import { describe, expect, it } from 'vitest'

import {
  V1_CONNECTION_LIFECYCLE_EVENT_NAMES,
  V1_REQUIRED_EVENT_NAMES,
  createEventsApi,
  isKnownV1EventName,
  parseRawEventEnvelope,
  parseV1StreamEvent,
} from '../events.js'

const KNOWN_EVENT_FIXTURES = [
  {
    type: 'session.status',
    properties: {
      sessionID: 'session-1',
      status: 'running',
    },
  },
  {
    type: 'message.part.updated',
    properties: {
      sessionID: 'session-1',
      messageID: 'message-1',
      partID: 'part-1',
    },
  },
  {
    type: 'message.part.delta',
    properties: {
      sessionID: 'session-1',
      messageID: 'message-1',
      partID: 'part-1',
      delta: 'hello',
    },
  },
  {
    type: 'message.updated',
    properties: {
      sessionID: 'session-1',
      messageID: 'message-1',
      completedAt: '2026-01-01T00:00:00Z',
    },
  },
  {
    type: 'server.connected',
    properties: {
      serverID: 'server-1',
    },
  },
  {
    type: 'global.disposed',
    properties: {
      reason: 'shutdown',
    },
  },
  {
    type: 'server.instance.disposed',
    properties: {
      instanceID: 'instance-1',
    },
  },
] as const

describe('events contracts (v1)', () => {
  it('keeps streamURL behavior unchanged', () => {
    const api = createEventsApi({
      baseUrl: 'https://opencode.example.com/',
      directory: '/repo/default',
      workspace: { id: 'default' },
    })

    expect(api.streamURL()).toBe('https://opencode.example.com/global/event?directory=%2Frepo%2Fdefault')
  })

  it('defines required v1 event names including lifecycle events', () => {
    expect(V1_CONNECTION_LIFECYCLE_EVENT_NAMES).toEqual([
      'server.connected',
      'global.disposed',
      'server.instance.disposed',
    ])

    expect(V1_REQUIRED_EVENT_NAMES).toEqual([
      'session.status',
      'message.part.updated',
      'message.part.delta',
      'message.updated',
      'server.connected',
      'global.disposed',
      'server.instance.disposed',
    ])
  })

  for (const fixture of KNOWN_EVENT_FIXTURES) {
    it(`parses known event fixture: ${fixture.type}`, () => {
      const parsed = parseV1StreamEvent(JSON.stringify(fixture))

      expect(parsed).toEqual({
        type: fixture.type,
        properties: fixture.properties,
      })

      expect(isKnownV1EventName(fixture.type)).toBe(true)
    })
  }

  it('returns typed unknown for unknown event names', () => {
    const payload = {
      type: 'mcp.tools.changed',
      properties: {
        timestamp: '2026-01-01T00:00:00Z',
      },
    }

    expect(parseV1StreamEvent(payload)).toEqual({
      type: 'unknown',
      eventType: 'mcp.tools.changed',
      properties: payload.properties,
    })

    expect(isKnownV1EventName('mcp.tools.changed')).toBe(false)
  })

  it('handles malformed JSON safely without throwing', () => {
    expect(() => parseV1StreamEvent('{"type":')).not.toThrow()
    expect(parseV1StreamEvent('{"type":')).toBeNull()
  })

  it('returns null when envelope shape is invalid', () => {
    expect(parseRawEventEnvelope('{"type":"session.status"}')).toBeNull()
    expect(parseV1StreamEvent('{"type":"session.status"}')).toBeNull()
    expect(parseV1StreamEvent('"not-an-envelope"')).toBeNull()
  })

  it('falls back to unknown when known event has malformed properties', () => {
    expect(parseV1StreamEvent('{"type":"message.updated","properties":"bad"}')).toEqual({
      type: 'unknown',
      eventType: 'message.updated',
      properties: 'bad',
    })
  })
})
