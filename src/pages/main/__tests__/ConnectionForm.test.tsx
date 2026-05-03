import '@testing-library/jest-dom'
import { describe, expect, test, vi } from 'vitest'
import { fireEvent, render } from '@lynx-js/react/testing-library'

import { ConnectionForm } from '../ConnectionForm.js'
import type { CodexConnectionContext, OpencodeConnectionContext } from '../connection.js'

vi.mock('@lynx-js/lynx-ui', async () => {
  const shim = await vi.importActual<typeof import('../../../test-support/lynx-ui-shim.js')>(
    '../../../test-support/lynx-ui-shim.js',
  )
  return shim
})

function makeOpencode(overrides: Partial<OpencodeConnectionContext> = {}): OpencodeConnectionContext {
  return {
    kind: 'opencode',
    ip: '10.0.0.1',
    port: '4567',
    password: 'pw',
    ...overrides,
  }
}

function makeCodex(overrides: Partial<CodexConnectionContext> = {}): CodexConnectionContext {
  return {
    kind: 'codex',
    host: 'codex.local',
    port: '7777',
    token: 'tk',
    secure: false,
    ...overrides,
  }
}

describe('ConnectionForm', () => {
  test('renders opencode branch when given an opencode connection', () => {
    const result = render(
      <ConnectionForm
        connection={makeOpencode()}
        status="idle"
        primaryLabel="Connect"
        onChange={vi.fn()}
        onPrimaryAction={vi.fn()}
      />,
    )

    expect(result.container.querySelector('#connection-ip')).not.toBeNull()
    expect(result.container.querySelector('#connection-password')).not.toBeNull()
    expect(result.container.querySelector('#connection-host')).toBeNull()
    expect(result.container.querySelector('#connection-token')).toBeNull()
    expect(result.container.querySelector('#connection-secure')).toBeNull()
  })

  test('renders codex branch when given a codex connection', () => {
    const result = render(
      <ConnectionForm
        connection={makeCodex()}
        status="idle"
        primaryLabel="Connect"
        onChange={vi.fn()}
        onPrimaryAction={vi.fn()}
      />,
    )

    expect(result.container.querySelector('#connection-host')).not.toBeNull()
    expect(result.container.querySelector('#connection-token')).not.toBeNull()
    expect(result.container.querySelector('#connection-secure')).not.toBeNull()
    expect(result.container.querySelector('#connection-ip')).toBeNull()
    expect(result.container.querySelector('#connection-password')).toBeNull()
  })

  test('tapping codex pill from opencode connection emits default codex connection', () => {
    const onChange = vi.fn()
    const result = render(
      <ConnectionForm
        connection={makeOpencode()}
        status="idle"
        primaryLabel="Connect"
        onChange={onChange}
        onPrimaryAction={vi.fn()}
      />,
    )

    const pills = result.container.querySelectorAll('.connection-kind__pill')
    expect(pills.length).toBe(2)
    // Pills are rendered in OpenCode, Codex order.
    fireEvent.tap(pills[1]!)

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({
      kind: 'codex',
      host: '127.0.0.1',
      port: '7777',
      token: '',
      secure: false,
    })
  })

  test('tapping opencode pill from codex connection emits default opencode connection', () => {
    const onChange = vi.fn()
    const result = render(
      <ConnectionForm
        connection={makeCodex()}
        status="idle"
        primaryLabel="Connect"
        onChange={onChange}
        onPrimaryAction={vi.fn()}
      />,
    )

    const pills = result.container.querySelectorAll('.connection-kind__pill')
    fireEvent.tap(pills[0]!)

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({
      kind: 'opencode',
      ip: '127.0.0.1',
      port: '3000',
      password: '',
    })
  })

  test('tapping the active pill does not call onChange', () => {
    const onChange = vi.fn()
    const result = render(
      <ConnectionForm
        connection={makeOpencode()}
        status="idle"
        primaryLabel="Connect"
        onChange={onChange}
        onPrimaryAction={vi.fn()}
      />,
    )

    const pills = result.container.querySelectorAll('.connection-kind__pill')
    fireEvent.tap(pills[0]!)

    expect(onChange).not.toHaveBeenCalled()
  })

  test('toggling secure flips the boolean and preserves other fields', () => {
    const onChange = vi.fn()
    const result = render(
      <ConnectionForm
        connection={makeCodex({ secure: false })}
        status="idle"
        primaryLabel="Connect"
        onChange={onChange}
        onPrimaryAction={vi.fn()}
      />,
    )

    const switchEl = result.container.querySelector('#connection-secure')
    expect(switchEl).not.toBeNull()
    fireEvent.tap(switchEl!)

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({
      kind: 'codex',
      host: 'codex.local',
      port: '7777',
      token: 'tk',
      secure: true,
    })
  })

  test('codex token input renders type="password"', () => {
    const result = render(
      <ConnectionForm
        connection={makeCodex()}
        status="idle"
        primaryLabel="Connect"
        onChange={vi.fn()}
        onPrimaryAction={vi.fn()}
      />,
    )

    const tokenInput = result.container.querySelector('#connection-token') as
      | (Element & { getAttribute(name: string): string | null })
      | null
    expect(tokenInput).not.toBeNull()
    expect(tokenInput!.getAttribute('type')).toBe('password')
  })

  test('renders error banner when status is error and message is non-empty', () => {
    const result = render(
      <ConnectionForm
        connection={makeOpencode()}
        status="error"
        errorMessage="bad ip"
        primaryLabel="Connect"
        onChange={vi.fn()}
        onPrimaryAction={vi.fn()}
      />,
    )

    expect(result.container.querySelector('.error-banner')).not.toBeNull()
  })
})
