// Codex BackendClient adapter. Bridges the unified `BackendClient` surface
// (consumed by the facade + chat UI) to the Codex JSON-RPC `protocol.ts`
// transport and the per-session `mapper.ts`.
//
// Behavior contract: see `.codex-rollout/handoffs/M2.4.md`. Tests in
// `src/backends/codex/__tests__/adapter.test.ts` cover the shape and
// every branching path described below.
//
// Lifetime: a single protocol client is opened lazily on the first call
// (sessions or events.subscribe) and reused. Multiple `events.subscribe`
// calls share the protocol; each gets its own onEvent / state listeners
// and detaches independently. Approval correlation lives on the adapter
// (one map shared by all subscribers, since approvals are scoped to the
// channel, not the subscription).

import { openBackendChannel } from './channel.js'
import type { BackendChannel, OpenBackendChannelOptions } from './channel.js'
import {
  createCodexProtocolClient,
} from './protocol.js'
import type {
  CodexProtocolClient,
  CreateCodexProtocolOptions,
  ProtocolConnectionState,
  ServerInitiatedRequest,
} from './protocol.js'
import { createCodexMapper } from './mapper.js'
import type { CodexMapper } from './mapper.js'
import { BackendFacadeError } from '../errors.js'
import type {
  BackendAgentInfo,
  BackendApprovalDecision,
  BackendCapabilities,
  BackendClient,
  BackendConnectionSnapshot,
  BackendDescriptor,
  BackendEvent,
  BackendMessage,
  BackendMessageRole,
  BackendPromptInput,
  BackendPromptResult,
  BackendProviderCatalog,
  BackendProviderInfo,
  BackendScope,
  BackendSessionRecord,
  BackendSessionSummary,
  BackendSubscribeOptions,
  BackendSubscription,
} from '../types.js'

export interface CodexBackendConfig {
  /** ws:// or wss:// URL of the Codex app-server. */
  url: string
  headers?: Record<string, string>
  pingIntervalMs?: number
  /** Default scope.directory for thread/start when not provided. */
  defaultCwd?: string
  /** Client-side info passed in initialize. */
  clientInfo?: { name: string; version: string }
}

export interface CreateCodexBackendAdapterOptions {
  /** Inject for tests. */
  createProtocolClient?: (opts: CreateCodexProtocolOptions) => CodexProtocolClient
  createMapper?: () => CodexMapper
  /** Inject openChannel into the protocol client (forwarded). */
  openChannel?: (opts: OpenBackendChannelOptions) => Promise<BackendChannel>
  /** ISO time generator (tests). */
  now?: () => string
}

const CODEX_DESCRIPTOR: BackendDescriptor = {
  kind: 'codex',
  label: 'Codex',
}

const CODEX_CAPABILITIES: BackendCapabilities = {
  sessions: true,
  streaming: true,
  catalog: true,
  approvals: true,
  pty: false,
  remoteDiscovery: false,
  agentPicker: false,
  modelPicker: true,
}

const DEFAULT_CLIENT_INFO = {
  name: 'opencode-lynx',
  version: '0.0.0',
}

// JSON-RPC error code emitted by the mock + by Codex itself when a thread
// has not yet been materialized — adapter retries thread/read with
// includeTurns=false on this code.
const ERR_NOT_MATERIALIZED = -32001

interface PendingApprovalEntry {
  req: ServerInitiatedRequest
  kind: 'commandExecution' | 'fileChange'
}

