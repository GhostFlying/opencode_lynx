import type {
  BackendAgentInfo,
  BackendProviderInfo,
} from '../../backends/index.js'
import type {
  CodexConnectionContext,
  ConnectionContext,
  OpencodeConnectionContext,
} from '../main/connection.js'

/**
 * Discriminated union mirroring `ConnectionContext` from the main page so the
 * chat route can carry either an opencode or a codex backend. `ConnectionPayload`
 * is kept as a type alias for backwards-compat with call sites that imported
 * the older opencode-only shape.
 */
export type ConnectionPayload = ConnectionContext

export interface ChatRouteParams {
  sessionId?: string
  sessionTitle?: string
  connection?: ConnectionContext
  isNewSession?: boolean
  knownDirectories?: string[]
}

export interface NewSessionDefaults {
  agent: string
  providerID: string
  modelID: string
  variant: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseOpencodeConnection(
  connection: Record<string, unknown>,
): OpencodeConnectionContext | null {
  const ip = typeof connection.ip === 'string' ? connection.ip : ''
  const port = typeof connection.port === 'string' ? connection.port : ''
  if (ip.length === 0 || port.length === 0) return null
  return {
    kind: 'opencode',
    ip,
    port,
    password: typeof connection.password === 'string' ? connection.password : '',
  }
}

function parseCodexConnection(
  connection: Record<string, unknown>,
): CodexConnectionContext | null {
  const host = typeof connection.host === 'string' ? connection.host : ''
  const port = typeof connection.port === 'string' ? connection.port : ''
  if (host.length === 0 || port.length === 0) return null
  return {
    kind: 'codex',
    host,
    port,
    token: typeof connection.token === 'string' ? connection.token : '',
    secure: connection.secure === true,
  }
}

function parseConnection(connection: Record<string, unknown>): ConnectionContext | null {
  // Back-compat: routes serialised before the kind field existed always carried
  // the opencode shape. Default the kind to 'opencode' when missing so any
  // in-flight new-session route still resolves correctly.
  const kind = typeof connection.kind === 'string' ? connection.kind : 'opencode'
  if (kind === 'codex') return parseCodexConnection(connection)
  if (kind === 'opencode') return parseOpencodeConnection(connection)
  return null
}

export function parseChatRouteParams(globalProps: unknown): ChatRouteParams {
  if (!isRecord(globalProps)) return {}

  let routeParams = isRecord(globalProps.routeParams) ? globalProps.routeParams : null

  // Some Android Lynx SDK versions do not serialise nested Maps into
  // globalProps. queryItems keeps the raw route_params string as a fallback.
  if (!routeParams) {
    const queryItems = isRecord(globalProps.queryItems) ? globalProps.queryItems : null
    const routeParamsRaw = queryItems?.route_params
    if (typeof routeParamsRaw === 'string') {
      try {
        const parsed = JSON.parse(routeParamsRaw) as unknown
        if (isRecord(parsed)) {
          routeParams = parsed
        }
      } catch {
        // ignore parse error
      }
    }
  }

  if (!routeParams) return {}

  const rawConnection = isRecord(routeParams.connection) ? routeParams.connection : null
  const connection = rawConnection ? parseConnection(rawConnection) : null
  const knownDirectoriesRaw = routeParams.knownDirectories
  const knownDirectories = Array.isArray(knownDirectoriesRaw)
    ? knownDirectoriesRaw.filter((value): value is string => typeof value === 'string')
    : undefined

  return {
    ...(typeof routeParams.sessionId === 'string' ? { sessionId: routeParams.sessionId } : {}),
    ...(typeof routeParams.sessionTitle === 'string' ? { sessionTitle: routeParams.sessionTitle } : {}),
    ...(connection ? { connection } : {}),
    ...(typeof routeParams.isNewSession === 'boolean' ? { isNewSession: routeParams.isNewSession } : {}),
    ...(knownDirectories ? { knownDirectories } : {}),
  }
}

/**
 * Picks first agent + first provider/model from a backend catalog. Backend-kind
 * agnostic — when a backend has no agent picker (Codex returns []), the agent
 * field is collapsed to '' and the chat App treats empty as "no agent".
 */
export function seedNewSessionDefaults(
  providers: BackendProviderInfo[],
  defaults: Record<string, string>,
  agents: BackendAgentInfo[],
): NewSessionDefaults | null {
  const providerIDs = Object.keys(defaults)
  const firstProviderID = providerIDs[0] ?? providers[0]?.id
  if (!firstProviderID) return null

  const firstModelID =
    defaults[firstProviderID] ?? providers.find(p => p.id === firstProviderID)?.models[0]?.id
  if (!firstModelID) return null

  const firstAgent = agents.find(a => a.name === 'build') ?? agents[0]

  return {
    agent: firstAgent?.name ?? '',
    providerID: firstProviderID,
    modelID: firstModelID,
    variant: null,
  }
}
