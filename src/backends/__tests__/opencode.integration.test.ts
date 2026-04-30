import { createServer } from 'node:http'
import { once } from 'node:events'
import type {
  IncomingMessage,
  Server as HttpServer,
  ServerResponse,
} from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'

import { createOpencodeGateway } from '../../opencode/gateway.js'
import type {
  EventSourceLike,
  OpenCodeGatewayContract,
} from '../../opencode/gateway.js'
import { createHttpTestOpencodeGateway } from '../../opencode/test-support.js'
import type { OpencodeWrapperConfig } from '../../opencode/types.js'
import { connectOpencodeBackendClient } from '../opencode/page-migration.js'
import { createOpenCodeBackendAdapter } from '../opencode/adapter.js'
import type { BackendEvent } from '../types.js'

interface RecordedRequest {
  method: string
  path: string
  query: Record<string, string>
  bodyText: string
  bodyJson: unknown
}

interface MockOpencodeServer {
  baseUrl: string
  port: number
  requests: RecordedRequest[]
  emitGlobalEvent(
    payload: unknown,
    options?: {
      id?: string
      event?: string
      retry?: number
    },
  ): void
  close(): Promise<void>
}

class FetchEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null

  private readonly controller = new AbortController()
  private closed = false

  constructor(private readonly url: string) {
    void this.start()
  }

  close(): void {
    this.closed = true
    this.controller.abort()
  }

  private async start(): Promise<void> {
    try {
      const response = await fetch(this.url, {
        headers: {
          accept: 'text/event-stream',
        },
        signal: this.controller.signal,
      })

      if (!response.ok) {
        throw new Error(`SSE failed: ${response.status}`)
      }

      if (!response.body) {
        throw new Error('SSE response body missing')
      }

      if (this.closed) {
        return
      }

      this.onopen?.({ type: 'open' } as Event)

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (!this.closed) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }

        buffer += decoder.decode(value, { stream: true })
        buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

        const chunks = buffer.split('\n\n')
        buffer = chunks.pop() ?? ''

        for (const chunk of chunks) {
          const dataLines: string[] = []
          const lines = chunk.split('\n')

          for (const line of lines) {
            if (line.startsWith('data:')) {
              dataLines.push(line.replace(/^data:\s*/, ''))
            }
          }

          if (dataLines.length === 0) {
            continue
          }

          this.onmessage?.({
            data: dataLines.join('\n'),
          } as MessageEvent)
        }
      }
    } catch (error) {
      if (this.closed) {
        return
      }

      if (error instanceof Error && error.name === 'AbortError') {
        return
      }

      this.onerror?.(error as Event)
    }
  }
}

function createFetchEventSource(url: string): EventSourceLike {
  return new FetchEventSource(url)
}

async function readBodyText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []

  for await (const chunk of request) {
    chunks.push(
      typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk),
    )
  }

  return Buffer.concat(chunks).toString('utf8')
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.setHeader('content-length', Buffer.byteLength(payload))
  response.end(payload)
}

