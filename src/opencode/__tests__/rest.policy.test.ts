import { describe, expect, it, vi } from 'vitest'

import { createWrappedSdkClient } from '../client.js'
import { OpencodeWrapperError } from '../errors.js'

describe('rest policy wrapper', () => {
  it('creates sdk client with normalized baseUrl + auth + default directory', () => {
    const createClientMock = vi.fn(() => ({
      session: {
        list: vi.fn(),
      },
    }))

    createWrappedSdkClient({
      baseUrl: 'https://opencode.example.com/',
      auth: 'token-abc',
      directory: '/repo/default',
      workspace: { id: 'default' },
      headers: {
        'x-policy': 'enabled',
      },
    }, {
      createClient: createClientMock,
    })

    expect(createClientMock).toHaveBeenCalledWith({
      baseUrl: 'https://opencode.example.com',
      auth: 'token-abc',
      directory: '/repo/default',
      headers: {
        'x-policy': 'enabled',
      },
      fetch: expect.any(Function),
    })
  })

  it('builds deterministic normalized request options from scope overrides', () => {
    const createClientMock = vi.fn(() => ({
      session: {
        list: vi.fn(),
      },
    }))

    const wrapped = createWrappedSdkClient({
      baseUrl: 'https://opencode.example.com',
      auth: 'token-abc',
      directory: '/repo/default',
      headers: {
        'x-policy': 'enabled',
      },
    }, {
      createClient: createClientMock,
    })

    expect(wrapped.createRequestOptions()).toEqual({
      directory: '/repo/default',
      workspace: 'default',
      headers: {
        'x-policy': 'enabled',
      },
    })

    expect(
      wrapped.createRequestOptions({
        directory: '/repo/override',
        workspace: { id: 'default' },
      }),
    ).toEqual({
      directory: '/repo/override',
      workspace: 'default',
      headers: {
        'x-policy': 'enabled',
      },
    })
  })

  it('normalizes sdk-facing failures through wrapper error contract', async () => {
    const createClientMock = vi.fn(() => ({
      session: {
        list: vi.fn(),
      },
    }))

    const wrapped = createWrappedSdkClient({
      baseUrl: 'https://opencode.example.com',
      auth: 'token-abc',
      directory: '/repo/default',
    }, {
      createClient: createClientMock,
    })

    const sdkFailure = Object.assign(new Error('request failed'), { status: 503 })

    await expect(
      wrapped.request(async () => {
        throw sdkFailure
      }),
    ).rejects.toBeInstanceOf(OpencodeWrapperError)

    await expect(
      wrapped.request(async () => {
        throw sdkFailure
      }),
    ).rejects.toMatchObject({
      name: 'OpencodeWrapperError',
      code: 'sdk_request_failed',
      status: 503,
      retryable: true,
      message: 'OpenCode SDK request failed: request failed',
      cause: sdkFailure,
    })
  })
})
