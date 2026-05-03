// Vitest covering the Codex mock fixture's wire-shape contract. These tests
// drive the fixture directly (no socket) so failures point at fixture
// behavior, not network plumbing. The integration tests under
// `src/backends/codex/__tests__/codex.integration.test.ts` (M2.6) will use
// the real `startInProcessCodexMock` boot helper.

import { describe, expect, it } from 'vitest'

import { createCodexMockFixture } from './protocol-fixture.js'

interface DriverOptions {
  scenario?: 'happy-path' | 'approvals' | 'tools'
}

interface Driver {
  send(frame: Record<string, unknown>): void
  outbound: Array<Record<string, unknown>>
  recordedRequests: ReturnType<ReturnType<typeof createCodexMockFixture>['bindConnection']>['recordedRequests']
  awaitFrame(predicate: (frame: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>
  dispose(): void
}

function makeDriver(opts: DriverOptions = {}): Driver {
  const fixture = createCodexMockFixture()
  const outbound: Array<Record<string, unknown>> = []
  const handle = fixture.bindConnection({
    scenario: opts.scenario,
    onSend(frame) {
      outbound.push(frame)
    },
  })
  return {
    send(frame) {
      handle.handle(frame)
    },
    outbound,
    recordedRequests: handle.recordedRequests,
    async awaitFrame(predicate, timeoutMs = 200) {
      const start = Date.now()
      // Microtasks run when we yield via Promise.resolve; the fixture
      // uses queueMicrotask. A short polling loop with awaiting microtasks
      // is sufficient here and avoids real timers.
      while (Date.now() - start < timeoutMs) {
        const found = outbound.find(predicate)
        if (found) return found
        await Promise.resolve()
        // Allow queued microtasks (and any nested ones) to drain.
        await new Promise<void>((r) => setImmediate(r))
      }
      throw new Error('awaitFrame timed out')
    },
    dispose() {
      handle.dispose()
    },
  }
}

function findResponse(outbound: Array<Record<string, unknown>>, id: number | string) {
  return outbound.find((frame) => frame.id === id && ('result' in frame || 'error' in frame))
}

describe('codex mock fixture — happy path', () => {
  it('handles initialize → initialized → turn/start with the correct notification sequence', async () => {
    const driver = makeDriver({ scenario: 'happy-path' })
    try {
      driver.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'x' } } })
      const initResp = findResponse(driver.outbound, 1)
      expect(initResp?.result).toMatchObject({
        userAgent: expect.any(String),
        codexHome: expect.any(String),
        platformFamily: expect.any(String),
        platformOs: expect.any(String),
      })

      driver.send({ jsonrpc: '2.0', method: 'initialized' })

      driver.send({
        jsonrpc: '2.0',
        id: 2,
        method: 'turn/start',
        params: {
          threadId: 'thread-from-test',
          input: [{ type: 'text', text: 'hi', text_elements: [] }],
        },
      })

      const turnResp = findResponse(driver.outbound, 2)
      expect(turnResp?.result).toMatchObject({ turn: { id: expect.any(String), status: 'inProgress' } })

      // Wait for the streamed sequence — the last frame must be turn/completed.
      await driver.awaitFrame((f) => f.method === 'turn/completed')

      // Filter to just the notifications emitted after turn/start.
      const notifs = driver.outbound
        .filter((f) => typeof f.method === 'string' && f.id === undefined)
        .map((f) => f.method as string)

      const turnNotifIdx = notifs.indexOf('turn/started')
      expect(turnNotifIdx).toBeGreaterThanOrEqual(0)

      // Order from turn/started onward:
      //   thread/started (because no thread/start was issued first),
      //   turn/started, item/started, three deltas, item/completed, turn/completed.
      const expected = [
        'thread/started',
        'turn/started',
        'item/started',
        'item/agentMessage/delta',
        'item/agentMessage/delta',
        'item/agentMessage/delta',
        'item/completed',
        'turn/completed',
      ]
      expect(notifs).toEqual(expected)

      // The deltas should carry the documented chunks.
      const deltas = driver.outbound
        .filter((f) => f.method === 'item/agentMessage/delta')
        .map((f) => (f.params as { delta: string }).delta)
      expect(deltas).toEqual(['Hello ', 'from ', 'codex.'])

      // item/completed should carry the accumulated text.
      const completed = driver.outbound.find((f) => f.method === 'item/completed')
      expect(completed?.params).toMatchObject({
        threadId: 'thread-from-test',
        item: { type: 'agentMessage', text: 'Hello from codex.' },
      })
    } finally {
      driver.dispose()
    }
  })

  it('skips thread/started when thread/start was already issued', async () => {
    const driver = makeDriver({ scenario: 'happy-path' })
    try {
      driver.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
      driver.send({ jsonrpc: '2.0', method: 'initialized' })
      driver.send({ jsonrpc: '2.0', id: 2, method: 'thread/start', params: { experimentalRawEvents: false, persistExtendedHistory: false } })
      const startResp = findResponse(driver.outbound, 2)
      const threadId = (startResp?.result as { thread: { id: string } }).thread.id

      driver.send({ jsonrpc: '2.0', id: 3, method: 'turn/start', params: { threadId, input: [] } })
      await driver.awaitFrame((f) => f.method === 'turn/completed')

      const notifs = driver.outbound.filter((f) => f.id === undefined).map((f) => f.method)
      expect(notifs).not.toContain('thread/started')
      expect(notifs).toContain('turn/started')
    } finally {
      driver.dispose()
    }
  })
})

