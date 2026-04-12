/**
 * Public entrypoints for the OpenCode wrapper.
 */
export { OpenCodeGateway, createOpencodeGateway } from './gateway.js'

/**
 * Public contract types re-exported for wrapper consumers.
 */
export type {
  EventsApi,
  OpencodeClientScope,
  OpencodeWorkspaceId,
  OpencodeWorkspaceSelector,
  OpencodeEventEnvelope,
  OpencodeGateway,
  OpencodeNetworkRequest,
  OpencodeNetworkResponse,
  OpencodeNetworkSseApi,
  OpencodeNetworkSseHandle,
  OpencodeNetworkSseOpenInput,
  OpencodeWrapperConfig,
  SessionSummary,
  SessionsApi,
} from './types.js'