interface InternalSubscription {
  onEvent?: (event: BackendEvent) => void
  onConnectionStateChange?: (state: BackendConnectionSnapshot) => void
  onError?: (error: unknown) => void
  /** Detachers for protocol listeners attached on first start(). */
  detachers: Array<() => void>
  /** Tracks abort-signal detachers so multiple attaches stack cleanly. */
  abortDetachers: Set<() => void>
  /** Latest snapshot pushed up — getState() reflects this when set. */
  lastSnapshot: BackendConnectionSnapshot
  started: boolean
  stopped: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toBackendMessageRole(role: string | undefined): BackendMessageRole {
  if (role === 'user' || role === 'assistant' || role === 'system' || role === 'tool') {
    return role
  }
  return 'system'
}

function toIsoFromUnixSeconds(seconds: unknown): string | undefined {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return undefined
  return new Date(seconds * 1000).toISOString()
}

function toBackendConnectionSnapshot(
  state: ProtocolConnectionState,
): BackendConnectionSnapshot {
  switch (state.status) {
    case 'connecting':
      return { status: 'connecting', retryAttempt: 0, nextRetryInMs: null, reason: null }
    case 'open':
      return { status: 'open', retryAttempt: 0, nextRetryInMs: null, reason: null }
    case 'reconnecting':
      return {
        status: 'reconnecting',
        retryAttempt: state.attempt,
        nextRetryInMs: null,
        reason: state.reason,
      }
    case 'failed':
      return { status: 'failed', retryAttempt: 0, nextRetryInMs: null, reason: state.reason }
    case 'closed':
      return { status: 'stopped', retryAttempt: 0, nextRetryInMs: null, reason: null }
    default: {
      // Defensive: future states default to idle so the UI keeps working.
      return { status: 'idle', retryAttempt: 0, nextRetryInMs: null, reason: null }
    }
  }
}

interface ThreadShape {
  id?: unknown
  name?: unknown
  preview?: unknown
  status?: unknown
  updatedAt?: unknown
  createdAt?: unknown
  cwd?: unknown
  modelProvider?: unknown
  source?: unknown
  ephemeral?: unknown
}

function toSessionSummary(thread: ThreadShape): BackendSessionSummary {
  const id = typeof thread.id === 'string' ? thread.id : ''
  const titleSource =
    typeof thread.name === 'string' && thread.name.length > 0
      ? thread.name
      : typeof thread.preview === 'string'
        ? thread.preview
        : undefined
  const status = thread.status !== undefined ? String(thread.status) : undefined
  const updatedAt = toIsoFromUnixSeconds(thread.updatedAt)
  const directory = typeof thread.cwd === 'string' ? thread.cwd : undefined

  const summary: BackendSessionSummary = {
    backend: 'codex',
    id,
    ...(titleSource !== undefined ? { title: titleSource } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(directory !== undefined ? { directory } : {}),
    backendMeta: {
      ...(thread.modelProvider !== undefined ? { modelProvider: thread.modelProvider } : {}),
      ...(thread.source !== undefined ? { source: thread.source } : {}),
      ...(thread.ephemeral !== undefined ? { ephemeral: thread.ephemeral } : {}),
    },
  }
  return summary
}

function toSessionRecord(thread: ThreadShape): BackendSessionRecord {
  const summary = toSessionSummary(thread)
  const createdAt = toIsoFromUnixSeconds(thread.createdAt)
  return {
    ...summary,
    ...(createdAt !== undefined ? { createdAt } : {}),
  }
}

interface TurnShape {
  id?: unknown
  startedAt?: unknown
  items?: unknown
}

interface ItemShape {
  type?: unknown
  id?: unknown
  text?: unknown
  content?: unknown
  command?: unknown
  cwd?: unknown
  status?: unknown
  changes?: unknown
  exitCode?: unknown
  durationMs?: unknown
  aggregatedOutput?: unknown
}

function joinUserInputText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const entry of content) {
    if (isRecord(entry) && entry.type === 'text' && typeof entry.text === 'string') {
      parts.push(entry.text)
    }
  }
  return parts.join('')
}

