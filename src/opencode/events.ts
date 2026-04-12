import { resolveDirectory, toQueryString } from './config.js'
import { isRecord } from './errors.js'
import {
  createOpencodeNetworkBridgeClient,
  normalizeBridgeError,
} from './network/bridge-client.js'
import type { OpencodeNetworkSseHandle } from './network/contract.js'
import type {
  EventsApi,
  OpencodeWrapperConfig,
} from './types.js'

/**
 * Lifecycle-style event names that matter even when no message payload is changing.
 */
export const V1_CONNECTION_LIFECYCLE_EVENT_NAMES = [
  'server.connected',
  'global.disposed',
  'server.instance.disposed',
] as const

/**
 * Event names the v1 mobile wrapper must understand explicitly.
 */
export const V1_REQUIRED_EVENT_NAMES = [
  'session.status',
  'message.part.updated',
  'message.part.delta',
  'message.updated',
  ...V1_CONNECTION_LIFECYCLE_EVENT_NAMES,
] as const

type V1RequiredEventNameTuple = typeof V1_REQUIRED_EVENT_NAMES
type V1RequiredEventName = V1RequiredEventNameTuple[number]

const V1_REQUIRED_EVENT_NAME_SET = new Set<string>(V1_REQUIRED_EVENT_NAMES)

type UnknownRecord = Record<string, unknown>

const DEFAULT_SSE_RECONNECT_POLICY = {
  initialDelayMs: 1_000,
  multiplier: 2,
  maxDelayMs: 30_000,
  maxRetries: 5,
} as const

interface NormalizedSseReconnectPolicy {
  initialDelayMs: number
  multiplier: number
  maxDelayMs: number
  maxRetries: number
}

/**
 * Caller-configurable reconnect policy overrides for SSE subscriptions.
 */
export interface SseReconnectPolicy {
  initialDelayMs?: number
  multiplier?: number
  maxDelayMs?: number
  maxRetries?: number
}

/**
 * Observable connection states produced by the SSE lifecycle manager.
 */
export type SseLifecycleStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'stopped' | 'failed'

/**
 * Snapshot of lifecycle state emitted to subscribers.
 */
export interface SseLifecycleState {
  status: SseLifecycleStatus
  retryAttempt: number
  nextRetryInMs: number | null
  reason: unknown
}

/**
 * Minimal `EventSource` contract used by the wrapper so tests can inject fakes.
 */
export interface EventSourceLike {
  onopen: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  close(): void
}

/**
 * Factory used to create event sources for a stream URL.
 */
export type EventSourceFactory = (url: string) => EventSourceLike

/**
 * Construction options for the SSE lifecycle manager.
 */
export interface SseLifecycleManagerOptions {
  streamURL: string
  reconnect?: SseReconnectPolicy
  createEventSource?: EventSourceFactory
}

/**
 * Runtime controller for SSE connection lifecycle.
 */
export interface SseLifecycleManager {
  start(): void
  stop(reason?: unknown): void
  reconnect(reason?: unknown): void
  subscribe(listener: (state: SseLifecycleState) => void): () => void
  getState(): SseLifecycleState
  attachAbortSignal(signal: AbortSignal): () => void
}


function normalizePositiveNumber(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value) || value <= 0) {
    return fallback
  }

  return value
}

function normalizeSseReconnectPolicy(policy?: SseReconnectPolicy): NormalizedSseReconnectPolicy {
  const initialDelayMs = normalizePositiveNumber(policy?.initialDelayMs, DEFAULT_SSE_RECONNECT_POLICY.initialDelayMs)
  const multiplier = normalizePositiveNumber(policy?.multiplier, DEFAULT_SSE_RECONNECT_POLICY.multiplier)
  const maxDelayMs = normalizePositiveNumber(policy?.maxDelayMs, DEFAULT_SSE_RECONNECT_POLICY.maxDelayMs)
  const normalizedMaxDelayMs = Math.max(maxDelayMs, initialDelayMs)

  const maxRetries = typeof policy?.maxRetries === 'number' && Number.isFinite(policy.maxRetries)
    ? Math.max(0, Math.floor(policy.maxRetries))
    : DEFAULT_SSE_RECONNECT_POLICY.maxRetries

  return {
    initialDelayMs,
    multiplier,
    maxDelayMs: normalizedMaxDelayMs,
    maxRetries,
  }
}

