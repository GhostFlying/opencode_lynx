import { describe, expect, it } from 'vitest'

import {
  classifyOpencodeError,
  normalizeOpencodeError,
  normalizeSdkError,
  OpencodeWrapperError,
} from '../errors.js'

describe('opencode error normalization', () => {
  it('classifies auth failures', () => {
    expect(classifyOpencodeError({ status: 401, message: 'Unauthorized' })).toBe('auth')
  })

  it('classifies network failures', () => {
    expect(classifyOpencodeError(new Error('fetch failed: connection reset by peer'))).toBe('network')
  })

  it('classifies rate-limit failures', () => {
    expect(classifyOpencodeError({ status: 429, message: 'Too many requests' })).toBe('rate-limit')
  })

  it('classifies not-found failures', () => {
    expect(classifyOpencodeError({ status: 404, message: 'Session not found' })).toBe('not-found')
  })

  it('classifies unknown failures when no mapping applies', () => {
    expect(classifyOpencodeError({ status: 418, message: 'teapot' })).toBe('unknown')
  })

  it('normalizes malformed payloads safely', () => {
    expect(() => normalizeOpencodeError(undefined)).not.toThrow()
    expect(normalizeOpencodeError(undefined)).toMatchObject({
      category: 'unknown',
      message: 'unknown error',
      status: undefined,
      retryable: false,
      cause: undefined,
    })

    expect(() => classifyOpencodeError(Symbol('bad-input'))).not.toThrow()
    expect(classifyOpencodeError(Symbol('bad-input'))).toBe('unknown')
  })

  it('preserves existing wrapper error compatibility', () => {
    const failure = { status: 503, message: 'upstream unavailable' }
    const wrapped = normalizeSdkError(failure)

    expect(wrapped).toBeInstanceOf(OpencodeWrapperError)
    expect(wrapped).toMatchObject({
      code: 'sdk_request_failed',
      status: 503,
      retryable: true,
      message: 'OpenCode SDK request failed: upstream unavailable',
      cause: failure,
    })
  })

  it('keeps existing wrapper error instances unchanged', () => {
    const wrapped = new OpencodeWrapperError('already normalized', {
      code: 'unknown',
      retryable: true,
    })

    expect(normalizeSdkError(wrapped)).toBe(wrapped)
  })
})