function toBackendMessages(threadId: string, turns: TurnShape[]): BackendMessage[] {
  const out: BackendMessage[] = []
  for (const turn of turns) {
    const turnId = typeof turn.id === 'string' ? turn.id : ''
    const createdAt = toIsoFromUnixSeconds(turn.startedAt)
    const items = Array.isArray(turn.items) ? (turn.items as ItemShape[]) : []
    for (const item of items) {
      const itemId = typeof item.id === 'string' ? item.id : ''
      const id = `${turnId}:${itemId}`
      const itemType = typeof item.type === 'string' ? item.type : ''

      let role: BackendMessageRole
      let parts: ReadonlyArray<Record<string, unknown>>
      if (itemType === 'userMessage') {
        role = 'user'
        parts = [{ type: 'text', text: joinUserInputText(item.content) }]
      } else if (itemType === 'agentMessage') {
        role = 'assistant'
        parts = [
          {
            type: 'text',
            text: typeof item.text === 'string' ? item.text : '',
            partID: itemId,
          },
        ]
      } else if (itemType === 'commandExecution' || itemType === 'fileChange') {
        role = 'tool'
        const toolPart: Record<string, unknown> = {
          type: 'tool',
          kind: itemType,
        }
        if (item.command !== undefined) toolPart.command = item.command
        if (item.cwd !== undefined) toolPart.cwd = item.cwd
        if (item.status !== undefined) toolPart.status = item.status
        if (item.changes !== undefined) toolPart.changes = item.changes
        if (item.exitCode !== undefined) toolPart.exitCode = item.exitCode
        if (item.durationMs !== undefined) toolPart.durationMs = item.durationMs
        if (item.aggregatedOutput !== undefined) toolPart.aggregatedOutput = item.aggregatedOutput
        parts = [toolPart]
      } else {
        // Reasoning, plan, MCP tool calls, dynamic tool calls, web search,
        // image view/generation, review-mode toggles, context compaction,
        // hook prompts, collab agent calls — pass through as raw v1.
        role = 'system'
        parts = [{ type: 'raw', item }]
      }

      const message: BackendMessage = {
        id,
        sessionID: threadId,
        role,
        parts,
        ...(createdAt !== undefined ? { createdAt } : {}),
      }
      out.push(message)
    }
  }
  return out
}

interface ModelShape {
  id?: unknown
  displayName?: unknown
  description?: unknown
  hidden?: unknown
  isDefault?: unknown
  defaultReasoningEffort?: unknown
  supportedReasoningEfforts?: unknown
}

function reasoningEffortLabel(option: unknown): string {
  if (typeof option === 'string') return option
  if (isRecord(option)) {
    if (typeof option.kind === 'string') return option.kind
  }
  return String(option)
}

function toProviderCatalog(models: ModelShape[]): BackendProviderCatalog {
  const providerInfo: BackendProviderInfo = {
    id: 'codex',
    name: 'Codex',
    models: models.map(model => {
      const reasoningEfforts = Array.isArray(model.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts.map(reasoningEffortLabel)
        : []
      const id = typeof model.id === 'string' ? model.id : ''
      const name = typeof model.displayName === 'string' ? model.displayName : id
      return {
        id,
        name,
        reasoning: reasoningEfforts.length > 0,
        reasoningEfforts,
        backendMeta: {
          ...(model.description !== undefined ? { description: model.description } : {}),
          ...(model.defaultReasoningEffort !== undefined
            ? { defaultReasoningEffort: model.defaultReasoningEffort }
            : {}),
          ...(model.hidden !== undefined ? { hidden: model.hidden } : {}),
          ...(model.isDefault !== undefined ? { isDefault: model.isDefault } : {}),
        },
      }
    }),
  }
  const defaultModel = models.find(m => m.isDefault === true) ?? models[0]
  const defaultId = defaultModel && typeof defaultModel.id === 'string' ? defaultModel.id : ''
  return {
    providers: [providerInfo],
    defaults: defaultId.length > 0 ? { codex: defaultId } : {},
  }
}

interface UserInputText {
  type: 'text'
  text: string
  text_elements: unknown[]
}

function translatePromptParts(parts: ReadonlyArray<Record<string, unknown>>): UserInputText[] {
  const out: UserInputText[] = []
  for (const part of parts) {
    if (!isRecord(part)) continue
    if (part.type === 'text' && typeof part.text === 'string') {
      out.push({ type: 'text', text: part.text, text_elements: [] })
      continue
    }
    if (typeof part.text === 'string') {
      out.push({ type: 'text', text: part.text, text_elements: [] })
      continue
    }
    console.warn('[codex.adapter] dropping non-text prompt part', part)
  }
  return out
}

function isJsonRpcErrorWithCode(error: unknown, code: number): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = (error as { code?: unknown }).code
  return candidate === code
}

