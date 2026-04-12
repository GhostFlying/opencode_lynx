import { describe, expect, it, vi } from 'vitest'

import { OpencodeWrapperError } from '../errors.js'
import {
  createOpencodeNetworkBridgeClient,
  normalizeBridgeError,
} from '../network/bridge-client.js'

function createBridgeFixture() {
  return {
    callAsync: vi.fn(),
    on: vi.fn((_eventName: string, callback: (event: unknown) => void) => callback),
    off: vi.fn(),
  }
}

describe('network bridge client', () => {
  it('resolves request through bridge.callAsync', async () => {
    const bridge = createBridgeFixture()
    bridge.callAsync.mockResolvedValueOnce({
      status_code: 201,
      headers: {
        'content-type': 'application/json',
      },
      body: {
        created: true,
      },
    })

    const client = createOpencodeNetworkBridgeClient({ bridge })

    const response = await client.request({
      path: '/session',
      method: 'POST',
      body: {
        title: 'new',
      },
    })

    expect(bridge.callAsync).toHaveBeenCalledWith(
      'network.request',
      {
        path: '/session',
        method: 'POST',
        body: {
          title: 'new',
        },
      },
      {},
      30_000,
    )

    expect(response).toEqual({
      ok: true,
      status: 201,
      headers: {
        'content-type': 'application/json',
      },
      body: {
        created: true,
      },
    })
  })

  it('opens and closes sse stream with on/off lifecycle parity', async () => {
    const bridge = createBridgeFixture()
    bridge.callAsync.mockResolvedValueOnce({
      stream_id: 'stream-1',
      event_name: 'network.sse.event.stream-1',
    })
    bridge.callAsync.mockResolvedValueOnce({
      closed: true,
    })

    const onEvent = vi.fn()
    const onError = vi.fn()
    const client = createOpencodeNetworkBridgeClient({ bridge })

    const handle = await client.openSseStream(
      {
        path: '/global/event',
      },
      {
        eventName: 'network.sse.event.stream-1',
        onEvent,
        onError,
      },
    )

    expect(handle).toEqual({
      id: 'stream-1',
    })
    expect(bridge.on).toHaveBeenCalledTimes(1)

    const listener = bridge.on.mock.calls[0]?.[1] as ((payload: unknown) => void)
    listener({
      stream_id: 'stream-1',
      type: 'message.part.delta',
    })
    listener({
      stream_id: 'stream-2',
      type: 'message.part.delta',
    })

    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()

    await client.closeSseStream(handle)

    expect(bridge.off).toHaveBeenCalledWith('network.sse.event.stream-1', listener)
    expect(bridge.callAsync).toHaveBeenLastCalledWith(
      'network.sse.close',
      { id: 'stream-1' },
      {},
      30_000,
    )
  })

  it('maps timeout and unavailable to wrapper errors', async () => {
    const timeout = normalizeBridgeError(new Error('Bridge call timeout after 50ms'))
    expect(timeout).toBeInstanceOf(OpencodeWrapperError)
    expect(timeout).toMatchObject({
      kind: 'bridge_timeout',
      retryable: true,
    })

    const unavailable = normalizeBridgeError(new Error('NativeModules is not available. Ensure you are running in a lynx environment.'))
    expect(unavailable).toBeInstanceOf(OpencodeWrapperError)
    expect(unavailable).toMatchObject({
      kind: 'bridge_unavailable',
      retryable: true,
    })

    const bridge = createBridgeFixture()
    bridge.callAsync.mockRejectedValueOnce(new Error('Bridge call timeout after 100ms'))

    const client = createOpencodeNetworkBridgeClient({ bridge })

    await expect(client.request({ path: '/session' })).rejects.toMatchObject({
      name: 'OpencodeNetworkBridgeError',
      kind: 'bridge_timeout',
      retryable: true,
    })
  })
})