async function startMockOpencodeServer(): Promise<MockOpencodeServer> {
  const requests: RecordedRequest[] = []
  const sseClients = new Set<ServerResponse>()

  const server = createServer(async (request, response) => {
    const method = request.method ?? 'GET'
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const bodyText = await readBodyText(request)
    let bodyJson: unknown = undefined

    if (bodyText.length > 0) {
      try {
        bodyJson = JSON.parse(bodyText)
      } catch {
        bodyJson = bodyText
      }
    }

    requests.push({
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      bodyText,
      bodyJson,
    })

    if (method === 'GET' && url.pathname === '/experimental/session') {
      writeJson(response, 200, [
        {
          id: 'session-1',
          title: 'Session One',
          status: 'idle',
          directory: '/repo/default',
          projectID: 'project-1',
          workspaceID: 'default',
          time: {
            updated: Date.parse('2026-01-01T00:00:00.000Z'),
          },
          project: {
            id: 'project-1',
            worktree: '/repo/default',
            name: 'Repo One',
          },
        },
      ])
      return
    }

    if (method === 'GET' && url.pathname === '/session/session-1') {
      writeJson(response, 200, {
        id: 'session-1',
        title: 'Session One',
        status: 'running',
        parentID: 'parent-1',
        directory: '/repo/default',
        time: {
          created: Date.parse('2025-12-31T23:59:59.000Z'),
          updated: Date.parse('2026-01-01T00:00:00.000Z'),
        },
      })
      return
    }

    if (method === 'GET' && url.pathname === '/session/session-1/message') {
      writeJson(response, 200, [
        {
          info: {
            id: 'message-1',
            sessionID: 'session-1',
            role: 'assistant',
            providerID: 'anthropic',
            modelID: 'claude-sonnet-4',
            agent: 'build',
            variant: 'high',
            time: {
              created: Date.parse('2026-01-01T00:00:01.000Z'),
              completed: Date.parse('2026-01-01T00:00:02.000Z'),
            },
          },
          parts: [
            {
              type: 'text',
              text: 'hello from server',
            },
          ],
        },
      ])
      return
    }

    if (method === 'POST' && url.pathname === '/session') {
      const body = (bodyJson ?? {}) as Record<string, unknown>
      const directory =
        typeof body.directory === 'string' && body.directory.length > 0
          ? body.directory
          : (typeof url.searchParams.get('directory') === 'string'
              ? url.searchParams.get('directory')!
              : '/repo/default')
      writeJson(response, 200, {
        id: 'session-new-1',
        title: typeof body.title === 'string' ? body.title : null,
        status: 'idle',
        directory,
        time: {
          created: Date.parse('2026-01-01T00:00:00.500Z'),
          updated: Date.parse('2026-01-01T00:00:00.500Z'),
        },
      })
      return
    }

    if (method === 'POST' && url.pathname === '/session/session-1/message') {
      writeJson(response, 200, {
        info: {
          id: 'assistant-1',
          sessionID: 'session-1',
          role: 'assistant',
          time: {
            created: Date.parse('2026-01-01T00:00:03.000Z'),
          },
        },
      })
      return
    }

    {
      const promptMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/)
      if (method === 'POST' && promptMatch) {
        const sessionIDFromPath = promptMatch[1]
        writeJson(response, 200, {
          info: {
            id: `assistant-${sessionIDFromPath}`,
            sessionID: sessionIDFromPath,
            role: 'assistant',
            time: {
              created: Date.parse('2026-01-01T00:00:03.000Z'),
            },
          },
        })
        return
      }
    }

    if (method === 'GET' && url.pathname === '/provider') {
      writeJson(response, 200, {
        all: [
          {
            id: 'anthropic',
            name: 'Anthropic',
            models: {
              'claude-sonnet-4': {
                id: 'claude-sonnet-4',
                name: 'Claude Sonnet 4',
                reasoning: true,
                variants: {
                  low: {},
                  high: {},
                },
              },
            },
          },
        ],
        default: {
          anthropic: 'claude-sonnet-4',
        },
      })
      return
    }

    if (method === 'GET' && url.pathname === '/agent') {
      writeJson(response, 200, [
        {
          name: 'build',
          description: 'Build things',
          mode: 'primary',
        },
      ])
      return
    }

    if (method === 'GET' && url.pathname === '/global/event') {
      response.statusCode = 200
      response.setHeader('content-type', 'text/event-stream')
      response.setHeader('cache-control', 'no-cache')
      response.setHeader('connection', 'keep-alive')
      response.flushHeaders?.()
      response.write(': connected\n\n')
      sseClients.add(response)
      response.on('close', () => {
        sseClients.delete(response)
      })
      return
    }

    writeJson(response, 404, {
      error: {
        message: `Unhandled mock route: ${method} ${url.pathname}`,
      },
      response: {
        status: 404,
        statusText: 'Not Found',
      },
    })
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve mock server port.')
  }

  const close = async () => {
    for (const client of Array.from(sseClients)) {
      client.end()
    }

    await new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error) {
          reject(error)
          return
        }

        resolve()
      })
    })
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requests,
    emitGlobalEvent(payload, options = {}) {
      const lines: string[] = []

      if (typeof options.event === 'string') {
        lines.push(`event: ${options.event}`)
      }

      if (typeof options.id === 'string') {
        lines.push(`id: ${options.id}`)
      }

      if (typeof options.retry === 'number') {
        lines.push(`retry: ${options.retry}`)
      }

      lines.push(`data: ${JSON.stringify(payload)}`)
      const frame = `${lines.join('\n')}\n\n`

      for (const client of Array.from(sseClients)) {
        client.write(frame)
      }
    },
    close,
  }
}

