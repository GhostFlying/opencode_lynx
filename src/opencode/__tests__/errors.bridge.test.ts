import { describe, expect, it } from 'vitest'

import {
  classifyOpencodeError,
  normalizeOpencodeError,
  normalizeSdkError,
  OpencodeWrapperError,
} from '../errors.js'

describe('bridge-aware error normalization', () => {
  it('maps native bridge envelope codes deterministically', () => {
    const timeout = normalizeOpencodeError({
      error_code: 'bridge_timeout',
      error_message: 'Bridge timed out waiting for native response.',
    })

    expect(timeout).toMatchObject({
      bridgeCode: 'bridge_timeout',
      category: 'network',
      retryable: true,
      message: 'Bridge timed out waiting for native response.',
    })

    const unavailable = normalizeOpencodeError({
      error_code: 'unavailable',
      error_message: 'Bridge unavailable in this runtime.',
    })

    expect(unavailable).toMatchObject({
      bridgeCode: 'bridge_unavailable',
      category: 'network',
      retryable: true,
    })

    const cancelled = normalizeOpencodeError({
      error_code: 'cancelled',
      error_message: 'Bridge request cancelled.',
    })

    expect(cancelled).toMatchObject({
      bridgeCode: 'bridge_cancelled',
      category: 'unknown',
      retryable: false,
    })

    const protocol = normalizeOpencodeError({
      error_code: 'protocol',
      error_message: 'Malformed bridge envelope.',
    })

    expect(protocol).toMatchObject({
      bridgeCode: 'bridge_protocol',
      category: 'unknown',
      retryable: false,
    })
  })

  it('maps stream closed errors even when envelopes are partial', () => {
    const normalized = normalizeOpencodeError({
      code: 'unknown',
      message: 'Event stream closed by native host.',
    })

    expect(normalized).toMatchObject({
      bridgeCode: 'stream_closed',
      category: 'network',
      retryable: true,
    })
  })

  it('keeps malformed envelopes deterministic and non-throwing', () => {
    const malformed = normalizeOpencodeError({
      error_code: 42,
      message: '',
    })

    expect(malformed).toMatchObject({
      bridgeCode: undefined,
      category: 'unknown',
      retryable: false,
      message: 'unknown error',
    })

    expect(() => classifyOpencodeError({ error_code: null })).not.toThrow()
  })

  it('normalizes mixed sdk/native failures without changing wrapper public code', () => {
    const wrapped = normalizeSdkError({
      error_code: 'bridge_timeout',
      error_message: 'native timeout',
      status_code: 504,
    })

    expect(wrapped).toBeInstanceOf(OpencodeWrapperError)
    expect(wrapped).toMatchObject({
      code: 'sdk_request_failed',
      status: 504,
      retryable: true,
      message: 'OpenCode SDK request failed: native timeout',
    })
  })

  it('does not reinterpret existing sdk error codes as bridge codes', () => {
    const normalized = normalizeOpencodeError({
      code: 'timeout',
      status: 401,
      message: 'Unauthorized',
    })

    expect(normalized).toMatchObject({
      bridgeCode: undefined,
      category: 'auth',
      retryable: false,
    })
  })
})
