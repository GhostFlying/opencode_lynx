import { createOpencodeClient } from '@opencode-ai/sdk/v2/client'

import { resolveDirectory, resolveWorkspaceSelector } from './config.js'
import { OpencodeWrapperError, isRecord, normalizeSdkError } from './errors.js'
import {
  createOpencodeNetworkBridgeClient,
} from './network/bridge-client.js'
import type { OpencodeNetworkResponse } from './network/contract.js'
import type {
  OpencodeClientScope,
  OpencodeWrapperConfig,
  OpencodeWorkspaceSelector,
} from './types.js'

/**
 * Request options resolved by the wrapper before a specific SDK operation runs.
 */
export interface NormalizedRequestOptions {
  readonly directory?: string
  readonly workspace: OpencodeWorkspaceSelector['id']
  readonly headers?: Readonly<Record<string, string>>
}

type SdkClient = ReturnType<typeof createOpencodeClient>

type SdkOperation<T> = (client: SdkClient, options: NormalizedRequestOptions) => Promise<T> | T

interface WrappedSdkClientDeps {
  createClient?: (config?: Parameters<typeof createOpencodeClient>[0]) => unknown
  createNetworkClient?: () => ReturnType<typeof createOpencodeNetworkBridgeClient>
}

interface SdkErrorEnvelope {
  error: unknown
  response?: {
    status?: unknown
    statusText?: unknown
  } | null
}

export interface SdkResponseEnvelope<TData = unknown> extends SdkErrorEnvelope {
  data?: TData
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim()

  if (trimmed.length === 0) {
    throw new OpencodeWrapperError('OpenCode baseUrl is required.', {
      code: 'invalid_config',
      retryable: false,
    })
  }

  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
}

function toSdkEnvelopeError(envelope: SdkErrorEnvelope): unknown {
  const status = typeof envelope.response?.status === 'number'
    ? envelope.response.status
    : undefined
  const statusText = typeof envelope.response?.statusText === 'string'
    ? envelope.response.statusText.trim()
    : ''
  const fallbackMessage = statusText.length > 0
    ? `OpenCode server request failed with status ${status} ${statusText}.`
    : status !== undefined
      ? `OpenCode server request failed with status ${status}.`
      : 'OpenCode server request failed.'

  if (isRecord(envelope.error)) {
    return typeof envelope.error.status === 'number' || status === undefined
      ? envelope.error
      : { ...envelope.error, status }
  }

  if (typeof envelope.error === 'string' && envelope.error.trim().length > 0) {
    return status === undefined
      ? envelope.error
      : { message: envelope.error, status }
  }

  return status === undefined
    ? { message: fallbackMessage }
    : { message: fallbackMessage, status }
}

export function throwIfSdkEnvelopeError(result: unknown): void {
  if (!isRecord(result) || !Object.prototype.hasOwnProperty.call(result, 'error')) {
    return
  }

  const errorValue = result.error
  if (errorValue === undefined || errorValue === null) {
    return
  }

  throw normalizeSdkError(toSdkEnvelopeError(result as SdkErrorEnvelope))
}

export function unwrapSdkEnvelopeData<TData = unknown>(result: unknown): TData | undefined {
  throwIfSdkEnvelopeError(result)

  if (!isRecord(result) || !Object.prototype.hasOwnProperty.call(result, 'data')) {
    return undefined
  }

  return result.data as TData
}

function normalizeSdkOperationResult<T>(result: T): T {
  throwIfSdkEnvelopeError(result)
  return result
}

function toRequestHeaders(headers: Headers): Record<string, string> {
  const normalized: Record<string, string> = {}

  for (const [key, value] of headers.entries()) {
    normalized[key] = value
  }

  return normalized
}

function toResponseBodyInit(body: unknown, headers: Headers): BodyInit | null {
  if (body === null || body === undefined) {
    return null
  }

  if (typeof body === 'string') {
    return body
  }

  if (body instanceof Blob) {
    return body
  }

  if (body instanceof FormData) {
    return body
  }

  if (body instanceof URLSearchParams) {
    return body
  }

  if (body instanceof ReadableStream) {
    return body
  }

  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }

  return JSON.stringify(body)
}

