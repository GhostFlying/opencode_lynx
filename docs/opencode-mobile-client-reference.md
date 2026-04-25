# OpenCode Mobile Client Reference

This document summarizes the public-facing OpenCode APIs and how OpenChamber uses them, with the specific goal of guiding a new mobile client project that connects to a remote OpenCode server.

## Goal

Build a mobile client on top of OpenCode that can:

- connect to a remote OpenCode server
- list and manage sessions
- send prompts and receive streamed assistant output
- observe server/session status changes in real time
- optionally support terminal-style interactions

---

## 1. High-level architecture

OpenCode exposes a network API that is already suitable for external clients.

The integration model is:

1. use HTTP/JSON for request-response operations
2. use SSE for real-time event delivery
3. use WebSocket only for PTY/terminal-style bidirectional sessions

In practice, a mobile client should treat OpenCode as:

- **REST API server** for CRUD and command endpoints
- **event source** for incremental updates
- **terminal gateway** when interactive shell sessions are needed

---

## 2. Transport model: REST vs SSE vs WebSocket

In this repository's mobile wrapper (`src/opencode`), transport is implemented as SSE-first native bridge networking with deterministic fallback behavior.

### REST API

Use standard HTTP endpoints for:

- listing projects
- creating sessions
- fetching session details
- sending prompts/commands
- reading messages and metadata
- working with config, providers, MCP, files, search, worktrees

This is the baseline transport for most app screens.

### SSE

OpenCode exposes server-sent events for live updates.

Primary endpoint:

- `GET /global/event`

Use SSE for:

- streaming message parts
- message deltas
- session status changes
- server lifecycle events
- permission/question prompts
- MCP/tool refresh signals

SSE is **server -> client only**. It is the correct default for chat/session realtime UX.

Current mobile wrapper mapping:

- SSE ownership is inside wrapper events infrastructure
- native path uses namespaced bridge methods (`network.capabilities`, `network.sse.open`, `network.sse.close`)
- native SSE open accepts the JS-provided global event name and both iOS and
  Android must dispatch stream payloads through that same name so the
  pre-registered `GlobalEventEmitter` listener receives early events
- fallback path uses runtime `EventSource` when native SSE is unavailable or locally disabled
- fallback reasons are deterministic (`force_fallback`, `native_sse_disabled`, `native_unavailable`)

### WebSocket

OpenCode uses WebSocket for PTY connections.

Primary endpoint family:

- `GET /pty/{id}/connect`

Use WebSocket for:

- terminal input/output
- low-latency interactive shell sessions
- full duplex communication

WebSocket is **not** the main transport for ordinary chat/session streaming.

Current wrapper status:

- explicitly deferred for v1 wrapper scope
- capabilities contract marks websocket as `{ supported: false, status: 'deferred', reason: 'sse-first-v1' }`
- no wrapper implementation for websocket transport

---

## 3. What OpenChamber uses

OpenChamber uses **both SSE and WebSocket**, with a clear division of responsibility.

### OpenChamber uses SSE for app state and assistant streaming

Relevant file:

- `openchamber/packages/ui/src/hooks/useEventStream.ts`

Observed behavior:

- subscribes to OpenCode global events
- reacts to `message.part.updated`
- reacts to `message.part.delta`
- reacts to `message.updated`
- reacts to `session.status`
- reacts to server and MCP events
- reconciles local state when event ordering or gaps occur

This is the core of OpenChamber's live chat/session UX.

### OpenChamber uses WebSocket for terminal input/output

Relevant files:

- `openchamber/packages/web/server/index.js`
- `openchamber/packages/web/server/TERMINAL_INPUT_WS_PROTOCOL.md`

Observed behavior:

- WebSocket is used for terminal input path
- SSE remains in place for output/state compatibility in surrounding app flows
- the codebase explicitly documents WebSocket terminal input as a latency optimization over per-keystroke HTTP

### Practical conclusion

For a mobile client:

- **SSE is mandatory** for a good chat/session experience
- **WebSocket is optional** unless terminal support is a product requirement

---

## 4. Main public API surfaces in OpenCode

Source of truth:

- `opencode/packages/sdk/openapi.json`
- generated SDK bindings under `opencode/packages/sdk/js/src/gen/`

Below is the API surface most relevant to an external client.

### Global

- `GET /global/event` — subscribe to global SSE events

### Project

- `GET /project` — list projects
- `GET /project/current` — get current project

### PTY

- `GET /pty` — list PTY sessions
- `POST /pty` — create PTY session
- `GET /pty/{id}` — get PTY
- `PUT /pty/{id}` — update PTY
- `DELETE /pty/{id}` — remove PTY
- `GET /pty/{id}/connect` — connect to PTY transport

### Config and providers

