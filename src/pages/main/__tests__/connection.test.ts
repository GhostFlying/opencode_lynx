import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { storageGetMock, storageSetMock, storageRemoveMock } = vi.hoisted(() => ({
  storageGetMock: vi.fn<(key: string) => Promise<string | null>>(),
  storageSetMock: vi.fn<(key: string, value: string) => Promise<void>>(),
  storageRemoveMock: vi.fn<(key: string) => Promise<void>>(),
}))

vi.mock('../../../storage.js', () => ({
  storageGet: storageGetMock,
  storageSet: storageSetMock,
  storageRemove: storageRemoveMock,
}))

import type {
  ConnectCodexBackendClientResult,
} from '../../../backends/codex/page-migration.js'
import type {
  ConnectOpencodeBackendClientResult,
} from '../../../backends/opencode/page-migration.js'
import type { BackendClient } from '../../../backends/index.js'
import {
  cloneConnection,
  connectToBackendClient,
  defaultConnection,
  defaultConnectionForKind,
  formatEndpoint,
  formatServerLabel,
  isCodexConnection,
  isOpencodeConnection,
  maskCredential,
  normalizeConnection,
  readSavedConnection,
  saveConnection,
  validateConnection,
} from '../connection.js'

const STORAGE_KEY = 'backend_connection'
const LEGACY_STORAGE_KEY = 'opencode_connection'

beforeEach(() => {
  storageGetMock.mockReset()
  storageSetMock.mockReset()
  storageRemoveMock.mockReset()
  storageSetMock.mockResolvedValue()
  storageRemoveMock.mockResolvedValue()
})

afterEach(() => {
  vi.useRealTimers()
})

function fakeClient(): BackendClient {
  return {
    descriptor: { kind: 'opencode', label: 'fake' },
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
    sessions: {} as unknown as BackendClient['sessions'],
    events: { subscribe: () => ({}) as never },
  } as unknown as BackendClient
}

describe('defaultConnectionForKind', () => {
  test('returns opencode defaults', () => {
    const c = defaultConnectionForKind('opencode')
    expect(c).toEqual({
      kind: 'opencode',
      ip: '127.0.0.1',
      port: '3000',
      password: '',
    })
  })

  test('returns codex defaults', () => {
    const c = defaultConnectionForKind('codex')
    expect(c).toEqual({
      kind: 'codex',
      host: '127.0.0.1',
      port: '7777',
      token: '',
      secure: false,
    })
  })

  test('defaultConnection() returns opencode shape', () => {
    expect(defaultConnection()).toEqual(defaultConnectionForKind('opencode'))
  })
})

describe('type guards', () => {
  test('isOpencodeConnection narrows correctly', () => {
    expect(isOpencodeConnection(defaultConnectionForKind('opencode'))).toBe(true)
    expect(isOpencodeConnection(defaultConnectionForKind('codex'))).toBe(false)
  })

  test('isCodexConnection narrows correctly', () => {
    expect(isCodexConnection(defaultConnectionForKind('codex'))).toBe(true)
    expect(isCodexConnection(defaultConnectionForKind('opencode'))).toBe(false)
  })
})

describe('cloneConnection', () => {
  test('opencode clone preserves shape and is independent', () => {
    const source = defaultConnectionForKind('opencode')
    const clone = cloneConnection(source)
    expect(clone).toEqual(source)
    expect(clone).not.toBe(source)
  })

  test('codex clone preserves shape and is independent', () => {
    const source = defaultConnectionForKind('codex')
    const clone = cloneConnection(source)
    expect(clone).toEqual(source)
    expect(clone).not.toBe(source)
  })
})

describe('normalizeConnection', () => {
  test('opencode trims ip and port but preserves password', () => {
    const trimmed = normalizeConnection({
      kind: 'opencode',
      ip: '  10.0.0.1  ',
      port: ' 3000 ',
      password: '  pw ',
    })
    expect(trimmed).toEqual({
      kind: 'opencode',
      ip: '10.0.0.1',
      port: '3000',
      password: '  pw ',
    })
  })

  test('codex trims host, port, token; preserves secure', () => {
    const trimmed = normalizeConnection({
      kind: 'codex',
      host: '  example.com  ',
      port: ' 7777 ',
      token: ' tok ',
      secure: true,
    })
    expect(trimmed).toEqual({
      kind: 'codex',
      host: 'example.com',
      port: '7777',
      token: 'tok',
      secure: true,
    })
  })
})

