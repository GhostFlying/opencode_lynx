import { describe, expect, it, vi } from 'vitest'

import {
  connectCodexBackendClient,
  createCodexBackendClient,
  createCodexBackendClientFromConnection,
  createCodexBackendConfigFromConnection,
  createCodexBackendTarget,
  formatCodexBackendServerLabel,
  normalizeCodexBackendConnection,
  validateCodexBackendConnection,
} from '../page-migration.js'
import type { BackendClient, CodexBackendTarget } from '../../types.js'

function createStubClient(): BackendClient {
  return {
    descriptor: {
      kind: 'codex',
      label: 'Codex',
    },
    capabilities: {
      sessions: true,
      streaming: true,
      catalog: true,
      approvals: true,
      pty: false,
      remoteDiscovery: false,
      agentPicker: false,
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
    approvals: {
      respond: vi.fn(),
    } as unknown as NonNullable<BackendClient['approvals']>,
  }
}

describe('codex page migration helpers', () => {
  it('normalizes input — trims fields and defaults secure/token', () => {
    expect(
      normalizeCodexBackendConnection({
        host: ' 127.0.0.1 ',
        port: ' 4000 ',
      }),
    ).toEqual({
      host: '127.0.0.1',
      port: '4000',
      token: '',
      secure: false,
    })

    expect(
      normalizeCodexBackendConnection({
        host: 'codex.example',
        port: '4000',
        token: 'abc',
        secure: true,
      }),
    ).toEqual({
      host: 'codex.example',
      port: '4000',
      token: 'abc',
      secure: true,
    })
  })

  it('flags missing host and invalid ports', () => {
    expect(
      validateCodexBackendConnection({
        host: '',
        port: '4000',
      }),
    ).toBe('Server host is required.')

    expect(
      validateCodexBackendConnection({
        host: '127.0.0.1',
        port: '0',
      }),
    ).toBe('Port must be a number between 1 and 65535.')

    expect(
      validateCodexBackendConnection({
        host: '127.0.0.1',
        port: '65536',
      }),
    ).toBe('Port must be a number between 1 and 65535.')

    expect(
      validateCodexBackendConnection({
        host: '127.0.0.1',
        port: 'not-a-number',
      }),
    ).toBe('Port must be a number between 1 and 65535.')

    expect(
      validateCodexBackendConnection({
        host: '127.0.0.1',
        port: '4000',
      }),
    ).toBeNull()
  })

  it('formats server label for both ws and wss', () => {
    expect(
      formatCodexBackendServerLabel({
        host: '127.0.0.1',
        port: '4000',
      }),
    ).toBe('ws://127.0.0.1:4000')

    expect(
      formatCodexBackendServerLabel({
        host: 'codex.example',
        port: '4001',
        secure: true,
      }),
    ).toBe('wss://codex.example:4001')
  })

  it('builds config with optional Authorization header', () => {
    expect(
      createCodexBackendConfigFromConnection({
        host: '127.0.0.1',
        port: '4000',
      }),
    ).toEqual({
      url: 'ws://127.0.0.1:4000',
    })

    expect(
      createCodexBackendConfigFromConnection({
        host: 'codex.example',
        port: '4001',
        token: 'secret',
        secure: true,
      }),
    ).toEqual({
      url: 'wss://codex.example:4001',
      headers: { Authorization: 'Bearer secret' },
    })

    // Empty token must NOT add a header (loopback Codex doesn't need auth).
    expect(
      createCodexBackendConfigFromConnection({
        host: '127.0.0.1',
        port: '4000',
        token: '',
      }),
    ).toEqual({
      url: 'ws://127.0.0.1:4000',
    })
  })

  it('creates a backend target wrapping the config', () => {
    const config = {
      url: 'ws://127.0.0.1:4000',
    }
    expect(createCodexBackendTarget(config)).toEqual({
      kind: 'codex',
      config,
    })
  })

  it('creates a backend client from config and from connection input', () => {
    const client = createStubClient()
    const createClient = vi.fn((_target: CodexBackendTarget) => client)

    const config = {
      url: 'ws://127.0.0.1:4000',
      headers: { Authorization: 'Bearer secret' },
    }

    expect(createCodexBackendClient(config, { createClient })).toBe(client)
    expect(createClient).toHaveBeenCalledWith({
      kind: 'codex',
      config,
    })

    expect(
      createCodexBackendClientFromConnection(
        {
          host: ' 127.0.0.1 ',
          port: ' 4000 ',
          token: 'secret',
        },
        { createClient },
      ),
    ).toBe(client)

    expect(createClient).toHaveBeenLastCalledWith({
      kind: 'codex',
      config: {
        url: 'ws://127.0.0.1:4000',
        headers: { Authorization: 'Bearer secret' },
      },
    })
  })

  it('validates and warms up the client before resolving connect', async () => {
    const client = createStubClient()
    const list = vi.fn(async () => [])
    client.sessions.list = list
    const createClient = vi.fn(() => client)

    await expect(
      connectCodexBackendClient(
        {
          host: ' 127.0.0.1 ',
          port: ' 4000 ',
          token: 'secret',
          secure: true,
        },
        { createClient },
      ),
    ).resolves.toEqual({
      client,
      connection: {
        host: '127.0.0.1',
        port: '4000',
        token: 'secret',
        secure: true,
      },
      serverLabel: 'wss://127.0.0.1:4000',
    })

    expect(list).toHaveBeenCalledWith()
    expect(createClient).toHaveBeenCalledWith({
      kind: 'codex',
      config: {
        url: 'wss://127.0.0.1:4000',
        headers: { Authorization: 'Bearer secret' },
      },
    })
  })

  it('throws the validation error or upstream warm-up error unchanged', async () => {
    await expect(
      connectCodexBackendClient({
        host: '',
        port: '4000',
      }),
    ).rejects.toThrow('Server host is required.')

    const upstreamError = new Error('warm-up failed')
    const client = createStubClient()
    client.sessions.list = vi.fn(async () => {
      throw upstreamError
    })

    await expect(
      connectCodexBackendClient(
        {
          host: '127.0.0.1',
          port: '4000',
        },
        {
          createClient: () => client,
        },
      ),
    ).rejects.toBe(upstreamError)
  })
})
