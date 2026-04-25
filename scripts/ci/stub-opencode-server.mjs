#!/usr/bin/env node
// Minimal OpenCode-shaped HTTP fixture server for CI UI tests.
// iOS Simulator can reach this host server via 127.0.0.1, while Android
// emulator tests must use the host alias 10.0.2.2.
//
// Used by testMainFlowOpensChatWithSavedConnectionAndRouteParams which
// performs a real GET /session from the test process, plus the Lynx app
// itself which fetches sessions and messages once the saved connection
// points at the platform-specific host URL.
//
// Responds to:
//   GET /session                      → [{ id, title }]
//   GET /session/:id/message          → one message with a text part (>= 12 chars)
//   GET /global/event                 → minimal OpenCode-shaped SSE stream
//   anything else                     → 404
//
// Exit with Ctrl-C or send SIGTERM.

import { createServer } from 'node:http'

const PORT = Number(process.env.STUB_SERVER_PORT ?? 3000)
const HOST = process.env.STUB_SERVER_HOST ?? '127.0.0.1'

const SESSION_ID = 'ses_ci'
const SESSION_TITLE = 'CI Fixture Session'
const FIXTURE_MESSAGE_TEXT = 'Hello from CI fixture, this is a stable message line.'
const NOW_MS = Date.now()
const sseStreams = new Set()

const sessions = [
  {
    id: SESSION_ID,
    slug: 'ci-fixture-session',
    projectID: 'prj_ci',
    directory: '/tmp/ci-fixture',
    title: SESSION_TITLE,
    version: '0.0.0-ci-stub',
    time: {
      created: NOW_MS,
      updated: NOW_MS,
    },
  },
]

const messagesBySession = {
  [SESSION_ID]: [
    {
      info: {
        id: 'msg_ci_1',
        sessionID: SESSION_ID,
        role: 'assistant',
        time: {
          created: NOW_MS,
          completed: NOW_MS,
        },
        parentID: 'msg_ci_0',
        modelID: 'ci-stub-model',
        providerID: 'ci-stub-provider',
        mode: 'default',
        agent: 'ci-stub',
        path: {
          cwd: '/tmp/ci-fixture',
          root: '/tmp/ci-fixture',
        },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
      parts: [
        {
          id: 'prt_ci_1',
          sessionID: SESSION_ID,
          messageID: 'msg_ci_1',
          type: 'text',
          text: FIXTURE_MESSAGE_TEXT,
        },
      ],
    },
  ],
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function writeSseEvent(res, { id, event, data }) {
  if (id) {
    res.write(`id: ${id}\n`)
  }
  if (event) {
    res.write(`event: ${event}\n`)
  }
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function openGlobalEventStream(_req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })

  res.write(': connected\n\n')
  writeSseEvent(res, {
    id: 'evt_ci_1',
    event: 'server.connected',
    data: {
      payload: {
        type: 'server.connected',
        properties: {},
      },
    },
  })

  const heartbeat = setInterval(() => {
    res.write(`: heartbeat ${Date.now()}\n\n`)
  }, 15_000)

  const stream = { res, heartbeat }
  sseStreams.add(stream)
  res.on('close', () => {
    clearInterval(heartbeat)
    sseStreams.delete(stream)
  })
}

function routeRequest(req, res) {
  if (req.method !== 'GET') {
    writeJson(res, 405, { error: 'method_not_allowed' })
    return
  }

  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`)
  const path = url.pathname

  if (path === '/session' || path === '/experimental/session') {
    // /session returns Session[]; /experimental/session returns GlobalSession[]
    // which the app normalizes via unwrapSessionEnvelope. Same minimal payload
    // is accepted by both shapes given the fields we're populating.
    writeJson(res, 200, sessions)
    return
  }

  if (path === '/global/event') {
    openGlobalEventStream(req, res)
    return
  }

  const messageMatch = path.match(/^\/session\/([^/]+)\/message$/)
  if (messageMatch) {
    const id = messageMatch[1]
    const messages = messagesBySession[id] ?? []
    writeJson(res, 200, messages)
    return
  }

  writeJson(res, 404, { error: 'not_found', path })
}

const server = createServer((req, res) => {
  console.log(`[stub-opencode-server] ${req.method} ${req.url}`)
  try {
    routeRequest(req, res)
  } catch (err) {
    console.error('[stub-opencode-server] request error:', err)
    if (!res.headersSent) {
      writeJson(res, 500, { error: 'internal_error' })
    }
  }
})

server.listen(PORT, HOST, () => {
  console.log(`[stub-opencode-server] listening on http://${HOST}:${PORT}`)
})

function shutdown(signal) {
  console.log(`[stub-opencode-server] received ${signal}, shutting down`)
  for (const stream of Array.from(sseStreams)) {
    clearInterval(stream.heartbeat)
    stream.res.end()
    sseStreams.delete(stream)
  }
  server.close(() => process.exit(0))
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
