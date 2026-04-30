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

// Cap to keep the new-session card chip strip readable and the route_params
// payload from ballooning. Heavy users can have dozens of unique worktrees;
// past that, "preset" stops being a shortcut. Free-text input remains as
// fallback for paths that fall off the tail.
export const KNOWN_DIRECTORY_LIMIT = 8

export function extractKnownDirectories(sessions: SessionItem[]): string[] {
  const latestByDir = new Map<string, string>()
  for (const session of sessions) {
    const dir = session.directory
    if (typeof dir !== 'string' || dir.length === 0) continue
    const existing = latestByDir.get(dir)
    const updatedAt = session.updatedAt ?? ''
    if (existing === undefined || updatedAt > existing) {
      latestByDir.set(dir, updatedAt)
    }
  }

  return Array.from(latestByDir.entries())
    .sort((left, right) => {
      if (left[1] === right[1]) return left[0].localeCompare(right[0])
      return right[1].localeCompare(left[1])
    })
    .slice(0, KNOWN_DIRECTORY_LIMIT)
    .map(([dir]) => dir)
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
