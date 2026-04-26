import { describe, expect, it, vi } from 'vitest'

import { BackendFacadeError } from '../errors.js'
import { createOpenCodeBackendAdapter } from '../opencode/adapter.js'
import type {
  OpenCodeGatewayContract,
  OpenCodeGatewayEventSubscription,
  OpenCodeGatewaySubscribeOptions,
} from '../../opencode/gateway.js'
import type { SessionPromptInput } from '../../opencode/types.js'
import { OpencodeWrapperError } from '../../opencode/errors.js'

function createMockGateway() {
  let lifecycleState: ReturnType<OpenCodeGatewayEventSubscription['getLifecycleState']> = {
    status: 'idle',
    retryAttempt: 0,
    nextRetryInMs: null,
    reason: null,
  }

  let subscribeOptions: OpenCodeGatewaySubscribeOptions | undefined

  const subscription: OpenCodeGatewayEventSubscription = {
    start: vi.fn(),
    stop: vi.fn(),
    reconnect: vi.fn(),
    getLifecycleState: vi.fn(() => lifecycleState),
    subscribeLifecycle: vi.fn(() => () => {}),
    attachAbortSignal: vi.fn(() => () => {}),
    getReconcileState: vi.fn(() => ({
      seenEventIds: [],
      lastSequenceByKey: {},
    })),
  }

  const gateway = {
    config: {
      baseUrl: 'https://opencode.example.com',
    },
    sessions: {
      list: vi.fn(async () => [
        {
          id: 'session-1',
          title: 'Session One',
          status: 'idle',
          updatedAt: '2026-01-01T00:00:00.000Z',
          directory: '/repo/default',
          project: {
            id: 'project-1',
            worktree: '/repo/default',
            name: 'Repo One',
          },
          projectID: 'project-1',
          workspaceID: 'default',
        },
      ]),
      create: vi.fn(async () => ({
        id: 'session-created',
        title: 'Created',
        createdAt: '2026-01-01T00:00:01.000Z',
        updatedAt: '2026-01-01T00:00:02.000Z',
        shareURL: 'https://share.example/session-created',
      })),
      get: vi.fn(async () => ({
        id: 'session-1',
        title: 'Session One',
        status: 'running',
        updatedAt: '2026-01-01T00:00:00.000Z',
        createdAt: '2025-12-31T23:59:59.000Z',
        parentID: 'parent-1',
      })),
      messages: vi.fn(async () => [
        {
          info: {
            id: 'message-1',
            sessionID: 'session-1',
            role: 'assistant',
            createdAt: '2026-01-01T00:00:00.000Z',
            completedAt: '2026-01-01T00:00:03.000Z',
            providerID: 'anthropic',
            modelID: 'claude-sonnet-4',
            agent: 'build',
            variant: 'high',
          },
          parts: [{ type: 'text', text: 'hello' }],
        },
      ]),
      prompt: vi.fn(async (_sessionID: string, _payload: SessionPromptInput) => ({
        id: 'assistant-1',
        sessionID: 'session-1',
        role: 'assistant',
        createdAt: '2026-01-01T00:00:04.000Z',
      })),
    },
    events: {
      streamURL: vi.fn(() => 'https://opencode.example.com/global/event'),
      requiredEventNames: [],
      connectionLifecycleEventNames: [],
      parse: vi.fn(),
      isKnownEventName: vi.fn(),
      subscribe: vi.fn((options?: OpenCodeGatewaySubscribeOptions) => {
        subscribeOptions = options
        return subscription
      }),
    },
    opencode: {} as OpenCodeGatewayContract['opencode'],
    scope: {} as OpenCodeGatewayContract['scope'],
    reconcile: {} as OpenCodeGatewayContract['reconcile'],
    catalog: {
      providers: vi.fn(async () => ({
        providers: [
          {
            id: 'anthropic',
            name: 'Anthropic',
            models: [
              {
                id: 'claude-sonnet-4',
                name: 'Claude Sonnet 4',
                reasoning: true,
                variants: {
                  low: {},
                  high: {},
                },
              },
            ],
          },
        ],
        defaults: {
          anthropic: 'claude-sonnet-4',
        },
      })),
      agents: vi.fn(async () => [
        {
          name: 'build',
          description: 'Build things',
          mode: 'primary',
        },
      ]),
    },
    projects: {
      list: vi.fn(async () => []),
    },
  } as unknown as OpenCodeGatewayContract

  return {
    gateway,
    subscription,
    getSubscribeOptions: () => subscribeOptions,
    setLifecycleState(nextState: typeof lifecycleState) {
      lifecycleState = nextState
    },
  }
}

