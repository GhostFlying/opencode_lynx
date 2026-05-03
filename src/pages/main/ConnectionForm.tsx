import { useCallback } from '@lynx-js/react'
import { Button, Input, KeyboardAwareTrigger } from '@lynx-js/lynx-ui'

import { isOpencodeConnection } from './connection.js'
import type { ConnectionContext, ConnectionFormStatus } from './connection.js'

export interface ConnectionFormProps {
  connection: ConnectionContext
  status: ConnectionFormStatus
  errorMessage?: string
  primaryLabel: string
  secondaryLabel?: string
  compact?: boolean
  onChange: (next: ConnectionContext) => void
  onPrimaryAction: () => void
  onSecondaryAction?: () => void
}

export function ConnectionForm({
  connection,
  status,
  errorMessage = '',
  primaryLabel,
  secondaryLabel,
  compact = false,
  onChange,
  onPrimaryAction,
  onSecondaryAction,
}: ConnectionFormProps) {
  // M3.1 stub: only the OpenCode form is rendered for now. The kind-branched
  // form (Codex host/token/secure fields, kind selector) lands in M3.2.
  if (!isOpencodeConnection(connection)) {
    return null
  }

  const opencodeConnection = connection

  const handleIpInput = useCallback((value: string) => {
    'background only'
    onChange({
      ...opencodeConnection,
      ip: value,
    })
  }, [opencodeConnection, onChange])

  const handlePortInput = useCallback((value: string) => {
    'background only'
    onChange({
      ...opencodeConnection,
      port: value,
    })
  }, [opencodeConnection, onChange])

  const handlePasswordInput = useCallback((value: string) => {
    'background only'
    onChange({
      ...opencodeConnection,
      password: value,
    })
  }, [opencodeConnection, onChange])

  return (
    <view className={compact ? 'connection-form connection-form--compact' : 'connection-form'}>
      <KeyboardAwareTrigger className="connection-field">
        <text className="connection-field__label">Server IP</text>
        <Input
          id="connection-ip"
          value={opencodeConnection.ip}
          placeholder="192.168.1.100"
          className="ui-input"
          onInput={handleIpInput}
        />
      </KeyboardAwareTrigger>

      <view className="connection-grid">
        <KeyboardAwareTrigger className="connection-field connection-field--grid">
          <text className="connection-field__label">Port</text>
          <Input
            id="connection-port"
            value={opencodeConnection.port}
            placeholder="3000"
            type="number"
            className="ui-input"
            onInput={handlePortInput}
          />
        </KeyboardAwareTrigger>

        <KeyboardAwareTrigger className="connection-field connection-field--grid">
          <text className="connection-field__label">Password</text>
          <Input
            id="connection-password"
            value={opencodeConnection.password}
            placeholder="Optional"
            type="password"
            className="ui-input"
            onInput={handlePasswordInput}
          />
        </KeyboardAwareTrigger>
      </view>

      {status === 'error' && errorMessage.length > 0
        ? (
          <view className="error-banner">
            <text className="error-text">{errorMessage}</text>
          </view>
        )
        : null}

      <view className={secondaryLabel && onSecondaryAction ? 'connection-actions connection-actions--split' : 'connection-actions'}>
        <Button
          className={status === 'connecting' ? 'ui-button ui-button--primary ui-button--disabled' : 'ui-button ui-button--primary'}
          disabled={status === 'connecting'}
          onClick={onPrimaryAction}
        >
          <view className="ui-button__content">
            <text className="ui-button__text">
              {status === 'connecting' ? 'Connecting...' : primaryLabel}
            </text>
          </view>
        </Button>

        {secondaryLabel && onSecondaryAction
          ? (
            <Button
              className="ui-button ui-button--secondary"
              onClick={onSecondaryAction}
            >
              <view className="ui-button__content">
                <text className="ui-button__text ui-button__text--secondary">{secondaryLabel}</text>
              </view>
            </Button>
          )
          : null}
      </view>
    </view>
  )
}
