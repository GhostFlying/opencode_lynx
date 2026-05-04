import { describe, expect, it } from 'vitest'

import type { ServerInitiatedRequest } from '../protocol.js'
import { createCodexMapper } from '../mapper.js'

const FROZEN_NOW = '2026-01-01T00:00:00.000Z'

function makeMapper() {
  return createCodexMapper({ now: () => FROZEN_NOW })
}

function fakeRequest(
  method: string,
  params: unknown,
  id: string | number = 42,
): ServerInitiatedRequest {
  return {
    id,
    method,
    params,
    async respond(): Promise<void> {
      throw new Error('respond should not be called by the mapper')
    },
    async respondError(): Promise<void> {
      throw new Error('respondError should not be called by the mapper')
    },
  }
}

describe('createCodexMapper / mapNotification', () => {
  it('maps thread/started → session.updated and updates active thread', () => {
    const mapper = makeMapper()
    const params = { thread: { id: 'thread-1', preview: 'hi' } }
    const events = mapper.mapNotification('thread/started', params)
    expect(events).toHaveLength(1)
    const event = events[0]!
    expect(event.backend).toBe('codex')
    expect(event.type).toBe('session.updated')
    expect(event.sessionID).toBe('thread-1')
    expect(event.payload).toEqual({ thread: params.thread })
    expect(event.raw).toBe(params)
    expect(event.sourceType).toBe('thread/started')
    expect(mapper.getContext().activeThreadID).toBe('thread-1')
  })

  it('maps thread/status/changed → session.updated', () => {
    const mapper = makeMapper()
    const params = { threadId: 'thread-9', status: 'running' }
    const [event] = mapper.mapNotification('thread/status/changed', params)
    expect(event!.type).toBe('session.updated')
    expect(event!.sessionID).toBe('thread-9')
    expect(event!.status).toBe('running')
    expect(event!.payload).toEqual({ threadID: 'thread-9', status: 'running' })
    expect(event!.raw).toBe(params)
  })

  it('maps turn/started → turn.started with turn id', () => {
    const mapper = makeMapper()
    const turn = { id: 'turn-1', items: [], status: 'running' }
    const params = { threadId: 'thread-1', turn }
    const [event] = mapper.mapNotification('turn/started', params)
    expect(event!.type).toBe('turn.started')
    expect(event!.sessionID).toBe('thread-1')
    expect(event!.turnID).toBe('turn-1')
    expect(event!.payload).toEqual({ threadID: 'thread-1', turn })
  })

  it('maps turn/completed → turn.completed', () => {
    const mapper = makeMapper()
    const turn = { id: 'turn-2', items: [], status: 'completed' }
    const params = { threadId: 'thread-1', turn }
    const [event] = mapper.mapNotification('turn/completed', params)
    expect(event!.type).toBe('turn.completed')
    expect(event!.turnID).toBe('turn-2')
    expect(event!.payload).toEqual({ threadID: 'thread-1', turn })
  })

  it('item/started agentMessage opens an empty assistant message.delta', () => {
    const mapper = makeMapper()
    const params = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'agentMessage', id: 'msg-1', text: '' },
    }
    const [event] = mapper.mapNotification('item/started', params)
    expect(event!.type).toBe('message.delta')
    expect(event!.messageID).toBe('msg-1')
    expect(event!.partID).toBe('msg-1')
    expect(event!.turnID).toBe('turn-1')
    expect(event!.payload).toEqual({
      partID: 'msg-1',
      role: 'assistant',
      delta: '',
      initial: true,
      kind: 'text',
    })
  })

  it('item/agentMessage/delta → message.delta with delta text', () => {
    const mapper = makeMapper()
    const params = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'msg-1',
      delta: 'hello ',
    }
    const [event] = mapper.mapNotification('item/agentMessage/delta', params)
    expect(event!.type).toBe('message.delta')
    expect(event!.messageID).toBe('msg-1')
    expect(event!.partID).toBe('msg-1')
    expect(event!.payload).toEqual({
      partID: 'msg-1',
      role: 'assistant',
      delta: 'hello ',
      kind: 'text',
    })
  })

  it('item/completed agentMessage → message.updated with frozen completedAt', () => {
    const mapper = makeMapper()
    const params = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'agentMessage', id: 'msg-1', text: 'hello world' },
    }
    const [event] = mapper.mapNotification('item/completed', params)
    expect(event!.type).toBe('message.updated')
    expect(event!.messageID).toBe('msg-1')
    expect(event!.payload).toEqual({
      partID: 'msg-1',
      role: 'assistant',
      text: 'hello world',
      completedAt: FROZEN_NOW,
      kind: 'text',
    })
  })

  it('item/started commandExecution → tool.started', () => {
    const mapper = makeMapper()
    const params = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        type: 'commandExecution',
        id: 'cmd-1',
        command: 'ls',
        cwd: '/tmp',
        status: 'in_progress',
      },
    }
    const [event] = mapper.mapNotification('item/started', params)
    expect(event!.type).toBe('tool.started')
    expect(event!.partID).toBe('cmd-1')
    expect(event!.status).toBe('in_progress')
    expect(event!.payload).toEqual({
      toolID: 'cmd-1',
      kind: 'commandExecution',
      command: 'ls',
      cwd: '/tmp',
      status: 'in_progress',
    })
  })

  it('item/commandExecution/outputDelta → tool.delta with output', () => {
    const mapper = makeMapper()
    const params = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'cmd-1',
      delta: 'line\n',
    }
    const [event] = mapper.mapNotification('item/commandExecution/outputDelta', params)
    expect(event!.type).toBe('tool.delta')
    expect(event!.payload).toEqual({
      toolID: 'cmd-1',
      deltaType: 'output',
      delta: 'line\n',
    })
  })

  it('item/completed commandExecution → tool.completed with exit info', () => {
    const mapper = makeMapper()
    const params = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        type: 'commandExecution',
        id: 'cmd-1',
        status: 'completed',
        exitCode: 0,
        durationMs: 250,
        aggregatedOutput: 'all good',
      },
    }
    const [event] = mapper.mapNotification('item/completed', params)
    expect(event!.type).toBe('tool.completed')
    expect(event!.status).toBe('completed')
    expect(event!.payload).toEqual({
      toolID: 'cmd-1',
      kind: 'commandExecution',
      status: 'completed',
      exitCode: 0,
      durationMs: 250,
      aggregatedOutput: 'all good',
    })
  })

  it('item/started fileChange → tool.started', () => {
    const mapper = makeMapper()
    const params = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'fileChange', id: 'fc-1', changes: [], status: 'pending' },
    }
    const [event] = mapper.mapNotification('item/started', params)
    expect(event!.type).toBe('tool.started')
    expect(event!.payload).toEqual({
      toolID: 'fc-1',
      kind: 'fileChange',
      status: 'pending',
    })
  })

  it('item/fileChange/outputDelta → tool.delta output', () => {
    const mapper = makeMapper()
    const params = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'fc-1',
      delta: 'patch progress',
    }
    const [event] = mapper.mapNotification('item/fileChange/outputDelta', params)
    expect(event!.type).toBe('tool.delta')
    expect(event!.payload).toEqual({
      toolID: 'fc-1',
      deltaType: 'output',
      delta: 'patch progress',
    })
  })

  it('item/fileChange/patchUpdated → tool.delta patch', () => {
    const mapper = makeMapper()
    const changes = [{ path: '/a.txt', kind: 'modify' }]
    const params = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'fc-1',
      changes,
    }
    const [event] = mapper.mapNotification('item/fileChange/patchUpdated', params)
    expect(event!.type).toBe('tool.delta')
    expect(event!.payload).toEqual({
      toolID: 'fc-1',
      deltaType: 'patch',
      changes,
    })
  })

  it('item/completed fileChange → tool.completed with changes', () => {
    const mapper = makeMapper()
    const changes = [{ path: '/a.txt', kind: 'modify' }]
    const params = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'fileChange', id: 'fc-1', status: 'applied', changes },
    }
    const [event] = mapper.mapNotification('item/completed', params)
    expect(event!.type).toBe('tool.completed')
    expect(event!.payload).toEqual({
      toolID: 'fc-1',
      kind: 'fileChange',
      status: 'applied',
      changes,
    })
  })

  it('error notification → connection.state with severity error', () => {
    const mapper = makeMapper()
    const params = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      willRetry: true,
      error: { message: 'rate limited' },
    }
    const [event] = mapper.mapNotification('error', params)
    expect(event!.type).toBe('connection.state')
    expect(event!.sessionID).toBe('thread-1')
    expect(event!.turnID).toBe('turn-1')
    expect(event!.payload).toEqual({
      severity: 'error',
      error: params.error,
      willRetry: true,
      threadID: 'thread-1',
      turnID: 'turn-1',
    })
  })

  it('warning notification → raw event with method/params payload', () => {
    const mapper = makeMapper()
    const params = { code: 'config-deprecated' }
    const [event] = mapper.mapNotification('warning', params)
    expect(event!.type).toBe('raw')
    expect(event!.sourceType).toBe('warning')
    expect(event!.payload).toEqual({ method: 'warning', params })
  })

  it('unknown notification (account/updated) → raw event', () => {
    const mapper = makeMapper()
    const params = { account: { id: 'a' } }
    const [event] = mapper.mapNotification('account/updated', params)
    expect(event!.type).toBe('raw')
    expect(event!.sourceType).toBe('account/updated')
    expect(event!.payload).toEqual({ method: 'account/updated', params })
  })

  it('item/started for unsupported types (reasoning/plan/...) emits raw', () => {
    const mapper = makeMapper()
    const params = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'reasoning', id: 'r-1', summary: [], content: [] },
    }
    const [event] = mapper.mapNotification('item/started', params)
    expect(event!.type).toBe('raw')
    expect(event!.sourceType).toBe('item/started')
  })

  it('command tool sequence: started → outputDelta → completed in order', () => {
    const mapper = makeMapper()
    const startEv = mapper.mapNotification('item/started', {
      threadId: 't', turnId: 'u', item: { type: 'commandExecution', id: 'c1', command: 'ls', cwd: '/', status: 'in_progress' },
    })
    const deltaEv = mapper.mapNotification('item/commandExecution/outputDelta', {
      threadId: 't', turnId: 'u', itemId: 'c1', delta: 'a',
    })
    const doneEv = mapper.mapNotification('item/completed', {
      threadId: 't', turnId: 'u', item: { type: 'commandExecution', id: 'c1', status: 'completed', exitCode: 0 },
    })
    expect(startEv[0]!.type).toBe('tool.started')
    expect(deltaEv[0]!.type).toBe('tool.delta')
    expect(deltaEv[0]!.payload.deltaType).toBe('output')
    expect(doneEv[0]!.type).toBe('tool.completed')
  })

  it('fileChange sequence: started → patchUpdated emits tool.started then tool.delta(patch)', () => {
    const mapper = makeMapper()
    const startEv = mapper.mapNotification('item/started', {
      threadId: 't', turnId: 'u', item: { type: 'fileChange', id: 'f1', status: 'pending', changes: [] },
    })
    const patchEv = mapper.mapNotification('item/fileChange/patchUpdated', {
      threadId: 't', turnId: 'u', itemId: 'f1', changes: [{ path: '/a' }],
    })
    expect(startEv[0]!.type).toBe('tool.started')
    expect(patchEv[0]!.type).toBe('tool.delta')
    expect(patchEv[0]!.payload).toMatchObject({ toolID: 'f1', deltaType: 'patch' })
  })

  it('interleaved items route outputDelta to the correct tool id; reset clears open items', () => {
    const mapper = makeMapper()
    mapper.mapNotification('item/started', {
      threadId: 't', turnId: 'u', item: { type: 'commandExecution', id: 'c1', command: 'echo', cwd: '/', status: 'in_progress' },
    })
    mapper.mapNotification('item/started', {
      threadId: 't', turnId: 'u', item: { type: 'fileChange', id: 'f1', status: 'pending', changes: [] },
    })
    const cDelta = mapper.mapNotification('item/commandExecution/outputDelta', {
      threadId: 't', turnId: 'u', itemId: 'c1', delta: 'x',
    })
    const fDelta = mapper.mapNotification('item/fileChange/outputDelta', {
      threadId: 't', turnId: 'u', itemId: 'f1', delta: 'y',
    })
    expect(cDelta[0]!.payload).toMatchObject({ toolID: 'c1', deltaType: 'output' })
    expect(fDelta[0]!.payload).toMatchObject({ toolID: 'f1', deltaType: 'output' })

    // reset clears the internal open-item map but keeps thread id
    mapper.setActiveThread('t')
    mapper.reset()
    expect(mapper.getContext().activeThreadID).toBe('t')
  })
})

