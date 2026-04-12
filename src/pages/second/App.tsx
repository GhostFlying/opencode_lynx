import { useCallback, useEffect } from '@lynx-js/react'

import { close } from '../../navigation.js'

import './App.css'

const SECOND_READY_MARKER = 'qa_second_ready_marker_v1' as const
const SECOND_CLOSE_ACTION_MARKER = 'qa_second_close_action_v1' as const

function emitRuntimeQaMarker(marker: string) {
  console.info(marker)
  console.info('qa_runtime_marker_v1', marker)
}

export function App(props: { onMounted?: () => void }) {

  useEffect(() => {
    console.info('Hello, OpenCode Lynx second page')
    console.info('lynx.__globalProps', lynx.__globalProps)
    emitRuntimeQaMarker(SECOND_READY_MARKER)
    emitRuntimeQaMarker(SECOND_CLOSE_ACTION_MARKER)
    props.onMounted?.()
  }, [props])

  const onClose = useCallback(() => {
    emitRuntimeQaMarker(SECOND_CLOSE_ACTION_MARKER)
    close()
  }, [])

  

  return (
    <view className="page">
      <view className="App">
        <view className="Banner">
          <text>{SECOND_READY_MARKER}</text>
          <text className="Title">This is the second page</text>
        </view>
        <view className="Content">
          <text className="Button" bindtap={onClose}>
            {SECOND_CLOSE_ACTION_MARKER}
          </text>
          <text className="Button" bindtap={onClose}>
            Close
          </text>
        </view>
      </view>
    </view>
  )
}
