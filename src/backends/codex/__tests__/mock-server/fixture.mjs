// Pure ESM fixture for the Codex app-server JSON-RPC mock.
//
// The fixture is transport-agnostic — callers (the in-process Vitest helper
// and the standalone CLI runner) supply an `onSend(frame)` sink and receive
// a `handle(frame)` function to feed inbound frames in. The fixture replies
// via onSend.
//
// Wire shapes are intentionally kept tight to the generated bindings under
// `scripts/codex-bindings/ts/` and `scripts/codex-bindings/ts/v2/` — only the
// fields the M2.x adapter exercises are populated. Keep this file ASCII +
// JS only so the standalone runner can `import` it directly without a build
// step.

const JSONRPC_VERSION = '2.0'

// JSON-RPC error codes.
//   -32002 'not initialized'         — adapter must send `initialize` first.
//   -32001 'thread not materialized' — adapter exercises the thread/read fallback path.
//   -32600 'invalid request'         — malformed frames (no method, etc.)
//   -32601 'method not found'        — anything we don't model.
const ERR_NOT_INITIALIZED = -32002
const ERR_NOT_MATERIALIZED = -32001
const ERR_INVALID_REQUEST = -32600
const ERR_METHOD_NOT_FOUND = -32601

const DEFAULT_INITIALIZE_RESPONSE = Object.freeze({
  userAgent: 'codex-mock/0.0.1',
  codexHome: '/tmp/codex-home',
  platformFamily: 'unix',
  platformOs: 'macos',
})

const DEFAULT_MODEL = Object.freeze({
  id: 'gpt-5-codex',
  model: 'gpt-5-codex',
  upgrade: null,
  upgradeInfo: null,
  availabilityNux: null,
  displayName: 'GPT-5 Codex',
  description: 'Mock model for fixtures.',
  hidden: false,
  supportedReasoningEfforts: [],
  defaultReasoningEffort: 'medium',
  inputModalities: ['text'],
  supportsPersonality: false,
  additionalSpeedTiers: [],
  isDefault: true,
})

const SCENARIO_HAPPY = 'happy-path'
const SCENARIO_APPROVALS = 'approvals'
const SCENARIO_TOOLS = 'tools'

/**
 * Create a Codex mock fixture.
 *
 * Each call returns a top-level object with `bindConnection({ onSend, scenario })`
 * which produces a per-connection handle:
 *   - handle(frame): feed an inbound JSON-RPC frame from the client.
 *   - recordedRequests: array of { method, id, params, ts } captured from the
 *                        client (responses from the client are also recorded
 *                        with method = '<response>' so approvals tests can
 *                        assert decisions).
 *   - dispose(): drop pending server requests and stop emitting.
 */
export function createCodexMockFixture() {
  return {
    bindConnection({ onSend, scenario }) {
      if (typeof onSend !== 'function') {
        throw new TypeError('bindConnection requires an onSend(frame) function')
      }
      const activeScenario = normalizeScenario(scenario)
      return createConnectionHandle(onSend, activeScenario)
    },
  }
}

function normalizeScenario(value) {
  if (value === SCENARIO_APPROVALS) return SCENARIO_APPROVALS
  if (value === SCENARIO_TOOLS) return SCENARIO_TOOLS
  return SCENARIO_HAPPY
}

