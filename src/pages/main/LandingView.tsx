import { useCallback } from '@lynx-js/react'

import { ConnectionForm } from './ConnectionForm.js'
import type { ConnectionAttemptResult, ConnectionContext, ConnectionFormStatus } from './connection.js'

export interface LandingViewProps {
  connection: ConnectionContext
  status: ConnectionFormStatus
  errorMessage?: string
  onChange: (next: ConnectionContext) => void
  onSubmit: () => void
  onConnected?: (result: ConnectionAttemptResult) => void
}

export function LandingView({
  connection,
  status,
  errorMessage = '',
  onChange,
  onSubmit,
}: LandingViewProps) {
  const handleConnect = useCallback(() => {
    'background only'
    onSubmit()
  }, [onSubmit])

  return (
    <view className="landing-shell">
      <view className="landing-note">
        <text className="landing-note__eyebrow">OpenCode mobile</text>
        <text className="landing-note__title">Keep your sessions close.</text>
        <text className="landing-note__body">
          A lighter, calmer client for checking recent work, reconnecting fast, and jumping back into the right thread.
        </text>
      </view>

      <view className="landing-panel">
        <view className="landing-panel__header">
          <text className="landing-panel__title">Connect to your server</text>
        </view>

        <ConnectionForm
          connection={connection}
          status={status}
          errorMessage={errorMessage}
          primaryLabel={status === 'error' ? 'Retry connection' : 'Connect'}
          onChange={onChange}
          onPrimaryAction={handleConnect}
        />
      </view>
    </view>
  )
}
