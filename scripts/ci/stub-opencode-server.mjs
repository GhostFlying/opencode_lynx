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
//   GET /experimental/session         → same shape (alternate path used by app)
//   GET /session/:id/message          → one message with a text part (>= 12 chars)
//   POST /session                     → newly-created session record (used by + button flow)
//   POST /session/:id/message         → assistant ack (prompt accepted)
//   GET /provider                     → catalog payload { all, default }
//   GET /agent                        → list of agents
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

// Synthetic seed sessions across many distinct worktrees so the new-session
// card can be exercised against a directory list that exceeds
// KNOWN_DIRECTORY_LIMIT (8). The "primary" CI fixture stays at index 0 with
// the freshest updatedAt so existing deeplink-smoke flows keep working.
const EXTRA_FIXTURE_DIRECTORIES = [
  '/Users/dev/projects/alpha',
  '/Users/dev/projects/beta',
  '/Users/dev/projects/gamma',
  '/Users/dev/projects/delta',
  '/Users/dev/projects/epsilon',
  '/Users/dev/projects/zeta',
  '/Users/dev/projects/eta',
  '/Users/dev/projects/theta',
  '/Users/dev/projects/iota',
  '/Users/dev/projects/kappa',
  '/Users/dev/projects/lambda',
]

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
  ...EXTRA_FIXTURE_DIRECTORIES.map((directory, idx) => ({
    id: `ses_ci_seed_${idx}`,
    slug: `ci-seed-${idx}`,
    // All seed sessions share one project so the main session list stays
    // compact (one extra Repository card with N worktrees) while still
    // exposing N distinct directories to the new-session chip strip.
    projectID: 'prj_ci_seed_shared',
    directory,
    title: `Seed session ${idx}`,
    version: '0.0.0-ci-stub',
    // Each seed session is one minute older than the previous; the primary
    // ci-fixture session above is the freshest so it still appears at the
    // top of the chip strip.
    time: {
      created: NOW_MS - (idx + 1) * 60_000,
      updated: NOW_MS - (idx + 1) * 60_000,
    },
  })),
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

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

let createdSessionCounter = 0

async function routeRequest(req, res) {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`)
  const path = url.pathname
  const method = req.method ?? 'GET'

  if (method === 'GET' && (path === '/session' || path === '/experimental/session')) {
    // /session returns Session[]; /experimental/session returns GlobalSession[]
    // which the app normalizes via unwrapSessionEnvelope. Same minimal payload
    // is accepted by both shapes given the fields we're populating.
    writeJson(res, 200, sessions)
    return
  }

  if (method === 'GET' && path === '/global/event') {
    openGlobalEventStream(req, res)
    return
  }

  const messageMatch = path.match(/^\/session\/([^/]+)\/message$/)
  if (method === 'GET' && messageMatch) {
    const id = messageMatch[1]
    const messages = messagesBySession[id] ?? []
    writeJson(res, 200, messages)
    return
  }

  if (method === 'POST' && messageMatch) {
    const id = messageMatch[1]
    const now = Date.now()
    writeJson(res, 200, {
      info: {
        id: `msg_assistant_${now}`,
        sessionID: id,
        role: 'assistant',
        time: { created: now },
      },
    })
    return
  }

  if (method === 'POST' && path === '/session') {
    const body = await readJsonBody(req)
    const directory =
      typeof body.directory === 'string' && body.directory.length > 0
        ? body.directory
        : url.searchParams.get('directory') ?? '/tmp/ci-fixture-new'
    createdSessionCounter += 1
    const newId = `ses_ci_new_${createdSessionCounter}`
    const now = Date.now()
    sessions.unshift({
      id: newId,
      slug: `ci-fixture-new-${createdSessionCounter}`,
      projectID: 'prj_ci',
      directory,
      title: typeof body.title === 'string' ? body.title : null,
      version: '0.0.0-ci-stub',
      time: { created: now, updated: now },
    })
    messagesBySession[newId] = []
    writeJson(res, 200, {
      id: newId,
      directory,
      title: typeof body.title === 'string' ? body.title : null,
      version: '0.0.0-ci-stub',
      time: { created: now, updated: now },
    })
    return
  }

  if (method === 'GET' && path === '/provider') {
    writeJson(res, 200, {
      all: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          models: {
            'claude-sonnet-4-20250514': {
              id: 'claude-sonnet-4-20250514',
              name: 'Claude Sonnet 4',
              reasoning: true,
              variants: { low: {}, medium: {}, high: {}, max: {} },
            },
          },
        },
      ],
      default: { anthropic: 'claude-sonnet-4-20250514' },
      connected: ['anthropic'],
    })
    return
  }

  if (method === 'GET' && path === '/agent') {
    writeJson(res, 200, [
      { name: 'build', description: 'Build things', mode: 'primary' },
      { name: 'plan', description: 'Plan first', mode: 'primary' },
    ])
    return
  }

  if (method !== 'GET' && method !== 'POST') {
    writeJson(res, 405, { error: 'method_not_allowed' })
    return
  }

  writeJson(res, 404, { error: 'not_found', path })
}

const server = createServer((req, res) => {
  console.log(`[stub-opencode-server] ${req.method} ${req.url}`)
  Promise.resolve()
    .then(() => routeRequest(req, res))
    .catch((err) => {
      console.error('[stub-opencode-server] request error:', err)
      if (!res.headersSent) {
        writeJson(res, 500, { error: 'internal_error' })
      }
    })
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
