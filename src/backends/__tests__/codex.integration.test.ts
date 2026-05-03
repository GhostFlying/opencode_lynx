import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

import { connectCodexBackendClient } from '../codex/page-migration.js'
import {
  createCodexBackendAdapter,
  type CodexBackendConfig,
} from '../codex/adapter.js'
import {
  openBackendChannel,
  type BackendChannel,
  type BackendChannelBridge,
  type OpenBackendChannelOptions,
} from '../codex/channel.js'
import {
  startInProcessCodexMock,
  type InProcessCodexMockHandle,
} from '../codex/__tests__/mock-server/in-process.js'
import type { BackendEvent } from '../types.js'

// ---------------------------------------------------------------------------
// Fake BackendChannelBridge: proxies the native protocol over a real `ws`
// connection. This lets us drive `openBackendChannel()` (the actual production
// channel.ts code path) without a Lynx native bridge in Node tests.
//
// Design choice (documented per handoff M2.6): we build the bridge at the
// `BackendChannelBridge` seam, then pass it via `openBackendChannel({ bridge })`
// inside an `openChannel` lambda we hand to `createCodexBackendAdapter`. This
// keeps every line of channel.ts under test alongside the protocol +
// adapter + mapper stack — only the literal native bridge is faked.
// ---------------------------------------------------------------------------

interface FakeBridgeChannel {
  socket: WebSocket
  messageEventName: string
  stateEventName: string
}

interface FakeBridge extends BackendChannelBridge {
  /** Force-close the underlying ws for the most recently opened channel. */
  killActiveSocket(): void
  /** All ws connections opened via this bridge, in order. */
  sockets(): readonly WebSocket[]
}

function createFakeWsBridge(): FakeBridge {
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const channels = new Map<string, FakeBridgeChannel>()
  const sockets: WebSocket[] = []
  let nextChannelId = 1

  function emit(eventName: string, event: unknown): void {
    const set = listeners.get(eventName)
    if (!set) return
    for (const handler of [...set]) {
      try {
        handler(event)
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('[fake-bridge] listener threw', error)
      }
    }
  }

  function on(
    eventName: string,
    callback: (event: unknown) => void,
  ): (event: unknown) => void {
    let set = listeners.get(eventName)
    if (!set) {
      set = new Set()
      listeners.set(eventName, set)
    }
    set.add(callback)
    return callback
  }

  function off(eventName: string, callback: (event: unknown) => void): void {
    const set = listeners.get(eventName)
    if (!set) return
    set.delete(callback)
    if (set.size === 0) listeners.delete(eventName)
  }

  async function callAsync(method: string, params: unknown): Promise<unknown> {
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      throw new Error(`fake bridge: ${method} requires object params`)
    }
    const p = params as Record<string, unknown>

    switch (method) {
      case 'backend.channel.open': {
        const url = typeof p.url === 'string' ? p.url : ''
        const messageEventName =
          typeof p.message_event_name === 'string' ? p.message_event_name : ''
        const stateEventName =
          typeof p.state_event_name === 'string' ? p.state_event_name : ''
        if (!url || !messageEventName || !stateEventName) {
          throw new Error('fake bridge: backend.channel.open missing fields')
        }
        const channelId = `ch-${nextChannelId++}`
        const socket = new WebSocket(url)
        sockets.push(socket)

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

        socket.on('message', (raw) => {
          let parsed: unknown
          try {
            parsed = JSON.parse(raw.toString('utf8'))
          } catch {
            return
          }
          if (
            typeof parsed === 'object' &&
            parsed !== null &&
            !Array.isArray(parsed)
          ) {
            emit(messageEventName, { frame: parsed })
          }
        })

        socket.on('close', (code: number, reasonBuf: Buffer) => {
          emit(stateEventName, {
            state: 'closed',
            code,
            reason: reasonBuf.toString('utf8'),
          })
        })

        socket.on('error', (err: Error) => {
          emit(stateEventName, {
            state: 'error',
            error: String(err.message ?? err),
          })
        })

        // Surface "open" so any onState replay gets the live state.
        emit(stateEventName, { state: 'open' })

        channels.set(channelId, { socket, messageEventName, stateEventName })
        return { channel_id: channelId }
      }

      case 'backend.channel.send': {
        const channelId = typeof p.channel_id === 'string' ? p.channel_id : ''
        const ch = channels.get(channelId)
        if (!ch) throw new Error(`fake bridge: unknown channel_id ${channelId}`)
        const payload = p.payload
        await new Promise<void>((resolve, reject) => {
          ch.socket.send(JSON.stringify(payload), (err) => {
            if (err) reject(err)
            else resolve()
          })
        })
        return { sent: true }
      }

      case 'backend.channel.close': {
        const channelId = typeof p.channel_id === 'string' ? p.channel_id : ''
        const ch = channels.get(channelId)
        if (!ch) return { closed: true }
        const code = typeof p.code === 'number' ? p.code : undefined
        const reason = typeof p.reason === 'string' ? p.reason : undefined
        try {
          ch.socket.close(code, reason)
        } catch {
          // ignore
        }
        channels.delete(channelId)
        return { closed: true }
      }

      default:
        throw new Error(`fake bridge: unknown method ${method}`)
    }
  }

  return {
    callAsync,
    on,
    off,
    killActiveSocket(): void {
      const last = sockets[sockets.length - 1]
      if (!last) return
      last.terminate()
    },
    sockets(): readonly WebSocket[] {
      return sockets
    },
  }
}

