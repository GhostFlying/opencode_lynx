import type { WrappedSdkClient } from './client.js'
import type {
  OpencodeWrapperConfig,
  ProjectSummary,
  ProjectsApi,
} from './types.js'

interface RawProject {
  id?: string
  worktree?: string
  name?: string
  vcs?: string
}

function normalizeProject(raw: RawProject): ProjectSummary {
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    worktree: typeof raw.worktree === 'string' ? raw.worktree : '',
    ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
    ...(typeof raw.vcs === 'string' ? { vcs: raw.vcs } : {}),
  }
}

export function createProjectsApi(
  client: WrappedSdkClient,
  _config: OpencodeWrapperConfig,
): ProjectsApi {
  return {
    async list(scope) {
      return client.request(async sdk => {
        const sdkProject = (sdk as unknown as {
          project: { list: (parameters?: Record<string, unknown>) => Promise<{ data?: RawProject[] }> }
        }).project
        const response = await sdkProject.list({})
        const data = Array.isArray(response?.data) ? response.data : []
        return data.map(normalizeProject).filter(p => p.id.length > 0)
      }, scope)
    },
  }
}
