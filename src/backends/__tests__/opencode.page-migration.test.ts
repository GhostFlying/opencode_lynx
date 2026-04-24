import { describe, expect, it, vi } from 'vitest'

import {
  connectOpencodeBackendClient,
  createOpencodeBackendClient,
  createOpencodeBackendClientFromConnection,
  createOpencodeBackendConfigFromConnection,
  createOpencodeBackendTarget,
  formatOpencodeBackendServerLabel,
  normalizeOpencodeBackendConnection,
  validateOpencodeBackendConnection,
} from '../opencode/page-migration.js'
import type { BackendClient, OpencodeBackendTarget } from '../types.js'

function createStubClient(): BackendClient {
  return {
    descriptor: {
      kind: 'opencode',
      label: 'OpenCode',
    },
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
      list: vi.fn(async () => []),
      create: vi.fn(),
      get: vi.fn(),
      messages: vi.fn(),
      prompt: vi.fn(),
    } as unknown as BackendClient['sessions'],
    events: {
      subscribe: vi.fn(),
    } as unknown as BackendClient['events'],
    catalog: {
      providers: vi.fn(),
      agents: vi.fn(),
    } as unknown as NonNullable<BackendClient['catalog']>,
  }
}

describe('opencode page migration helpers', () => {
  it('normalizes and validates connection input', () => {
    const normalized = normalizeOpencodeBackendConnection({
      ip: ' 127.0.0.1 ',
      port: ' 3000 ',
      password: undefined,
    })

    expect(normalized).toEqual({
      ip: '127.0.0.1',
      port: '3000',
      password: '',
    })

    expect(validateOpencodeBackendConnection({
      ip: '',
      port: '3000',
      password: '',
    })).toBe('Server IP is required.')

    expect(validateOpencodeBackendConnection({
      ip: '127.0.0.1',
      port: '70000',
      password: '',
    })).toBe('Port must be a number between 1 and 65535.')

    expect(validateOpencodeBackendConnection(normalized)).toBeNull()
  })

  it('builds config and target from connection input', () => {
    const withoutPassword = createOpencodeBackendConfigFromConnection({
      ip: '127.0.0.1',
      port: '3000',
      password: '',
    })

    expect(withoutPassword).toEqual({
      baseUrl: 'http://127.0.0.1:3000',
    })

    const withPassword = createOpencodeBackendConfigFromConnection({
      ip: '127.0.0.1',
      port: '3001',
      password: 'secret',
    })

    expect(withPassword).toEqual({
      baseUrl: 'http://127.0.0.1:3001',
      auth: 'secret',
    })

    expect(createOpencodeBackendTarget(withPassword)).toEqual({
      kind: 'opencode',
      config: {
        baseUrl: 'http://127.0.0.1:3001',
        auth: 'secret',
      },
    })

    expect(formatOpencodeBackendServerLabel({
      ip: '127.0.0.1',
      port: '3001',
      password: 'secret',
    })).toBe('127.0.0.1:3001')
  })

  it('creates a backend client from config and from connection input', () => {
    const client = createStubClient()
    const createClient = vi.fn((_target: OpencodeBackendTarget) => client)

    const config = {
      baseUrl: 'http://127.0.0.1:3000',
      auth: 'secret',
    }

    expect(createOpencodeBackendClient(config, { createClient })).toBe(client)
    expect(createClient).toHaveBeenCalledWith({
      kind: 'opencode',
      config,
    })

    expect(createOpencodeBackendClientFromConnection({
      ip: ' 127.0.0.1 ',
      port: ' 3000 ',
      password: 'secret',
    }, { createClient })).toBe(client)

    expect(createClient).toHaveBeenLastCalledWith({
      kind: 'opencode',
      config: {
        baseUrl: 'http://127.0.0.1:3000',
        auth: 'secret',
      },
    })
  })

  it('validates and probes the client before returning a page-migration connection result', async () => {
    const client = createStubClient()
    const list = vi.fn(async () => [])
    client.sessions.list = list
    const createClient = vi.fn(() => client)

    await expect(connectOpencodeBackendClient({
      ip: ' 127.0.0.1 ',
      port: ' 3000 ',
      password: 'secret',
    }, { createClient })).resolves.toEqual({
      client,
      connection: {
        ip: '127.0.0.1',
        port: '3000',
        password: 'secret',
      },
      serverLabel: '127.0.0.1:3000',
    })

    expect(list).toHaveBeenCalledWith()
    expect(createClient).toHaveBeenCalledWith({
      kind: 'opencode',
      config: {
        baseUrl: 'http://127.0.0.1:3000',
        auth: 'secret',
      },
    })
  })

  it('throws the validation error or upstream probe error unchanged', async () => {
    await expect(connectOpencodeBackendClient({
      ip: '',
      port: '3000',
      password: '',
    })).rejects.toThrow('Server IP is required.')

    const upstreamError = new Error('probe failed')
    const client = createStubClient()
    client.sessions.list = vi.fn(async () => {
      throw upstreamError
    })

    await expect(connectOpencodeBackendClient({
      ip: '127.0.0.1',
      port: '3000',
      password: '',
    }, {
      createClient: () => client,
    })).rejects.toBe(upstreamError)
  })
})
