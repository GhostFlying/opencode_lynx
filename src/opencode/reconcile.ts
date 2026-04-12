import { isRecord } from './errors.js'

type UnknownRecord = Record<string, unknown>

const DEFAULT_DEDUPE_HISTORY_LIMIT = 512
const DEFAULT_FIRST_EXPECTED_SEQUENCE = 0
const MISSING_SEQUENCE_SENTINEL = -1

/**
 * Minimal stream event shape consumed by the reconciliation algorithm.
 */
export interface ReconcileEventLike {
  type: string
  eventType?: string
  id?: string
  eventID?: string
  eventId?: string
  event_id?: string
  properties: unknown
}

/**
 * Immutable reconciliation state carried between events.
 */
export interface SseReconcileState {
  readonly seenEventIds: readonly string[]
  readonly lastSequenceByKey: Readonly<Record<string, number>>
}

/**
 * Optional tuning parameters for the reconciliation algorithm.
 */
export interface SseReconcileOptions {
  dedupeHistoryLimit?: number
  firstExpectedSequence?: number
}

/**
 * Reasons the caller must refetch state after reconciliation.
 */
export type ReconcileRefetchReason = 'out_of_order' | 'gap'

/**
 * Action emitted when an event is accepted with no resync required.
 */
export interface SseReconcileAcceptedAction {
  type: 'accepted'
  eventName: string
  refetchRequired: false
}

/**
 * Action emitted when an event is ignored because it was already seen.
 */
export interface SseReconcileDeduplicatedAction {
  type: 'deduplicated'
  eventName: string
  duplicateId: string
  refetchRequired: false
}

/**
 * Action emitted when ordering problems require a caller-managed refetch.
 */
export interface SseReconcileRefetchRequiredAction {
  type: 'refetchRequired'
  eventName: string
  reason: ReconcileRefetchReason
  orderKey: string
  expectedSequence: number
  receivedSequence: number
  refetchRequired: true
}

/**
 * All possible reconciliation outcomes.
 */
export type SseReconcileAction =
  | SseReconcileAcceptedAction
  | SseReconcileDeduplicatedAction
  | SseReconcileRefetchRequiredAction

/**
 * Pair of next state plus emitted action.
 */
export interface SseReconcileResult {
  state: SseReconcileState
  action: SseReconcileAction
}

/**
 * Empty initial reconciliation state.
 */
export const INITIAL_SSE_RECONCILE_STATE: SseReconcileState = {
  seenEventIds: [],
  lastSequenceByKey: {},
}

interface OrderingInfo {
  orderKey: string
  sequence: number
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }

  const normalized = Math.floor(value)
  if (normalized <= 0) {
    return fallback
  }

  return normalized
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }

  return Math.max(0, Math.floor(value))
}

function normalizeOptions(options?: SseReconcileOptions): Required<SseReconcileOptions> {
  return {
    dedupeHistoryLimit: normalizePositiveInteger(options?.dedupeHistoryLimit, DEFAULT_DEDUPE_HISTORY_LIMIT),
    firstExpectedSequence: normalizeNonNegativeInteger(options?.firstExpectedSequence, DEFAULT_FIRST_EXPECTED_SEQUENCE),
  }
}

function readString(record: UnknownRecord, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }

  return null
}

function readInteger(record: UnknownRecord, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = record[key]

    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      return value
    }

    if (typeof value === 'string' && /^\d+$/.test(value)) {
      return Number.parseInt(value, 10)
    }
  }

  return null
}

function resolveEventName(event: ReconcileEventLike): string {
  if (event.type === 'unknown' && typeof event.eventType === 'string' && event.eventType.trim().length > 0) {
    return event.eventType.trim()
  }

  return event.type.trim().length > 0 ? event.type.trim() : 'unknown'
}

function readExplicitEventId(event: ReconcileEventLike, properties: UnknownRecord): string | null {
  if (typeof event.id === 'string' && event.id.trim().length > 0) {
    return event.id.trim()
  }

  if (typeof event.eventID === 'string' && event.eventID.trim().length > 0) {
    return event.eventID.trim()
  }

  if (typeof event.eventId === 'string' && event.eventId.trim().length > 0) {
    return event.eventId.trim()
  }

  if (typeof event.event_id === 'string' && event.event_id.trim().length > 0) {
    return event.event_id.trim()
  }

  return readString(properties, ['eventID', 'eventId', 'event_id', 'id'])
}

function toDedupeId(event: ReconcileEventLike, eventName: string, properties: UnknownRecord): string | null {
  const explicitId = readExplicitEventId(event, properties)
  if (!explicitId) {
    return null
  }

  return `event:${eventName}:${explicitId}`
}

function toOrderingInfo(eventName: string, properties: UnknownRecord): OrderingInfo | null {
  const sessionID = readString(properties, ['sessionID', 'sessionId', 'session_id'])
  const messageID = readString(properties, ['messageID', 'messageId', 'message_id'])

  if (!sessionID || !messageID) {
    return null
  }

  if (eventName === 'message.part.updated') {
    const sequence = readInteger(properties, ['partIndex', 'part_index', 'index', 'sequence', 'seq'])

    return {
      orderKey: `message:${sessionID}:${messageID}`,
      sequence: sequence ?? MISSING_SEQUENCE_SENTINEL,
    }
  }

  if (eventName === 'message.part.delta') {
    const partID = readString(properties, ['partID', 'partId', 'part_id'])
    if (!partID) {
      return null
    }

    const sequence = readInteger(properties, ['deltaIndex', 'delta_index', 'index', 'sequence', 'seq'])

    return {
      orderKey: `part:${sessionID}:${messageID}:${partID}`,
      sequence: sequence ?? MISSING_SEQUENCE_SENTINEL,
    }
  }

  return null
}

