import type { BackendEvent } from '../../backends/index.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function errorMessageFromBackendEvent(event: BackendEvent): string {
  const error = event.payload.error
  if (typeof error === 'string' && error.trim().length > 0) return error
  if (isRecord(error)) {
    if (typeof error.message === 'string' && error.message.trim().length > 0) {
      return error.message
    }
    const data = error.data
    if (isRecord(data) && typeof data.message === 'string' && data.message.trim().length > 0) {
      return data.message
    }
  }

  return 'Agent reported an error.'
}

export function shouldRefreshMessagesForBackendEvent(event: BackendEvent): boolean {
  return event.type === 'message.updated' || event.type === 'resync.required'
}

/**
 * Return true if this event is the "we tried to call the model and it failed,
 * we will try again" pulse. The codex backend sends one of these per retry
 * attempt; the chat surfaces them as "Retrying… N/5" instead of stopping.
 */
export function isRetryingBackendEvent(event: BackendEvent): boolean {
  if (event.type !== 'connection.state') return false
  const payload = event.payload as { severity?: unknown; willRetry?: unknown }
  return payload?.severity === 'error' && payload?.willRetry === true
}

/**
 * Return true if this event marks the end of a turn — either successfully
 * (`turn.completed`) or terminally (a `connection.state` error that won't
 * retry). The OpenCode backend signals this via `raw + sourceType=session.idle`;
 * codex uses turn.completed/error. Either way, the chat indicator stops.
 */
export function shouldStopThinkingForBackendEvent(event: BackendEvent): boolean {
  if (event.type === 'raw' && event.sourceType === 'session.idle') return true
  if (event.type === 'turn.completed') return true
  if (event.type === 'connection.state') {
    // OpenCode reports stopped/failed via the top-level `status` field.
    if (event.status === 'stopped' || event.status === 'failed') return true
    // Codex reports terminal model-call failures via payload.severity.
    const payload = event.payload as { severity?: unknown; willRetry?: unknown }
    if (payload?.severity === 'error' && payload?.willRetry === false) return true
  }
  return false
}

/**
 * Return true for a terminal failure that should also surface a user-visible
 * error (not just stop the indicator). Distinguishes "turn ended cleanly" from
 * "turn ended because the model couldn't be reached".
 */
export function isTerminalErrorBackendEvent(event: BackendEvent): boolean {
  if (event.type === 'raw' && event.sourceType === 'session.error') return true
  if (event.type === 'connection.state') {
    const payload = event.payload as { severity?: unknown; willRetry?: unknown }
    if (payload?.severity === 'error' && payload?.willRetry === false) return true
  }
  return false
}