function createConnectionHandle(onSend, scenario) {
  const recordedRequests = []
  // pendingServerRequests: id -> resolve(responseFrame) — the fixture awaits
  // the client to answer a server-initiated approval request before
  // continuing the turn.
  const pendingServerRequests = new Map()
  let initialized = false
  let disposed = false
  let nextServerRequestId = 1
  // Threads created via thread/start become "materialized"; thread/read on a
  // bare threadId rejects until then.
  const materializedThreads = new Set()
  // Thread known to scenario seed (default empty)
  const seededThreads = []

  function safeSend(frame) {
    if (disposed) return
    try {
      onSend(frame)
    } catch (err) {
      // Swallow downstream send errors — the test harness or runner is
      // responsible for surfacing them.
    }
  }

  function sendError(id, code, message, data) {
    const error = { code, message }
    if (data !== undefined) error.data = data
    safeSend({ jsonrpc: JSONRPC_VERSION, id, error })
  }

  function sendResult(id, result) {
    safeSend({ jsonrpc: JSONRPC_VERSION, id, result })
  }

  function sendNotification(method, params) {
    safeSend({ jsonrpc: JSONRPC_VERSION, method, params })
  }

  function sendServerRequest(method, params) {
    const id = `srv-${nextServerRequestId++}`
    safeSend({ jsonrpc: JSONRPC_VERSION, id, method, params })
    return new Promise((resolve) => {
      pendingServerRequests.set(id, resolve)
    })
  }

  function record(method, id, params) {
    recordedRequests.push({ method, id, params, ts: Date.now() })
  }

  function handle(frame) {
    if (disposed) return
    if (!isPlainObject(frame)) {
      sendError(null, ERR_INVALID_REQUEST, 'frame must be a JSON object')
      return
    }
    // Response from client to a server-initiated request.
    if (
      ('result' in frame || 'error' in frame) &&
      frame.method === undefined &&
      frame.id !== undefined
    ) {
      const resolver = pendingServerRequests.get(frame.id)
      record('<response>', frame.id, 'result' in frame ? frame.result : frame.error)
      if (resolver) {
        pendingServerRequests.delete(frame.id)
        resolver(frame)
      }
      return
    }

    const { method, id, params } = frame
    if (typeof method !== 'string') {
      sendError(id ?? null, ERR_INVALID_REQUEST, 'frame.method must be a string')
      return
    }
    record(method, id, params)

    // Notifications (no id): the only one Codex defines is `initialized`.
    if (id === undefined || id === null) {
      handleNotification(method, params)
      return
    }

    // Requests (id present) before initialize must be rejected, except for
    // the initialize request itself.
    if (!initialized && method !== 'initialize') {
      sendError(id, ERR_NOT_INITIALIZED, 'not initialized')
      return
    }

    handleRequest(method, id, params)
  }

  function handleNotification(method, params) {
    if (method === 'initialized') {
      initialized = true
      return
    }
    // Other notifications are ignored — the Codex client-notification union
    // currently only contains `initialized`.
  }

  function handleRequest(method, id, params) {
    switch (method) {
      case 'initialize':
        // Per spec the client must call initialize first, then send the
        // `initialized` notification before issuing other requests. Until
        // the notification arrives we still answer initialize but block
        // everything else.
        sendResult(id, { ...DEFAULT_INITIALIZE_RESPONSE })
        return
      case 'model/list':
        sendResult(id, {
          data: [{ ...DEFAULT_MODEL }],
          nextCursor: null,
        })
        return
      case 'thread/list':
        sendResult(id, {
          data: seededThreads.slice(),
          nextCursor: null,
          backwardsCursor: null,
        })
        return
      case 'thread/start': {
        const thread = createMockThread('thread-mock-1')
        materializedThreads.add(thread.id)
        sendResult(id, buildThreadStartResponse(thread))
        return
      }
      case 'thread/resume': {
        const threadId = isPlainObject(params) && typeof params.threadId === 'string' ? params.threadId : null
        if (!threadId || !materializedThreads.has(threadId)) {
          sendError(id, ERR_NOT_MATERIALIZED, 'thread not materialized')
          return
        }
        const thread = createMockThread(threadId)
        sendResult(id, buildThreadStartResponse(thread))
        return
      }
      case 'thread/read': {
        if (!isPlainObject(params)) {
          sendError(id, ERR_INVALID_REQUEST, 'thread/read requires params')
          return
        }
        const threadId = typeof params.threadId === 'string' ? params.threadId : ''
        const includeTurns = params.includeTurns === true
        if (includeTurns && !materializedThreads.has(threadId)) {
          sendError(id, ERR_NOT_MATERIALIZED, 'thread not materialized')
          return
        }
        const thread = createMockThread(threadId || 'thread-mock-1')
        sendResult(id, { thread })
        return
      }
      case 'thread/turns/list':
        sendResult(id, { data: [], nextCursor: null, backwardsCursor: null })
        return
      case 'turn/start': {
        if (!isPlainObject(params) || typeof params.threadId !== 'string') {
          sendError(id, ERR_INVALID_REQUEST, 'turn/start requires { threadId, input }')
          return
        }
        const threadId = params.threadId
        const turnId = `turn-mock-${recordedRequests.length}`
        const turn = createMockTurn(turnId)
        sendResult(id, { turn })
        // Stream notifications on a microtask so the JSON-RPC response
        // arrives at the client before the first notification frame. This
        // mirrors how the real app-server orders the wire.
        queueMicrotask(() => {
          if (disposed) return
          driveTurn({ threadId, turnId })
        })
        return
      }
      default:
        sendError(id, ERR_METHOD_NOT_FOUND, `method not found: ${method}`)
    }
  }

  async function driveTurn({ threadId, turnId }) {
    if (disposed) return
    // thread/started — only emit if the thread was created via this
    // turn/start (not via a prior thread/start). materializedThreads is the
    // marker. For simplicity, emit thread/started when the recorded list has
    // no prior thread/start for this id.
    const startedFromTurn = !hasPriorThreadStart(recordedRequests, threadId)
    if (startedFromTurn) {
      materializedThreads.add(threadId)
      sendNotification('thread/started', { thread: createMockThread(threadId) })
    }

    const turn = createMockTurn(turnId)
    sendNotification('turn/started', { threadId, turn })

    if (scenario === SCENARIO_TOOLS) {
      await driveToolsTurn({ threadId, turnId })
    } else {
      await driveAgentMessageTurn({ threadId, turnId })
    }

    sendNotification('turn/completed', {
      threadId,
      turn: { ...turn, status: 'completed', completedAt: nowSeconds(), durationMs: 1 },
    })
  }

  async function driveAgentMessageTurn({ threadId, turnId }) {
    const itemId = 'item-msg-1'
    const startItem = {
      type: 'agentMessage',
      id: itemId,
      text: '',
      phase: null,
      memoryCitation: null,
    }
    sendNotification('item/started', { item: startItem, threadId, turnId })

    if (scenario === SCENARIO_APPROVALS) {
      const decisionFrame = await sendServerRequest('item/commandExecution/requestApproval', {
        threadId,
        turnId,
        itemId,
        approvalId: null,
        reason: 'approve simulated command',
        command: 'echo hello',
        cwd: '/tmp/codex-home',
        commandActions: [],
        availableDecisions: ['accept', 'decline', 'cancel'],
      })
      if (disposed) return
      // Decision is recorded via record('<response>', ...) already; nothing
      // additional to do beyond moving on.
      void decisionFrame
    }

    const chunks = ['Hello ', 'from ', 'codex.']
    let acc = ''
    for (const delta of chunks) {
      if (disposed) return
      acc += delta
      sendNotification('item/agentMessage/delta', {
        threadId,
        turnId,
        itemId,
        delta,
      })
    }

    const completedItem = {
      type: 'agentMessage',
      id: itemId,
      text: acc,
      phase: null,
      memoryCitation: null,
    }
    sendNotification('item/completed', { item: completedItem, threadId, turnId })
  }

  async function driveToolsTurn({ threadId, turnId }) {
    const itemId = 'item-cmd-1'
    const startItem = {
      type: 'commandExecution',
      id: itemId,
      command: 'ls -la',
      cwd: '/tmp/codex-home',
      processId: null,
      source: 'agent',
      status: 'inProgress',
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    }
    sendNotification('item/started', { item: startItem, threadId, turnId })

    sendNotification('item/commandExecution/outputDelta', {
      threadId,
      turnId,
      itemId,
      delta: 'total 0\n',
    })
    sendNotification('item/commandExecution/outputDelta', {
      threadId,
      turnId,
      itemId,
      delta: 'drwxr-xr-x  2 root  wheel  64\n',
    })

    const completedItem = {
      ...startItem,
      status: 'completed',
      aggregatedOutput: 'total 0\ndrwxr-xr-x  2 root  wheel  64\n',
      exitCode: 0,
      durationMs: 5,
    }
    sendNotification('item/completed', { item: completedItem, threadId, turnId })
  }

  function dispose() {
    disposed = true
    pendingServerRequests.clear()
  }

  return {
    handle,
    recordedRequests,
    dispose,
  }
}

