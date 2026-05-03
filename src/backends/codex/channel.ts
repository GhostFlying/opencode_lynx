import lynxNativeBridge from '../../native-bridge.js'

export type ChannelState =
  | { state: 'open' }
  | { state: 'closing' }
  | { state: 'closed'; code?: number; reason?: string }
  | { state: 'error'; error: string; code?: number; reason?: string }

export interface BackendChannel {
  send(payload: Record<string, unknown>): Promise<void>
  onMessage(handler: (frame: Record<string, unknown>) => void): () => void
  onState(handler: (state: ChannelState) => void): () => void
  close(code?: number, reason?: string): Promise<void>
}

export interface BackendChannelBridge {
  callAsync(
    method: string,
    params: unknown,
    options?: Record<string, unknown>,
    timeout?: number,
  ): Promise<unknown>
  on(eventName: string, callback: (event: unknown) => void): (event: unknown) => void
  off(eventName: string, callback: (event: unknown) => void): void
}

export interface OpenBackendChannelOptions {
  url: string
  headers?: Record<string, string>
  pingIntervalMs?: number
  bridge?: BackendChannelBridge
  randomId?: () => string
}

export async function openBackendChannel(opts: OpenBackendChannelOptions): Promise<BackendChannel> {
  const bridge: BackendChannelBridge = opts.bridge ?? (lynxNativeBridge as unknown as BackendChannelBridge)
  const randomId = opts.randomId ?? defaultRandomId

  const id = randomId()
  const messageEventName = `backend.channel.message.${id}`
  const stateEventName = `backend.channel.state.${id}`

  const messageSubscribers = new Set<(frame: Record<string, unknown>) => void>()
  const stateSubscribers = new Set<(state: ChannelState) => void>()
  let lastState: ChannelState | null = null
  let closed = false

  const messageListener = (event: unknown): void => {
    if (!isRecord(event)) return
    const frame = event.frame
    if (isRecord(frame)) {
      for (const subscriber of [...messageSubscribers]) {
        try {
          subscriber(frame)
        } catch (error) {
          console.warn('[backend.channel] onMessage handler threw', error)
        }
      }
    }
  }

  const cleanupBridgeListeners = (): void => {
    bridge.off(messageEventName, messageListener)
    bridge.off(stateEventName, stateListener)
  }

  const stateListener = (event: unknown): void => {
    if (!isRecord(event)) return
    const mapped = mapStateEvent(event)
    if (!mapped) return
    lastState = mapped
    for (const subscriber of [...stateSubscribers]) {
      try {
        subscriber(mapped)
      } catch (error) {
        console.warn('[backend.channel] onState handler threw', error)
      }
    }
    // Remote-driven termination: native has emitted a final state, so the
    // channel cannot deliver more frames. Mark closed and release bridge
    // listeners so callers don't have to remember to call close() after a
    // remote close. Subsequent send() rejects; close() is a no-op.
    if (mapped.state === 'closed') {
      if (!closed) {
        closed = true
        cleanupBridgeListeners()
      }
    }
  }

  bridge.on(messageEventName, messageListener)
  bridge.on(stateEventName, stateListener)

  let channelId: string
  try {
    const result = await bridge.callAsync('backend.channel.open', {
      url: opts.url,
      headers: opts.headers,
      message_event_name: messageEventName,
      state_event_name: stateEventName,
      ping_interval_ms: opts.pingIntervalMs ?? 30_000,
    })
    if (!isRecord(result) || typeof result.channel_id !== 'string' || !result.channel_id) {
      throw new Error('backend.channel.open did not return a channel_id')
    }
    channelId = result.channel_id
  } catch (error) {
    cleanupBridgeListeners()
    throw error
  }

  return {
    async send(payload: Record<string, unknown>): Promise<void> {
      if (closed) {
        throw new Error('backend channel is closed')
      }
      await bridge.callAsync('backend.channel.send', {
        channel_id: channelId,
        payload,
      })
    },

    onMessage(handler: (frame: Record<string, unknown>) => void): () => void {
      messageSubscribers.add(handler)
      return () => {
        messageSubscribers.delete(handler)
      }
    },

    onState(handler: (state: ChannelState) => void): () => void {
      stateSubscribers.add(handler)
      if (lastState) {
        const snapshot = lastState
        try {
          handler(snapshot)
        } catch (error) {
          console.warn('[backend.channel] onState handler threw on replay', error)
        }
      }
      return () => {
        stateSubscribers.delete(handler)
      }
    },

    async close(code?: number, reason?: string): Promise<void> {
      if (closed) return
      closed = true
      try {
        await bridge.callAsync('backend.channel.close', {
          channel_id: channelId,
          code,
          reason,
        })
      } finally {
        cleanupBridgeListeners()
      }
    },
  }
}

function mapStateEvent(event: Record<string, unknown>): ChannelState | null {
  const stateValue = event.state
  if (stateValue === 'open') return { state: 'open' }
  if (stateValue === 'closing') return { state: 'closing' }
  if (stateValue === 'closed') {
    const out: ChannelState = { state: 'closed' }
    if (typeof event.code === 'number') out.code = event.code
    if (typeof event.reason === 'string') out.reason = event.reason
    return out
  }
  if (stateValue === 'error') {
    const out: ChannelState = {
      state: 'error',
      error: typeof event.error === 'string' ? event.error : 'unknown',
    }
    if (typeof event.code === 'number') out.code = event.code
    if (typeof event.reason === 'string') out.reason = event.reason
    return out
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function defaultRandomId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}
