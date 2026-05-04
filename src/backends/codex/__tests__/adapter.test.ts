import { describe, expect, it, vi } from 'vitest'

import { BackendFacadeError } from '../../errors.js'
import { createCodexBackendAdapter } from '../adapter.js'
import { createCodexMapper } from '../mapper.js'
import type {
  CodexProtocolClient,
  ProtocolConnectionState,
  ServerInitiatedRequest,
} from '../protocol.js'
import type { BackendEvent } from '../../types.js'

// ---------------------------------------------------------------------------
// FakeCodexProtocolClient — a tiny, observable replacement for the real
// JSON-RPC protocol client. Each test wires in a `requestHandler` to drive
// the adapter's outbound calls. Notifications + server requests can be
// pushed in via `pushNotification` / `pushServerRequest`.
// ---------------------------------------------------------------------------

interface FakeProtocolClient extends CodexProtocolClient {
  /** Frames the adapter has sent (method + params), in order. */
  sentRequests: Array<{ method: string; params: unknown }>
  /** Push a notification frame at all attached listeners. */
  pushNotification(method: string, params: unknown): void
  /** Push a server-initiated request at all attached listeners. */
  pushServerRequest(req: ServerInitiatedRequest): void
  /** Push a connection-state change at all attached listeners. */
  pushState(state: ProtocolConnectionState): void
  /** True once close() was called. */
  closed: boolean
  /** Latest reconnect reason (if any). */
  reconnectReason: unknown
}

interface FakeProtocolOptions {
  requestHandler?: (method: string, params: unknown) => unknown | Promise<unknown>
  initialState?: ProtocolConnectionState
}

function createFakeProtocol(opts: FakeProtocolOptions = {}): FakeProtocolClient {
  const sentRequests: FakeProtocolClient['sentRequests'] = []
  const notificationListeners = new Set<(n: { method: string; params: unknown }) => void>()
  const serverRequestListeners = new Set<(req: ServerInitiatedRequest) => void>()
  const stateListeners = new Set<(state: ProtocolConnectionState) => void>()
  let state: ProtocolConnectionState = opts.initialState ?? { status: 'connecting', attempt: 0 }
  let closed = false
  let reconnectReason: unknown = null

  const handler =
    opts.requestHandler ??
    ((method: string) => {
      throw new Error(`unexpected request: ${method}`)
    })

  const fake: FakeProtocolClient = {
    sentRequests,
    closed,
    reconnectReason,
    async request<Result = unknown>(method: string, params?: unknown): Promise<Result> {
      sentRequests.push({ method, params })
      return (await handler(method, params)) as Result
    },
    async notify(): Promise<void> {
      // unused by adapter so far
    },
    reconnect(reason?: unknown): void {
      fake.reconnectReason = reason ?? null
      // Simulate the protocol going back to connecting state.
      state = { status: 'connecting', attempt: 1 }
      for (const l of [...stateListeners]) l(state)
    },
    async close(): Promise<void> {
      fake.closed = true
      closed = true
      state = { status: 'closed' }
      for (const l of [...stateListeners]) l(state)
    },
    getState(): ProtocolConnectionState {
      return state
    },
    onNotification(handler) {
      notificationListeners.add(handler)
      return () => notificationListeners.delete(handler)
    },
    onServerRequest(handler) {
      serverRequestListeners.add(handler)
      return () => serverRequestListeners.delete(handler)
    },
    onConnectionState(handler) {
      stateListeners.add(handler)
      // Replay current state, matching real protocol behavior.
      try {
        handler(state)
      } catch {
        // ignore
      }
      return () => stateListeners.delete(handler)
    },
    pushNotification(method, params) {
      for (const l of [...notificationListeners]) l({ method, params })
    },
    pushServerRequest(req) {
      for (const l of [...serverRequestListeners]) l(req)
    },
    pushState(next) {
      state = next
      for (const l of [...stateListeners]) l(next)
    },
  }
  return fake
}

