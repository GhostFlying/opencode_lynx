import { createWrappedSdkClient } from './client.js'
import { resolveDirectory, resolveWorkspaceSelector } from './config.js'
import { OpencodeWrapperError } from './errors.js'
import {
  V1_CONNECTION_LIFECYCLE_EVENT_NAMES,
  V1_REQUIRED_EVENT_NAMES,
  createEventsApi,
  createNativeEventSourceFactory,
  createSseLifecycleManager,
  isKnownV1EventName,
  parseV1StreamEvent,
} from './events.js'
import {
  INITIAL_SSE_RECONCILE_STATE,
  reconcileSseEvent,
} from './reconcile.js'
import { createSessionsApi } from './sessions.js'
import { createCatalogApi } from './catalog-api.js'
import { createProjectsApi } from './projects.js'
import { createOpencodeNetworkBridgeClient } from './network/bridge-client.js'
import type {
  EventSourceLike,
  EventSourceFactory,
  ParsedV1StreamEvent,
  SseLifecycleState,
  SseReconnectPolicy,
} from './events.js'
import type {
  ReconcileEventLike,
  SseReconcileAction,
  SseReconcileOptions,
  SseReconcileResult,
  SseReconcileState,
} from './reconcile.js'
import type {
  OpencodeClientScope,
  OpencodeGateway,
  OpencodeGatewayNamespaceApi,
  OpencodeWorkspaceSelector,
  OpencodeWrapperConfig,
} from './types.js'

type WrappedSdkClientDeps = NonNullable<Parameters<typeof createWrappedSdkClient>[1]>

interface OpenCodeGatewayDeps {
  createClient?: WrappedSdkClientDeps['createClient']
  createNetworkClient?: WrappedSdkClientDeps['createNetworkClient']
  createEventSource?: EventSourceFactory
}

/**
 * Resolved scope returned by the gateway's scope helper.
 */
export interface OpenCodeGatewayScopeResolution {
  workspace: OpencodeWorkspaceSelector
  directory?: string
}

/**
 * Scope helper exposed by the gateway.
 */
export interface OpenCodeGatewayScopeApi {
  resolve(scope?: OpencodeClientScope): OpenCodeGatewayScopeResolution
}

/**
 * Reconciliation helper exposed by the gateway.
 */
export interface OpenCodeGatewayReconcileApi {
  initialState(): SseReconcileState
  apply(
    state: SseReconcileState,
    event: ReconcileEventLike,
    options?: SseReconcileOptions,
  ): SseReconcileResult
}

/**
 * Context delivered alongside parsed events from the gateway subscription API.
 */
export interface OpenCodeGatewayEventContext {
  action: SseReconcileAction
  state: SseReconcileState
  raw: unknown
}

/**
 * Subscription options for the gateway's app-facing SSE API.
 */
export interface OpenCodeGatewaySubscribeOptions {
  scope?: OpencodeClientScope
  reconnect?: SseReconnectPolicy
  createEventSource?: EventSourceFactory
  reconcile?: SseReconcileOptions
  initialReconcileState?: SseReconcileState
  onEvent?: (event: ParsedV1StreamEvent, context: OpenCodeGatewayEventContext) => void
  onReconcileAction?: (action: SseReconcileAction, state: SseReconcileState, event: ParsedV1StreamEvent) => void
  onLifecycleStateChange?: (state: SseLifecycleState) => void
  onParseError?: (error: OpencodeWrapperError, payload: unknown) => void
  onError?: (error: OpencodeWrapperError) => void
  abortSignal?: AbortSignal
  autoStart?: boolean
}

/**
 * Handle returned by `gateway.events.subscribe(...)`.
 */
export interface OpenCodeGatewayEventSubscription {
  start(): void
  stop(reason?: unknown): void
  reconnect(reason?: unknown): void
  getLifecycleState(): SseLifecycleState
  subscribeLifecycle(listener: (state: SseLifecycleState) => void): () => void
  attachAbortSignal(signal: AbortSignal): () => void
  getReconcileState(): SseReconcileState
}

/**
 * App-facing events API exposed by the gateway.
 */
export interface OpenCodeGatewayEventsApi {
  streamURL(scope?: OpencodeClientScope): string
  readonly requiredEventNames: readonly string[]
  readonly connectionLifecycleEventNames: readonly string[]
  parse(payload: unknown): ParsedV1StreamEvent | null
  isKnownEventName(type: string): boolean
  subscribe(options?: OpenCodeGatewaySubscribeOptions): OpenCodeGatewayEventSubscription
}

