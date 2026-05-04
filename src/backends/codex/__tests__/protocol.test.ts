import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BackendChannel, ChannelState, OpenBackendChannelOptions } from '../channel.js'
import {
  createCodexProtocolClient,
  type CodexProtocolClient,
  type ProtocolConnectionState,
  type ServerInitiatedRequest,
} from '../protocol.js'
import { startInProcessCodexMock } from './mock-server/in-process.js'

// ---------------------------------------------------------------------------
// In-memory fake channel used for unit tests of the JSON-RPC protocol layer.
// Lets each test drive both directions of the wire and observe the frames the
// protocol sends in order.
// ---------------------------------------------------------------------------

interface FakeChannel extends BackendChannel {
  /** Frames the protocol has sent so far, in order. */
  sent: Record<string, unknown>[]
  /** Feed an inbound JSON-RPC frame from the "server". */
  receive(frame: Record<string, unknown>): void
  /** Push a state event from the underlying transport. */
  pushState(state: ChannelState): void
  /** Whether close() has been called on this channel. */
  closed: boolean
  /** Number of times this channel was constructed (for reconnect assertions). */
  generation: number
  /** Configure send() to reject on the next call. */
  failNextSend(reason?: unknown): void
}

interface FakeChannelFactory {
  channels: FakeChannel[]
  open: (opts: OpenBackendChannelOptions) => Promise<BackendChannel>
}

function createFakeChannel(generation: number): FakeChannel {
  const messageHandlers = new Set<(frame: Record<string, unknown>) => void>()
  const stateHandlers = new Set<(state: ChannelState) => void>()
  let nextSendError: unknown = null

  const channel: FakeChannel = {
    sent: [],
    closed: false,
    generation,
    failNextSend(reason: unknown = new Error('send failed')) {
      nextSendError = reason
    },
    async send(payload: Record<string, unknown>): Promise<void> {
      if (nextSendError) {
        const err = nextSendError
        nextSendError = null
        throw err
      }
      if (channel.closed) {
        throw new Error('channel: closed')
      }
      channel.sent.push(payload)
    },
    onMessage(handler) {
      messageHandlers.add(handler)
      return () => {
        messageHandlers.delete(handler)
      }
    },
    onState(handler) {
      stateHandlers.add(handler)
      return () => {
        stateHandlers.delete(handler)
      }
    },
    async close(): Promise<void> {
      channel.closed = true
    },
    receive(frame) {
      for (const h of [...messageHandlers]) h(frame)
    },
    pushState(state) {
      for (const h of [...stateHandlers]) h(state)
    },
  }
  return channel
}

function createFakeChannelFactory(): FakeChannelFactory {
  const channels: FakeChannel[] = []
  return {
    channels,
    async open(_opts: OpenBackendChannelOptions): Promise<BackendChannel> {
      const ch = createFakeChannel(channels.length + 1)
      channels.push(ch)
      return ch
    },
  }
}

const STD_CLIENT_INFO = { name: 'codex-mobile-tests', version: '0.0.0' }

/** Wait one microtask + macrotask so queued promises settle. */
async function tick(): Promise<void> {
  await Promise.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

/** Run all queued microtasks until the predicate holds, with a watchdog. */
async function waitFor(predicate: () => boolean, label = 'predicate'): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await tick()
  }
  throw new Error(`waitFor: ${label} did not become true within budget`)
}

/**
 * Drive the standard handshake on the most recently opened fake channel.
 * Returns once the protocol has sent both `initialize` and `initialized`.
 */
