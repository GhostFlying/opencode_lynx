import '@testing-library/jest-dom'
import { expect, test, vi } from 'vitest'
import { render, getQueriesForElement } from '@lynx-js/react/testing-library'

import { App, type ReadySignalPayload } from '../App.js'

vi.mock('../../navigation.js', () => ({ open: vi.fn() }))
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
  const title = await findByText('OpenCode')
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
