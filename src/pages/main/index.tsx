import { root } from '@lynx-js/react'

import { App } from './App.js'

function readRootReadyRunId(): string | undefined {
  if (typeof lynx === 'undefined') {
    return 'main-entry-ready-run'
  }

  const globalProps = lynx.__globalProps as Record<string, unknown> | null | undefined
  const direct = typeof globalProps?.run_id === 'string' ? globalProps.run_id.trim() : ''
  if (direct.length > 0) {
    return direct
  }

  const queryItems = globalProps?.queryItems as Record<string, unknown> | null | undefined
  const fromQuery = typeof queryItems?.run_id === 'string' ? queryItems.run_id.trim() : ''
  if (fromQuery.length > 0) {
    return fromQuery
  }

  return 'main-entry-ready-run'
}

root.render(<App readyRunId={readRootReadyRunId()} />)

if (import.meta.webpackHot) {
  import.meta.webpackHot.accept()
}