/**
 * Compute the reconnect delay for a given retry attempt using a capped
 * exponential backoff schedule.
 */
export function computeSseBackoffDelay(
  retryAttempt: number,
  policy: SseReconnectPolicy = {},
): number {
  const normalizedPolicy = normalizeSseReconnectPolicy(policy)
  const normalizedAttempt = Math.max(1, Math.floor(retryAttempt))
  const exponentialDelay = normalizedPolicy.initialDelayMs * normalizedPolicy.multiplier ** (normalizedAttempt - 1)

  return Math.min(Math.round(exponentialDelay), normalizedPolicy.maxDelayMs)
}

export function createNativeEventSourceFactory(
  options: { createNetworkClient?: () => ReturnType<typeof createOpencodeNetworkBridgeClient> } = {},
): EventSourceFactory {
  const createNetworkClient = options.createNetworkClient ?? (() => createOpencodeNetworkBridgeClient())

  return (url: string) => {
    let closed = false
    let nativeOpenReceived = false
    let nativeHandle: OpencodeNetworkSseHandle | null = null
    let nativeClient: ReturnType<typeof createOpencodeNetworkBridgeClient> | null = null

    const source: EventSourceLike = {
      onopen: null,
      onerror: null,
      onmessage: null,
      close() {
        if (closed) return
        closed = true
        if (nativeClient && nativeHandle) {
          void nativeClient.closeSseStream(nativeHandle).catch(() => {})
          nativeHandle = null
        }
      },
    }

    const publishOpen = (event: Event = {} as Event) => {
      if (closed) return
      source.onopen?.(event)
    }

    const publishError = (event: unknown) => {
      if (closed) return
      source.onerror?.(event as Event)
    }

    const publishMessage = (payload: unknown) => {
      if (closed) return
      source.onmessage?.({ data: payload } as MessageEvent)
    }

    const handleNativeEventPayload = (payload: unknown) => {
      if (isRecord(payload) && typeof payload.event === 'string') {
        if (payload.event === 'open') {
          nativeOpenReceived = true
          publishOpen({ type: 'open' } as Event)
          return
        }
        if (payload.event === 'closed') {
          publishError(payload)
          return
        }
        if (payload.event === 'error') {
          if (payload.data === 'reconnect-required') return
          publishError(payload)
          return
        }
      }
      if (isRecord(payload) && Object.prototype.hasOwnProperty.call(payload, 'data')) {
        publishMessage(payload.data)
        return
      }
      publishMessage(payload)
    }

    void (async () => {
      try {
        nativeClient = createNetworkClient()
        nativeHandle = await nativeClient.openSseStream({ path: url }, {
          onEvent: payload => {
            if (closed) return
            if (nativeHandle && isRecord(payload) && typeof payload.stream_id === 'string' && payload.stream_id !== nativeHandle.id) {
              return
            }
            handleNativeEventPayload(payload)
          },
          onError: (error) => {
            if (closed) return
            publishError(normalizeBridgeError(error))
          },
        })

        if (closed) {
          if (nativeHandle) {
            void nativeClient.closeSseStream(nativeHandle).catch(() => {})
            nativeHandle = null
          }
          return
        }

        if (!nativeOpenReceived) {
          publishOpen({ type: 'open' } as Event)
        }
      } catch (error) {
        if (closed) return
        publishError(normalizeBridgeError(error))
      }
    })()

    return source
  }
}

/**
 * Create a reusable SSE lifecycle manager with deterministic retry behavior.
 */