function makeAdapter(options: {
  requestHandler?: (method: string, params: unknown) => unknown | Promise<unknown>
  initialState?: ProtocolConnectionState
}) {
  const fake = createFakeProtocol({
    ...(options.requestHandler ? { requestHandler: options.requestHandler } : {}),
    ...(options.initialState ? { initialState: options.initialState } : {}),
  })
  let createdMapper: ReturnType<typeof createCodexMapper> | null = null
  const client = createCodexBackendAdapter(
    {
      url: 'ws://example.test',
      defaultCwd: '/repo/default',
      clientInfo: { name: 'test', version: '0.0.0' },
    },
    {
      createProtocolClient: () => fake,
      createMapper: () => {
        createdMapper = createCodexMapper()
        return createdMapper
      },
    },
  )
  return { client, fake, getMapper: () => createdMapper! }
}

function makeServerRequest(
  method: string,
  params: unknown,
  id: string | number = 'srv-1',
): ServerInitiatedRequest & { responded: { result?: unknown; error?: unknown } } {
  const responded: { result?: unknown; error?: unknown } = {}
  const wrapper = {
    id,
    method,
    params,
    async respond(result: unknown): Promise<void> {
      responded.result = result
    },
    async respondError(code: number, message: string): Promise<void> {
      responded.error = { code, message }
    },
    responded,
  }
  return wrapper
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createCodexBackendAdapter / descriptor + capabilities', () => {
  it('exposes the codex descriptor and the documented capabilities', () => {
    const { client } = makeAdapter({})
    expect(client.descriptor).toEqual({ kind: 'codex', label: 'Codex' })
    expect(client.capabilities).toEqual({
      sessions: true,
      streaming: true,
      catalog: true,
      approvals: true,
      pty: false,
      remoteDiscovery: false,
      agentPicker: false,
      modelPicker: true,
    })
  })
})

describe('createCodexBackendAdapter / sessions.list', () => {
  it('translates ThreadListResponse into BackendSessionSummary[] with timestamp + name fallback + modelProvider in meta', async () => {
    const updatedAtSeconds = 1_730_000_000
    const updatedAtIso = new Date(updatedAtSeconds * 1000).toISOString()
    const { client, fake } = makeAdapter({
      requestHandler: method => {
        if (method !== 'thread/list') throw new Error(`unexpected ${method}`)
        return {
          data: [
            {
              id: 'thread-named',
              name: 'My thread',
              preview: 'first user message',
              status: 'idle',
              updatedAt: updatedAtSeconds,
              cwd: '/work/repo',
              modelProvider: 'openai',
              source: 'cli',
              ephemeral: false,
            },
            {
              id: 'thread-no-name',
              name: null,
              preview: 'fallback preview',
              status: 'running',
              updatedAt: updatedAtSeconds,
              cwd: '/work/repo',
              modelProvider: 'openai',
              source: 'app-server',
              ephemeral: true,
            },
          ],
          nextCursor: null,
        }
      },
    })

    const summaries = await client.sessions.list()
    expect(fake.sentRequests).toEqual([{ method: 'thread/list', params: {} }])
    expect(summaries).toHaveLength(2)
    const first = summaries[0]!
    expect(first).toMatchObject({
      backend: 'codex',
      id: 'thread-named',
      title: 'My thread',
      status: 'idle',
      updatedAt: updatedAtIso,
      directory: '/work/repo',
    })
    expect(first.backendMeta).toMatchObject({
      modelProvider: 'openai',
      source: 'cli',
      ephemeral: false,
    })
    const second = summaries[1]!
    expect(second.title).toBe('fallback preview')
  })
})

