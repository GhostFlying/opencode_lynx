import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, waitFor } from '@lynx-js/react/testing-library'

import type {
  BackendClient,
  BackendConnectionSnapshot,
  BackendEvent,
  BackendSubscribeOptions,
  BackendSubscription,
} from '../../../backends/index.js'
import {
  errorMessageFromBackendEvent,
  shouldRefreshMessagesForBackendEvent,
  shouldStopThinkingForBackendEvent,
} from '../backend-events.js'
import {
  FIXTURE_AGENTS,
  FIXTURE_PROVIDER_DEFAULTS,
  FIXTURE_PROVIDERS,
  getFixtureMessages,
} from '../fixtures.js'
import {
  parseChatRouteParams,
  seedNewSessionDefaults,
} from '../new-session-model.js'

const {
  storageGetMock,
  storageSetMock,
  createBackendClientMock,
  createCodexBackendClientMock,
} = vi.hoisted(() => ({
  storageGetMock: vi.fn(),
  storageSetMock: vi.fn(),
  createBackendClientMock: vi.fn(),
  createCodexBackendClientMock: vi.fn(),
}))

vi.mock('../ChatInput.js', () => ({
  ChatInput: ({
    onSend,
    disabled,
    agentPickerEnabled,
    selection,
  }: {
    onSend: (text: string) => void
    disabled?: boolean
    agentPickerEnabled?: boolean
    selection?: { agentLabel: string; modelLabel: string; effortLabel: string }
  }) => {
    // Encode props into class name segments so the test runtime (Lynx-react
    // testing-library) does not reject custom data-* attribute names. The
    // assertions below match against `.composer-stub` and class tokens.
    const classNames = [
      'composer-stub',
      disabled ? 'composer-stub--disabled' : 'composer-stub--enabled',
      agentPickerEnabled === false
        ? 'composer-stub--no-agent-picker'
        : 'composer-stub--agent-picker',
      `composer-stub--model-${selection?.modelLabel ?? 'none'}`,
    ]
    return (
      <view
        className={classNames.join(' ')}
        // Honour the disabled prop so a tap on a disabled composer never
        // fires onSend — matches the real ChatInput which omits the bindtap
        // wiring on its send button when disabled.
        bindtap={() => {
          if (disabled) return
          onSend('hello world')
        }}
      />
    )
  },
}))
vi.mock('../../../navigation.js', () => ({ close: vi.fn() }))
vi.mock('../../../storage.js', () => ({
  storageGet: storageGetMock,
  storageSet: storageSetMock,
  storageRemove: vi.fn(),
}))
vi.mock('../../../backends/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../../backends/index.js')>(
    '../../../backends/index.js',
  )
  return {
    ...actual,
    createOpencodeBackendClientFromConnection: createBackendClientMock,
    createCodexBackendClientFromConnection: createCodexBackendClientMock,
  }
})