describe('createCodexMapper / mapServerRequest', () => {
  it('item/commandExecution/requestApproval echoes provided availableDecisions', () => {
    const mapper = makeMapper()
    const req = fakeRequest(
      'item/commandExecution/requestApproval',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'cmd-1',
        command: 'rm -rf /',
        cwd: '/tmp',
        reason: 'destructive',
        availableDecisions: ['accept', 'cancel'],
      },
      77,
    )
    const event = mapper.mapServerRequest(req)
    expect(event).not.toBeNull()
    expect(event!.type).toBe('approval.requested')
    expect(event!.approvalID).toBe('77')
    expect(event!.sessionID).toBe('thread-1')
    expect(event!.turnID).toBe('turn-1')
    expect(event!.partID).toBe('cmd-1')
    expect(event!.payload).toEqual({
      approvalID: '77',
      kind: 'commandExecution',
      threadID: 'thread-1',
      turnID: 'turn-1',
      itemID: 'cmd-1',
      command: 'rm -rf /',
      cwd: '/tmp',
      reason: 'destructive',
      availableDecisions: ['accept', 'cancel'],
    })
  })

  it('default availableDecisions when server omits them (commandExecution)', () => {
    const mapper = makeMapper()
    const req = fakeRequest('item/commandExecution/requestApproval', {
      threadId: 't', turnId: 'u', itemId: 'cmd-1',
    })
    const event = mapper.mapServerRequest(req)
    expect(event!.payload.availableDecisions).toEqual(['accept', 'decline', 'cancel'])
  })

  it('item/fileChange/requestApproval emits approval with kind fileChange and defaults', () => {
    const mapper = makeMapper()
    const req = fakeRequest('item/fileChange/requestApproval', {
      threadId: 't', turnId: 'u', itemId: 'fc-1', reason: 'needs write',
    })
    const event = mapper.mapServerRequest(req)
    expect(event!.type).toBe('approval.requested')
    expect(event!.payload.kind).toBe('fileChange')
    expect(event!.payload.availableDecisions).toEqual(['accept', 'decline', 'cancel'])
  })

  it('returns null for item/tool/requestUserInput and other unmapped requests', () => {
    const mapper = makeMapper()
    expect(
      mapper.mapServerRequest(fakeRequest('item/tool/requestUserInput', {})),
    ).toBeNull()
    expect(
      mapper.mapServerRequest(fakeRequest('mcpServer/elicitation/request', {})),
    ).toBeNull()
    expect(
      mapper.mapServerRequest(fakeRequest('account/chatgptAuthTokens/refresh', {})),
    ).toBeNull()
  })

  it('coerces numeric ids to string approvalID', () => {
    const mapper = makeMapper()
    const event = mapper.mapServerRequest(
      fakeRequest('item/commandExecution/requestApproval', { availableDecisions: ['accept'] }, 12),
    )
    // JSON.stringify(12) === "12" — number ids stay unquoted in the key.
    expect(event!.approvalID).toBe('12')
  })

  it('preserves number-vs-string distinction in approvalID', () => {
    // Regression: a previous version used `String(req.id)`, which collapsed
    // numeric `1` and string `'1'` to the same key. JSON-RPC 2.0 allows
    // mixed id types, so two distinct in-flight server requests could
    // overwrite each other in the adapter's pendingApprovals map.
    const mapper = makeMapper()
    const numEvent = mapper.mapServerRequest(
      fakeRequest('item/commandExecution/requestApproval', {}, 1),
    )
    const strEvent = mapper.mapServerRequest(
      fakeRequest('item/commandExecution/requestApproval', {}, '1'),
    )
    expect(numEvent!.approvalID).toBe('1')
    expect(strEvent!.approvalID).toBe('"1"')
    expect(numEvent!.approvalID).not.toBe(strEvent!.approvalID)
  })
})

describe('createCodexMapper / emitApprovalResolved', () => {
  it('produces a well-formed approval.resolved event', () => {
    const mapper = makeMapper()
    const event = mapper.emitApprovalResolved('77', { kind: 'accept' })
    expect(event.backend).toBe('codex')
    expect(event.type).toBe('approval.resolved')
    expect(event.approvalID).toBe('77')
    expect(event.payload).toEqual({ approvalID: '77', decision: { kind: 'accept' } })
    expect(event.sourceType).toBe('approval.resolved')
  })

  it('passes through union-shaped decisions verbatim', () => {
    const mapper = makeMapper()
    const decision = {
      kind: 'acceptWithExecpolicyAmendment',
      payload: { execpolicy_amendment: { foo: 'bar' } },
    }
    const event = mapper.emitApprovalResolved('99', decision)
    expect(event.payload).toEqual({ approvalID: '99', decision })
  })
})
