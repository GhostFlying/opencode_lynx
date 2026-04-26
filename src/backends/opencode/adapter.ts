import { createOpencodeGateway } from '../../opencode/gateway.js'
import type {
  OpenCodeGatewayContract,
  OpenCodeGatewayEventContext,
  OpenCodeGatewayEventSubscription,
  OpenCodeGatewaySubscribeOptions,
} from '../../opencode/gateway.js'
import type {
  AgentInfo,
  CatalogProvidersResult,
  OpencodeClientScope,
  OpencodeWrapperConfig,
  ProviderInfo,
  SessionMessageRecord,
  SessionPromptResult,
  SessionRecord,
  SessionSummary,
} from '../../opencode/types.js'
import { BackendFacadeError } from '../errors.js'
import type {
  BackendAgentInfo,
  BackendClient,
  BackendConnectionSnapshot,
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
  BackendSubscription,
} from '../types.js'

interface CreateOpenCodeBackendAdapterOptions {
  createGateway?: (config: OpencodeWrapperConfig) => OpenCodeGatewayContract
}

const OPENCODE_DESCRIPTOR = {
  kind: 'opencode',
  label: 'OpenCode',
} as const

const OPENCODE_CAPABILITIES = {
  sessions: true,
  streaming: true,
  catalog: true,
  approvals: false,
  pty: false,
  remoteDiscovery: false,
  agentPicker: true,
  modelPicker: true,
} as const

type OpencodeEvent = NonNullable<OpenCodeGatewaySubscribeOptions['onEvent']> extends (
  event: infer TEvent,
  context: OpenCodeGatewayEventContext,
) => void ? TEvent : never

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toOpencodeScope(scope?: BackendScope): OpencodeClientScope | undefined {
  if (!scope) {
    return undefined
  }

  const nextScope: OpencodeClientScope = {}

  if (typeof scope.directory === 'string' && scope.directory.length > 0) {
    nextScope.directory = scope.directory
  }

  if (typeof scope.workspaceID === 'string' && scope.workspaceID.length > 0) {
    nextScope.workspace = { id: scope.workspaceID }
  }

  return Object.keys(nextScope).length > 0 ? nextScope : undefined
}

function toBackendMessageRole(role: string | undefined): BackendMessageRole {
  if (role === 'user' || role === 'assistant' || role === 'system' || role === 'tool') {
    return role
  }

  return 'system'
}

function toSessionSummary(session: SessionSummary): BackendSessionSummary {
  return {
    backend: 'opencode',
    id: session.id,
    ...(typeof session.title === 'string' ? { title: session.title } : {}),
    ...(typeof session.status === 'string' ? { status: session.status } : {}),
    ...(typeof session.updatedAt === 'string' ? { updatedAt: session.updatedAt } : {}),
    ...(typeof session.directory === 'string' ? { directory: session.directory } : {}),
    ...(typeof session.project?.name === 'string' ? { projectLabel: session.project.name } : {}),
    backendMeta: {
      ...(typeof session.parentID === 'string' ? { parentID: session.parentID } : {}),
      ...(typeof session.projectID === 'string' ? { projectID: session.projectID } : {}),
      ...(typeof session.workspaceID === 'string' ? { workspaceID: session.workspaceID } : {}),
      ...(typeof session.slug === 'string' ? { slug: session.slug } : {}),
      ...(session.project !== undefined ? { project: session.project } : {}),
    },
  }
}

function toSessionRecord(session: SessionRecord): BackendSessionRecord {
  return {
    ...toSessionSummary(session),
    ...(typeof session.createdAt === 'string' ? { createdAt: session.createdAt } : {}),
    ...(typeof session.parentID === 'string' ? { parentID: session.parentID } : {}),
    ...(typeof session.shareURL === 'string' ? { shareURL: session.shareURL } : {}),
  }
}

function toBackendMessage(message: SessionMessageRecord): BackendMessage {
  return {
    id: message.info.id,
    sessionID: message.info.sessionID,
    role: toBackendMessageRole(message.info.role),
    ...(typeof message.info.createdAt === 'string' ? { createdAt: message.info.createdAt } : {}),
    ...(typeof message.info.completedAt === 'string' ? { completedAt: message.info.completedAt } : {}),
    parts: message.parts.map(part => isRecord(part) ? part : { value: part }),
    backendMeta: {
      ...(typeof message.info.providerID === 'string' ? { providerID: message.info.providerID } : {}),
      ...(typeof message.info.modelID === 'string' ? { modelID: message.info.modelID } : {}),
      ...(typeof message.info.agent === 'string' ? { agent: message.info.agent } : {}),
      ...(typeof message.info.variant === 'string' ? { variant: message.info.variant } : {}),
    },
  }
}

