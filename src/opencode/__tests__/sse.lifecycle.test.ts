import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  computeSseBackoffDelay,
  createSseLifecycleManager,
} from '../events.js'

class MockEventSource {
  public onopen: ((event: unknown) => void) | null = null
  public onerror: ((event: unknown) => void) | null = null
  public onmessage: ((event: unknown) => void) | null = null
  public readonly close = vi.fn()

  constructor(public readonly url: string) {}

  emitOpen(event: unknown = { type: 'open' }): void {
    this.onopen?.(event)
  }

  emitError(error: unknown = { type: 'error' }): void {
    this.onerror?.(error)
  }
}

function createHarness() {
  const sources: MockEventSource[] = []

  const createEventSource = vi.fn((url: string) => {
    const source = new MockEventSource(url)
    sources.push(source)
    return source
  })

  return {
    sources,
    createEventSource,
  }
}

describe('sse lifecycle manager', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('computes deterministic capped backoff delays', () => {
    const policy = {
      initialDelayMs: 100,
      multiplier: 2,
      maxDelayMs: 250,
      maxRetries: 5,
    }

    expect(computeSseBackoffDelay(1, policy)).toBe(100)
    expect(computeSseBackoffDelay(2, policy)).toBe(200)
    expect(computeSseBackoffDelay(3, policy)).toBe(250)
    expect(computeSseBackoffDelay(99, policy)).toBe(250)
  })

  it('emits lifecycle transitions and reconnects with deterministic schedule', () => {
    vi.useFakeTimers()

    const { sources, createEventSource } = createHarness()
    const states: string[] = []

    const manager = createSseLifecycleManager({
      streamURL: 'https://opencode.example.com/global/event?directory=%2Frepo',
      reconnect: {
        initialDelayMs: 100,
        multiplier: 2,
        maxDelayMs: 250,
        maxRetries: 5,
      },
      createEventSource,
    })

    manager.subscribe(state => {
      states.push(`${state.status}:${state.retryAttempt}:${state.nextRetryInMs ?? 'none'}`)
    })

    manager.start()
    expect(createEventSource).toHaveBeenCalledTimes(1)
    expect(sources[0]?.url).toContain('/global/event')

    sources[0]?.emitOpen()
    sources[0]?.emitError('drop-1')
    expect(sources[0]?.close).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(100)
    expect(createEventSource).toHaveBeenCalledTimes(2)

    sources[1]?.emitError('drop-2')
    vi.advanceTimersByTime(200)
    expect(createEventSource).toHaveBeenCalledTimes(3)

    sources[2]?.emitError('drop-3')
    vi.advanceTimersByTime(250)
    expect(createEventSource).toHaveBeenCalledTimes(4)

    sources[3]?.emitOpen()

    expect(states).toEqual([
      'idle:0:none',
      'connecting:0:none',
      'open:0:none',
      'reconnecting:1:100',
      'connecting:1:none',
      'reconnecting:2:200',
      'connecting:2:none',
      'reconnecting:3:250',
      'connecting:3:none',
      'open:0:none',
    ])
  })

  it('transitions to failed after retry budget is exhausted', () => {
    vi.useFakeTimers()

    const { sources, createEventSource } = createHarness()

    const manager = createSseLifecycleManager({
      streamURL: 'https://opencode.example.com/global/event?directory=%2Frepo',
      reconnect: {
        initialDelayMs: 50,
        multiplier: 2,
        maxDelayMs: 100,
        maxRetries: 2,
      },
      createEventSource,
    })

    manager.start()
    sources[0]?.emitError('drop-1')
    vi.advanceTimersByTime(50)

    sources[1]?.emitError('drop-2')
    vi.advanceTimersByTime(100)

    sources[2]?.emitError('drop-3')

    expect(manager.getState()).toMatchObject({
      status: 'failed',
      retryAttempt: 2,
      nextRetryInMs: null,
    })

    vi.advanceTimersByTime(5_000)
    expect(createEventSource).toHaveBeenCalledTimes(3)
  })

  it('stop/abort cancels pending retries and prevents reconnect leaks', () => {
    vi.useFakeTimers()

    const { sources, createEventSource } = createHarness()
    const manager = createSseLifecycleManager({
      streamURL: 'https://opencode.example.com/global/event?directory=%2Frepo',
      reconnect: {
        initialDelayMs: 100,
        multiplier: 2,
        maxDelayMs: 500,
        maxRetries: 5,
      },
      createEventSource,
    })

    manager.start()
    sources[0]?.emitError('drop-1')
    manager.stop('manual-stop')

    expect(manager.getState()).toMatchObject({
      status: 'stopped',
      retryAttempt: 0,
      nextRetryInMs: null,
      reason: 'manual-stop',
    })

    vi.advanceTimersByTime(5_000)
    expect(createEventSource).toHaveBeenCalledTimes(1)

    manager.start()
    const controller = new AbortController()
    manager.attachAbortSignal(controller.signal)
    sources[1]?.emitError('drop-2')
    controller.abort()

    expect(manager.getState()).toMatchObject({
      status: 'stopped',
      retryAttempt: 0,
      nextRetryInMs: null,
      reason: 'abort',
    })

    vi.advanceTimersByTime(5_000)
    expect(createEventSource).toHaveBeenCalledTimes(2)
  })

  it('ignores stale source errors after reconnect to avoid close-race retries', () => {
    vi.useFakeTimers()

    const { sources, createEventSource } = createHarness()
    const manager = createSseLifecycleManager({
      streamURL: 'https://opencode.example.com/global/event?directory=%2Frepo',
      reconnect: {
        initialDelayMs: 100,
        multiplier: 2,
        maxDelayMs: 500,
        maxRetries: 5,
      },
      createEventSource,
    })

    manager.start()
    sources[0]?.emitError('drop-1')
    vi.advanceTimersByTime(100)

    expect(createEventSource).toHaveBeenCalledTimes(2)

    sources[1]?.emitOpen()
    expect(manager.getState()).toMatchObject({
      status: 'open',
      retryAttempt: 0,
      nextRetryInMs: null,
    })

    sources[0]?.emitError('late-stale-error')
    vi.advanceTimersByTime(1_000)

    expect(createEventSource).toHaveBeenCalledTimes(2)
    expect(manager.getState()).toMatchObject({
      status: 'open',
      retryAttempt: 0,
      nextRetryInMs: null,
    })
  })

  it('suppresses late close-race errors after stop', () => {
    vi.useFakeTimers()

    const { sources, createEventSource } = createHarness()
    const manager = createSseLifecycleManager({
      streamURL: 'https://opencode.example.com/global/event?directory=%2Frepo',
      reconnect: {
        initialDelayMs: 100,
        multiplier: 2,
        maxDelayMs: 500,
        maxRetries: 5,
      },
      createEventSource,
    })

    manager.start()
    sources[0]?.emitError('drop-1')
    manager.stop('manual-stop')

    sources[0]?.emitError('late-error-after-stop')
    vi.advanceTimersByTime(5_000)

    expect(createEventSource).toHaveBeenCalledTimes(1)
    expect(manager.getState()).toMatchObject({
      status: 'stopped',
      retryAttempt: 0,
      nextRetryInMs: null,
      reason: 'manual-stop',
    })
  })
})
