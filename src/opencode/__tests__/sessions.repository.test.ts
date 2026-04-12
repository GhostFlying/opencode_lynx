import { describe, expect, it, vi } from 'vitest'

import { createWrappedSdkClient } from '../client.js'
import { OpencodeWrapperError } from '../errors.js'
import { createSessionsApi } from '../sessions.js'

function createRepository() {
  const sessionListMock = vi.fn()
  const sessionCreateMock = vi.fn()
  const sessionGetMock = vi.fn()
  const sessionMessagesMock = vi.fn()
  const sessionPromptMock = vi.fn()

  const createClientMock = vi.fn(() => ({
    experimental: {
      session: {
        list: sessionListMock,
      },
    },
    session: {
      create: sessionCreateMock,
      get: sessionGetMock,
      messages: sessionMessagesMock,
      prompt: sessionPromptMock,
    },
  }))

  const config = {
    baseUrl: 'https://opencode.example.com',
    auth: 'token-abc',
    directory: '/repo/default',
  }

  const wrapped = createWrappedSdkClient(config, {
    createClient: createClientMock,
  })

  return {
    sessions: createSessionsApi(wrapped, config),
    mocks: {
      sessionListMock,
      sessionCreateMock,
      sessionGetMock,
      sessionMessagesMock,
      sessionPromptMock,
    },
  }
}

