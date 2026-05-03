// Tiny TypeScript wrapper around the pure-JS fixture so Vitest tests can
// `import { createCodexMockFixture } from './protocol-fixture'` and get
// typed access to its public surface. The implementation lives in
// `./fixture.mjs`; the `.d.mts` shim alongside it provides the types.

export {
  createCodexMockFixture,
  type CodexMockFixture,
  type CodexMockConnectionHandle,
  type CodexMockRecordedRequest,
  type CodexMockScenario,
  type BindConnectionOptions,
} from './fixture.mjs'