describe('formatServerLabel / formatEndpoint', () => {
  test('opencode format', () => {
    const c = { kind: 'opencode', ip: '127.0.0.1', port: '3000', password: '' } as const
    expect(formatServerLabel(c)).toBe('127.0.0.1:3000')
    expect(formatEndpoint(c)).toBe('http://127.0.0.1:3000')
  })

  test('codex insecure → ws', () => {
    const c = {
      kind: 'codex',
      host: 'example.com',
      port: '7777',
      token: '',
      secure: false,
    } as const
    expect(formatServerLabel(c)).toBe('ws://example.com:7777')
    expect(formatEndpoint(c)).toBe('ws://example.com:7777')
  })

  test('codex secure → wss', () => {
    const c = {
      kind: 'codex',
      host: 'example.com',
      port: '7777',
      token: '',
      secure: true,
    } as const
    expect(formatServerLabel(c)).toBe('wss://example.com:7777')
  })
})

describe('maskCredential', () => {
  test('opencode masks password', () => {
    expect(
      maskCredential({
        kind: 'opencode',
        ip: '127.0.0.1',
        port: '3000',
        password: 'abcd',
      }),
    ).toBe('••••')
  })

  test('codex masks token', () => {
    expect(
      maskCredential({
        kind: 'codex',
        host: '127.0.0.1',
        port: '7777',
        token: 'abcd',
        secure: false,
      }),
    ).toBe('••••')
  })

  test('empty credential renders Not set', () => {
    expect(
      maskCredential({
        kind: 'opencode',
        ip: '127.0.0.1',
        port: '3000',
        password: '',
      }),
    ).toBe('Not set')
  })
})

describe('validateConnection', () => {
  test('opencode happy path', () => {
    expect(
      validateConnection({
        kind: 'opencode',
        ip: '127.0.0.1',
        port: '3000',
        password: '',
      }),
    ).toBeNull()
  })

  test('opencode rejects empty ip', () => {
    expect(
      validateConnection({
        kind: 'opencode',
        ip: '',
        port: '3000',
        password: '',
      }),
    ).toMatch(/ip is required/i)
  })

  test('opencode rejects out-of-range port', () => {
    expect(
      validateConnection({
        kind: 'opencode',
        ip: '127.0.0.1',
        port: '70000',
        password: '',
      }),
    ).toMatch(/port/i)
  })

  test('codex happy path', () => {
    expect(
      validateConnection({
        kind: 'codex',
        host: '127.0.0.1',
        port: '7777',
        token: '',
        secure: false,
      }),
    ).toBeNull()
  })

  test('codex rejects empty host', () => {
    expect(
      validateConnection({
        kind: 'codex',
        host: '',
        port: '7777',
        token: '',
        secure: false,
      }),
    ).toMatch(/host is required/i)
  })

  test('codex rejects bogus port', () => {
    expect(
      validateConnection({
        kind: 'codex',
        host: '127.0.0.1',
        port: 'abc',
        token: '',
        secure: false,
      }),
    ).toMatch(/port/i)
  })
})

