import { createBackendFacade } from '../facade.js'
import type { BackendClient, CodexBackendTarget } from '../types.js'
import type { CodexBackendConfig } from './adapter.js'

export interface CodexBackendConnectionInput {
  host: string
  port: string
  token?: string
  secure?: boolean
}

export interface CodexBackendConnection {
  host: string
  port: string
  token: string
  secure: boolean
}

export interface ConnectCodexBackendClientResult {
  client: BackendClient
  connection: CodexBackendConnection
  serverLabel: string
}

interface CreateCodexBackendClientOptions {
  createClient?: (target: CodexBackendTarget) => BackendClient
}

interface ConnectCodexBackendClientOptions
  extends CreateCodexBackendClientOptions {}

export function normalizeCodexBackendConnection(
  connection: CodexBackendConnectionInput,
): CodexBackendConnection {
  return {
    host: connection.host.trim(),
    port: connection.port.trim(),
    token: typeof connection.token === 'string' ? connection.token : '',
    secure: connection.secure === true,
  }
}

export function validateCodexBackendConnection(
  connection: CodexBackendConnectionInput,
): string | null {
  const normalized = normalizeCodexBackendConnection(connection)

  if (normalized.host.length === 0) {
    return 'Server host is required.'
  }

  const portNum = Number(normalized.port)
  if (
    normalized.port.length === 0 ||
    !Number.isInteger(portNum) ||
    portNum < 1 ||
    portNum > 65535
  ) {
    return 'Port must be a number between 1 and 65535.'
  }

  return null
}

export function formatCodexBackendServerLabel(
  connection: CodexBackendConnectionInput,
): string {
  const normalized = normalizeCodexBackendConnection(connection)
  const scheme = normalized.secure ? 'wss' : 'ws'
  return `${scheme}://${normalized.host}:${normalized.port}`
}

export function createCodexBackendConfigFromConnection(
  connection: CodexBackendConnectionInput,
): CodexBackendConfig {
  const normalized = normalizeCodexBackendConnection(connection)
  const scheme = normalized.secure ? 'wss' : 'ws'

  return {
    url: `${scheme}://${normalized.host}:${normalized.port}`,
    ...(normalized.token.length > 0
      ? { headers: { Authorization: `Bearer ${normalized.token}` } }
      : {}),
  }
}

export function createCodexBackendTarget(
  config: CodexBackendConfig,
): CodexBackendTarget {
  return {
    kind: 'codex',
    config,
  }
}

export function createCodexBackendClient(
  config: CodexBackendConfig,
  options: CreateCodexBackendClientOptions = {},
): BackendClient {
  const createClient = options.createClient ?? createBackendFacade
  return createClient(createCodexBackendTarget(config))
}

export function createCodexBackendClientFromConnection(
  connection: CodexBackendConnectionInput,
  options: CreateCodexBackendClientOptions = {},
): BackendClient {
  return createCodexBackendClient(
    createCodexBackendConfigFromConnection(connection),
    options,
  )
}

export async function connectCodexBackendClient(
  connection: CodexBackendConnectionInput,
  options: ConnectCodexBackendClientOptions = {},
): Promise<ConnectCodexBackendClientResult> {
  const normalized = normalizeCodexBackendConnection(connection)
  const validationError = validateCodexBackendConnection(normalized)

  if (validationError) {
    throw new Error(validationError)
  }

  const client = createCodexBackendClientFromConnection(normalized, options)
  await client.sessions.list()

  return {
    client,
    connection: normalized,
    serverLabel: formatCodexBackendServerLabel(normalized),
  }
}