function makeOpenChannelViaFakeBridge(
  bridge: BackendChannelBridge,
): (opts: OpenBackendChannelOptions) => Promise<BackendChannel> {
  return (opts) => openBackendChannel({ ...opts, bridge })
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 4_000,
  label = 'predicate',
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`waitFor: ${label} did not become true within ${timeoutMs}ms`)
}

const activeMocks = new Set<InProcessCodexMockHandle>()
const activeBridges = new Set<FakeBridge>()

afterEach(async () => {
  for (const mock of [...activeMocks]) {
    activeMocks.delete(mock)
    await mock.dispose()
  }
  for (const bridge of [...activeBridges]) {
    activeBridges.delete(bridge)
    for (const socket of bridge.sockets()) {
      try {
        socket.terminate()
      } catch {
        // ignore
      }
    }
  }
})

function parsePort(url: string): string {
  const match = url.match(/:(\d+)$/)
  return match ? match[1]! : '0'
}

describe('codex backend integration with in-process mock', () => {
  it('connects, lists empty sessions, and records the initialize handshake', async () => {
    const mock = await startInProcessCodexMock()
    activeMocks.add(mock)
    const bridge = createFakeWsBridge()
    activeBridges.add(bridge)
    const openChannel = makeOpenChannelViaFakeBridge(bridge)

    const result = await connectCodexBackendClient(
      {
        host: '127.0.0.1',
        port: parsePort(mock.url),
      },
      {
        createClient(target) {
          return createCodexBackendAdapter(
            target.config as CodexBackendConfig,
            { openChannel },
          )
        },
      },
    )

    expect(result.serverLabel).toBe(`ws://127.0.0.1:${parsePort(mock.url)}`)
    expect(result.connection).toEqual({
      host: '127.0.0.1',
      port: parsePort(mock.url),
      token: '',
      secure: false,
    })

    const sessions = await result.client.sessions.list()
    expect(sessions).toEqual([])

    const recorded = mock.recordedRequests()
    const initialize = recorded.find((r) => r.method === 'initialize')
    expect(initialize).toBeDefined()
    expect(initialize?.id).toBe(1)
    const initialized = recorded.find((r) => r.method === 'initialized')
    expect(initialized).toBeDefined()
    expect(initialized?.id).toBeUndefined()
    const threadList = recorded.find((r) => r.method === 'thread/list')
    expect(threadList).toBeDefined()
  })

  it('creates a thread via sessions.create and records thread/start params', async () => {
    const mock = await startInProcessCodexMock()
    activeMocks.add(mock)
    const bridge = createFakeWsBridge()
    activeBridges.add(bridge)
    const openChannel = makeOpenChannelViaFakeBridge(bridge)

    const adapter = createCodexBackendAdapter(
      { url: mock.url },
      { openChannel },
    )

    const created = await adapter.sessions.create()
    expect(created).toMatchObject({
      backend: 'codex',
      id: 'thread-mock-1',
    })

    const recorded = mock.recordedRequests()
    const start = recorded.find((r) => r.method === 'thread/start')
    expect(start).toBeDefined()
    expect(start?.params).toMatchObject({
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    })
  })

  it('streams a happy-path prompt with the expected event sequence', async () => {
    const mock = await startInProcessCodexMock({ scenario: 'happy-path' })
    activeMocks.add(mock)
    const bridge = createFakeWsBridge()
    activeBridges.add(bridge)
    const openChannel = makeOpenChannelViaFakeBridge(bridge)

    const adapter = createCodexBackendAdapter(
      { url: mock.url },
      { openChannel },
    )

    const events: BackendEvent[] = []
    const subscription = adapter.events.subscribe({
      autoStart: true,
      onEvent(event) {
        events.push(event)
      },
    })

    // Drive prompt directly without sessions.create() so the mock's
    // hasPriorThreadStart check stays false and thread/started is emitted —
    // matching the natural happy-path event sequence the chat UI expects.
    const threadId = 'thread-mock-1'
    await adapter.sessions.prompt(threadId, {
      parts: [{ type: 'text', text: 'hi' }],
    })

    await waitFor(
      () => events.some((e) => e.type === 'turn.completed'),
      4_000,
      'turn.completed event',
    )

    const types = events.map((e) => e.type)
    // Sequence (per fixture happy-path):
    //   thread/started -> session.updated
    //   turn/started -> turn.started
    //   item/started (agentMessage) -> message.delta (initial empty)
    //   item/agentMessage/delta x3 -> message.delta x3
    //   item/completed (agentMessage) -> message.updated
    //   turn/completed -> turn.completed
    expect(types).toEqual([
      'session.updated',
      'turn.started',
      'message.delta',
      'message.delta',
      'message.delta',
      'message.delta',
      'message.updated',
      'turn.completed',
    ])

    const recorded = mock.recordedRequests()
    const turnStart = recorded.find((r) => r.method === 'turn/start')
    expect(turnStart).toBeDefined()
    expect(turnStart?.params).toMatchObject({
      threadId,
      input: [{ type: 'text', text: 'hi', text_elements: [] }],
    })

    subscription.stop('done')
  })

  it('round-trips an approval through approvals.respond', async () => {
    const mock = await startInProcessCodexMock({ scenario: 'approvals' })
    activeMocks.add(mock)
    const bridge = createFakeWsBridge()
    activeBridges.add(bridge)
    const openChannel = makeOpenChannelViaFakeBridge(bridge)

    const adapter = createCodexBackendAdapter(
      { url: mock.url },
      { openChannel },
    )

    const events: BackendEvent[] = []
    const subscription = adapter.events.subscribe({
      autoStart: true,
      onEvent(event) {
        events.push(event)
      },
    })

    const created = await adapter.sessions.create()
    const threadId = created.id

    await adapter.sessions.prompt(threadId, {
      parts: [{ type: 'text', text: 'run something dangerous' }],
    })

    await waitFor(
      () => events.some((e) => e.type === 'approval.requested'),
      4_000,
      'approval.requested event',
    )

    const approvalEvent = events.find((e) => e.type === 'approval.requested')!
    expect(approvalEvent.payload).toMatchObject({
      kind: 'commandExecution',
      availableDecisions: ['accept', 'decline', 'cancel'],
    })
    const approvalId = approvalEvent.approvalID
    expect(typeof approvalId).toBe('string')

    await adapter.approvals!.respond(approvalId!, { kind: 'accept' })

    await waitFor(
      () => events.some((e) => e.type === 'turn.completed'),
      4_000,
      'turn.completed after approval',
    )
    await waitFor(
      () => events.some((e) => e.type === 'approval.resolved'),
      1_000,
      'approval.resolved',
    )

    const recorded = mock.recordedRequests()
    const decisionResponse = recorded.find((r) => r.method === '<response>')
    expect(decisionResponse).toBeDefined()
    expect(decisionResponse?.params).toEqual({ decision: 'accept' })

    subscription.stop('done')
  })

  it('streams a tools-scenario prompt with tool.* events', async () => {
    const mock = await startInProcessCodexMock({ scenario: 'tools' })
    activeMocks.add(mock)
    const bridge = createFakeWsBridge()
    activeBridges.add(bridge)
    const openChannel = makeOpenChannelViaFakeBridge(bridge)

    const adapter = createCodexBackendAdapter(
      { url: mock.url },
      { openChannel },
    )

    const events: BackendEvent[] = []
    const subscription = adapter.events.subscribe({
      autoStart: true,
      onEvent(event) {
        events.push(event)
      },
    })

    const created = await adapter.sessions.create()
    const threadId = created.id

    await adapter.sessions.prompt(threadId, {
      parts: [{ type: 'text', text: 'list files' }],
    })

    await waitFor(
      () => events.some((e) => e.type === 'turn.completed'),
      4_000,
      'turn.completed event for tools scenario',
    )

    const toolEvents = events.filter(
      (e) =>
        e.type === 'tool.started' ||
        e.type === 'tool.delta' ||
        e.type === 'tool.completed',
    )
    const toolTypes = toolEvents.map((e) => e.type)
    expect(toolTypes).toEqual([
      'tool.started',
      'tool.delta',
      'tool.delta',
      'tool.completed',
    ])
    expect(toolEvents[0]!.payload).toMatchObject({ kind: 'commandExecution' })
    expect(toolEvents[3]!.payload).toMatchObject({ kind: 'commandExecution' })

    subscription.stop('done')
  })

  it('reconnects after a transport flap and re-issues the initialize handshake', async () => {
    const mock = await startInProcessCodexMock()
    activeMocks.add(mock)
    const bridge = createFakeWsBridge()
    activeBridges.add(bridge)
    const openChannel = makeOpenChannelViaFakeBridge(bridge)

    const adapter = createCodexBackendAdapter(
      { url: mock.url },
      {
        openChannel,
        createProtocolClient: undefined,
      },
    )

    // Use a reconnect-friendly subscription so we can observe state.
    const states: string[] = []
    const subscription = adapter.events.subscribe({
      autoStart: true,
      onConnectionStateChange(snapshot) {
        states.push(snapshot.status)
      },
    })

    // Trigger initial handshake completion.
    await adapter.sessions.list()

    // Verify first handshake recorded.
    expect(
      mock.recordedRequests().filter((r) => r.method === 'initialize').length,
    ).toBe(1)
    expect(states).toContain('open')

    // Force a transport flap by terminating the active ws from the bridge
    // side. The mock-server's per-connection handle is dropped on close, so
    // its prior recorded requests vanish from the aggregate view; the proof
    // of reconnect is that a NEW initialize is recorded by the new handle
    // after the schedule fires.
    bridge.killActiveSocket()

    // Wait for the protocol to surface 'reconnecting' then 'open' again.
    await waitFor(
      () => states.includes('reconnecting'),
      4_000,
      'reconnecting state',
    )
    await waitFor(
      () =>
        states.lastIndexOf('open') > states.lastIndexOf('reconnecting'),
      6_000,
      'open after reconnecting',
    )

    // Issue another request to confirm channel works post-reconnect; the
    // mock will record a fresh initialize on the new handle.
    await adapter.sessions.list()

    const postFlapInitialize = mock
      .recordedRequests()
      .filter((r) => r.method === 'initialize')
    expect(postFlapInitialize.length).toBeGreaterThanOrEqual(1)
    const postFlapInitialized = mock
      .recordedRequests()
      .filter((r) => r.method === 'initialized')
    expect(postFlapInitialized.length).toBeGreaterThanOrEqual(1)
    const postFlapList = mock
      .recordedRequests()
      .filter((r) => r.method === 'thread/list')
    expect(postFlapList.length).toBeGreaterThanOrEqual(1)

    subscription.stop('done')
  })

  it('exposes the codex provider catalog with at least one model', async () => {
    const mock = await startInProcessCodexMock()
    activeMocks.add(mock)
    const bridge = createFakeWsBridge()
    activeBridges.add(bridge)
    const openChannel = makeOpenChannelViaFakeBridge(bridge)

    const adapter = createCodexBackendAdapter(
      { url: mock.url },
      { openChannel },
    )

    const catalog = await adapter.catalog!.providers()
    expect(catalog.providers).toHaveLength(1)
    expect(catalog.providers[0]!.id).toBe('codex')
    const models = catalog.providers[0]!.models
    expect(models.length).toBeGreaterThanOrEqual(1)
    expect(models.some((m) => m.id === 'gpt-5-codex')).toBe(true)
  })
})