describe('chat backend facade helpers', () => {
  it('uses backend-neutral fixture data for dev mode messages and catalogs', () => {
    const messages = getFixtureMessages('session-fixture')

    expect(messages[0]).toMatchObject({
      id: 'msg_fix_u1',
      sessionID: 'session-fixture',
      role: 'user',
    })
    expect(messages.some(message => message.role === 'assistant' && message.backendMeta)).toBe(true)
    expect(FIXTURE_PROVIDERS[0]?.models[0]).toMatchObject({
      id: 'claude-sonnet-4-20250514',
      reasoningEfforts: ['low', 'medium', 'high', 'max'],
    })
    expect(FIXTURE_PROVIDER_DEFAULTS.anthropic).toBe('claude-sonnet-4-20250514')
    expect(FIXTURE_AGENTS[0]).toMatchObject({
      id: 'build',
      name: 'build',
    })
  })

  it('classifies unified backend events for chat refresh and thinking state', () => {
    const messageUpdated: BackendEvent = {
      backend: 'opencode',
      type: 'message.updated',
      sessionID: 'session-1',
      payload: {},
      raw: {},
    }
    const resyncRequired: BackendEvent = {
      backend: 'opencode',
      type: 'resync.required',
      sessionID: 'session-1',
      payload: {},
      raw: {},
    }
    const sessionIdle: BackendEvent = {
      backend: 'opencode',
      type: 'raw',
      sourceType: 'session.idle',
      sessionID: 'session-1',
      payload: {},
      raw: {},
    }
    const stopped: BackendEvent = {
      backend: 'opencode',
      type: 'connection.state',
      status: 'stopped',
      payload: {},
      raw: {},
    }
    const delta: BackendEvent = {
      backend: 'opencode',
      type: 'message.delta',
      sessionID: 'session-1',
      payload: {},
      raw: {},
    }

    expect(shouldRefreshMessagesForBackendEvent(messageUpdated)).toBe(true)
    expect(shouldRefreshMessagesForBackendEvent(resyncRequired)).toBe(true)
    expect(shouldRefreshMessagesForBackendEvent(sessionIdle)).toBe(false)
    expect(shouldStopThinkingForBackendEvent(sessionIdle)).toBe(true)
    expect(shouldStopThinkingForBackendEvent(stopped)).toBe(true)
    expect(shouldStopThinkingForBackendEvent(delta)).toBe(false)
  })

  it('parses route params from globalProps.routeParams (back-compat opencode default)', () => {
    expect(parseChatRouteParams({
      routeParams: {
        sessionId: 's1',
        sessionTitle: 'Hello',
        // No `kind` field — back-compat path defaults to opencode shape so
        // any in-flight new-session route blob serialised before M3.1 still
        // resolves correctly.
        connection: { ip: '1.2.3.4', port: '4567', password: 'pw' },
        isNewSession: false,
        knownDirectories: ['/repo/a', 12, '/repo/b'],
      },
    })).toEqual({
      sessionId: 's1',
      sessionTitle: 'Hello',
      connection: { kind: 'opencode', ip: '1.2.3.4', port: '4567', password: 'pw' },
      isNewSession: false,
      knownDirectories: ['/repo/a', '/repo/b'],
    })
  })

  it('parses route params from queryItems.route_params fallback', () => {
    expect(parseChatRouteParams({
      queryItems: {
        route_params: JSON.stringify({
          isNewSession: true,
          connection: { ip: '10.0.0.1', port: '3000' },
        }),
      },
    })).toEqual({
      isNewSession: true,
      connection: { kind: 'opencode', ip: '10.0.0.1', port: '3000', password: '' },
    })
  })

  it('parses an explicit codex connection blob', () => {
    expect(parseChatRouteParams({
      routeParams: {
        sessionId: 's2',
        connection: {
          kind: 'codex',
          host: 'example.com',
          port: '7777',
          token: 'tok',
          secure: true,
        },
        isNewSession: false,
      },
    })).toEqual({
      sessionId: 's2',
      connection: {
        kind: 'codex',
        host: 'example.com',
        port: '7777',
        token: 'tok',
        secure: true,
      },
      isNewSession: false,
    })
  })

  it('parses an explicit opencode connection blob', () => {
    expect(parseChatRouteParams({
      routeParams: {
        connection: {
          kind: 'opencode',
          ip: '1.2.3.4',
          port: '4567',
          password: 'pw',
        },
      },
    })).toEqual({
      connection: { kind: 'opencode', ip: '1.2.3.4', port: '4567', password: 'pw' },
    })
  })

  it('returns empty object on malformed route params', () => {
    expect(parseChatRouteParams(null)).toEqual({})
    expect(parseChatRouteParams({ queryItems: { route_params: '{not json' } })).toEqual({})
    expect(parseChatRouteParams({})).toEqual({})
  })

  it('seeds new-session defaults from server catalogs', () => {
    expect(seedNewSessionDefaults(
      [
        {
          id: 'anthropic',
          name: 'Anthropic',
          models: [{ id: 'claude-sonnet-4', name: 'Sonnet', reasoning: false, reasoningEfforts: [] }],
        },
      ],
      { anthropic: 'claude-sonnet-4' },
      [{ id: 'build', name: 'build' }],
    )).toEqual({
      agent: 'build',
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4',
      variant: null,
    })
  })

  it('seedNewSessionDefaults prefers the build agent over alphabetical first', () => {
    expect(seedNewSessionDefaults(
      [
        {
          id: 'p1',
          name: 'P1',
          models: [{ id: 'm1', name: 'M1', reasoning: false, reasoningEfforts: [] }],
        },
      ],
      { p1: 'm1' },
      [{ id: 'plan', name: 'plan' }, { id: 'build', name: 'build' }],
    )?.agent).toBe('build')
  })

  it('seedNewSessionDefaults returns null when catalogs are empty', () => {
    expect(seedNewSessionDefaults([], {}, [])).toBeNull()
    expect(seedNewSessionDefaults(
      [{ id: 'p1', name: 'P1', models: [] }],
      {},
      [{ id: 'a', name: 'a' }],
    )).toBeNull()
  })

  it('extracts session.error messages from raw backend payloads', () => {
    expect(errorMessageFromBackendEvent({
      backend: 'opencode',
      type: 'raw',
      sourceType: 'session.error',
      sessionID: 'session-1',
      payload: {
        error: {
          data: {
            message: 'The agent failed.',
          },
        },
      },
      raw: {},
    })).toBe('The agent failed.')

    expect(errorMessageFromBackendEvent({
      backend: 'opencode',
      type: 'raw',
      sourceType: 'session.error',
      sessionID: 'session-1',
      payload: {},
      raw: {},
    })).toBe('Agent reported an error.')
  })
})

