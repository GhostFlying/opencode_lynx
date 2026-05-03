import { describe, expect, it } from 'vitest'

import {
  parseChatRouteParams,
  seedNewSessionDefaults,
} from '../new-session-model.js'

describe('parseChatRouteParams', () => {
  it('parses an opencode connection union', () => {
    expect(parseChatRouteParams({
      routeParams: {
        connection: {
          kind: 'opencode',
          ip: '10.0.0.1',
          port: '4567',
          password: 'pw',
        },
      },
    })).toEqual({
      connection: { kind: 'opencode', ip: '10.0.0.1', port: '4567', password: 'pw' },
    })
  })

  it('parses a codex connection union', () => {
    expect(parseChatRouteParams({
      routeParams: {
        sessionId: 's-1',
        connection: {
          kind: 'codex',
          host: 'example.com',
          port: '7777',
          token: 'tok',
          secure: true,
        },
      },
    })).toEqual({
      sessionId: 's-1',
      connection: {
        kind: 'codex',
        host: 'example.com',
        port: '7777',
        token: 'tok',
        secure: true,
      },
    })
  })

  it('codex without secure defaults to false', () => {
    const result = parseChatRouteParams({
      routeParams: {
        connection: { kind: 'codex', host: '127.0.0.1', port: '7777' },
      },
    })
    expect(result.connection).toEqual({
      kind: 'codex',
      host: '127.0.0.1',
      port: '7777',
      token: '',
      secure: false,
    })
  })

  it('back-compat: missing kind defaults to opencode', () => {
    expect(parseChatRouteParams({
      routeParams: {
        connection: { ip: '1.2.3.4', port: '4567', password: 'pw' },
      },
    })).toEqual({
      connection: { kind: 'opencode', ip: '1.2.3.4', port: '4567', password: 'pw' },
    })
  })

  it('drops connection when required fields are missing', () => {
    // codex needs `host`; an opencode-shaped blob doesn't satisfy it
    expect(parseChatRouteParams({
      routeParams: { connection: { kind: 'codex', port: '7777' } },
    })).toEqual({})
  })

  it('parses queryItems.route_params fallback', () => {
    expect(parseChatRouteParams({
      queryItems: {
        route_params: JSON.stringify({
          isNewSession: true,
          connection: { kind: 'codex', host: 'h', port: '1' },
        }),
      },
    })).toEqual({
      isNewSession: true,
      connection: { kind: 'codex', host: 'h', port: '1', token: '', secure: false },
    })
  })

  it('returns empty object on malformed input', () => {
    expect(parseChatRouteParams(null)).toEqual({})
    expect(parseChatRouteParams({})).toEqual({})
    expect(parseChatRouteParams({ queryItems: { route_params: '{not json' } })).toEqual({})
  })
})

describe('seedNewSessionDefaults', () => {
  it('picks build agent + provider default model when both available', () => {
    expect(seedNewSessionDefaults(
      [
        {
          id: 'anthropic',
          name: 'Anthropic',
          models: [{ id: 'sonnet', name: 'Sonnet', reasoning: false, reasoningEfforts: [] }],
        },
      ],
      { anthropic: 'sonnet' },
      [{ id: 'plan', name: 'plan' }, { id: 'build', name: 'build' }],
    )).toEqual({
      agent: 'build',
      providerID: 'anthropic',
      modelID: 'sonnet',
      variant: null,
    })
  })

  it('returns agent="" when agents list is empty (codex case)', () => {
    expect(seedNewSessionDefaults(
      [
        {
          id: 'codex',
          name: 'Codex',
          models: [{ id: 'gpt-5', name: 'GPT-5', reasoning: false, reasoningEfforts: [] }],
        },
      ],
      { codex: 'gpt-5' },
      [],
    )).toEqual({
      agent: '',
      providerID: 'codex',
      modelID: 'gpt-5',
      variant: null,
    })
  })

  it('falls back to first provider/model when defaults map is empty', () => {
    expect(seedNewSessionDefaults(
      [
        {
          id: 'p1',
          name: 'P1',
          models: [
            { id: 'm1', name: 'M1', reasoning: false, reasoningEfforts: [] },
            { id: 'm2', name: 'M2', reasoning: false, reasoningEfforts: [] },
          ],
        },
      ],
      {},
      [{ id: 'build', name: 'build' }],
    )).toEqual({
      agent: 'build',
      providerID: 'p1',
      modelID: 'm1',
      variant: null,
    })
  })

  it('returns null when no provider available', () => {
    expect(seedNewSessionDefaults([], {}, [])).toBeNull()
    expect(seedNewSessionDefaults([], {}, [{ id: 'a', name: 'a' }])).toBeNull()
  })

  it('returns null when provider has no models and no default', () => {
    expect(seedNewSessionDefaults(
      [{ id: 'p1', name: 'P1', models: [] }],
      {},
      [{ id: 'a', name: 'a' }],
    )).toBeNull()
  })
})