describe('opencode backend adapter', () => {
  it('exposes a stable descriptor and capability set for future UI switching', () => {
    const { gateway } = createMockGateway()
    const adapter = createOpenCodeBackendAdapter(
      { baseUrl: 'https://opencode.example.com' },
      { createGateway: () => gateway },
    )

    expect(adapter.descriptor).toEqual({
      kind: 'opencode',
      label: 'OpenCode',
    })

    expect(adapter.capabilities).toEqual({
      sessions: true,
      streaming: true,
      catalog: true,
      approvals: false,
      pty: false,
      remoteDiscovery: false,
      agentPicker: true,
      modelPicker: true,
    })
  })

  it('maps sessions, messages, prompts, and catalog through the unified contract', async () => {
    const { gateway } = createMockGateway()
    const adapter = createOpenCodeBackendAdapter(
      { baseUrl: 'https://opencode.example.com' },
      { createGateway: () => gateway },
    )

    const scope = { directory: '/repo/override', workspaceID: 'default' }

    await expect(adapter.sessions.list(scope)).resolves.toEqual([
      {
        backend: 'opencode',
        id: 'session-1',
        title: 'Session One',
        status: 'idle',
        updatedAt: '2026-01-01T00:00:00.000Z',
        directory: '/repo/default',
        projectLabel: 'Repo One',
        backendMeta: {
          projectID: 'project-1',
          workspaceID: 'default',
          project: {
            id: 'project-1',
            worktree: '/repo/default',
            name: 'Repo One',
          },
        },
      },
    ])

    expect(gateway.sessions.list).toHaveBeenCalledWith({
      directory: '/repo/override',
      workspace: { id: 'default' },
    })

    await expect(adapter.sessions.get('session-1')).resolves.toMatchObject({
      backend: 'opencode',
      id: 'session-1',
      parentID: 'parent-1',
      createdAt: '2025-12-31T23:59:59.000Z',
    })

    await expect(adapter.sessions.messages('session-1')).resolves.toEqual([
      {
        id: 'message-1',
        sessionID: 'session-1',
        role: 'assistant',
        createdAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:00:03.000Z',
        parts: [{ type: 'text', text: 'hello' }],
        backendMeta: {
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4',
          agent: 'build',
          variant: 'high',
        },
      },
    ])

    await expect(adapter.sessions.prompt('session-1', {
      parts: [{ type: 'text', text: 'hello' }],
      model: {
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4',
      },
      agent: 'build',
      reasoningEffort: 'high',
      tools: {
        bash: true,
      },
    })).resolves.toEqual({
      sessionID: 'session-1',
      messageID: 'assistant-1',
      backendMeta: {
        role: 'assistant',
        createdAt: '2026-01-01T00:00:04.000Z',
      },
    })

    expect(gateway.sessions.prompt).toHaveBeenCalledWith(
      'session-1',
      {
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4',
        parts: [{ type: 'text', text: 'hello' }],
        agent: 'build',
        variant: 'high',
        tools: {
          bash: true,
        },
      },
      undefined,
    )

    await adapter.sessions.prompt('session-1', {
      parts: [{ type: 'text', text: 'scoped hello' }],
      model: {
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4',
      },
    }, scope)

    expect(gateway.sessions.prompt).toHaveBeenLastCalledWith(
      'session-1',
      {
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4',
        parts: [{ type: 'text', text: 'scoped hello' }],
      },
      {
        directory: '/repo/override',
        workspace: { id: 'default' },
      },
    )

    await expect(adapter.catalog?.providers(scope)).resolves.toEqual({
      providers: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          models: [
            {
              id: 'claude-sonnet-4',
              name: 'Claude Sonnet 4',
              reasoning: true,
              reasoningEfforts: ['low', 'high'],
              backendMeta: {
                variants: {
                  low: {},
                  high: {},
                },
              },
            },
          ],
        },
      ],
      defaults: {
        anthropic: 'claude-sonnet-4',
      },
    })

    await expect(adapter.catalog?.agents()).resolves.toEqual([
      {
        id: 'build',
        name: 'build',
        description: 'Build things',
        backendMeta: {
          mode: 'primary',
        },
      },
    ])
  })

  it('passes through gateway failures unchanged so callers can keep existing error handling', async () => {
    const { gateway } = createMockGateway()
    const adapter = createOpenCodeBackendAdapter(
      { baseUrl: 'https://opencode.example.com' },
      { createGateway: () => gateway },
    )

    const failure = new Error('gateway list failed')
    gateway.sessions.list = vi.fn(async () => {
      throw failure
    }) as never

    await expect(adapter.sessions.list()).rejects.toBe(failure)

    const catalogFailure = new Error('gateway providers failed')
    gateway.catalog.providers = vi.fn(async () => {
      throw catalogFailure
    }) as never

    await expect(adapter.catalog?.providers()).rejects.toBe(catalogFailure)
  })

  it('validates prompt input before calling OpenCode prompt', async () => {
    const { gateway } = createMockGateway()
    const adapter = createOpenCodeBackendAdapter(
      { baseUrl: 'https://opencode.example.com' },
      { createGateway: () => gateway },
    )

    await expect(
      adapter.sessions.prompt('session-1', {
        parts: [{ type: 'text', text: 'hello' }],
        model: {
          modelID: 'claude-sonnet-4',
        },
      }),
    ).rejects.toMatchObject({
      name: 'BackendFacadeError',
      code: 'invalid_backend_input',
      message: 'OpenCode backend requires model.providerID.',
    })

    await expect(
      adapter.sessions.prompt('session-1', {
        parts: [],
        model: {
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4',
        },
      }),
    ).rejects.toBeInstanceOf(BackendFacadeError)

    expect(gateway.sessions.prompt).not.toHaveBeenCalled()
  })

  it('maps event stream callbacks and resync actions into backend events', () => {
    const { gateway, subscription, getSubscribeOptions, setLifecycleState } = createMockGateway()
    const adapter = createOpenCodeBackendAdapter(
      { baseUrl: 'https://opencode.example.com' },
      { createGateway: () => gateway },
    )

    const onEvent = vi.fn()
    const onConnectionStateChange = vi.fn()
    const onError = vi.fn()

    const backendSubscription = adapter.events.subscribe({
      autoStart: false,
      scope: {
        directory: '/repo/override',
        workspaceID: 'ws-1',
      },
      onEvent,
      onConnectionStateChange,
      onError,
    })

    expect(gateway.events.subscribe).toHaveBeenCalledTimes(1)
    expect(getSubscribeOptions()).toMatchObject({
      autoStart: false,
      scope: {
        directory: '/repo/override',
        workspace: { id: 'ws-1' },
      },
    })

    const forwardedOptions = getSubscribeOptions()!

    forwardedOptions.onLifecycleStateChange?.({
      status: 'reconnecting',
      retryAttempt: 2,
      nextRetryInMs: 400,
      reason: 'network',
    })

    expect(onConnectionStateChange).toHaveBeenCalledWith({
      status: 'reconnecting',
      retryAttempt: 2,
      nextRetryInMs: 400,
      reason: 'network',
    })

    forwardedOptions.onEvent?.({
      type: 'message.part.delta',
      properties: {
        sessionID: 'session-1',
        messageID: 'message-1',
        partID: 'part-1',
        delta: 'hello',
      },
    } as never, {
      action: {
        type: 'accepted',
        eventName: 'message.part.delta',
        refetchRequired: false,
      },
      state: {
        seenEventIds: [],
        lastSequenceByKey: {},
      },
      raw: 'raw-1',
    })

    expect(onEvent).toHaveBeenCalledWith({
      backend: 'opencode',
      type: 'message.delta',
      raw: {
        type: 'message.part.delta',
        properties: {
          sessionID: 'session-1',
          messageID: 'message-1',
          partID: 'part-1',
          delta: 'hello',
        },
      },
      sourceType: 'message.part.delta',
      payload: {
        sessionID: 'session-1',
        messageID: 'message-1',
        partID: 'part-1',
        delta: 'hello',
      },
      sessionID: 'session-1',
      messageID: 'message-1',
      partID: 'part-1',
    })

    forwardedOptions.onEvent?.({
      type: 'session.status',
      properties: {
        sessionID: 'session-1',
        status: 'running',
      },
    } as never, {
      action: {
        type: 'accepted',
        eventName: 'session.status',
        refetchRequired: false,
      },
      state: {
        seenEventIds: [],
        lastSequenceByKey: {},
      },
      raw: 'raw-session',
    })

    expect(onEvent).toHaveBeenCalledWith({
      backend: 'opencode',
      type: 'session.updated',
      raw: {
        type: 'session.status',
        properties: {
          sessionID: 'session-1',
          status: 'running',
        },
      },
      sourceType: 'session.status',
      payload: {
        sessionID: 'session-1',
        status: 'running',
      },
      sessionID: 'session-1',
      status: 'running',
    })

    forwardedOptions.onEvent?.({
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        messageID: 'message-2',
      },
    } as never, {
      action: {
        type: 'accepted',
        eventName: 'message.updated',
        refetchRequired: false,
      },
      state: {
        seenEventIds: [],
        lastSequenceByKey: {},
      },
      raw: 'raw-message-updated',
    })

    expect(onEvent).toHaveBeenCalledWith({
      backend: 'opencode',
      type: 'message.updated',
      raw: {
        type: 'message.updated',
        properties: {
          sessionID: 'session-1',
          messageID: 'message-2',
        },
      },
      sourceType: 'message.updated',
      payload: {
        sessionID: 'session-1',
        messageID: 'message-2',
      },
      sessionID: 'session-1',
      messageID: 'message-2',
    })

    forwardedOptions.onEvent?.({
      type: 'unknown',
      eventType: 'session.idle',
      properties: {
        sessionID: 'session-1',
      },
    } as never, {
      action: {
        type: 'accepted',
        eventName: 'session.idle',
        refetchRequired: false,
      },
      state: {
        seenEventIds: [],
        lastSequenceByKey: {},
      },
      raw: 'raw-2',
    })

    expect(onEvent).toHaveBeenCalledWith({
      backend: 'opencode',
      type: 'raw',
      raw: {
        type: 'unknown',
        eventType: 'session.idle',
        properties: {
          sessionID: 'session-1',
        },
      },
      sourceType: 'session.idle',
      payload: {
        sessionID: 'session-1',
      },
      sessionID: 'session-1',
    })

    forwardedOptions.onEvent?.({
      type: 'unknown',
      eventType: 'session.error',
      properties: {
        info: {
          sessionID: 'session-2',
        },
        error: {
          data: {
            message: 'agent failed',
          },
        },
      },
    } as never, {
      action: {
        type: 'accepted',
        eventName: 'session.error',
        refetchRequired: false,
      },
      state: {
        seenEventIds: [],
        lastSequenceByKey: {},
      },
      raw: 'raw-error',
    })

    expect(onEvent).toHaveBeenCalledWith({
      backend: 'opencode',
      type: 'raw',
      raw: {
        type: 'unknown',
        eventType: 'session.error',
        properties: {
          info: {
            sessionID: 'session-2',
          },
          error: {
            data: {
              message: 'agent failed',
            },
          },
        },
      },
      sourceType: 'session.error',
      payload: {
        info: {
          sessionID: 'session-2',
        },
        error: {
          data: {
            message: 'agent failed',
          },
        },
      },
      sessionID: 'session-2',
    })

    forwardedOptions.onEvent?.({
      type: 'unknown',
      eventType: 'provider.changed',
      properties: 'bad-payload',
    } as never, {
      action: {
        type: 'accepted',
        eventName: 'provider.changed',
        refetchRequired: false,
      },
      state: {
        seenEventIds: [],
        lastSequenceByKey: {},
      },
      raw: 'raw-unknown-bad',
    })

    expect(onEvent).toHaveBeenCalledWith({
      backend: 'opencode',
      type: 'raw',
      raw: {
        type: 'unknown',
        eventType: 'provider.changed',
        properties: 'bad-payload',
      },
      sourceType: 'provider.changed',
      payload: {
        value: 'bad-payload',
      },
    })

    forwardedOptions.onEvent?.({
      type: 'server.connected',
      properties: {
        serverID: 'server-1',
      },
    } as never, {
      action: {
        type: 'accepted',
        eventName: 'server.connected',
        refetchRequired: false,
      },
      state: {
        seenEventIds: [],
        lastSequenceByKey: {},
      },
      raw: 'raw-connected',
    })

    expect(onEvent).toHaveBeenCalledWith({
      backend: 'opencode',
      type: 'connection.state',
      raw: {
        type: 'server.connected',
        properties: {
          serverID: 'server-1',
        },
      },
      sourceType: 'server.connected',
      payload: {
        serverID: 'server-1',
      },
      status: 'open',
    })

    forwardedOptions.onEvent?.({
      type: 'global.disposed',
      properties: {
        reason: 'shutdown',
      },
    } as never, {
      action: {
        type: 'accepted',
        eventName: 'global.disposed',
        refetchRequired: false,
      },
      state: {
        seenEventIds: [],
        lastSequenceByKey: {},
      },
      raw: 'raw-disposed',
    })

    expect(onEvent).toHaveBeenCalledWith({
      backend: 'opencode',
      type: 'connection.state',
      raw: {
        type: 'global.disposed',
        properties: {
          reason: 'shutdown',
        },
      },
      sourceType: 'global.disposed',
      payload: {
        reason: 'shutdown',
      },
      status: 'stopped',
    })

    forwardedOptions.onReconcileAction?.({
      type: 'refetchRequired',
      eventName: 'message.part.updated',
      reason: 'gap',
      orderKey: 'message:session-1:message-1',
      expectedSequence: 4,
      receivedSequence: 6,
      refetchRequired: true,
    }, {
      seenEventIds: [],
      lastSequenceByKey: {},
    }, {
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        messageID: 'message-1',
        partID: 'part-1',
      },
    } as never)

    expect(onEvent).toHaveBeenCalledWith({
      backend: 'opencode',
      type: 'resync.required',
      raw: {
        event: {
          type: 'message.part.updated',
          properties: {
            sessionID: 'session-1',
            messageID: 'message-1',
            partID: 'part-1',
          },
        },
        action: {
          type: 'refetchRequired',
          eventName: 'message.part.updated',
          reason: 'gap',
          orderKey: 'message:session-1:message-1',
          expectedSequence: 4,
          receivedSequence: 6,
          refetchRequired: true,
        },
      },
      sourceType: 'message.part.updated',
      payload: {
        eventName: 'message.part.updated',
        reason: 'gap',
        orderKey: 'message:session-1:message-1',
        expectedSequence: 4,
        receivedSequence: 6,
      },
      sessionID: 'session-1',
      messageID: 'message-1',
      partID: 'part-1',
    })

    const upstreamError = new OpencodeWrapperError('stream failed', {
      code: 'unknown',
    })
    forwardedOptions.onError?.(upstreamError)
    expect(onError).toHaveBeenCalledWith(upstreamError)

    setLifecycleState({
      status: 'open',
      retryAttempt: 0,
      nextRetryInMs: null,
      reason: null,
    })

    expect(backendSubscription.getState()).toEqual({
      status: 'open',
      retryAttempt: 0,
      nextRetryInMs: null,
      reason: null,
    })

    const abort = new AbortController()
    const detach = backendSubscription.attachAbortSignal(abort.signal)
    expect(subscription.attachAbortSignal).toHaveBeenCalledWith(abort.signal)
    expect(typeof detach).toBe('function')

    backendSubscription.start()
    backendSubscription.reconnect('retry')
    backendSubscription.stop('stop')

    expect(subscription.start).toHaveBeenCalledTimes(1)
    expect(subscription.reconnect).toHaveBeenCalledWith('retry')
    expect(subscription.stop).toHaveBeenCalledWith('stop')
  })
})