/**
 * Full gateway contract consumed by stores or future app services.
 */
export interface OpenCodeGatewayContract extends OpencodeGateway {
  readonly events: OpenCodeGatewayEventsApi
  readonly scope: OpenCodeGatewayScopeApi
  readonly reconcile: OpenCodeGatewayReconcileApi
}

function toInvalidConfigError(error: unknown): OpencodeWrapperError {
  if (error instanceof OpencodeWrapperError) {
    return error
  }

  const message = error instanceof Error && error.message.trim().length > 0
    ? error.message
    : 'Invalid OpenCode gateway configuration.'

  return new OpencodeWrapperError(message, {
    code: 'invalid_config',
    retryable: false,
    cause: error,
  })
}

function toUnknownGatewayError(error: unknown, fallbackMessage: string): OpencodeWrapperError {
  if (error instanceof OpencodeWrapperError) {
    return error
  }

  const status = typeof (error as { status?: unknown })?.status === 'number'
    ? (error as { status: number }).status
    : undefined

  const message = error instanceof Error && error.message.trim().length > 0
    ? error.message
    : fallbackMessage

  return new OpencodeWrapperError(message, {
    code: 'unknown',
    status,
    retryable: false,
    cause: error,
  })
}

function cloneReconcileState(state: SseReconcileState): SseReconcileState {
  return {
    seenEventIds: [...state.seenEventIds],
    lastSequenceByKey: { ...state.lastSequenceByKey },
  }
}

function createScopeApi(config: OpencodeWrapperConfig): OpenCodeGatewayScopeApi {
  return {
    resolve(scope) {
      const workspace = resolveWorkspaceSelector(config, scope)
      const directory = resolveDirectory(config, scope)

      return {
        workspace,
        ...(directory ? { directory } : {}),
      }
    },
  }
}

function createReconcileApi(): OpenCodeGatewayReconcileApi {
  return {
    initialState() {
      return cloneReconcileState(INITIAL_SSE_RECONCILE_STATE)
    },

    apply(state, event, options) {
      return reconcileSseEvent(state, event, options)
    },
  }
}

function createGatewayNamespaceApi(deps: OpenCodeGatewayDeps): OpencodeGatewayNamespaceApi {
  let networkClient: ReturnType<typeof createOpencodeNetworkBridgeClient> | null = null

  const getNetworkClient = () => {
    if (!networkClient) {
      const createNetworkClient = deps.createNetworkClient ?? (() => createOpencodeNetworkBridgeClient())
      networkClient = createNetworkClient()
    }

    return networkClient
  }

  return {
    network: {
      request(input, options) {
        return getNetworkClient().request(input, options)
      },

      sse: {
        open(input, options) {
          return getNetworkClient().openSseStream(input, options)
        },

        close(handle, options) {
          return getNetworkClient().closeSseStream(handle, options)
        },
      },
    },
  }
}

