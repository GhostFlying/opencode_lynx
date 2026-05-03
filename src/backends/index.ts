export type {
  BackendAgentInfo,
  BackendApprovalDecision,
  BackendApprovalsApi,
  BackendCapabilities,
  BackendCatalogApi,
  BackendClient,
  BackendConnectionSnapshot,
  BackendConnectionState,
  BackendDescriptor,
  BackendEvent,
  BackendEventType,
  BackendEventsApi,
  BackendKind,
  BackendMessage,
  BackendMessagePart,
  BackendMessageRole,
  BackendModelInfo,
  BackendModelRef,
  BackendPromptInput,
  BackendPromptResult,
  BackendProviderCatalog,
  BackendProviderInfo,
  BackendScope,
  BackendSessionRecord,
  BackendSessionSummary,
  BackendSessionsApi,
  BackendSubscribeOptions,
  BackendSubscription,
  BackendTarget,
  ClaudeBackendTarget,
  CodexBackendTarget,
  OpencodeBackendTarget,
} from './types.js'
export { BackendFacadeError } from './errors.js'
export type { BackendFacadeErrorCode } from './errors.js'
export { createBackendFacade } from './facade.js'
export type { CreateBackendFacadeOptions } from './facade.js'
export { createOpenCodeBackendAdapter } from './opencode/adapter.js'
export { createCodexBackendAdapter } from './codex/adapter.js'
export type { CodexBackendConfig } from './codex/adapter.js'
export {
  connectOpencodeBackendClient,
  createOpencodeBackendClient,
  createOpencodeBackendClientFromConnection,
  createOpencodeBackendConfigFromConnection,
  createOpencodeBackendTarget,
  formatOpencodeBackendServerLabel,
  normalizeOpencodeBackendConnection,
  validateOpencodeBackendConnection,
} from './opencode/page-migration.js'
export {
  connectCodexBackendClient,
  createCodexBackendClient,
  createCodexBackendClientFromConnection,
  createCodexBackendConfigFromConnection,
  createCodexBackendTarget,
  formatCodexBackendServerLabel,
  normalizeCodexBackendConnection,
  validateCodexBackendConnection,
} from './codex/page-migration.js'
export { createBackendRegistry } from './registry.js'
export type {
  BackendRegistry,
  CreateBackendRegistryOptions,
} from './registry.js'
export type {
  ConnectOpencodeBackendClientResult,
  OpencodeBackendConnection,
  OpencodeBackendConnectionInput,
} from './opencode/page-migration.js'
export type {
  CodexBackendConnection,
  CodexBackendConnectionInput,
  ConnectCodexBackendClientResult,
} from './codex/page-migration.js'
export {
  findBackendModel,
  findBackendProvider,
  getBackendModelReasoningEffortKeys,
  inferSelectionFromBackendMessages,
  selectionFromBackendMessage,
} from './ui-mappers.js'
export type { BackendChatSelection } from './ui-mappers.js'