describe('createCodexBackendAdapter / sessions.create', () => {
  it('calls thread/start with experimentalRawEvents=false, persistExtendedHistory=false, cwd from scope; sets active thread', async () => {
    let captured: { method: string; params: unknown } | null = null
    const { client, getMapper } = makeAdapter({
      requestHandler: (method, params) => {
        if (method !== 'thread/start') throw new Error(`unexpected ${method}`)
        captured = { method, params }
        return {
          thread: {
            id: 'thread-created',
            name: 'New',
            preview: 'New',
            status: 'idle',
            createdAt: 1_730_000_001,
            updatedAt: 1_730_000_002,
            cwd: '/scope/dir',
            modelProvider: 'openai',
            source: 'app-server',
            ephemeral: false,
          },
        }
      },
    })

    const record = await client.sessions.create({ directory: '/scope/dir' })
    expect(captured).not.toBeNull()
    expect(captured!.params).toMatchObject({
      experimentalRawEvents: false,
      persistExtendedHistory: false,
      cwd: '/scope/dir',
    })
    expect(record).toMatchObject({
      backend: 'codex',
      id: 'thread-created',
      directory: '/scope/dir',
    })
    expect(record.createdAt).toBe(new Date(1_730_000_001 * 1000).toISOString())
    expect(getMapper().getContext().activeThreadID).toBe('thread-created')
  })

  it('falls back to defaultCwd when scope.directory is absent', async () => {
    let capturedParams: unknown = null
    const { client } = makeAdapter({
      requestHandler: (method, params) => {
        if (method !== 'thread/start') throw new Error(`unexpected ${method}`)
        capturedParams = params
        return {
          thread: {
            id: 'thread-default',
            preview: 'p',
            status: 'idle',
            createdAt: 0,
            updatedAt: 0,
            cwd: '/repo/default',
            modelProvider: 'openai',
            source: 'app-server',
            ephemeral: false,
          },
        }
      },
    })
    await client.sessions.create()
    expect(capturedParams).toMatchObject({ cwd: '/repo/default' })
  })
})

describe('createCodexBackendAdapter / sessions.get', () => {
  it('first tries includeTurns=true; on -32001 retries with includeTurns=false; on second failure throws', async () => {
    const calls: Array<{ params: unknown }> = []
    let attempt = 0
    const { client } = makeAdapter({
      requestHandler: (method, params) => {
        if (method !== 'thread/read') throw new Error(`unexpected ${method}`)
        calls.push({ params })
        attempt += 1
        if (attempt === 1) {
          const err = new Error('not materialized') as Error & { code?: number }
          err.code = -32001
          throw err
        }
        return {
          thread: {
            id: 'thread-x',
            preview: 'p',
            status: 'idle',
            updatedAt: 0,
            createdAt: 0,
            cwd: '/work',
            modelProvider: 'openai',
            source: 'app-server',
            ephemeral: false,
          },
        }
      },
    })
    const record = await client.sessions.get('thread-x')
    expect(record).toMatchObject({ backend: 'codex', id: 'thread-x' })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.params).toEqual({ threadId: 'thread-x', includeTurns: true })
    expect(calls[1]!.params).toEqual({ threadId: 'thread-x', includeTurns: false })

    // Now exercise the both-fail path.
    const failing = makeAdapter({
      requestHandler: () => {
        const err = new Error('still not materialized') as Error & { code?: number }
        err.code = -32001
        throw err
      },
    })
    await expect(failing.client.sessions.get('thread-y')).rejects.toThrow(/still not materialized/)
  })
})

