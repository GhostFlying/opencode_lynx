import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface BridgeFixture {
  readonly platform: 'android' | 'ios'
  readonly request_invalid: {
    readonly ok: boolean
    readonly status_code: number | null
    readonly headers: Record<string, string>
    readonly body: null
    readonly error_code: string
    readonly error_message: string
  }
  readonly sse_open_invalid: {
    readonly stream_id: null
    readonly event_name: null
    readonly error_code: string
    readonly error_message: string
  }
  readonly sse_close_invalid: {
    readonly closed: boolean
    readonly error_code: string
    readonly error_message: string
  }
}

const testFile = fileURLToPath(import.meta.url)
const fixturesDir = resolve(testFile, '..', 'fixtures', 'network-bridge-v1')
const appRoot = resolve(testFile, '..', '..', '..', '..')

const androidRequestTestPath = resolve(
  appRoot,
  'android',
  'app',
  'src',
  'main',
  'java',
  'com',
  'opencode',
  'lynx',
  'NetworkRequestOkHttpTransport.kt',
)

const androidBridgeContractPath = resolve(
  appRoot,
  'android',
  'app',
  'src',
  'main',
  'java',
  'com',
  'opencode',
  'lynx',
  'OpenCodeBridgeModule.kt',
)

const androidSseTestPath = resolve(
  appRoot,
  'android',
  'app',
  'src',
  'main',
  'java',
  'com',
  'opencode',
  'lynx',
  'NetworkSseOkHttpTransport.kt',
)

const iosRequestTestPath = resolve(
  appRoot,
  'ios',
  'OpenCodeLynx',
  'OpenCodeLynx',
  'MethodServices',
  'NativeNetworkRequestExecutor.swift',
)

const iosBridgeContractPath = resolve(
  appRoot,
  'ios',
  'OpenCodeLynx',
  'OpenCodeLynx',
  'Bridge',
  'OpenCodeBridgeDispatcher.swift',
)

const iosSseTestPath = resolve(
  appRoot,
  'ios',
  'OpenCodeLynx',
  'OpenCodeLynx',
  'MethodServices',
  'NativeNetworkSseManager.swift',
)

function readFixture(platform: 'android' | 'ios'): BridgeFixture {
  const filePath = resolve(fixturesDir, `${platform}.json`)
  return JSON.parse(readFileSync(filePath, 'utf-8')) as BridgeFixture
}

function readText(filePath: string): string {
  return readFileSync(filePath, 'utf-8')
}

function assertObjectKeyParity(left: unknown, right: unknown, path = '$'): void {
  if (left === null || right === null) {
    return
  }

  if (typeof left !== 'object' || typeof right !== 'object') {
    return
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    return
  }

  const leftObject = left as Record<string, unknown>
  const rightObject = right as Record<string, unknown>
  const leftKeys = Object.keys(leftObject).sort()
  const rightKeys = Object.keys(rightObject).sort()

  expect(leftKeys, `${path} key parity drift`).toEqual(rightKeys)

  for (const key of leftKeys) {
    assertObjectKeyParity(leftObject[key], rightObject[key], `${path}.${key}`)
  }
}

function expectSnippets(source: string, snippets: readonly string[], context: string): void {
  for (const snippet of snippets) {
    expect(source, `${context}: missing snippet ${snippet}`).toContain(snippet)
  }
}

describe('network bridge parity integration (android/ios fixtures + transport tests)', () => {
  it('enforces key-for-key fixture parity with explicit malformed metadata differences', () => {
    const android = readFixture('android')
    const ios = readFixture('ios')

    assertObjectKeyParity(android, ios)

    expect(android.request_invalid.status_code).toBe(400)
    expect(ios.request_invalid.status_code).toBeNull()
    expect(android.request_invalid.error_code).toBe('invalid_param')
    expect(ios.request_invalid.error_code).toBe('invalid_payload')
    expect(android.sse_open_invalid.error_code).toBe('invalid_param')
    expect(ios.sse_open_invalid.error_code).toBe('invalid_payload')
    expect(android.sse_close_invalid.error_code).toBe('invalid_param')
    expect(ios.sse_close_invalid.error_code).toBe('invalid_payload')
  })

  it('locks request error code constants parity across Android and iOS transport implementations', () => {
    const androidRequestImpl = readText(androidRequestTestPath)
    const iosRequestTest = readText(iosRequestTestPath)

    expectSnippets(
      androidRequestImpl,
      [
        'HTTP_STATUS_GATEWAY_TIMEOUT = 504',
        'ERROR_CODE_TIMEOUT = "bridge_timeout"',
        'ERROR_CODE_PROTOCOL = "bridge_protocol"',
        'ERROR_CODE_UNAVAILABLE = "bridge_unavailable"',
      ],
      'android request transport error constants',
    )

    expectSnippets(
      iosRequestTest,
      [
        'ok: (200 ..< 300).contains(statusCode)',
        'statusCode: NativeNetworkRequestDefaults.statusGatewayTimeout',
        'errorCode: "bridge_timeout"',
        'statusCode: NativeNetworkRequestDefaults.statusClientClosed',
        'errorCode: "bridge_cancelled"',
        'errorCode: "bridge_unavailable"',
      ],
      'ios request transport parity',
    )
  })

  it('locks malformed payload error-code mapping drift intentionally', () => {
    const androidBridgeContract = readText(androidBridgeContractPath)
    const iosBridgeContract = readText(iosBridgeContractPath)

    expectSnippets(
      androidBridgeContract,
      [
        'handleNetworkRequest',
        'handleSseOpen',
        'handleSseClose',
        'errorResult("invalid_payload")',
      ],
      'android malformed payload mapping',
    )

    expectSnippets(
      iosBridgeContract,
      [
        '["ok": false, "error_code": "invalid_payload"]',
        '["error_code": "invalid_payload"]',
        '["closed": false, "error_code": "invalid_payload"]',
      ],
      'ios malformed payload mapping',
    )
  })

  it('locks SSE reconnect and lifecycle parity markers across Android and iOS implementations', () => {
    const androidSseImpl = readText(androidSseTestPath)
    const iosSseTest = readText(iosSseTestPath)

    expectSnippets(
      androidSseImpl,
      [
        'scheduleReconnect',
        'lastEventId',
        'Last-Event-ID',
        'reconnectAttempt',
      ],
      'android sse reconnect implementation markers',
    )

    expectSnippets(
      iosSseTest,
      [
        'scheduleReconnect(errorCode: mapped.code, errorMessage: mapped.message, retryAttempt: snapshot.retryAttempt + 1)',
        'request.setValue(lastEventID, forHTTPHeaderField: "Last-Event-ID")',
        'private let NativeNetworkSseErrorStreamClosed = "stream_closed"',
      ],
      'ios sse reconnect-required parity',
    )
  })
})
