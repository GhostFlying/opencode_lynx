import { describe, expect, it } from 'vitest'

import { OpencodeWrapperError } from '../errors.js'
import { OpenCodeGateway, createOpencodeGateway } from '../gateway.js'

describe('gateway composition boundary', () => {
  it('composes sessions and events behind one OpenCodeGateway boundary', () => {
    const gateway = OpenCodeGateway.create({
      baseUrl: 'https://opencode.example.com/',
      auth: 'token-abc',
      directory: '/repo/default',
      workspace: { id: 'default' },
    })

    const direct = createOpencodeGateway({
      baseUrl: 'https://opencode.example.com/',
      auth: 'token-abc',
      directory: '/repo/default',
      workspace: { id: 'default' },
    })

    expect(typeof direct.sessions.list).toBe('function')
    expect(typeof direct.events.streamURL).toBe('function')

    expect(typeof gateway.sessions.list).toBe('function')
    expect(typeof gateway.sessions.create).toBe('function')
    expect(typeof gateway.sessions.get).toBe('function')
    expect(typeof gateway.sessions.messages).toBe('function')
    expect(typeof gateway.sessions.prompt).toBe('function')
    expect(gateway.events.streamURL()).toBe('https://opencode.example.com/global/event?directory=%2Frepo%2Fdefault')
    expect((gateway as unknown as { client?: unknown }).client).toBeUndefined()
  })

  it('fails invalid config with typed invalid_config error behavior', () => {
    expect(() => createOpencodeGateway({
      baseUrl: 'https://opencode.example.com',
      workspace: { id: 'non-default' },
    })).toThrow(OpencodeWrapperError)

    expect(() => createOpencodeGateway({
      baseUrl: 'https://opencode.example.com',
      workspace: { id: 'non-default' },
    })).toThrow('Single-workspace mode only allows workspace "default" in v1.')

    try {
      createOpencodeGateway({
        baseUrl: 'https://opencode.example.com',
        workspace: { id: 'non-default' },
      })
      throw new Error('expected createOpencodeGateway to throw')
    } catch (error) {
      const typed = error as OpencodeWrapperError
      expect(typed).toMatchObject({
        name: 'OpencodeWrapperError',
        code: 'invalid_config',
        retryable: false,
        message: 'Single-workspace mode only allows workspace "default" in v1.',
      })
    }
  })
})
