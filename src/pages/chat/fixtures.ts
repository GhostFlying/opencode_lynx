import type {
  BackendAgentInfo,
  BackendMessage,
  BackendProviderInfo,
} from '../../backends/index.js'

// Minimal catalog data used when the chat page runs without a live server.
// Keeps the 3-picker UI functional in dev mode.
export const FIXTURE_PROVIDERS: BackendProviderInfo[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    models: [
      {
        id: 'claude-sonnet-4-20250514',
        name: 'Claude Sonnet 4',
        reasoning: true,
        reasoningEfforts: ['low', 'medium', 'high', 'max'],
      },
      {
        id: 'claude-haiku-3-5',
        name: 'Claude Haiku 3.5',
        reasoning: false,
        reasoningEfforts: [],
      },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    models: [
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        reasoning: false,
        reasoningEfforts: [],
      },
      {
        id: 'o3',
        name: 'o3',
        reasoning: true,
        reasoningEfforts: ['low', 'medium', 'high'],
      },
    ],
  },
]

export const FIXTURE_PROVIDER_DEFAULTS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o',
}

export const FIXTURE_AGENTS: BackendAgentInfo[] = [
  {
    id: 'build',
    name: 'build',
    description: 'Default coding agent with full tool access',
    backendMeta: { mode: 'primary' },
  },
  {
    id: 'plan',
    name: 'plan',
    description: 'Read-only planning agent',
    backendMeta: { mode: 'primary' },
  },
  {
    id: 'review',
    name: 'review',
    description: 'Code review specialist',
    backendMeta: { mode: 'subagent' },
  },
]


const SESSION_ID = 'ses_fixture_demo'
const MSG_USER_1 = 'msg_fix_u1'
const MSG_ASST_1 = 'msg_fix_a1'
const MSG_USER_2 = 'msg_fix_u2'
const MSG_ASST_2 = 'msg_fix_a2'

let partSeq = 0
function pid(): string {
  return `part_fix_${++partSeq}`
}

