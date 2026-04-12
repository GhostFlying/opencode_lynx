import { describe, expect, it } from 'vitest'

import {
  INITIAL_SSE_RECONCILE_STATE,
  reconcileSseEvent,
} from '../reconcile.js'

describe('sse reconciliation policy', () => {
  it('accepts normal ordered stream events deterministically', () => {
    const fixtures = [
      {
        type: 'message.part.updated',
        properties: {
          eventID: 'evt-1',
          sessionID: 'session-1',
          messageID: 'message-1',
          partIndex: 0,
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          eventID: 'evt-2',
          sessionID: 'session-1',
          messageID: 'message-1',
          partIndex: 1,
        },
      },
      {
        type: 'message.part.delta',
        properties: {
          eventID: 'evt-3',
          sessionID: 'session-1',
          messageID: 'message-1',
          partID: 'part-1',
          deltaIndex: 0,
          field: 'text',
          delta: 'hello',
        },
      },
      {
        type: 'message.part.delta',
        properties: {
          eventID: 'evt-4',
          sessionID: 'session-1',
          messageID: 'message-1',
          partID: 'part-1',
          deltaIndex: 1,
          field: 'text',
          delta: ' world',
        },
      },
    ] as const

    let state = INITIAL_SSE_RECONCILE_STATE
    const actions = fixtures.map(event => {
      const next = reconcileSseEvent(state, event)
      state = next.state
      return next.action
    })

    expect(actions).toEqual([
      { type: 'accepted', eventName: 'message.part.updated', refetchRequired: false },
      { type: 'accepted', eventName: 'message.part.updated', refetchRequired: false },
      { type: 'accepted', eventName: 'message.part.delta', refetchRequired: false },
      { type: 'accepted', eventName: 'message.part.delta', refetchRequired: false },
    ])

    expect(state).toEqual({
      seenEventIds: [
        'event:message.part.updated:evt-1',
        'event:message.part.updated:evt-2',
        'event:message.part.delta:evt-3',
        'event:message.part.delta:evt-4',
      ],
      lastSequenceByKey: {
        'message:session-1:message-1': 1,
        'part:session-1:message-1:part-1': 1,
      },
    })
  })

  it('deduplicates repeated event ids without side effects', () => {
    const first = {
      type: 'message.part.updated',
      properties: {
        eventID: 'evt-dup-1',
        sessionID: 'session-1',
        messageID: 'message-1',
        partIndex: 0,
      },
    } as const

    const duplicate = {
      type: 'message.part.updated',
      properties: {
        eventID: 'evt-dup-1',
        sessionID: 'session-1',
        messageID: 'message-1',
        partIndex: 99,
      },
    } as const

    const firstResult = reconcileSseEvent(INITIAL_SSE_RECONCILE_STATE, first)
    const duplicateResult = reconcileSseEvent(firstResult.state, duplicate)

    expect(firstResult.action).toEqual({
      type: 'accepted',
      eventName: 'message.part.updated',
      refetchRequired: false,
    })

    expect(duplicateResult.action).toEqual({
      type: 'deduplicated',
      eventName: 'message.part.updated',
      duplicateId: 'event:message.part.updated:evt-dup-1',
      refetchRequired: false,
    })

    expect(duplicateResult.state).toEqual(firstResult.state)
  })

  it('deduplicates native snake_case event_id deterministically', () => {
    const first = {
      type: 'message.part.delta',
      properties: {
        event_id: 'evt-native-dup-1',
        session_id: 'session-1',
        message_id: 'message-1',
        part_id: 'part-1',
        delta_index: 0,
      },
    } as const

    const duplicate = {
      type: 'message.part.delta',
      properties: {
        event_id: 'evt-native-dup-1',
        session_id: 'session-1',
        message_id: 'message-1',
        part_id: 'part-1',
        delta_index: 9,
      },
    } as const

    const firstResult = reconcileSseEvent(INITIAL_SSE_RECONCILE_STATE, first)
    const duplicateResult = reconcileSseEvent(firstResult.state, duplicate)

    expect(firstResult.action).toEqual({
      type: 'accepted',
      eventName: 'message.part.delta',
      refetchRequired: false,
    })

    expect(firstResult.state).toEqual({
      seenEventIds: ['event:message.part.delta:evt-native-dup-1'],
      lastSequenceByKey: {
        'part:session-1:message-1:part-1': 0,
      },
    })

    expect(duplicateResult.action).toEqual({
      type: 'deduplicated',
      eventName: 'message.part.delta',
      duplicateId: 'event:message.part.delta:evt-native-dup-1',
      refetchRequired: false,
    })

    expect(duplicateResult.state).toEqual(firstResult.state)
  })

  it('emits out-of-order refetchRequired action for stale sequence', () => {
    const accepted = reconcileSseEvent(INITIAL_SSE_RECONCILE_STATE, {
      type: 'message.part.updated',
      properties: {
        eventID: 'evt-oo-1',
        sessionID: 'session-1',
        messageID: 'message-1',
        partIndex: 0,
      },
    })

    const outOfOrder = reconcileSseEvent(accepted.state, {
      type: 'message.part.updated',
      properties: {
        eventID: 'evt-oo-2',
        sessionID: 'session-1',
        messageID: 'message-1',
        partIndex: 0,
      },
    })

    expect(outOfOrder.action).toEqual({
      type: 'refetchRequired',
      eventName: 'message.part.updated',
      reason: 'out_of_order',
      orderKey: 'message:session-1:message-1',
      expectedSequence: 1,
      receivedSequence: 0,
      refetchRequired: true,
    })
  })

  it('emits gap refetchRequired action for missing sequence', () => {
    const accepted = reconcileSseEvent(INITIAL_SSE_RECONCILE_STATE, {
      type: 'message.part.delta',
      properties: {
        eventID: 'evt-gap-1',
        sessionID: 'session-1',
        messageID: 'message-1',
        partID: 'part-1',
        deltaIndex: 0,
      },
    })

    const gap = reconcileSseEvent(accepted.state, {
      type: 'message.part.delta',
      properties: {
        eventID: 'evt-gap-2',
        sessionID: 'session-1',
        messageID: 'message-1',
        partID: 'part-1',
        deltaIndex: 2,
      },
    })

    expect(gap.action).toEqual({
      type: 'refetchRequired',
      eventName: 'message.part.delta',
      reason: 'gap',
      orderKey: 'part:session-1:message-1:part-1',
      expectedSequence: 1,
      receivedSequence: 2,
      refetchRequired: true,
    })
  })

  it('emits deterministic refetchRequired when native reconnect payload omits sequence', () => {
    const reconnectState = {
      seenEventIds: ['event:message.part.updated:evt-prev'],
      lastSequenceByKey: {
        'message:session-reconnect:message-1': 3,
      },
    } as const

    const reconnectEvent = {
      type: 'message.part.updated',
      properties: {
        event_id: 'evt-missing-seq',
        session_id: 'session-reconnect',
        message_id: 'message-1',
      },
    } as const

    const first = reconcileSseEvent(reconnectState, reconnectEvent)
    const second = reconcileSseEvent(reconnectState, reconnectEvent)

    expect(first).toEqual(second)
    expect(first.action).toEqual({
      type: 'refetchRequired',
      eventName: 'message.part.updated',
      reason: 'gap',
      orderKey: 'message:session-reconnect:message-1',
      expectedSequence: 4,
      receivedSequence: -1,
      refetchRequired: true,
    })
    expect(first.state).toEqual({
      seenEventIds: [
        'event:message.part.updated:evt-prev',
        'event:message.part.updated:evt-missing-seq',
      ],
      lastSequenceByKey: {
        'message:session-reconnect:message-1': 3,
      },
    })
  })

  it('emits deterministic reconnect gap refetchRequired payload', () => {
    const reconnectState = {
      seenEventIds: ['event:message.part.delta:evt-prev'],
      lastSequenceByKey: {
        'part:session-reconnect:message-1:part-1': 4,
      },
    } as const

    const reconnectGapEvent = {
      type: 'message.part.delta',
      properties: {
        event_id: 'evt-gap-reconnect',
        session_id: 'session-reconnect',
        message_id: 'message-1',
        part_id: 'part-1',
        delta_index: 7,
      },
    } as const

    const first = reconcileSseEvent(reconnectState, reconnectGapEvent)
    const second = reconcileSseEvent(reconnectState, reconnectGapEvent)

    expect(first).toEqual(second)
    expect(first.action).toEqual({
      type: 'refetchRequired',
      eventName: 'message.part.delta',
      reason: 'gap',
      orderKey: 'part:session-reconnect:message-1:part-1',
      expectedSequence: 5,
      receivedSequence: 7,
      refetchRequired: true,
    })
    expect(first.state).toEqual({
      seenEventIds: [
        'event:message.part.delta:evt-prev',
        'event:message.part.delta:evt-gap-reconnect',
      ],
      lastSequenceByKey: {
        'part:session-reconnect:message-1:part-1': 4,
      },
    })
  })

  it('is deterministic and does not mutate input state/event', () => {
    const state = {
      seenEventIds: ['event:message.part.updated:evt-keep'],
      lastSequenceByKey: {
        'message:session-1:message-1': 1,
      },
    } as const

    const event = {
      type: 'message.updated',
      properties: {
        eventID: 'evt-stable',
        sessionID: 'session-1',
        messageID: 'message-1',
      },
    } as const

    const stateSnapshot = {
      seenEventIds: [...state.seenEventIds],
      lastSequenceByKey: { ...state.lastSequenceByKey },
    }

    const eventSnapshot = {
      ...event,
      properties: { ...event.properties },
    }

    const first = reconcileSseEvent(state, event)
    const second = reconcileSseEvent(state, event)

    expect(first).toEqual(second)
    expect(state).toEqual(stateSnapshot)
    expect(event).toEqual(eventSnapshot)
  })
})
