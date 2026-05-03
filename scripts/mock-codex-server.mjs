#!/usr/bin/env node
// Standalone runner for the Codex JSON-RPC mock fixture. Used by UI e2e
// (`pnpm mock:codex-server`) and by ad-hoc manual smoke runs.
//
//   node scripts/mock-codex-server.mjs --port 7777 --scenario happy-path
//
// Logs every connection / inbound request / outbound response or
// notification to stdout so a developer watching the terminal can see the
// JSON-RPC traffic. SIGINT / SIGTERM trigger a clean shutdown.

import { WebSocketServer } from 'ws'

import { createCodexMockFixture } from '../src/backends/codex/__tests__/mock-server/fixture.mjs'

const VALID_SCENARIOS = new Set(['happy-path', 'approvals', 'tools'])

function parseArgs(argv) {
  const args = { port: 7777, scenario: 'happy-path' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--port') {
      const next = argv[++i]
      const parsed = Number.parseInt(next, 10)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--port expects a positive integer, got ${next}`)
      }
      args.port = parsed
    } else if (arg === '--scenario') {
      const next = argv[++i]
      if (!VALID_SCENARIOS.has(next)) {
        throw new Error(
          `--scenario must be one of: ${[...VALID_SCENARIOS].join(', ')}; got ${next}`,
        )
      }
      args.scenario = next
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return args
}

function printHelp() {
  process.stdout.write(
    [
      'mock-codex-server — JSON-RPC stand-in for `codex app-server`',
      '',
      'Usage:',
      '  node scripts/mock-codex-server.mjs [--port <n>] [--scenario <name>]',
      '',
      'Options:',
      '  --port <n>            Listen on this port (default: 7777)',
      `  --scenario <name>     One of: ${[...VALID_SCENARIOS].join(', ')} (default: happy-path)`,
      '  --help, -h            Show this help text',
      '',
    ].join('\n'),
  )
}

function timestamp() {
  return new Date().toISOString()
}

function log(...parts) {
  process.stdout.write(`[${timestamp()}] ${parts.join(' ')}\n`)
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n\n`)
    printHelp()
    process.exit(2)
  }

  const fixture = createCodexMockFixture()
  const wss = new WebSocketServer({ host: '127.0.0.1', port: args.port })
  const sockets = new Set()
  const handles = new Set()

  await new Promise((resolve, reject) => {
    wss.once('listening', resolve)
    wss.once('error', reject)
  })

  const address = wss.address()
  const port = typeof address === 'object' && address ? address.port : args.port
  log(`mock-codex-server listening on ws://127.0.0.1:${port} scenario=${args.scenario}`)

  let connectionCounter = 0
  wss.on('connection', (socket, req) => {
    const connId = ++connectionCounter
    sockets.add(socket)
    log(`conn#${connId} open from ${req.socket.remoteAddress}:${req.socket.remotePort}`)

    const handle = fixture.bindConnection({
      scenario: args.scenario,
      onSend(frame) {
        if (socket.readyState !== socket.OPEN) return
        try {
          socket.send(JSON.stringify(frame))
          log(`conn#${connId} <-`, JSON.stringify(frame))
        } catch (err) {
          log(`conn#${connId} send-error`, err?.message ?? String(err))
        }
      },
    })
    handles.add(handle)

    socket.on('message', (raw) => {
      const text = typeof raw === 'string' ? raw : raw.toString('utf8')
      log(`conn#${connId} ->`, text)
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch (err) {
        log(`conn#${connId} parse-error`, err?.message ?? String(err))
        handle.handle({})
        return
      }
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        handle.handle(parsed)
      } else {
        handle.handle({})
      }
    })

    const cleanup = (reason) => {
      sockets.delete(socket)
      handles.delete(handle)
      handle.dispose()
      log(`conn#${connId} close ${reason}`)
    }
    socket.on('close', () => cleanup('close'))
    socket.on('error', (err) => cleanup(`error: ${err?.message ?? String(err)}`))
  })

  let shuttingDown = false
  const shutdown = async (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    log(`received ${signal}; shutting down`)
    for (const handle of handles) handle.dispose()
    handles.clear()
    for (const socket of sockets) {
      try {
        socket.terminate()
      } catch {
        // ignore
      }
    }
    sockets.clear()
    wss.close((err) => {
      if (err) {
        log('wss.close error', err.message ?? String(err))
        process.exit(1)
      } else {
        log('wss closed cleanly')
        process.exit(0)
      }
    })
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err?.stack ?? err?.message ?? String(err)}\n`)
  process.exit(1)
})
