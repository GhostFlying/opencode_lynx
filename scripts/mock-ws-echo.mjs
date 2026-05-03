#!/usr/bin/env node
import { WebSocketServer } from 'ws'

const args = process.argv.slice(2)
let port = 7777
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    port = Number.parseInt(args[i + 1], 10)
    if (!Number.isFinite(port) || port <= 0) {
      console.error(`Invalid --port value: ${args[i + 1]}`)
      process.exit(2)
    }
    i++
  }
}

const server = new WebSocketServer({ port })
server.on('listening', () => {
  console.log(`mock-ws-echo: listening on ws://0.0.0.0:${port}`)
})

server.on('connection', (socket, req) => {
  console.log(`mock-ws-echo: connection from ${req.socket.remoteAddress}`)
  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      console.log(`mock-ws-echo: <binary frame ignored>`)
      return
    }
    const text = data.toString('utf8')
    console.log(`mock-ws-echo: <- ${text}`)
    socket.send(text)
  })
  socket.on('close', (code, reason) => {
    console.log(`mock-ws-echo: closed code=${code} reason=${reason?.toString('utf8') ?? ''}`)
  })
})

const shutdown = (signal) => {
  console.log(`mock-ws-echo: ${signal}, shutting down`)
  server.close(() => process.exit(0))
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