interface ChatAppHarness {
  client: BackendClient
  subscription: BackendSubscription
  getSubscribeOptionsList: () => BackendSubscribeOptions[]
}

function createSubscription(): BackendSubscription {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    reconnect: vi.fn(),
    getState: vi.fn(
      (): BackendConnectionSnapshot => ({
        status: 'idle',
        retryAttempt: 0,
        nextRetryInMs: null,
        reason: null,
      }),
    ),
    attachAbortSignal: vi.fn(() => () => {}),
  }
}

function createFakeChatClient(overrides: Partial<{
  create: ReturnType<typeof vi.fn>
  prompt: ReturnType<typeof vi.fn>
  messages: ReturnType<typeof vi.fn>
}> = {}): ChatAppHarness {
  const subscription = createSubscription()
  const subscribeOptionsList: BackendSubscribeOptions[] = []

  const client: BackendClient = {
    descriptor: { kind: 'opencode', label: 'OpenCode' },
    capabilities: {
      sessions: true,
      streaming: true,
      catalog: true,
      approvals: false,
      pty: false,
      remoteDiscovery: false,
      agentPicker: true,
      modelPicker: true,
    },
    sessions: {
      list: vi.fn(),
      create:
        overrides.create
          ?? vi.fn(async () => ({
            backend: 'opencode' as const,
            id: 'session-new',
            backendMeta: {},
          })),
      get: vi.fn(),
      messages: overrides.messages ?? vi.fn(async () => []),
      prompt: overrides.prompt ?? vi.fn(async () => ({ status: 'sent' })),
    } as unknown as BackendClient['sessions'],
    events: {
      subscribe: vi.fn((options?: BackendSubscribeOptions) => {
        if (options) subscribeOptionsList.push(options)
        options?.onConnectionStateChange?.({
          status: 'open',
          retryAttempt: 0,
          nextRetryInMs: null,
          reason: null,
        })
        return subscription
      }),
    },
    catalog: {
      providers: vi.fn(async () => ({
        providers: [...FIXTURE_PROVIDERS],
        defaults: { ...FIXTURE_PROVIDER_DEFAULTS },
      })),
      agents: vi.fn(async () => [...FIXTURE_AGENTS]),
    } as unknown as NonNullable<BackendClient['catalog']>,
  }

  return {
    client,
    subscription,
    getSubscribeOptionsList: () => subscribeOptionsList,
  }
}

