/**
 * Wrapper-level error codes exposed to application consumers.
 */
export type OpencodeWrapperErrorCode =
  | 'invalid_config'
  | 'sdk_request_failed'
  | 'unknown'

export type OpencodeBridgeErrorCode =
  | 'bridge_unavailable'
  | 'bridge_timeout'
  | 'bridge_cancelled'
  | 'bridge_protocol'
  | 'stream_closed'

/**
 * High-level categories used for retry and UX decisions.
 */
export type OpencodeErrorCategory =
  | 'auth'
  | 'network'
  | 'rate-limit'
  | 'not-found'
  | 'unknown'

/**
 * Normalized error shape derived from unknown SDK or runtime failures.
 */
export type NormalizedOpencodeError = {
  category: OpencodeErrorCategory
  bridgeCode?: OpencodeBridgeErrorCode
  message: string
  status?: number
  retryable: boolean
  cause: unknown
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
  }

  if (typeof error === 'string' && error.trim().length > 0) {
    return error
  }

  if (isRecord(error) && typeof error.message === 'string' && error.message.trim().length > 0) {
    return error.message
  }

  if (isRecord(error) && typeof error.error_message === 'string' && error.error_message.trim().length > 0) {
    return error.error_message
  }

  return 'unknown error'
}

function getErrorStatus(error: unknown): number | undefined {
  if (!isRecord(error)) {
    return undefined
  }

  const statusCandidate = error.status
  if (typeof statusCandidate === 'number') {
    return statusCandidate
  }

  const statusCodeCandidate = error.status_code
  return typeof statusCodeCandidate === 'number' ? statusCodeCandidate : undefined
}

function getErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined
  }

  const code = error.code
  if (typeof code === 'string') {
    return code.toLowerCase()
  }

  const envelopeCode = error.error_code
  return typeof envelopeCode === 'string' ? envelopeCode.toLowerCase() : undefined
}

function normalizeCodeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[-\s]+/g, '_')
}

function toBridgeCodeStrict(value: string): OpencodeBridgeErrorCode | undefined {
  const code = normalizeCodeToken(value)

  if (code === 'bridge_unavailable') {
    return 'bridge_unavailable'
  }

  if (code === 'bridge_timeout') {
    return 'bridge_timeout'
  }

  if (code === 'bridge_cancelled') {
    return 'bridge_cancelled'
  }

  if (code === 'bridge_protocol') {
    return 'bridge_protocol'
  }

  if (code === 'stream_closed' || code === 'stream_closed_error') {
    return 'stream_closed'
  }

  return undefined
}

function toBridgeCodeLoose(value: string): OpencodeBridgeErrorCode | undefined {
  const code = normalizeCodeToken(value)

  if (code === 'unavailable') {
    return 'bridge_unavailable'
  }

  if (code === 'timeout') {
    return 'bridge_timeout'
  }

  if (code === 'cancelled' || code === 'canceled') {
    return 'bridge_cancelled'
  }

  if (code === 'protocol') {
    return 'bridge_protocol'
  }

  return toBridgeCodeStrict(code)
}

function isStreamClosedMessage(message: string): boolean {
  const normalized = message.toLowerCase()

  return normalized.includes('stream closed') || normalized.includes('stream was closed')
}

function getBridgeErrorCode(error: unknown): OpencodeBridgeErrorCode | undefined {
  if (!isRecord(error)) {
    return undefined
  }

  if (typeof error.kind === 'string') {
    const mapped = toBridgeCodeLoose(error.kind)
    if (mapped) {
      return mapped
    }
  }

  if (typeof error.error_code === 'string') {
    const mapped = toBridgeCodeLoose(error.error_code)
    if (mapped) {
      return mapped
    }
  }

  if (typeof error.code === 'string') {
    const mapped = toBridgeCodeStrict(error.code)
    if (mapped) {
      return mapped
    }
  }

  const message = getErrorMessage(error)
  if (isStreamClosedMessage(message)) {
    return 'stream_closed'
  }

  return undefined
}

function containsAny(value: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => value.includes(pattern))
}

