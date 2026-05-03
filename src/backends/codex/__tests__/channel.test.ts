import { describe, expect, it, vi } from 'vitest'

import { openBackendChannel } from '../channel.js'
import type { BackendChannelBridge, ChannelState } from '../channel.js'

interface BridgeFixture {
  bridge: BackendChannelBridge
  callAsync: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  off: ReturnType<typeof vi.fn>
  listeners: Map<string, Set<(event: unknown) => void>>
  emit(eventName: string, payload: unknown): void
}

function createBridgeFixture(): BridgeFixture {
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const callAsync = vi.fn<BackendChannelBridge['callAsync']>()
  const on = vi.fn<BackendChannelBridge['on']>((eventName, callback) => {
    if (!listeners.has(eventName)) listeners.set(eventName, new Set())
    listeners.get(eventName)!.add(callback)
    return callback
  })
  const off = vi.fn<BackendChannelBridge['off']>((eventName, callback) => {
    listeners.get(eventName)?.delete(callback)
  })
  const bridge: BackendChannelBridge = { callAsync, on, off }
  return {
    bridge,
    callAsync,
    on,
    off,
    listeners,
    emit(eventName: string, payload: unknown) {
      const set = listeners.get(eventName)
      if (!set) return
      for (const cb of [...set]) cb(payload)
    },
  }
}

