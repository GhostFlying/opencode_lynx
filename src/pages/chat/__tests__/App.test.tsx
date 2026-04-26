import '@testing-library/jest-dom'
import { describe, expect, it } from 'vitest'

import type { BackendEvent } from '../../../backends/index.js'
import {
  errorMessageFromBackendEvent,
  shouldRefreshMessagesForBackendEvent,
  shouldStopThinkingForBackendEvent,
} from '../backend-events.js'
import {
  FIXTURE_AGENTS,
  FIXTURE_PROVIDER_DEFAULTS,
  FIXTURE_PROVIDERS,
  getFixtureMessages,
} from '../fixtures.js'

describe('chat backend facade helpers', () => {
  it('uses backend-neutral fixture data for dev mode messages and catalogs', () => {
    const messages = getFixtureMessages('session-fixture')

    expect(messages[0]).toMatchObject({
      id: 'msg_fix_u1',
      sessionID: 'session-fixture',
      role: 'user',
    })
    expect(messages.some(message => message.role === 'assistant' && message.backendMeta)).toBe(true)
    expect(FIXTURE_PROVIDERS[0]?.models[0]).toMatchObject({
      id: 'claude-sonnet-4-20250514',
      reasoningEfforts: ['low', 'medium', 'high', 'max'],
    })
    expect(FIXTURE_PROVIDER_DEFAULTS.anthropic).toBe('claude-sonnet-4-20250514')
    expect(FIXTURE_AGENTS[0]).toMatchObject({
      id: 'build',
      name: 'build',
    })
  })

  it('classifies unified backend events for chat refresh and thinking state', () => {
    const messageUpdated: BackendEvent = {
      backend: 'opencode',
      type: 'message.updated',
      sessionID: 'session-1',
      payload: {},
      raw: {},
    }
    const resyncRequired: BackendEvent = {
      backend: 'opencode',
      type: 'resync.required',
      sessionID: 'session-1',
      payload: {},
      raw: {},
    }
    const sessionIdle: BackendEvent = {
      backend: 'opencode',
      type: 'raw',
      sourceType: 'session.idle',
      sessionID: 'session-1',
      payload: {},
      raw: {},
    }
    const stopped: BackendEvent = {
      backend: 'opencode',
      type: 'connection.state',
      status: 'stopped',
      payload: {},
      raw: {},
    }
    const delta: BackendEvent = {
      backend: 'opencode',
      type: 'message.delta',
      sessionID: 'session-1',
      payload: {},
      raw: {},
    }

    expect(shouldRefreshMessagesForBackendEvent(messageUpdated)).toBe(true)
    expect(shouldRefreshMessagesForBackendEvent(resyncRequired)).toBe(true)
    expect(shouldRefreshMessagesForBackendEvent(sessionIdle)).toBe(false)
    expect(shouldStopThinkingForBackendEvent(sessionIdle)).toBe(true)
    expect(shouldStopThinkingForBackendEvent(stopped)).toBe(true)
    expect(shouldStopThinkingForBackendEvent(delta)).toBe(false)
  })

  it('extracts session.error messages from raw backend payloads', () => {
    expect(errorMessageFromBackendEvent({
      backend: 'opencode',
      type: 'raw',
      sourceType: 'session.error',
      sessionID: 'session-1',
      payload: {
        error: {
          data: {
            message: 'The agent failed.',
          },
        },
      },
      raw: {},
    })).toBe('The agent failed.')

    expect(errorMessageFromBackendEvent({
      backend: 'opencode',
      type: 'raw',
      sourceType: 'session.error',
      sessionID: 'session-1',
      payload: {},
      raw: {},
    })).toBe('Agent reported an error.')
  })
})