async function completeHandshake(
  factory: FakeChannelFactory,
  initializeResult: Record<string, unknown> = { userAgent: 'mock', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' },
): Promise<FakeChannel> {
  await waitFor(() => factory.channels.length > 0, 'channel opened')
  const ch = factory.channels[factory.channels.length - 1]!
  await waitFor(() => ch.sent.length >= 1, 'initialize sent')
  const initFrame = ch.sent[0]!
  expect(initFrame.method).toBe('initialize')
  expect(typeof initFrame.id === 'number' || typeof initFrame.id === 'string').toBe(true)
  ch.receive({ jsonrpc: '2.0', id: initFrame.id as number | string, result: initializeResult })
  await waitFor(() => ch.sent.length >= 2, 'initialized notification sent')
  return ch
}

describe('createCodexProtocolClient — handshake gate', () => {
  it('sends initialize request, waits for response, then sends initialized notification', async () => {
    const factory = createFakeChannelFactory()
    const client = createCodexProtocolClient({
      url: 'ws://test',
      openChannel: factory.open,
      clientInfo: STD_CLIENT_INFO,
    })

    await waitFor(() => factory.channels.length === 1, 'channel opened')
    const ch = factory.channels[0]!
    await waitFor(() => ch.sent.length >= 1, 'first frame sent')
    const initFrame = ch.sent[0]!
    expect(initFrame.jsonrpc).toBe('2.0')
    expect(initFrame.method).toBe('initialize')
    expect(initFrame.id).toBe(1)
    expect(initFrame.params).toEqual({
      clientInfo: STD_CLIENT_INFO,
      capabilities: null,
    })
    // Initialized must NOT have been sent yet — handshake gated on response.
    expect(ch.sent.length).toBe(1)

    ch.receive({ jsonrpc: '2.0', id: 1, result: { userAgent: 'mock' } })
    await waitFor(() => ch.sent.length >= 2, 'initialized sent')
    const initializedFrame = ch.sent[1]!
    expect(initializedFrame.jsonrpc).toBe('2.0')
    expect(initializedFrame.method).toBe('initialized')
    expect('id' in initializedFrame).toBe(false)

    await client.close()
  })

  it('queues request() calls issued before handshake completes', async () => {
    const factory = createFakeChannelFactory()
    const client = createCodexProtocolClient({
      url: 'ws://test',
      openChannel: factory.open,
      clientInfo: STD_CLIENT_INFO,
    })

    // Issue request before the handshake response is fed.
    const pending = client.request<{ ok: boolean }>('thread/list', {})

    // Give the protocol a chance to send initialize but not flush the queue.
    await waitFor(() => factory.channels.length === 1, 'channel opened')
    const ch = factory.channels[0]!
    await waitFor(() => ch.sent.length >= 1, 'initialize sent')
    expect(ch.sent.length).toBe(1) // initialize only — thread/list is queued

    // Resolve handshake.
    ch.receive({ jsonrpc: '2.0', id: 1, result: {} })
    await waitFor(() => ch.sent.length >= 3, 'queued thread/list flushed')

    const flushed = ch.sent[2]!
    expect(flushed.method).toBe('thread/list')
    expect(flushed.id).toBe(2)

    // Reply to thread/list.
    ch.receive({ jsonrpc: '2.0', id: 2, result: { ok: true } })
    await expect(pending).resolves.toEqual({ ok: true })

    await client.close()
  })
})

describe('createCodexProtocolClient — request/response correlation', () => {
  it('correlates two interleaved in-flight calls by id', async () => {
    const factory = createFakeChannelFactory()
    const client = createCodexProtocolClient({
      url: 'ws://test',
      openChannel: factory.open,
      clientInfo: STD_CLIENT_INFO,
    })
    const ch = await completeHandshake(factory)

    const callA = client.request<{ which: 'a' }>('a/method', { x: 1 })
    const callB = client.request<{ which: 'b' }>('b/method', { x: 2 })
    await waitFor(() => ch.sent.length >= 4, 'both sends drained')

    const aFrame = ch.sent[2]!
    const bFrame = ch.sent[3]!
    expect(aFrame.method).toBe('a/method')
    expect(bFrame.method).toBe('b/method')
    expect(aFrame.id).toBe(2)
    expect(bFrame.id).toBe(3)

    // Respond out of order — B first, then A.
    ch.receive({ jsonrpc: '2.0', id: 3, result: { which: 'b' } })
    ch.receive({ jsonrpc: '2.0', id: 2, result: { which: 'a' } })

    await expect(callA).resolves.toEqual({ which: 'a' })
    await expect(callB).resolves.toEqual({ which: 'b' })

    await client.close()
  })

  it('rejects request() with a JSON-RPC error frame', async () => {
    const factory = createFakeChannelFactory()
    const client = createCodexProtocolClient({
      url: 'ws://test',
      openChannel: factory.open,
      clientInfo: STD_CLIENT_INFO,
    })
    const ch = await completeHandshake(factory)

    const call = client.request('boom', {})
    await waitFor(() => ch.sent.length >= 3, 'send drained')
    const idSent = ch.sent[2]!.id as number
    ch.receive({
      jsonrpc: '2.0',
      id: idSent,
      error: { code: -32601, message: 'method not found' },
    })

    await expect(call).rejects.toThrow(/method not found/)

    await client.close()
  })

  it('drops late responses for unknown ids without crashing', async () => {
    const factory = createFakeChannelFactory()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client = createCodexProtocolClient({
      url: 'ws://test',
      openChannel: factory.open,
      clientInfo: STD_CLIENT_INFO,
    })
    const ch = await completeHandshake(factory)

    ch.receive({ jsonrpc: '2.0', id: 99999, result: { stale: true } })
    expect(warnSpy).toHaveBeenCalled()

    await client.close()
    warnSpy.mockRestore()
  })
})

describe('createCodexProtocolClient — timeouts', () => {
  it('rejects request() with a timeout error containing the method name', async () => {
    const factory = createFakeChannelFactory()
    const client = createCodexProtocolClient({
      url: 'ws://test',
      openChannel: factory.open,
      clientInfo: STD_CLIENT_INFO,
    })
    await completeHandshake(factory)

    const call = client.request('thread/list', {}, { timeoutMs: 30 })
    await expect(call).rejects.toThrow(/timeout.*thread\/list/)

    await client.close()
  })

  // FIX-1 regression: a request queued before handshake completes must NOT
  // be flushed onto the wire if its timeout already fired. Otherwise the
  // server sees a frame with a unique id whose response has no listener.
  it('does not flush a queued request whose timeout fired before handshake completed', async () => {
    const factory = createFakeChannelFactory()
    const client = createCodexProtocolClient({
      url: 'ws://test',
      openChannel: factory.open,
      clientInfo: STD_CLIENT_INFO,
    })

    // Issue request with a very short timeout BEFORE we resolve the handshake.
    const queued = client.request('thread/list', {}, { timeoutMs: 20 })

    // Wait for the channel to open and `initialize` to be sent. Don't reply
    // yet — we want the request to sit in the pre-init queue until timeout.
    await waitFor(() => factory.channels.length === 1, 'channel opened')
    const ch = factory.channels[0]!
    await waitFor(() => ch.sent.length >= 1, 'initialize sent')
    expect(ch.sent.length).toBe(1)

    // Let the timeout fire while we still haven't resolved initialize.
    await expect(queued).rejects.toThrow(/timeout.*thread\/list/)
    const sentBeforeHandshake = ch.sent.length

    // NOW complete the handshake. Flush should skip the cancelled entry.
    ch.receive({ jsonrpc: '2.0', id: 1, result: {} })
    await waitFor(() => ch.sent.length >= sentBeforeHandshake + 1, 'initialized sent')

    // After handshake the only new frame should be `initialized` — the
    // previously-timed-out thread/list request must NOT appear on the wire.
    const allSent = ch.sent.slice()
    expect(allSent.find(f => f.method === 'thread/list')).toBeUndefined()
    // Also assert the channel saw exactly the two handshake frames.
    expect(allSent.map(f => f.method)).toEqual(['initialize', 'initialized'])

    await client.close()
  })
})

describe('createCodexProtocolClient — server-initiated requests', () => {
  it('delivers server requests to onServerRequest and roundtrips respond()', async () => {
    const factory = createFakeChannelFactory()
    const client = createCodexProtocolClient({
      url: 'ws://test',
      openChannel: factory.open,
      clientInfo: STD_CLIENT_INFO,
    })
    const ch = await completeHandshake(factory)

    const seen: ServerInitiatedRequest[] = []
    client.onServerRequest((r) => seen.push(r))

    ch.receive({
      jsonrpc: '2.0',
      id: 'srv-1',
      method: 'item/commandExecution/requestApproval',
      params: { reason: 'approve' },
    })
    expect(seen.length).toBe(1)
    expect(seen[0]!.method).toBe('item/commandExecution/requestApproval')
    expect(seen[0]!.params).toEqual({ reason: 'approve' })

    await seen[0]!.respond({ decision: 'accept' })
    const last = ch.sent[ch.sent.length - 1]!
    expect(last).toEqual({ jsonrpc: '2.0', id: 'srv-1', result: { decision: 'accept' } })

    await client.close()
  })

  it('throws if respond() is called twice on the same server request', async () => {
    const factory = createFakeChannelFactory()
    const client = createCodexProtocolClient({
      url: 'ws://test',
      openChannel: factory.open,
      clientInfo: STD_CLIENT_INFO,
    })
    const ch = await completeHandshake(factory)

    let captured: ServerInitiatedRequest | null = null
    client.onServerRequest((r) => {
      captured = r
    })
    ch.receive({ jsonrpc: '2.0', id: 'srv-x', method: 'fake/req', params: null })
    expect(captured).not.toBeNull()
    const wrapper = captured!
    await wrapper.respond({ ok: true })
    await expect(wrapper.respond({ ok: true })).rejects.toThrow(/already responded/)

    await client.close()
  })

  it('auto-fails outstanding server requests on protocol close', async () => {
    const factory = createFakeChannelFactory()
    const client = createCodexProtocolClient({
      url: 'ws://test',
      openChannel: factory.open,
      clientInfo: STD_CLIENT_INFO,
    })
    const ch = await completeHandshake(factory)

    let captured: ServerInitiatedRequest | null = null
    client.onServerRequest((r) => {
      captured = r
    })
    ch.receive({ jsonrpc: '2.0', id: 'srv-y', method: 'fake/req', params: null })
    expect(captured).not.toBeNull()
    const wrapper = captured!

    await client.close()

    // Wrapper should now consider itself responded (auto respondError fired).
    await expect(wrapper.respond({ ok: true })).rejects.toThrow(/already responded/)
  })
})

describe('createCodexProtocolClient — notifications', () => {
  it('fans notifications out to multiple listeners and supports unsubscribe', async () => {
    const factory = createFakeChannelFactory()
    const client = createCodexProtocolClient({
      url: 'ws://test',
      openChannel: factory.open,
      clientInfo: STD_CLIENT_INFO,
    })
    const ch = await completeHandshake(factory)

    const a = vi.fn()
    const b = vi.fn()
    const unsubA = client.onNotification(a)
    client.onNotification(b)

    ch.receive({ jsonrpc: '2.0', method: 'thread/started', params: { id: 't1' } })
    expect(a).toHaveBeenCalledWith({ method: 'thread/started', params: { id: 't1' } })
    expect(b).toHaveBeenCalledWith({ method: 'thread/started', params: { id: 't1' } })

    unsubA()
    ch.receive({ jsonrpc: '2.0', method: 'turn/started', params: { id: 't1', turnId: 'u1' } })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(2)

    await client.close()
  })
})

describe('createCodexProtocolClient — reconnect', () => {
  it('transitions through reconnecting and re-runs initialize on a new channel', async () => {
    const factory = createFakeChannelFactory()
    const client = createCodexProtocolClient({
      url: 'ws://test',
      openChannel: factory.open,
      clientInfo: STD_CLIENT_INFO,
      retrySchedule: [10, 20], // fast schedule for the test
    })
    const states: ProtocolConnectionState[] = []
    client.onConnectionState((s) => states.push(s))

    const ch1 = await completeHandshake(factory)
    await waitFor(() => states.some((s) => s.status === 'open'), 'first open')

    // Simulate a remote close.
    ch1.pushState({ state: 'closed', code: 1006 })

    // After the configured delay the protocol should open a fresh channel.
    await waitFor(() => factory.channels.length === 2, 'second channel opened')

    // Drive handshake on channel 2 — id counter should reset to 1.
    const ch2 = factory.channels[1]!
    await waitFor(() => ch2.sent.length >= 1, 'second initialize sent')
    expect(ch2.sent[0]!.method).toBe('initialize')
    expect(ch2.sent[0]!.id).toBe(1)
    ch2.receive({ jsonrpc: '2.0', id: 1, result: {} })
    await waitFor(() => ch2.sent.length >= 2, 'second initialized sent')
    expect(ch2.sent[1]!.method).toBe('initialized')

    await waitFor(
      () => states.filter((s) => s.status === 'open').length >= 2,
      'second open state',
    )
    const statusSequence = states.map((s) => s.status)
    expect(statusSequence).toContain('reconnecting')
    expect(statusSequence.filter((s) => s === 'open').length).toBeGreaterThanOrEqual(2)

    await client.close()
  })

  it('rejects in-flight requests on channel close', async () => {
    const factory = createFakeChannelFactory()
    const client = createCodexProtocolClient({
      url: 'ws://test',
      openChannel: factory.open,
      clientInfo: STD_CLIENT_INFO,
      retrySchedule: [5],
    })
    const ch = await completeHandshake(factory)
    const call = client.request('long/op', {})
    await waitFor(() => ch.sent.length >= 3, 'request sent')
    ch.pushState({ state: 'closed', code: 1006 })
    await expect(call).rejects.toThrow(/channel closed/)
    await client.close()
  })

  it('honors a custom retry schedule using fake timers', async () => {
    vi.useFakeTimers()
    try {
      const factory = createFakeChannelFactory()
      const client = createCodexProtocolClient({
        url: 'ws://test',
        openChannel: factory.open,
        clientInfo: STD_CLIENT_INFO,
        retrySchedule: [10, 20],
      })

      // Drive the first handshake.
      // openConnection runs as a microtask kicked by ensureBootstrap; resolve
      // it before asserting on factory.channels.
      await vi.advanceTimersByTimeAsync(0)
      await Promise.resolve()
      expect(factory.channels.length).toBe(1)
      const ch1 = factory.channels[0]!
      // Initialize was sent synchronously; respond.
      ch1.receive({ jsonrpc: '2.0', id: 1, result: {} })
      await vi.advanceTimersByTimeAsync(0)
      await Promise.resolve()

      // Trigger termination — reconnect is scheduled at retrySchedule[0]=10ms.
      ch1.pushState({ state: 'closed', code: 1006 })
      // Before 10ms have elapsed, no new channel.
      await vi.advanceTimersByTimeAsync(5)
      expect(factory.channels.length).toBe(1)
      // After the remaining time, the second channel opens.
      await vi.advanceTimersByTimeAsync(5)
      await Promise.resolve()
      expect(factory.channels.length).toBe(2)

      // Fail this attempt by closing the new channel during handshake.
      const ch2 = factory.channels[1]!
      ch2.pushState({ state: 'error', error: 'reset' })
      // Next reconnect uses retrySchedule[1]=20ms.
      await vi.advanceTimersByTimeAsync(15)
      expect(factory.channels.length).toBe(2)
      await vi.advanceTimersByTimeAsync(5)
      await Promise.resolve()
      expect(factory.channels.length).toBe(3)

      await client.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('transitions to failed (no retry) when retrySchedule is empty', async () => {
    const factory = createFakeChannelFactory()
    const client = createCodexProtocolClient({
      url: 'ws://test',
      openChannel: factory.open,
      clientInfo: STD_CLIENT_INFO,
      retrySchedule: [],
    })
    const states: ProtocolConnectionState[] = []
    client.onConnectionState((s) => states.push(s))
    const ch = await completeHandshake(factory)
    ch.pushState({ state: 'closed', code: 1006 })
    await tick()
    expect(states[states.length - 1]!.status).toBe('failed')
    await client.close()
  })
})

describe('createCodexProtocolClient — end to end via in-process mock', () => {
  let client: CodexProtocolClient | null = null
  let mock: Awaited<ReturnType<typeof startInProcessCodexMock>> | null = null

  beforeEach(() => {
    client = null
    mock = null
  })

  afterEach(async () => {
    if (client) {
      try {
        await client.close()
      } catch {
        // ignore
      }
      client = null
    }
    if (mock) {
      await mock.dispose()
      mock = null
    }
  })

  it('completes a real handshake and answers model/list with the fixture data', async () => {
    mock = await startInProcessCodexMock()
    // Adapt the mock URL into a channel factory that uses the `ws` package
    // directly — we don't rely on the native bridge in tests.
    const { default: WebSocket } = await import('ws')
    const url = mock.url
    client = createCodexProtocolClient({
      url,
      clientInfo: STD_CLIENT_INFO,
      defaultTimeoutMs: 4_000,
      retrySchedule: [],
      openChannel: async () => {
        const socket = new WebSocket(url)
        await new Promise<void>((resolve, reject) => {
          const onOpen = (): void => {
            socket.off('error', onError)
            resolve()
          }
          const onError = (err: Error): void => {
            socket.off('open', onOpen)
            reject(err)
          }
          socket.once('open', onOpen)
          socket.once('error', onError)
        })

        const messageHandlers = new Set<(frame: Record<string, unknown>) => void>()
        const stateHandlers = new Set<(state: ChannelState) => void>()

        socket.on('message', (raw) => {
          let parsed: unknown
          try {
            parsed = JSON.parse(raw.toString('utf8'))
          } catch {
            return
          }
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            const frame = parsed as Record<string, unknown>
            for (const h of [...messageHandlers]) h(frame)
          }
        })
        socket.on('close', (code: number, reasonBuf: Buffer) => {
          const state: ChannelState = { state: 'closed', code, reason: reasonBuf.toString('utf8') }
          for (const h of [...stateHandlers]) h(state)
        })
        socket.on('error', (err: Error) => {
          const state: ChannelState = { state: 'error', error: String(err.message ?? err) }
          for (const h of [...stateHandlers]) h(state)
        })

        const channel: BackendChannel = {
          async send(payload) {
            await new Promise<void>((resolve, reject) => {
              socket.send(JSON.stringify(payload), (err) => {
                if (err) reject(err)
                else resolve()
              })
            })
          },
          onMessage(handler) {
            messageHandlers.add(handler)
            return () => {
              messageHandlers.delete(handler)
            }
          },
          onState(handler) {
            stateHandlers.add(handler)
            return () => {
              stateHandlers.delete(handler)
            }
          },
          async close() {
            try {
              socket.close()
            } catch {
              // ignore
            }
          },
        }
        return channel
      },
    })

    const result = await client.request<{ data: Array<{ id: string }> }>('model/list', {})
    expect(Array.isArray(result.data)).toBe(true)
    expect(result.data[0]!.id).toBe('gpt-5-codex')
  })
})