describe('openBackendChannel', () => {
  it('subscribes to both event names BEFORE calling backend.channel.open', async () => {
    const bridge = createBridgeFixture()
    const callOrder: string[] = []
    bridge.on.mockImplementation((eventName: string, callback: (event: unknown) => void) => {
      callOrder.push(`on:${eventName}`)
      const set = bridge.listeners.get(eventName) ?? new Set()
      set.add(callback)
      bridge.listeners.set(eventName, set)
      return callback
    })
    bridge.callAsync.mockImplementation(async (method: string) => {
      callOrder.push(`call:${method}`)
      if (method === 'backend.channel.open') return { channel_id: 'channel-x' }
      return null
    })

    await openBackendChannel({
      url: 'ws://example.com/socket',
      bridge: bridge.bridge,
      randomId: () => 'test-id',
    })

    expect(callOrder).toEqual([
      'on:backend.channel.message.test-id',
      'on:backend.channel.state.test-id',
      'call:backend.channel.open',
    ])
  })

  it('passes the pre-allocated event names and ping interval to native', async () => {
    const bridge = createBridgeFixture()
    bridge.callAsync.mockResolvedValueOnce({ channel_id: 'channel-x' })

    await openBackendChannel({
      url: 'ws://example.com/socket',
      headers: { Authorization: 'Bearer abc' },
      pingIntervalMs: 15_000,
      bridge: bridge.bridge,
      randomId: () => 'rid',
    })

    expect(bridge.callAsync).toHaveBeenCalledWith('backend.channel.open', {
      url: 'ws://example.com/socket',
      headers: { Authorization: 'Bearer abc' },
      message_event_name: 'backend.channel.message.rid',
      state_event_name: 'backend.channel.state.rid',
      ping_interval_ms: 15_000,
    })
  })

  it('fans out message frames to multiple onMessage subscribers', async () => {
    const bridge = createBridgeFixture()
    bridge.callAsync.mockResolvedValueOnce({ channel_id: 'channel-x' })

    const channel = await openBackendChannel({
      url: 'ws://example.com',
      bridge: bridge.bridge,
      randomId: () => 'r1',
    })

    const a = vi.fn()
    const b = vi.fn()
    const unsubscribeA = channel.onMessage(a)
    channel.onMessage(b)

    bridge.emit('backend.channel.message.r1', { frame: { hello: 'world' } })

    expect(a).toHaveBeenCalledWith({ hello: 'world' })
    expect(b).toHaveBeenCalledWith({ hello: 'world' })

    unsubscribeA()
    bridge.emit('backend.channel.message.r1', { frame: { second: true } })

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(2)
  })

  it('maps state events into the unified ChannelState shape', async () => {
    const bridge = createBridgeFixture()
    bridge.callAsync.mockResolvedValueOnce({ channel_id: 'channel-x' })

    const channel = await openBackendChannel({
      url: 'ws://example.com',
      bridge: bridge.bridge,
      randomId: () => 'r1',
    })

    const states: ChannelState[] = []
    channel.onState((s) => states.push(s))

    bridge.emit('backend.channel.state.r1', { state: 'open' })
    bridge.emit('backend.channel.state.r1', {
      state: 'error',
      error: 'tcp reset',
      code: 54,
      reason: 'ECONNRESET',
    })
    bridge.emit('backend.channel.state.r1', { state: 'closed', code: 1000, reason: 'bye' })

    expect(states).toEqual([
      { state: 'open' },
      { state: 'error', error: 'tcp reset', code: 54, reason: 'ECONNRESET' },
      { state: 'closed', code: 1000, reason: 'bye' },
    ])
  })

  it('replays the last state to a late onState subscriber', async () => {
    const bridge = createBridgeFixture()
    bridge.callAsync.mockResolvedValueOnce({ channel_id: 'channel-x' })

    const channel = await openBackendChannel({
      url: 'ws://example.com',
      bridge: bridge.bridge,
      randomId: () => 'r1',
    })

    bridge.emit('backend.channel.state.r1', { state: 'open' })

    const handler = vi.fn()
    channel.onState(handler)

    expect(handler).toHaveBeenCalledWith({ state: 'open' })
  })

  it('routes send through bridge with the channel id', async () => {
    const bridge = createBridgeFixture()
    bridge.callAsync
      .mockResolvedValueOnce({ channel_id: 'channel-x' })
      .mockResolvedValueOnce({ sent: true })

    const channel = await openBackendChannel({
      url: 'ws://example.com',
      bridge: bridge.bridge,
      randomId: () => 'r1',
    })

    await channel.send({ ping: 1 })

    expect(bridge.callAsync).toHaveBeenLastCalledWith('backend.channel.send', {
      channel_id: 'channel-x',
      payload: { ping: 1 },
    })
  })

  it('close calls native and unsubscribes both listeners', async () => {
    const bridge = createBridgeFixture()
    bridge.callAsync
      .mockResolvedValueOnce({ channel_id: 'channel-x' })
      .mockResolvedValueOnce({ closed: true })

    const channel = await openBackendChannel({
      url: 'ws://example.com',
      bridge: bridge.bridge,
      randomId: () => 'r1',
    })

    await channel.close(1000, 'bye')

    expect(bridge.callAsync).toHaveBeenLastCalledWith('backend.channel.close', {
      channel_id: 'channel-x',
      code: 1000,
      reason: 'bye',
    })
    expect(bridge.off).toHaveBeenCalledWith('backend.channel.message.r1', expect.any(Function))
    expect(bridge.off).toHaveBeenCalledWith('backend.channel.state.r1', expect.any(Function))
    expect(bridge.listeners.get('backend.channel.message.r1')?.size ?? 0).toBe(0)
    expect(bridge.listeners.get('backend.channel.state.r1')?.size ?? 0).toBe(0)
  })

  it('close is idempotent and send after close rejects', async () => {
    const bridge = createBridgeFixture()
    bridge.callAsync
      .mockResolvedValueOnce({ channel_id: 'channel-x' })
      .mockResolvedValueOnce({ closed: true })

    const channel = await openBackendChannel({
      url: 'ws://example.com',
      bridge: bridge.bridge,
      randomId: () => 'r1',
    })

    await channel.close()
    await channel.close()
    expect(bridge.callAsync).toHaveBeenCalledTimes(2)

    await expect(channel.send({ x: 1 })).rejects.toThrow(/closed/)
  })

  it('cleans up subscriptions when open fails', async () => {
    const bridge = createBridgeFixture()
    bridge.callAsync.mockRejectedValueOnce(new Error('open boom'))

    await expect(
      openBackendChannel({
        url: 'ws://example.com',
        bridge: bridge.bridge,
        randomId: () => 'r1',
      }),
    ).rejects.toThrow(/open boom/)

    expect(bridge.off).toHaveBeenCalledWith('backend.channel.message.r1', expect.any(Function))
    expect(bridge.off).toHaveBeenCalledWith('backend.channel.state.r1', expect.any(Function))
    expect(bridge.listeners.get('backend.channel.message.r1')?.size ?? 0).toBe(0)
  })

  it('rejects when native open omits a channel_id', async () => {
    const bridge = createBridgeFixture()
    bridge.callAsync.mockResolvedValueOnce({})

    await expect(
      openBackendChannel({
        url: 'ws://example.com',
        bridge: bridge.bridge,
        randomId: () => 'r1',
      }),
    ).rejects.toThrow(/channel_id/)
  })
})