function setRouteParams(params: Record<string, unknown>): void {
  const lynxGlobal = (globalThis as { lynx?: { __globalProps?: Record<string, unknown> } }).lynx
  if (!lynxGlobal) {
    throw new Error('lynx global is not initialized in this test environment')
  }
  lynxGlobal.__globalProps = { ...(lynxGlobal.__globalProps ?? {}), routeParams: params }
}

function clearRouteParams(): void {
  const lynxGlobal = (globalThis as { lynx?: { __globalProps?: Record<string, unknown> } }).lynx
  if (!lynxGlobal?.__globalProps) return
  delete lynxGlobal.__globalProps.routeParams
  delete lynxGlobal.__globalProps.queryItems
}

describe('Chat App new-session flow', () => {
  beforeEach(() => {
    storageGetMock.mockResolvedValue(null)
    storageSetMock.mockReturnValue(undefined)
    createBackendClientMock.mockReset()
    createCodexBackendClientMock.mockReset()
  })

  afterEach(() => {
    clearRouteParams()
  })

  it('renders the new-session card when sessionId is missing and connection is present', async () => {
    setRouteParams({
      isNewSession: true,
      knownDirectories: ['/repo/known-one'],
      connection: { ip: '10.0.0.1', port: '4567', password: 'pw' },
    })
    const harness = createFakeChatClient()
    createBackendClientMock.mockReturnValue(harness.client)

    const { App: ChatApp } = await import('../App.js')
    const result = render(<ChatApp />)

    expect(await result.findByText('New session')).toBeInTheDocument()
    expect(await result.findByText('/repo/known-one')).toBeInTheDocument()
    expect(result.queryByText('No session ID provided.')).toBeNull()
    expect(result.queryByText('Loading messages...')).toBeNull()

    result.unmount()
  })

  it('fills the directory input when a known-directory chip is tapped', async () => {
    setRouteParams({
      isNewSession: true,
      knownDirectories: ['/repo/alpha', '/repo/beta'],
      connection: { ip: '10.0.0.1', port: '4567', password: 'pw' },
    })
    const harness = createFakeChatClient()
    createBackendClientMock.mockReturnValue(harness.client)

    const { App: ChatApp } = await import('../App.js')
    const result = render(<ChatApp />)

    const chip = await result.findByText('/repo/alpha')
    fireEvent.tap(chip.parentElement!)

    await waitFor(() => {
      const wrap = result.container.querySelector('.new-session-card__chip--active')
      expect(wrap?.textContent).toContain('/repo/alpha')
    })

    result.unmount()
  })

  it('creates session and prompts on first send, then dismisses the card', async () => {
    setRouteParams({
      isNewSession: true,
      knownDirectories: ['/repo/alpha'],
      connection: { ip: '10.0.0.1', port: '4567', password: 'pw' },
    })
    const createMock = vi.fn(async () => ({
      backend: 'opencode' as const,
      id: 'session-created-1',
      backendMeta: {},
    }))
    const promptMock = vi.fn(async () => ({ status: 'sent' }))
    const harness = createFakeChatClient({ create: createMock, prompt: promptMock })
    createBackendClientMock.mockReturnValue(harness.client)

    const { App: ChatApp } = await import('../App.js')
    const result = render(<ChatApp />)

    const chip = await result.findByText('/repo/alpha')
    fireEvent.tap(chip.parentElement!)

    // Wait for catalog defaults to seed selection so the prompt payload
    // contains a real model id.
    await waitFor(() => {
      expect(harness.client.catalog!.agents).toHaveBeenCalled()
    })

    const composer = result.container.querySelector('.composer-stub')
    expect(composer).not.toBeNull()
    fireEvent.tap(composer!)

    await waitFor(() => {
      expect(createMock).toHaveBeenCalledTimes(1)
    })
    expect(createMock).toHaveBeenCalledWith({ directory: '/repo/alpha' })

    await waitFor(() => {
      expect(promptMock).toHaveBeenCalledTimes(1)
    })
    expect(promptMock).toHaveBeenCalledWith(
      'session-created-1',
      expect.objectContaining({
        agent: expect.any(String),
        parts: [{ type: 'text', text: 'hello world' }],
        model: expect.objectContaining({
          providerID: expect.any(String),
          modelID: expect.any(String),
        }),
      }),
    )

    await waitFor(() => {
      expect(result.container.querySelector('.new-session-card')).toBeNull()
    })

    result.unmount()
  })

  it('keeps the card and surfaces the error when sessions.create rejects', async () => {
    setRouteParams({
      isNewSession: true,
      connection: { ip: '10.0.0.1', port: '4567', password: 'pw' },
    })
    const createMock = vi.fn(async () => {
      throw new Error('Server out of capacity')
    })
    const promptMock = vi.fn(async () => ({ status: 'sent' }))
    const harness = createFakeChatClient({ create: createMock, prompt: promptMock })
    createBackendClientMock.mockReturnValue(harness.client)

    const { App: ChatApp } = await import('../App.js')
    const result = render(<ChatApp />)

    await waitFor(() => {
      expect(harness.client.catalog!.agents).toHaveBeenCalled()
    })

    const composer = result.container.querySelector('.composer-stub')
    expect(composer).not.toBeNull()
    fireEvent.tap(composer!)

    await waitFor(() => {
      expect(result.queryByText('Server out of capacity')).not.toBeNull()
    })
    expect(promptMock).not.toHaveBeenCalled()

    result.unmount()
  })

  // FIX-5: persisted chat selection JSON must be validated before use. A
  // malformed blob, missing fields, or wrong types must fall back to defaults
  // without throwing or producing a half-typed selection in state.
  it('falls back to defaults when stored selection is malformed JSON', async () => {
    setRouteParams({
      sessionId: 'session-fix5-bad-json',
      connection: { ip: '10.0.0.1', port: '4567', password: 'pw' },
    })
    storageGetMock.mockResolvedValueOnce('{not valid json')
    const harness = createFakeChatClient()
    createBackendClientMock.mockReturnValue(harness.client)

    const { App: ChatApp } = await import('../App.js')
    const result = render(<ChatApp />)

    await waitFor(() => {
      expect(harness.client.sessions.messages).toHaveBeenCalledWith('session-fix5-bad-json')
    })
    // App must render normally — no throw, no error state from JSON parse.
    expect(result.container.querySelector('.chat-page')).not.toBeNull()
    result.unmount()
  })

  it('falls back to defaults when stored selection has wrong field types', async () => {
    setRouteParams({
      sessionId: 'session-fix5-wrong-types',
      connection: { ip: '10.0.0.1', port: '4567', password: 'pw' },
    })
    // agent should be string; providerID number is invalid; variant must be string|null.
    storageGetMock.mockResolvedValueOnce(JSON.stringify({
      agent: 123,
      providerID: { not: 'a string' },
      modelID: false,
      variant: 42,
    }))
    const harness = createFakeChatClient()
    createBackendClientMock.mockReturnValue(harness.client)

    const { App: ChatApp } = await import('../App.js')
    const result = render(<ChatApp />)

    await waitFor(() => {
      expect(harness.client.catalog!.providers).toHaveBeenCalled()
    })
    // After catalog seeds defaults, model label should reflect a real catalog
    // model (not stringified garbage from the malformed blob).
    const composer = result.container.querySelector('.composer-stub')
    expect(composer?.className).not.toContain('composer-stub--model-[object Object]')
    expect(composer?.className).not.toContain('composer-stub--model-false')
    result.unmount()
  })

  it('accepts a well-formed stored selection with missing optional fields', async () => {
    setRouteParams({
      sessionId: 'session-fix5-partial',
      connection: { ip: '10.0.0.1', port: '4567', password: 'pw' },
    })
    // Only `variant` set — must be allowed (Partial<ChatSelection> shape).
    storageGetMock.mockResolvedValueOnce(JSON.stringify({ variant: null }))
    const harness = createFakeChatClient()
    createBackendClientMock.mockReturnValue(harness.client)

    const { App: ChatApp } = await import('../App.js')
    const result = render(<ChatApp />)

    await waitFor(() => {
      expect(harness.client.sessions.messages).toHaveBeenCalledWith('session-fix5-partial')
    })
    expect(result.container.querySelector('.chat-page')).not.toBeNull()
    result.unmount()
  })

  it('rejects a stored selection that is an array (not an object)', async () => {
    setRouteParams({
      sessionId: 'session-fix5-array',
      connection: { ip: '10.0.0.1', port: '4567', password: 'pw' },
    })
    storageGetMock.mockResolvedValueOnce(JSON.stringify(['agent', 'providerID']))
    const harness = createFakeChatClient()
    createBackendClientMock.mockReturnValue(harness.client)

    const { App: ChatApp } = await import('../App.js')
    const result = render(<ChatApp />)

    await waitFor(() => {
      expect(harness.client.sessions.messages).toHaveBeenCalledWith('session-fix5-array')
    })
    expect(result.container.querySelector('.chat-page')).not.toBeNull()
    result.unmount()
  })

  it('renders the existing-session list path when sessionId is provided', async () => {
    setRouteParams({
      sessionId: 'session-existing-1',
      sessionTitle: 'Existing chat',
      connection: { ip: '10.0.0.1', port: '4567', password: 'pw' },
    })
    const messagesMock = vi.fn(async () => [])
    const harness = createFakeChatClient({ messages: messagesMock })
    createBackendClientMock.mockReturnValue(harness.client)

    const { App: ChatApp } = await import('../App.js')
    const result = render(<ChatApp />)

    await waitFor(() => {
      expect(messagesMock).toHaveBeenCalledWith('session-existing-1')
    })
    expect(result.container.querySelector('.new-session-card')).toBeNull()

    result.unmount()
  })

  it('codex backend hides the agent picker and skips the agents() round-trip', async () => {
    setRouteParams({
      isNewSession: true,
      knownDirectories: [],
      connection: {
        kind: 'codex',
        host: 'example.com',
        port: '7777',
        token: '',
        secure: false,
      },
    })

    const subscription = createSubscription()
    const agentsMock = vi.fn(async () => [])
    const providersMock = vi.fn(async () => ({
      providers: [
        {
          id: 'codex',
          name: 'Codex',
          models: [
            { id: 'gpt-5', name: 'GPT-5', reasoning: false, reasoningEfforts: [] },
          ],
        },
      ],
      defaults: { codex: 'gpt-5' },
    }))
    const codexClient: BackendClient = {
      descriptor: { kind: 'codex', label: 'Codex' },
      capabilities: {
        sessions: true,
        streaming: true,
        catalog: true,
        approvals: true,
        pty: false,
        remoteDiscovery: false,
        agentPicker: false,
        modelPicker: true,
      },
      sessions: {
        list: vi.fn(),
        create: vi.fn(async () => ({
          backend: 'codex' as const,
          id: 'codex-session-1',
          backendMeta: {},
        })),
        get: vi.fn(),
        messages: vi.fn(async () => []),
        prompt: vi.fn(async () => ({ status: 'sent' })),
      } as unknown as BackendClient['sessions'],
      events: {
        subscribe: vi.fn(() => subscription),
      },
      catalog: {
        providers: providersMock,
        agents: agentsMock,
      } as unknown as NonNullable<BackendClient['catalog']>,
    }
    createCodexBackendClientMock.mockReturnValue(codexClient)

    const { App: ChatApp } = await import('../App.js')
    const result = render(<ChatApp />)

    await waitFor(() => {
      expect(providersMock).toHaveBeenCalled()
    })

    // The agent picker chip in ChatInput should be hidden, and the codex
    // adapter should never see an agents() call (capability gates it out).
    expect(agentsMock).not.toHaveBeenCalled()
    const composer = result.container.querySelector('.composer-stub')
    expect(composer?.className).toContain('composer-stub--no-agent-picker')

    // NewSessionCard should not render the Agent label either.
    expect(result.queryByText('Agent')).toBeNull()
    // Model field is still present.
    expect(await result.findByText('Model')).toBeInTheDocument()

    // Flat catalog (1 provider): chip shows just the model name, not
    // "codex/gpt-5".
    await waitFor(() => {
      expect(composer?.className).toContain('composer-stub--model-GPT-5')
    })

    result.unmount()
  })

  it('codex prompt payload omits the agent field when none is selected', async () => {
    setRouteParams({
      isNewSession: true,
      connection: {
        kind: 'codex',
        host: 'example.com',
        port: '7777',
        token: '',
        secure: false,
      },
    })

    const subscription = createSubscription()
    const promptMock = vi.fn(async () => ({ status: 'sent' }))
    const codexClient: BackendClient = {
      descriptor: { kind: 'codex', label: 'Codex' },
      capabilities: {
        sessions: true,
        streaming: true,
        catalog: true,
        approvals: true,
        pty: false,
        remoteDiscovery: false,
        agentPicker: false,
        modelPicker: true,
      },
      sessions: {
        list: vi.fn(),
        create: vi.fn(async () => ({
          backend: 'codex' as const,
          id: 'codex-session-2',
          backendMeta: {},
        })),
        get: vi.fn(),
        messages: vi.fn(async () => []),
        prompt: promptMock,
      } as unknown as BackendClient['sessions'],
      events: { subscribe: vi.fn(() => subscription) },
      catalog: {
        providers: vi.fn(async () => ({
          providers: [
            {
              id: 'codex',
              name: 'Codex',
              models: [{ id: 'gpt-5', name: 'GPT-5', reasoning: false, reasoningEfforts: [] }],
            },
          ],
          defaults: { codex: 'gpt-5' },
        })),
        agents: vi.fn(async () => []),
      } as unknown as NonNullable<BackendClient['catalog']>,
    }
    createCodexBackendClientMock.mockReturnValue(codexClient)

    const { App: ChatApp } = await import('../App.js')
    const result = render(<ChatApp />)

    await waitFor(() => {
      expect(codexClient.catalog!.providers).toHaveBeenCalled()
    })

    const composer = result.container.querySelector('.composer-stub')
    expect(composer).not.toBeNull()
    fireEvent.tap(composer!)

    await waitFor(() => {
      expect(promptMock).toHaveBeenCalledTimes(1)
    })
    const firstCall = promptMock.mock.calls[0] as unknown as [string, Record<string, unknown>]
    const payload = firstCall[1]
    expect(payload).toEqual(
      expect.objectContaining({
        parts: [{ type: 'text', text: 'hello world' }],
        model: { providerID: 'codex', modelID: 'gpt-5' },
      }),
    )
    expect(payload.agent).toBeUndefined()

    result.unmount()
  })

  // Selection-init gating: the very first send on a fresh new-session must
  // wait for a real selection to seed — without this the prompt payload
  // would carry FALLBACK_SELECTION, harmless on most OpenCode deployments
  // but a 100% repro on Codex (no `anthropic` provider).
  it('keeps composer disabled and never calls prompt while catalog is pending', async () => {
    setRouteParams({
      isNewSession: true,
      connection: {
        kind: 'codex',
        host: 'example.com',
        port: '7777',
        token: '',
        secure: false,
      },
    })

    const subscription = createSubscription()
    const promptMock = vi.fn(async () => ({ status: 'sent' }))
    // providers() returns a promise that never resolves — simulates a slow
    // server / app foregrounded before catalog finished loading.
    const providersMock = vi.fn(() => new Promise(() => {}))
    const codexClient: BackendClient = {
      descriptor: { kind: 'codex', label: 'Codex' },
      capabilities: {
        sessions: true,
        streaming: true,
        catalog: true,
        approvals: true,
        pty: false,
        remoteDiscovery: false,
        agentPicker: false,
        modelPicker: true,
      },
      sessions: {
        list: vi.fn(),
        create: vi.fn(),
        get: vi.fn(),
        messages: vi.fn(async () => []),
        prompt: promptMock,
      } as unknown as BackendClient['sessions'],
      events: { subscribe: vi.fn(() => subscription) },
      catalog: {
        providers: providersMock as unknown as NonNullable<BackendClient['catalog']>['providers'],
        agents: vi.fn(async () => []),
      } as unknown as NonNullable<BackendClient['catalog']>,
    }
    createCodexBackendClientMock.mockReturnValue(codexClient)

    const { App: ChatApp } = await import('../App.js')
    const result = render(<ChatApp />)

    await waitFor(() => {
      expect(providersMock).toHaveBeenCalled()
    })

    const composer = result.container.querySelector('.composer-stub')
    expect(composer?.className).toContain('composer-stub--disabled')
    expect(composer?.className).toContain('composer-stub--model-Loading…')

    fireEvent.tap(composer!)

    // Give any pending microtasks a chance to flush, then assert prompt
    // was never reached. waitFor would only succeed for the *positive*
    // case; here we want to assert a steady-state negative.
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(promptMock).not.toHaveBeenCalled()

    result.unmount()
  })

  it('enables composer once the catalog seeds the selection', async () => {
    setRouteParams({
      isNewSession: true,
      connection: { ip: '10.0.0.1', port: '4567', password: 'pw' },
    })
    const harness = createFakeChatClient()
    createBackendClientMock.mockReturnValue(harness.client)

    const { App: ChatApp } = await import('../App.js')
    const result = render(<ChatApp />)

    await waitFor(() => {
      const composer = result.container.querySelector('.composer-stub')
      expect(composer?.className).toContain('composer-stub--enabled')
    })
    const composer = result.container.querySelector('.composer-stub')
    expect(composer?.className).not.toContain('composer-stub--model-Loading…')

    result.unmount()
  })

  it('surfaces a catalog-fetch error when nothing has seeded selection', async () => {
    setRouteParams({
      isNewSession: true,
      connection: { ip: '10.0.0.1', port: '4567', password: 'pw' },
    })
    const promptMock = vi.fn()
    const providersMock = vi.fn(async () => {
      throw new Error('Network unreachable')
    })
    const harness = createFakeChatClient({ prompt: promptMock })
    ;(harness.client.catalog!.providers as unknown as ReturnType<typeof vi.fn>) = providersMock
    createBackendClientMock.mockReturnValue(harness.client)

    const { App: ChatApp } = await import('../App.js')
    const result = render(<ChatApp />)

    await waitFor(() => {
      expect(result.queryByText(/Failed to load model catalog/)).not.toBeNull()
    })
    // The composer stays mounted (it lives outside the chat-state branch),
    // but must remain disabled because no selection ever seeded.
    const composer = result.container.querySelector('.composer-stub')
    expect(composer?.className).toContain('composer-stub--disabled')
    fireEvent.tap(composer!)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(promptMock).not.toHaveBeenCalled()

    result.unmount()
  })

  it('enables composer immediately when storage has a full stored selection', async () => {
    setRouteParams({
      sessionId: 'session-stored-1',
      connection: { ip: '10.0.0.1', port: '4567', password: 'pw' },
    })
    storageGetMock.mockResolvedValueOnce(JSON.stringify({
      agent: 'build',
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4-20250514',
      variant: null,
    }))
    // Make catalog hang — composer should still enable from storage alone.
    const providersMock = vi.fn(() => new Promise(() => {}))
    const harness = createFakeChatClient()
    ;(harness.client.catalog!.providers as unknown as ReturnType<typeof vi.fn>) = providersMock
    createBackendClientMock.mockReturnValue(harness.client)

    const { App: ChatApp } = await import('../App.js')
    const result = render(<ChatApp />)

    await waitFor(() => {
      const composer = result.container.querySelector('.composer-stub')
      expect(composer?.className).toContain('composer-stub--enabled')
    })

    result.unmount()
  })
})
