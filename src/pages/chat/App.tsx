import { useCallback, useEffect, useMemo, useRef, useState, useLynxGlobalEventListener } from '@lynx-js/react'
import { close } from '../../navigation.js'
import { px, readSafeAreaInsetsFromGlobalProps } from '../../safeArea.js'
import { storageGet, storageSet } from '../../storage.js'
import { createOpencodeGateway } from '../../opencode/gateway.js'
import type { OpenCodeGatewayContract, OpenCodeGatewayEventSubscription } from '../../opencode/gateway.js'
import type {
  AgentInfo,
  CatalogApi,
  ModelInfo,
  ProviderInfo,
  SessionMessageRecord,
  SessionPromptInput,
} from '../../opencode/types.js'
import {
  FIXTURE_AGENTS,
  FIXTURE_PROVIDERS,
  FIXTURE_PROVIDER_DEFAULTS,
  getFixtureMessages,
} from './fixtures.js'
import { MessageBubble } from './MessageBubble.js'
import { ChatInput } from './ChatInput.js'
import { PickerOverlay } from './PickerOverlay.js'
import type { PickerOption } from './PickerOverlay.js'

import './App.css'

interface ConnectionPayload {
  ip?: string
  port?: string
  password?: string
}

interface RouteParams {
  sessionId?: string
  sessionTitle?: string
  connection?: ConnectionPayload
}

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
function hasRenderableContent(msg: SessionMessageRecord): boolean {
  if (msg.info.role !== 'assistant') return true
  if (!Array.isArray(msg.parts) || msg.parts.length === 0) return false
  return msg.parts.some((p) => {
    const t = (p as { type?: string }).type
    return t !== undefined && t !== 'step-start' && t !== 'step-finish'
  })
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function estimateMessageItemSize(msg: SessionMessageRecord): number {
  const role = msg.info.role ?? 'assistant'
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

function countVisibleMessageItems(messages: SessionMessageRecord[], includeThinking: boolean): number {
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
// "weakest" to "strongest", regardless of how the opencode provider emitted
// them. Keys not in this list fall through alphabetically at the end.
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

function findModel(catalog: ProviderInfo[], providerID: string, modelID: string): ModelInfo | undefined {
  return catalog.find(p => p.id === providerID)?.models.find(m => m.id === modelID)
}

function findProvider(catalog: ProviderInfo[], providerID: string): ProviderInfo | undefined {
  return catalog.find(p => p.id === providerID)
}

function getVariantKeys(model: ModelInfo | undefined): string[] {
  if (!model?.variants) return []
  return Object.keys(model.variants)
}

function deriveAgentLabel(selection: ChatSelection): string {
  return selection.agent || 'agent'
}

function deriveModelLabel(selection: ChatSelection, catalog: ProviderInfo[]): string {
  const model = findModel(catalog, selection.providerID, selection.modelID)
  if (model) return model.name
  // Fallback: strip provider-family prefix for a short label.
  const id = selection.modelID
  const shortened = id.split('/').pop() ?? id
  return shortened || 'model'
}

function deriveEffortLabel(selection: ChatSelection): string {
  return selection.variant ?? EFFORT_DEFAULT_LABEL
}

function inferSelectionFromMessages(messages: SessionMessageRecord[]): Partial<ChatSelection> | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i]?.info
    if (!info || info.role !== 'assistant') continue
    if (!info.providerID || !info.modelID) continue
    return {
      agent: info.agent ?? undefined,
      providerID: info.providerID,
      modelID: info.modelID,
      variant: typeof info.variant === 'string' ? info.variant : null,
    }
  }
  return null
}

// Persistent storage for chip selections. Backed by the native `storage.*`
// bridge — Lynx has no Web Storage, so this routes through the native bridge
// module → NSUserDefaults. See `src/storage.ts`.
function selectionStorageKey(sessionId: string): string {
  return `chat-selection-${sessionId}`
}

async function loadStoredSelection(sessionId: string): Promise<Partial<ChatSelection> | null> {
  if (!sessionId) return null
  const raw = await storageGet(selectionStorageKey(sessionId))
  if (!raw) return null
  try {
    return JSON.parse(raw) as Partial<ChatSelection>
  } catch {
    return null
  }
}