export function createCodexBackendAdapter(
  config: CodexBackendConfig,
  options: CreateCodexBackendAdapterOptions = {},
): BackendClient {
  const createProtocolClient =
    options.createProtocolClient ?? createCodexProtocolClient
  const createMapper = options.createMapper ?? createCodexMapper
  const openChannel = options.openChannel ?? openBackendChannel

  const mapper = createMapper()

  // Approval correlation is shared across all subscriptions of this adapter.
  const pendingApprovals = new Map<string, PendingApprovalEntry>()

  // All active subscriptions; protocol fan-out is handled via this set so a
  // single notification or server request reaches every subscriber.
  const subscriptions = new Set<InternalSubscription>()

  // Lazily-created singleton protocol client.
  let protocol: CodexProtocolClient | null = null
  let protocolListenersAttached = false
  let unsubProtoNotification: (() => void) | null = null
  let unsubProtoServerRequest: (() => void) | null = null
  let unsubProtoState: (() => void) | null = null

  function ensureProtocol(): CodexProtocolClient {
    if (protocol) return protocol
    const protoOpts: CreateCodexProtocolOptions = {
      url: config.url,
      clientInfo: config.clientInfo ?? DEFAULT_CLIENT_INFO,
      openChannel,
    }
    if (config.headers !== undefined) protoOpts.headers = config.headers
    if (config.pingIntervalMs !== undefined) protoOpts.pingIntervalMs = config.pingIntervalMs
    protocol = createProtocolClient(protoOpts)
    attachProtocolListeners(protocol)
    return protocol
  }

  function attachProtocolListeners(client: CodexProtocolClient): void {
    if (protocolListenersAttached) return
    protocolListenersAttached = true

    unsubProtoNotification = client.onNotification(({ method, params }) => {
      const events = mapper.mapNotification(method, params)
      if (events.length === 0) return
      for (const sub of [...subscriptions]) {
        if (!sub.started || sub.stopped) continue
        if (!sub.onEvent) continue
        for (const event of events) {
          try {
            sub.onEvent(event)
          } catch (error) {
            console.warn('[codex.adapter] subscriber onEvent threw', error)
          }
        }
      }
    })

    unsubProtoServerRequest = client.onServerRequest(req => {
      const event = mapper.mapServerRequest(req)
      if (!event) {
        // Auto-decline anything we don't understand so the server isn't
        // left waiting forever. The adapter never holds a correlation for
        // these — the call is fire-and-forget.
        req.respondError(-32601, 'unsupported approval method').catch(() => {
          // Best effort; channel may already be gone.
        })
        return
      }
      const approvalID = event.approvalID
      if (typeof approvalID === 'string' && approvalID.length > 0) {
        let kind: 'commandExecution' | 'fileChange'
        if (req.method === 'item/fileChange/requestApproval') {
          kind = 'fileChange'
        } else {
          // Default branch handles item/commandExecution/requestApproval and
          // leaves the door open for future exec-style approvals to inherit
          // the command-execution wire shape.
          kind = 'commandExecution'
        }
        pendingApprovals.set(approvalID, { req, kind })
      }
      for (const sub of [...subscriptions]) {
        if (!sub.started || sub.stopped) continue
        if (!sub.onEvent) continue
        try {
          sub.onEvent(event)
        } catch (error) {
          console.warn('[codex.adapter] subscriber onEvent threw', error)
        }
      }
    })

    unsubProtoState = client.onConnectionState(state => {
      const snapshot = toBackendConnectionSnapshot(state)
      for (const sub of [...subscriptions]) {
        sub.lastSnapshot = snapshot
        if (!sub.started || sub.stopped) continue
        if (!sub.onConnectionStateChange) continue
        try {
          sub.onConnectionStateChange(snapshot)
        } catch (error) {
          console.warn('[codex.adapter] subscriber onConnectionStateChange threw', error)
        }
      }
    })
  }

  function detachProtocolListeners(): void {
    if (!protocolListenersAttached) return
    protocolListenersAttached = false
    if (unsubProtoNotification) {
      try {
        unsubProtoNotification()
      } catch {
        // ignore
      }
      unsubProtoNotification = null
    }
    if (unsubProtoServerRequest) {
      try {
        unsubProtoServerRequest()
      } catch {
        // ignore
      }
      unsubProtoServerRequest = null
    }
    if (unsubProtoState) {
      try {
        unsubProtoState()
      } catch {
        // ignore
      }
      unsubProtoState = null
    }
  }

  function fanoutEvent(event: BackendEvent): void {
    for (const sub of [...subscriptions]) {
      if (!sub.started || sub.stopped) continue
      if (!sub.onEvent) continue
      try {
        sub.onEvent(event)
      } catch (error) {
        console.warn('[codex.adapter] subscriber onEvent threw', error)
      }
    }
  }

  function buildScope(scope?: BackendScope): { directory: string | undefined } {
    return {
      directory:
        typeof scope?.directory === 'string' && scope.directory.length > 0
          ? scope.directory
          : config.defaultCwd,
    }
  }

  // -------------------------------------------------------------------------
  // Public BackendClient surface

  const sessionsApi = {
    async list(_scope?: BackendScope): Promise<BackendSessionSummary[]> {
      void _scope
      const client = ensureProtocol()
      const response = await client.request<{ data: ThreadShape[] }>('thread/list', {})
      const data = Array.isArray(response?.data) ? response.data : []
      return data.map(toSessionSummary)
    },

    async create(scope?: BackendScope): Promise<BackendSessionRecord> {
      const client = ensureProtocol()
      const { directory } = buildScope(scope)
      const params: Record<string, unknown> = {
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      }
      if (directory !== undefined) params.cwd = directory
      const response = await client.request<{ thread: ThreadShape }>(
        'thread/start',
        params,
      )
      const thread = response?.thread ?? {}
      if (typeof thread.id === 'string') {
        mapper.setActiveThread(thread.id)
      }
      return toSessionRecord(thread)
    },

    async get(sessionID: string, _scope?: BackendScope): Promise<BackendSessionRecord> {
      void _scope
      const client = ensureProtocol()
      try {
        const response = await client.request<{ thread: ThreadShape }>('thread/read', {
          threadId: sessionID,
          includeTurns: true,
        })
        return toSessionRecord(response?.thread ?? {})
      } catch (error) {
        if (!isJsonRpcErrorWithCode(error, ERR_NOT_MATERIALIZED)) {
          throw error
        }
        // Retry once without turns; surface the second failure if it also fails.
        const response = await client.request<{ thread: ThreadShape }>('thread/read', {
          threadId: sessionID,
          includeTurns: false,
        })
        return toSessionRecord(response?.thread ?? {})
      }
    },

    async messages(sessionID: string, _scope?: BackendScope): Promise<BackendMessage[]> {
      void _scope
      const client = ensureProtocol()
      const response = await client.request<{ data: TurnShape[] }>('thread/turns/list', {
        threadId: sessionID,
      })
      const turns = Array.isArray(response?.data) ? response.data : []
      return toBackendMessages(sessionID, turns)
    },

    async prompt(
      sessionID: string,
      input: BackendPromptInput,
      _scope?: BackendScope,
    ): Promise<BackendPromptResult> {
      void _scope
      if (!Array.isArray(input.parts) || input.parts.length === 0) {
        throw new BackendFacadeError(
          'Codex backend prompt input requires at least one part.',
          'invalid_backend_input',
        )
      }
      const userInputs = translatePromptParts(input.parts)
      if (userInputs.length === 0) {
        throw new BackendFacadeError(
          'Codex backend prompt input requires at least one text part.',
          'invalid_backend_input',
        )
      }
      const client = ensureProtocol()
      const params: Record<string, unknown> = {
        threadId: sessionID,
        input: userInputs,
      }
      if (input.model?.modelID && input.model.modelID.length > 0) {
        params.model = input.model.modelID
      }
      if (typeof input.reasoningEffort === 'string' && input.reasoningEffort.length > 0) {
        params.effort = input.reasoningEffort
      }
      const response = await client.request<{ turn: TurnShape }>('turn/start', params)
      const turn = response?.turn
      const turnId = isRecord(turn) && typeof turn.id === 'string' ? turn.id : undefined
      return {
        sessionID,
        ...(turnId !== undefined ? { messageID: turnId } : {}),
      }
    },
  }

  const eventsApi = {
    subscribe(opts: BackendSubscribeOptions = {}): BackendSubscription {
      const internal: InternalSubscription = {
        ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
        ...(opts.onConnectionStateChange
          ? { onConnectionStateChange: opts.onConnectionStateChange }
          : {}),
        ...(opts.onError ? { onError: opts.onError } : {}),
        detachers: [],
        abortDetachers: new Set(),
        lastSnapshot: { status: 'idle', retryAttempt: 0, nextRetryInMs: null, reason: null },
        started: false,
        stopped: false,
      }
      subscriptions.add(internal)

      const start = (): void => {
        if (internal.stopped) return
        if (internal.started) return
        internal.started = true
        // Lazily create + attach the protocol client. The act of opening
        // also forces the initialize handshake to begin.
        const client = ensureProtocol()
        internal.lastSnapshot = toBackendConnectionSnapshot(client.getState())
        // Replay current state so the new subscriber sees the first
        // status without waiting for a transition.
        if (internal.onConnectionStateChange) {
          try {
            internal.onConnectionStateChange(internal.lastSnapshot)
          } catch (error) {
            console.warn('[codex.adapter] subscriber onConnectionStateChange replay threw', error)
          }
        }
      }

      const stop = (_reason?: unknown): void => {
        if (internal.stopped) return
        internal.stopped = true
        for (const detach of [...internal.abortDetachers]) {
          try {
            detach()
          } catch {
            // ignore
          }
        }
        internal.abortDetachers.clear()
        subscriptions.delete(internal)
        // If this was the last subscription, tear the protocol down so the
        // channel doesn't dangle. Sessions API will reopen on next call.
        if (subscriptions.size === 0 && protocol) {
          const client = protocol
          protocol = null
          detachProtocolListeners()
          client.close().catch(() => {
            // ignore close errors
          })
        }
        void _reason
      }

      const reconnect = (reason?: unknown): void => {
        if (internal.stopped) return
        const client = ensureProtocol()
        client.reconnect(reason)
      }

      const getState = (): BackendConnectionSnapshot => internal.lastSnapshot

      const attachAbortSignal = (signal: AbortSignal): (() => void) => {
        const onAbort = (): void => {
          stop(signal.reason)
        }
        if (signal.aborted) {
          onAbort()
          return () => {
            // already torn down
          }
        }
        signal.addEventListener('abort', onAbort, { once: true })
        const detach = (): void => {
          signal.removeEventListener('abort', onAbort)
          internal.abortDetachers.delete(detach)
        }
        internal.abortDetachers.add(detach)
        return detach
      }

      // Honor abortSignal up-front (if already aborted, stop immediately).
      if (opts.abortSignal) {
        attachAbortSignal(opts.abortSignal)
      }

      // autoStart defaults to true to match OpenCode adapter semantics.
      if (opts.autoStart !== false) {
        start()
      }

      return {
        start,
        stop,
        reconnect,
        getState,
        attachAbortSignal,
      }
    },
  }

  const catalogApi = {
    async providers(_scope?: BackendScope): Promise<BackendProviderCatalog> {
      void _scope
      const client = ensureProtocol()
      const collected: ModelShape[] = []
      let cursor: string | null = null
      // Defensive cap so a buggy server doesn't spin us forever.
      const SAFETY_CAP = 64
      for (let i = 0; i < SAFETY_CAP; i += 1) {
        const params: Record<string, unknown> = {}
        if (cursor !== null) params.cursor = cursor
        const response = await client.request<{
          data: ModelShape[]
          nextCursor: string | null
        }>('model/list', params)
        const page = Array.isArray(response?.data) ? response.data : []
        collected.push(...page)
        const next = response?.nextCursor
        if (next === null || next === undefined) break
        cursor = next
      }
      return toProviderCatalog(collected)
    },

    async agents(_scope?: BackendScope): Promise<BackendAgentInfo[]> {
      void _scope
      return []
    },
  }

  const approvalsApi = {
    async respond(
      approvalID: string,
      decision: BackendApprovalDecision,
    ): Promise<void> {
      const entry = pendingApprovals.get(approvalID)
      if (!entry) {
        throw new BackendFacadeError(
          `Codex approval ${approvalID} not found`,
          'invalid_backend_input',
        )
      }
      let wireResponse: { decision: unknown }
      if (entry.kind === 'commandExecution') {
        wireResponse = { decision: translateCommandExecutionDecision(decision) }
      } else {
        wireResponse = { decision: translateFileChangeDecision(decision) }
      }
      try {
        await entry.req.respond(wireResponse)
      } finally {
        pendingApprovals.delete(approvalID)
      }
      const resolved = mapper.emitApprovalResolved(approvalID, decision)
      fanoutEvent(resolved)
    },
  }

  return {
    descriptor: CODEX_DESCRIPTOR,
    capabilities: CODEX_CAPABILITIES,
    sessions: sessionsApi,
    events: eventsApi,
    catalog: catalogApi,
    approvals: approvalsApi,
  }
}

