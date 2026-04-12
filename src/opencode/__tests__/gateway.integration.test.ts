import { describe, expect, it, vi } from 'vitest'

import { OpencodeWrapperError } from '../errors.js'
import { createOpencodeGateway } from '../gateway.js'

class MockEventSource {
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null

  closed = false

  constructor(readonly url: string) {}

  close(): void {
    this.closed = true
  }

  emitOpen(): void {
    this.onopen?.({} as Event)
  }

  emitError(value: unknown): void {
    this.onerror?.(value as Event)
  }

  emitMessage(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent)
  }
}

function createGatewayFixture() {
  const sessionListMock = vi.fn()
  const sessionCreateMock = vi.fn()
  const sessionGetMock = vi.fn()
  const sessionMessagesMock = vi.fn()
  const sessionPromptMock = vi.fn()

  const createClientMock = vi.fn(() => ({
    experimental: {
      session: {
        list: sessionListMock,
      },
    },
    session: {
      create: sessionCreateMock,
      get: sessionGetMock,
      messages: sessionMessagesMock,
      prompt: sessionPromptMock,
    },
  }))

  const sources: MockEventSource[] = []
  const createEventSource = vi.fn((url: string) => {
    const source = new MockEventSource(url)
    sources.push(source)
    return source
  })

  const gateway = createOpencodeGateway({
    baseUrl: 'https://opencode.example.com/',
    auth: 'token-abc',
    directory: '/repo/default',
    workspace: { id: 'default' },
    headers: {
      'x-opencode-client': 'lynx-mobile',
    },
  }, {
    createClient: createClientMock,
    createEventSource,
  })

  return {
    gateway,
    createClientMock,
    createEventSource,
    sources,
    mocks: {
      sessionListMock,
      sessionCreateMock,
      sessionGetMock,
      sessionMessagesMock,
      sessionPromptMock,
    },
  }
}