export function createSseLifecycleManager(options: SseLifecycleManagerOptions): SseLifecycleManager {
  const listeners = new Set<(state: SseLifecycleState) => void>()
  const abortDisposers = new Set<() => void>()
  const reconnectPolicy = normalizeSseReconnectPolicy(options.reconnect)
  const createEventSource = options.createEventSource ?? ((url: string) => {
    throw new Error('No EventSource factory available. Provide createEventSource in options.')
  })

  let state: SseLifecycleState = {
    status: 'idle',
    retryAttempt: 0,
    nextRetryInMs: null,
    reason: null,
  }

  let activeSource: EventSourceLike | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let started = false
  let retryAttempt = 0
  let connectionVersion = 0

  function publishState(nextState: SseLifecycleState): void {
    state = nextState

    for (const listener of Array.from(listeners)) {
      listener(state)
    }
  }

  function setState(
    status: SseLifecycleStatus,
    nextRetryAttempt: number,
    nextRetryInMs: number | null,
    reason: unknown,
  ): void {
    publishState({
      status,
      retryAttempt: nextRetryAttempt,
      nextRetryInMs,
      reason,
    })
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer === null) {
      return
    }

    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  function closeActiveSource(): void {
    if (!activeSource) {
      return
    }

    activeSource.onopen = null
    activeSource.onerror = null
    activeSource.onmessage = null
    activeSource.close()
    activeSource = null
  }

  function detachAbortSignals(): void {
    for (const dispose of Array.from(abortDisposers)) {
      dispose()
    }

    abortDisposers.clear()
  }

  function resetConnectionResources(): void {
    connectionVersion += 1
    clearReconnectTimer()
    closeActiveSource()
  }

  function openConnection(reason: unknown): void {
    if (!started) {
      return
    }

    const thisConnectionVersion = ++connectionVersion
    setState('connecting', retryAttempt, null, reason)

    let source: EventSourceLike

    try {
      source = createEventSource(options.streamURL)
    } catch (error) {
      started = false
      setState('failed', retryAttempt, null, error)
      return
    }

    activeSource = source

    source.onopen = () => {
      if (!started || thisConnectionVersion !== connectionVersion) {
        return
      }

      retryAttempt = 0
      setState('open', 0, null, null)
    }

    source.onerror = (error: unknown) => {
      if (!started || thisConnectionVersion !== connectionVersion) {
        return
      }

      closeActiveSource()

      if (retryAttempt >= reconnectPolicy.maxRetries) {
        started = false
        setState('failed', retryAttempt, null, error)
        return
      }

      retryAttempt += 1
      const nextRetryInMs = computeSseBackoffDelay(retryAttempt, reconnectPolicy)

      setState('reconnecting', retryAttempt, nextRetryInMs, error)

      reconnectTimer = setTimeout(() => {
        reconnectTimer = null

        if (!started) {
          return
        }

        openConnection(error)
      }, nextRetryInMs)
    }
  }

  return {
    start() {
      if (started) {
        return
      }

      started = true
      retryAttempt = 0
      resetConnectionResources()
      openConnection('start')
    },

    stop(reason: unknown = 'stop') {
      if (!started && state.status === 'stopped') {
        return
      }

      started = false
      retryAttempt = 0
      resetConnectionResources()
      detachAbortSignals()
      setState('stopped', 0, null, reason)
    },

    reconnect(reason: unknown = 'manual-reconnect') {
      if (state.status === 'stopped') {
        return
      }

      started = true
      retryAttempt = 0
      resetConnectionResources()
      setState('reconnecting', 0, 0, reason)
      openConnection(reason)
    },

    subscribe(listener: (nextState: SseLifecycleState) => void) {
      listeners.add(listener)
      listener(state)

      return () => {
        listeners.delete(listener)
      }
    },

    getState() {
      return state
    },

    attachAbortSignal(signal: AbortSignal) {
      if (signal.aborted) {
        this.stop('abort')
        return () => {}
      }

      const onAbort = () => {
        this.stop('abort')
      }

      signal.addEventListener('abort', onAbort, { once: true })

      const dispose = () => {
        signal.removeEventListener('abort', onAbort)
      }

      abortDisposers.add(dispose)

      return () => {
        dispose()
        abortDisposers.delete(dispose)
      }
    },
  }
}

interface BaseKnownEvent<TType extends V1RequiredEventName, TProperties extends UnknownRecord>
{
  type: TType
  properties: TProperties
}

export interface SessionStatusEvent extends BaseKnownEvent<'session.status', {
  sessionID?: string
  status?: string
} & UnknownRecord> {}

/**
 * Typed `message.part.updated` event payload.
 */
export interface MessagePartUpdatedEvent extends BaseKnownEvent<'message.part.updated', {
  sessionID?: string
  messageID?: string
  partID?: string
} & UnknownRecord> {}

/**
 * Typed `message.part.delta` event payload.
 */
