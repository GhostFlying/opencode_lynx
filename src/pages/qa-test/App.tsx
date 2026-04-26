import { useCallback, useEffect, useState } from '@lynx-js/react'

import { open } from '../../navigation.js'

import './App.css'

const MAIN_READY_MARKER = 'qa_main_ready_marker_v1' as const
const OPEN_SECOND_PAGE_ACTION_MARKER = 'qa_open_second_page_action_v1' as const
const MAIN_READY_SIGNAL_MARKER_PREFIX = 'qa_main_ready_signal_v1' as const

const SECOND_PAGE_SCHEME =
  'hybrid://lynxview_page?bundle=second.lynx.bundle&title=Second%20Page&screen_orientation=portrait'

type ReadyPhase = 'react_ready' | 'ui_ready'

function readySeqForPhase(phase: ReadyPhase): 1 | 2 {
  return phase === 'react_ready' ? 1 : 2
}

function toReadySignalMarker(phase: ReadyPhase, runId: string): string {
  return `${MAIN_READY_SIGNAL_MARKER_PREFIX}|phase=${phase}|seq=${readySeqForPhase(phase)}|run_id=${runId}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readRunIdFromGlobalProps(): string {
  if (typeof lynx === 'undefined') {
    return 'qa_test_default_run'
  }

  const globalProps = lynx.__globalProps
  if (!isRecord(globalProps)) {
    return 'qa_test_default_run'
  }

  const directRunId = globalProps.run_id
  if (typeof directRunId === 'string' && directRunId.trim().length > 0) {
    return directRunId.trim()
  }

  const queryItems = globalProps.queryItems
  if (isRecord(queryItems)) {
    const queryRunId = queryItems.run_id
    if (typeof queryRunId === 'string' && queryRunId.trim().length > 0) {
      return queryRunId.trim()
    }
  }

  return 'qa_test_default_run'
}

function emitRuntimeQaMarker(marker: string) {
  console.info(marker)
  console.info('qa_runtime_marker_v1', marker)
}

export function App() {
  const [signals, setSignals] = useState<{ react_ready?: string; ui_ready?: string }>({})
  const runId = readRunIdFromGlobalProps()

  useEffect(() => {
    'background only'
    emitRuntimeQaMarker(MAIN_READY_MARKER)
    emitRuntimeQaMarker(OPEN_SECOND_PAGE_ACTION_MARKER)

    const reactReadySignal = toReadySignalMarker('react_ready', runId)
    const uiReadySignal = toReadySignalMarker('ui_ready', runId)
    emitRuntimeQaMarker(reactReadySignal)
    emitRuntimeQaMarker(uiReadySignal)
    setSignals({ react_ready: reactReadySignal, ui_ready: uiReadySignal })
  }, [runId])

  const onOpenSecondPage = useCallback(() => {
    'background only'
    emitRuntimeQaMarker(OPEN_SECOND_PAGE_ACTION_MARKER)
    open({ scheme: SECOND_PAGE_SCHEME })
  }, [])

  return (
    <view className="page">
      <view className="App">
        <view className="Header">
          <text className="Title">QA Test Page</text>
          <text className="Subtitle">Run ID: {runId}</text>
        </view>

        <view className="Markers">
          <text className="Marker">{MAIN_READY_MARKER}</text>
          {signals.react_ready ? <text className="Marker">{signals.react_ready}</text> : null}
          {signals.ui_ready ? <text className="Marker">{signals.ui_ready}</text> : null}
        </view>

        <view className="Content">
          <text className="Button" bindtap={onOpenSecondPage}>
            {OPEN_SECOND_PAGE_ACTION_MARKER}
          </text>
        </view>
      </view>
    </view>
  )
}
