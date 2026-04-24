import type { OpencodeWrapperConfig } from '../../opencode/types.js'
import { createBackendFacade } from '../facade.js'
import type { BackendClient, OpencodeBackendTarget } from '../types.js'

export interface OpencodeBackendConnectionInput {
  ip: string
  port: string
  password?: string
}

export interface OpencodeBackendConnection {
  ip: string
  port: string
  password: string
}

export interface ConnectOpencodeBackendClientResult {
  client: BackendClient
  connection: OpencodeBackendConnection
  serverLabel: string
}

interface CreateOpencodeBackendClientOptions {
  createClient?: (target: OpencodeBackendTarget) => BackendClient
}

interface ConnectOpencodeBackendClientOptions
  extends CreateOpencodeBackendClientOptions {}

export function normalizeOpencodeBackendConnection(
  connection: OpencodeBackendConnectionInput,
): OpencodeBackendConnection {
  return {
    ip: connection.ip.trim(),
    port: connection.port.trim(),
    password:
      typeof connection.password === 'string' ? connection.password : '',
  }
}

export function validateOpencodeBackendConnection(
  connection: OpencodeBackendConnectionInput,
): string | null {
  const normalized = normalizeOpencodeBackendConnection(connection)

  if (normalized.ip.length === 0) {
    return 'Server IP is required.'
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

export function formatOpencodeBackendServerLabel(
  connection: OpencodeBackendConnectionInput,
): string {
  const normalized = normalizeOpencodeBackendConnection(connection)
  return `${normalized.ip}:${normalized.port}`
}

export function createOpencodeBackendConfigFromConnection(
  connection: OpencodeBackendConnectionInput,
): OpencodeWrapperConfig {
  const normalized = normalizeOpencodeBackendConnection(connection)

  return {
    baseUrl: `http://${normalized.ip}:${normalized.port}`,
    ...(normalized.password.length > 0 ? { auth: normalized.password } : {}),
  }
}

export function createOpencodeBackendTarget(
  config: OpencodeWrapperConfig,
): OpencodeBackendTarget {
  return {
    kind: 'opencode',
    config,
  }
}

export function createOpencodeBackendClient(
  config: OpencodeWrapperConfig,
  options: CreateOpencodeBackendClientOptions = {},
): BackendClient {
  const createClient = options.createClient ?? createBackendFacade
  return createClient(createOpencodeBackendTarget(config))
}

export function createOpencodeBackendClientFromConnection(
  connection: OpencodeBackendConnectionInput,
  options: CreateOpencodeBackendClientOptions = {},
): BackendClient {
  return createOpencodeBackendClient(
    createOpencodeBackendConfigFromConnection(connection),
    options,
  )
}

export async function connectOpencodeBackendClient(
  connection: OpencodeBackendConnectionInput,
  options: ConnectOpencodeBackendClientOptions = {},
): Promise<ConnectOpencodeBackendClientResult> {
  const normalized = normalizeOpencodeBackendConnection(connection)
  const validationError = validateOpencodeBackendConnection(normalized)

  if (validationError) {
    throw new Error(validationError)
  }

  const client = createOpencodeBackendClientFromConnection(normalized, options)
  await client.sessions.list()

  return {
    client,
    connection: normalized,
    serverLabel: formatOpencodeBackendServerLabel(normalized),
  }
}
