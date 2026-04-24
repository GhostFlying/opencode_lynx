import { createOpencodeClient } from '@opencode-ai/sdk/v2/client'

import { createOpencodeGateway } from './gateway.js'
import type { EventSourceLike, OpenCodeGatewayContract } from './gateway.js'
import type { OpencodeWrapperConfig } from './types.js'

export type TestEventSourceFactory = (url: string) => EventSourceLike

/**
 * Test-only gateway constructor that bypasses the native bridge and uses the
 * host runtime fetch implementation against a local mock HTTP/SSE server.
 */
export function createHttpTestOpencodeGateway(
  config: OpencodeWrapperConfig,
  createEventSource: TestEventSourceFactory,
): OpenCodeGatewayContract {
  return createOpencodeGateway(config, {
    createClient(options) {
      return createOpencodeClient({
        ...options,
        fetch: globalThis.fetch,
      })
    },
    createEventSource,
  })
}
