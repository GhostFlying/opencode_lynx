import lynxNativeBridge from '../../native-bridge.js'

import { OpencodeWrapperError, isRecord } from '../errors.js'
import type {
  OpencodeNetworkRequest,
  OpencodeNetworkResponse,
  OpencodeNetworkSseHandle,
  OpencodeNetworkSseOpenInput,
} from './contract.js'

const NETWORK_METHODS = {
  request: 'network.request',
  sseOpen: 'network.sse.open',
  sseClose: 'network.sse.close',
} as const

const DEFAULT_METHOD_TIMEOUT_MS = 30_000
const DEFAULT_SSE_EVENT_NAME_PREFIX = 'network.sse.event.'

const BRIDGE_ERROR_PATTERNS = {
  timeout: ['timeout', 'timed out'],
  unavailable: [
    'nativemodules is not available',
    'native module "nativebridge" is not registered',
    'lynx context not available',
    'bridge unavailable',
    'unavailable in the current runtime',
  ],
  cancelled: ['abort', 'aborted', 'cancelled', 'canceled', 'cancel'],
  protocol: ['protocol', 'invalid', 'malformed', 'missing', 'unexpected'],
} as const

export type NetworkBridgeErrorKind =
  | 'bridge_timeout'
  | 'bridge_unavailable'
  | 'bridge_cancelled'
  | 'bridge_protocol'

export interface NativeBridgeClient {
  callAsync<TParams, TResponse>(
    methodMap: string | { module: string, method: string },
    params: TParams,
    options?: Record<string, unknown>,
    timeout?: number,
  ): Promise<TResponse>
  on(eventName: string, callback: (event: unknown) => void): (event: unknown) => void
  off(eventName: string, callback: (event: unknown) => void): void
}

const defaultBridge: NativeBridgeClient = lynxNativeBridge

export interface NetworkBridgeMethodOptions {
  timeoutMs?: number
  abortSignal?: AbortSignal
}

export interface NetworkBridgeRequestResult<TBody = unknown> extends OpencodeNetworkResponse<TBody> {
  ok: boolean
}

export interface NetworkBridgeOpenSseStreamOptions extends NetworkBridgeMethodOptions {
  eventName?: string
  onEvent?: (payload: unknown) => void
  onError?: (error: OpencodeWrapperError, payload: unknown) => void
}

export interface OpencodeNetworkBridgeClient {
  request<TBody = unknown>(
    input: OpencodeNetworkRequest,
    options?: NetworkBridgeMethodOptions,
  ): Promise<NetworkBridgeRequestResult<TBody>>
  openSseStream(
    input: OpencodeNetworkSseOpenInput,
    options?: NetworkBridgeOpenSseStreamOptions,
  ): Promise<OpencodeNetworkSseHandle>
  closeSseStream(
    handle: OpencodeNetworkSseHandle,
    options?: NetworkBridgeMethodOptions,
  ): Promise<void>
}

interface SseListenerRegistration {
  eventName: string
  listener: (event: unknown) => void
}

interface NetworkSseOpenResponseEnvelope {
  id: string
  eventName: string
}

interface CreateOpencodeNetworkBridgeClientDeps {
  bridge?: NativeBridgeClient
  randomId?: () => string
}

export class OpencodeNetworkBridgeError extends OpencodeWrapperError {
  readonly kind: NetworkBridgeErrorKind

  constructor(
    kind: NetworkBridgeErrorKind,
    message: string,
    options: {
      retryable: boolean
      status?: number
      cause?: unknown
    },
  ) {
    super(message, {
      code: 'unknown',
      retryable: options.retryable,
      status: options.status,
      cause: options.cause,
    })

    this.name = 'OpencodeNetworkBridgeError'
    this.kind = kind
  }
}

function containsAny(value: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => value.includes(pattern))
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
  }

  if (typeof error === 'string' && error.trim().length > 0) {
    return error
  }

  return fallback
}

function createBridgeError(
  kind: NetworkBridgeErrorKind,
  fallbackMessage: string,
  cause: unknown,
): OpencodeNetworkBridgeError {
  return new OpencodeNetworkBridgeError(kind, getErrorMessage(cause, fallbackMessage), {
    retryable: kind === 'bridge_timeout' || kind === 'bridge_unavailable',
    cause,
  })
}