describe('gateway integration contract', () => {
  it('integrates sessions/events/reconcile/scope under one stable v1 boundary', async () => {
    const fixture = createGatewayFixture()
    const { gateway, createClientMock, createEventSource, sources, mocks } = fixture

    mocks.sessionListMock.mockResolvedValue({
      data: [{ id: 'session-1', title: 'One', status: 'idle', time: { updated: 1_700_000_000_001 } }],
    })

    mocks.sessionCreateMock.mockResolvedValue({
      data: {
        id: 'session-created',
        title: 'Created',
        time: { created: 1_700_000_000_010, updated: 1_700_000_000_011 },
      },
    })

    mocks.sessionGetMock.mockImplementation(async ({ sessionID }: { sessionID: string }) => ({
      data: {
        id: sessionID,
        title: `Title ${sessionID}`,
        time: { created: 1_700_000_000_100, updated: 1_700_000_000_101 },
      },
    }))

    mocks.sessionMessagesMock.mockImplementation(async ({ sessionID }: { sessionID: string }) => ({
      data: [
        {
          info: {
            id: `msg-${sessionID}`,
            sessionID,
            role: 'assistant',
            time: { created: 1_700_000_000_111 },
          },
          parts: [{ type: 'text', text: `hello ${sessionID}` }],
        },
      ],
    }))

    mocks.sessionPromptMock.mockImplementation(async ({ sessionID }: { sessionID: string }) => ({
      data: {
        info: {
          id: `assistant-${sessionID}`,
          sessionID,
          role: 'assistant',
          time: { created: 1_700_000_000_121 },
        },
      },
    }))

    const [sessionA, sessionB] = await Promise.all([
      gateway.sessions.get('session-a'),
      gateway.sessions.get('session-b'),
    ])

    const [messagesA, messagesB] = await Promise.all([
      gateway.sessions.messages('session-a'),
      gateway.sessions.messages('session-b'),
    ])

    const [promptA, promptB] = await Promise.all([
      gateway.sessions.prompt('session-a', {
        providerID: 'provider-1',
        modelID: 'model-1',
        parts: [{ type: 'text', text: 'hello session-a' }],
      }),
      gateway.sessions.prompt('session-b', {
        providerID: 'provider-1',
        modelID: 'model-1',
        parts: [{ type: 'text', text: 'hello session-b' }],
      }),
    ])

    const listed = await gateway.sessions.list()
    const created = await gateway.sessions.create()

    expect(sessionA.id).toBe('session-a')
    expect(sessionB.id).toBe('session-b')
    expect(messagesA[0]?.info.sessionID).toBe('session-a')
    expect(messagesB[0]?.info.sessionID).toBe('session-b')
    expect(promptA.sessionID).toBe('session-a')
    expect(promptB.sessionID).toBe('session-b')
    expect(listed[0]?.id).toBe('session-1')
    expect(created.id).toBe('session-created')

    expect(createClientMock).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'https://opencode.example.com',
      auth: 'token-abc',
      directory: '/repo/default',
      headers: {
        'x-opencode-client': 'lynx-mobile',
      },
    }))
    expect(createClientMock.mock.calls[0]?.[0]).toHaveProperty('fetch')

    const resolvedScope = gateway.scope.resolve({
      directory: '/repo/override',
      workspace: { id: 'default' },
    })

    expect(resolvedScope).toEqual({
      workspace: { id: 'default' },
      directory: '/repo/override',
    })

    expect(gateway.events.requiredEventNames).toContain('session.status')
    expect(gateway.events.connectionLifecycleEventNames).toContain('server.connected')
    expect(gateway.events.streamURL()).toBe('https://opencode.example.com/global/event?directory=%2Frepo%2Fdefault')
    expect(typeof gateway.opencode.network.request).toBe('function')
    expect(typeof gateway.opencode.network.sse.open).toBe('function')
    expect(typeof gateway.opencode.network.sse.close).toBe('function')

    const lifecycleStatuses: string[] = []
    const parsedEvents: string[] = []
    const reconcileActionTypes: string[] = []

    const subscription = gateway.events.subscribe({
      scope: { directory: '/repo/override', workspace: { id: 'default' } },
      autoStart: false,
      onLifecycleStateChange: state => {
        lifecycleStatuses.push(state.status)
      },
      onEvent: event => {
        parsedEvents.push(event.type)
      },
      onReconcileAction: action => {
        reconcileActionTypes.push(action.type)
      },
    })

    expect(createEventSource).not.toHaveBeenCalled()
    subscription.start()

    expect(createEventSource).toHaveBeenCalledWith(
      'https://opencode.example.com/global/event?directory=%2Frepo%2Foverride',
    )

    const source = sources[0]
    expect(source).toBeDefined()

    source?.emitOpen()
    source?.emitMessage(JSON.stringify({
      type: 'message.part.updated',
      properties: {
        eventID: 'evt-1',
        sessionID: 'session-a',
        messageID: 'message-1',
        partIndex: 0,
      },
    }))
    source?.emitMessage(JSON.stringify({
      type: 'message.part.updated',
      properties: {
        eventID: 'evt-2',
        sessionID: 'session-a',
        messageID: 'message-1',
        partIndex: 2,
      },
    }))

    expect(parsedEvents).toEqual(['message.part.updated', 'message.part.updated'])
    expect(reconcileActionTypes).toEqual(['accepted', 'refetchRequired'])
    expect(subscription.getReconcileState()).toEqual({
      seenEventIds: [
        'event:message.part.updated:evt-1',
        'event:message.part.updated:evt-2',
      ],
      lastSequenceByKey: {
        'message:session-a:message-1': 0,
      },
    })

    subscription.stop('done')

    expect(source?.closed).toBe(true)
    expect(lifecycleStatuses).toContain('idle')
    expect(lifecycleStatuses).toContain('connecting')
    expect(lifecycleStatuses).toContain('open')
    expect(lifecycleStatuses).toContain('stopped')
    expect((gateway as unknown as { client?: unknown }).client).toBeUndefined()
  })

  it('propagates normalized failure semantics for rest and stream paths', async () => {
    const fixture = createGatewayFixture()
    const { gateway, sources, mocks } = fixture

    const sdkFailure = Object.assign(new Error('session lookup failed'), { status: 503 })
    mocks.sessionGetMock.mockRejectedValue(sdkFailure)

    await expect(gateway.sessions.get('session-error')).rejects.toBeInstanceOf(OpencodeWrapperError)

    await expect(gateway.sessions.get('session-error')).rejects.toMatchObject({
      name: 'OpencodeWrapperError',
      code: 'sdk_request_failed',
      status: 503,
      retryable: true,
      message: 'OpenCode SDK request failed: session lookup failed',
      cause: sdkFailure,
    })

    const parseFailures: OpencodeWrapperError[] = []
    const parseFailurePayloads: unknown[] = []

    const parseSubscription = gateway.events.subscribe({
      autoStart: true,
      onError: error => {
        parseFailures.push(error)
      },
      onParseError: (error, payload) => {
        parseFailurePayloads.push(payload)
        parseFailures.push(error)
      },
    })

    const parseSource = sources[0]
    expect(parseSource).toBeDefined()

    parseSource?.emitOpen()
    parseSource?.emitMessage('{"type":')

    expect(parseFailurePayloads).toEqual(['{"type":'])
    expect(parseFailures[0]).toBeInstanceOf(OpencodeWrapperError)
    expect(parseFailures[0]).toMatchObject({
      code: 'unknown',
      retryable: false,
      message: 'Failed to parse OpenCode SSE event payload.',
    })

    parseSubscription.stop('parse-failure-test')

    const handlerFailures: OpencodeWrapperError[] = []

    const handlerSubscription = gateway.events.subscribe({
      autoStart: true,
      onError: error => {
        handlerFailures.push(error)
      },
      onEvent: () => {
        throw new Error('event callback crashed')
      },
    })

    const handlerSource = sources[1]
    expect(handlerSource).toBeDefined()

    handlerSource?.emitOpen()
    handlerSource?.emitMessage(JSON.stringify({
      type: 'message.updated',
      properties: {
        eventID: 'evt-handler',
        sessionID: 'session-a',
        messageID: 'message-1',
      },
    }))

    expect(handlerFailures[0]).toBeInstanceOf(OpencodeWrapperError)
    expect(handlerFailures[0]).toMatchObject({
      code: 'unknown',
      retryable: false,
      message: 'event callback crashed',
    })

    handlerSubscription.stop('handler-failure-test')
  })

  it('surfaces sdk error envelopes so dead-server session probes fail fast', async () => {
    const fixture = createGatewayFixture()
    const { gateway, mocks } = fixture

    mocks.sessionListMock.mockResolvedValue({
      error: {
        message: 'connect ECONNREFUSED 127.0.0.1:3000',
      },
      response: {
        status: 502,
        statusText: 'Bad Gateway',
      },
    })

    await expect(gateway.sessions.list()).rejects.toMatchObject({
      name: 'OpencodeWrapperError',
      code: 'sdk_request_failed',
      status: 502,
      retryable: true,
      message: 'OpenCode SDK request failed: connect ECONNREFUSED 127.0.0.1:3000',
    })
  })
})