- `GET /config`
- `PATCH /config`
- `GET /config/providers`
- `GET /provider`
- `POST /provider/auth`
- `GET /provider/oauth/authorize`
- `GET /provider/oauth/callback`

### Sessions

- `GET /session`
- `POST /session`
- `GET /session/status`
- `GET /session/{sessionID}`
- `DELETE /session/{sessionID}`
- `PATCH /session/{sessionID}`
- `GET /session/{sessionID}/children`
- `GET /session/{sessionID}/todo`
- `POST /session/{sessionID}/init`
- `POST /session/{sessionID}/fork`
- `POST /session/{sessionID}/abort`
- `POST /session/{sessionID}/share`
- `DELETE /session/{sessionID}/share`
- `GET /session/{sessionID}/diff`
- `POST /session/{sessionID}/summarize`

### Messages and prompting

- `GET /session/{sessionID}/message`
- `POST /session/{sessionID}/message`
- `GET /session/{sessionID}/message/{messageID}`
- `GET /session/{sessionID}/message/{messageID}/part/{partID}`
- `POST /session/{sessionID}/prompt`
- `POST /session/{sessionID}/prompt_async`
- `POST /session/{sessionID}/command`
- `POST /session/{sessionID}/shell`
- `POST /session/{sessionID}/revert`
- `POST /session/{sessionID}/unrevert`
- `POST /session/{sessionID}/permissions/{permissionID}`

### Search and file access

- `POST /find/text`
- `POST /find/files`
- `POST /find/symbols`
- `GET /file`
- `GET /file/status`
- `GET /path`
- `GET /vcs`

### Tools, agents, app metadata

- `GET /agent`
- `GET /app/agents`
- `GET /app/log`
- `GET /experimental/tool/ids`
- `GET /experimental/tool`

### MCP and editor/runtime integration

- `GET /mcp/status`
- `POST /mcp`
- `DELETE /mcp/auth`
- `POST /mcp/auth/start`
- `GET /mcp/auth/callback`
- `POST /mcp/auth/authenticate`
- `POST /mcp/connect`
- `POST /mcp/disconnect`
- `GET /lsp/status`
- `GET /formatter/status`

### Experimental workspace/worktree/global session surfaces

- `POST /experimental/workspace`
- `GET /experimental/workspace`
- `DELETE /experimental/workspace/{id}`
- `POST /experimental/worktree`
- `GET /experimental/worktree`
- `DELETE /experimental/worktree`
- `POST /experimental/worktree/reset`
- `GET /experimental/session`
- `GET /experimental/resource`

---

## 5. Important query parameters and scoping model

Many endpoints support these query parameters:

- `directory`
- `workspace`

This matters a lot for client design.

### `directory`

OpenCode commonly scopes operations to a project directory. A client can switch context by attaching the directory to requests.

This is how OpenChamber builds “scoped clients”.

Relevant file:

- `openchamber/packages/ui/src/lib/opencode/client.ts`

Observed pattern:

- one base client for global/default use
- additional per-directory scoped clients for project-specific operations

### Recommendation

A mobile client should model:

- one global API client
- optional per-project/per-directory scoped clients

---

## 6. SDK usage model

OpenCode ships an SDK:

- `@opencode-ai/sdk`
- OpenChamber imports from `@opencode-ai/sdk/v2`

Relevant file:

- `opencode/packages/sdk/js/src/gen/sdk.gen.ts`

Representative usage style:

```ts
import { createOpencodeClient } from "@opencode-ai/sdk/v2"

const client = createOpencodeClient({
  baseUrl: "https://your-opencode-server",
  directory: "/repo/path",
})

const sessions = await client.session.list()
const created = await client.session.create({
  body: { title: "Mobile Session" },
})
```

### Recommendation

For a new mobile project, use the official SDK where possible, then add a thin app-specific wrapper for:

- auth headers/cookies
- reconnection policy
- directory scoping
- temporary UI message IDs
- local cache reconciliation

In this repository, that wrapper now lives under:

- `src/opencode/`

Current v1 responsibilities in this repo:

- construct the OpenCode SDK client behind a single wrapper boundary
- enforce the current single-workspace runtime policy while keeping a future multi-workspace seam in the public contract
- expose session-oriented REST helpers
- expose SSE URL, parsing, lifecycle, reconnect helpers, and native-preferred SSE routing
- expose deterministic reconciliation logic that returns typed actions instead of performing refetch side effects internally

Current transport routing details in this repo:

- transport mode defaults to `native-preferred`
- request path tries native bridge first (`network.request`) and falls back only for deterministic reasons (`force_fallback`, `native_request_disabled`, `native_unavailable`)
- rollout controls are local config only (`enableNativeRequest`, `enableNativeSse`, `forceFallback`), no remote-config integration in v1
- observability is local through mutable counters and optional `onEvent` callbacks
- no global networking polyfill assumption is made for bridge behavior