describe('createCodexBackendAdapter / sessions.messages', () => {
  it('expands Turn.items into BackendMessage[] across roles', async () => {
    const { client } = makeAdapter({
      requestHandler: method => {
        if (method !== 'thread/turns/list') throw new Error(`unexpected ${method}`)
        return {
          data: [
            {
              id: 'turn-1',
              startedAt: 1_730_000_010,
              items: [
                {
                  type: 'userMessage',
                  id: 'item-1',
                  content: [
                    { type: 'text', text: 'hello ', text_elements: [] },
                    { type: 'text', text: 'world', text_elements: [] },
                  ],
                },
                {
                  type: 'agentMessage',
                  id: 'item-2',
                  text: 'reply',
                },
                {
                  type: 'commandExecution',
                  id: 'item-3',
                  command: 'ls',
                  cwd: '/work',
                  status: 'completed',
                  exitCode: 0,
                  durationMs: 12,
                  aggregatedOutput: 'file.txt',
                },
                {
                  type: 'fileChange',
                  id: 'item-4',
                  status: 'applied',
                  changes: [{ path: '/x' }],
                },
                {
                  type: 'reasoning',
                  id: 'item-5',
                  summary: ['s'],
                  content: ['c'],
                },
              ],
            },
          ],
        }
      },
    })
    const messages = await client.sessions.messages('thread-1')
    expect(messages).toHaveLength(5)
    expect(messages[0]).toMatchObject({
      id: 'turn-1:item-1',
      sessionID: 'thread-1',
      role: 'user',
    })
    expect(messages[0]!.parts[0]).toEqual({ type: 'text', text: 'hello world' })
    expect(messages[1]).toMatchObject({
      id: 'turn-1:item-2',
      role: 'assistant',
    })
    expect(messages[1]!.parts[0]).toMatchObject({
      type: 'text',
      text: 'reply',
      partID: 'item-2',
    })
    expect(messages[2]).toMatchObject({ role: 'tool' })
    expect(messages[2]!.parts[0]).toMatchObject({
      type: 'tool',
      tool: 'shell',
      callID: 'item-3',
      state: {
        status: 'completed',
        input: { command: 'ls', cwd: '/work' },
        output: 'file.txt',
        exitCode: 0,
        durationMs: 12,
      },
    })
    expect(messages[3]).toMatchObject({ role: 'tool' })
    expect(messages[3]!.parts[0]).toMatchObject({
      type: 'tool',
      tool: 'edit',
      callID: 'item-4',
      state: {
        status: 'applied',
        input: { changes: [{ path: '/x' }] },
      },
    })
    expect(messages[4]).toMatchObject({ role: 'system' })
    expect(messages[4]!.parts[0]).toMatchObject({ type: 'raw' })
    expect(messages[0]!.createdAt).toBe(new Date(1_730_000_010 * 1000).toISOString())
  })

  it('returns store snapshot on subsequent calls without round-tripping the network', async () => {
    let calls = 0
    const { client } = makeAdapter({
      requestHandler: (method) => {
        if (method !== 'thread/turns/list') throw new Error(`unexpected ${method}`)
        calls += 1
        return { data: [] }
      },
    })
    await client.sessions.messages('thread-1')
    await client.sessions.messages('thread-1')
    await client.sessions.messages('thread-1')
    expect(calls).toBe(1)
  })

  it('folds streaming notifications into the store and emits message.updated', async () => {
    const { client, fake } = makeAdapter({
      requestHandler: (method) => {
        if (method !== 'thread/turns/list') throw new Error(`unexpected ${method}`)
        return { data: [] }
      },
    })

    // Seed the session by reading messages once (cold path).
    const initial = await client.sessions.messages('thread-1')
    expect(initial).toEqual([])

    const events: BackendEvent[] = []
    const sub = client.events.subscribe({
      autoStart: true,
      onEvent: (event) => events.push(event),
    })

    fake.pushNotification('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'agentMessage', id: 'msg-1' },
    })
    fake.pushNotification('item/agentMessage/delta', {
      threadId: 'thread-1',
      itemId: 'msg-1',
      delta: 'hi',
    })
    fake.pushNotification('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'agentMessage', id: 'msg-1', text: 'hi' },
    })

    // Synthesized message.updated for each fold (one per state-changing event).
    const updates = events.filter(
      (e) => e.type === 'message.updated' && e.payload.source === 'codex.store',
    )
    expect(updates.length).toBeGreaterThanOrEqual(2)
    expect(updates[0]!.sessionID).toBe('thread-1')

    // Snapshot read should now reflect the streamed content; no more network.
    const snap = await client.sessions.messages('thread-1')
    expect(snap).toHaveLength(1)
    expect(snap[0]!.role).toBe('assistant')
    expect((snap[0]!.parts[0] as { text: string }).text).toBe('hi')

    sub.stop()
  })

  it('clears the store on reconnect so the next read re-fetches', async () => {
    let calls = 0
    const { client, fake } = makeAdapter({
      requestHandler: (method) => {
        if (method !== 'thread/turns/list') throw new Error(`unexpected ${method}`)
        calls += 1
        return { data: [] }
      },
    })
    await client.sessions.messages('thread-1')
    expect(calls).toBe(1)
    fake.pushState({ status: 'reconnecting', attempt: 1 })
    await client.sessions.messages('thread-1')
    expect(calls).toBe(2)
  })

  it('terminal error notifications surface as a system message via the store', async () => {
    const { client, fake } = makeAdapter({
      requestHandler: (method) => {
        if (method !== 'thread/turns/list') throw new Error(`unexpected ${method}`)
        return { data: [] }
      },
    })
    await client.sessions.messages('thread-1')
    fake.pushNotification('error', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      willRetry: false,
      error: { message: 'upstream 503' },
    })
    const snap = await client.sessions.messages('thread-1')
    expect(snap).toHaveLength(1)
    expect(snap[0]!.role).toBe('system')
    expect((snap[0]!.parts[0] as { text: string }).text).toBe('upstream 503')
  })
})