const NO_BODY_STATUSES = new Set([204, 205, 304])

function toFetchResponse(response: OpencodeNetworkResponse & { ok?: boolean }): Response {
  const headers = new Headers()

  for (const [key, value] of Object.entries(response.headers ?? {})) {
    headers.set(key, value)
  }

  const rawBody = NO_BODY_STATUSES.has(response.status)
    ? null
    : toResponseBodyInit(response.body, headers)

  return new Response(rawBody, {
    status: response.status,
    headers,
  })
}

function createNativeFetch(
  deps: WrappedSdkClientDeps,
): (request: Request) => Promise<Response> {
  const createNetworkClient = deps.createNetworkClient ?? (() => createOpencodeNetworkBridgeClient())
  let networkClient: ReturnType<typeof createOpencodeNetworkBridgeClient> | null = null

  const getNetworkClient = () => {
    if (!networkClient) {
      networkClient = createNetworkClient()
    }
    return networkClient
  }

  return async (request: Request): Promise<Response> => {
    const method = (request.method || 'GET').toUpperCase()
    const headers = toRequestHeaders(request.headers)

    let body: string | undefined
    if (method !== 'GET' && method !== 'HEAD') {
      const textBody = await request.clone().text()
      if (textBody.length > 0) {
        body = textBody
      }
    }

    const nativeResponse = await getNetworkClient().request({
      path: request.url,
      method,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(body !== undefined ? { body } : {}),
    }, {
      abortSignal: request.signal,
      // Opencode prompt endpoints block until the agent finishes streaming the
      // full assistant response (can take minutes). The 30s bridge default is
      // too aggressive; rely on AbortSignal for logical cancellation instead.
      timeoutMs: 10 * 60 * 1000,
    })

    return toFetchResponse(nativeResponse)
  }
}

/**
 * Internal SDK adapter used by higher-level wrapper modules.
 */
export interface WrappedSdkClient {
  readonly client: SdkClient
  createRequestOptions(scope?: OpencodeClientScope): NormalizedRequestOptions
  request<T>(operation: SdkOperation<T>, scope?: OpencodeClientScope): Promise<T>
}

/**
 * Create the wrapped SDK client that owns request defaults, scope resolution,
 * and SDK failure normalization.
 */
export function createWrappedSdkClient(
  config: OpencodeWrapperConfig,
  deps: WrappedSdkClientDeps = {},
): WrappedSdkClient {
  const baseUrl = normalizeBaseUrl(config.baseUrl)

  resolveWorkspaceSelector(config, undefined)

  const nativeFetch = createNativeFetch(deps)

  // The SDK client's Config.fetch expects the full DOM fetch signature
  // `(input: URL | RequestInfo, init?: RequestInit) => Promise<Response>`,
  // but the hey-api runtime always wraps calls with `new Request(...)` before
  // invoking fetch, so a narrow Request-only adapter is safe in practice.
  // Cast through `typeof fetch` to satisfy TS without widening the adapter.
  const options = {
    baseUrl,
    ...(config.auth ? { auth: config.auth } : {}),
    ...(config.directory ? { directory: config.directory } : {}),
    ...(config.headers ? { headers: { ...config.headers } } : {}),
    fetch: nativeFetch as unknown as typeof fetch,
  }

  const clientFactory = deps.createClient
  const client = (clientFactory ? clientFactory(options) : createOpencodeClient(options)) as SdkClient

  const createRequestOptions = (scope?: OpencodeClientScope): NormalizedRequestOptions => {
    const workspace = resolveWorkspaceSelector(config, scope)
    const directory = resolveDirectory(config, scope)

    return {
      workspace: workspace.id,
      ...(directory ? { directory } : {}),
      ...(config.headers ? { headers: { ...config.headers } } : {}),
    }
  }

  return {
    client,
    createRequestOptions,
    async request<T>(operation: SdkOperation<T>, scope?: OpencodeClientScope): Promise<T> {
      const requestOptions = createRequestOptions(scope)

      try {
        const result = await operation(client, requestOptions)
        return normalizeSdkOperationResult(result)
      } catch (error) {
        throw normalizeSdkError(error)
      }
    },
  }
}
