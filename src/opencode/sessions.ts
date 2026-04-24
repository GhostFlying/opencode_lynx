import { OpencodeWrapperError, isRecord } from './errors.js'
import { unwrapSdkEnvelopeData } from './client.js'
import type { SdkResponseEnvelope, WrappedSdkClient } from './client.js'
import type {
  OpencodeWrapperConfig,
  SessionMessageRecord,
  SessionPromptInput,
  SessionPromptResult,
  SessionRecord,
  SessionSummary,
  SessionsApi,
} from './types.js'

interface SdkSession {
  id?: string
  title?: string
  status?: string
  parentID?: string
  directory?: string
  version?: string
  share?: { url?: string }
  time?: { created?: number; updated?: number }
  projectID?: string
  workspaceID?: string
  slug?: string
  /** Present only on GlobalSession from experimental/session endpoint. */
  project?: { id?: string; worktree?: string; name?: string; vcs?: string } | null
}

interface SdkMessageInfo {
  id?: string
  sessionID?: string
  role?: string
  time?: { created?: number; completed?: number }
  providerID?: string
  modelID?: string
  agent?: string
  variant?: string
}

interface SdkMessage {
  info?: SdkMessageInfo
  parts?: unknown[]
}

interface SdkAssistantMessage {
  id?: string
  sessionID?: string
  role?: string
  time?: { created?: number; completed?: number }
}

function unwrapSessionEnvelope<TData>(response: unknown): TData | undefined {
  return unwrapSdkEnvelopeData<TData>(response)
}

export interface SessionsRepository extends SessionsApi {
  list: SessionsApi['list']
  create: SessionsApi['create']
  get: SessionsApi['get']
  messages: SessionsApi['messages']
  prompt: SessionsApi['prompt']
}

type PromptPart =
  | {
    type: 'text'
    text: string
    id?: string
    synthetic?: boolean
    time?: { start: number; end?: number }
  }
  | {
    type: 'file'
    mime: string
    url: string
    id?: string
    filename?: string
    source?: unknown
  }
  | {
    type: 'agent'
    name: string
    id?: string
    source?: unknown
  }

// Shape of v2 session.prompt parameters (flattened body + path + scope).
// We only populate the subset wrapper consumers care about.
interface SdkPromptParameters {
  sessionID: string
  directory?: string
  workspace?: string
  messageID?: string
  model?: { providerID: string; modelID: string }
  agent?: string
  system?: string
  variant?: string
  tools?: Record<string, boolean>
  parts: PromptPart[]
}

function toISOTime(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }

  return new Date(value).toISOString()
}

function requireSessionID(sessionID: string): string {
  const trimmed = sessionID.trim()

  if (trimmed.length === 0) {
    throw new OpencodeWrapperError('Session ID is required.', {
      code: 'invalid_config',
      retryable: false,
    })
  }

  return trimmed
}

function validatePromptInput(input: SessionPromptInput, sessionID: string): SdkPromptParameters {
  if (input.providerID.trim().length === 0 || input.modelID.trim().length === 0 || input.parts.length === 0) {
    throw new OpencodeWrapperError('Prompt payload requires providerID, modelID, and at least one part.', {
      code: 'invalid_config',
      retryable: false,
    })
  }

  const parameters: SdkPromptParameters = {
    sessionID,
    model: { providerID: input.providerID, modelID: input.modelID },
    parts: [...input.parts] as PromptPart[],
  }

  if (input.messageID !== undefined) parameters.messageID = input.messageID
  if (input.agent !== undefined) parameters.agent = input.agent
  if (input.system !== undefined) parameters.system = input.system
  if (input.variant !== undefined) parameters.variant = input.variant
  if (input.tools !== undefined) parameters.tools = input.tools

  return parameters
}

function normalizeSessionSummary(session: SdkSession): SessionSummary {
  const summary: SessionSummary = {
    id: session.id ?? '',
    title: session.title,
    status: session.status,
    updatedAt: toISOTime(session.time?.updated),
    parentID: session.parentID,
    directory: session.directory,
    ...(typeof session.projectID === 'string' ? { projectID: session.projectID } : {}),
    ...(typeof session.workspaceID === 'string' ? { workspaceID: session.workspaceID } : {}),
    ...(typeof session.slug === 'string' ? { slug: session.slug } : {}),
  }

  // Carry inline project from experimental/session endpoint
  if (session.project !== undefined) {
    summary.project = session.project
      ? { id: session.project.id ?? '', worktree: session.project.worktree ?? '', name: session.project.name, vcs: session.project.vcs }
      : null
  }

  return summary
}

function normalizeSessionRecord(session: SdkSession): SessionRecord {
  return {
    ...normalizeSessionSummary(session),
    parentID: session.parentID,
    version: session.version,
    shareURL: session.share?.url,
    createdAt: toISOTime(session.time?.created),
  }
}

