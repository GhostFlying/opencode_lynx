import { describe, expect, it, vi } from 'vitest'

import { createWrappedSdkClient } from '../client.js'
import { createProjectsApi } from '../projects.js'

function createRepository() {
  const projectListMock = vi.fn()

  const createClientMock = vi.fn(() => ({
    project: {
      list: projectListMock,
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
    projects: createProjectsApi(wrapped, config),
    mocks: {
      projectListMock,
    },
  }
}

describe('projects repository wrapper', () => {
  it('passes scope through to project listing', async () => {
    const { projects, mocks } = createRepository()

    mocks.projectListMock.mockResolvedValue({
      data: [
        {
          id: 'project-1',
          worktree: '/repo/override',
          name: 'Repo One',
          vcs: 'git',
        },
      ],
    })

    await expect(
      projects.list({
        directory: '/repo/override',
        workspace: { id: 'default' },
      }),
    ).resolves.toEqual([
      {
        id: 'project-1',
        worktree: '/repo/override',
        name: 'Repo One',
        vcs: 'git',
      },
    ])

    expect(mocks.projectListMock).toHaveBeenCalledWith({
      directory: '/repo/override',
      workspace: 'default',
    })
  })
})