describe('createCodexBackendAdapter / sessions.prompt', () => {
  it('translates text parts to UserInput[] and forwards model + reasoning', async () => {
    let captured: { method: string; params: unknown } | null = null
    const { client } = makeAdapter({
      requestHandler: (method, params) => {
        if (method !== 'turn/start') throw new Error(`unexpected ${method}`)
        captured = { method, params }
        return { turn: { id: 'turn-1' } }
      },
    })
    const result = await client.sessions.prompt('thread-1', {
      parts: [
        { type: 'text', text: 'hi' },
        { type: 'text', text: 'there' },
      ],
      model: { modelID: 'gpt-5-codex' },
      reasoningEffort: 'medium',
    })
    expect(captured).not.toBeNull()
    expect(captured!.params).toMatchObject({
      threadId: 'thread-1',
      model: 'gpt-5-codex',
      effort: 'medium',
      input: [
        { type: 'text', text: 'hi', text_elements: [] },
        { type: 'text', text: 'there', text_elements: [] },
      ],
    })
    expect(result).toEqual({ sessionID: 'thread-1', messageID: 'turn-1' })
  })

  it('throws BackendFacadeError on empty parts', async () => {
    const { client } = makeAdapter({})
    await expect(client.sessions.prompt('thread-1', { parts: [] })).rejects.toBeInstanceOf(
      BackendFacadeError,
    )
  })

  it('throws BackendFacadeError when no part has text', async () => {
    const { client } = makeAdapter({})
    await expect(
      client.sessions.prompt('thread-1', {
        parts: [{ type: 'image', url: 'https://x.png' }],
      }),
    ).rejects.toBeInstanceOf(BackendFacadeError)
  })
})

describe('createCodexBackendAdapter / events.subscribe', () => {
  it('wires notifications through the mapper to onEvent and forwards state transitions', () => {
    const events: BackendEvent[] = []
    const states: Array<unknown> = []
    const { client, fake } = makeAdapter({
      initialState: { status: 'connecting', attempt: 0 },
    })
    const sub = client.events.subscribe({
      onEvent(event) {
        events.push(event)
      },
      onConnectionStateChange(state) {
        states.push(state.status)
      },
    })
    // Replay-on-start should emit a connecting state.
    expect(states).toContain('connecting')

    fake.pushNotification('thread/started', { thread: { id: 'thread-1', preview: 'p' } })
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('session.updated')
    expect(events[0]!.sessionID).toBe('thread-1')

    fake.pushState({ status: 'open' })
    expect(states).toContain('open')

    sub.stop()
  })

  it('fans notifications out to multiple active subscribers', () => {
    const a: BackendEvent[] = []
    const b: BackendEvent[] = []
    const { client, fake } = makeAdapter({})
    client.events.subscribe({ onEvent: e => a.push(e) })
    client.events.subscribe({ onEvent: e => b.push(e) })
    fake.pushNotification('thread/status/changed', { threadId: 't', status: 'running' })
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
  })
})