function createGatewayEventsApi(
  config: OpencodeWrapperConfig,
  deps: OpenCodeGatewayDeps,
  scope: OpenCodeGatewayScopeApi,
  reconcile: OpenCodeGatewayReconcileApi,
): OpenCodeGatewayEventsApi {
  const eventsApi = createEventsApi(config)
  const nativeEventSourceFactory = createNativeEventSourceFactory({
    createNetworkClient: deps.createNetworkClient,
  })

  return {
    streamURL(scopeInput) {
      return eventsApi.streamURL(scopeInput)
    },

    requiredEventNames: [...V1_REQUIRED_EVENT_NAMES],
    connectionLifecycleEventNames: [...V1_CONNECTION_LIFECYCLE_EVENT_NAMES],

    parse(payload) {
      return parseV1StreamEvent(payload)
    },

    isKnownEventName(type) {
      return isKnownV1EventName(type)
    },

    subscribe(options: OpenCodeGatewaySubscribeOptions = {}) {
      const resolvedScope = scope.resolve(options.scope)
      const streamURL = eventsApi.streamURL(resolvedScope)
      const createEventSource: EventSourceFactory = options.createEventSource ?? deps.createEventSource ?? nativeEventSourceFactory ?? ((url: string) => {
        const EventSourceCtor = (globalThis as typeof globalThis & {
          EventSource?: new (sourceURL: string) => EventSourceLike
        }).EventSource

        if (!EventSourceCtor) {
          throw new Error('EventSource is unavailable in the current runtime.')
        }

        return new EventSourceCtor(url)
      })

      let state = options.initialReconcileState
        ? cloneReconcileState(options.initialReconcileState)
        : reconcile.initialState()

      const notifyError = (error: unknown, fallbackMessage: string): OpencodeWrapperError => {
        const normalized = toUnknownGatewayError(error, fallbackMessage)
        options.onError?.(normalized)
        return normalized
      }

      const lifecycle = createSseLifecycleManager({
        streamURL,
        reconnect: options.reconnect,
        createEventSource: (url: string) => {
          const source = createEventSource(url)

          source.onmessage = (message: MessageEvent) => {
            const payload = (message as MessageEvent & { data?: unknown }).data
            const parsed = parseV1StreamEvent(payload)

            if (!parsed) {
              const parseError = notifyError(
                new Error('Failed to parse OpenCode SSE event payload.'),
                'Failed to parse OpenCode SSE event payload.',
              )
              options.onParseError?.(parseError, payload)
              return
            }

            let result: SseReconcileResult

            try {
              result = reconcile.apply(state, parsed, options.reconcile)
            } catch (error) {
              notifyError(error, 'OpenCode gateway reconciliation failed.')
              return
            }

            state = result.state
            options.onReconcileAction?.(result.action, state, parsed)

            try {
              options.onEvent?.(parsed, {
                action: result.action,
                state,
                raw: payload,
              })
            } catch (error) {
              notifyError(error, 'OpenCode gateway event handler failed.')
            }
          }

          return source
        },
      })

      let disposeLifecycleListener: (() => void) | null = null
      let disposeAbortSignal: (() => void) | null = null

      if (options.onLifecycleStateChange) {
        disposeLifecycleListener = lifecycle.subscribe(options.onLifecycleStateChange)
      }

      if (options.abortSignal) {
        disposeAbortSignal = lifecycle.attachAbortSignal(options.abortSignal)
      }

      const stop = (reason?: unknown) => {
        lifecycle.stop(reason)

        if (disposeLifecycleListener) {
          disposeLifecycleListener()
          disposeLifecycleListener = null
        }

        if (disposeAbortSignal) {
          disposeAbortSignal()
          disposeAbortSignal = null
        }
      }

      const subscription: OpenCodeGatewayEventSubscription = {
        start() {
          lifecycle.start()
        },

        stop,

        reconnect(reason?: unknown) {
          lifecycle.reconnect(reason)
        },

        getLifecycleState() {
          return lifecycle.getState()
        },

        subscribeLifecycle(listener: (nextState: SseLifecycleState) => void): () => void {
          return lifecycle.subscribe(listener)
        },

        attachAbortSignal(signal: AbortSignal): () => void {
          return lifecycle.attachAbortSignal(signal)
        },

        getReconcileState() {
          return state
        },
      }

      if (options.autoStart ?? true) {
        lifecycle.start()
      }

      return subscription
    },
  }
}

/**
 * Create the complete OpenCode gateway used by application code.
 */
export function createOpencodeGateway(
  config: OpencodeWrapperConfig,
  deps: OpenCodeGatewayDeps = {},
): OpenCodeGatewayContract {
  try {
    const sdkDeps: WrappedSdkClientDeps = {
      ...(deps.createClient ? { createClient: deps.createClient } : {}),
      ...(deps.createNetworkClient ? { createNetworkClient: deps.createNetworkClient } : {}),
    }

    const sdk = createWrappedSdkClient(config, sdkDeps)
    const scope = createScopeApi(config)
    const reconcile = createReconcileApi()
    const events = createGatewayEventsApi(config, deps, scope, reconcile)
    const opencode = createGatewayNamespaceApi(deps)

    return {
      config,
      sessions: createSessionsApi(sdk, config),
      catalog: createCatalogApi(sdk, config),
      projects: createProjectsApi(sdk, config),
      events,
      opencode,
      scope,
      reconcile,
    }
  } catch (error) {
    throw toInvalidConfigError(error)
  }
}

/**
 * Public namespace-style entrypoint used by consumers.
 */
export const OpenCodeGateway = {
  create: createOpencodeGateway,
} as const

/**
 * Concrete instance type returned by `createOpencodeGateway`.
 */
export type OpenCodeGatewayInstance = OpenCodeGatewayContract
