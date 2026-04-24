import { createOpenCodeBackendAdapter } from './opencode/adapter.js'
import { BackendFacadeError } from './errors.js'
import type {
  BackendClient,
  BackendKind,
  BackendTarget,
  ClaudeBackendTarget,
  CodexBackendTarget,
  OpencodeBackendTarget,
} from './types.js'

type OpencodeBackendFactory = (target: OpencodeBackendTarget) => BackendClient
type CodexBackendFactory = (target: CodexBackendTarget) => BackendClient
type ClaudeBackendFactory = (target: ClaudeBackendTarget) => BackendClient

interface BackendFactoryMap {
  opencode: OpencodeBackendFactory
  codex: CodexBackendFactory
  claude: ClaudeBackendFactory
}

export interface CreateBackendRegistryOptions {
  factories?: Partial<BackendFactoryMap>
}

export interface BackendRegistry {
  has(kind: BackendKind): boolean
  create(target: BackendTarget): BackendClient
}

function unsupportedBackend(kind: BackendKind): never {
  throw new BackendFacadeError(
    `Backend "${kind}" is not supported in the current registry.`,
    'unsupported_backend',
  )
}

export function createBackendRegistry(
  options: CreateBackendRegistryOptions = {},
): BackendRegistry {
  const factories: Partial<BackendFactoryMap> = {
    opencode: (target: OpencodeBackendTarget) =>
      createOpenCodeBackendAdapter(target.config),
    ...options.factories,
  }

  return {
    has(kind) {
      return typeof factories[kind] === 'function'
    },

    create(target) {
      if (target.kind === 'opencode') {
        const factory = factories.opencode
        if (!factory) unsupportedBackend(target.kind)
        return factory(target)
      }

      if (target.kind === 'codex') {
        const factory = factories.codex
        if (!factory) unsupportedBackend(target.kind)
        return factory(target)
      }

      const factory = factories.claude
      if (!factory) unsupportedBackend(target.kind)
      return factory(target)
    },
  }
}
