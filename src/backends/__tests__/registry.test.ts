import { describe, expect, it, vi } from 'vitest'

import { BackendFacadeError } from '../errors.js'
import { createBackendRegistry } from '../registry.js'
import type { BackendClient } from '../types.js'

function createStubClient(kind: 'opencode' | 'codex' | 'claude'): BackendClient {
  return {
    descriptor: { kind, label: kind },
    capabilities: {
      sessions: true,
      streaming: false,
      catalog: false,
      approvals: false,
      pty: false,
      remoteDiscovery: false,
      agentPicker: false,
      modelPicker: false,
    },
    sessions: {
      list: async () => [],
      create: async () => ({
        backend: kind,
        id: 'session-1',
      }),
      get: async () => ({
        backend: kind,
        id: 'session-1',
      }),
      messages: async () => [],
      prompt: async () => ({
        sessionID: 'session-1',
      }),
    },
    events: {
      subscribe: () => ({
        start() {},
        stop() {},
        reconnect() {},
        getState() {
          return {
            status: 'idle',
            retryAttempt: 0,
            nextRetryInMs: null,
            reason: null,
          }
        },
        attachAbortSignal() {
          return () => {}
        },
      }),
    },
  }
}

describe('backend registry', () => {
  it('registers OpenCode by default', () => {
    const registry = createBackendRegistry()

    expect(registry.has('opencode')).toBe(true)
    expect(registry.has('codex')).toBe(false)
    expect(registry.has('claude')).toBe(false)
  })

  it('creates a backend client through the registered factory', () => {
    const client = createStubClient('opencode')
    const factory = vi.fn(() => client)
    const registry = createBackendRegistry({
      factories: {
        opencode: factory,
      },
    })

    const target = {
      kind: 'opencode',
      config: { baseUrl: 'https://opencode.example.com' },
    } as const

    expect(registry.has('opencode')).toBe(true)
    expect(registry.create(target)).toBe(client)
    expect(factory).toHaveBeenCalledWith(target)
  })

  it('throws a typed unsupported_backend error for missing factories', () => {
    const registry = createBackendRegistry({
      factories: {
        opencode: vi.fn(() => createStubClient('opencode')),
      },
    })

    expect(() => registry.create({
      kind: 'codex',
      config: {},
    })).toThrow(BackendFacadeError)

    try {
      registry.create({
        kind: 'claude',
        config: {},
      })
      throw new Error('expected registry.create to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(BackendFacadeError)
      expect(error).toMatchObject({
        name: 'BackendFacadeError',
        code: 'unsupported_backend',
        message: 'Backend "claude" is not supported in the current registry.',
      })
    }
  })

  it('creates custom codex and claude factories when they are provided', () => {
    const codexFactory = vi.fn(() => createStubClient('codex'))
    const claudeFactory = vi.fn(() => createStubClient('claude'))
    const registry = createBackendRegistry({
      factories: {
        codex: codexFactory,
        claude: claudeFactory,
      },
    })

    expect(registry.has('codex')).toBe(true)
    expect(registry.has('claude')).toBe(true)
    expect(registry.create({ kind: 'codex', config: { transport: 'stdio' } }).descriptor.kind).toBe('codex')
    expect(registry.create({ kind: 'claude', config: { endpoint: 'local' } }).descriptor.kind).toBe('claude')
    expect(codexFactory).toHaveBeenCalledWith({
      kind: 'codex',
      config: { transport: 'stdio' },
    })
    expect(claudeFactory).toHaveBeenCalledWith({
      kind: 'claude',
      config: { endpoint: 'local' },
    })
  })
})
