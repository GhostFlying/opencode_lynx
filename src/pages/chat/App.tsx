import { useCallback, useEffect, useMemo, useRef, useState } from '@lynx-js/react'
import { KeyboardAwareResponder, KeyboardAwareRoot } from '@lynx-js/lynx-ui'
import { close } from '../../navigation.js'
import { px, readSafeAreaInsetsFromGlobalProps } from '../../safeArea.js'
import { storageGet, storageSet } from '../../storage.js'
import {
  findBackendModel,
  getBackendModelReasoningEffortKeys,
  inferSelectionFromBackendMessages,
} from '../../backends/index.js'
import type {
  BackendAgentInfo,
  BackendClient,
  BackendMessage,
  BackendPromptInput,
  BackendProviderInfo,
  BackendSubscription,
} from '../../backends/index.js'
import { createBackendClientFromConnection } from '../main/connection.js'
import {
  FIXTURE_AGENTS,
  FIXTURE_PROVIDERS,
  FIXTURE_PROVIDER_DEFAULTS,
  getFixtureMessages,
} from './fixtures.js'
import { MessageBubble } from './MessageBubble.js'
import { ChatInput } from './ChatInput.js'
import { NewSessionCard } from './NewSessionCard.js'
import { PickerOverlay } from './PickerOverlay.js'
import type { PickerOption } from './PickerOverlay.js'
import {
  errorMessageFromBackendEvent,
  isRetryingBackendEvent,
  isTerminalErrorBackendEvent,
  shouldRefreshMessagesForBackendEvent,
  shouldStopThinkingForBackendEvent,
} from './backend-events.js'
import {
  parseChatRouteParams,
  seedNewSessionDefaults,
} from './new-session-model.js'
import type { ChatRouteParams } from './new-session-model.js'

import './App.css'

