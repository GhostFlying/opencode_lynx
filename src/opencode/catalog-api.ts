import type { WrappedSdkClient } from './client.js'
import type {
  AgentInfo,
  CatalogApi,
  CatalogProvidersResult,
  ModelInfo,
  OpencodeWrapperConfig,
  ProviderInfo,
} from './types.js'

// We keep the local shape narrow — v2 exposes far more model fields than the
// chat page cares about, and mapping them all would explode this file for no
// gain. Structural types let us pick just what we need.
interface RawModel {
  id?: string
  name?: string
  reasoning?: boolean
  variants?: Record<string, unknown> | null
}

interface RawProvider {
  id?: string
  name?: string
  models?: Record<string, RawModel>
}

interface RawProvidersResponse {
  // v2 Provider.list() returns `{ all, default, connected }` — renamed from
  // v0.4.45's `{ providers, default }`. We keep both keys here as optional so
  // older servers (if any) still work.
  all?: RawProvider[]
  providers?: RawProvider[]
  default?: Record<string, string>
  connected?: string[]
}

interface RawAgent {
  name?: string
  description?: string
  mode?: string
  model?: { providerID?: string; modelID?: string }
}

function normalizeModel(rawId: string, raw: RawModel): ModelInfo {
  const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : rawId
  return {
    id,
    name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : id,
    reasoning: raw.reasoning === true,
    variants:
      raw.variants && typeof raw.variants === 'object'
        ? (raw.variants as Record<string, unknown>)
        : null,
  }
}

function normalizeProvider(raw: RawProvider): ProviderInfo {
  const id = typeof raw.id === 'string' ? raw.id : ''
  const modelsRecord = raw.models && typeof raw.models === 'object' ? raw.models : {}
  return {
    id,
    name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : id,
    models: Object.entries(modelsRecord).map(([modelId, rawModel]) =>
      normalizeModel(modelId, rawModel),
    ),
  }
}

function normalizeAgent(raw: RawAgent): AgentInfo | null {
  if (typeof raw.name !== 'string' || raw.name.length === 0) return null
  const out: AgentInfo = { name: raw.name }
  if (typeof raw.description === 'string') out.description = raw.description
  if (typeof raw.mode === 'string') out.mode = raw.mode
  if (
    raw.model &&
    typeof raw.model.providerID === 'string' &&
    typeof raw.model.modelID === 'string'
  ) {
    out.model = { providerID: raw.model.providerID, modelID: raw.model.modelID }
  }
  return out
}

export function createCatalogApi(
  client: WrappedSdkClient,
  _config: OpencodeWrapperConfig,
): CatalogApi {
  return {
    async providers(scope): Promise<CatalogProvidersResult> {
      return client.request(async sdk => {
        // v2 moved providers off `config.providers()` to a dedicated
        // `provider.list()` namespace, and renamed the `providers` field to
        // `all`. Keep the response narrowing structural so we don't have to
        // mirror v2's full Model schema.
        const sdkProvider = (sdk as unknown as {
          provider: { list: (parameters?: Record<string, unknown>) => Promise<{ data?: RawProvidersResponse }> }
        }).provider
        const response = await sdkProvider.list({})
        const data = (response?.data ?? {}) as RawProvidersResponse
        const rawProviders = Array.isArray(data.all)
          ? data.all
          : Array.isArray(data.providers)
            ? data.providers
            : []
        return {
          providers: rawProviders.map(normalizeProvider).filter(p => p.id.length > 0),
          defaults: data.default && typeof data.default === 'object' ? { ...data.default } : {},
        }
      }, scope)
    },

    async agents(scope): Promise<AgentInfo[]> {
      return client.request(async sdk => {
        // v2 flattens app.agents() parameters (takes an options object now).
        const sdkApp = (sdk as unknown as {
          app: { agents: (parameters?: Record<string, unknown>) => Promise<{ data?: RawAgent[] }> }
        }).app
        const response = await sdkApp.agents({})
        const data = Array.isArray(response?.data) ? response.data : []
        return data.map(normalizeAgent).filter((a): a is AgentInfo => a !== null)
      }, scope)
    },
  }
}
