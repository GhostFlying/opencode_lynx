import { createCodexBackendAdapter } from './codex/adapter.js'
import type { CodexBackendConfig } from './codex/adapter.js'
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

function assertCodexBackendConfig(value: unknown): CodexBackendConfig {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as { url?: unknown }).url !== 'string'
  ) {
    throw new BackendFacadeError(
      'codex backend requires a url string',
      'invalid_backend_input',
    )
  }
  return value as CodexBackendConfig
}

export function createBackendRegistry(
  options: CreateBackendRegistryOptions = {},
): BackendRegistry {
  const factories: Partial<BackendFactoryMap> = {
    opencode: (target: OpencodeBackendTarget) =>
      createOpenCodeBackendAdapter(target.config),
    codex: (target: CodexBackendTarget) =>
      createCodexBackendAdapter(assertCodexBackendConfig(target.config)),
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