function hasPriorThreadStart(recordedRequests, threadId) {
  // The mock assigns its own thread id ('thread-mock-1') from thread/start,
  // so the cleanest check is: was thread/start ever recorded before this
  // turn/start? recordedRequests is in chronological order.
  for (const entry of recordedRequests) {
    if (entry.method === 'thread/start') return true
    if (entry.method === 'thread/resume') return true
  }
  // Conservative fallback — never null, threadId is unused for now.
  void threadId
  return false
}

function createMockThread(id) {
  return {
    id,
    forkedFromId: null,
    preview: '',
    ephemeral: true,
    modelProvider: 'openai',
    createdAt: nowSeconds(),
    updatedAt: nowSeconds(),
    status: 'idle',
    path: null,
    cwd: '/tmp/codex-home',
    cliVersion: 'codex-mock/0.0.1',
    source: 'cli',
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  }
}

function createMockTurn(id) {
  return {
    id,
    items: [],
    status: 'inProgress',
    error: null,
    startedAt: nowSeconds(),
    completedAt: null,
    durationMs: null,
  }
}

function buildThreadStartResponse(thread) {
  return {
    thread,
    model: DEFAULT_MODEL.model,
    modelProvider: thread.modelProvider,
    serviceTier: null,
    cwd: thread.cwd,
    instructionSources: [],
    approvalPolicy: 'never',
    approvalsReviewer: 'human',
    sandbox: 'workspace-write',
    permissionProfile: null,
    reasoningEffort: 'medium',
  }
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