describe('readSavedConnection', () => {
  test('returns null when neither key set', async () => {
    storageGetMock.mockResolvedValue(null)
    expect(await readSavedConnection()).toBeNull()
    expect(storageGetMock).toHaveBeenCalledWith(STORAGE_KEY)
    expect(storageGetMock).toHaveBeenCalledWith(LEGACY_STORAGE_KEY)
  })

  test('legacy opencode_connection migrates to backend_connection and removes legacy', async () => {
    const legacyPayload = JSON.stringify({
      ip: '10.0.0.1',
      port: '4567',
      password: 'pw',
    })

    storageGetMock.mockImplementation(async (key: string) => {
      if (key === STORAGE_KEY) return null
      if (key === LEGACY_STORAGE_KEY) return legacyPayload
      return null
    })

    const result = await readSavedConnection()
    expect(result).toEqual({
      kind: 'opencode',
      ip: '10.0.0.1',
      port: '4567',
      password: 'pw',
    })

    expect(storageSetMock).toHaveBeenCalledWith(
      STORAGE_KEY,
      JSON.stringify({
        kind: 'opencode',
        ip: '10.0.0.1',
        port: '4567',
        password: 'pw',
      }),
    )
    expect(storageRemoveMock).toHaveBeenCalledWith(LEGACY_STORAGE_KEY)
  })

  test('migration does not remove legacy when storageSet rejects', async () => {
    const legacyPayload = JSON.stringify({
      ip: '10.0.0.1',
      port: '4567',
      password: 'pw',
    })

    storageGetMock.mockImplementation(async (key: string) => {
      if (key === STORAGE_KEY) return null
      if (key === LEGACY_STORAGE_KEY) return legacyPayload
      return null
    })
    storageSetMock.mockRejectedValueOnce(new Error('disk full'))

    const result = await readSavedConnection()
    expect(result).toEqual({
      kind: 'opencode',
      ip: '10.0.0.1',
      port: '4567',
      password: 'pw',
    })

    expect(storageRemoveMock).not.toHaveBeenCalled()
  })

  test('returns parsed union when backend_connection already migrated (opencode)', async () => {
    storageGetMock.mockImplementation(async (key: string) => {
      if (key === STORAGE_KEY) {
        return JSON.stringify({
          kind: 'opencode',
          ip: '10.0.0.1',
          port: '4567',
          password: 'pw',
        })
      }
      return null
    })

    const result = await readSavedConnection()
    expect(result).toEqual({
      kind: 'opencode',
      ip: '10.0.0.1',
      port: '4567',
      password: 'pw',
    })
    expect(storageSetMock).not.toHaveBeenCalled()
    expect(storageRemoveMock).not.toHaveBeenCalled()
  })

  test('returns parsed codex union when already migrated', async () => {
    storageGetMock.mockImplementation(async (key: string) => {
      if (key === STORAGE_KEY) {
        return JSON.stringify({
          kind: 'codex',
          host: 'example.com',
          port: '7777',
          token: 'tok',
          secure: true,
        })
      }
      return null
    })

    const result = await readSavedConnection()
    expect(result).toEqual({
      kind: 'codex',
      host: 'example.com',
      port: '7777',
      token: 'tok',
      secure: true,
    })
  })

  test('corrupt JSON in backend_connection falls back to legacy lookup', async () => {
    storageGetMock.mockImplementation(async (key: string) => {
      if (key === STORAGE_KEY) return '{not-json'
      if (key === LEGACY_STORAGE_KEY) return null
      return null
    })

    expect(await readSavedConnection()).toBeNull()
  })

  test('corrupt JSON in both keys returns null', async () => {
    storageGetMock.mockImplementation(async (key: string) => {
      if (key === STORAGE_KEY) return '{bad'
      if (key === LEGACY_STORAGE_KEY) return 'also-bad'
      return null
    })

    expect(await readSavedConnection()).toBeNull()
  })
})

describe('saveConnection', () => {
  test('writes union JSON under backend_connection', () => {
    saveConnection({
      kind: 'codex',
      host: 'example.com',
      port: '7777',
      token: 'tok',
      secure: true,
    })

    expect(storageSetMock).toHaveBeenCalledWith(
      STORAGE_KEY,
      JSON.stringify({
        kind: 'codex',
        host: 'example.com',
        port: '7777',
        token: 'tok',
        secure: true,
      }),
    )
  })
})

describe('connectToBackendClient', () => {
  test('opencode dispatches through connectOpencode option', async () => {
    const result: ConnectOpencodeBackendClientResult = {
      client: fakeClient(),
      connection: {
        ip: '127.0.0.1',
        port: '3000',
        password: 'pw',
      },
      serverLabel: '127.0.0.1:3000',
    }
    const connectOpencode = vi.fn(async () => result)
    const connectCodex = vi.fn()

    const out = await connectToBackendClient(
      {
        kind: 'opencode',
        ip: '127.0.0.1',
        port: '3000',
        password: 'pw',
      },
      { connectOpencode, connectCodex },
    )

    expect(connectOpencode).toHaveBeenCalledTimes(1)
    expect(connectCodex).not.toHaveBeenCalled()
    expect(out.connection).toEqual({
      kind: 'opencode',
      ip: '127.0.0.1',
      port: '3000',
      password: 'pw',
    })
    expect(out.serverLabel).toBe('127.0.0.1:3000')
    expect(storageSetMock).toHaveBeenCalledWith(
      STORAGE_KEY,
      JSON.stringify(out.connection),
    )
  })

  test('codex dispatches through connectCodex option', async () => {
    const result: ConnectCodexBackendClientResult = {
      client: fakeClient(),
      connection: {
        host: 'example.com',
        port: '7777',
        token: 'tok',
        secure: true,
      },
      serverLabel: 'wss://example.com:7777',
    }
    const connectOpencode = vi.fn()
    const connectCodex = vi.fn(async () => result)

    const out = await connectToBackendClient(
      {
        kind: 'codex',
        host: 'example.com',
        port: '7777',
        token: 'tok',
        secure: true,
      },
      { connectOpencode, connectCodex },
    )

    expect(connectCodex).toHaveBeenCalledTimes(1)
    expect(connectOpencode).not.toHaveBeenCalled()
    expect(out.connection).toEqual({
      kind: 'codex',
      host: 'example.com',
      port: '7777',
      token: 'tok',
      secure: true,
    })
    expect(out.serverLabel).toBe('wss://example.com:7777')
    expect(storageSetMock).toHaveBeenCalledWith(
      STORAGE_KEY,
      JSON.stringify(out.connection),
    )
  })
})