interface ChatListScrollDetail {
  scrollTop?: number
  scrollHeight?: number
  listHeight?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// Opencode creates an assistant Message row (role=assistant, parts=[]) the
// instant a turn starts — before any content has streamed. Rendering that as
// an empty bubble looks broken; skip it and let the thinking indicator fill
// the gap until the first part arrives.
function hasRenderableContent(msg: BackendMessage): boolean {
  if (msg.role !== 'assistant') return true
  if (!Array.isArray(msg.parts) || msg.parts.length === 0) return false
  return msg.parts.some((p) => {
    const t = (p as { type?: string }).type
    return t !== undefined && t !== 'step-start' && t !== 'step-finish'
  })
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function estimateMessageItemSize(msg: BackendMessage): number {
  const role = msg.role ?? 'assistant'
  let score = role === 'user' ? 96 : 132

  for (const part of msg.parts) {
    const typedPart = part as { type?: string; text?: string; files?: unknown[]; state?: { output?: string; error?: string } }
    const type = typedPart.type ?? 'unknown'

    if (type === 'text' || type === 'reasoning') {
      const text = typedPart.text ?? ''
      score += 28
      score += Math.ceil(text.length / 72) * (type === 'reasoning' ? 22 : 18)
      continue
    }

    if (type === 'tool') {
      const outputLength = typedPart.state?.output?.length ?? typedPart.state?.error?.length ?? 0
      score += 88 + Math.ceil(outputLength / 120) * 16
      continue
    }

    if (type === 'patch') {
      const fileCount = Array.isArray(typedPart.files) ? typedPart.files.length : 0
      score += 84 + fileCount * 18
      continue
    }

    if (type === 'step-start' || type === 'step-finish') {
      score += 26
      continue
    }

    score += 64
  }

  return clamp(score, role === 'user' ? 92 : 118, 420)
}

function countVisibleMessageItems(messages: BackendMessage[], includeThinking: boolean): number {
  const visibleCount = messages.filter(hasRenderableContent).length
  return includeThinking ? visibleCount + 1 : visibleCount
}

interface ChatSelection {
  agent: string
  providerID: string
  modelID: string
  variant: string | null
}

type PickerKind = 'agent' | 'model' | 'effort' | null

const FALLBACK_SELECTION: ChatSelection = {
  agent: 'build',
  providerID: 'anthropic',
  modelID: 'claude-sonnet-4-20250514',
  variant: null,
}

const EFFORT_DEFAULT_KEY = '__default__'
const EFFORT_DEFAULT_LABEL = 'default'
const CHAT_HEADER_TOP_SPACING_PX = 12
const CHAT_INPUT_BOTTOM_SPACING_PX = 12
const CHAT_BOTTOM_STICK_THRESHOLD_PX = 48

// Canonical order so the effort picker always shows keys left-to-right from
// "weakest" to "strongest", regardless of provider catalog order.
const EFFORT_ORDER = [
  'off',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'veryhigh',
  'xhigh',
  'max',
]

function sortEffortKeys(keys: string[]): string[] {
  const present = new Set(keys)
  const known = EFFORT_ORDER.filter(k => present.has(k))
  const knownSet = new Set(known)
  const unknown = keys.filter(k => !knownSet.has(k)).sort()
  return [...known, ...unknown]
}

function deriveAgentLabel(selection: ChatSelection): string {
  return selection.agent || 'agent'
}

function deriveModelLabel(selection: ChatSelection, catalog: BackendProviderInfo[]): string {
  const model = findBackendModel(catalog, selection.providerID, selection.modelID)
  if (model) return model.name
  // Fallback: strip provider-family prefix for a short label.
  const id = selection.modelID
  const shortened = id.split('/').pop() ?? id
  return shortened || 'model'
}

function deriveEffortLabel(selection: ChatSelection): string {
  return selection.variant ?? EFFORT_DEFAULT_LABEL
}

// Persistent storage for chip selections. Backed by the native `storage.*`
// bridge — Lynx has no Web Storage, so this routes through the native bridge
// module → NSUserDefaults. See `src/storage.ts`.
function selectionStorageKey(sessionId: string): string {
  return `chat-selection-${sessionId}`
}

// Defensive guard against malformed or migration-drifted blobs in native
// storage. We only accept a value if every present field has the expected
// type — anything else falls back to defaults via `null`. This deliberately
// stays narrow (FIX-5): a well-formed blob is preserved exactly as before.
function isStoredChatSelection(value: unknown): value is Partial<ChatSelection> {
  if (!isRecord(value)) return false
  if (Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if ('agent' in v && typeof v.agent !== 'string') return false
  if ('providerID' in v && typeof v.providerID !== 'string') return false
  if ('modelID' in v && typeof v.modelID !== 'string') return false
  if ('variant' in v && v.variant !== null && typeof v.variant !== 'string') return false
  return true
}

async function loadStoredSelection(sessionId: string): Promise<Partial<ChatSelection> | null> {
  if (!sessionId) return null
  const raw = await storageGet(selectionStorageKey(sessionId))
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isStoredChatSelection(parsed)) return null
  return parsed
}

function saveStoredSelection(sessionId: string, selection: ChatSelection): void {
  if (!sessionId) return
  // Fire-and-forget — persistence is best-effort.
  void storageSet(selectionStorageKey(sessionId), JSON.stringify(selection))
}

export function App() {
  // Route params come from __globalProps — a fresh object each render. Freeze
  // the extracted values with useMemo([]) so they are reference-stable; any
  // effect that depends on them must not resubscribe on every render.
  const initialRoute = useMemo<ChatRouteParams>(() => parseChatRouteParams(lynx.__globalProps), [])
  const isNewSession = !initialRoute.sessionId
  const sessionTitle = initialRoute.sessionTitle ?? (isNewSession ? 'New session' : 'Chat')
  const connection = initialRoute.connection
  const knownDirectories = useMemo(() => initialRoute.knownDirectories ?? [], [initialRoute])
  const [sessionId, setSessionId] = useState<string>(initialRoute.sessionId ?? '')

  const [messages, setMessages] = useState<BackendMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fixtureMode, setFixtureMode] = useState(false)
  const [sending, setSending] = useState(false)
  // Codex's `error` notifications pulse on every retry attempt before a turn
  // either succeeds or terminally fails. Counting them locally lets the
  // thinking shell text show "Retrying… N" without needing the server to
  // send an attempt counter (the protocol doesn't, today).
  const [retryAttempt, setRetryAttempt] = useState(0)
  const [providersCatalog, setProvidersCatalog] = useState<BackendProviderInfo[]>([])
  const [agentsCatalog, setAgentsCatalog] = useState<BackendAgentInfo[]>([])
  const [providerDefaults, setProviderDefaults] = useState<Record<string, string>>({})
  const [selection, setSelection] = useState<ChatSelection>(() => ({ ...FALLBACK_SELECTION }))
  const [pickerKind, setPickerKind] = useState<PickerKind>(null)
  const [initialScrollIndex, setInitialScrollIndex] = useState<number | null>(null)
  const [pendingDirectory, setPendingDirectory] = useState<string>('')
  const mountedRef = useRef(false)
  const clientRef = useRef<BackendClient | null>(null)
  const msgSeqRef = useRef(0)
  const subscriptionRef = useRef<BackendSubscription | null>(null)
  const refreshInFlightRef = useRef(false)
  const refreshPendingRef = useRef(false)
  const sendingRef = useRef(false)
  // `storageResolvedRef` blocks the message-inference / catalog-default
  // branches from running until the async storage lookup has returned, so a
  // saved pick always wins over a re-inferred fallback on re-entry.
  const storageResolvedRef = useRef(false)
  const selectionInitializedRef = useRef(false)
  const isAtBottomRef = useRef(true)
  const initialScrollDoneRef = useRef(false)

  const safeAreaInsets = readSafeAreaInsetsFromGlobalProps()
  const chatHeaderStyle = {
    paddingTop: px(safeAreaInsets.top + CHAT_HEADER_TOP_SPACING_PX),
  }
  const chatInputAreaStyle = {
    paddingBottom: px(safeAreaInsets.bottom + CHAT_INPUT_BOTTOM_SPACING_PX),
  }

  const updateSending = useCallback((value: boolean) => {
    sendingRef.current = value
    setSending(value)
  }, [])

  const updateBottomAffinity = useCallback((detail: ChatListScrollDetail | undefined) => {
    const scrollTop = detail?.scrollTop
    const scrollHeight = detail?.scrollHeight
    const listHeight = detail?.listHeight
    if (
      typeof scrollTop !== 'number' ||
      typeof scrollHeight !== 'number' ||
      typeof listHeight !== 'number'
    ) {
      return
    }
    const distanceToBottom = scrollHeight - (scrollTop + listHeight)
    isAtBottomRef.current = distanceToBottom <= CHAT_BOTTOM_STICK_THRESHOLD_PX
  }, [])

  // Selection setter that also persists through the native storage bridge. Accepts a partial
  // patch so callers don't need to reconstruct the full object.
  const applySelection = useCallback((patch: Partial<ChatSelection>) => {
    setSelection(prev => {
      const next: ChatSelection = { ...prev, ...patch }
      saveStoredSelection(sessionId, next)
      return next
    })
  }, [sessionId])

  const initClient = useCallback(() => {
    'background only'
    if (clientRef.current) return clientRef.current
    if (!connection) return null
    try {
      const client = createBackendClientFromConnection(connection)
      clientRef.current = client
      return client
    } catch {
      return null
    }
  }, [connection])

  const scrollListToBottom = useCallback((count: number) => {
    'background only'
    if (count <= 0) return
    isAtBottomRef.current = true
    setTimeout(() => {
      lynx
        .createSelectorQuery()
        .select('#chat-msg-list')
        .invoke({
          method: 'scrollToPosition',
          params: { position: count - 1, alignTo: 'bottom', smooth: true },
        })
        .exec()
    }, 50)
  }, [])

  const handleListScroll = useCallback((event: { detail?: ChatListScrollDetail }) => {
    'background only'
    updateBottomAffinity(event.detail)
  }, [updateBottomAffinity])

  const handleInitialLayoutComplete = useCallback(() => {
    'background only'
    if (initialScrollDoneRef.current) return
    initialScrollDoneRef.current = true
    isAtBottomRef.current = true
    setInitialScrollIndex(null)
  }, [])

  const refreshMessages = useCallback(async (showLoading: boolean) => {
    'background only'
    // Fixture mode: no server connection — load local sample data
    if (!connection) {
      const fixtureMsgs = getFixtureMessages(sessionId || undefined)
      const visibleCount = countVisibleMessageItems(fixtureMsgs, false)
      setMessages(fixtureMsgs)
      if (!initialScrollDoneRef.current) {
        if (visibleCount > 0) {
          setInitialScrollIndex(visibleCount - 1)
        } else {
          initialScrollDoneRef.current = true
          setInitialScrollIndex(null)
        }
      }
      setFixtureMode(true)
      setProvidersCatalog(FIXTURE_PROVIDERS)
      setProviderDefaults(FIXTURE_PROVIDER_DEFAULTS)
      setAgentsCatalog(FIXTURE_AGENTS)
      // Seed selection from fixture defaults on first load — but only after
      // the async storage lookup has resolved, so a saved pick always wins.
      if (storageResolvedRef.current && !selectionInitializedRef.current) {
        selectionInitializedRef.current = true
        const inferred = inferSelectionFromBackendMessages(fixtureMsgs)
        if (inferred) {
          applySelection(inferred)
        } else {
          applySelection({
            agent: FIXTURE_AGENTS[0]?.name ?? 'build',
            providerID: 'anthropic',
            modelID: FIXTURE_PROVIDER_DEFAULTS.anthropic ?? 'claude-sonnet-4-20250514',
            variant: null,
          })
        }
      }
      setLoading(false)
      return
    }

    if (!sessionId) {
      // New-session flow: card is rendered above the empty list; do not
      // surface an error and stay out of loading.
      if (isNewSession) {
        setMessages([])
        setLoading(false)
        return
      }
      setError('No session ID provided.')
      setLoading(false)
      return
    }

    // Coalesce concurrent silent refreshes triggered by bursts of SSE events.
    if (!showLoading) {
      if (refreshInFlightRef.current) {
        refreshPendingRef.current = true
        return
      }
      refreshInFlightRef.current = true
    }

    if (showLoading) {
      setLoading(true)
      setError(null)
    }

    try {
      const client = initClient()
      if (!client) {
        setError('No connection payload provided. Go back and reconnect first.')
        setLoading(false)
        return
      }

      const result = await client.sessions.messages(sessionId)
      const visibleCount = countVisibleMessageItems(result, sendingRef.current)
      const shouldScrollToBottom = initialScrollDoneRef.current && isAtBottomRef.current
      setMessages(result)
      if (!initialScrollDoneRef.current) {
        if (visibleCount > 0) {
          setInitialScrollIndex(visibleCount - 1)
        } else {
          initialScrollDoneRef.current = true
          setInitialScrollIndex(null)
        }
      }
      if (shouldScrollToBottom) {
        scrollListToBottom(visibleCount)
      }
      // First successful load: if the session has previous assistant
      // messages, adopt their provider/model/agent/variant as the current
      // selection. Gated on storageResolvedRef so a user's saved-but-unsent
      // pick always wins over re-inferring from older assistant messages.
      if (storageResolvedRef.current && !selectionInitializedRef.current) {
        selectionInitializedRef.current = true
        const inferred = inferSelectionFromBackendMessages(result)
        if (inferred) {
          applySelection(inferred)
        }
      }
    } catch (err) {
      if (showLoading) {
        const message = err instanceof Error && err.message.trim().length > 0
          ? err.message
          : 'Failed to load messages.'
        setError(message)
      }
      // Silent refresh errors are ignored to avoid disrupting the UI
    } finally {
      if (showLoading) {
        setLoading(false)
      } else {
        refreshInFlightRef.current = false
        if (refreshPendingRef.current) {
          refreshPendingRef.current = false
          void refreshMessages(false)
        }
      }
    }
  }, [sessionId, connection, initClient, scrollListToBottom, applySelection, isNewSession])

  useEffect(() => {
    if (mountedRef.current) return
    mountedRef.current = true
    // Await the storage lookup BEFORE fetching messages, so the init-once
    // branches inside refreshMessages see the correct `storageResolvedRef`
    // state on their first pass. Storage reads through the native bridge
    // are local and very fast (~few ms) — the added latency is negligible
    // and it eliminates any race with message/catalog load ordering.
    void (async () => {
      'background only'
      try {
        const stored = await loadStoredSelection(sessionId)
        if (stored) {
          // setSelection directly (not applySelection) — don't write back
          // to storage on initial hydration, the data came from there.
          setSelection(prev => ({ ...prev, ...stored }))
          selectionInitializedRef.current = true
        }
      } catch {
        // Ignore — treat as "no stored selection".
      }
      storageResolvedRef.current = true
      refreshMessages(true)
    })()
  }, [refreshMessages, sessionId])

  // SSE subscription — drives live streaming updates and the sending indicator.
  useEffect(() => {
    'background only'
    if (!connection || !sessionId) return
    const client = initClient()
    if (!client?.events?.subscribe) return

    const sub = client.events.subscribe({
      autoStart: true,
      onEvent: (event) => {
        if (event.sessionID && event.sessionID !== sessionId) return

        // Mid-flight retry pulse from codex: keep thinking on, bump the
        // attempt counter so the indicator text reflects what's happening.
        if (isRetryingBackendEvent(event)) {
          setRetryAttempt((prev) => prev + 1)
          return
        }

        if (shouldRefreshMessagesForBackendEvent(event)) {
          refreshMessages(false)
          return
        }

        if (shouldStopThinkingForBackendEvent(event)) {
          updateSending(false)
          setRetryAttempt(0)
          if (event.sourceType === 'session.idle') {
            refreshMessages(false)
          }
          if (isTerminalErrorBackendEvent(event)) {
            // The codex store has already inserted a system-message bubble
            // with the error text; pull it via refresh so it shows inline.
            refreshMessages(false)
          }
          return
        }

        if (event.type === 'raw' && event.sourceType === 'session.error') {
          updateSending(false)
          setRetryAttempt(0)
          setError(errorMessageFromBackendEvent(event))
        }
      },
    })
    subscriptionRef.current = sub

    return () => {
      sub.stop()
      subscriptionRef.current = null
    }
  }, [connection, sessionId, initClient, refreshMessages, updateSending])

  // Load provider/agent catalogs from the server once per mount. Failures are
  // logged but not surfaced — chips still work with whatever selection state
  // we have; the pickers just show "No options available" in that case.
  useEffect(() => {
    'background only'
    if (!connection) return // fixture mode handled in refreshMessages
    const client = initClient()
    if (!client?.catalog) return
    const agentPickerEnabled = client.capabilities.agentPicker !== false
    let cancelled = false
    void (async () => {
      try {
        // Skip the agents() round-trip when the backend doesn't support an
        // agent picker (e.g. Codex). The catalog API would return [] anyway,
        // but we save the call and keep behavior explicit.
        const [providersRes, agentsRes] = await Promise.all([
          client.catalog!.providers(),
          agentPickerEnabled
            ? client.catalog!.agents()
            : Promise.resolve<BackendAgentInfo[]>([]),
        ])
        if (cancelled) return
        setProvidersCatalog([...providersRes.providers])
        setProviderDefaults(providersRes.defaults)
        setAgentsCatalog([...agentsRes])
        // If messages didn't supply a selection yet, fall back to server
        // defaults (first provider's default model + first agent if any).
        // Still gated on storage lookup so a stored pick wins.
        if (storageResolvedRef.current && !selectionInitializedRef.current) {
          selectionInitializedRef.current = true
          const firstAgent = agentsRes.find(a => a.name === 'build') ?? agentsRes[0]
          const providerIDs = Object.keys(providersRes.defaults)
          const firstProviderID = providerIDs[0] ?? providersRes.providers[0]?.id
          const firstModelID = firstProviderID
            ? providersRes.defaults[firstProviderID]
              ?? providersRes.providers.find(p => p.id === firstProviderID)?.models[0]?.id
            : undefined
          if (firstProviderID && firstModelID) {
            applySelection({
              // Empty agent string when capability is off — chat App treats
              // empty as "no agent" and the prompt payload omits the field.
              agent: firstAgent?.name ?? '',
              providerID: firstProviderID,
              modelID: firstModelID,
              variant: null,
            })
          }
        }
      } catch {
        // Silent — keep previous selection; pickers will show empty list.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [connection, initClient, applySelection])

  const handleBack = useCallback(() => {
    'background only'
    console.info('chat_back_tapped', { sessionId })
    close()
  }, [sessionId])

  const handleSend = useCallback(async (text: string) => {
    'background only'
    // Ref guard avoids stale-closure re-entry when the memoized child handler
    // holds an older `onSend` reference.
    if (sendingRef.current) return

    const buildOptimisticUserMessage = (boundSessionId: string): BackendMessage => {
      const seq = ++msgSeqRef.current
      return {
        id: `msg_local_${seq}`,
        sessionID: boundSessionId,
        role: 'user',
        createdAt: new Date().toISOString(),
        parts: [
          {
            id: `part_local_${seq}`,
            sessionID: boundSessionId,
            messageID: `msg_local_${seq}`,
            type: 'text',
            text,
          },
        ],
      }
    }

    const buildPayload = (): BackendPromptInput => ({
      model: {
        providerID: selection.providerID,
        modelID: selection.modelID,
      },
      // Only include `agent` when the selection actually has one. The Codex
      // adapter ignores it but stay hygienic across backends.
      ...(selection.agent ? { agent: selection.agent } : {}),
      parts: [{ type: 'text', text }],
      ...(selection.variant ? { reasoningEffort: selection.variant } : {}),
    })

    if (isNewSession && !sessionId) {
      const client = initClient()
      if (!client) {
        setError('No connection payload provided. Go back and reconnect first.')
        return
      }

      updateSending(true)
      setRetryAttempt(0)
      try {
        const directory = pendingDirectory.trim()
        const created = await client.sessions.create(
          directory.length > 0 ? { directory } : undefined,
        )
        const newId = created.id
        const optimistic = buildOptimisticUserMessage(newId)
        setMessages([optimistic])
        saveStoredSelection(newId, selection)
        setSessionId(newId)

        const payload = buildPayload()
        void client.sessions
          .prompt(newId, payload)
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : 'Failed to send message.'
            setError(message)
            updateSending(false)
          })
      } catch (err) {
        updateSending(false)
        const message = err instanceof Error ? err.message : 'Failed to create session.'
        setError(message)
      }
      return
    }

    const userMsg = buildOptimisticUserMessage(sessionId)
    const shouldStickToBottom = isAtBottomRef.current
    setMessages(prev => {
      const next = [...prev, userMsg]
      if (shouldStickToBottom) {
        scrollListToBottom(countVisibleMessageItems(next, !fixtureMode))
      }
      return next
    })

    if (fixtureMode) return

    const client = initClient()
    if (!client) return

    updateSending(true)
    setRetryAttempt(0)
    // Fire-and-forget: OpenCode prompt completion can block until the full
    // response. Unified backend events drive progressive UI refreshes.
    const payload = buildPayload()
    void client.sessions
      .prompt(sessionId, payload)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Failed to send message.'
        setError(message)
        updateSending(false)
      })
  }, [
    sessionId,
    fixtureMode,
    initClient,
    scrollListToBottom,
    updateSending,
    selection,
    isNewSession,
    pendingDirectory,
  ])

  // Keyboard avoidance is delegated to KeyboardAwareRoot/Responder/Trigger from
  // @lynx-js/lynx-ui (wrapping the chat-body below). The Root listens for
  // keyboardstatuschanged itself, queries the focused input's rect, and only
  // shifts the responder when the input would otherwise be hidden — so a top-of-
  // page input (e.g. NewSessionCard's directory field) stays in place.

  // Derive picker data + labels from current selection + catalogs.
  const currentModel = findBackendModel(providersCatalog, selection.providerID, selection.modelID)
  const variantKeys = sortEffortKeys(getBackendModelReasoningEffortKeys(currentModel))
  const variantAvailable = variantKeys.length > 0

  // Capability gate for the agent picker. Lazy-read off the cached client so
  // fixture mode (no client) still keeps the historical "agent picker on"
  // behaviour the demo data expects. Codex sets this to false.
  const cachedClient = clientRef.current
  const agentPickerEnabled = cachedClient
    ? cachedClient.capabilities.agentPicker !== false
    : true
  // Flat catalog (single provider, e.g. Codex) collapses the provider/model
  // label to model-only. Selection storage still uses `${providerID}/${modelID}`;
  // only the visual representation changes.
  const hasFlatCatalog = providersCatalog.length <= 1

  const agentLabel = deriveAgentLabel(selection)
  const modelLabel = deriveModelLabel(selection, providersCatalog)
  const effortLabel = deriveEffortLabel(selection)

  const agentOptions: PickerOption[] = agentsCatalog.map(a => ({
    key: a.name,
    title: a.name,
    ...(a.description ? { subtitle: a.description } : {}),
  }))

  // Stable alphabetical ordering keeps provider-native catalog order from
  // looking shuffled to end-users.
  const sortedProviders = [...providersCatalog]
    .sort((a, b) => a.name.localeCompare(b.name))
  const modelOptions: PickerOption[] = sortedProviders.flatMap(p =>
    [...p.models]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(m => ({
        key: `${p.id}/${m.id}`,
        title: m.name,
        // For flat catalogs (one provider) drop the provider subtitle — the
        // grouping reads as redundant noise when there's nothing to group.
        ...(hasFlatCatalog ? {} : { subtitle: p.name }),
      })),
  )

  const effortOptions: PickerOption[] = variantAvailable
    ? [
        { key: EFFORT_DEFAULT_KEY, title: EFFORT_DEFAULT_LABEL, subtitle: 'Model default' },
        ...variantKeys.map(k => ({ key: k, title: k })),
      ]
    : []

  const selectedModelKey = `${selection.providerID}/${selection.modelID}`
  const selectedEffortKey = selection.variant ?? EFFORT_DEFAULT_KEY

  const handleOpenAgent = useCallback(() => {
    'background only'
    setPickerKind(prev => (prev === 'agent' ? null : 'agent'))
  }, [])
  const handleOpenModel = useCallback(() => {
    'background only'
    setPickerKind(prev => (prev === 'model' ? null : 'model'))
  }, [])
  const handleOpenEffort = useCallback(() => {
    'background only'
    setPickerKind(prev => (prev === 'effort' ? null : 'effort'))
  }, [])
  const handleClosePicker = useCallback(() => {
    'background only'
    setPickerKind(null)
  }, [])

  const handleSelectAgent = useCallback((key: string) => {
    'background only'
    applySelection({ agent: key })
    setPickerKind(null)
  }, [applySelection])

  const handleSelectModel = useCallback((key: string) => {
    'background only'
    const slash = key.indexOf('/')
    if (slash < 0) return
    const providerID = key.slice(0, slash)
    const modelID = key.slice(slash + 1)
    const newModel = findBackendModel(providersCatalog, providerID, modelID)
    const newVariantKeys = getBackendModelReasoningEffortKeys(newModel)
    setSelection(prev => {
      // Preserve variant only if still valid on the new model.
      const nextVariant = prev.variant && newVariantKeys.includes(prev.variant)
        ? prev.variant
        : null
      const next: ChatSelection = {
        ...prev,
        providerID,
        modelID,
        variant: nextVariant,
      }
      saveStoredSelection(sessionId, next)
      return next
    })
    setPickerKind(null)
  }, [providersCatalog, sessionId])

  const handleSelectEffort = useCallback((key: string) => {
    'background only'
    applySelection({ variant: key === EFFORT_DEFAULT_KEY ? null : key })
    setPickerKind(null)
  }, [applySelection])

  const handleDirectoryInput = useCallback((next: string) => {
    'background only'
    setPendingDirectory(next)
  }, [])

  const handlePickDirectory = useCallback((dir: string) => {
    'background only'
    setPendingDirectory(dir)
  }, [])

  const showNewSessionCard = isNewSession && !sessionId

  const chatInputSelection = {
    agentLabel,
    modelLabel,
    effortLabel,
  }

  return (
    <view className="chat-page">
      <view className="chat-header" style={chatHeaderStyle}>
        <view className="chat-back-button" bindtap={handleBack}>
          <view className="chat-back-button__surface">
            <text className="chat-back-button__icon">{'\u2039'}</text>
            <text className="chat-back-button__label">Back</text>
          </view>
        </view>

        <view className="chat-title-wrap">
          <text className="chat-title">{sessionTitle}</text>
        </view>
      </view>

      <view className="chat-body">
        <KeyboardAwareRoot androidStatusBarPlusBottomBarHeight={safeAreaInsets.bottom}>
          <KeyboardAwareResponder
            as="View"
            className="chat-body__keyboard-responder"
          >
        {fixtureMode
          ? (
            <view className="dev-banner">
              <text className="dev-banner-text">DEV FIXTURE MODE</text>
            </view>
          )
          : null}

        <view className="chat-content">
          {loading ? (
            <view className="chat-state chat-state--center" style={{ flex: 1 }}>
              <view className="chat-state-card">
                <text className="chat-state-card__title">Loading messages...</text>
                <text className="chat-state-card__body">
                  Pulling the latest conversation from your backend session.
                </text>
              </view>
            </view>
          ) : error ? (
            <view className="chat-state" style={{ flex: 1 }}>
              <view className="chat-error-card">
                <text className="chat-state-card__title">Something went sideways</text>
                <text className="chat-error-text">{error}</text>
              </view>
            </view>
          ) : showNewSessionCard ? (
            <scroll-view
              className="chat-new-session-scroll"
              scroll-orientation="vertical"
              style={{ flex: 1 }}
            >
              <NewSessionCard
                directory={pendingDirectory}
                knownDirectories={knownDirectories}
                agentLabel={agentLabel}
                modelLabel={modelLabel}
                effortLabel={effortLabel}
                variantAvailable={variantAvailable}
                agentPickerEnabled={agentPickerEnabled}
                onDirectoryInput={handleDirectoryInput}
                onPickDirectory={handlePickDirectory}
                onOpenAgent={handleOpenAgent}
                onOpenModel={handleOpenModel}
                onOpenEffort={handleOpenEffort}
              />
            </scroll-view>
          ) : messages.length === 0 ? (
            <view className="chat-state chat-state--center" style={{ flex: 1 }}>
              <view className="chat-state-card">
                <text className="chat-state-card__title">No messages yet</text>
                <text className="chat-state-card__body">
                  Your conversation is ready whenever you want to send the first prompt.
                </text>
              </view>
            </view>
          ) : (
            (() => {
              const visibleMessages = messages.filter(hasRenderableContent)
              return (
                <list
                  id="chat-msg-list"
                  className="chat-list"
                  list-type="single"
                  scroll-orientation="vertical"
                  ios-fix-offset-from-start
                  initial-scroll-index={initialScrollIndex ?? undefined}
                  bindscroll={handleListScroll}
                  bindlayoutcomplete={handleInitialLayoutComplete}
                  style={{ flex: 1 }}
                >
                  {visibleMessages.map((msg) => (
                    <list-item
                      item-key={msg.id}
                      key={msg.id}
                      estimated-main-axis-size-px={estimateMessageItemSize(msg)}
                    >
                      <MessageBubble
                        role={msg.role ?? 'assistant'}
                        parts={msg.parts}
                        createdAt={msg.createdAt}
                        kind={
                          typeof msg.backendMeta?.kind === 'string'
                            ? (msg.backendMeta.kind as string)
                            : undefined
                        }
                      />
                    </list-item>
                  ))}
                  {sending ? (
                    <list-item
                      item-key="__thinking"
                      key="__thinking"
                      estimated-main-axis-size-px={96}
                    >
                      <view className="chat-thinking-shell">
                        <view className="chat-thinking">
                          <text className="chat-thinking-dot">●</text>
                          <text className="chat-thinking-dot">●</text>
                          <text className="chat-thinking-dot">●</text>
                          <text className="chat-thinking-text">
                            {retryAttempt > 0
                              ? `Retrying… ${retryAttempt}`
                              : 'Agent is thinking…'}
                          </text>
                        </view>
                      </view>
                    </list-item>
                  ) : null}
                </list>
              )
            })()
          )}
        </view>

        <ChatInput
          onSend={handleSend}
          disabled={sending}
          selection={chatInputSelection}
          variantAvailable={variantAvailable}
          agentPickerEnabled={agentPickerEnabled}
          onOpenAgentPicker={handleOpenAgent}
          onOpenModelPicker={handleOpenModel}
          onOpenEffortPicker={handleOpenEffort}
          areaStyle={chatInputAreaStyle}
        />
          </KeyboardAwareResponder>
        </KeyboardAwareRoot>
      </view>

      {pickerKind === 'agent' && agentPickerEnabled ? (
        <PickerOverlay
          title="Agent"
          options={agentOptions}
          selectedKey={selection.agent}
          onSelect={handleSelectAgent}
          onClose={handleClosePicker}
        />
      ) : null}
      {pickerKind === 'model' ? (
        <PickerOverlay
          title="Model"
          options={modelOptions}
          selectedKey={selectedModelKey}
          searchable
          searchPlaceholder="Search provider or model…"
          onSelect={handleSelectModel}
          onClose={handleClosePicker}
        />
      ) : null}
      {pickerKind === 'effort' ? (
        <PickerOverlay
          title="Think effort"
          options={effortOptions}
          selectedKey={selectedEffortKey}
          onSelect={handleSelectEffort}
          onClose={handleClosePicker}
        />
      ) : null}
    </view>
  )
}
