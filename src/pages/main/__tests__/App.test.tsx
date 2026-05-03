import '@testing-library/jest-dom'
import { describe, expect, test, vi } from 'vitest'
import { fireEvent, render, getQueriesForElement, waitFor } from '@lynx-js/react/testing-library'

import type {
  BackendClient,
  BackendConnectionSnapshot,
  BackendSubscribeOptions,
  BackendSubscription,
} from '../../../backends/index.js'
import { open } from '../../../navigation.js'
import { App, buildNewSessionScheme, type ReadySignalPayload } from '../App.js'

vi.mock('../../../navigation.js', () => ({ open: vi.fn() }))

const { connectToBackendClientMock, readSavedConnectionWithRetryMock } = vi.hoisted(() => ({
  connectToBackendClientMock: vi.fn(),
  readSavedConnectionWithRetryMock: vi.fn(),
}))

vi.mock('../connection.js', async () => {
  const actual = await vi.importActual<typeof import('../connection.js')>('../connection.js')
  return {
    ...actual,
    connectToBackendClient: connectToBackendClientMock,
    readSavedConnectionWithRetry: readSavedConnectionWithRetryMock,
  }
})
vi.mock('@lynx-js/lynx-ui', async () => {
  const actual = await vi.importActual<typeof import('@lynx-js/lynx-ui')>('@lynx-js/lynx-ui')

  return {
    ...actual,
    KeyboardAwareRoot: ({ children }: { children?: JSX.Element | JSX.Element[] }) => <>{children}</>,
    KeyboardAwareResponder: ({
      children,
      className,
    }: {
      children?: JSX.Element | JSX.Element[]
      className?: string
    }) => <view className={className}>{children}</view>,
    KeyboardAwareTrigger: ({
      children,
      className,
    }: {
      children?: JSX.Element | JSX.Element[]
      className?: string
    }) => <view className={className}>{children}</view>,
  }
})

test('ordered happy path emits react_ready then ui_ready with shared run_id', async () => {
  const onMounted = vi.fn()
  const nowMs = vi.fn()
    .mockReturnValueOnce(101)
    .mockReturnValueOnce(202)
  const readySignalSender = vi.fn()

  render(
    <App
      onMounted={onMounted}
      readyRunId="run-ordered-1"
      readySignalSender={readySignalSender}
      startupDataReady={true}
      nowMs={nowMs}
    />
  )

  expect(onMounted).toHaveBeenCalledTimes(1)

  const { findByText } = getQueriesForElement(elementTree.root!)
  const title = await findByText((_content, element) => {
    return element?.tagName?.toLowerCase() === 'text'
      && element?.getAttribute('class') === 'hero__title'
      && (element?.textContent ?? '') === 'OpenCode'
  })
  const marker = await findByText('main_ready_marker')
  expect(title).toBeInTheDocument()
  expect(marker).toBeInTheDocument()

  expect(readySignalSender).toHaveBeenCalledTimes(2)
  expect(readySignalSender).toHaveBeenNthCalledWith(1, {
    report_id: 'run-ordered-1:react_ready:1',
    run_id: 'run-ordered-1',
    timestamp: 101,
    phase: 'react_ready',
    status: 'ok',
  })
  expect(readySignalSender).toHaveBeenNthCalledWith(2, {
    report_id: 'run-ordered-1:ui_ready:1',
    run_id: 'run-ordered-1',
    timestamp: 202,
    phase: 'ui_ready',
    status: 'ok',
  })
})

test('readiness does not emit when run_id is missing', async () => {
  const onMounted = vi.fn()
  const readySignalSender = vi.fn()

  render(
    <App
      onMounted={onMounted}
      readySignalSender={readySignalSender}
      startupDataReady={true}
      nowMs={() => 303}
    />
  )

  expect(onMounted).toHaveBeenCalledTimes(1)

  const { findByText } = getQueriesForElement(elementTree.root!)
  const marker = await findByText('main_ready_marker')
  expect(marker).toBeInTheDocument()

  expect(readySignalSender).toHaveBeenCalledTimes(0)
})

test('retry contract uses bounded attempts up to 3 and preserves phase ordering', async () => {
  vi.useFakeTimers()

  const onMounted = vi.fn()
  const nowMs = vi.fn()
    .mockReturnValueOnce(100)
    .mockReturnValueOnce(200)
    .mockReturnValueOnce(300)
    .mockReturnValueOnce(400)
    .mockReturnValueOnce(500)
  const readySignalSender = vi.fn((payload: ReadySignalPayload) => {
    if (payload.phase === 'react_ready' && !payload.report_id.endsWith(':3')) {
      throw new Error('react-retry')
    }
    if (payload.phase === 'ui_ready' && !payload.report_id.endsWith(':2')) {
      throw new Error('ui-retry')
    }
  })

  try {
    render(
      <App
        onMounted={onMounted}
        readyRunId="run-retry-1"
        readySignalSender={readySignalSender}
        startupDataReady={true}
        nowMs={nowMs}
      />
    )

    await vi.runAllTimersAsync()

    expect(onMounted).toHaveBeenCalledTimes(1)

    const payloads = readySignalSender.mock.calls.map((entry) => entry[0])
    expect(payloads).toHaveLength(5)

    expect(payloads).toEqual([
      {
        report_id: 'run-retry-1:react_ready:1',
        run_id: 'run-retry-1',
        timestamp: 100,
        phase: 'react_ready',
        status: 'ok',
      },
      {
        report_id: 'run-retry-1:react_ready:2',
        run_id: 'run-retry-1',
        timestamp: 200,
        phase: 'react_ready',
        status: 'ok',
      },
      {
        report_id: 'run-retry-1:react_ready:3',
        run_id: 'run-retry-1',
        timestamp: 300,
        phase: 'react_ready',
        status: 'ok',
      },
      {
        report_id: 'run-retry-1:ui_ready:1',
        run_id: 'run-retry-1',
        timestamp: 400,
        phase: 'ui_ready',
        status: 'ok',
      },
      {
        report_id: 'run-retry-1:ui_ready:2',
        run_id: 'run-retry-1',
        timestamp: 500,
        phase: 'ui_ready',
        status: 'ok',
      },
    ])

    expect(payloads.every((payload) => /:(1|2|3)$/.test(payload.report_id))).toBe(true)
  } finally {
    vi.useRealTimers()
  }
})