function normalizeSessionMessage(message: SdkMessage): SessionMessageRecord {
  const info = message.info ?? {}
  return {
    info: {
      id: info.id ?? '',
      sessionID: info.sessionID ?? '',
      role: info.role,
      createdAt: toISOTime(info.time?.created),
      completedAt: toISOTime(info.time?.completed),
      ...(typeof info.providerID === 'string' ? { providerID: info.providerID } : {}),
      ...(typeof info.modelID === 'string' ? { modelID: info.modelID } : {}),
      ...(typeof info.agent === 'string' ? { agent: info.agent } : {}),
      ...(typeof info.variant === 'string' ? { variant: info.variant } : {}),
    },
    parts: Array.isArray(message.parts) ? message.parts : [],
  }
}

function normalizePromptResult(message: SdkAssistantMessage): SessionPromptResult {
  return {
    id: message.id ?? '',
    sessionID: message.sessionID ?? '',
    role: message.role,
    createdAt: toISOTime(message.time?.created),
    completedAt: toISOTime(message.time?.completed),
  }
}

/**
 * Create the session-oriented repository used by the gateway.
 */
export function createSessionsApi(client: WrappedSdkClient, _config: OpencodeWrapperConfig): SessionsRepository {
  return {
    async list(scope) {
      return client.request(async (sdk, requestOptions) => {
        // Use experimental/session endpoint to get ALL sessions across
        // directories with inline project info (GlobalSession[]).
        const experimental = (sdk as unknown as {
          experimental: { session: { list: (p: Record<string, unknown>) => Promise<SdkResponseEnvelope<unknown>> } }
        }).experimental
        const response = await experimental.session.list({
          ...(requestOptions.directory ? { directory: requestOptions.directory } : {}),
          ...(requestOptions.workspace ? { workspace: requestOptions.workspace } : {}),
        })
        const rawData = unwrapSessionEnvelope<unknown>(response)
        const data = Array.isArray(rawData) ? (rawData as SdkSession[]) : []
        return data.map(normalizeSessionSummary)
      }, scope)
    },

    async create(scope) {
      return client.request(async (sdk, requestOptions) => {
        const response = await sdk.session.create({
          ...(requestOptions.directory ? { directory: requestOptions.directory } : {}),
          ...(requestOptions.workspace ? { workspace: requestOptions.workspace } : {}),
        })
        const data = unwrapSessionEnvelope<SdkSession>(response)
        return normalizeSessionRecord((data ?? {}) as SdkSession)
      }, scope)
    },

    async get(sessionID, scope) {
      const id = requireSessionID(sessionID)

      return client.request(async (sdk, requestOptions) => {
        const response = await sdk.session.get({
          sessionID: id,
          ...(requestOptions.directory ? { directory: requestOptions.directory } : {}),
          ...(requestOptions.workspace ? { workspace: requestOptions.workspace } : {}),
        })
        const data = unwrapSessionEnvelope<SdkSession>(response)
        return normalizeSessionRecord((data ?? {}) as SdkSession)
      }, scope)
    },

    async messages(sessionID, scope) {
      const id = requireSessionID(sessionID)

      return client.request(async (sdk, requestOptions) => {
        const response = await sdk.session.messages({
          sessionID: id,
          ...(requestOptions.directory ? { directory: requestOptions.directory } : {}),
          ...(requestOptions.workspace ? { workspace: requestOptions.workspace } : {}),
        })
        const rawData = unwrapSessionEnvelope<unknown>(response)
        const data = Array.isArray(rawData) ? (rawData as SdkMessage[]) : []
        return data.map(normalizeSessionMessage)
      }, scope)
    },

    async prompt(sessionID, payload, scope) {
      const id = requireSessionID(sessionID)
      const parameters = validatePromptInput(payload, id)

      return client.request(async (sdk, requestOptions) => {
        // v2 session.prompt takes a flat parameters object (sessionID, model,
        // parts, ...) rather than v1's { path:{id}, body } shape. The TS types
        // are very strict about the Part tagged union and model nesting; we
        // cast through unknown because our internal SdkPromptParameters is a
        // structural subset.
        const response = await (sdk.session.prompt as unknown as (
          p: SdkPromptParameters,
        ) => Promise<{ data?: { info?: SdkAssistantMessage } }>)({
          ...parameters,
          ...(requestOptions.directory ? { directory: requestOptions.directory } : {}),
          ...(requestOptions.workspace ? { workspace: requestOptions.workspace } : {}),
        })

        const data = unwrapSessionEnvelope<unknown>(response)
        const info = isRecord(data) && isRecord(data.info) ? data.info : {}
        return normalizePromptResult(info as SdkAssistantMessage)
      }, scope)
    },
  }
}