describe('codex mock fixture — approvals scenario', () => {
  it('emits a server-initiated approval request and waits for the client decision', async () => {
    const driver = makeDriver({ scenario: 'approvals' })
    try {
      driver.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
      driver.send({ jsonrpc: '2.0', method: 'initialized' })
      driver.send({
        jsonrpc: '2.0',
        id: 2,
        method: 'turn/start',
        params: { threadId: 'thread-approval', input: [] },
      })

      // Server should issue item/commandExecution/requestApproval as a request.
      const approvalReq = await driver.awaitFrame(
        (f) => f.method === 'item/commandExecution/requestApproval' && f.id !== undefined,
      )
      expect(approvalReq.params).toMatchObject({
        threadId: 'thread-approval',
        availableDecisions: expect.arrayContaining(['accept', 'decline', 'cancel']),
      })

      // Before the client answers, no item/agentMessage/delta should have
      // been emitted (the fixture must wait).
      const deltasBeforeDecision = driver.outbound.filter((f) => f.method === 'item/agentMessage/delta')
      expect(deltasBeforeDecision).toHaveLength(0)

      // Send back a decision response.
      driver.send({ jsonrpc: '2.0', id: approvalReq.id, result: { decision: 'accept' } })

      // After the decision the turn should play out to completion.
      await driver.awaitFrame((f) => f.method === 'turn/completed')

      const deltas = driver.outbound
        .filter((f) => f.method === 'item/agentMessage/delta')
        .map((f) => (f.params as { delta: string }).delta)
      expect(deltas).toEqual(['Hello ', 'from ', 'codex.'])

      // The decision should have been recorded.
      const decision = driver.recordedRequests.find((r) => r.method === '<response>' && r.id === approvalReq.id)
      expect(decision).toBeDefined()
      expect(decision?.params).toMatchObject({ decision: 'accept' })
    } finally {
      driver.dispose()
    }
  })
})

describe('codex mock fixture — tools scenario', () => {
  it('emits commandExecution lifecycle without approvals', async () => {
    const driver = makeDriver({ scenario: 'tools' })
    try {
      driver.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
      driver.send({ jsonrpc: '2.0', method: 'initialized' })
      driver.send({
        jsonrpc: '2.0',
        id: 2,
        method: 'turn/start',
        params: { threadId: 'thread-tools', input: [] },
      })

      await driver.awaitFrame((f) => f.method === 'turn/completed')

      const cmdNotifs = driver.outbound
        .filter((f) => typeof f.method === 'string' && (f.method === 'item/started' || f.method === 'item/commandExecution/outputDelta' || f.method === 'item/completed'))
        .map((f) => f.method)
      expect(cmdNotifs).toEqual([
        'item/started',
        'item/commandExecution/outputDelta',
        'item/commandExecution/outputDelta',
        'item/completed',
      ])

      const completed = driver.outbound.find((f) => f.method === 'item/completed')
      expect(completed?.params).toMatchObject({
        item: { type: 'commandExecution', status: 'completed', exitCode: 0 },
      })

      // No approval request should have been issued in this scenario.
      const approvalReq = driver.outbound.find((f) => f.method === 'item/commandExecution/requestApproval')
      expect(approvalReq).toBeUndefined()
    } finally {
      driver.dispose()
    }
  })
})

describe('codex mock fixture — guards', () => {
  it('rejects model/list before initialized with -32002', () => {
    const driver = makeDriver()
    try {
      driver.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
      // Skip the `initialized` notification on purpose.
      driver.send({ jsonrpc: '2.0', id: 2, method: 'model/list', params: {} })
      const resp = findResponse(driver.outbound, 2)
      expect(resp?.error).toMatchObject({ code: -32002, message: 'not initialized' })
    } finally {
      driver.dispose()
    }
  })

  it('rejects thread/read with includeTurns:true on a non-materialized thread with -32001', () => {
    const driver = makeDriver()
    try {
      driver.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
      driver.send({ jsonrpc: '2.0', method: 'initialized' })
      driver.send({
        jsonrpc: '2.0',
        id: 2,
        method: 'thread/read',
        params: { threadId: 'never-started', includeTurns: true },
      })
      const resp = findResponse(driver.outbound, 2)
      expect(resp?.error).toMatchObject({ code: -32001, message: 'thread not materialized' })
    } finally {
      driver.dispose()
    }
  })

  it('records inbound payloads in recordedRequests', () => {
    const driver = makeDriver()
    try {
      driver.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'tester' } } })
      driver.send({ jsonrpc: '2.0', method: 'initialized' })

      const methods = driver.recordedRequests.map((r) => r.method)
      expect(methods).toEqual(['initialize', 'initialized'])
      expect(driver.recordedRequests[0].params).toMatchObject({ clientInfo: { name: 'tester' } })
    } finally {
      driver.dispose()
    }
  })
})
