import type {
  OpencodeNetworkRequest,
  OpencodeNetworkSseHandle,
  OpencodeNetworkSseOpenInput,
} from './network/contract.js'
import type {
  NetworkBridgeMethodOptions,
  NetworkBridgeOpenSseStreamOptions,
  NetworkBridgeRequestResult,
} from './network/bridge-client.js'

/**
 * Project directory scope understood by OpenCode requests.
 */
export type OpencodeDirectory = string

/**
 * Stable identifier for an OpenCode workspace.
 */
export type OpencodeWorkspaceId = string

/**
 * Explicit workspace selector kept in the public contract so v1 can stay
 * single-workspace at runtime while preserving a future extension seam.
 */
export interface OpencodeWorkspaceSelector {
  id: OpencodeWorkspaceId
}

export interface OpencodeTransportConfig {}

/**
 * Top-level configuration for constructing the wrapper gateway.
 */
export interface OpencodeWrapperConfig {
  baseUrl: string
  auth?: string
  directory?: OpencodeDirectory
  workspace?: OpencodeWorkspaceSelector
  headers?: Record<string, string>
  transport?: OpencodeTransportConfig
}

/**
 * Per-request scope overrides applied on top of wrapper defaults.
 */
export interface OpencodeClientScope {
  directory?: OpencodeDirectory
  workspace?: OpencodeWorkspaceSelector
}

/**
 * Lightweight session list item returned by the wrapper.
 */
export interface SessionSummary {
  id: string
  title?: string
  status?: string
  updatedAt?: string
  parentID?: string
  directory?: string
  projectID?: string
  workspaceID?: string
  slug?: string
  /** Inline project info from the experimental/session endpoint. */
  project?: ProjectSummary | null
}

/**
 * Expanded session record returned when a single session is fetched or created.
 */
export interface SessionRecord extends SessionSummary {
  parentID?: string
  version?: string
  shareURL?: string
  createdAt?: string
}

/**
 * Normalized message record exposed by the wrapper.
 *
 * `providerID/modelID/agent/variant` are only populated on assistant messages —
 * the chat page uses these to infer defaults ("what did we use last time")
 * without depending on localStorage when the server already knows the answer.
 */
export interface SessionMessageRecord {
  info: {
    id: string
    sessionID: string
    role?: string
    createdAt?: string
    completedAt?: string
    providerID?: string
    modelID?: string
    agent?: string
    variant?: string
  }
  parts: unknown[]
}

/**
 * Prompt payload accepted by the wrapper's session API.
 */
export interface SessionPromptInput {
  providerID: string
  modelID: string
  parts: ReadonlyArray<Record<string, unknown>>
  messageID?: string
  agent?: string
  system?: string
  tools?: Record<string, boolean>
  /**
   * Reasoning-effort variant name (e.g. "low"/"medium"/"high"). Matches
   * opencode TUI's Ctrl+T variant_cycle field. Omit for model default.
   */
  variant?: string
}

/**
 * Lightweight description of a single model within a provider, as surfaced by
 * the catalog API. Only the fields the chat UI needs are normalized — the raw
 * provider-specific option blobs are preserved via `variants` for server-side
 * deep-merge.
 */
export interface ModelInfo {
  id: string
  name: string
  reasoning: boolean
  /**
   * Opencode surfaces reasoning-effort variants as `Record<key, optionsOverride>`.
   * We only care about the keys to populate the picker; `null` means no
   * variant metadata at all (effort picker should be disabled).
   */
  variants: Record<string, unknown> | null
}

export interface ProviderInfo {
  id: string
  name: string
  models: ModelInfo[]
}

export interface AgentInfo {
  name: string
  description?: string
  mode?: string
  model?: { providerID: string; modelID: string }
}

export interface CatalogProvidersResult {
  providers: ProviderInfo[]
  /**
   * Server-recommended default model per provider (`providerID -> modelID`).
   */
  defaults: Record<string, string>
}

/**
 * Read-only catalog API exposing providers/models/agents for pickers.
 */
export interface CatalogApi {
  providers(scope?: OpencodeClientScope): Promise<CatalogProvidersResult>
  agents(scope?: OpencodeClientScope): Promise<AgentInfo[]>
}

/**
 * Lightweight project record surfaced by the wrapper.
 */
export interface ProjectSummary {
  id: string
  worktree: string
  name?: string
  vcs?: string
}

/**
 * Read-only projects API for listing known opencode projects.
 */
export interface ProjectsApi {
  list(scope?: OpencodeClientScope): Promise<ProjectSummary[]>
}

/**
 * Normalized assistant message metadata returned after a prompt request.
 */
export interface SessionPromptResult {
  id: string
  sessionID: string
  role?: string
  createdAt?: string
  completedAt?: string
}

/**
 * Stable session-oriented API surface used by application code.
 */
export interface SessionsApi {
  list(scope?: OpencodeClientScope): Promise<SessionSummary[]>
  create(scope?: OpencodeClientScope): Promise<SessionRecord>
  get(sessionID: string, scope?: OpencodeClientScope): Promise<SessionRecord>
  messages(sessionID: string, scope?: OpencodeClientScope): Promise<SessionMessageRecord[]>
  prompt(sessionID: string, payload: SessionPromptInput, scope?: OpencodeClientScope): Promise<SessionPromptResult>
}

/**
 * Generic event envelope returned by the OpenCode SSE stream.
 */
export interface OpencodeEventEnvelope<T = unknown> {
  type: string
  properties: T
}

/**
 * Minimal events API surface required by the wrapper contract.
 */
export interface EventsApi {
  streamURL(scope?: OpencodeClientScope): string
}

export interface OpencodeGatewayNetworkApi {
  request<TBody = unknown>(
    input: OpencodeNetworkRequest,
    options?: NetworkBridgeMethodOptions,
  ): Promise<NetworkBridgeRequestResult<TBody>>
  sse: {
    open(
      input: OpencodeNetworkSseOpenInput,
      options?: NetworkBridgeOpenSseStreamOptions,
    ): Promise<OpencodeNetworkSseHandle>
    close(handle: OpencodeNetworkSseHandle, options?: NetworkBridgeMethodOptions): Promise<void>
  }
}

export interface OpencodeGatewayNamespaceApi {
  readonly network: OpencodeGatewayNetworkApi
}

/**
 * Minimal gateway shape shared across wrapper entrypoints.
 */
export interface OpencodeGateway {
  readonly config: Readonly<OpencodeWrapperConfig>
  readonly sessions: SessionsApi
  readonly events: EventsApi
  readonly opencode: OpencodeGatewayNamespaceApi
  readonly catalog: CatalogApi
  readonly projects: ProjectsApi
}

export type {
  OpencodeNetworkRequest,
  OpencodeNetworkResponse,
  OpencodeNetworkSseApi,
  OpencodeNetworkSseHandle,
  OpencodeNetworkSseOpenInput,
} from './network/contract.js'
