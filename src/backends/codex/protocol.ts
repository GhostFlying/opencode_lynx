// JSON-RPC 2.0 client for the Codex app-server. Sits on top of
// `BackendChannel` (Phase 1 transport) and is consumed by the Codex adapter
// (M2.4). Owns:
//   - request / response correlation by id
//   - one-way notification dispatch (server -> client)
//   - server-initiated request handling (approvals, permissions, dynamic tools)
//   - the two-step initialize handshake gate
//   - request timeouts and pending-call cleanup
//   - reconnect (transport-driven), with handshake replay so adapters see a
//     fresh notification stream after reopen.
//
// Behavior contract is documented inline alongside each section. See
// `.codex-rollout/handoffs/M2.2.md` for the spec this implements.

import { openBackendChannel } from './channel.js'
import type {
  BackendChannel,
  ChannelState,
  OpenBackendChannelOptions,
} from './channel.js'

/** JSON-RPC 2.0 frames */
export type JsonRpcId = string | number

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: P
}

export interface JsonRpcNotification<P = unknown> {
  jsonrpc: '2.0'
  method: string
  params?: P
}

export interface JsonRpcResponseOk<R = unknown> {
  jsonrpc: '2.0'
  id: JsonRpcId
  result: R
}

export interface JsonRpcResponseErr {
  jsonrpc: '2.0'
  id: JsonRpcId
  error: { code: number; message: string; data?: unknown }
}

/** Server-initiated request surface (e.g. approvals). */
export interface ServerInitiatedRequest {
  id: JsonRpcId
  method: string
  params: unknown
  /** Send the response back. Throws if already responded or channel closed. */
  respond(result: unknown): Promise<void>
  respondError(code: number, message: string, data?: unknown): Promise<void>
}

export interface CodexProtocolEvents {
  onNotification(handler: (n: { method: string; params: unknown }) => void): () => void
  onServerRequest(handler: (req: ServerInitiatedRequest) => void): () => void
  onConnectionState(handler: (state: ProtocolConnectionState) => void): () => void
}

export type ProtocolConnectionState =
  | { status: 'connecting'; attempt: number }
  | { status: 'open' } // initialize+initialized done
  | { status: 'reconnecting'; attempt: number; reason: unknown }
  | { status: 'failed'; reason: unknown }
  | { status: 'closed' }

export interface CodexProtocolClient extends CodexProtocolEvents {
  /** Send a JSON-RPC request and resolve with the result, or reject with error. */
  request<Result = unknown, Params = unknown>(
    method: string,
    params?: Params,
    options?: { timeoutMs?: number },
  ): Promise<Result>
  /** Send a one-way notification. Returns once the channel accepts the frame. */
  notify<Params = unknown>(method: string, params?: Params): Promise<void>
  /** Force a reconnect now (used by adapter on app foreground / explicit retry). */
  reconnect(reason?: unknown): void
  /** Tear down: closes channel + rejects all pending. Idempotent. */
  close(reason?: unknown): Promise<void>
  /** Current connection state. */
  getState(): ProtocolConnectionState
}

export interface CreateCodexProtocolOptions {
  url: string
  headers?: Record<string, string>
  pingIntervalMs?: number
  /** Override channel opener (for tests). Defaults to openBackendChannel. */
  openChannel?: (opts: OpenBackendChannelOptions) => Promise<BackendChannel>
  /** Client info sent in initialize. */
  clientInfo: { name: string; version: string }
  /** Optional capabilities forwarded to initialize.params. */
  capabilities?: Record<string, unknown> | null
  /** Default request timeout. */
  defaultTimeoutMs?: number
  /**
   * Backoff schedule for reconnect attempts in ms. Defaults to
   * `[500, 1000, 2000, 4000, 8000]`, then repeats the last entry. An empty
   * array means "fail fast" — protocol transitions to `failed` after the
   * first close without retrying.
   */
  retrySchedule?: ReadonlyArray<number>
  /** Inject id factory + clock for tests. */
  randomId?: () => string
  now?: () => number
}

