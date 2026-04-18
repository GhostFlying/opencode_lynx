import { useCallback } from '@lynx-js/react'
import { Button, Input, KeyboardAwareTrigger } from '@lynx-js/lynx-ui'

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
  const handleIpInput = useCallback((value: string) => {
    'background only'
    onChange({
      ...connection,
      ip: value,
    })
  }, [connection, onChange])

  const handlePortInput = useCallback((value: string) => {
    'background only'
    onChange({
      ...connection,
      port: value,
    })
  }, [connection, onChange])

  const handlePasswordInput = useCallback((value: string) => {
    'background only'
    onChange({
      ...connection,
      password: value,
    })
  }, [connection, onChange])

  return (
    <view className={compact ? 'connection-form connection-form--compact' : 'connection-form'}>
      <KeyboardAwareTrigger className="connection-field">
        <text className="connection-field__label">Server IP</text>
        <Input
          id="connection-ip"
          value={connection.ip}
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
            value={connection.port}
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
            value={connection.password}
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