function withSeenEventId(
  state: SseReconcileState,
  dedupeId: string,
  dedupeHistoryLimit: number,
): SseReconcileState {
  const seenEventIds = [...state.seenEventIds, dedupeId]
  const overflow = seenEventIds.length - dedupeHistoryLimit

  if (overflow > 0) {
    seenEventIds.splice(0, overflow)
  }

  return {
    ...state,
    seenEventIds,
  }
}

function withSequence(state: SseReconcileState, orderKey: string, sequence: number): SseReconcileState {
  return {
    ...state,
    lastSequenceByKey: {
      ...state.lastSequenceByKey,
      [orderKey]: sequence,
    },
  }
}

/**
 * Reconcile a parsed SSE event against the current state.
 *
 * The function is intentionally pure. It never performs IO or automatic refetches;
 * instead it returns a typed action telling the caller what to do next.
 */
export function reconcileSseEvent(
  state: SseReconcileState,
  event: ReconcileEventLike,
  options?: SseReconcileOptions,
): SseReconcileResult {
  const normalizedOptions = normalizeOptions(options)
  const normalizedEventName = resolveEventName(event)
  const properties = isRecord(event.properties) ? event.properties : {}
  const dedupeId = toDedupeId(event, normalizedEventName, properties)

  if (dedupeId && state.seenEventIds.includes(dedupeId)) {
    return {
      state,
      action: {
        type: 'deduplicated',
        eventName: normalizedEventName,
        duplicateId: dedupeId,
        refetchRequired: false,
      },
    }
  }

  const stateAfterDedupe = dedupeId
    ? withSeenEventId(state, dedupeId, normalizedOptions.dedupeHistoryLimit)
    : state

  const ordering = toOrderingInfo(normalizedEventName, properties)

  if (!ordering) {
    return {
      state: stateAfterDedupe,
      action: {
        type: 'accepted',
        eventName: normalizedEventName,
        refetchRequired: false,
      },
    }
  }

  const lastSequence = state.lastSequenceByKey[ordering.orderKey]

  if (ordering.sequence === MISSING_SEQUENCE_SENTINEL) {
    const expectedSequence = lastSequence === undefined
      ? normalizedOptions.firstExpectedSequence
      : lastSequence + 1

    return {
      state: stateAfterDedupe,
      action: {
        type: 'refetchRequired',
        eventName: normalizedEventName,
        reason: 'gap',
        orderKey: ordering.orderKey,
        expectedSequence,
        receivedSequence: MISSING_SEQUENCE_SENTINEL,
        refetchRequired: true,
      },
    }
  }

  if (lastSequence === undefined) {
    if (ordering.sequence > normalizedOptions.firstExpectedSequence) {
      return {
        state: stateAfterDedupe,
        action: {
          type: 'refetchRequired',
          eventName: normalizedEventName,
          reason: 'gap',
          orderKey: ordering.orderKey,
          expectedSequence: normalizedOptions.firstExpectedSequence,
          receivedSequence: ordering.sequence,
          refetchRequired: true,
        },
      }
    }

    if (ordering.sequence < normalizedOptions.firstExpectedSequence) {
      return {
        state: stateAfterDedupe,
        action: {
          type: 'refetchRequired',
          eventName: normalizedEventName,
          reason: 'out_of_order',
          orderKey: ordering.orderKey,
          expectedSequence: normalizedOptions.firstExpectedSequence,
          receivedSequence: ordering.sequence,
          refetchRequired: true,
        },
      }
    }

    return {
      state: withSequence(stateAfterDedupe, ordering.orderKey, ordering.sequence),
      action: {
        type: 'accepted',
        eventName: normalizedEventName,
        refetchRequired: false,
      },
    }
  }

  const expectedSequence = lastSequence + 1

  if (ordering.sequence === expectedSequence) {
    return {
      state: withSequence(stateAfterDedupe, ordering.orderKey, ordering.sequence),
      action: {
        type: 'accepted',
        eventName: normalizedEventName,
        refetchRequired: false,
      },
    }
  }

  if (ordering.sequence < expectedSequence) {
    return {
      state: stateAfterDedupe,
      action: {
        type: 'refetchRequired',
        eventName: normalizedEventName,
        reason: 'out_of_order',
        orderKey: ordering.orderKey,
        expectedSequence,
        receivedSequence: ordering.sequence,
        refetchRequired: true,
      },
    }
  }

  return {
    state: stateAfterDedupe,
    action: {
      type: 'refetchRequired',
      eventName: normalizedEventName,
      reason: 'gap',
      orderKey: ordering.orderKey,
      expectedSequence,
      receivedSequence: ordering.sequence,
      refetchRequired: true,
    },
  }
}
