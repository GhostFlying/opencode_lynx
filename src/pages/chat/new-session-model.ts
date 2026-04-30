import type {
  BackendAgentInfo,
  BackendProviderInfo,
} from '../../backends/index.js'

export interface ConnectionPayload {
  ip?: string
  port?: string
  password?: string
}

export interface ChatRouteParams {
  sessionId?: string
  sessionTitle?: string
  connection?: ConnectionPayload
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

  const connection = isRecord(routeParams.connection) ? routeParams.connection : null
  const knownDirectoriesRaw = routeParams.knownDirectories
  const knownDirectories = Array.isArray(knownDirectoriesRaw)
    ? knownDirectoriesRaw.filter((value): value is string => typeof value === 'string')
    : undefined

  return {
    ...(typeof routeParams.sessionId === 'string' ? { sessionId: routeParams.sessionId } : {}),
    ...(typeof routeParams.sessionTitle === 'string' ? { sessionTitle: routeParams.sessionTitle } : {}),
    ...(connection
      ? {
          connection: {
            ip: typeof connection.ip === 'string' ? connection.ip : undefined,
            port: typeof connection.port === 'string' ? connection.port : undefined,
            password: typeof connection.password === 'string' ? connection.password : undefined,
          },
        }
      : {}),
    ...(typeof routeParams.isNewSession === 'boolean' ? { isNewSession: routeParams.isNewSession } : {}),
    ...(knownDirectories ? { knownDirectories } : {}),
  }
}

export function seedNewSessionDefaults(
  providers: BackendProviderInfo[],
  defaults: Record<string, string>,
  agents: BackendAgentInfo[],
): NewSessionDefaults | null {
  const firstAgent = agents.find(a => a.name === 'build') ?? agents[0]
  const providerIDs = Object.keys(defaults)
  const firstProviderID = providerIDs[0] ?? providers[0]?.id
  if (!firstAgent || !firstProviderID) return null

  const firstModelID =
    defaults[firstProviderID] ?? providers.find(p => p.id === firstProviderID)?.models[0]?.id
  if (!firstModelID) return null

  return {
    agent: firstAgent.name,
    providerID: firstProviderID,
    modelID: firstModelID,
    variant: null,
  }
}
