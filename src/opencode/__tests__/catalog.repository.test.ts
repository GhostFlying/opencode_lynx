import { describe, expect, it, vi } from 'vitest'

import { createWrappedSdkClient } from '../client.js'
import { createCatalogApi } from '../catalog-api.js'

function createRepository() {
  const providerListMock = vi.fn()
  const appAgentsMock = vi.fn()

  const createClientMock = vi.fn(() => ({
    provider: {
      list: providerListMock,
    },
    app: {
      agents: appAgentsMock,
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
    catalog: createCatalogApi(wrapped, config),
    mocks: {
      providerListMock,
      appAgentsMock,
    },
  }
}

describe('catalog repository wrapper', () => {
  it('passes scope through to provider and agent catalog calls', async () => {
    const { catalog, mocks } = createRepository()

    mocks.providerListMock.mockResolvedValue({
      data: {
        all: [
          {
            id: 'anthropic',
            name: 'Anthropic',
            models: {
              'claude-sonnet-4': {
                id: 'claude-sonnet-4',
                name: 'Claude Sonnet 4',
                reasoning: true,
                variants: {
                  low: {},
                },
              },
            },
          },
        ],
        default: {
          anthropic: 'claude-sonnet-4',
        },
      },
    })

    mocks.appAgentsMock.mockResolvedValue({
      data: [
        {
          name: 'build',
          description: 'Build things',
          mode: 'primary',
        },
      ],
    })

    await expect(
      catalog.providers({
        directory: '/repo/override',
        workspace: { id: 'default' },
      }),
    ).resolves.toEqual({
      providers: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          models: [
            {
              id: 'claude-sonnet-4',
              name: 'Claude Sonnet 4',
              reasoning: true,
              variants: {
                low: {},
              },
            },
          ],
        },
      ],
      defaults: {
        anthropic: 'claude-sonnet-4',
      },
    })

    await expect(
      catalog.agents({
        directory: '/repo/override',
        workspace: { id: 'default' },
      }),
    ).resolves.toEqual([
      {
        name: 'build',
        description: 'Build things',
        mode: 'primary',
      },
    ])

    expect(mocks.providerListMock).toHaveBeenCalledWith({
      directory: '/repo/override',
      workspace: 'default',
    })
    expect(mocks.appAgentsMock).toHaveBeenCalledWith({
      directory: '/repo/override',
      workspace: 'default',
    })
  })
})
