// In-process Codex mock server. Boots the shared fixture inside a `ws`
// WebSocketServer on `127.0.0.1:<ephemeral>` so adapter integration tests
// can exercise real JSON-RPC framing over a real socket without depending
// on the standalone CLI runner.

import { WebSocketServer, type WebSocket } from 'ws'

import {
  createCodexMockFixture,
  type CodexMockConnectionHandle,
  type CodexMockRecordedRequest,
  type CodexMockScenario,
} from './protocol-fixture.js'

export interface InProcessCodexMockHandle {
  /** ws://127.0.0.1:<port> URL the client should connect to. */
  url: string
  /** Snapshot of every frame the connected client(s) sent so far. */
  recordedRequests(): readonly CodexMockRecordedRequest[]
  /** Close all sockets and shut down the server. Resolves once closed. */
  dispose(): Promise<void>
}

export interface StartInProcessCodexMockOptions {
  scenario?: CodexMockScenario
}

export async function startInProcessCodexMock(
  opts: StartInProcessCodexMockOptions = {},
): Promise<InProcessCodexMockHandle> {
  const fixture = createCodexMockFixture()
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(wss, 'listening')

  const sockets = new Set<WebSocket>()
  const handles = new Set<CodexMockConnectionHandle>()

  wss.on('connection', (socket) => {
    sockets.add(socket)

    const handle = fixture.bindConnection({
      scenario: opts.scenario ?? 'happy-path',
      onSend(frame) {
        if (socket.readyState !== socket.OPEN) return
        try {
          socket.send(JSON.stringify(frame))
        } catch {
          // Socket may have closed between readyState check and send — drop.
        }
      },
    })
    handles.add(handle)

    socket.on('message', (raw) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'))
      } catch {
        // Malformed frame — let the fixture send back an invalid-request
        // error by feeding a non-object placeholder.
        handle.handle({} as Record<string, unknown>)
        return
      }
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        handle.handle(parsed as Record<string, unknown>)
      } else {
        handle.handle({} as Record<string, unknown>)
      }
    })

    const cleanup = () => {
      sockets.delete(socket)
      handles.delete(handle)
      handle.dispose()
    }
    socket.on('close', cleanup)
    socket.on('error', cleanup)
  })

  const address = wss.address()
  if (typeof address !== 'object' || address === null) {
    wss.close()
    throw new Error('WebSocketServer.address() did not return an AddressInfo object')
  }
  const url = `ws://127.0.0.1:${address.port}`

  return {
    url,
    recordedRequests() {
      const out: CodexMockRecordedRequest[] = []
      for (const handle of handles) {
        out.push(...handle.recordedRequests)
      }
      return out
    },
    async dispose() {
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
      await new Promise<void>((resolve, reject) => {
        wss.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    },
  }
}

function once(emitter: WebSocketServer, eventName: 'listening'): Promise<void> {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      emitter.off('error', onError)
      resolve()
    }
    const onError = (err: Error) => {
      emitter.off(eventName, onListening)
      reject(err)
    }
    emitter.once(eventName, onListening)
    emitter.once('error', onError)
  })
}
