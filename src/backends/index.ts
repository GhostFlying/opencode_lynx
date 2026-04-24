export type {
  BackendAgentInfo,
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
