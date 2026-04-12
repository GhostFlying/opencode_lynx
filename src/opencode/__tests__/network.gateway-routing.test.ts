import { describe, expect, it, vi } from 'vitest'

import { createOpencodeGateway } from '../gateway.js'

class MockEventSource {
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  closed = false

  constructor(readonly url: string) {}

  close(): void {
    this.closed = true
  }

  emitOpen(): void {
    this.onopen?.({} as Event)
  }

  emitMessage(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent)
  }
}

function createSdkClientHarness() {
  let capturedFetch: ((request: Request) => Promise<Response>) | undefined

  const sessionListMock = vi.fn(async () => {
    const fetcher = capturedFetch
    if (!fetcher) {
      throw new Error('SDK fetch bridge was not configured.')
    }

    const response = await fetcher(new Request('https://opencode.example.com/experimental/session', {
      method: 'GET',
    }))

    const payload = await response.json() as { data?: unknown }
    const data = Array.isArray(payload.data) ? payload.data : []

    return { data }
  })

  const createClient = vi.fn((options?: { fetch?: (request: Request) => Promise<Response> }) => {
    capturedFetch = options?.fetch

    return {
      experimental: {
        session: {
          list: sessionListMock,
        },
      },
      session: {
        create: vi.fn(),
        get: vi.fn(),
        messages: vi.fn(),
        prompt: vi.fn(),
      },
    }
  })

  return {
    createClient,
    sessionListMock,
  }
}

async function flushMicrotasks(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve()
  }
}

describe('network gateway routing', () => {
  it('exposes opencode.network namespace for request and sse open/close', async () => {
    const sdk = createSdkClientHarness()
    const networkClient = {
      request: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: {},
        body: { ok: true },
      }),
      openSseStream: vi.fn().mockResolvedValue({ id: 'stream-namespace' }),
      closeSseStream: vi.fn().mockResolvedValue(undefined),
    }

    const gateway = createOpencodeGateway({
      baseUrl: 'https://opencode.example.com',
      workspace: { id: 'default' },
    }, {
      createClient: sdk.createClient,
      createNetworkClient: () => networkClient,
      createEventSource: vi.fn((url: string) => new MockEventSource(url)),
    })

    const requestResult = await gateway.opencode.network.request({
      path: 'https://opencode.example.com/session',
      method: 'GET',
    })
    const streamHandle = await gateway.opencode.network.sse.open({
      path: 'https://opencode.example.com/global/event',
    })
    await gateway.opencode.network.sse.close(streamHandle)

    expect(requestResult).toMatchObject({
      status: 200,
      ok: true,
    })
    expect(streamHandle).toEqual({ id: 'stream-namespace' })
    expect(networkClient.request).toHaveBeenCalledWith({
      path: 'https://opencode.example.com/session',
      method: 'GET',
    }, undefined)
    expect(networkClient.openSseStream).toHaveBeenCalledWith({
      path: 'https://opencode.example.com/global/event',
    }, undefined)
    expect(networkClient.closeSseStream).toHaveBeenCalledWith({ id: 'stream-namespace' }, undefined)
  })

  it('routes sessions and sse via native bridge', async () => {
    const sdk = createSdkClientHarness()
    const networkClient = {
      request: vi.fn().mockResolvedValue({
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          data: [
            {
              id: 'session-native',
              title: 'Native Session',
              status: 'idle',
            },
          ],
        }),
      }),
      openSseStream: vi.fn().mockImplementation(async (_input: unknown, options?: { onEvent?: (payload: unknown) => void }) => {
        queueMicrotask(() => {
          options?.onEvent?.({
            stream_id: 'stream-native',
            type: 'message.updated',
            properties: {
              sessionID: 'session-native',
              messageID: 'message-1',
            },
          })
        })

        return {
          id: 'stream-native',
        }
      }),
      closeSseStream: vi.fn().mockResolvedValue(undefined),
    }

    const gateway = createOpencodeGateway({
      baseUrl: 'https://opencode.example.com',
      directory: '/repo/default',
      workspace: { id: 'default' },
    }, {
      createClient: sdk.createClient,
      createNetworkClient: () => networkClient,
    })

    const sessions = await gateway.sessions.list()

    expect(sessions[0]).toMatchObject({
      id: 'session-native',
      title: 'Native Session',
    })
    expect(networkClient.request).toHaveBeenCalledTimes(1)
    expect(networkClient.request.mock.calls[0]?.[0]).toMatchObject({
      path: 'https://opencode.example.com/experimental/session',
      method: 'GET',
    })
    expect(networkClient.request.mock.calls[0]?.[1]).toMatchObject({
      abortSignal: expect.any(AbortSignal),
    })

    const streamedEvent = new Promise<{ type: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('timed out waiting for native SSE event'))
      }, 1_000)

      gateway.events.subscribe({
        onEvent: event => {
          clearTimeout(timer)
          resolve(event)
        },
      })
    })

    const event = await streamedEvent
    expect(event.type).toBe('message.updated')
    expect(networkClient.openSseStream).toHaveBeenCalledTimes(1)

    const subscription = gateway.events.subscribe({ autoStart: true })
    await flushMicrotasks()
    subscription.stop('done')

    expect(networkClient.closeSseStream).toHaveBeenCalledWith({ id: 'stream-native' })
  })
})