export interface MessagePartDeltaEvent extends BaseKnownEvent<'message.part.delta', {
  sessionID?: string
  messageID?: string
  partID?: string
  delta?: string
} & UnknownRecord> {}

/**
 * Typed `message.updated` event payload.
 */
export interface MessageUpdatedEvent extends BaseKnownEvent<'message.updated', {
  sessionID?: string
  messageID?: string
} & UnknownRecord> {}

/**
 * Typed `server.connected` event payload.
 */
export interface ServerConnectedEvent extends BaseKnownEvent<'server.connected', UnknownRecord> {}

/**
 * Typed `global.disposed` event payload.
 */
export interface GlobalDisposedEvent extends BaseKnownEvent<'global.disposed', UnknownRecord> {}

/**
 * Typed `server.instance.disposed` event payload.
 */
export interface ServerInstanceDisposedEvent
  extends BaseKnownEvent<'server.instance.disposed', UnknownRecord> {}

/**
 * Union of all known v1 event types.
 */
export type KnownV1StreamEvent =
  | SessionStatusEvent
  | MessagePartUpdatedEvent
  | MessagePartDeltaEvent
  | MessageUpdatedEvent
  | ServerConnectedEvent
  | GlobalDisposedEvent
  | ServerInstanceDisposedEvent

/**
 * Fallback envelope returned when an event is syntactically valid but unknown.
 */
export interface UnknownV1StreamEvent {
  type: 'unknown'
  eventType: string
  properties: unknown
}

/**
 * Parsed stream event exposed to callers.
 */
export type ParsedV1StreamEvent = KnownV1StreamEvent | UnknownV1StreamEvent

/**
 * Raw event envelope shape before event-type refinement.
 */
export interface RawEventEnvelope {
  type: string
  properties: unknown
}


function toRawEnvelope(value: unknown): RawEventEnvelope | null {
  if (!isRecord(value)) {
    return null
  }

  // Opencode's /global/event endpoint wraps events as {payload: {type, properties}}.
  // Unwrap if we see that shape.
  const maybeWrapped = value as { payload?: unknown }
  if (isRecord(maybeWrapped.payload) && typeof (maybeWrapped.payload as { type?: unknown }).type === 'string') {
    return toRawEnvelope(maybeWrapped.payload)
  }

  const { type, properties } = value

  if (typeof type !== 'string') {
    return null
  }

  if (!('properties' in value)) {
    return null
  }

  return {
    type,
    properties,
  }
}

/**
 * Parse a raw SSE payload into an untyped envelope shape.
 */
export function parseRawEventEnvelope(payload: string | unknown): RawEventEnvelope | null {
  if (typeof payload === 'string') {
    try {
      return toRawEnvelope(JSON.parse(payload))
    } catch {
      return null
    }
  }

  return toRawEnvelope(payload)
}

/**
 * Check whether a raw event name belongs to the v1 required set.
 */
export function isKnownV1EventName(type: string): type is V1RequiredEventName {
  return V1_REQUIRED_EVENT_NAME_SET.has(type)
}

/**
 * Parse a raw payload into a typed known event or a safe `unknown` fallback.
 */
export function parseV1StreamEvent(payload: string | unknown): ParsedV1StreamEvent | null {
  const envelope = parseRawEventEnvelope(payload)

  if (!envelope) {
    return null
  }

  if (!isKnownV1EventName(envelope.type)) {
    return {
      type: 'unknown',
      eventType: envelope.type,
      properties: envelope.properties,
    }
  }

  if (!isRecord(envelope.properties)) {
    return {
      type: 'unknown',
      eventType: envelope.type,
      properties: envelope.properties,
    }
  }

  return {
    type: envelope.type,
    properties: envelope.properties,
  } as KnownV1StreamEvent
}

/**
 * Create the lightweight events API used by the gateway.
 */
export function createEventsApi(config: OpencodeWrapperConfig): EventsApi {
  return {
    streamURL(scope) {
      const directory = resolveDirectory(config, scope)
      const query = toQueryString({ directory })
      const path = '/global/event'
      const normalizedBase = config.baseUrl.endsWith('/') ? config.baseUrl.slice(0, -1) : config.baseUrl

      return query ? `${normalizedBase}${path}?${query}` : `${normalizedBase}${path}`
    },
  }
}