function toBackendProviderCatalog(result: CatalogProvidersResult): BackendProviderCatalog {
  return {
    providers: result.providers.map((provider: ProviderInfo): BackendProviderInfo => ({
      id: provider.id,
      name: provider.name,
      models: provider.models.map(model => ({
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        reasoningEfforts: Object.keys(model.variants ?? {}),
        backendMeta: {
          ...(model.variants ? { variants: model.variants } : {}),
        },
      })),
    })),
    defaults: { ...result.defaults },
  }
}

function toBackendAgent(agent: AgentInfo): BackendAgentInfo {
  return {
    id: agent.name,
    name: agent.name,
    ...(typeof agent.description === 'string' ? { description: agent.description } : {}),
    backendMeta: {
      ...(typeof agent.mode === 'string' ? { mode: agent.mode } : {}),
      ...(agent.model ? { model: agent.model } : {}),
    },
  }
}

function toConnectionSnapshot(state: {
  status: BackendConnectionSnapshot['status']
  retryAttempt: number
  nextRetryInMs: number | null
  reason: unknown
}): BackendConnectionSnapshot {
  return {
    status: state.status,
    retryAttempt: state.retryAttempt,
    nextRetryInMs: state.nextRetryInMs,
    reason: state.reason,
  }
}

function readEventField(
  properties: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = properties[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }

  return undefined
}

function readNestedEventField(
  properties: Record<string, unknown>,
  containers: readonly string[],
  keys: readonly string[],
): string | undefined {
  for (const containerKey of containers) {
    const container = properties[containerKey]
    if (!isRecord(container)) {
      continue
    }

    const value = readEventField(container, keys)
    if (value) {
      return value
    }
  }

  return undefined
}

function toPayload(properties: unknown): Record<string, unknown> {
  if (isRecord(properties)) {
    return properties
  }

  return { value: properties }
}

function toBackendEvent(event: OpencodeEvent): BackendEvent {
  const payload = toPayload(event.properties)
  const sessionID =
    readEventField(payload, ['sessionID', 'sessionId', 'session_id']) ??
    readNestedEventField(payload, ['info', 'part', 'message'], [
      'sessionID',
      'sessionId',
      'session_id',
    ])
  const messageID =
    readEventField(payload, ['messageID', 'messageId', 'message_id']) ??
    readNestedEventField(payload, ['info', 'part', 'message'], [
      'messageID',
      'messageId',
      'message_id',
      'id',
    ])
  const partID =
    readEventField(payload, ['partID', 'partId', 'part_id']) ??
    readNestedEventField(payload, ['part'], ['partID', 'partId', 'part_id', 'id'])

  if (event.type === 'unknown') {
    return {
      backend: 'opencode',
      type: 'raw',
      raw: event,
      sourceType: event.eventType,
      payload,
      ...(sessionID ? { sessionID } : {}),
      ...(messageID ? { messageID } : {}),
      ...(partID ? { partID } : {}),
    }
  }

  if (event.type === 'session.status') {
    return {
      backend: 'opencode',
      type: 'session.updated',
      raw: event,
      sourceType: event.type,
      payload,
      ...(sessionID ? { sessionID } : {}),
      ...(typeof payload.status === 'string' ? { status: payload.status } : {}),
    }
  }

  if (event.type === 'message.part.delta') {
    return {
      backend: 'opencode',
      type: 'message.delta',
      raw: event,
      sourceType: event.type,
      payload,
      ...(sessionID ? { sessionID } : {}),
      ...(messageID ? { messageID } : {}),
      ...(partID ? { partID } : {}),
    }
  }

  if (event.type === 'message.part.updated' || event.type === 'message.updated') {
    return {
      backend: 'opencode',
      type: 'message.updated',
      raw: event,
      sourceType: event.type,
      payload,
      ...(sessionID ? { sessionID } : {}),
      ...(messageID ? { messageID } : {}),
      ...(partID ? { partID } : {}),
    }
  }

  if (event.type === 'server.connected') {
    return {
      backend: 'opencode',
      type: 'connection.state',
      raw: event,
      sourceType: event.type,
      payload,
      status: 'open',
    }
  }

  return {
    backend: 'opencode',
    type: 'connection.state',
    raw: event,
    sourceType: event.type,
    payload,
    status: 'stopped',
  }
}

function toPromptResult(
  sessionID: string,
  result: SessionPromptResult,
): BackendPromptResult {
  return {
    sessionID: result.sessionID || sessionID,
    ...(typeof result.id === 'string' && result.id.length > 0 ? { messageID: result.id } : {}),
    backendMeta: {
      ...(typeof result.role === 'string' ? { role: result.role } : {}),
      ...(typeof result.createdAt === 'string' ? { createdAt: result.createdAt } : {}),
      ...(typeof result.completedAt === 'string' ? { completedAt: result.completedAt } : {}),
    },
  }
}