function createRealHttpGateway(config: OpencodeWrapperConfig): OpenCodeGatewayContract {
  return createHttpTestOpencodeGateway(config, createFetchEventSource)
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }

    await new Promise(resolve => setTimeout(resolve, 20))
  }

  throw new Error('Timed out waiting for condition.')
}

const activeServers = new Set<MockOpencodeServer>()

afterEach(async () => {
  await Promise.all(
    Array.from(activeServers).map(async server => {
      activeServers.delete(server)
      await server.close()
    }),
  )
})

describe('opencode backend integration with mock server', () => {
  it('connects and exercises list/messages/prompt/catalog over real HTTP', async () => {
    const server = await startMockOpencodeServer()
    activeServers.add(server)

    const result = await connectOpencodeBackendClient(
      {
        ip: '127.0.0.1',
        port: String(server.port),
        password: '',
      },
      {
        createClient(target) {
          return createOpenCodeBackendAdapter(target.config, {
            createGateway: createRealHttpGateway,
          })
        },
      },
    )

    expect(result.serverLabel).toBe(`127.0.0.1:${server.port}`)
    expect(result.connection).toEqual({
      ip: '127.0.0.1',
      port: String(server.port),
      password: '',
    })

    await expect(
      result.client.sessions.list({
        directory: '/repo/override',
        workspaceID: 'default',
      }),
    ).resolves.toEqual([
      {
        backend: 'opencode',
        id: 'session-1',
        title: 'Session One',
        status: 'idle',
        updatedAt: '2026-01-01T00:00:00.000Z',
        directory: '/repo/default',
        projectLabel: 'Repo One',
        backendMeta: {
          projectID: 'project-1',
          workspaceID: 'default',
          project: {
            id: 'project-1',
            worktree: '/repo/default',
            name: 'Repo One',
          },
        },
      },
    ])

    await expect(result.client.sessions.get('session-1')).resolves.toMatchObject({
      backend: 'opencode',
      id: 'session-1',
      parentID: 'parent-1',
      createdAt: '2025-12-31T23:59:59.000Z',
    })

    await expect(result.client.sessions.messages('session-1')).resolves.toEqual([
      {
        id: 'message-1',
        sessionID: 'session-1',
        role: 'assistant',
        createdAt: '2026-01-01T00:00:01.000Z',
        completedAt: '2026-01-01T00:00:02.000Z',
        parts: [
          {
            type: 'text',
            text: 'hello from server',
          },
        ],
        backendMeta: {
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4',
          agent: 'build',
          variant: 'high',
        },
      },
    ])

    await expect(
      result.client.sessions.prompt(
        'session-1',
        {
          parts: [{ type: 'text', text: 'hello over http' }],
          model: {
            providerID: 'anthropic',
            modelID: 'claude-sonnet-4',
          },
          agent: 'build',
          reasoningEffort: 'high',
          tools: {
            bash: true,
          },
        },
        {
          directory: '/repo/override',
          workspaceID: 'default',
        },
      ),
    ).resolves.toEqual({
      sessionID: 'session-1',
      messageID: 'assistant-1',
      backendMeta: {
        role: 'assistant',
        createdAt: '2026-01-01T00:00:03.000Z',
      },
    })

    await expect(result.client.catalog?.providers()).resolves.toEqual({
      providers: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          models: [
            {
              id: 'claude-sonnet-4',
              name: 'Claude Sonnet 4',
              reasoning: true,
              reasoningEfforts: ['low', 'high'],
              backendMeta: {
                variants: {
                  low: {},
                  high: {},
                },
              },
            },
          ],
        },
      ],
      defaults: {
        anthropic: 'claude-sonnet-4',
      },
    })

    await expect(result.client.catalog?.agents()).resolves.toEqual([
      {
        id: 'build',
        name: 'build',
        description: 'Build things',
        backendMeta: {
          mode: 'primary',
        },
      },
    ])

    const listRequest = server.requests.find(
      request =>
        request.method === 'GET' &&
        request.path === '/experimental/session' &&
        request.query.directory === '/repo/override',
    )

    expect(listRequest).toBeDefined()
    expect(listRequest?.query.workspace).toBe('default')

    const promptRequest = server.requests.find(
      request =>
        request.method === 'POST' &&
        request.path === '/session/session-1/message',
    )

    expect(promptRequest).toBeDefined()
    expect(promptRequest?.query).toEqual({
      directory: '/repo/override',
      workspace: 'default',
    })
    expect(promptRequest?.bodyJson).toEqual({
      model: {
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4',
      },
      agent: 'build',
      tools: {
        bash: true,
      },
      variant: 'high',
      parts: [{ type: 'text', text: 'hello over http' }],
    })
  })

  it('creates a new session then prompts it (new-session flow) over real HTTP', async () => {
    const server = await startMockOpencodeServer()
    activeServers.add(server)

    const result = await connectOpencodeBackendClient(
      {
        ip: '127.0.0.1',
        port: String(server.port),
        password: '',
      },
      {
        createClient(target) {
          return createOpenCodeBackendAdapter(target.config, {
            createGateway: createRealHttpGateway,
          })
        },
      },
    )

    const created = await result.client.sessions.create({
      directory: '/repo/new-session-target',
    })
    expect(created).toMatchObject({
      backend: 'opencode',
      id: 'session-new-1',
      directory: '/repo/new-session-target',
      createdAt: '2026-01-01T00:00:00.500Z',
    })

    const promptResult = await result.client.sessions.prompt(
      created.id,
      {
        parts: [{ type: 'text', text: 'hello new world' }],
        model: {
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4',
        },
        agent: 'build',
      },
      { directory: '/repo/new-session-target' },
    )
    expect(promptResult).toMatchObject({
      sessionID: 'session-new-1',
      messageID: 'assistant-session-new-1',
    })

    const createRequest = server.requests.find(
      request => request.method === 'POST' && request.path === '/session',
    )
    expect(createRequest).toBeDefined()
    expect(createRequest?.query.directory).toBe('/repo/new-session-target')

    const promptRequest = server.requests.find(
      request =>
        request.method === 'POST' && request.path === '/session/session-new-1/message',
    )
    expect(promptRequest).toBeDefined()
    expect(promptRequest?.bodyJson).toMatchObject({
      agent: 'build',
      model: {
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4',
      },
      parts: [{ type: 'text', text: 'hello new world' }],
    })
    expect(promptRequest?.query.directory).toBe('/repo/new-session-target')
  })

  it('subscribes to real SSE and maps streamed events through the adapter', async () => {
    const server = await startMockOpencodeServer()
    activeServers.add(server)

    const client = createOpenCodeBackendAdapter(
      { baseUrl: server.baseUrl },
      { createGateway: createRealHttpGateway },
    )

    const events: BackendEvent[] = []
    const states: string[] = []
    const errors: unknown[] = []

    const subscription = client.events.subscribe({
      autoStart: true,
      onEvent(event) {
        events.push(event)
      },
      onConnectionStateChange(state) {
        states.push(state.status)
      },
      onError(error) {
        errors.push(error)
      },
    })

    await waitForCondition(() => states.includes('open'))

    server.emitGlobalEvent({
      type: 'session.status',
      properties: {
        sessionID: 'session-1',
        status: 'running',
      },
    })

    server.emitGlobalEvent({
      type: 'message.part.delta',
      properties: {
        sessionID: 'session-1',
        messageID: 'message-1',
        partID: 'part-1',
        deltaIndex: 0,
        delta: 'hello',
      },
    })

    server.emitGlobalEvent({
      type: 'message.part.updated',
      properties: {
        eventID: 'evt-1',
        sessionID: 'session-1',
        messageID: 'message-1',
        partID: 'part-1',
        partIndex: 0,
      },
    })

    server.emitGlobalEvent({
      type: 'message.part.updated',
      properties: {
        eventID: 'evt-2',
        sessionID: 'session-1',
        messageID: 'message-1',
        partID: 'part-1',
        partIndex: 2,
      },
    })

    server.emitGlobalEvent({
      type: 'provider.changed',
      properties: {
        providerID: 'anthropic',
      },
    })

    await waitForCondition(() => events.length >= 6)

    expect(events).toEqual([
      {
        backend: 'opencode',
        type: 'session.updated',
        raw: {
          type: 'session.status',
          properties: {
            sessionID: 'session-1',
            status: 'running',
          },
        },
        sourceType: 'session.status',
        payload: {
          sessionID: 'session-1',
          status: 'running',
        },
        sessionID: 'session-1',
        status: 'running',
      },
      {
        backend: 'opencode',
        type: 'message.delta',
        raw: {
          type: 'message.part.delta',
          properties: {
            sessionID: 'session-1',
            messageID: 'message-1',
            partID: 'part-1',
            deltaIndex: 0,
            delta: 'hello',
          },
        },
        sourceType: 'message.part.delta',
        payload: {
          sessionID: 'session-1',
          messageID: 'message-1',
          partID: 'part-1',
          deltaIndex: 0,
          delta: 'hello',
        },
        sessionID: 'session-1',
        messageID: 'message-1',
        partID: 'part-1',
      },
      {
        backend: 'opencode',
        type: 'message.updated',
        raw: {
          type: 'message.part.updated',
          properties: {
            eventID: 'evt-1',
            sessionID: 'session-1',
            messageID: 'message-1',
            partID: 'part-1',
            partIndex: 0,
          },
        },
        sourceType: 'message.part.updated',
        payload: {
          eventID: 'evt-1',
          sessionID: 'session-1',
          messageID: 'message-1',
          partID: 'part-1',
          partIndex: 0,
        },
        sessionID: 'session-1',
        messageID: 'message-1',
        partID: 'part-1',
      },
      {
        backend: 'opencode',
        type: 'resync.required',
        raw: {
          event: {
            type: 'message.part.updated',
            properties: {
              eventID: 'evt-2',
              sessionID: 'session-1',
              messageID: 'message-1',
              partID: 'part-1',
              partIndex: 2,
            },
          },
          action: {
            type: 'refetchRequired',
            eventName: 'message.part.updated',
            reason: 'gap',
            orderKey: 'message:session-1:message-1',
            expectedSequence: 1,
            receivedSequence: 2,
            refetchRequired: true,
          },
        },
        sourceType: 'message.part.updated',
        payload: {
          eventName: 'message.part.updated',
          reason: 'gap',
          orderKey: 'message:session-1:message-1',
          expectedSequence: 1,
          receivedSequence: 2,
        },
        sessionID: 'session-1',
        messageID: 'message-1',
        partID: 'part-1',
      },
      {
        backend: 'opencode',
        type: 'message.updated',
        raw: {
          type: 'message.part.updated',
          properties: {
            eventID: 'evt-2',
            sessionID: 'session-1',
            messageID: 'message-1',
            partID: 'part-1',
            partIndex: 2,
          },
        },
        sourceType: 'message.part.updated',
        payload: {
          eventID: 'evt-2',
          sessionID: 'session-1',
          messageID: 'message-1',
          partID: 'part-1',
          partIndex: 2,
        },
        sessionID: 'session-1',
        messageID: 'message-1',
        partID: 'part-1',
      },
      {
        backend: 'opencode',
        type: 'raw',
        raw: {
          type: 'unknown',
          eventType: 'provider.changed',
          properties: {
            providerID: 'anthropic',
          },
        },
        sourceType: 'provider.changed',
        payload: {
          providerID: 'anthropic',
        },
      },
    ])

    expect(states).toContain('connecting')
    expect(states).toContain('open')
    expect(errors).toEqual([])

    subscription.stop('done')
  })
})
