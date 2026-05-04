// Codex in-adapter message store: a session-keyed reducer that folds
// streaming JSON-RPC notifications into canonical `BackendMessage[]`
// snapshots. The chat UI reads via `sessions.messages()`, which now
// pulls from this store instead of round-tripping `thread/turns/list`
// for every event.
//
// Why a store and not OpenCode-style "refetch on hint":
//   `thread/turns/list` only returns *completed* turns. The actual
//   streaming surface — `item/started`, `*/outputDelta`, `item/completed`,
//   `item/agentMessage/delta` — carries the only authoritative state for
//   in-flight items. Folding into a local store is the protocol's intent
//   (the codex TUI does the same).
//
// Canonical part shape (matches `src/pages/chat/parts/ToolPart.tsx` and
// `src/pages/chat/fixtures.ts`):
//   { type:'tool', tool:'shell'|'edit', callID, state:{ status, input, output, error, title } }
//   { type:'text', text, partID }
//
// State is keyed by `sessionID` (Codex `threadId`). Each session keeps an
// ordered `messages` array, an `index` mapping itemId → message+part for
// O(1) delta routing, and an `inFlightItemIds` set used for reconnect
// hygiene (currently we drop the whole store on reconnect; the field is
// kept so a future incremental-recovery pass has the hook).

import type { BackendMessage, BackendMessagePart, BackendMessageRole } from '../types.js'

interface PartRef {
  messageIndex: number
  partIndex: number
}

interface SessionState {
  messages: BackendMessage[]
  /** itemId → location of the part it produced. */
  index: Map<string, PartRef>
  /** itemIds that have not yet seen item/completed. */
  inFlightItemIds: Set<string>
}

export interface CodexMessageStore {
  /** Apply a JSON-RPC notification frame. Returns true if state changed. */
  apply(method: string, params: unknown): boolean
  /** Return a defensive copy of the messages for a session, or null. */
  snapshot(sessionID: string): BackendMessage[] | null
  /** Seed the store from a `thread/turns/list` response (already-parsed turns). */
  seedFromTurns(sessionID: string, turns: TurnShape[]): BackendMessage[]
  /** True if the store has any state for this session. */
  has(sessionID: string): boolean
  /** Drop everything. Called on reconnect; chat refresh will reseed. */
  reset(): void
  /** Drop a single session (e.g. when the user deletes it remotely). */
  resetSession(sessionID: string): void
}

// Mirror of `adapter.ts` shapes; intentionally permissive.
export interface TurnShape {
  id?: unknown
  startedAt?: unknown
  items?: unknown
}

export interface ItemShape {
  type?: unknown
  id?: unknown
  text?: unknown
  content?: unknown
  command?: unknown
  cwd?: unknown
  status?: unknown
  changes?: unknown
  exitCode?: unknown
  durationMs?: unknown
  aggregatedOutput?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toIsoFromUnixSeconds(seconds: unknown): string | undefined {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return undefined
  return new Date(seconds * 1000).toISOString()
}

function joinUserInputText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const out: string[] = []
  for (const entry of content) {
    if (isRecord(entry) && entry.type === 'text' && typeof entry.text === 'string') {
      out.push(entry.text)
    }
  }
  return out.join('')
}

function toolNameFor(itemType: string): string {
  if (itemType === 'commandExecution') return 'shell'
  if (itemType === 'fileChange') return 'edit'
  return itemType || 'tool'
}

function formatErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (isRecord(error)) {
    if (typeof error.message === 'string' && error.message.trim().length > 0) {
      return error.message
    }
    const data = error.data
    if (isRecord(data) && typeof data.message === 'string' && data.message.trim().length > 0) {
      return data.message
    }
  }
  return 'Codex returned an error.'
}