For the code-local architecture breakdown, see:

- `src/opencode/ARCHITECTURE.md`

---

## 7. Event model a mobile client must support

Based on OpenChamber's event handling, the mobile client should be prepared to process at least:

- `server.connected`
- `global.disposed`
- `server.instance.disposed`
- `mcp.tools.changed`
- `session.status`
- `message.part.updated`
- `message.part.delta`
- `message.updated`

OpenChamber also handles app-specific events such as:

- `openchamber:session-status`

That event is OpenChamber-specific and should not be treated as part of OpenCode's core public contract unless your own gateway reproduces it.

### Why this matters

Message rendering is not purely request-response. Assistant output arrives incrementally.

Your mobile client should support:

- append new parts
- patch deltas into existing parts
- update message metadata after partial streaming
- recover from missed events by refetching session/message state

---

## 8. Authentication and security observations

OpenCode's raw API surface is one part of the story. OpenChamber adds a browser-facing auth layer.

Relevant file:

- `openchamber/packages/web/server/lib/opencode/ui-auth.js`

Observed behavior in OpenChamber:

- cookie-based browser session named `oc_ui_session`
- JWT-backed session token
- configurable UI password gate
- rate-limited login attempts
- `HttpOnly` cookie
- `SameSite=Strict`
- optional `Secure` flag when request is HTTPS

### Implication for a mobile client

There are two viable deployment models:

#### Model A — connect directly to OpenCode server

Use when:

- you control network access another way
- the server is already protected behind VPN, reverse proxy auth, or private network

#### Model B — connect through a gateway like OpenChamber

Use when:

- you need user-facing authentication
- you want safer remote exposure for browser/mobile clients
- you want to centralize auth, origin checks, and rate limiting

### Recommendation

For an internet-facing mobile product, prefer a gateway/auth layer instead of exposing a raw OpenCode server directly.

---

## 9. Suggested mobile client feature map

### Phase 1 — essential

- server URL configuration
- auth/session bootstrap
- list sessions
- create session
- load session messages
- send prompt
- receive streamed events over SSE
- reconnect SSE on background/foreground/network changes

### Phase 2 — strong parity

- session status view
- permissions/questions UI
- diff/summarize/share flows
- provider/model selection
- project switching via `directory`

### Phase 3 — optional advanced

- PTY terminal via WebSocket
- workspace/worktree management
- MCP status/connection UI
- file/search/LSP utilities

---

## 10. Recommended client architecture

### API layer

Create a wrapper around the official SDK that owns:

- `baseUrl`
- auth state
- default `directory`
- SSE lifecycle
- retry logic

### State layer

Keep local stores for:

- sessions
- per-session messages
- streaming state
- pending permissions/questions
- connection status

### Reconciliation layer

Mirror OpenChamber's defensive behavior:

- if an event arrives out of order, refetch session/messages
- if SSE reconnects, reload recent session state
- if message streaming stalls, resync from server

This matters more on mobile because backgrounding and network instability are normal.

---

## 11. Practical conclusions for a new project

### If the mobile app is chat-first

Implement:

- REST
- SSE

Skip initially:

- WebSocket/PTTY

### If the mobile app must include terminal control

Implement:

- REST
- SSE
- WebSocket for PTY

### If the product is remotely accessible by end users

Prefer:

- OpenCode behind an authenticated gateway
- HTTPS-only deployment
- token/cookie/session management outside the raw OpenCode server boundary

---

## 12. Most relevant source references

### In OpenCode

- `packages/sdk/openapi.json`
- `packages/sdk/js/src/gen/sdk.gen.ts`
- `packages/sdk/js/src/client.ts`
- `packages/sdk/js/src/v2/server.ts`

### In OpenChamber

- `packages/ui/src/lib/opencode/client.ts`
- `packages/ui/src/hooks/useEventStream.ts`
- `packages/web/server/index.js`
- `packages/web/server/lib/opencode/ui-auth.js`
- `packages/web/server/TERMINAL_INPUT_WS_PROTOCOL.md`

---

## 13. Final recommendation

For a first mobile release, the best architecture is:

1. connect to OpenCode with the official SDK for REST operations
2. subscribe to SSE for all live chat/session updates, with native bridge first and deterministic fallback
3. add a small client wrapper modeled after OpenChamber's scoped client pattern
4. keep WebSocket deferred at wrapper level until terminal support is truly needed
5. place an auth-capable gateway in front of OpenCode for remote production access

That gives the smallest implementation surface while preserving the parts that are essential to a high-quality OpenCode client experience.
