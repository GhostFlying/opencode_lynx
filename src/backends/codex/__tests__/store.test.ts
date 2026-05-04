import { describe, expect, it } from 'vitest'

import { createCodexMessageStore } from '../store.js'
import type { TurnShape } from '../store.js'

const SID = 'thread-1'

function makeStore() {
  const store = createCodexMessageStore()
  // Seed empty so apply() will route events for SID. (Production code
  // seeds via sessions.messages() bootstrapping; tests skip that.)
  store.seedFromTurns(SID, [])
  return store
}

describe('createCodexMessageStore / seedFromTurns', () => {
  it('produces canonical tool part shape for commandExecution history', () => {
    const store = createCodexMessageStore()
    const turns: TurnShape[] = [
      {
        id: 'turn-1',
        startedAt: 1700000000,
        items: [
          {
            type: 'commandExecution',
            id: 'item-1',
            command: 'ls -la',
            cwd: '/repo',
            status: 'completed',
            exitCode: 0,
            durationMs: 12,
            aggregatedOutput: 'a\nb\nc',
          },
        ],
      },
    ]
    store.seedFromTurns(SID, turns)
    const snap = store.snapshot(SID)!
    expect(snap).toHaveLength(1)
    const msg = snap[0]!
    expect(msg.role).toBe('tool')
    expect(msg.id).toBe('turn-1:item-1')
    const part = msg.parts[0] as Record<string, unknown>
    expect(part.type).toBe('tool')
    expect(part.tool).toBe('shell')
    expect(part.callID).toBe('item-1')
    const state = part.state as Record<string, unknown>
    expect(state.status).toBe('completed')
    expect(state.input).toEqual({ command: 'ls -la', cwd: '/repo' })
    expect(state.output).toBe('a\nb\nc')
    expect(state.exitCode).toBe(0)
    expect(state.durationMs).toBe(12)
  })

  it('maps fileChange to tool:edit with changes in input', () => {
    const store = createCodexMessageStore()
    const turns: TurnShape[] = [
      {
        id: 'turn-1',
        items: [
          {
            type: 'fileChange',
            id: 'item-2',
            status: 'completed',
            changes: [{ path: 'a.ts', kind: 'modified' }],
          },
        ],
      },
    ]
    store.seedFromTurns(SID, turns)
    const snap = store.snapshot(SID)!
    const part = snap[0]!.parts[0] as Record<string, unknown>
    expect(part.tool).toBe('edit')
    const state = part.state as Record<string, unknown>
    expect(state.status).toBe('completed')
    expect((state.input as Record<string, unknown>).changes).toEqual([
      { path: 'a.ts', kind: 'modified' },
    ])
  })

  it('user and assistant items map cleanly', () => {
    const store = createCodexMessageStore()
    const turns: TurnShape[] = [
      {
        id: 'turn-1',
        items: [
          { type: 'userMessage', id: 'u-1', content: [{ type: 'text', text: 'hi' }] },
          { type: 'agentMessage', id: 'a-1', text: 'hey' },
        ],
      },
    ]
    store.seedFromTurns(SID, turns)
    const snap = store.snapshot(SID)!
    expect(snap).toHaveLength(2)
    expect(snap[0]!.role).toBe('user')
    expect((snap[0]!.parts[0] as { text: string }).text).toBe('hi')
    expect(snap[1]!.role).toBe('assistant')
    expect((snap[1]!.parts[0] as { text: string }).text).toBe('hey')
  })
})