export function createCodexMessageStore(): CodexMessageStore {
  const sessions = new Map<string, SessionState>()

  function ensureSession(sessionID: string): SessionState {
    let state = sessions.get(sessionID)
    if (!state) {
      state = {
        messages: [],
        index: new Map(),
        inFlightItemIds: new Set(),
      }
      sessions.set(sessionID, state)
    }
    return state
  }

  function appendMessage(
    state: SessionState,
    message: BackendMessage,
    partRefForItemId?: string,
  ): void {
    const messageIndex = state.messages.length
    state.messages.push(message)
    if (partRefForItemId) {
      state.index.set(partRefForItemId, { messageIndex, partIndex: 0 })
    }
  }

  function getPart(
    state: SessionState,
    itemId: string,
  ): { message: BackendMessage; part: BackendMessagePart; ref: PartRef } | null {
    const ref = state.index.get(itemId)
    if (!ref) return null
    const message = state.messages[ref.messageIndex]
    if (!message) return null
    const part = message.parts[ref.partIndex]
    if (!part) return null
    return { message, part, ref }
  }

  function replacePart(
    state: SessionState,
    itemId: string,
    transform: (part: BackendMessagePart) => BackendMessagePart,
  ): boolean {
    const found = getPart(state, itemId)
    if (!found) return false
    const next = transform(found.part)
    const newParts = [...found.message.parts]
    newParts[found.ref.partIndex] = next
    state.messages[found.ref.messageIndex] = { ...found.message, parts: newParts }
    return true
  }

  function buildToolPartFromItem(item: ItemShape, itemId: string): BackendMessagePart {
    const itemType = typeof item.type === 'string' ? item.type : ''
    const status = typeof item.status === 'string' ? item.status : 'running'
    const input: Record<string, unknown> = {}
    if (item.command !== undefined) input.command = item.command
    if (item.cwd !== undefined) input.cwd = item.cwd
    if (item.changes !== undefined) input.changes = item.changes

    const stateField: Record<string, unknown> = {
      status,
      input,
      output: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '',
    }
    if (item.exitCode !== undefined) stateField.exitCode = item.exitCode
    if (item.durationMs !== undefined) stateField.durationMs = item.durationMs

    return {
      type: 'tool',
      tool: toolNameFor(itemType),
      callID: itemId,
      state: stateField,
    }
  }

  function buildAssistantTextPart(itemId: string, text: string): BackendMessagePart {
    return { type: 'text', text, partID: itemId }
  }

  function buildUserMessage(
    sessionID: string,
    turnId: string,
    item: ItemShape,
    createdAt?: string,
  ): BackendMessage {
    const itemId = typeof item.id === 'string' ? item.id : ''
    // Intentionally no partID on user-message parts: user messages don't
    // stream, so a stable per-part id provides no benefit and would force
    // existing snapshot tests to update.
    return {
      id: `${turnId}:${itemId}`,
      sessionID,
      role: 'user',
      parts: [{ type: 'text', text: joinUserInputText(item.content) }],
      ...(createdAt !== undefined ? { createdAt } : {}),
    }
  }

  function buildAssistantMessage(
    sessionID: string,
    turnId: string,
    item: ItemShape,
    createdAt?: string,
  ): BackendMessage {
    const itemId = typeof item.id === 'string' ? item.id : ''
    const text = typeof item.text === 'string' ? item.text : ''
    return {
      id: `${turnId}:${itemId}`,
      sessionID,
      role: 'assistant',
      parts: [buildAssistantTextPart(itemId, text)],
      ...(createdAt !== undefined ? { createdAt } : {}),
    }
  }

  function buildToolMessage(
    sessionID: string,
    turnId: string,
    item: ItemShape,
    createdAt?: string,
  ): BackendMessage {
    const itemId = typeof item.id === 'string' ? item.id : ''
    return {
      id: `${turnId}:${itemId}`,
      sessionID,
      role: 'tool',
      parts: [buildToolPartFromItem(item, itemId)],
      ...(createdAt !== undefined ? { createdAt } : {}),
    }
  }

  function seedFromTurns(sessionID: string, turns: TurnShape[]): BackendMessage[] {
    const state = ensureSession(sessionID)
    state.messages = []
    state.index.clear()
    state.inFlightItemIds.clear()

    for (const turn of turns) {
      const turnId = typeof turn.id === 'string' ? turn.id : ''
      const createdAt = toIsoFromUnixSeconds(turn.startedAt)
      const items = Array.isArray(turn.items) ? (turn.items as ItemShape[]) : []
      for (const item of items) {
        const itemType = typeof item.type === 'string' ? item.type : ''
        const itemId = typeof item.id === 'string' ? item.id : ''
        if (itemType === 'userMessage') {
          appendMessage(state, buildUserMessage(sessionID, turnId, item, createdAt))
          continue
        }
        if (itemType === 'agentMessage') {
          const message = buildAssistantMessage(sessionID, turnId, item, createdAt)
          appendMessage(state, message, itemId)
          continue
        }
        if (itemType === 'commandExecution' || itemType === 'fileChange') {
          const message = buildToolMessage(sessionID, turnId, item, createdAt)
          appendMessage(state, message, itemId)
          continue
        }
        // Unmapped (reasoning, plan, MCP, etc.) — keep the raw passthrough so
        // history doesn't silently drop content.
        appendMessage(state, {
          id: `${turnId}:${itemId}`,
          sessionID,
          role: 'system',
          parts: [{ type: 'raw', item } as BackendMessagePart],
          ...(createdAt !== undefined ? { createdAt } : {}),
        })
      }
    }

    return snapshotInternal(state)
  }

  function snapshotInternal(state: SessionState): BackendMessage[] {
    return state.messages.map(msg => ({ ...msg, parts: [...msg.parts] }))
  }

  function snapshot(sessionID: string): BackendMessage[] | null {
    const state = sessions.get(sessionID)
    if (!state) return null
    return snapshotInternal(state)
  }

  function has(sessionID: string): boolean {
    return sessions.has(sessionID)
  }

  function reset(): void {
    sessions.clear()
  }

  function resetSession(sessionID: string): void {
    sessions.delete(sessionID)
  }

  function applyItemStarted(
    sessionID: string,
    state: SessionState,
    p: Record<string, unknown>,
  ): boolean {
    const turnId = typeof p.turnId === 'string' ? p.turnId : ''
    const item = isRecord(p.item) ? (p.item as ItemShape) : null
    if (!item) return false
    const itemId = typeof item.id === 'string' ? item.id : ''
    if (!itemId) return false
    if (state.index.has(itemId)) {
      // Already seeded (history bootstrap or duplicate event) — no-op.
      return false
    }
    const itemType = typeof item.type === 'string' ? item.type : ''
    const turnHeader = turnId

    if (itemType === 'userMessage') {
      // Codex echoes the user prompt as a real userMessage item — accept it
      // as the authoritative copy. The chat may have rendered an optimistic
      // bubble in local state; that gets replaced when the chat refresh
      // reads the next snapshot.
      const message: BackendMessage = {
        id: `${turnHeader}:${itemId}`,
        sessionID,
        role: 'user',
        parts: [{ type: 'text', text: joinUserInputText(item.content) }],
      }
      appendMessage(state, message, itemId)
      return true
    }

    if (itemType === 'agentMessage') {
      const message: BackendMessage = {
        id: `${turnHeader}:${itemId}`,
        sessionID,
        role: 'assistant',
        parts: [buildAssistantTextPart(itemId, '')],
      }
      appendMessage(state, message, itemId)
      state.inFlightItemIds.add(itemId)
      return true
    }

    if (itemType === 'commandExecution' || itemType === 'fileChange') {
      const message: BackendMessage = {
        id: `${turnHeader}:${itemId}`,
        sessionID,
        role: 'tool',
        parts: [buildToolPartFromItem(item, itemId)],
      }
      appendMessage(state, message, itemId)
      state.inFlightItemIds.add(itemId)
      return true
    }

    const message: BackendMessage = {
      id: `${turnHeader}:${itemId}`,
      sessionID,
      role: 'system',
      parts: [{ type: 'raw', item } as BackendMessagePart],
    }
    appendMessage(state, message, itemId)
    state.inFlightItemIds.add(itemId)
    return true
  }

  function applyAgentMessageDelta(
    state: SessionState,
    p: Record<string, unknown>,
  ): boolean {
    const itemId = typeof p.itemId === 'string' ? p.itemId : ''
    const delta = typeof p.delta === 'string' ? p.delta : ''
    if (!itemId || !delta) return false
    return replacePart(state, itemId, part => {
      const prev = typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : ''
      return { ...part, text: prev + delta }
    })
  }

  function applyToolOutputDelta(state: SessionState, p: Record<string, unknown>): boolean {
    const itemId = typeof p.itemId === 'string' ? p.itemId : ''
    const delta = typeof p.delta === 'string' ? p.delta : ''
    if (!itemId || !delta) return false
    return replacePart(state, itemId, part => {
      const stateField =
        isRecord((part as { state?: unknown }).state)
          ? ((part as { state: Record<string, unknown> }).state)
          : {}
      const prev = typeof stateField.output === 'string' ? stateField.output : ''
      return {
        ...part,
        state: { ...stateField, output: prev + delta },
      }
    })
  }

  function applyFileChangePatchUpdated(
    state: SessionState,
    p: Record<string, unknown>,
  ): boolean {
    const itemId = typeof p.itemId === 'string' ? p.itemId : ''
    if (!itemId) return false
    const changes = p.changes
    return replacePart(state, itemId, part => {
      const stateField =
        isRecord((part as { state?: unknown }).state)
          ? ((part as { state: Record<string, unknown> }).state)
          : {}
      const input = isRecord(stateField.input)
        ? (stateField.input as Record<string, unknown>)
        : {}
      return {
        ...part,
        state: {
          ...stateField,
          input: { ...input, changes },
        },
      }
    })
  }

  function applyItemCompleted(state: SessionState, p: Record<string, unknown>): boolean {
    const item = isRecord(p.item) ? (p.item as ItemShape) : null
    if (!item) return false
    const itemId = typeof item.id === 'string' ? item.id : ''
    if (!itemId) return false
    const itemType = typeof item.type === 'string' ? item.type : ''
    state.inFlightItemIds.delete(itemId)

    if (itemType === 'agentMessage') {
      const text = typeof item.text === 'string' ? item.text : ''
      return replacePart(state, itemId, part => ({ ...part, text }))
    }

    if (itemType === 'commandExecution') {
      return replacePart(state, itemId, part => {
        const stateField =
          isRecord((part as { state?: unknown }).state)
            ? ((part as { state: Record<string, unknown> }).state)
            : {}
        const status = typeof item.status === 'string' ? item.status : 'completed'
        const aggregated = typeof item.aggregatedOutput === 'string'
          ? item.aggregatedOutput
          : (typeof stateField.output === 'string' ? stateField.output : '')
        const next: Record<string, unknown> = {
          ...stateField,
          status,
          output: aggregated,
        }
        if (item.exitCode !== undefined) next.exitCode = item.exitCode
        if (item.durationMs !== undefined) next.durationMs = item.durationMs
        // For exec failures, surface error text alongside output so ToolPart's
        // error branch fires when status==='error'.
        if (status === 'error' && typeof aggregated === 'string') {
          next.error = aggregated
        }
        return { ...part, state: next }
      })
    }

    if (itemType === 'fileChange') {
      return replacePart(state, itemId, part => {
        const stateField =
          isRecord((part as { state?: unknown }).state)
            ? ((part as { state: Record<string, unknown> }).state)
            : {}
        const input = isRecord(stateField.input)
          ? (stateField.input as Record<string, unknown>)
          : {}
        const status = typeof item.status === 'string' ? item.status : 'completed'
        return {
          ...part,
          state: {
            ...stateField,
            status,
            input: { ...input, changes: item.changes ?? input.changes },
          },
        }
      })
    }

    return false
  }

  function applyError(
    sessionID: string,
    state: SessionState,
    p: Record<string, unknown>,
  ): boolean {
    // Only the *terminal* error (willRetry === false) is folded as a
    // user-visible system message. Mid-flight retry events are surfaced
    // via the live BackendEvent stream (handled in mapper + chat App).
    //
    // The synthesized message is in-memory only — the codex server does
    // not persist errors in the rollout JSONL. After reconnect or app
    // restart the bubble is gone, which matches codex's own TUI. The
    // `backendMeta.kind` marker lets MessageBubble render this as a
    // distinct error style instead of a generic system bubble.
    const willRetry = Boolean(p.willRetry)
    if (willRetry) return false
    const turnId = typeof p.turnId === 'string' ? p.turnId : ''
    const error = p.error
    const message: BackendMessage = {
      id: `${turnId}:__error__`,
      sessionID,
      role: 'system',
      backendMeta: { kind: 'turnError' },
      parts: [
        {
          type: 'text',
          text: formatErrorMessage(error),
        },
      ],
    }
    state.messages.push(message)
    return true
  }

  function methodSessionId(method: string, p: Record<string, unknown>): string | null {
    if (method === 'thread/started') {
      const thread = isRecord(p.thread) ? p.thread : null
      const id = thread && typeof thread.id === 'string' ? thread.id : null
      return id
    }
    const tid = typeof p.threadId === 'string' ? p.threadId : null
    return tid
  }

  function apply(method: string, params: unknown): boolean {
    if (!isRecord(params)) return false
    const sessionID = methodSessionId(method, params)
    if (!sessionID) return false
    // Auto-create the session entry on first event. Codex only delivers
    // notifications for threads on the current connection's active turn,
    // so this is bounded to threads the user is actively interacting with
    // — no risk of background-thread inflation. The alternative
    // (require explicit pre-seeding) drops the very first userMessage
    // echo for newly-created sessions, since the chat's first
    // `messages()` round-trip races the server's `item/started`.
    const state = ensureSession(sessionID)

    switch (method) {
      case 'item/started':
        return applyItemStarted(sessionID, state, params)
      case 'item/agentMessage/delta':
        return applyAgentMessageDelta(state, params)
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta':
        return applyToolOutputDelta(state, params)
      case 'item/fileChange/patchUpdated':
        return applyFileChangePatchUpdated(state, params)
      case 'item/completed':
        return applyItemCompleted(state, params)
      case 'turn/completed': {
        // Drop any leftover in-flight ids; their parts stay as-is so the
        // user keeps whatever partial output streamed before the turn ended.
        if (state.inFlightItemIds.size === 0) return false
        state.inFlightItemIds.clear()
        return false
      }
      case 'error':
        return applyError(sessionID, state, params)
      default:
        return false
    }
  }

  return {
    apply,
    snapshot,
    seedFromTurns,
    has,
    reset,
    resetSession,
  }
}