function makeFixtureMessages(sessionId: string): BackendMessage[] {
  partSeq = 0

  return [
    // ── Message 1: User question ──
    {
      id: MSG_USER_1,
      sessionID: sessionId,
      role: 'user',
      createdAt: '2026-04-03T10:00:00Z',
      parts: [
        {
          id: pid(), sessionID: sessionId, messageID: MSG_USER_1, type: 'text',
          text: 'Help me refactor the authentication module. The current implementation mixes session management with password hashing and it\'s becoming hard to test.',
        },
      ],
    },

    // ── Message 2: Full assistant response with all part types ──
    {
      id: MSG_ASST_1,
      sessionID: sessionId,
      role: 'assistant',
      createdAt: '2026-04-03T10:00:05Z',
      completedAt: '2026-04-03T10:00:42Z',
      backendMeta: {
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4-20250514',
        agent: 'build',
        variant: 'medium',
      },
      parts: [
        // step-start
        {
          id: pid(), sessionID: sessionId, messageID: MSG_ASST_1, type: 'step-start',
          snapshot: '4f22a44a11b262d1fcd9bb1811abcf832748651b',
        },

        // reasoning
        {
          id: pid(), sessionID: sessionId, messageID: MSG_ASST_1, type: 'reasoning',
          text: 'The user wants to separate concerns in their auth module. I should first look at the existing code structure to understand the coupling between session management and password hashing. Then I\'ll propose a clean separation with proper interfaces.\n\nKey considerations:\n- Password hashing should be a standalone utility\n- Session management should depend on an abstract auth provider\n- Both should be independently testable',
          time: { start: 1743674405000, end: 1743674408000 },
        },

        // text (intro)
        {
          id: pid(), sessionID: sessionId, messageID: MSG_ASST_1, type: 'text',
          text: 'I\'ll help you refactor the auth module into clean, testable components. Let me first examine the current structure.',
        },

        // tool — completed (bash)
        {
          id: pid(), sessionID: sessionId, messageID: MSG_ASST_1, type: 'tool',
          callID: 'call_bash_001', tool: 'bash',
          state: {
            status: 'completed',
            title: 'List auth module files',
            input: { command: 'find src/auth -type f -name "*.ts" | head -20' },
            output: 'src/auth/index.ts\nsrc/auth/handler.ts\nsrc/auth/session.ts\nsrc/auth/password.ts\nsrc/auth/middleware.ts\nsrc/auth/types.ts',
            metadata: {},
            time: { start: 1743674409000, end: 1743674410000 },
          },
        },

        // tool — error (file_search)
        {
          id: pid(), sessionID: sessionId, messageID: MSG_ASST_1, type: 'tool',
          callID: 'call_search_002', tool: 'file_search',
          state: {
            status: 'error',
            input: { pattern: 'bcrypt.hash', path: '/etc/shadow' },
            error: 'Permission denied: cannot read /etc/shadow. Access restricted to project directory.',
            time: { start: 1743674411000, end: 1743674411500 },
          },
        },

        // text (analysis)
        {
          id: pid(), sessionID: sessionId, messageID: MSG_ASST_1, type: 'text',
          text: 'Found the relevant files. The main coupling is in `handler.ts` where `bcrypt.hash()` is called directly alongside `sessionStore.create()`. Here\'s my refactoring plan:\n\n1. Extract `PasswordService` — handles hashing and verification\n2. Extract `SessionService` — manages session lifecycle\n3. `AuthHandler` depends on both via interfaces',
        },

        // file
        {
          id: pid(), sessionID: sessionId, messageID: MSG_ASST_1, type: 'file',
          mime: 'text/typescript', filename: 'src/auth/handler.ts', url: 'file://src/auth/handler.ts',
          source: {
            type: 'file',
            path: 'src/auth/handler.ts',
            text: { value: 'export class AuthHandler {\n  constructor(\n    private passwordService: PasswordService,\n    private sessionService: SessionService\n  ) {}\n}', start: 0, end: 145 },
          },
        },

        // patch
        {
          id: pid(), sessionID: sessionId, messageID: MSG_ASST_1, type: 'patch',
          hash: 'abc123def456789012345678901234567890abcd',
          files: ['src/auth/handler.ts', 'src/auth/password-service.ts', 'src/auth/session-service.ts', 'src/auth/types.ts'],
        },

        // agent
        {
          id: pid(), sessionID: sessionId, messageID: MSG_ASST_1, type: 'agent',
          name: 'code-review',
          source: { value: 'Reviewing refactored auth module for correctness...', start: 0, end: 52 },
        },

        // text (conclusion)
        {
          id: pid(), sessionID: sessionId, messageID: MSG_ASST_1, type: 'text',
          text: 'The refactoring is complete. Each service now has a single responsibility and can be tested independently with mock dependencies.',
        },

        // step-finish
        {
          id: pid(), sessionID: sessionId, messageID: MSG_ASST_1, type: 'step-finish',
          reason: 'stop',
          snapshot: '4f22a44a11b262d1fcd9bb1811abcf832748651b',
          cost: 0.0234,
          tokens: { total: 94786, input: 1500, output: 800, reasoning: 200, cache: { read: 90624, write: 0 } },
        },

        // snapshot
        {
          id: pid(), sessionID: sessionId, messageID: MSG_ASST_1, type: 'snapshot',
          snapshot: '{"version":1,"files":{"src/auth/handler.ts":"refactored","src/auth/password-service.ts":"new","src/auth/session-service.ts":"new"}}',
        },
      ],
    },

    // ── Message 3: User follow-up ──
    {
      id: MSG_USER_2,
      sessionID: sessionId,
      role: 'user',
      createdAt: '2026-04-03T10:01:00Z',
      parts: [
        {
          id: pid(), sessionID: sessionId, messageID: MSG_USER_2, type: 'text',
          text: 'Can you also update the tests? The existing test file uses a lot of mocking that should be simplified now.',
        },
      ],
    },

    // ── Message 4: In-progress assistant response ──
    {
      id: MSG_ASST_2,
      sessionID: sessionId,
      role: 'assistant',
      createdAt: '2026-04-03T10:01:05Z',
      backendMeta: {
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4-20250514',
        agent: 'build',
        variant: 'medium',
      },
      parts: [
        // step-start
        {
          id: pid(), sessionID: sessionId, messageID: MSG_ASST_2, type: 'step-start',
          snapshot: 'b8c3d5e7f9a1234567890abcdef12345678abcde',
        },

        // reasoning
        {
          id: pid(), sessionID: sessionId, messageID: MSG_ASST_2, type: 'reasoning',
          text: 'Looking at the test files to understand the current mocking patterns. With the new service separation, tests should be much simpler — each service can be tested in isolation.',
          time: { start: 1743674465000 },
        },

        // tool — running
        {
          id: pid(), sessionID: sessionId, messageID: MSG_ASST_2, type: 'tool',
          callID: 'call_bash_003', tool: 'bash',
          state: {
            status: 'running',
            title: 'Running test suite',
            input: { command: 'npm test -- --coverage src/auth/' },
            metadata: {},
            time: { start: 1743674468000 },
          },
        },

        // tool — pending
        {
          id: pid(), sessionID: sessionId, messageID: MSG_ASST_2, type: 'tool',
          callID: 'call_write_004', tool: 'file_write',
          state: { status: 'pending' },
        },
      ],
    },
  ]
}

export function getFixtureMessages(sessionId?: string): BackendMessage[] {
  return makeFixtureMessages(sessionId ?? SESSION_ID)
}
