// Translate Codex JSON-RPC notifications and server-initiated requests into
// the unified `BackendEvent` stream that the chat UI consumes.
//
// The mapper is stateless across reconnects in the sense that the active
// thread id is owned by the adapter and pushed in via `setActiveThread`.
// The only transient state held here is the open-item map, which lets
// `outputDelta` notifications (which lack an item `type` discriminator)
// route back to the item kind that started them.
//
// Behavior contract: see `.codex-rollout/handoffs/M2.3.md`. Tests in
// `src/backends/codex/__tests__/mapper.test.ts` assert each row of the
// mapping table.

import type { BackendEvent, BackendEventType, BackendKind } from '../types.js'
import type { ServerInitiatedRequest } from './protocol.js'

const BACKEND: BackendKind = 'codex'

const DEFAULT_EXEC_DECISIONS: ReadonlyArray<string> = ['accept', 'decline', 'cancel']
const DEFAULT_FILE_CHANGE_DECISIONS: ReadonlyArray<string> = ['accept', 'decline', 'cancel']

type OpenItemKind = 'commandExecution' | 'fileChange'

export interface CodexMapperContext {
  /** Currently active thread for the channel (one mapper per BackendClient).
   *  null until the first thread/started or thread/start response. */
  activeThreadID: string | null
}

export interface CodexMapper {
  /** Push a notification frame; returns 0+ unified events. */
  mapNotification(method: string, params: unknown): BackendEvent[]
  /** Push a server-initiated request (e.g. approval). Returns the
   *  approval.requested event; the adapter records the correlation
   *  id → ServerInitiatedRequest mapping so client.approvals.respond
   *  can resolve later. */
  mapServerRequest(req: ServerInitiatedRequest): BackendEvent | null
  /** Push a synthesized approval-resolved event (called by the adapter
   *  AFTER the client's response is sent). */
  emitApprovalResolved(
    approvalID: string,
    decision: { kind: string; payload?: Record<string, unknown> },
  ): BackendEvent
  /** Reset transient state on connection reset. Does NOT clear thread id. */
  reset(): void
  /** Public accessors for the adapter. */
  getContext(): Readonly<CodexMapperContext>
  setActiveThread(threadID: string | null): void
}

export interface CreateCodexMapperOptions {
  /** Inject for tests. Defaults to () => new Date().toISOString(). */
  now?: () => string
}

