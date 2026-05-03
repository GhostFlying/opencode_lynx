import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, waitFor } from '@lynx-js/react/testing-library'

import type {
  BackendClient,
  BackendConnectionSnapshot,
  BackendEvent,
  BackendSubscribeOptions,
  BackendSubscription,
} from '../../../backends/index.js'
import { open } from '../../../navigation.js'
import { SessionListView } from '../SessionListView.js'
import {
  KNOWN_DIRECTORY_LIMIT,
  extractKnownDirectories,
  mapBackendSessionToSessionItem,
  shouldRefreshSessionListForBackendEvent,
} from '../session-list-model.js'

vi.mock('../../../navigation.js', () => ({ open: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
})

function createSubscription(): BackendSubscription {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    reconnect: vi.fn(),
    getState: vi.fn((): BackendConnectionSnapshot => ({
      status: 'idle',
      retryAttempt: 0,
      nextRetryInMs: null,
      reason: null,
    })),
    attachAbortSignal: vi.fn(() => () => {}),
  }
}

function createClient(list = vi.fn(async () => [
  {
    backend: 'opencode' as const,
    id: 'session-1',
    title: 'Facade Session',
    updatedAt: '2026-04-26T01:00:00.000Z',
    directory: '/repo/opencode_lynx',
    backendMeta: {
      projectID: 'project-1',
      project: {
        id: 'project-1',
        name: 'opencode_lynx',
        worktree: '/repo/opencode_lynx',
      },
    },
  },
])) {
  let subscribeOptions: BackendSubscribeOptions | undefined
  const subscription = createSubscription()
  const client: BackendClient = {
    descriptor: {
      kind: 'opencode',
      label: 'OpenCode',
    },
    capabilities: {
      sessions: true,
      streaming: true,
      catalog: true,
      approvals: false,
      pty: false,
      remoteDiscovery: false,
      agentPicker: true,
      modelPicker: true,
    },
    sessions: {
      list,
      create: vi.fn(),
      get: vi.fn(),
      messages: vi.fn(),
      prompt: vi.fn(),
    } as unknown as BackendClient['sessions'],
    events: {
      subscribe: vi.fn((options?: BackendSubscribeOptions) => {
        subscribeOptions = options
        options?.onConnectionStateChange?.({
          status: 'open',
          retryAttempt: 0,
          nextRetryInMs: null,
          reason: null,
        })
        return subscription
      }),
    },
    catalog: {
      providers: vi.fn(),
      agents: vi.fn(),
    } as unknown as NonNullable<BackendClient['catalog']>,
  }

  return {
    client,
    list,
    subscription,
    getSubscribeOptions: () => subscribeOptions,
  }
}

