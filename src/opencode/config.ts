import type { OpencodeClientScope, OpencodeWrapperConfig, OpencodeWorkspaceSelector } from './types.js'

/**
 * The only workspace identifier allowed by the v1 runtime policy.
 */
export const V1_DEFAULT_WORKSPACE = 'default'
const SINGLE_WORKSPACE_V1_GUARD_MESSAGE = 'Single-workspace mode only allows workspace "default" in v1.'

type WorkspaceAwareConfig = Pick<OpencodeWrapperConfig, 'workspace'>
type WorkspaceAwareScope = Pick<OpencodeClientScope, 'workspace'>

/**
 * Resolve the effective workspace and enforce the v1 single-workspace guard.
 */
export function resolveWorkspaceSelector(
  config: WorkspaceAwareConfig,
  scope?: WorkspaceAwareScope,
): OpencodeWorkspaceSelector {
  const workspace = scope?.workspace ?? config.workspace ?? { id: V1_DEFAULT_WORKSPACE }

  if (workspace.id !== V1_DEFAULT_WORKSPACE) {
    throw new Error(SINGLE_WORKSPACE_V1_GUARD_MESSAGE)
  }

  return workspace
}

/**
 * Resolve the effective directory after validating the same workspace policy.
 */
export function resolveDirectory(
  config: Pick<OpencodeWrapperConfig, 'directory' | 'workspace'>,
  scope?: OpencodeClientScope,
): string | undefined {
  resolveWorkspaceSelector(config, scope)
  return scope?.directory ?? config.directory
}

/**
 * Build a query string while omitting undefined values.
 */
export function toQueryString(params: Record<string, string | undefined>): string {
  const searchParams = new URLSearchParams()

  for (const [key, value] of Object.entries(params)) {
    if (value) {
      searchParams.set(key, value)
    }
  }

  return searchParams.toString()
}
