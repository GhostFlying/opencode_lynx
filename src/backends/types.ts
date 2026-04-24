import type { OpencodeWrapperConfig } from '../opencode/types.js'

export type BackendKind = 'opencode' | 'codex' | 'claude'

export interface BackendDescriptor {
  kind: BackendKind
  label: string
}

/**
 * Capabilities surfaced to higher layers so UI code can branch on behavior
 * instead of hard-coding provider names.
 */
export interface BackendCapabilities {
  sessions: boolean
  streaming: boolean
  catalog: boolean
  approvals: boolean
  pty: boolean
  remoteDiscovery: boolean
  agentPicker: boolean
  modelPicker: boolean
}

/**
 * Thin request scope passed from future facade/UI layers into providers.
 */
export interface BackendScope {
  directory?: string
  workspaceID?: string
}

export interface BackendModelRef {
  providerID?: string
  modelID: string
}

export interface BackendPromptInput {
  parts: ReadonlyArray<Record<string, unknown>>
  model?: BackendModelRef
  agent?: string
  reasoningEffort?: string
  tools?: Record<string, boolean>
}

export interface BackendPromptResult {
  sessionID: string
  messageID?: string
  backendMeta?: Record<string, unknown>
}

export type BackendMessageRole = 'user' | 'assistant' | 'system' | 'tool'

/**
 * Message parts stay intentionally thin in phase 1. Adapters may preserve
 * provider-native payloads here until real cross-provider rendering needs
 * force a deeper normalization layer.
 */
export type BackendMessagePart = Record<string, unknown>

export interface BackendMessage {
  id: string
  sessionID: string
  role: BackendMessageRole
  createdAt?: string
  completedAt?: string
  parts: ReadonlyArray<BackendMessagePart>
  backendMeta?: Record<string, unknown>
}

export interface BackendSessionSummary {
  backend: BackendKind
  id: string
  title?: string
  status?: string
  updatedAt?: string
  directory?: string
  projectLabel?: string
  backendMeta?: Record<string, unknown>
}

export interface BackendSessionRecord extends BackendSessionSummary {
  createdAt?: string
  parentID?: string
  shareURL?: string
}

export interface BackendModelInfo {
  id: string
  name: string
  reasoning: boolean
  reasoningEfforts: ReadonlyArray<string>
  backendMeta?: Record<string, unknown>
}

export interface BackendProviderInfo {
  id: string
  name: string
  models: ReadonlyArray<BackendModelInfo>
}

export interface BackendProviderCatalog {
  providers: ReadonlyArray<BackendProviderInfo>
  defaults: Readonly<Record<string, string>>
}

export interface BackendAgentInfo {
  id: string
  name: string
  description?: string
  backendMeta?: Record<string, unknown>
}

export type BackendConnectionState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'stopped'
  | 'failed'

export interface BackendConnectionSnapshot {
  status: BackendConnectionState
  retryAttempt: number
  nextRetryInMs: number | null
  reason: unknown
}

export type BackendEventType =
  | 'session.updated'
  | 'message.delta'
  | 'message.updated'
  | 'connection.state'
  | 'resync.required'
  | 'raw'

export interface BackendEvent {
  backend: BackendKind
  type: BackendEventType
  payload: Record<string, unknown>
  raw: unknown
  sourceType?: string
  sessionID?: string
  messageID?: string
  partID?: string
  status?: string
}

export interface BackendSubscribeOptions {
  scope?: BackendScope
  autoStart?: boolean
  onEvent?: (event: BackendEvent) => void
  onConnectionStateChange?: (state: BackendConnectionSnapshot) => void
  onError?: (error: unknown) => void
  abortSignal?: AbortSignal
}

export interface BackendSubscription {
  start(): void
  stop(reason?: unknown): void
  reconnect(reason?: unknown): void
  getState(): BackendConnectionSnapshot
  attachAbortSignal(signal: AbortSignal): () => void
}

export interface BackendSessionsApi {
  list(scope?: BackendScope): Promise<BackendSessionSummary[]>
  create(scope?: BackendScope): Promise<BackendSessionRecord>
  get(sessionID: string, scope?: BackendScope): Promise<BackendSessionRecord>
  messages(sessionID: string, scope?: BackendScope): Promise<BackendMessage[]>
  prompt(
    sessionID: string,
    input: BackendPromptInput,
    scope?: BackendScope,
  ): Promise<BackendPromptResult>
}

export interface BackendEventsApi {
  subscribe(options?: BackendSubscribeOptions): BackendSubscription
}

export interface BackendCatalogApi {
  providers(scope?: BackendScope): Promise<BackendProviderCatalog>
  agents(scope?: BackendScope): Promise<BackendAgentInfo[]>
}

export interface BackendClient {
  readonly descriptor: BackendDescriptor
  readonly capabilities: BackendCapabilities
  readonly sessions: BackendSessionsApi
  readonly events: BackendEventsApi
  readonly catalog?: BackendCatalogApi
}

export interface OpencodeBackendTarget {
  kind: 'opencode'
  config: OpencodeWrapperConfig
}

export interface CodexBackendTarget {
  kind: 'codex'
  config: unknown
}

export interface ClaudeBackendTarget {
  kind: 'claude'
  config: unknown
}

export type BackendTarget =
  | OpencodeBackendTarget
  | CodexBackendTarget
  | ClaudeBackendTarget