export function normalizeBridgeError(error: unknown): OpencodeNetworkBridgeError {
  if (error instanceof OpencodeNetworkBridgeError) {
    return error
  }

  const message = getErrorMessage(error, 'OpenCode network bridge protocol error.').toLowerCase()

  if (containsAny(message, BRIDGE_ERROR_PATTERNS.timeout)) {
    return createBridgeError(
      'bridge_timeout',
      'OpenCode network bridge request timed out.',
      error,
    )
  }

  if (containsAny(message, BRIDGE_ERROR_PATTERNS.unavailable)) {
    return createBridgeError(
      'bridge_unavailable',
      'OpenCode network bridge is unavailable in the current runtime.',
      error,
    )
  }

  if (containsAny(message, BRIDGE_ERROR_PATTERNS.cancelled)) {
    return createBridgeError(
      'bridge_cancelled',
      'OpenCode network bridge request was cancelled.',
      error,
    )
  }

  if (containsAny(message, BRIDGE_ERROR_PATTERNS.protocol)) {
    return createBridgeError(
      'bridge_protocol',
      'OpenCode network bridge protocol error.',
      error,
    )
  }

  return createBridgeError(
    'bridge_protocol',
    'OpenCode network bridge protocol error.',
    error,
  )
}

function toStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {}
  }

  const entries = Object.entries(value)
  const result: Record<string, string> = {}

  for (const [key, candidate] of entries) {
    if (typeof candidate === 'string') {
      result[key] = candidate
      continue
    }

    if (candidate === null || candidate === undefined) {
      continue
    }

    result[key] = String(candidate)
  }

  return result
}

function toNumericStatus(value: unknown): number | null {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
    return null
  }

  return value
}

function toBridgeErrorFromEnvelope(payload: Record<string, unknown>): OpencodeNetworkBridgeError | null {
  const code = typeof payload.error_code === 'string'
    ? payload.error_code.toLowerCase()
    : null
  const message = typeof payload.error_message === 'string'
    ? payload.error_message
    : 'OpenCode network bridge protocol error.'

  if (!code) {
    return null
  }

  if (code === 'bridge_timeout' || code === 'timeout') {
    return createBridgeError('bridge_timeout', message, payload)
  }

  if (code === 'bridge_unavailable' || code === 'unavailable') {
    return createBridgeError('bridge_unavailable', message, payload)
  }

  if (code === 'bridge_cancelled' || code === 'cancelled' || code === 'canceled') {
    return createBridgeError('bridge_cancelled', message, payload)
  }

  if (code === 'bridge_protocol' || code === 'protocol') {
    return createBridgeError('bridge_protocol', message, payload)
  }

  return createBridgeError('bridge_protocol', message, payload)
}

function normalizeRequestResponse<TBody = unknown>(payload: unknown): NetworkBridgeRequestResult<TBody> {
  if (!isRecord(payload)) {
    throw createBridgeError(
      'bridge_protocol',
      'OpenCode network bridge request payload is malformed.',
      payload,
    )
  }

  const envelopeError = toBridgeErrorFromEnvelope(payload)
  if (envelopeError) {
    throw envelopeError
  }

  const status = toNumericStatus(payload.status) ?? toNumericStatus(payload.status_code)

  if (status === null) {
    throw createBridgeError(
      'bridge_protocol',
      'OpenCode network bridge request payload is missing HTTP status.',
      payload,
    )
  }

  const responseBody = Object.prototype.hasOwnProperty.call(payload, 'body')
    ? payload.body as TBody
    : payload.data as TBody

  const ok = typeof payload.ok === 'boolean'
    ? payload.ok
    : status >= 200 && status < 300

  return {
    ok,
    status,
    headers: toStringRecord(payload.headers),
    body: responseBody,
  }
}

function resolveSseStreamId(handle: OpencodeNetworkSseHandle): string {
  const streamID = typeof handle.id === 'string' ? handle.id.trim() : ''
  if (streamID.length > 0) {
    return streamID
  }

  throw createBridgeError(
    'bridge_protocol',
    'OpenCode network bridge SSE handle is malformed.',
    handle,
  )
}

function normalizeSseOpenResponse(
  payload: unknown,
  fallbackEventName: string,
): NetworkSseOpenResponseEnvelope {
  if (!isRecord(payload)) {
    throw createBridgeError(
      'bridge_protocol',
      'OpenCode network bridge SSE open payload is malformed.',
      payload,
    )
  }

  const envelopeError = toBridgeErrorFromEnvelope(payload)
  if (envelopeError) {
    throw envelopeError
  }

  const streamIDCandidate = typeof payload.id === 'string'
    ? payload.id
    : typeof payload.stream_id === 'string'
      ? payload.stream_id
      : ''
  const streamID = streamIDCandidate.trim()

  if (streamID.length === 0) {
    throw createBridgeError(
      'bridge_protocol',
      'OpenCode network bridge SSE open payload is missing stream id.',
      payload,
    )
  }

  const eventName = typeof payload.event_name === 'string' && payload.event_name.trim().length > 0
    ? payload.event_name
    : fallbackEventName

  return {
    id: streamID,
    eventName,
  }
}