describe('createCodexBackendAdapter / approvals.respond', () => {
  it('happy path: subscribe → server request → respond({kind:accept}) sends decision and emits approval.resolved', async () => {
    const events: BackendEvent[] = []
    const { client, fake } = makeAdapter({})
    client.events.subscribe({ onEvent: e => events.push(e) })

    const req = makeServerRequest(
      'item/commandExecution/requestApproval',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        command: 'rm -rf /',
        cwd: '/',
        availableDecisions: ['accept', 'decline'],
      },
      'srv-1',
    )
    fake.pushServerRequest(req)
    expect(events.some(e => e.type === 'approval.requested')).toBe(true)
    const requested = events.find(e => e.type === 'approval.requested')!
    // approvalID is opaque to callers — read it from the event rather than
    // assuming any specific encoding. (mapper uses JSON.stringify so a
    // string id 'srv-1' surfaces as '"srv-1"', preserving id-type identity.)
    const approvalID = requested.approvalID!

    await client.approvals!.respond(approvalID, { kind: 'accept' })
    expect(req.responded.result).toEqual({ decision: 'accept' })
    expect(events.some(e => e.type === 'approval.resolved')).toBe(true)
  })

  it('translates acceptWithExecpolicyAmendment payload into the wire object form', async () => {
    const events: BackendEvent[] = []
    const { client, fake } = makeAdapter({})
    client.events.subscribe({ onEvent: e => events.push(e) })
    const req = makeServerRequest(
      'item/commandExecution/requestApproval',
      { threadId: 't', turnId: 'u', itemId: 'i', command: 'x', cwd: '/' },
      'srv-2',
    )
    fake.pushServerRequest(req)
    const approvalID = events.find(e => e.type === 'approval.requested')!.approvalID!
    await client.approvals!.respond(approvalID, {
      kind: 'acceptWithExecpolicyAmendment',
      payload: { execpolicy_amendment: { foo: 'bar' } },
    })
    expect(req.responded.result).toEqual({
      decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: { foo: 'bar' } } },
    })
  })

  it('throws BackendFacadeError on unsupported decision kind', async () => {
    const events: BackendEvent[] = []
    const { client, fake } = makeAdapter({})
    client.events.subscribe({ onEvent: e => events.push(e) })
    const req = makeServerRequest(
      'item/commandExecution/requestApproval',
      { threadId: 't' },
      'srv-3',
    )
    fake.pushServerRequest(req)
    const approvalID = events.find(e => e.type === 'approval.requested')!.approvalID!
    await expect(
      client.approvals!.respond(approvalID, { kind: 'totallyMadeUp' }),
    ).rejects.toBeInstanceOf(BackendFacadeError)
  })

  it('throws BackendFacadeError when approvalID is unknown', async () => {
    const { client } = makeAdapter({})
    await expect(
      client.approvals!.respond('does-not-exist', { kind: 'accept' }),
    ).rejects.toBeInstanceOf(BackendFacadeError)
  })

  it('fileChange approvals only accept plain string decisions', async () => {
    const events: BackendEvent[] = []
    const { client, fake } = makeAdapter({})
    client.events.subscribe({ onEvent: e => events.push(e) })
    const req = makeServerRequest(
      'item/fileChange/requestApproval',
      { threadId: 't', turnId: 'u', itemId: 'i' },
      'srv-fc',
    )
    fake.pushServerRequest(req)
    const firstApprovalID = events.find(e => e.type === 'approval.requested')!.approvalID!
    await client.approvals!.respond(firstApprovalID, { kind: 'decline' })
    expect(req.responded.result).toEqual({ decision: 'decline' })

    // Build a second pending approval and try a structured decision — must throw.
    const before = events.filter(e => e.type === 'approval.requested').length
    const req2 = makeServerRequest(
      'item/fileChange/requestApproval',
      { threadId: 't', turnId: 'u', itemId: 'i' },
      'srv-fc-2',
    )
    fake.pushServerRequest(req2)
    const secondApprovalID = events.filter(e => e.type === 'approval.requested')[before]!.approvalID!
    await expect(
      client.approvals!.respond(secondApprovalID, {
        kind: 'acceptWithExecpolicyAmendment',
        payload: { execpolicy_amendment: { foo: 'bar' } },
      }),
    ).rejects.toBeInstanceOf(BackendFacadeError)
  })

  it('auto-declines unknown server-initiated request methods via respondError', () => {
    const { client, fake } = makeAdapter({})
    client.events.subscribe({ onEvent: () => {} })
    const req = makeServerRequest('totally/unknown', {}, 'srv-unk')
    const respondError = vi.spyOn(req, 'respondError')
    fake.pushServerRequest(req)
    expect(respondError).toHaveBeenCalledWith(-32601, expect.stringContaining('unsupported'))
  })

  it('approval.resolved reaches every active subscriber, not only the one whose call fired', async () => {
    const a: BackendEvent[] = []
    const b: BackendEvent[] = []
    const { client, fake } = makeAdapter({})
    client.events.subscribe({ onEvent: e => a.push(e) })
    client.events.subscribe({ onEvent: e => b.push(e) })
    const req = makeServerRequest(
      'item/commandExecution/requestApproval',
      { threadId: 't' },
      'srv-shared',
    )
    fake.pushServerRequest(req)
    const approvalID = a.find(e => e.type === 'approval.requested')!.approvalID!
    await client.approvals!.respond(approvalID, { kind: 'accept' })
    const aResolved = a.filter(e => e.type === 'approval.resolved')
    const bResolved = b.filter(e => e.type === 'approval.resolved')
    expect(aResolved).toHaveLength(1)
    expect(bResolved).toHaveLength(1)
  })
})

