import { BackendFacadeError } from './errors.js'
import { createBackendRegistry } from './registry.js'
import type { BackendClient, BackendTarget } from './types.js'
import type { BackendRegistry } from './registry.js'

export interface CreateBackendFacadeOptions {
  registry?: BackendRegistry
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBackendKind(value: unknown): value is BackendTarget['kind'] {
  return value === 'opencode' || value === 'codex' || value === 'claude'
}

function validateBackendTarget(target: BackendTarget | unknown): BackendTarget {
  if (!isRecord(target) || !isBackendKind(target.kind)) {
    throw new BackendFacadeError(
      'Backend target must be an object with a supported kind.',
      'invalid_backend_input',
    )
  }

  return target as BackendTarget
}

export function createBackendFacade(
  target: BackendTarget,
  options: CreateBackendFacadeOptions = {},
): BackendClient {
  const validatedTarget = validateBackendTarget(target)
  const registry = options.registry ?? createBackendRegistry()
  return registry.create(validatedTarget)
}
