import type { BackendEvent } from '../../backends/index.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function errorMessageFromBackendEvent(event: BackendEvent): string {
  const error = event.payload.error
  if (isRecord(error)) {
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

export function shouldStopThinkingForBackendEvent(event: BackendEvent): boolean {
  return (
    (event.type === 'raw' && event.sourceType === 'session.idle') ||
    (event.type === 'connection.state' &&
      (event.status === 'stopped' || event.status === 'failed'))
  )
}