describe('createCodexBackendAdapter / disconnect cleanup (FIX-2/FIX-3)', () => {
  // FIX-2: mapper.reset() must be invoked when the connection drops, so the
  // open-item map doesn't leak across reconnects and misroute outputDelta.
  it('resets the mapper on a reconnecting state transition', () => {
    const { client, fake, getMapper } = makeAdapter({})
    // Subscribe so the adapter attaches the protocol's connection-state
    // listener (which is the layer that calls mapper.reset()).
    client.events.subscribe({ onEvent: () => {} })
    const captured = getMapper()
    const resetSpy = vi.spyOn(captured, 'reset')

    // Open item — populates the mapper's open-items map.
    captured.setActiveThread('thread-1')
    captured.mapNotification('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'item-1', type: 'commandExecution', command: 'ls', cwd: '/' },
    })

    // Push a connection-state change — must reset mapper.
    fake.pushState({ status: 'reconnecting', attempt: 1, reason: 'lost' })
    expect(resetSpy).toHaveBeenCalled()
  })

  it('clears pendingApprovals on reconnecting so stale ids cannot be respondTo', async () => {
    const { client, fake } = makeAdapter({})
    client.events.subscribe({ onEvent: () => {} })

    // Populate pendingApprovals.
    const req = makeServerRequest(
      'item/commandExecution/requestApproval',
      { threadId: 't', turnId: 'u', itemId: 'i', command: 'x', cwd: '/' },
      'srv-cleanup',
    )
    fake.pushServerRequest(req)

    // Sanity: the entry exists (otherwise respond would already throw).
    // Push a disconnect — must clear the pendingApprovals map.
    fake.pushState({ status: 'reconnecting', attempt: 1, reason: 'lost' })

    // FIX-3: trying to respond to a cleared approval must throw "not found"
    // the same way an unknown approvalID does.
    await expect(
      client.approvals!.respond('srv-cleanup', { kind: 'accept' }),
    ).rejects.toBeInstanceOf(BackendFacadeError)
  })

  it('also resets on a closed transition (no retry path)', () => {
    const { client, fake, getMapper } = makeAdapter({})
    client.events.subscribe({ onEvent: () => {} })
    const captured = getMapper()
    const resetSpy = vi.spyOn(captured, 'reset')
    fake.pushState({ status: 'closed' })
    expect(resetSpy).toHaveBeenCalled()
  })
})

