import { useCallback } from '@lynx-js/react'
import { Button, KeyboardAwareResponder } from '@lynx-js/lynx-ui'

import { ConnectionForm } from './ConnectionForm.js'
import {
  formatEndpoint,
  isOpencodeConnection,
  maskCredential,
} from './connection.js'
import type {
  ConnectionContext,
  ConnectionFormStatus,
  ConnectionTag,
} from './connection.js'

function px(value: number): string {
  if (!Number.isFinite(value) || value === 0) {
    return '0'
  }
  return `${value}px`
}

export interface SettingsViewProps {
  connection: ConnectionContext
  status: ConnectionFormStatus
  errorMessage?: string
  connectionTag: ConnectionTag
  onChange: (next: ConnectionContext) => void
  onReconnect: () => void
  onDisconnect: () => void
  header?: JSX.Element
  contentInsetBottom?: number
}

export function SettingsView({
  connection,
  status,
  errorMessage = '',
  connectionTag,
  onChange,
  onReconnect,
  onDisconnect,
  header,
  contentInsetBottom = 146,
}: SettingsViewProps) {
  const handleReconnect = useCallback(() => {
    'background only'
    onReconnect()
  }, [onReconnect])

  const handleDisconnect = useCallback(() => {
    'background only'
    onDisconnect()
  }, [onDisconnect])

  return (
    <KeyboardAwareResponder
      as="ScrollView"
      scrollviewId="settings-scroll"
      className="settings-scroll"
    >
      <view className="settings-stack" style={{ paddingBottom: px(contentInsetBottom) }}>
        {header}

        <view className="settings-card">
          <view className="settings-card__header">
            <view>
              <text className="settings-card__title">Current endpoint</text>
              <text className="settings-card__body">Connection details live here instead of the header, so the main view can stay quiet.</text>
            </view>
          </view>

          <view className="meta-list">
            <view className="meta-row">
              <text className="meta-row__label">Address</text>
              <text className="meta-row__value">{formatEndpoint(connection)}</text>
            </view>
            <view className="meta-row">
              <text className="meta-row__label">{isOpencodeConnection(connection) ? 'Password' : 'Token'}</text>
              <text className="meta-row__value">{maskCredential(connection)}</text>
            </view>
          </view>

          <ConnectionForm
            compact={true}
            connection={connection}
            status={status}
            errorMessage={errorMessage}
            primaryLabel="Reconnect"
            secondaryLabel="Disconnect"
            onChange={onChange}
            onPrimaryAction={handleReconnect}
            onSecondaryAction={handleDisconnect}
          />
        </view>

        <view className="settings-card settings-card--subtle">
          <text className="settings-card__title">Secret Pocket</text>
          <text className="settings-card__body">
            You made it to the quietest corner of the client. No treasure chest yet, but this
            spot is officially reserved for future mischief.
          </text>
          <Button className="ui-button ui-button--ghost" disabled={true}>
            <view className="ui-button__content">
              <text className="ui-button__text ui-button__text--ghost">Classified for now</text>
            </view>
          </Button>
        </view>
      </view>
    </KeyboardAwareResponder>
  )
}