function translateCommandExecutionDecision(decision: BackendApprovalDecision): unknown {
  switch (decision.kind) {
    case 'accept':
    case 'acceptForSession':
    case 'decline':
    case 'cancel':
      return decision.kind
    case 'acceptWithExecpolicyAmendment': {
      const amendment = decision.payload?.execpolicy_amendment
      if (amendment === undefined) {
        throw new BackendFacadeError(
          'acceptWithExecpolicyAmendment requires payload.execpolicy_amendment',
          'invalid_backend_input',
        )
      }
      return {
        acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment },
      }
    }
    case 'applyNetworkPolicyAmendment': {
      const amendment = decision.payload?.network_policy_amendment
      if (amendment === undefined) {
        throw new BackendFacadeError(
          'applyNetworkPolicyAmendment requires payload.network_policy_amendment',
          'invalid_backend_input',
        )
      }
      return {
        applyNetworkPolicyAmendment: { network_policy_amendment: amendment },
      }
    }
    default:
      throw new BackendFacadeError(
        `unsupported commandExecution approval decision kind: ${decision.kind}`,
        'invalid_backend_input',
      )
  }
}

function translateFileChangeDecision(decision: BackendApprovalDecision): unknown {
  switch (decision.kind) {
    case 'accept':
    case 'acceptForSession':
    case 'decline':
    case 'cancel':
      return decision.kind
    default:
      throw new BackendFacadeError(
        `unsupported fileChange approval decision kind: ${decision.kind}`,
        'invalid_backend_input',
      )
  }
}