function saveStoredSelection(sessionId: string, selection: ChatSelection): void {
  if (!sessionId) return
  // Fire-and-forget — persistence is best-effort.
  void storageSet(selectionStorageKey(sessionId), JSON.stringify(selection))
}

function readRouteParams(): RouteParams {
  const globalProps = lynx.__globalProps as Record<string, unknown> | null | undefined
  let routeParams = globalProps?.routeParams as Record<string, unknown> | null | undefined

  // Some Android Lynx SDK versions do not serialise nested Maps into
  // globalProps. queryItems keeps the raw route_params string as a fallback.
  if (!routeParams) {
    const queryItems = globalProps?.queryItems as Record<string, string> | null | undefined
    const routeParamsRaw = queryItems?.route_params
    if (typeof routeParamsRaw === 'string') {
      try {
        routeParams = JSON.parse(routeParamsRaw) as Record<string, unknown>
      } catch {
        // ignore parse error
      }
    }
  }

  const connection = routeParams?.connection as Record<string, unknown> | null | undefined
  return {
    sessionId: typeof routeParams?.sessionId === 'string' ? routeParams.sessionId : undefined,
    sessionTitle: typeof routeParams?.sessionTitle === 'string' ? routeParams.sessionTitle : undefined,
    connection: connection
      ? {
          ip: typeof connection.ip === 'string' ? connection.ip : undefined,
          port: typeof connection.port === 'string' ? connection.port : undefined,
          password: typeof connection.password === 'string' ? connection.password : undefined,
        }
      : undefined,
  }
}