describe('SessionListView backend facade behavior', () => {
  it('maps backend session metadata into the existing grouped list shape', () => {
    expect(mapBackendSessionToSessionItem({
      backend: 'opencode',
      id: 'session-1',
      title: 'Session',
      updatedAt: '2026-04-26T01:00:00.000Z',
      directory: '/repo',
      backendMeta: {
        parentID: 'parent-1',
        projectID: 'project-1',
        project: {
          id: 'project-1',
          name: 'Repo',
          worktree: '/repo',
        },
      },
    })).toEqual({
      id: 'session-1',
      title: 'Session',
      updatedAt: '2026-04-26T01:00:00.000Z',
      directory: '/repo',
      parentID: 'parent-1',
      projectID: 'project-1',
      project: {
        id: 'project-1',
        name: 'Repo',
        worktree: '/repo',
      },
    })
  })

  it('caps extractKnownDirectories at KNOWN_DIRECTORY_LIMIT, keeping the most recent', () => {
    const sessions = Array.from({ length: KNOWN_DIRECTORY_LIMIT + 4 }, (_, idx) => ({
      id: `s${idx}`,
      directory: `/repo/dir-${idx}`,
      // Higher idx → later updatedAt, so newest dirs are dir-N..dir-(N-LIMIT+1)
      updatedAt: `2026-04-26T${String(idx).padStart(2, '0')}:00:00.000Z`,
    }))
    const result = extractKnownDirectories(sessions)
    expect(result).toHaveLength(KNOWN_DIRECTORY_LIMIT)
    const lastIdx = sessions.length - 1
    expect(result[0]).toBe(`/repo/dir-${lastIdx}`)
    expect(result[result.length - 1]).toBe(`/repo/dir-${lastIdx - KNOWN_DIRECTORY_LIMIT + 1}`)
  })

  it('extracts known directories deduped and ordered by recency', () => {
    expect(
      extractKnownDirectories([
        { id: 's1', directory: '/repo/a', updatedAt: '2026-04-26T01:00:00.000Z' },
        { id: 's2', directory: '/repo/b', updatedAt: '2026-04-26T03:00:00.000Z' },
        { id: 's3', directory: '/repo/a', updatedAt: '2026-04-26T05:00:00.000Z' },
        { id: 's4', directory: '', updatedAt: '2026-04-26T06:00:00.000Z' },
        { id: 's5' },
        { id: 's6', directory: '/repo/c' },
      ]),
    ).toEqual(['/repo/a', '/repo/b', '/repo/c'])
  })

  it('refreshes from unified backend events that matter to the session list', () => {
    const refreshEvents: BackendEvent[] = [
      {
        backend: 'opencode',
        type: 'session.updated',
        payload: {},
        raw: {},
      },
      {
        backend: 'opencode',
        type: 'message.updated',
        payload: {},
        raw: {},
      },
      {
        backend: 'opencode',
        type: 'resync.required',
        payload: {},
        raw: {},
      },
      {
        backend: 'opencode',
        type: 'raw',
        sourceType: 'session.idle',
        payload: {},
        raw: {},
      },
    ]

    for (const event of refreshEvents) {
      expect(shouldRefreshSessionListForBackendEvent(event)).toBe(true)
    }

    expect(shouldRefreshSessionListForBackendEvent({
      backend: 'opencode',
      type: 'message.delta',
      payload: {},
      raw: {},
    })).toBe(false)
  })

  it('lists sessions, tracks connection lifecycle, refreshes silently, and opens chat with route params', async () => {
    const onConnectionTagChange = vi.fn()
    const onKnownDirectoriesChange = vi.fn()
    const { client, list, getSubscribeOptions, subscription } = createClient()

    const result = render(
      <SessionListView
        client={client}
        connection={{ kind: 'opencode', ip: '127.0.0.1', port: '3000', password: 'secret' }}
        onConnectionTagChange={onConnectionTagChange}
        onKnownDirectoriesChange={onKnownDirectoriesChange}
      />,
    )

    expect(await result.findByText('Facade Session')).toBeInTheDocument()
    expect(await result.findByText('opencode_lynx')).toBeInTheDocument()
    expect(list).toHaveBeenCalledTimes(1)
    expect(onConnectionTagChange).toHaveBeenCalledWith('Online')
    await waitFor(() => {
      expect(onKnownDirectoriesChange).toHaveBeenCalledWith(['/repo/opencode_lynx'])
    })

    act(() => {
      getSubscribeOptions()?.onEvent?.({
        backend: 'opencode',
        type: 'message.updated',
        sessionID: 'session-1',
        payload: {},
        raw: {},
      })
    })

    await waitFor(() => {
      expect(list).toHaveBeenCalledTimes(2)
    })

    const row = result.container.querySelector('.session-row')
    expect(row).not.toBeNull()
    fireEvent.tap(row!)

    expect(open).toHaveBeenCalledTimes(1)
    const scheme = vi.mocked(open).mock.calls[0]![0].scheme
    const encoded = scheme.split('route_params=')[1]!
    expect(JSON.parse(decodeURIComponent(encoded))).toEqual({
      sessionId: 'session-1',
      sessionTitle: 'Facade Session',
      connection: {
        kind: 'opencode',
        ip: '127.0.0.1',
        port: '3000',
        password: 'secret',
      },
    })

    result.unmount()
    expect(subscription.stop).toHaveBeenCalledTimes(1)
  })
})