function validatePromptInput(input: BackendPromptInput): {
  providerID: string
  modelID: string
} {
  if (!Array.isArray(input.parts) || input.parts.length === 0) {
    throw new BackendFacadeError(
      'Backend prompt input requires at least one part.',
      'invalid_backend_input',
    )
  }

  const providerID = input.model?.providerID
  const modelID = input.model?.modelID

  if (typeof providerID !== 'string' || providerID.trim().length === 0) {
    throw new BackendFacadeError(
      'OpenCode backend requires model.providerID.',
      'invalid_backend_input',
    )
  }

  if (typeof modelID !== 'string' || modelID.trim().length === 0) {
    throw new BackendFacadeError(
      'OpenCode backend requires model.modelID.',
      'invalid_backend_input',
    )
  }

  return {
    providerID: providerID.trim(),
    modelID: modelID.trim(),
  }
}

export function createOpenCodeBackendAdapter(
  config: OpencodeWrapperConfig,
  options: CreateOpenCodeBackendAdapterOptions = {},
): BackendClient {
  const createGateway = options.createGateway ?? createOpencodeGateway
  const gateway = createGateway(config)

  return {
    descriptor: OPENCODE_DESCRIPTOR,
    capabilities: OPENCODE_CAPABILITIES,
    sessions: {
      async list(scope) {
        const result = await gateway.sessions.list(toOpencodeScope(scope))
        return result.map(toSessionSummary)
      },

      async create(scope) {
        const result = await gateway.sessions.create(toOpencodeScope(scope))
        return toSessionRecord(result)
      },

      async get(sessionID, scope) {
        const result = await gateway.sessions.get(sessionID, toOpencodeScope(scope))
        return toSessionRecord(result)
      },

      async messages(sessionID, scope) {
        const result = await gateway.sessions.messages(sessionID, toOpencodeScope(scope))
        return result.map(toBackendMessage)
      },

      async prompt(sessionID, input, scope) {
        const model = validatePromptInput(input)
        const result = await gateway.sessions.prompt(
          sessionID,
          {
            providerID: model.providerID,
            modelID: model.modelID,
            parts: [...input.parts],
            ...(typeof input.agent === 'string' ? { agent: input.agent } : {}),
            ...(typeof input.reasoningEffort === 'string'
              ? { variant: input.reasoningEffort }
              : {}),
            ...(input.tools ? { tools: input.tools } : {}),
          },
          toOpencodeScope(scope),
        )

        return toPromptResult(sessionID, result)
      },
    },
    events: {
      subscribe(options = {}): BackendSubscription {
        const subscription = gateway.events.subscribe({
          scope: toOpencodeScope(options.scope),
          autoStart: options.autoStart,
          onEvent(event, _context) {
            options.onEvent?.(toBackendEvent(event))
          },
          onReconcileAction(action, _state, event) {
            if (action.type !== 'refetchRequired') {
              return
            }

            const baseEvent = toBackendEvent(event)
            options.onEvent?.({
              backend: 'opencode',
              type: 'resync.required',
              raw: { event, action },
              sourceType: baseEvent.sourceType,
              payload: {
                eventName: action.eventName,
                reason: action.reason,
                orderKey: action.orderKey,
                expectedSequence: action.expectedSequence,
                receivedSequence: action.receivedSequence,
              },
              ...(baseEvent.sessionID ? { sessionID: baseEvent.sessionID } : {}),
              ...(baseEvent.messageID ? { messageID: baseEvent.messageID } : {}),
              ...(baseEvent.partID ? { partID: baseEvent.partID } : {}),
            })
          },
          onLifecycleStateChange(state) {
            options.onConnectionStateChange?.(toConnectionSnapshot(state))
          },
          onError(error) {
            options.onError?.(error)
          },
          abortSignal: options.abortSignal,
        })

        return {
          start() {
            subscription.start()
          },

          stop(reason) {
            subscription.stop(reason)
          },

          reconnect(reason) {
            subscription.reconnect(reason)
          },

          getState() {
            return toConnectionSnapshot(subscription.getLifecycleState())
          },

          attachAbortSignal(signal: AbortSignal) {
            return subscription.attachAbortSignal(signal)
          },
        }
      },
    },
    catalog: {
      async providers(scope) {
        const result = await gateway.catalog.providers(toOpencodeScope(scope))
        return toBackendProviderCatalog(result)
      },

      async agents(scope) {
        const result = await gateway.catalog.agents(toOpencodeScope(scope))
        return result.map(toBackendAgent)
      },
    },
  }
}