export function App() {
  // Route params come from __globalProps — a fresh object each render. Freeze
  // the extracted values with useMemo([]) so they are reference-stable; any
  // effect that depends on them must not resubscribe on every render.
  const { sessionId, sessionTitle, connection } = useMemo(() => {
    const rp = readRouteParams()
    return {
      sessionId: rp.sessionId ?? '',
      sessionTitle: rp.sessionTitle ?? 'Chat',
      connection: rp.connection,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [messages, setMessages] = useState<SessionMessageRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fixtureMode, setFixtureMode] = useState(false)
  const [sending, setSending] = useState(false)
  const [keyboardInsetPx, setKeyboardInsetPx] = useState(0)
  const [providersCatalog, setProvidersCatalog] = useState<ProviderInfo[]>([])
  const [agentsCatalog, setAgentsCatalog] = useState<AgentInfo[]>([])
  const [providerDefaults, setProviderDefaults] = useState<Record<string, string>>({})
  const [selection, setSelection] = useState<ChatSelection>(() => ({ ...FALLBACK_SELECTION }))
  const [pickerKind, setPickerKind] = useState<PickerKind>(null)
  const [initialScrollIndex, setInitialScrollIndex] = useState<number | null>(null)
  const mountedRef = useRef(false)
  const gatewayRef = useRef<unknown>(null)
  const msgSeqRef = useRef(0)
  const subscriptionRef = useRef<OpenCodeGatewayEventSubscription | null>(null)
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
  const chatBodyStyle = {
    transform: `translateY(-${keyboardInsetPx}px)`,
    transition: keyboardInsetPx > 0 ? 'transform 0.3s' : 'transform 0.1s',
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

  // Selection setter that also persists to localStorage. Accepts a partial
  // patch so callers don't need to reconstruct the full object.
  const applySelection = useCallback((patch: Partial<ChatSelection>) => {
    setSelection(prev => {
      const next: ChatSelection = { ...prev, ...patch }
      saveStoredSelection(sessionId, next)
      return next
    })
  }, [sessionId])

  const initGateway = useCallback(() => {
    'background only'
    if (gatewayRef.current) return gatewayRef.current
    if (!connection?.ip || !connection.port) return null
    try {
      const baseUrl = `http://${connection.ip}:${connection.port}`
      const config = {
        baseUrl,
        ...(connection.password ? { auth: connection.password } : {}),
      }
      const gw = createOpencodeGateway(config)
      gatewayRef.current = gw
      return gw
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
    if (!connection?.ip) {
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
        const inferred = inferSelectionFromMessages(fixtureMsgs)
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
      const gw = initGateway() as { sessions: { messages: (id: string) => Promise<SessionMessageRecord[]> } } | null
      if (!gw) {
        setError('No connection payload provided. Go back and reconnect first.')
        setLoading(false)
        return
      }

      const result = await gw.sessions.messages(sessionId)
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
        const inferred = inferSelectionFromMessages(result)
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
  }, [sessionId, connection, initGateway, scrollListToBottom, applySelection])

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
    if (!connection?.ip || !sessionId) return
    const gw = initGateway() as OpenCodeGatewayContract | null
    if (!gw?.events?.subscribe) return

    const sub = gw.events.subscribe({
      autoStart: true,
      onEvent: (event) => {
        // Known events expose `type` directly; unknown ones surface via `eventType`.
        const actualType = event.type === 'unknown'
          ? (event as { eventType?: string }).eventType
          : event.type
        const props = (event as { properties?: Record<string, unknown> }).properties ?? {}

        // Extract sessionID from whichever shape the payload uses.
        const eventSessionId =
          (typeof props.sessionID === 'string' && props.sessionID) ||
          (isRecord(props.info) && typeof (props.info as { sessionID?: unknown }).sessionID === 'string'
            ? (props.info as { sessionID: string }).sessionID
            : undefined) ||
          (isRecord(props.part) && typeof (props.part as { sessionID?: unknown }).sessionID === 'string'
            ? (props.part as { sessionID: string }).sessionID
            : undefined)

        if (eventSessionId && eventSessionId !== sessionId) return

        if (actualType === 'message.updated' || actualType === 'message.part.updated') {
          refreshMessages(false)
          return
        }

        if (actualType === 'session.idle') {
          updateSending(false)
          refreshMessages(false)
          return
        }

        if (actualType === 'session.error') {
          updateSending(false)
          const errProps = props as { error?: { data?: { message?: unknown } } }
          const message = typeof errProps.error?.data?.message === 'string'
            ? errProps.error.data.message
            : 'Agent reported an error.'
          setError(message)
        }
      },
    })
    subscriptionRef.current = sub

    return () => {
      sub.stop()
      subscriptionRef.current = null
    }
  }, [connection, sessionId, initGateway, refreshMessages, updateSending])

  // Load provider/agent catalogs from the server once per mount. Failures are
  // logged but not surfaced — chips still work with whatever selection state
  // we have; the pickers just show "No options available" in that case.
  useEffect(() => {
    'background only'
    if (!connection?.ip) return // fixture mode handled in refreshMessages
    const gw = initGateway() as { catalog?: CatalogApi } | null
    if (!gw?.catalog) return
    let cancelled = false
    void (async () => {
      try {
        const [providersRes, agentsRes] = await Promise.all([
          gw.catalog!.providers(),
          gw.catalog!.agents(),
        ])
        if (cancelled) return
        setProvidersCatalog(providersRes.providers)
        setProviderDefaults(providersRes.defaults)
        setAgentsCatalog(agentsRes)
        // If messages didn't supply a selection yet, fall back to server
        // defaults (first agent + first provider's default model). Still
        // gated on storage lookup so a stored pick wins.
        if (storageResolvedRef.current && !selectionInitializedRef.current) {
          selectionInitializedRef.current = true
          const firstAgent = agentsRes.find(a => a.name === 'build') ?? agentsRes[0]
          const providerIDs = Object.keys(providersRes.defaults)
          const firstProviderID = providerIDs[0] ?? providersRes.providers[0]?.id
          const firstModelID = firstProviderID
            ? providersRes.defaults[firstProviderID]
              ?? providersRes.providers.find(p => p.id === firstProviderID)?.models[0]?.id
            : undefined
          if (firstAgent && firstProviderID && firstModelID) {
            applySelection({
              agent: firstAgent.name,
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
  }, [connection, initGateway, applySelection])

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

    const seq = ++msgSeqRef.current
    const userMsg: SessionMessageRecord = {
      info: {
        id: `msg_local_${seq}`,
        sessionID: sessionId,
        role: 'user',
        createdAt: new Date().toISOString(),
      },
      parts: [
        {
          id: `part_local_${seq}`,
          sessionID: sessionId,
          messageID: `msg_local_${seq}`,
          type: 'text',
          text,
        },
      ],
    }

    const shouldStickToBottom = isAtBottomRef.current
    setMessages(prev => {
      const next = [...prev, userMsg]
      if (shouldStickToBottom) {
        scrollListToBottom(countVisibleMessageItems(next, !fixtureMode))
      }
      return next
    })

    if (fixtureMode) return

    type Gateway = { sessions: { prompt: (id: string, payload: SessionPromptInput) => Promise<unknown> } }
    const gw = initGateway() as Gateway | null
    if (!gw) return

    updateSending(true)
    // Fire-and-forget: opencode's prompt endpoint blocks until the full agent response.
    // SSE events (message.part.updated, message.updated, session.idle) drive the UI
    // progressively; session.idle flips `sending` back off.
    const payload: SessionPromptInput = {
      providerID: selection.providerID,
      modelID: selection.modelID,
      agent: selection.agent,
      parts: [{ type: 'text', text }],
      ...(selection.variant ? { variant: selection.variant } : {}),
    }
    void gw.sessions
      .prompt(sessionId, payload)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Failed to send message.'
        setError(message)
        updateSending(false)
      })
  }, [sessionId, fixtureMode, initGateway, scrollListToBottom, updateSending, selection])

  // Keyboard avoidance stays local to chat. Keyboard show/hide is low-frequency,
  // so a local inset state keeps the composer and list in sync without feeding
  // keyboard height through global props.
  useLynxGlobalEventListener(
    'keyboardstatuschanged',
    (status: unknown, keyboardHeight: unknown) => {
      const parsedHeight = typeof keyboardHeight === 'number'
        ? keyboardHeight
        : Number(keyboardHeight ?? 0)
      const nextHeight = status === 'on' && Number.isFinite(parsedHeight)
        ? Math.max(0, parsedHeight)
        : 0
      setKeyboardInsetPx(nextHeight)
    },
  )

  useEffect(() => {
    'background only'
    if (keyboardInsetPx <= 0 || !isAtBottomRef.current) return
    scrollListToBottom(countVisibleMessageItems(messages, sending))
  }, [keyboardInsetPx, messages, sending, scrollListToBottom])

  // Derive picker data + labels from current selection + catalogs.
  const currentModel = findModel(providersCatalog, selection.providerID, selection.modelID)
  const variantKeys = sortEffortKeys(getVariantKeys(currentModel))
  const variantAvailable = variantKeys.length > 0

  const agentLabel = deriveAgentLabel(selection)
  const modelLabel = deriveModelLabel(selection, providersCatalog)
  const effortLabel = deriveEffortLabel(selection)

  const agentOptions: PickerOption[] = agentsCatalog.map(a => ({
    key: a.name,
    title: a.name,
    ...(a.description ? { subtitle: a.description } : {}),
  }))

  // Stable alphabetical ordering — the opencode `/config/providers` response
  // preserves config order, which looks shuffled to end-users.
  const sortedProviders = [...providersCatalog]
    .sort((a, b) => a.name.localeCompare(b.name))
  const modelOptions: PickerOption[] = sortedProviders.flatMap(p =>
    [...p.models]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(m => ({
        key: `${p.id}/${m.id}`,
        title: m.name,
        subtitle: p.name,
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
    const newModel = findModel(providersCatalog, providerID, modelID)
    const newVariantKeys = getVariantKeys(newModel)
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

      <view className="chat-body" style={chatBodyStyle}>
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
                  Pulling the latest conversation from your OpenCode session.
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
                      item-key={msg.info.id}
                      key={msg.info.id}
                      estimated-main-axis-size-px={estimateMessageItemSize(msg)}
                    >
                      <MessageBubble
                        role={msg.info.role ?? 'assistant'}
                        parts={msg.parts}
                        createdAt={msg.info.createdAt}
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
                          <text className="chat-thinking-text">Agent is thinking…</text>
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
          onOpenAgentPicker={handleOpenAgent}
          onOpenModelPicker={handleOpenModel}
          onOpenEffortPicker={handleOpenEffort}
          areaStyle={chatInputAreaStyle}
        />
      </view>

      {pickerKind === 'agent' ? (
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