describe('createCodexBackendAdapter / sessions.list pagination (FIX-4)', () => {
  it('paginates via nextCursor and concatenates pages', async () => {
    let call = 0
    const seen: unknown[] = []
    const { client } = makeAdapter({
      requestHandler: (method, params) => {
        if (method !== 'thread/list') throw new Error(`unexpected ${method}`)
        call += 1
        seen.push(params)
        if (call === 1) {
          return {
            data: [
              { id: 't1', preview: 'p1', status: 'idle', updatedAt: 0, cwd: '/' },
              { id: 't2', preview: 'p2', status: 'idle', updatedAt: 0, cwd: '/' },
            ],
            nextCursor: 'p2',
          }
        }
        return {
          data: [
            { id: 't3', preview: 'p3', status: 'idle', updatedAt: 0, cwd: '/' },
          ],
          nextCursor: null,
        }
      },
    })
    const summaries = await client.sessions.list()
    expect(call).toBe(2)
    expect(seen[0]).toEqual({})
    expect(seen[1]).toEqual({ cursor: 'p2' })
    expect(summaries.map(s => s.id)).toEqual(['t1', 't2', 't3'])
  })

  it('terminates after a single page when nextCursor is null (no spurious extra request)', async () => {
    let call = 0
    const { client } = makeAdapter({
      requestHandler: (method) => {
        if (method !== 'thread/list') throw new Error(`unexpected ${method}`)
        call += 1
        return {
          data: [{ id: 't1', preview: 'p', status: 'idle', updatedAt: 0, cwd: '/' }],
          nextCursor: null,
        }
      },
    })
    const summaries = await client.sessions.list()
    expect(call).toBe(1)
    expect(summaries).toHaveLength(1)
  })
})

describe('createCodexBackendAdapter / catalog.providers', () => {
  it('paginates via nextCursor and merges all pages into one provider with all models', async () => {
    let call = 0
    const seen: unknown[] = []
    const { client } = makeAdapter({
      requestHandler: (method, params) => {
        if (method !== 'model/list') throw new Error(`unexpected ${method}`)
        call += 1
        seen.push(params)
        if (call === 1) {
          return {
            data: [
              {
                id: 'gpt-5-codex',
                displayName: 'GPT-5 Codex',
                description: 'codex',
                hidden: false,
                isDefault: true,
                defaultReasoningEffort: 'medium',
                supportedReasoningEfforts: [{ kind: 'minimal' }, { kind: 'medium' }],
              },
            ],
            nextCursor: 'page-2',
          }
        }
        return {
          data: [
            {
              id: 'o4-mini',
              displayName: 'o4-mini',
              description: 'mini',
              hidden: false,
              isDefault: false,
              defaultReasoningEffort: 'low',
              supportedReasoningEfforts: [],
            },
          ],
          nextCursor: null,
        }
      },
    })
    const catalog = await client.catalog!.providers()
    expect(call).toBe(2)
    expect(seen[0]).toEqual({})
    expect(seen[1]).toEqual({ cursor: 'page-2' })
    expect(catalog.providers).toHaveLength(1)
    const provider = catalog.providers[0]!
    expect(provider.id).toBe('codex')
    expect(provider.models).toHaveLength(2)
    expect(provider.models[0]).toMatchObject({
      id: 'gpt-5-codex',
      reasoning: true,
      reasoningEfforts: ['minimal', 'medium'],
    })
    expect(provider.models[1]).toMatchObject({
      id: 'o4-mini',
      reasoning: false,
      reasoningEfforts: [],
    })
    expect(catalog.defaults).toEqual({ codex: 'gpt-5-codex' })
  })

  it('catalog.agents returns []', async () => {
    const { client } = makeAdapter({})
    await expect(client.catalog!.agents()).resolves.toEqual([])
  })
})