function createAbortedError(): OpencodeNetworkBridgeError {
  return createBridgeError(
    'bridge_cancelled',
    'OpenCode network bridge request was cancelled.',
    new Error('aborted'),
  )
}

function withAbortSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise
  }

  if (signal.aborted) {
    return Promise.reject(createAbortedError())
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(createAbortedError())
    }

    const cleanup = () => {
      signal.removeEventListener('abort', onAbort)
    }

    signal.addEventListener('abort', onAbort, { once: true })

    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
  })
}

export function createOpencodeNetworkBridgeClient(
  deps: CreateOpencodeNetworkBridgeClientDeps = {},
): OpencodeNetworkBridgeClient {
  const bridgeClient = deps.bridge ?? defaultBridge

  if (!bridgeClient) {
    throw createBridgeError(
      'bridge_unavailable',
      'OpenCode network bridge is unavailable in the current runtime.',
      new Error('native bridge module is unavailable'),
    )
  }

  const resolvedBridgeClient: NativeBridgeClient = bridgeClient
  const randomId = deps.randomId ?? (() => {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`
  })

  const registeredSseListeners = new Map<string, SseListenerRegistration>()

  // TODO(network-bridge): AbortSignal currently only races the JS promise.
  // The native request executor continues running after abort.
  // To propagate cancellation, the native bridge needs a cancel/dispose
  // semantic for in-flight callAsync calls, or we need a dedicated cancel
  // method.
  async function callBridgeMethod<TParams, TResponse>(
    methodName: string,
    params: TParams,
    options: NetworkBridgeMethodOptions = {},
  ): Promise<TResponse> {
    try {
      const timeoutMs = options.timeoutMs ?? DEFAULT_METHOD_TIMEOUT_MS
      const pending = resolvedBridgeClient.callAsync<TParams, TResponse>(methodName, params, {}, timeoutMs)
      return await withAbortSignal(pending, options.abortSignal)
    } catch (error) {
      throw normalizeBridgeError(error)
    }
  }

  return {
    async request<TBody = unknown>(input: OpencodeNetworkRequest, options = {}) {
      const payload = await callBridgeMethod<OpencodeNetworkRequest, unknown>(
        NETWORK_METHODS.request,
        input,
        options,
      )

      return normalizeRequestResponse<TBody>(payload)
    },

    async openSseStream(input, options = {}) {
      const fallbackEventName = options.eventName ?? `${DEFAULT_SSE_EVENT_NAME_PREFIX}${randomId()}`

      // Register listener BEFORE opening so early native events are not lost.
      // The listener filters by stream_id once the open response arrives.
      let preRegistered: { eventName: string, listener: (event: unknown) => void } | null = null
      let resolvedStreamId: string | null = null

      if (options.onEvent || options.onError) {
        const listener = (eventPayload: unknown) => {
          if (resolvedStreamId && isRecord(eventPayload) && typeof eventPayload.stream_id === 'string' && eventPayload.stream_id !== resolvedStreamId) {
            return
          }

          try {
            options.onEvent?.(eventPayload)
          } catch (error) {
            options.onError?.(normalizeBridgeError(error), eventPayload)
          }
        }

        try {
          const registered = resolvedBridgeClient.on(fallbackEventName, listener)
          preRegistered = { eventName: fallbackEventName, listener: registered }
        } catch (error) {
          throw normalizeBridgeError(error)
        }
      }

      let payload: unknown
      try {
        payload = await callBridgeMethod<OpencodeNetworkSseOpenInput, unknown>(
          NETWORK_METHODS.sseOpen,
          { ...input, event_name: fallbackEventName },
          options,
        )
      } catch (error) {
        // Clean up pre-registered listener on open failure
        if (preRegistered) {
          try { resolvedBridgeClient.off(preRegistered.eventName, preRegistered.listener) } catch {}
        }
        throw error
      }

      let opened: NetworkSseOpenResponseEnvelope
      try {
        opened = normalizeSseOpenResponse(payload, fallbackEventName)
      } catch (error) {
        if (preRegistered) {
          try { resolvedBridgeClient.off(preRegistered.eventName, preRegistered.listener) } catch {}
        }
        throw error
      }

      resolvedStreamId = opened.id

      if (preRegistered) {
        registeredSseListeners.set(opened.id, preRegistered)
      }

      return {
        id: opened.id,
      }
    },

    async closeSseStream(handle, options = {}) {
      const streamID = resolveSseStreamId(handle)
      const registration = registeredSseListeners.get(streamID)

      if (registration) {
        try {
          resolvedBridgeClient.off(registration.eventName, registration.listener)
        } finally {
          registeredSseListeners.delete(streamID)
        }
      }

      await callBridgeMethod<{ id: string }, unknown>(
        NETWORK_METHODS.sseClose,
        { id: streamID },
        options,
      )
    },
  }
}