describe('buildNewSessionScheme', () => {
  test('encodes connection, isNewSession flag, and known directories', () => {
    const scheme = buildNewSessionScheme(
      { kind: 'opencode', ip: '10.0.0.1', port: '4567', password: 'pw' },
      ['/repo/a', '/repo/b'],
    )

    expect(scheme.startsWith('hybrid://lynxview?bundle=.%2Fchat.lynx.bundle&hide_nav_bar=1&route_params=')).toBe(true)

    const encoded = scheme.split('route_params=')[1]!
    expect(JSON.parse(decodeURIComponent(encoded))).toEqual({
      connection: { kind: 'opencode', ip: '10.0.0.1', port: '4567', password: 'pw' },
      isNewSession: true,
      knownDirectories: ['/repo/a', '/repo/b'],
    })
  })
})

function createSubscription(): BackendSubscription {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    reconnect: vi.fn(),
    getState: vi.fn(
      (): BackendConnectionSnapshot => ({
        status: 'idle',
        retryAttempt: 0,
        nextRetryInMs: null,
        reason: null,
      }),
    ),
    attachAbortSignal: vi.fn(() => () => {}),
  }
}

function createFakeBackendClient(): BackendClient {
  const subscription = createSubscription()
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
      list: vi.fn(async () => [
        {
          backend: 'opencode' as const,
          id: 'session-1',
          title: 'Existing',
          updatedAt: '2026-04-26T01:00:00.000Z',
          directory: '/repo/known-one',
          backendMeta: {},
        },
      ]),
      create: vi.fn(),
      get: vi.fn(),
      messages: vi.fn(),
      prompt: vi.fn(),
    } as unknown as BackendClient['sessions'],
    events: {
      subscribe: vi.fn((options?: BackendSubscribeOptions) => {
        options?.onConnectionStateChange?.({
          status: 'open',
          retryAttempt: 0,
          nextRetryInMs: null,
          reason: null,
        })
        return subscription
      }),
    },
    catalog: {
      providers: vi.fn(),
      agents: vi.fn(),
    } as unknown as NonNullable<BackendClient['catalog']>,
  }
}

test('+ button on connected screen navigates to chat with new-session route params', async () => {
  vi.mocked(open).mockClear()
  readSavedConnectionWithRetryMock.mockResolvedValue({
    kind: 'opencode',
    ip: '10.0.0.1',
    port: '4567',
    password: 'pw',
  })
  const fakeClient = createFakeBackendClient()
  connectToBackendClientMock.mockResolvedValue({
    client: fakeClient,
    connection: { kind: 'opencode', ip: '10.0.0.1', port: '4567', password: 'pw' },
    serverLabel: '10.0.0.1:4567',
  })

  const result = render(
    <App
      onMounted={vi.fn()}
      readyRunId="run-plus-1"
      readySignalSender={vi.fn()}
      startupDataReady={true}
      nowMs={() => 1000}
    />,
  )

  await waitFor(() => {
    expect(result.container.querySelector('.icon-button')).not.toBeNull()
  })

  await waitFor(() => {
    expect(fakeClient.sessions.list).toHaveBeenCalled()
  })

  // Wait for known directories to propagate from SessionListView via callback.
  const button = result.container.querySelector('.icon-button')!
  fireEvent.tap(button)

  expect(open).toHaveBeenCalledTimes(1)
  const scheme = vi.mocked(open).mock.calls[0]![0].scheme
  const encoded = scheme.split('route_params=')[1]!
  expect(JSON.parse(decodeURIComponent(encoded))).toEqual({
    connection: { kind: 'opencode', ip: '10.0.0.1', port: '4567', password: 'pw' },
    isNewSession: true,
    knownDirectories: ['/repo/known-one'],
  })
})

test('no-ready guard emits only react_ready when predicate stays false', async () => {
  const onMounted = vi.fn()
  const readySignalSender = vi.fn()

  render(
    <App
      onMounted={onMounted}
      readyRunId="run-guard-1"
      readySignalSender={readySignalSender}
      startupDataReady={true}
      uiReadyPredicate={() => false}
      nowMs={() => 303}
    />
  )

  expect(onMounted).toHaveBeenCalledTimes(1)

  const { findByText } = getQueriesForElement(elementTree.root!)
  const marker = await findByText('main_ready_marker')
  expect(marker).toBeInTheDocument()

  expect(readySignalSender).toHaveBeenCalledTimes(1)
  expect(readySignalSender).toHaveBeenCalledWith({
    report_id: 'run-guard-1:react_ready:1',
    run_id: 'run-guard-1',
    timestamp: 303,
    phase: 'react_ready',
    status: 'ok',
  })
})
