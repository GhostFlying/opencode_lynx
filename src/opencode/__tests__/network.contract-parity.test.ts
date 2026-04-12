import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

type PrimitiveSchema =
  | { readonly kind: 'string' }
  | { readonly kind: 'number' }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'null' }

interface LiteralSchema {
  readonly kind: 'literal'
  readonly value: string | number | boolean | null
}

interface EnumSchema {
  readonly kind: 'enum'
  readonly values: readonly (string | number | boolean | null)[]
}

interface ObjectSchema {
  readonly kind: 'object'
  readonly fields: Readonly<Record<string, Schema>>
}

interface UnionSchema {
  readonly kind: 'union'
  readonly variants: readonly Schema[]
}

type Schema = PrimitiveSchema | LiteralSchema | EnumSchema | ObjectSchema | UnionSchema

const testFile = fileURLToPath(import.meta.url)
const fixturesDir = resolve(testFile, '..', 'fixtures', 'network-bridge-v1')

const NETWORK_BRIDGE_V1_SCHEMA: Schema = {
  kind: 'object',
  fields: {
    platform: {
      kind: 'enum',
      values: ['android', 'ios'],
    },
    request_invalid: {
      kind: 'object',
      fields: {
        ok: {
          kind: 'literal',
          value: false,
        },
        status_code: {
          kind: 'union',
          variants: [
            {
              kind: 'number',
            },
            {
              kind: 'null',
            },
          ],
        },
        headers: {
          kind: 'object',
          fields: {},
        },
        body: {
          kind: 'null',
        },
        error_code: {
          kind: 'enum',
          values: ['invalid_param', 'invalid_payload'],
        },
        error_message: {
          kind: 'string',
        },
      },
    },
    sse_open_invalid: {
      kind: 'object',
      fields: {
        stream_id: {
          kind: 'null',
        },
        event_name: {
          kind: 'null',
        },
        error_code: {
          kind: 'enum',
          values: ['invalid_param', 'invalid_payload'],
        },
        error_message: {
          kind: 'string',
        },
      },
    },
    sse_close_invalid: {
      kind: 'object',
      fields: {
        closed: {
          kind: 'literal',
          value: false,
        },
        error_code: {
          kind: 'enum',
          values: ['invalid_param', 'invalid_payload'],
        },
        error_message: {
          kind: 'string',
        },
      },
    },
  },
}

function parseFixture(name: 'android' | 'ios'): unknown {
  const fixturePath = resolve(fixturesDir, `${name}.json`)
  return JSON.parse(readFileSync(fixturePath, 'utf-8')) as unknown
}

function getTag(value: unknown): 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array' {
  if (value === null) {
    return 'null'
  }

  if (Array.isArray(value)) {
    return 'array'
  }

  const valueType = typeof value
  if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
    return valueType
  }

  return 'object'
}

function validateSchema(value: unknown, schema: Schema, path = '$'): string[] {
  if (schema.kind === 'string' || schema.kind === 'number' || schema.kind === 'boolean' || schema.kind === 'null') {
    const valueTag = getTag(value)
    return valueTag === schema.kind ? [] : [`${path}: expected ${schema.kind}, got ${valueTag}`]
  }

  if (schema.kind === 'literal') {
    return Object.is(value, schema.value) ? [] : [`${path}: expected literal ${JSON.stringify(schema.value)}, got ${JSON.stringify(value)}`]
  }

  if (schema.kind === 'enum') {
    for (const accepted of schema.values) {
      if (Object.is(value, accepted)) {
        return []
      }
    }
    return [`${path}: expected one of ${JSON.stringify(schema.values)}, got ${JSON.stringify(value)}`]
  }

  if (schema.kind === 'union') {
    for (const variant of schema.variants) {
      const candidateErrors = validateSchema(value, variant, path)
      if (candidateErrors.length === 0) {
        return []
      }
    }
    return [`${path}: value did not match any allowed union variant`]
  }

  if (getTag(value) !== 'object') {
    return [`${path}: expected object, got ${getTag(value)}`]
  }

  const payload = value as Record<string, unknown>
  const errors: string[] = []
  const expectedKeys = Object.keys(schema.fields)
  const actualKeys = Object.keys(payload)

  for (const expectedKey of expectedKeys) {
    if (!(expectedKey in payload)) {
      errors.push(`${path}.${expectedKey}: missing key`)
      continue
    }
    errors.push(...validateSchema(payload[expectedKey], schema.fields[expectedKey], `${path}.${expectedKey}`))
  }

  for (const actualKey of actualKeys) {
    if (!(actualKey in schema.fields)) {
      errors.push(`${path}.${actualKey}: unexpected key`)
    }
  }

  return errors
}

describe('network bridge v1 contract parity fixtures', () => {
  it('matches one shared schema for android and ios request+sse envelopes', () => {
    const androidFixture = parseFixture('android')
    const iosFixture = parseFixture('ios')

    expect(validateSchema(androidFixture, NETWORK_BRIDGE_V1_SCHEMA)).toEqual([])
    expect(validateSchema(iosFixture, NETWORK_BRIDGE_V1_SCHEMA)).toEqual([])
  })

  it('exercises mismatch detection branch for schema drift', () => {
    const iosFixture = parseFixture('ios') as Record<string, unknown>
    const driftedFixture = JSON.parse(JSON.stringify(iosFixture)) as {
      sse_open_invalid: Record<string, unknown>
    }
    delete driftedFixture.sse_open_invalid.error_message

    const errors = validateSchema(driftedFixture, NETWORK_BRIDGE_V1_SCHEMA)
    expect(errors).toContain('$.sse_open_invalid.error_message: missing key')
  })
})