function isAuthFailure(status: number | undefined, text: string): boolean {
  if (status === 401 || status === 403) {
    return true
  }

  return containsAny(text, ['unauthorized', 'forbidden', 'api key'])
}

function isRateLimitFailure(status: number | undefined, text: string): boolean {
  if (status === 429) {
    return true
  }

  return containsAny(text, ['rate limit', 'too many requests', 'throttl'])
}

function isNotFoundFailure(status: number | undefined, text: string): boolean {
  if (status === 404) {
    return true
  }

  return containsAny(text, ['not found', 'no such'])
}

function isNetworkFailure(status: number | undefined, text: string): boolean {
  if (typeof status === 'number') {
    return false
  }

  return containsAny(text, [
    'network',
    'fetch failed',
    'timeout',
    'timed out',
    'connection',
    'econn',
    'enotfound',
    'eai_again',
    'etimedout',
    'socket hang up',
  ])
}

function isRetryableStatus(status: number | undefined): boolean {
  if (typeof status !== 'number') {
    return false
  }

  return status === 429 || status >= 500
}

function getBridgeCategory(code: OpencodeBridgeErrorCode): OpencodeErrorCategory {
  if (code === 'bridge_unavailable' || code === 'bridge_timeout' || code === 'stream_closed') {
    return 'network'
  }

  return 'unknown'
}

function isRetryableBridgeCode(code: OpencodeBridgeErrorCode): boolean {
  return code === 'bridge_unavailable' || code === 'bridge_timeout' || code === 'stream_closed'
}

/**
 * Classify an unknown error into a small caller-friendly category set.
 */
export function classifyOpencodeError(error: unknown): OpencodeErrorCategory {
  const status = getErrorStatus(error)
  const message = getErrorMessage(error).toLowerCase()
  const code = getErrorCode(error)
  const bridgeCode = getBridgeErrorCode(error)
  const combinedText = `${message} ${code ?? ''}`

  if (bridgeCode) {
    return getBridgeCategory(bridgeCode)
  }

  if (isRateLimitFailure(status, combinedText)) {
    return 'rate-limit'
  }

  if (isAuthFailure(status, combinedText)) {
    return 'auth'
  }

  if (isNotFoundFailure(status, combinedText)) {
    return 'not-found'
  }

  if (isNetworkFailure(status, combinedText)) {
    return 'network'
  }

  return 'unknown'
}

/**
 * Convert an arbitrary failure into the normalized error payload used by the wrapper.
 */
export function normalizeOpencodeError(error: unknown): NormalizedOpencodeError {
  const status = getErrorStatus(error)
  const bridgeCode = getBridgeErrorCode(error)

  return {
    category: classifyOpencodeError(error),
    bridgeCode,
    message: getErrorMessage(error),
    status,
    retryable: bridgeCode ? isRetryableBridgeCode(bridgeCode) : isRetryableStatus(status),
    cause: error,
  }
}

/**
 * Rich error class thrown by wrapper entrypoints.
 */
export class OpencodeWrapperError extends Error {
  readonly code: OpencodeWrapperErrorCode
  readonly status?: number
  readonly retryable: boolean

  constructor(
    message: string,
    options: {
      code: OpencodeWrapperErrorCode
      status?: number
      retryable?: boolean
      cause?: unknown
    },
  ) {
    super(message)
    this.name = 'OpencodeWrapperError'
    this.code = options.code
    this.status = options.status
    this.retryable = options.retryable ?? isRetryableStatus(options.status)

    if ('cause' in options) {
      ;(this as Error & { cause?: unknown }).cause = options.cause
    }
  }
}

/**
 * Convert SDK or runtime failures into the wrapper's canonical error type.
 */
export function normalizeSdkError(error: unknown): OpencodeWrapperError {
  if (error instanceof OpencodeWrapperError) {
    return error
  }

  const normalized = normalizeOpencodeError(error)

  return new OpencodeWrapperError(`OpenCode SDK request failed: ${normalized.message}`, {
    code: 'sdk_request_failed',
    status: normalized.status,
    retryable: normalized.retryable,
    cause: error,
  })
}
