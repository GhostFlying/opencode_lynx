import { describe, expect, it } from 'vitest'

import type { OpencodeNetworkApi, OpencodeNetworkRequest } from '../types.js'

async function requestFixture(input: OpencodeNetworkRequest) {
  return {
    status: 200,
    headers: {
      'x-path': input.path,
    },
    body: {
      ok: true,
    },
  }
}

function createNetworkApiFixture(): OpencodeNetworkApi {
  return {
    request: requestFixture as OpencodeNetworkApi['request'],
    sse: {
      open: input => ({
        id: `sse:${input.path}`,
      }),
      close: () => {},
    },
  }
}

describe('network contracts (v1)', () => {
  it('allows request and sse methods under network namespace', async () => {
    const api = createNetworkApiFixture()

    const response = await api.request({
      path: '/session',
      method: 'GET',
    })

    const handle = api.sse.open({
      path: '/global/event',
    })

    api.sse.close(handle)

    expect(response.status).toBe(200)
    expect(response.headers).toEqual({
      'x-path': '/session',
    })
    expect(handle.id).toBe('sse:/global/event')
  })
})
