import { describe, expect, it, vi } from 'vitest'

import { BackendFacadeError } from '../errors.js'
import { createBackendFacade } from '../facade.js'
import { createBackendRegistry } from '../registry.js'
import type { BackendClient } from '../types.js'

function createStubClient(): BackendClient {
  return {
    descriptor: { kind: 'opencode', label: 'OpenCode' },
    capabilities: {
      sessions: true,
      streaming: true,
      catalog: true,
      approvals: false,
      pty: false,
      remoteDiscovery: false,
      agentPicker: true,
      modelPicker: true,
    },
    sessions: {
      list: async () => [],
      create: async () => ({ backend: 'opencode', id: 'session-1' }),
      get: async () => ({ backend: 'opencode', id: 'session-1' }),
      messages: async () => [],
      prompt: async () => ({ sessionID: 'session-1' }),
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

describe('backend facade', () => {
  it('delegates backend creation to the provided registry', () => {
    const client = createStubClient()
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

    expect(createBackendFacade(target, { registry })).toBe(client)
    expect(factory).toHaveBeenCalledWith(target)
  })

  it('builds an OpenCode client through the default registry path', () => {
    const client = createBackendFacade({
      kind: 'opencode',
      config: { baseUrl: 'https://opencode.example.com' },
    })

    expect(client.descriptor).toEqual({
      kind: 'opencode',
      label: 'OpenCode',
    })

    expect(client.capabilities).toEqual({
      sessions: true,
      streaming: true,
      catalog: true,
      approvals: false,
      pty: false,
      remoteDiscovery: false,
      agentPicker: true,
      modelPicker: true,
    })
  })

  it('throws invalid_backend_input for malformed targets', () => {
    expect(() => createBackendFacade(null as unknown as never)).toThrow(BackendFacadeError)

    try {
      createBackendFacade({ kind: 'not-real' } as unknown as never)
      throw new Error('expected createBackendFacade to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(BackendFacadeError)
      expect(error).toMatchObject({
        code: 'invalid_backend_input',
        message: 'Backend target must be an object with a supported kind.',
      })
    }
  })

  it('does not wrap backend factory errors', () => {
    const providerError = new Error('provider failed')
    const registry = createBackendRegistry({
      factories: {
        opencode: () => {
          throw providerError
        },
      },
    })

    expect(() =>
      createBackendFacade(
        {
          kind: 'opencode',
          config: { baseUrl: 'https://opencode.example.com' },
        },
        { registry },
      ),
    ).toThrow(providerError)
  })

  it('throws unsupported_backend for unimplemented default backends', () => {
    expect(() =>
      createBackendFacade({
        kind: 'codex',
        config: {},
      }),
    ).toThrow(BackendFacadeError)

    try {
      createBackendFacade({
        kind: 'claude',
        config: {},
      })
      throw new Error('expected createBackendFacade to throw')
    } catch (error) {
      expect(error).toMatchObject({
        name: 'BackendFacadeError',
        code: 'unsupported_backend',
      })
    }
  })
})
