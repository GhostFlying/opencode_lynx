import type {
  BackendEvent,
  BackendSessionSummary,
} from '../../backends/index.js'

export interface SessionItem {
  id: string
  title?: string
  updatedAt?: string
  parentID?: string
  directory?: string
  projectID?: string
  project?: ProjectSummaryLike | null
}

export interface ProjectSummaryLike {
  id?: string
  worktree: string
  name?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function mapBackendSessionToSessionItem(session: BackendSessionSummary): SessionItem {
  const meta = isRecord(session.backendMeta) ? session.backendMeta : {}
  const rawProject = meta.project
  const project = isRecord(rawProject)
    ? {
        ...(typeof rawProject.id === 'string' ? { id: rawProject.id } : {}),
        worktree: typeof rawProject.worktree === 'string' ? rawProject.worktree : '',
        ...(typeof rawProject.name === 'string' ? { name: rawProject.name } : {}),
      }
    : null

  return {
    id: session.id,
    ...(typeof session.title === 'string' ? { title: session.title } : {}),
    ...(typeof session.updatedAt === 'string' ? { updatedAt: session.updatedAt } : {}),
    ...(typeof session.directory === 'string' ? { directory: session.directory } : {}),
    ...(typeof meta.parentID === 'string' ? { parentID: meta.parentID } : {}),
    ...(typeof meta.projectID === 'string' ? { projectID: meta.projectID } : {}),
    ...(project ? { project } : {}),
  }
}

export function shouldRefreshSessionListForBackendEvent(event: BackendEvent): boolean {
  if (
    event.type === 'session.updated' ||
    event.type === 'message.updated' ||
    event.type === 'resync.required'
  ) {
    return true
  }

  return event.type === 'raw' && event.sourceType === 'session.idle'
}