describe('createCodexMessageStore / apply (live events)', () => {
  it('item/started agentMessage appends an empty assistant text part', () => {
    const store = makeStore()
    const changed = store.apply('item/started', {
      threadId: SID,
      turnId: 'turn-1',
      item: { type: 'agentMessage', id: 'msg-1' },
    })
    expect(changed).toBe(true)
    const snap = store.snapshot(SID)!
    expect(snap).toHaveLength(1)
    expect(snap[0]!.role).toBe('assistant')
    expect((snap[0]!.parts[0] as { text: string }).text).toBe('')
  })

  it('agentMessage/delta accumulates across multiple events', () => {
    const store = makeStore()
    store.apply('item/started', {
      threadId: SID,
      turnId: 'turn-1',
      item: { type: 'agentMessage', id: 'msg-1' },
    })
    store.apply('item/agentMessage/delta', { threadId: SID, itemId: 'msg-1', delta: 'hello ' })
    store.apply('item/agentMessage/delta', { threadId: SID, itemId: 'msg-1', delta: 'world' })
    const part = store.snapshot(SID)![0]!.parts[0] as { text: string }
    expect(part.text).toBe('hello world')
  })

  it('item/completed agentMessage replaces text with final', () => {
    const store = makeStore()
    store.apply('item/started', {
      threadId: SID,
      turnId: 'turn-1',
      item: { type: 'agentMessage', id: 'msg-1' },
    })
    store.apply('item/agentMessage/delta', { threadId: SID, itemId: 'msg-1', delta: 'partial' })
    store.apply('item/completed', {
      threadId: SID,
      turnId: 'turn-1',
      item: { type: 'agentMessage', id: 'msg-1', text: 'final answer' },
    })
    const part = store.snapshot(SID)![0]!.parts[0] as { text: string }
    expect(part.text).toBe('final answer')
  })

  it('commandExecution lifecycle: started → outputDelta → completed', () => {
    const store = makeStore()
    store.apply('item/started', {
      threadId: SID,
      turnId: 'turn-1',
      item: { type: 'commandExecution', id: 'cmd-1', command: 'echo hi', cwd: '/repo' },
    })

    let snap = store.snapshot(SID)!
    let part = snap[0]!.parts[0] as Record<string, unknown>
    expect(part.tool).toBe('shell')
    expect(((part.state as Record<string, unknown>).status)).toBe('running')

    store.apply('item/commandExecution/outputDelta', {
      threadId: SID,
      itemId: 'cmd-1',
      delta: 'hi\n',
    })
    store.apply('item/commandExecution/outputDelta', {
      threadId: SID,
      itemId: 'cmd-1',
      delta: 'done\n',
    })

    snap = store.snapshot(SID)!
    part = snap[0]!.parts[0] as Record<string, unknown>
    expect(((part.state as Record<string, unknown>).output)).toBe('hi\ndone\n')

    store.apply('item/completed', {
      threadId: SID,
      turnId: 'turn-1',
      item: {
        type: 'commandExecution',
        id: 'cmd-1',
        status: 'completed',
        exitCode: 0,
        durationMs: 5,
        aggregatedOutput: 'hi\ndone\n',
      },
    })

    snap = store.snapshot(SID)!
    part = snap[0]!.parts[0] as Record<string, unknown>
    const state = part.state as Record<string, unknown>
    expect(state.status).toBe('completed')
    expect(state.exitCode).toBe(0)
    expect(state.output).toBe('hi\ndone\n')
  })

  it('fileChange patchUpdated stores changes under state.input.changes', () => {
    const store = makeStore()
    store.apply('item/started', {
      threadId: SID,
      turnId: 'turn-1',
      item: { type: 'fileChange', id: 'f-1' },
    })
    store.apply('item/fileChange/patchUpdated', {
      threadId: SID,
      itemId: 'f-1',
      changes: [{ path: 'a.ts', kind: 'modified' }],
    })
    const part = store.snapshot(SID)![0]!.parts[0] as Record<string, unknown>
    const state = part.state as Record<string, unknown>
    expect((state.input as Record<string, unknown>).changes).toEqual([
      { path: 'a.ts', kind: 'modified' },
    ])
  })

  it('terminal error inserts a system message and reports change', () => {
    const store = makeStore()
    const changed = store.apply('error', {
      threadId: SID,
      turnId: 'turn-1',
      willRetry: false,
      error: { message: 'upstream 503' },
    })
    expect(changed).toBe(true)
    const snap = store.snapshot(SID)!
    expect(snap).toHaveLength(1)
    expect(snap[0]!.role).toBe('system')
    expect((snap[0]!.parts[0] as { text: string }).text).toBe('upstream 503')
  })

  it('mid-flight retry error does NOT mutate state', () => {
    const store = makeStore()
    const changed = store.apply('error', {
      threadId: SID,
      turnId: 'turn-1',
      willRetry: true,
      error: { message: 'try again' },
    })
    expect(changed).toBe(false)
    expect(store.snapshot(SID)).toEqual([])
  })

  it('apply() auto-creates the session entry for unseeded sessions', () => {
    const store = createCodexMessageStore()
    // No prior seed — codex notifications still fold cleanly so a new
    // session's first userMessage echo doesn't get dropped by a race
    // against the chat's bootstrap `messages()` call.
    const changed = store.apply('item/started', {
      threadId: 'fresh',
      turnId: 't-1',
      item: { type: 'agentMessage', id: 'a-1' },
    })
    expect(changed).toBe(true)
    expect(store.has('fresh')).toBe(true)
    const snap = store.snapshot('fresh')!
    expect(snap).toHaveLength(1)
    expect(snap[0]!.role).toBe('assistant')
  })

  it('item/started userMessage lands as a user role message', () => {
    const store = createCodexMessageStore()
    store.apply('item/started', {
      threadId: SID,
      turnId: 'turn-1',
      item: {
        type: 'userMessage',
        id: 'u-1',
        content: [{ type: 'text', text: 'hello' }],
      },
    })
    const snap = store.snapshot(SID)!
    expect(snap).toHaveLength(1)
    expect(snap[0]!.role).toBe('user')
    expect(snap[0]!.id).toBe('turn-1:u-1')
    expect((snap[0]!.parts[0] as { text: string }).text).toBe('hello')
  })

  it('snapshot returns defensive copies', () => {
    const store = makeStore()
    store.apply('item/started', {
      threadId: SID,
      turnId: 'turn-1',
      item: { type: 'agentMessage', id: 'msg-1' },
    })
    const a = store.snapshot(SID)!
    a[0] = { ...a[0]!, role: 'user' }
    const b = store.snapshot(SID)!
    expect(b[0]!.role).toBe('assistant')
  })

  it('reset() clears all sessions; resetSession() drops just one', () => {
    const store = makeStore()
    store.seedFromTurns('other', [])
    expect(store.has(SID)).toBe(true)
    expect(store.has('other')).toBe(true)
    store.resetSession('other')
    expect(store.has('other')).toBe(false)
    expect(store.has(SID)).toBe(true)
    store.reset()
    expect(store.has(SID)).toBe(false)
  })

  it('terminal error message carries backendMeta.kind=turnError marker', () => {
    const store = makeStore()
    store.apply('error', {
      threadId: SID,
      turnId: 'turn-1',
      willRetry: false,
      error: { message: 'upstream 503' },
    })
    const snap = store.snapshot(SID)!
    expect(snap[0]!.backendMeta).toEqual({ kind: 'turnError' })
  })

  it('seedFromTurns then live delta composes correctly', () => {
    const store = createCodexMessageStore()
    store.seedFromTurns(SID, [
      {
        id: 'turn-0',
        items: [{ type: 'agentMessage', id: 'old', text: 'history' }],
      },
    ])
    store.apply('item/started', {
      threadId: SID,
      turnId: 'turn-1',
      item: { type: 'agentMessage', id: 'new' },
    })
    store.apply('item/agentMessage/delta', { threadId: SID, itemId: 'new', delta: 'live' })
    const snap = store.snapshot(SID)!
    expect(snap).toHaveLength(2)
    expect((snap[0]!.parts[0] as { text: string }).text).toBe('history')
    expect((snap[1]!.parts[0] as { text: string }).text).toBe('live')
  })
})
