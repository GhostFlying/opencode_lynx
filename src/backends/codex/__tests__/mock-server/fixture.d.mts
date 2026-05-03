// TypeScript ambient typing for fixture.mjs. The runtime file is plain
// ESM JS so node and the rspeedy build can import it without a transform;
// this file teaches `tsc` the public surface the integration tests rely
// on. Keep it in sync with fixture.mjs by hand.

export type CodexMockScenario = 'happy-path' | 'approvals' | 'tools'

export interface CodexMockRecordedRequest {
  method: string
  id?: string | number | null
  params: unknown
  ts: number
}

export interface CodexMockConnectionHandle {
  /** Feed an inbound JSON-RPC frame from the client. */
  handle(frame: Record<string, unknown>): void
  /** Mutable, ordered list of frames the client has sent (and responses to server requests). */
  recordedRequests: CodexMockRecordedRequest[]
  /** Drop pending server requests and stop emitting. */
  dispose(): void
}

export interface BindConnectionOptions {
  onSend(frame: Record<string, unknown>): void
  scenario?: CodexMockScenario
}

export interface CodexMockFixture {
  bindConnection(opts: BindConnectionOptions): CodexMockConnectionHandle
}

export function createCodexMockFixture(): CodexMockFixture