describe('sessions repository wrapper', () => {
  it('lists sessions via wrapped request policy with scoped directory', async () => {
    const { sessions, mocks } = createRepository()

    mocks.sessionListMock.mockResolvedValue({
      data: [
        {
          id: 'session-1',
          title: 'Session One',
          status: 'idle',
          time: { updated: 1_700_000_000_000 },
        },
      ],
    })

    const result = await sessions.list({
      directory: '/repo/override',
      workspace: { id: 'default' },
    })

    expect(mocks.sessionListMock).toHaveBeenCalledWith({})

    expect(result).toEqual([
      {
        id: 'session-1',
        title: 'Session One',
        status: 'idle',
        updatedAt: new Date(1_700_000_000_000).toISOString(),
      },
    ])
  })

  it('creates session through wrapped request policy', async () => {
    const { sessions, mocks } = createRepository()

    mocks.sessionCreateMock.mockResolvedValue({
      data: {
        id: 'session-created',
        title: 'Created Session',
        version: '1',
        share: { url: 'https://share.example/session-created' },
        time: {
          created: 1_700_000_000_001,
          updated: 1_700_000_000_002,
        },
      },
    })

    const result = await sessions.create({
      directory: '/repo/new',
      workspace: { id: 'default' },
    })

    expect(mocks.sessionCreateMock).toHaveBeenCalledWith({})

    expect(result).toEqual({
      id: 'session-created',
      title: 'Created Session',
      status: undefined,
      version: '1',
      shareURL: 'https://share.example/session-created',
      createdAt: new Date(1_700_000_000_001).toISOString(),
      updatedAt: new Date(1_700_000_000_002).toISOString(),
      parentID: undefined,
    })
  })

  it('supports multi-session get/messages/prompt operations independently in one workspace', async () => {
    const { sessions, mocks } = createRepository()

    mocks.sessionGetMock.mockImplementation(async ({ sessionID }: { sessionID: string }) => ({
      data: {
        id: sessionID,
        title: `Title ${sessionID}`,
        version: '1',
        time: {
          created: 1_700_000_000_000,
          updated: 1_700_000_000_100,
        },
      },
    }))

    mocks.sessionMessagesMock.mockImplementation(async ({ sessionID }: { sessionID: string }) => ({
      data: [
        {
          info: {
            id: `msg-${sessionID}`,
            sessionID,
            role: 'assistant',
            time: {
              created: 1_700_000_000_000,
            },
          },
          parts: [{ type: 'text', text: `hello ${sessionID}` }],
        },
      ],
    }))

    mocks.sessionPromptMock.mockImplementation(async ({ sessionID }: { sessionID: string }) => ({
      data: {
        info: {
          id: `assistant-${sessionID}`,
          sessionID,
          role: 'assistant',
          time: {
            created: 1_700_000_000_111,
          },
        },
      },
    }))

    const sessionA = 'session-a'
    const sessionB = 'session-b'

    const [getA, getB] = await Promise.all([
      sessions.get(sessionA),
      sessions.get(sessionB),
    ])

    const [messagesA, messagesB] = await Promise.all([
      sessions.messages(sessionA),
      sessions.messages(sessionB),
    ])

    const [promptA, promptB] = await Promise.all([
      sessions.prompt(sessionA, {
        providerID: 'provider-1',
        modelID: 'model-1',
        parts: [{ type: 'text', text: 'hello A' }],
      }),
      sessions.prompt(sessionB, {
        providerID: 'provider-1',
        modelID: 'model-1',
        parts: [{ type: 'text', text: 'hello B' }],
      }),
    ])

    expect(getA.id).toBe(sessionA)
    expect(getB.id).toBe(sessionB)
    expect(messagesA[0]?.info.sessionID).toBe(sessionA)
    expect(messagesB[0]?.info.sessionID).toBe(sessionB)
    expect(promptA.sessionID).toBe(sessionA)
    expect(promptB.sessionID).toBe(sessionB)

    expect(mocks.sessionGetMock).toHaveBeenNthCalledWith(1, {
      sessionID: sessionA,
    })
    expect(mocks.sessionGetMock).toHaveBeenNthCalledWith(2, {
      sessionID: sessionB,
    })

    expect(mocks.sessionMessagesMock).toHaveBeenNthCalledWith(1, {
      sessionID: sessionA,
    })
    expect(mocks.sessionMessagesMock).toHaveBeenNthCalledWith(2, {
      sessionID: sessionB,
    })

    expect(mocks.sessionPromptMock).toHaveBeenNthCalledWith(1, {
      sessionID: sessionA,
      model: {
        providerID: 'provider-1',
        modelID: 'model-1',
      },
      parts: [{ type: 'text', text: 'hello A' }],
    })
    expect(mocks.sessionPromptMock).toHaveBeenNthCalledWith(2, {
      sessionID: sessionB,
      model: {
        providerID: 'provider-1',
        modelID: 'model-1',
      },
      parts: [{ type: 'text', text: 'hello B' }],
    })
  })

  it('normalizes sdk transport failures into typed wrapper errors', async () => {
    const { sessions, mocks } = createRepository()

    const sdkFailure = Object.assign(new Error('session not found'), { status: 404 })
    mocks.sessionGetMock.mockRejectedValue(sdkFailure)

    const error = await sessions.get('missing-session').catch(failure => failure as OpencodeWrapperError)

    expect(error).toBeInstanceOf(OpencodeWrapperError)
    expect(error).not.toBe(sdkFailure)
    expect(error).toMatchObject({
      code: 'sdk_request_failed',
      status: 404,
      retryable: false,
      message: 'OpenCode SDK request failed: session not found',
      cause: sdkFailure,
    })
  })

  it('treats sdk error envelopes as failures instead of silently returning an empty session list', async () => {
    const { sessions, mocks } = createRepository()

    mocks.sessionListMock.mockResolvedValue({
      error: {
        message: 'connect ECONNREFUSED 127.0.0.1:3000',
      },
      response: {
        status: 502,
        statusText: 'Bad Gateway',
      },
    })

    const error = await sessions.list().catch(failure => failure as OpencodeWrapperError)

    expect(error).toBeInstanceOf(OpencodeWrapperError)
    expect(error).toMatchObject({
      code: 'sdk_request_failed',
      status: 502,
      retryable: true,
      message: 'OpenCode SDK request failed: connect ECONNREFUSED 127.0.0.1:3000',
    })
  })

  it('enforces single-workspace policy seam for repository operations', async () => {
    const { sessions } = createRepository()

    await expect(
      sessions.get('session-a', {
        workspace: { id: 'workspace-2' },
      }),
    ).rejects.toThrow('Single-workspace mode only allows workspace "default" in v1.')
  })

  it('validates prompt/session inputs and returns typed config failures', async () => {
    const { sessions, mocks } = createRepository()

    await expect(sessions.messages('   ')).rejects.toMatchObject({
      name: 'OpencodeWrapperError',
      code: 'invalid_config',
      message: 'Session ID is required.',
    })

    await expect(
      sessions.prompt('session-a', {
        providerID: 'provider-1',
        modelID: '',
        parts: [],
      }),
    ).rejects.toMatchObject({
      name: 'OpencodeWrapperError',
      code: 'invalid_config',
      message: 'Prompt payload requires providerID, modelID, and at least one part.',
    })

    expect(mocks.sessionMessagesMock).not.toHaveBeenCalled()
    expect(mocks.sessionPromptMock).not.toHaveBeenCalled()
  })
})
