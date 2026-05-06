import { useCallback } from '@lynx-js/react'
import { Button, Input, KeyboardAwareTrigger, Switch } from '@lynx-js/lynx-ui'

import {
  defaultConnectionForKind,
  isCodexConnection,
  isOpencodeConnection,
} from './connection.js'
import type {
  BackendKindLabel,
  ConnectionContext,
  ConnectionFormStatus,
} from './connection.js'

export interface ConnectionFormProps {
  connection: ConnectionContext
  status: ConnectionFormStatus
  errorMessage?: string
  primaryLabel: string
  secondaryLabel?: string
  compact?: boolean
  // Locks the OpenCode/Codex pill switch and shows a hint. Settings sets this
  // while a connection is open or in flight, so the user must explicitly
  // disconnect before changing backends instead of silently overwriting the
  // saved connection by tapping the other pill.
  kindSwitchDisabled?: boolean
  kindSwitchDisabledHint?: string
  onChange: (next: ConnectionContext) => void
  onPrimaryAction: () => void
  onSecondaryAction?: () => void
}

interface KindSelectorProps {
  activeKind: BackendKindLabel
  disabled: boolean
  onSelectKind: (kind: BackendKindLabel) => void
}

function pillClassName(active: boolean, disabled: boolean): string {
  const classes = ['connection-kind__pill']
  if (active) classes.push('connection-kind__pill--active')
  if (disabled && !active) classes.push('connection-kind__pill--disabled')
  return classes.join(' ')
}

function KindSelector({ activeKind, disabled, onSelectKind }: KindSelectorProps) {
  const handleOpencodeTap = useCallback(() => {
    'background only'
    if (disabled) return
    if (activeKind !== 'opencode') {
      onSelectKind('opencode')
    }
  }, [activeKind, disabled, onSelectKind])

  const handleCodexTap = useCallback(() => {
    'background only'
    if (disabled) return
    if (activeKind !== 'codex') {
      onSelectKind('codex')
    }
  }, [activeKind, disabled, onSelectKind])

  return (
    <view className="connection-kind">
      <view
        className={pillClassName(activeKind === 'opencode', disabled)}
        bindtap={handleOpencodeTap}
      >
        <text className="connection-kind__label">OpenCode</text>
      </view>
      <view
        className={pillClassName(activeKind === 'codex', disabled)}
        bindtap={handleCodexTap}
      >
        <text className="connection-kind__label">Codex</text>
      </view>
    </view>
  )
}

export function ConnectionForm({
  connection,
  status,
  errorMessage = '',
  primaryLabel,
  secondaryLabel,
  compact = false,
  kindSwitchDisabled = false,
  kindSwitchDisabledHint,
  onChange,
  onPrimaryAction,
  onSecondaryAction,
}: ConnectionFormProps) {
  const handleSelectKind = useCallback(
    (kind: BackendKindLabel) => {
      'background only'
      onChange(defaultConnectionForKind(kind))
    },
    [onChange],
  )

  // Opencode-branch handlers (no-op when in codex branch).
  const handleIpInput = useCallback(
    (value: string) => {
      'background only'
      if (isOpencodeConnection(connection)) {
        onChange({ ...connection, ip: value })
      }
    },
    [connection, onChange],
  )

  const handleOpencodePortInput = useCallback(
    (value: string) => {
      'background only'
      if (isOpencodeConnection(connection)) {
        onChange({ ...connection, port: value })
      }
    },
    [connection, onChange],
  )

  const handlePasswordInput = useCallback(
    (value: string) => {
      'background only'
      if (isOpencodeConnection(connection)) {
        onChange({ ...connection, password: value })
      }
    },
    [connection, onChange],
  )

  // Codex-branch handlers.
  const handleHostInput = useCallback(
    (value: string) => {
      'background only'
      if (isCodexConnection(connection)) {
        onChange({ ...connection, host: value })
      }
    },
    [connection, onChange],
  )

  const handleCodexPortInput = useCallback(
    (value: string) => {
      'background only'
      if (isCodexConnection(connection)) {
        onChange({ ...connection, port: value })
      }
    },
    [connection, onChange],
  )

  const handleTokenInput = useCallback(
    (value: string) => {
      'background only'
      if (isCodexConnection(connection)) {
        onChange({ ...connection, token: value })
      }
    },
    [connection, onChange],
  )

  const handleSecureChange = useCallback(
    (checked: boolean) => {
      'background only'
      if (isCodexConnection(connection)) {
        onChange({ ...connection, secure: checked })
      }
    },
    [connection, onChange],
  )

  const containerClass = compact
    ? 'connection-form connection-form--compact'
    : 'connection-form'

  return (
    <view className={containerClass}>
      <KindSelector
        activeKind={connection.kind}
        disabled={kindSwitchDisabled}
        onSelectKind={handleSelectKind}
      />
      {kindSwitchDisabled && kindSwitchDisabledHint ? (
        <text className="connection-kind__hint">{kindSwitchDisabledHint}</text>
      ) : null}

      {isOpencodeConnection(connection) ? (
        <>
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
                onInput={handleOpencodePortInput}
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
        </>
      ) : null}

      {isCodexConnection(connection) ? (
        <>
          <KeyboardAwareTrigger className="connection-field">
            <text className="connection-field__label">Host</text>
            <Input
              id="connection-host"
              value={connection.host}
              placeholder="127.0.0.1"
              className="ui-input"
              onInput={handleHostInput}
            />
          </KeyboardAwareTrigger>

          <view className="connection-grid">
            <KeyboardAwareTrigger className="connection-field connection-field--grid">
              <text className="connection-field__label">Port</text>
              <Input
                id="connection-port"
                value={connection.port}
                placeholder="7777"
                type="number"
                className="ui-input"
                onInput={handleCodexPortInput}
              />
            </KeyboardAwareTrigger>

            <KeyboardAwareTrigger className="connection-field connection-field--grid">
              <text className="connection-field__label">Token</text>
              <Input
                id="connection-token"
                value={connection.token}
                placeholder="Optional"
                type="password"
                className="ui-input"
                onInput={handleTokenInput}
              />
            </KeyboardAwareTrigger>
          </view>

          <view className="connection-secure-row">
            <text className="connection-field__label">
              Use secure WebSocket (wss://)
            </text>
            <Switch
              id="connection-secure"
              className="connection-secure-row__switch"
              checked={connection.secure}
              onChange={handleSecureChange}
            />
          </view>
        </>
      ) : null}

      {status === 'error' && errorMessage.length > 0 ? (
        <view className="error-banner">
          <text className="error-text">{errorMessage}</text>
        </view>
      ) : null}

      <view
        className={
          secondaryLabel && onSecondaryAction
            ? 'connection-actions connection-actions--split'
            : 'connection-actions'
        }
      >
        <Button
          className={
            status === 'connecting'
              ? 'ui-button ui-button--primary ui-button--disabled'
              : 'ui-button ui-button--primary'
          }
          disabled={status === 'connecting'}
          onClick={onPrimaryAction}
        >
          <view className="ui-button__content">
            <text className="ui-button__text">
              {status === 'connecting' ? 'Connecting...' : primaryLabel}
            </text>
          </view>
        </Button>

        {secondaryLabel && onSecondaryAction ? (
          <Button
            className="ui-button ui-button--secondary"
            onClick={onSecondaryAction}
          >
            <view className="ui-button__content">
              <text className="ui-button__text ui-button__text--secondary">
                {secondaryLabel}
              </text>
            </view>
          </Button>
        ) : null}
      </view>
    </view>
  )
}