export function createCodexMapper(opts?: CreateCodexMapperOptions): CodexMapper {
  const now = opts?.now ?? (() => new Date().toISOString())

  let activeThreadID: string | null = null
  // itemId -> kind. Cleared on item/completed (per item) and on reset().
  const openItems = new Map<string, OpenItemKind>()

  function setActiveThread(threadID: string | null): void {
    activeThreadID = threadID
  }

  function getContext(): Readonly<CodexMapperContext> {
    return { activeThreadID }
  }

  function reset(): void {
    openItems.clear()
  }

  function rawEvent(method: string, params: unknown): BackendEvent {
    return {
      backend: BACKEND,
      type: 'raw',
      payload: { method, params: params as Record<string, unknown> | undefined } as Record<
        string,
        unknown
      >,
      raw: { method, params },
      sourceType: method,
    }
  }

  function makeEvent(
    type: BackendEventType,
    method: string,
    params: unknown,
    payload: Record<string, unknown>,
    extras: Partial<
      Pick<BackendEvent, 'sessionID' | 'messageID' | 'partID' | 'turnID' | 'approvalID' | 'status'>
    > = {},
  ): BackendEvent {
    const event: BackendEvent = {
      backend: BACKEND,
      type,
      payload,
      raw: params,
      sourceType: method,
    }
    if (extras.sessionID !== undefined) event.sessionID = extras.sessionID
    if (extras.messageID !== undefined) event.messageID = extras.messageID
    if (extras.partID !== undefined) event.partID = extras.partID
    if (extras.turnID !== undefined) event.turnID = extras.turnID
    if (extras.approvalID !== undefined) event.approvalID = extras.approvalID
    if (extras.status !== undefined) event.status = extras.status
    return event
  }

  function mapNotification(method: string, params: unknown): BackendEvent[] {
    const p = (params ?? {}) as Record<string, unknown>

    switch (method) {
      case 'thread/started': {
        const thread = p.thread as { id?: string } | undefined
        const threadID = thread?.id
        if (typeof threadID === 'string') activeThreadID = threadID
        return [
          makeEvent(
            'session.updated',
            method,
            params,
            { thread },
            { sessionID: typeof threadID === 'string' ? threadID : undefined },
          ),
        ]
      }
      case 'thread/status/changed': {
        const threadID = typeof p.threadId === 'string' ? p.threadId : undefined
        const status = p.status
        return [
          makeEvent(
            'session.updated',
            method,
            params,
            { threadID, status },
            {
              sessionID: threadID,
              status: typeof status === 'string' ? status : undefined,
            },
          ),
        ]
      }
      case 'turn/started': {
        const threadID = typeof p.threadId === 'string' ? p.threadId : undefined
        const turn = p.turn as { id?: string } | undefined
        const turnID = typeof turn?.id === 'string' ? turn.id : undefined
        return [
          makeEvent(
            'turn.started',
            method,
            params,
            { threadID, turn },
            { sessionID: threadID, turnID },
          ),
        ]
      }
      case 'turn/completed': {
        const threadID = typeof p.threadId === 'string' ? p.threadId : undefined
        const turn = p.turn as { id?: string } | undefined
        const turnID = typeof turn?.id === 'string' ? turn.id : undefined
        return [
          makeEvent(
            'turn.completed',
            method,
            params,
            { threadID, turn },
            { sessionID: threadID, turnID },
          ),
        ]
      }
      case 'item/started': {
        return mapItemStarted(method, params, p)
      }
      case 'item/completed': {
        return mapItemCompleted(method, params, p)
      }
      case 'item/agentMessage/delta': {
        const threadID = typeof p.threadId === 'string' ? p.threadId : undefined
        const turnID = typeof p.turnId === 'string' ? p.turnId : undefined
        const itemID = typeof p.itemId === 'string' ? p.itemId : undefined
        const delta = typeof p.delta === 'string' ? p.delta : ''
        return [
          makeEvent(
            'message.delta',
            method,
            params,
            {
              partID: itemID,
              role: 'assistant',
              delta,
              kind: 'text',
            },
            {
              sessionID: threadID,
              turnID,
              messageID: itemID,
              partID: itemID,
            },
          ),
        ]
      }
      case 'item/commandExecution/outputDelta': {
        const threadID = typeof p.threadId === 'string' ? p.threadId : undefined
        const turnID = typeof p.turnId === 'string' ? p.turnId : undefined
        const itemID = typeof p.itemId === 'string' ? p.itemId : undefined
        const delta = typeof p.delta === 'string' ? p.delta : ''
        return [
          makeEvent(
            'tool.delta',
            method,
            params,
            {
              toolID: itemID,
              deltaType: 'output',
              delta,
            },
            {
              sessionID: threadID,
              turnID,
              partID: itemID,
            },
          ),
        ]
      }
      case 'item/fileChange/outputDelta': {
        const threadID = typeof p.threadId === 'string' ? p.threadId : undefined
        const turnID = typeof p.turnId === 'string' ? p.turnId : undefined
        const itemID = typeof p.itemId === 'string' ? p.itemId : undefined
        const delta = typeof p.delta === 'string' ? p.delta : ''
        return [
          makeEvent(
            'tool.delta',
            method,
            params,
            {
              toolID: itemID,
              deltaType: 'output',
              delta,
            },
            {
              sessionID: threadID,
              turnID,
              partID: itemID,
            },
          ),
        ]
      }
      case 'item/fileChange/patchUpdated': {
        const threadID = typeof p.threadId === 'string' ? p.threadId : undefined
        const turnID = typeof p.turnId === 'string' ? p.turnId : undefined
        const itemID = typeof p.itemId === 'string' ? p.itemId : undefined
        const changes = p.changes
        return [
          makeEvent(
            'tool.delta',
            method,
            params,
            {
              toolID: itemID,
              deltaType: 'patch',
              changes,
            },
            {
              sessionID: threadID,
              turnID,
              partID: itemID,
            },
          ),
        ]
      }
      case 'error': {
        const threadID = typeof p.threadId === 'string' ? p.threadId : undefined
        const turnID = typeof p.turnId === 'string' ? p.turnId : undefined
        const willRetry = Boolean(p.willRetry)
        const error = p.error
        return [
          makeEvent(
            'connection.state',
            method,
            params,
            {
              severity: 'error',
              error,
              willRetry,
              threadID,
              turnID,
            },
            { sessionID: threadID, turnID },
          ),
        ]
      }
      case 'warning': {
        return [rawEvent(method, params)]
      }
      default: {
        return [rawEvent(method, params)]
      }
    }
  }

  function mapItemStarted(
    method: string,
    params: unknown,
    p: Record<string, unknown>,
  ): BackendEvent[] {
    const threadID = typeof p.threadId === 'string' ? p.threadId : undefined
    const turnID = typeof p.turnId === 'string' ? p.turnId : undefined
    const item = p.item as Record<string, unknown> | undefined
    if (!item || typeof item !== 'object') {
      return [rawEvent(method, params)]
    }
    const itemType = typeof item.type === 'string' ? item.type : ''
    const itemID = typeof item.id === 'string' ? item.id : undefined

    if (itemType === 'agentMessage') {
      return [
        makeEvent(
          'message.delta',
          method,
          params,
          {
            partID: itemID,
            role: 'assistant',
            delta: '',
            initial: true,
            kind: 'text',
          },
          {
            sessionID: threadID,
            turnID,
            messageID: itemID,
            partID: itemID,
          },
        ),
      ]
    }

    if (itemType === 'commandExecution') {
      if (itemID) openItems.set(itemID, 'commandExecution')
      const status = typeof item.status === 'string' ? item.status : undefined
      return [
        makeEvent(
          'tool.started',
          method,
          params,
          {
            toolID: itemID,
            kind: 'commandExecution',
            command: item.command,
            cwd: item.cwd,
            status: item.status,
          },
          {
            sessionID: threadID,
            turnID,
            partID: itemID,
            status,
          },
        ),
      ]
    }

    if (itemType === 'fileChange') {
      if (itemID) openItems.set(itemID, 'fileChange')
      const status = typeof item.status === 'string' ? item.status : undefined
      return [
        makeEvent(
          'tool.started',
          method,
          params,
          {
            toolID: itemID,
            kind: 'fileChange',
            status: item.status,
          },
          {
            sessionID: threadID,
            turnID,
            partID: itemID,
            status,
          },
        ),
      ]
    }

    // Reasoning, plan, MCP tool calls, dynamic tool calls, web search,
    // image view/generation, review-mode toggles, context compaction,
    // user message echoes, hook prompts, collab agent calls — emit raw
    // for v1. Adapter / chat UI may opt-in later.
    return [rawEvent(method, params)]
  }

  function mapItemCompleted(
    method: string,
    params: unknown,
    p: Record<string, unknown>,
  ): BackendEvent[] {
    const threadID = typeof p.threadId === 'string' ? p.threadId : undefined
    const turnID = typeof p.turnId === 'string' ? p.turnId : undefined
    const item = p.item as Record<string, unknown> | undefined
    if (!item || typeof item !== 'object') {
      return [rawEvent(method, params)]
    }
    const itemType = typeof item.type === 'string' ? item.type : ''
    const itemID = typeof item.id === 'string' ? item.id : undefined

    if (itemType === 'agentMessage') {
      if (itemID) openItems.delete(itemID)
      return [
        makeEvent(
          'message.updated',
          method,
          params,
          {
            partID: itemID,
            role: 'assistant',
            text: item.text,
            completedAt: now(),
            kind: 'text',
          },
          {
            sessionID: threadID,
            turnID,
            messageID: itemID,
            partID: itemID,
          },
        ),
      ]
    }

    if (itemType === 'commandExecution') {
      if (itemID) openItems.delete(itemID)
      const status = typeof item.status === 'string' ? item.status : undefined
      return [
        makeEvent(
          'tool.completed',
          method,
          params,
          {
            toolID: itemID,
            kind: 'commandExecution',
            status: item.status,
            exitCode: item.exitCode,
            durationMs: item.durationMs,
            aggregatedOutput: item.aggregatedOutput,
          },
          {
            sessionID: threadID,
            turnID,
            partID: itemID,
            status,
          },
        ),
      ]
    }

    if (itemType === 'fileChange') {
      if (itemID) openItems.delete(itemID)
      const status = typeof item.status === 'string' ? item.status : undefined
      return [
        makeEvent(
          'tool.completed',
          method,
          params,
          {
            toolID: itemID,
            kind: 'fileChange',
            status: item.status,
            changes: item.changes,
          },
          {
            sessionID: threadID,
            turnID,
            partID: itemID,
            status,
          },
        ),
      ]
    }

    if (itemID) openItems.delete(itemID)
    return [rawEvent(method, params)]
  }

  function mapServerRequest(req: ServerInitiatedRequest): BackendEvent | null {
    const approvalID = String(req.id)
    const params = (req.params ?? {}) as Record<string, unknown>
    const threadID = typeof params.threadId === 'string' ? params.threadId : undefined
    const turnID = typeof params.turnId === 'string' ? params.turnId : undefined
    const itemID = typeof params.itemId === 'string' ? params.itemId : undefined
    const reason = typeof params.reason === 'string' ? params.reason : undefined

    if (req.method === 'item/commandExecution/requestApproval') {
      const decisions = Array.isArray(params.availableDecisions)
        ? params.availableDecisions
        : DEFAULT_EXEC_DECISIONS
      const payload: Record<string, unknown> = {
        approvalID,
        kind: 'commandExecution',
        threadID,
        turnID,
        itemID,
        command: params.command,
        cwd: params.cwd,
        reason,
        availableDecisions: decisions,
      }
      return {
        backend: BACKEND,
        type: 'approval.requested',
        payload,
        raw: { method: req.method, params: req.params, id: req.id },
        sourceType: req.method,
        approvalID,
        ...(threadID !== undefined ? { sessionID: threadID } : {}),
        ...(turnID !== undefined ? { turnID } : {}),
        ...(itemID !== undefined ? { partID: itemID } : {}),
      }
    }

    if (req.method === 'item/fileChange/requestApproval') {
      const decisions = Array.isArray(params.availableDecisions)
        ? params.availableDecisions
        : DEFAULT_FILE_CHANGE_DECISIONS
      const payload: Record<string, unknown> = {
        approvalID,
        kind: 'fileChange',
        threadID,
        turnID,
        itemID,
        reason,
        grantRoot: params.grantRoot,
        availableDecisions: decisions,
      }
      return {
        backend: BACKEND,
        type: 'approval.requested',
        payload,
        raw: { method: req.method, params: req.params, id: req.id },
        sourceType: req.method,
        approvalID,
        ...(threadID !== undefined ? { sessionID: threadID } : {}),
        ...(turnID !== undefined ? { turnID } : {}),
        ...(itemID !== undefined ? { partID: itemID } : {}),
      }
    }

    // Unmapped server-initiated request kinds — adapter handles defaults.
    return null
  }

  function emitApprovalResolved(
    approvalID: string,
    decision: { kind: string; payload?: Record<string, unknown> },
  ): BackendEvent {
    return {
      backend: BACKEND,
      type: 'approval.resolved',
      payload: { approvalID, decision },
      raw: { approvalID, decision },
      sourceType: 'approval.resolved',
      approvalID,
    }
  }

  return {
    mapNotification,
    mapServerRequest,
    emitApprovalResolved,
    reset,
    getContext,
    setActiveThread,
  }
}