const DEFAULT_RETRY_SCHEDULE: ReadonlyArray<number> = [500, 1000, 2000, 4000, 8000]
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const JSONRPC_VERSION = '2.0'

interface PendingRequest {
  id: JsonRpcId
  method: string
  resolve(value: unknown): void
  reject(reason: unknown): void
  timeoutHandle: ReturnType<typeof setTimeout> | null
}

type QueuedSend = QueuedRequestSend | QueuedNotifySend

interface QueuedRequestSend {
  kind: 'request'
  method: string
  params: unknown | undefined
  /** The pending entry created at request() time. Id is allocated on flush. */
  pending: PendingRequest
  /** Rejects the public promise — used on send failure and on close. */
  rejectPublic(reason: unknown): void
}

interface QueuedNotifySend {
  kind: 'notify'
  payload: Record<string, unknown>
  resolveAccepted(): void
  rejectPublic(reason: unknown): void
}

export function createCodexProtocolClient(opts: CreateCodexProtocolOptions): CodexProtocolClient {
  const openChannel = opts.openChannel ?? openBackendChannel
  const retrySchedule = opts.retrySchedule ?? DEFAULT_RETRY_SCHEDULE
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  // `now` is held for future jitter / scheduling extensions; tests inject it
  // alongside fake timers. Reference it to avoid an "unused option" lint.
  void (opts.now ?? Date.now)

  // Listener registries — these live across reconnects.
  const notificationListeners = new Set<(n: { method: string; params: unknown }) => void>()
  const serverRequestListeners = new Set<(req: ServerInitiatedRequest) => void>()
  const stateListeners = new Set<(state: ProtocolConnectionState) => void>()

  // Per-session state (reset on each new channel).
  let channel: BackendChannel | null = null
  let unsubChannelMessage: (() => void) | null = null
  let unsubChannelState: (() => void) | null = null
  let nextRequestId = 1
  // `initialized` flips true once the initialize response was received AND
  // the `initialized` notification was sent. While false, request/notify
  // calls queue (except for the initialize handshake itself, which goes
  // through runHandshake() inline).
  let initialized = false
  let pending = new Map<JsonRpcId, PendingRequest>()
  let outstandingWrappers = new Map<JsonRpcId, ServerInitiatedRequest>()
  let preInitQueue: QueuedSend[] = []
  let initializePending: PendingRequest | null = null

  // Reconnect / lifecycle bookkeeping.
  let connectionState: ProtocolConnectionState = { status: 'connecting', attempt: 0 }
  let attempt = 0 // monotonic across reconnects, reset on successful open
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let openInFlight = false
  let closedByCaller = false
  // Tracks whether we've started the initial open() so request()/notify()
  // calls before bootstrap kick the lifecycle.
  let bootstrapStarted = false

  function setState(next: ProtocolConnectionState): void {
    connectionState = next
    for (const listener of [...stateListeners]) {
      try {
        listener(next)
      } catch (error) {
        console.warn('[codex.protocol] onConnectionState handler threw', error)
      }
    }
  }

  function emitNotification(method: string, params: unknown): void {
    for (const listener of [...notificationListeners]) {
      try {
        listener({ method, params })
      } catch (error) {
        console.warn('[codex.protocol] onNotification handler threw', error)
      }
    }
  }

  function emitServerRequest(req: ServerInitiatedRequest): void {
    for (const listener of [...serverRequestListeners]) {
      try {
        listener(req)
      } catch (error) {
        console.warn('[codex.protocol] onServerRequest handler threw', error)
      }
    }
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function rejectAllPending(reason: unknown): void {
    for (const entry of pending.values()) {
      if (entry.timeoutHandle !== null) clearTimeout(entry.timeoutHandle)
      try {
        entry.reject(reason)
      } catch {
        // ignore
      }
    }
    pending = new Map()
    if (initializePending) {
      if (initializePending.timeoutHandle !== null) clearTimeout(initializePending.timeoutHandle)
      try {
        initializePending.reject(reason)
      } catch {
        // ignore
      }
      initializePending = null
    }
  }

  function rejectPreInitQueue(reason: unknown): void {
    const queued = preInitQueue
    preInitQueue = []
    for (const item of queued) {
      try {
        item.rejectPublic(reason)
      } catch {
        // ignore listener throws
      }
    }
  }

  function failOutstandingServerRequests(): void {
    const wrappers = [...outstandingWrappers.values()]
    outstandingWrappers = new Map()
    for (const wrapper of wrappers) {
      // respondError no-ops cleanly when the channel is already detached. It
      // still flips internal `responded` so a later respond() throws. The
      // adapter (M2.4) receives the cancellation via this code/message and
      // can release its correlation map.
      wrapper
        .respondError(-32603, 'channel closed before response')
        .catch(() => {
          // ignore — adapter side may have already raced its own respond()
        })
    }
  }

  function detachChannel(): void {
    if (unsubChannelMessage) {
      try {
        unsubChannelMessage()
      } catch {
        // ignore
      }
      unsubChannelMessage = null
    }
    if (unsubChannelState) {
      try {
        unsubChannelState()
      } catch {
        // ignore
      }
      unsubChannelState = null
    }
    if (channel) {
      const ch = channel
      channel = null
      // Best-effort cleanup; the remote may already be gone.
      ch.close().catch(() => {
        // ignore
      })
    }
  }

  function handleChannelTermination(reason: unknown): void {
    if (closedByCaller) return
    initialized = false
    rejectAllPending(new Error('protocol: channel closed during request'))
    failOutstandingServerRequests()
    detachChannel()

    if (retrySchedule.length === 0) {
      setState({ status: 'failed', reason })
      // Fail any queued sends as well — there will be no future flush.
      rejectPreInitQueue(new Error('protocol: connection failed'))
      return
    }

    const idx = Math.min(attempt, retrySchedule.length - 1)
    const delayMs = retrySchedule[idx] ?? retrySchedule[retrySchedule.length - 1]!
    attempt += 1
    setState({ status: 'reconnecting', attempt, reason })
    clearReconnectTimer()
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void openConnection()
    }, delayMs)
  }

  function dispatchFrame(frame: Record<string, unknown>): void {
    // Discriminator: response frames carry an id and either result or error
    // and no method. Server requests carry both id AND method. Notifications
    // carry method without id.
    const hasId = frame.id !== undefined && frame.id !== null
    const hasMethod = typeof frame.method === 'string'
    const hasResult = 'result' in frame
    const hasError = 'error' in frame

    if (hasId && !hasMethod && (hasResult || hasError)) {
      handleResponse(frame as unknown as JsonRpcResponseOk | JsonRpcResponseErr)
      return
    }
    if (hasId && hasMethod) {
      handleServerRequest(frame as unknown as JsonRpcRequest)
      return
    }
    if (hasMethod) {
      const method = frame.method as string
      emitNotification(method, frame.params)
      return
    }
    console.warn('[codex.protocol] dropping malformed frame', frame)
  }

  function handleResponse(frame: JsonRpcResponseOk | JsonRpcResponseErr): void {
    const id = frame.id
    // Initialize is a special pending entry that is NOT in the regular pending
    // map (we want to treat it as part of the handshake gate, not as a normal
    // user request).
    if (initializePending && initializePending.id === id) {
      const entry = initializePending
      initializePending = null
      if (entry.timeoutHandle !== null) clearTimeout(entry.timeoutHandle)
      if ('error' in frame) {
        entry.reject(toError(frame.error))
      } else {
        entry.resolve((frame as JsonRpcResponseOk).result)
      }
      return
    }
    const entry = pending.get(id)
    if (!entry) {
      console.warn('[codex.protocol] response for unknown id', id)
      return
    }
    pending.delete(id)
    if (entry.timeoutHandle !== null) clearTimeout(entry.timeoutHandle)
    if ('error' in frame) {
      entry.reject(toError(frame.error))
    } else {
      entry.resolve((frame as JsonRpcResponseOk).result)
    }
  }

  function handleServerRequest(frame: JsonRpcRequest): void {
    const id = frame.id
    const method = frame.method
    const params = frame.params as unknown
    let responded = false

    const respond = async (result: unknown): Promise<void> => {
      if (responded) {
        throw new Error(`server request ${String(id)} already responded`)
      }
      if (!channel) {
        responded = true
        outstandingWrappers.delete(id)
        throw new Error('channel closed before response')
      }
      responded = true
      outstandingWrappers.delete(id)
      const responseFrame: JsonRpcResponseOk = { jsonrpc: JSONRPC_VERSION, id, result }
      await channel.send(responseFrame as unknown as Record<string, unknown>)
    }

    const respondError = async (
      code: number,
      message: string,
      data?: unknown,
    ): Promise<void> => {
      if (responded) {
        throw new Error(`server request ${String(id)} already responded`)
      }
      responded = true
      outstandingWrappers.delete(id)
      if (!channel) {
        // No-op: channel is gone. We've still flipped `responded` so a later
        // respond() throws; the auto-cleanup path uses this branch.
        return
      }
      const errorObj: { code: number; message: string; data?: unknown } = { code, message }
      if (data !== undefined) errorObj.data = data
      const responseFrame: JsonRpcResponseErr = {
        jsonrpc: JSONRPC_VERSION,
        id,
        error: errorObj,
      }
      await channel.send(responseFrame as unknown as Record<string, unknown>)
    }

    const wrapper: ServerInitiatedRequest = {
      id,
      method,
      params,
      respond,
      respondError,
    }
    outstandingWrappers.set(id, wrapper)
    emitServerRequest(wrapper)
  }

  async function openConnection(): Promise<void> {
    if (closedByCaller) return
    if (openInFlight) return
    openInFlight = true
    setState({ status: 'connecting', attempt })

    // Reset per-session counters.
    nextRequestId = 1
    pending = new Map()
    outstandingWrappers = new Map()
    initialized = false

    let newChannel: BackendChannel
    try {
      const channelOpts: OpenBackendChannelOptions = { url: opts.url }
      if (opts.headers) channelOpts.headers = opts.headers
      if (opts.pingIntervalMs !== undefined) channelOpts.pingIntervalMs = opts.pingIntervalMs
      newChannel = await openChannel(channelOpts)
    } catch (error) {
      openInFlight = false
      handleChannelTermination(error)
      return
    }
    if (closedByCaller) {
      openInFlight = false
      try {
        await newChannel.close()
      } catch {
        // ignore
      }
      return
    }
    channel = newChannel
    unsubChannelMessage = newChannel.onMessage((frame) => {
      try {
        dispatchFrame(frame)
      } catch (error) {
        console.warn('[codex.protocol] dispatchFrame threw', error)
      }
    })
    unsubChannelState = newChannel.onState((state) => {
      handleChannelStateChange(state)
    })

    try {
      await runHandshake()
    } catch (error) {
      openInFlight = false
      handleChannelTermination(error)
      return
    }

    openInFlight = false
    initialized = true
    attempt = 0
    setState({ status: 'open' })
    flushPreInitQueue()
  }

  function handleChannelStateChange(state: ChannelState): void {
    if (state.state === 'closed') {
      handleChannelTermination(state.reason ?? 'channel closed')
    } else if (state.state === 'error') {
      handleChannelTermination(new Error(`channel error: ${state.error}`))
    }
    // 'open' / 'closing' are informational — the handshake's await on
    // initialize already establishes liveness.
  }

  async function runHandshake(): Promise<void> {
    if (!channel) throw new Error('protocol: no channel during handshake')
    const id = allocId()
    const initParams: {
      clientInfo: { name: string; version: string }
      capabilities: Record<string, unknown> | null
    } = {
      clientInfo: opts.clientInfo,
      capabilities: opts.capabilities ?? null,
    }
    const initFrame: JsonRpcRequest = {
      jsonrpc: JSONRPC_VERSION,
      id,
      method: 'initialize',
      params: initParams,
    }
    const initPromise = new Promise<unknown>((resolve, reject) => {
      const handle = setTimeout(() => {
        if (initializePending && initializePending.id === id) {
          initializePending = null
          reject(new Error(`timeout: initialize`))
        }
      }, defaultTimeoutMs)
      initializePending = {
        id,
        method: 'initialize',
        resolve,
        reject,
        timeoutHandle: handle,
      }
    })
    await channel.send(initFrame as unknown as Record<string, unknown>)
    await initPromise
    if (!channel) throw new Error('protocol: channel lost after initialize')
    const initializedFrame: JsonRpcNotification = {
      jsonrpc: JSONRPC_VERSION,
      method: 'initialized',
    }
    await channel.send(initializedFrame as unknown as Record<string, unknown>)
  }

  function flushPreInitQueue(): void {
    if (!channel) return
    const queue = preInitQueue
    preInitQueue = []
    for (const item of queue) {
      if (item.kind === 'notify') {
        channel.send(item.payload).then(item.resolveAccepted, item.rejectPublic)
      } else {
        // Allocate the JSON-RPC id at flush time so it sits cleanly after the
        // initialize handshake's id (= 1) on this session.
        const id = allocId()
        item.pending.id = id
        pending.set(id, item.pending)
        const frame: JsonRpcRequest = {
          jsonrpc: JSONRPC_VERSION,
          id,
          method: item.method,
        }
        if (item.params !== undefined) frame.params = item.params
        channel.send(frame as unknown as Record<string, unknown>).catch((error) => {
          const existing = pending.get(id)
          if (existing) {
            pending.delete(id)
            if (existing.timeoutHandle !== null) clearTimeout(existing.timeoutHandle)
          }
          item.rejectPublic(error)
        })
      }
    }
  }

  function allocId(): JsonRpcId {
    return nextRequestId++
  }

  function ensureBootstrap(): void {
    if (bootstrapStarted) return
    bootstrapStarted = true
    void openConnection()
  }

  // Public surface ----------------------------------------------------------

  function request<Result = unknown, Params = unknown>(
    method: string,
    params?: Params,
    options?: { timeoutMs?: number },
  ): Promise<Result> {
    ensureBootstrap()
    if (closedByCaller) {
      return Promise.reject(new Error('protocol: client closed'))
    }
    const timeoutMs = options?.timeoutMs ?? defaultTimeoutMs

    return new Promise<Result>((resolve, reject) => {
      // The pending entry is shared between the immediate-send and queued
      // paths. Id is set at send time (after the handshake) so it sits cleanly
      // after `initialize`'s id on a fresh session.
      let entryId: JsonRpcId | null = null
      const timeoutHandle = setTimeout(() => {
        if (entryId !== null) {
          const entry = pending.get(entryId)
          if (entry) {
            pending.delete(entryId)
          }
        }
        reject(new Error(`timeout: ${method}`))
      }, timeoutMs)
      const entry: PendingRequest = {
        id: 0, // overwritten at send time
        method,
        resolve: (value) => resolve(value as Result),
        reject,
        timeoutHandle,
      }

      const removePendingOnFailure = (error: unknown): void => {
        if (entryId !== null) {
          const existing = pending.get(entryId)
          if (existing) {
            pending.delete(entryId)
            if (existing.timeoutHandle !== null) clearTimeout(existing.timeoutHandle)
          }
        } else if (entry.timeoutHandle !== null) {
          clearTimeout(entry.timeoutHandle)
        }
        reject(error)
      }

      if (initialized && channel) {
        const id = allocId()
        entryId = id
        entry.id = id
        pending.set(id, entry)
        const frame: JsonRpcRequest = { jsonrpc: JSONRPC_VERSION, id, method }
        if (params !== undefined) frame.params = params
        channel.send(frame as unknown as Record<string, unknown>).catch(removePendingOnFailure)
      } else {
        preInitQueue.push({
          kind: 'request',
          method,
          params,
          pending: entry,
          rejectPublic: removePendingOnFailure,
        })
      }
    })
  }

  function notify<Params = unknown>(method: string, params?: Params): Promise<void> {
    ensureBootstrap()
    if (closedByCaller) {
      return Promise.reject(new Error('protocol: client closed'))
    }
    const frame: JsonRpcNotification = {
      jsonrpc: JSONRPC_VERSION,
      method,
    }
    if (params !== undefined) frame.params = params

    if (initialized && channel) {
      return channel.send(frame as unknown as Record<string, unknown>)
    }
    return new Promise<void>((resolve, reject) => {
      preInitQueue.push({
        kind: 'notify',
        payload: frame as unknown as Record<string, unknown>,
        resolveAccepted: resolve,
        rejectPublic: reject,
      })
    })
  }

  function reconnect(reason?: unknown): void {
    if (closedByCaller) return
    // User-driven reconnect: reset the schedule index and treat as a forced
    // termination so the existing reconnect path kicks in.
    attempt = 0
    clearReconnectTimer()
    handleChannelTermination(reason ?? new Error('protocol: forced reconnect'))
  }

  async function close(reason?: unknown): Promise<void> {
    if (closedByCaller) return
    closedByCaller = true
    clearReconnectTimer()
    rejectAllPending(new Error('protocol: client closed'))
    rejectPreInitQueue(new Error('protocol: client closed'))
    failOutstandingServerRequests()
    detachChannel()
    setState({ status: 'closed' })
    void reason
  }

  function getState(): ProtocolConnectionState {
    return connectionState
  }

  // Listener registration helpers -----------------------------------------

  function onNotification(
    handler: (n: { method: string; params: unknown }) => void,
  ): () => void {
    notificationListeners.add(handler)
    return () => {
      notificationListeners.delete(handler)
    }
  }

  function onServerRequest(handler: (req: ServerInitiatedRequest) => void): () => void {
    serverRequestListeners.add(handler)
    return () => {
      serverRequestListeners.delete(handler)
    }
  }

  function onConnectionState(
    handler: (state: ProtocolConnectionState) => void,
  ): () => void {
    stateListeners.add(handler)
    // Replay current state so late subscribers don't miss the initial value.
    try {
      handler(connectionState)
    } catch (error) {
      console.warn('[codex.protocol] onConnectionState replay threw', error)
    }
    return () => {
      stateListeners.delete(handler)
    }
  }

  // Kick off the initial connection eagerly so callers don't have to issue a
  // request just to make the protocol open the channel. This matches the
  // contract used by tests (the very first `initialize` frame is observable
  // without any user-issued request).
  ensureBootstrap()

  return {
    request,
    notify,
    reconnect,
    close,
    getState,
    onNotification,
    onServerRequest,
    onConnectionState,
  }
}

function toError(err: { code?: number; message?: string; data?: unknown } | undefined): Error {
  const code = err?.code ?? -32603
  const message = err?.message ?? 'unknown error'
  const out = new Error(`jsonrpc error ${code}: ${message}`)
  ;(out as Error & { code?: number; data?: unknown }).code = code
  if (err && 'data' in err) {
    ;(out as Error & { code?: number; data?: unknown }).data = err.data
  }
  return out
}
