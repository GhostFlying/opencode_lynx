# Multi-Backend Client Plan

## Status

This document describes a **planned** architecture for expanding the current mobile client from an OpenCode-only client into a client that can support:

- OpenCode
- Codex
- Claude Code

It does **not** mean those backends are already implemented in this repository.

Today, the repository ships:

- a Lynx mobile client wrapper centered on OpenCode transport and session flows
- native bridge networking for REST and SSE plus `backend.channel.*` for
  bidirectional WebSocket channels (used by Codex)
- a `src/backends/` layer with shared types, registry, facade, OpenCode
  adapter, and Codex adapter (v1)
- production `main` and `chat` pages using the backend facade for both
  OpenCode and Codex, with kind selection in the connection form
- no Claude adapter implementation yet

## Problem Statement

The current app is organized around OpenCode-specific integration code under `src/opencode/`.

That works well for OpenCode because OpenCode already exposes a remote-first API surface built around:

- REST for CRUD and command operations
- SSE for realtime updates
- optional WebSocket for PTY flows

Codex and Claude Code do not fit that exact transport model:

- Codex's rich-client interface is `codex app-server`, not the `codex exec` SDK wrapper
- Claude Code does not currently present a directly comparable public local app-server for third-party mobile clients; the most practical integration path is a local or remote companion bridge built around the official Agent SDK

Because of that mismatch, the client should not try to force all three backends into a single transport implementation. The correct abstraction boundary is a **provider adapter layer**, not a single shared wire protocol.

## Research Summary

### OpenCode

OpenCode is already a good fit for direct mobile-client integration:

- use HTTP/JSON for request-response flows
- use SSE for live session and message updates
- use WebSocket only for PTY-style bidirectional sessions

This repository already reflects that design in:

- `src/opencode/`
- `docs/opencode-mobile-client-reference.md`
- `docs/network-bridge-api-spec.md`

### Codex

Codex exposes an official rich-client interface:

- `codex app-server`
- bidirectional JSON-RPC 2.0
- default transport: `stdio://`
- optional websocket transport: currently experimental / unsupported

Important implications:

- `codex exec` is useful for one-shot automation and JSONL event streaming
- `codex exec` is **not** the right primary interface for a mobile client that needs:
  - thread lifecycle
  - approvals
  - tool progress
  - file-change review
  - long-lived multi-turn sessions

For Codex, the client should target `app-server`.

### Claude Code

Claude Code currently presents three relevant surfaces:

- CLI
- official Agent SDK
- official Remote Control bridge

For a third-party mobile client, the practical path is:

- run a local or remote companion process
- use the official `@anthropic-ai/claude-agent-sdk`
- translate SDK messages, permission prompts, and session lifecycle into the mobile client's unified event model

The official Remote Control feature is useful product evidence, but it is not the same as an openly reusable local rich-client server comparable to `codex app-server`.

## Current Repository Position

The existing `src/opencode/` wrapper is already well-structured and should be preserved as an OpenCode-specific integration layer.

Its current responsibilities are good and should remain scoped:

- SDK construction and request defaults
- single-workspace policy
- session-oriented REST access
- SSE parsing and lifecycle handling
- reconciliation and resync decisions
- normalized error handling

The current wrapper should **not** be generalized in-place into a three-backend layer.

## Design Principles

### 1. Preserve the current OpenCode wrapper

Keep `src/opencode/` as the OpenCode adapter implementation.

Do not rename it into a generic backend layer.

### 2. Add a provider-agnostic facade above provider adapters

The multi-backend abstraction should be a new layer, for example:

- `src/backends/`

This layer should:

- expose a stable UI-facing contract
- hide provider-specific transport differences
- normalize session, message, event, and approval concepts

### 3. Keep transport-specific logic out of Lynx page code

Lynx pages should not know whether a backend uses:

- REST + SSE
- JSON-RPC over stdio
- JSON-RPC over websocket
- a local companion process

Pages should consume a unified facade only.

### 4. Keep host responsibilities in host/native or companion code

The Lynx app must not own:

- process spawning
- SSH bootstrap
- local daemon lifecycle
- `codex app-server` connection details
- Claude Agent SDK runtime execution
- discovery and port forwarding

Those responsibilities belong in:

- iOS/Android native host code
- or an external companion process on the developer machine

### 5. Normalize only what the UI actually needs

The abstraction should be intentionally thin.

It should normalize:

- sessions
- messages
- streaming events
- approvals
- capabilities

It should not attempt to erase all provider differences at the transport level.

## Proposed Module Layout

Recommended top-level client-side structure:

```text
src/
  backends/
    ARCHITECTURE.md
    index.ts
    types.ts
    capabilities.ts
    registry.ts
    facade.ts
    events.ts
    opencode/
      adapter.ts
      mapper.ts
    codex/
      adapter.ts
      mapper.ts
      protocol.ts
    claude/
      adapter.ts
      mapper.ts
      protocol.ts
  opencode/
    ...existing OpenCode wrapper stays here
```

### Why this split

- `src/opencode/` stays intact and continues to own OpenCode-specific policy
- `src/backends/` becomes the app-facing provider-neutral layer
- future backends do not distort the existing OpenCode design

## Unified UI-Facing Contract

The UI should depend on a single backend contract.

Suggested shape:

```ts
export type BackendKind = 'opencode' | 'codex' | 'claude'

export interface BackendCapabilities {
  listSessions: boolean
  createSession: boolean
  resumeSession: boolean
  streamEvents: boolean
  approvals: boolean
  toolCalls: boolean
  pty: boolean
  remoteDiscovery: boolean
  modelPicker: boolean
  agentPicker: boolean
}

export interface UnifiedSessionSummary {
  backend: BackendKind
  id: string
  title?: string
  status?: string
  updatedAt?: string
  directory?: string
  projectLabel?: string
}

export interface UnifiedSessionRecord extends UnifiedSessionSummary {
  createdAt?: string
  parentID?: string
  shareURL?: string
}

export interface UnifiedPromptInput {
  text: string
  attachments?: UnifiedAttachment[]
  model?: UnifiedModelRef
  agent?: string
  reasoningEffort?: string
  tools?: Record<string, boolean>
}

export interface UnifiedMessage {
  id: string
  sessionID: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  createdAt?: string
  completedAt?: string
  backendMeta?: Record<string, unknown>
  parts: UnifiedMessagePart[]
}

export interface UnifiedEvent {
  backend: BackendKind
  type: UnifiedEventType
  sessionID?: string
  turnID?: string
  itemID?: string
  payload: Record<string, unknown>
}

export interface BackendAdapter {
  descriptor(): BackendDescriptor
  sessions: {
    list(scope?: BackendScope): Promise<UnifiedSessionSummary[]>
    create(scope?: BackendScope): Promise<UnifiedSessionRecord>
    get(sessionID: string, scope?: BackendScope): Promise<UnifiedSessionRecord>
    messages(sessionID: string, scope?: BackendScope): Promise<UnifiedMessage[]>
    prompt(sessionID: string, input: UnifiedPromptInput, scope?: BackendScope): Promise<void>
  }
  events: {
    subscribe(options: BackendSubscribeOptions): BackendSubscription
  }
  catalog?: {
    models?(scope?: BackendScope): Promise<UnifiedModelCatalog>
    agents?(scope?: BackendScope): Promise<UnifiedAgentInfo[]>
  }
  approvals?: {
    respond(requestID: string, decision: UnifiedApprovalDecision): Promise<void>
  }
}
```

Current repository checkpoint:

- `src/backends/types.ts` defines the shared contract surface
- `src/backends/index.ts` re-exports the internal API
- `src/backends/registry.ts` and `src/backends/facade.ts` exist for internal use
- `src/backends/opencode/adapter.ts` exists as the first provider implementation
- `src/pages/main` and `src/pages/chat` consume `BackendClient` through the
  OpenCode backend facade helper path

## Unified Event Model

The app should normalize provider events into a small set of UI-relevant event types.

Suggested event set:

- `session.updated`
- `turn.started`
- `turn.completed`
- `message.delta`
- `message.updated`
- `tool.started`
- `tool.completed`
- `approval.requested`
- `approval.resolved`
- `connection.state`
- `resync.required`
- `subagent.started`
- `subagent.completed`

This is intentionally smaller than any provider's native protocol.

## Provider Adapters

### OpenCodeAdapter

Implementation approach:

- wrap the existing `createOpencodeGateway(...)`
- map current `SessionSummary`, `SessionRecord`, and `SessionMessageRecord`
- translate `src/opencode/events.ts` payloads into the unified event model

OpenCode transport remains:

- REST via `network.request`
- SSE via `network.sse.open` / `network.sse.close`
- optional PTY websocket later if the wrapper grows into that scope

### CodexAdapter

Implementation approach:

- use `codex app-server` as the primary provider boundary
- do not use `codex exec` as the main client integration interface

Recommended deployment modes:

- local machine: host/native or companion talks to `codex app-server --listen stdio://`
- remote machine: connect to app-server directly, or bootstrap it over SSH and port-forward loopback

Codex event mapping should normalize:

- `thread/started` -> `session.updated`
- `thread/status/changed` -> `session.updated`
- `thread/name/updated` -> `session.updated` (Codex auto-summarizes threads asynchronously and pushes the new title here; without this mapping the UI keeps the long first-message preview as the title)
- `turn/started` -> `turn.started`
- `turn/completed` -> `turn.completed`
- `item/agentMessage/delta` -> `message.delta`
- item lifecycle notifications for command/file/MCP work -> `tool.started` / `tool.completed`
- approval requests -> `approval.requested`

When mapping `Thread` to a session summary, prefer `Thread.name`. The fallback to `Thread.preview` (the first user message, often unbounded) must truncate to first line + a small character cap so list rows / chat headers stay readable until the auto-summary lands.

### ClaudeAdapter

Implementation approach:

- use a local or remote companion process
- inside the companion, run the official Claude Agent SDK
- translate SDK message flow into the unified event model

Recommended responsibilities of the companion:

- session lifecycle
- prompt submission
- resume behavior
- approval routing
- tool-call translation
- optional transcript/session metadata reads for list screens

Claude event mapping should normalize:

- init/session metadata -> `session.updated`
- assistant text/thinking -> `message.delta` / `message.updated`
- result/finish -> `turn.completed`
- tool permission callback -> `approval.requested`
- tool lifecycle -> `tool.started` / `tool.completed`

## Native Bridge Requirements

The existing `network.*` bridge should remain dedicated to HTTP and SSE.

Do **not** overload `network.request` with Codex- or Claude-specific session protocols.

Instead, add a separate backend-aware native bridge namespace for non-OpenCode providers.

Suggested bridge methods:

- `backend.channel.open`
- `backend.channel.send`
- `backend.channel.close`
- `backend.discovery.scan`
- `backend.discovery.connect`
- `backend.approval.respond`

### Why a separate namespace

- OpenCode already cleanly maps onto HTTP and SSE
- Codex and Claude need long-lived provider-aware channels
- keeping them separate avoids distorting the existing network bridge contract

## Host and Companion Responsibilities

These responsibilities belong outside Lynx page code:

- spawn `codex app-server`
- connect to websocket or stdio JSON-RPC transports
- start and supervise the Claude companion runtime
- run SSH login, key verification, and loopback port forwarding
- perform LAN / Bonjour / Tailscale discovery
- maintain durable approval channels

The Lynx app should own:

- session list rendering
- chat rendering
- model and agent selection
- approval UI
- retry and resync prompts
- backend capability-driven UI branching

## Backend Capabilities

Provider differences should be declared as explicit capabilities, not hardcoded all over the UI.

Suggested initial capability matrix:

| Capability | OpenCode | Codex | Claude Code |
|---|---|---|---|
| sessions | yes | yes | yes (planned) |
| streaming | yes | yes | yes (planned) |
| catalog | yes | yes | yes (planned) |
| approvals | yes | yes | yes (planned) |
| PTY | yes | no | no initial target |
| remote discovery | no initial target | no | no initial target |
| agent picker | yes | no (v1) | yes (planned) |
| model picker | yes | yes | yes (planned) |

The Codex column reflects the actual `CODEX_CAPABILITIES` block in
`src/backends/codex/adapter.ts`. v1 ships with `agentPicker: false`, so the
chat page's agent surface stays gated off for Codex even though Codex itself
has an agent concept (`agentNickname`, `agentRole`, `collabAgentToolCall`
per the local protocol bindings) — we just are not surfacing it in v1.

The UI should branch based on these capability flags instead of checking provider names directly.

## Implementation Phases

### Phase 1: Define the shared contract layer

- keep `src/opencode/` unchanged in responsibility
- add `src/backends/types.ts`
- add `src/backends/index.ts`
- completed before page migration

### Phase 2: Preserve and wrap OpenCode

- add `src/backends/opencode/adapter.ts`
- add `src/backends/registry.ts` and `src/backends/facade.ts`
- completed; the layer is now used by the OpenCode production page path

### Phase 3: Introduce backend channel bridge

Status: complete.

- native `backend.channel.{open,send,close}` contract is documented in
  `docs/network-bridge-api-spec.md`
- iOS and Android implementations are wired through `OpenCodeBridgeModule`
- OpenCode and Codex are both registered in the backend registry; backend
  selection lands in connection form (M3.2)

### Phase 4: Add Codex

Status: in progress / v1 complete; Codex adapter, JSON-RPC bridge, and
connection form selector are merged. Real-codex Gate B validation pending
(see M3.5).

- implement `CodexAdapter`
- support direct app-server connection first
- then add SSH bootstrap and discovery
- normalize approvals and tool-call events

### Phase 5: Add Claude Code

- implement Claude companion runtime
- implement `ClaudeAdapter`
- normalize Agent SDK events into the shared event model

### Phase 6: Shared UI polish and migration

Status: partially complete for OpenCode page migration.

- unify approval cards
- unify tool-call timeline rendering
- unify session list cards
- unify reconnect/resync UI
- migrate pages to the backend facade once OpenCode parity is verified
  - complete for the OpenCode production path on `main` and `chat`
  - Codex production path (v1) and backend channel bridge are merged;
    backend selection lives in the connection form (M3.2)
  - Claude adapter and Codex agent picker surface remain deferred

## Storage migration

The persisted connection record was renamed from `opencode_connection` to
`backend_connection` in M3.1. Existing records are migrated forward at read
time by injecting `kind: 'opencode'` so legacy installs keep working without
prompting the user to reconfigure. New records are written under the new key
with the user-selected backend kind (`opencode` or `codex`). The legacy
`opencode_connection` key is no longer written.

## Risks

### Codex websocket transport status

Codex websocket transport exists, but upstream still documents it as experimental / unsupported.

Implication:

- production remote access should prefer loopback websocket plus SSH forwarding
- direct remote websocket exposure should be treated cautiously

### Claude rich-client boundary

Claude Code does not currently expose a directly comparable third-party local app-server boundary in the same way as Codex.

Implication:

- the project should explicitly plan for a companion layer
- do not design the app assuming an official local Claude app-server will appear soon

### Over-generalization risk

Trying to force all three providers into one transport or DTO layer too early will produce a leaky abstraction.

Implication:

- keep adapter boundaries thin
- normalize only UI-relevant concepts

## Non-Goals

This plan does **not** propose:

- replacing the OpenCode wrapper with a generic wrapper
- moving process orchestration into Lynx page code
- implementing PTY for every backend in the first iteration
- inventing a fake common transport underneath all providers
- claiming that Codex and Claude have identical server surfaces

## Immediate Decisions

The following decisions are recommended now:

1. Preserve `src/opencode/` as an OpenCode-specific wrapper.
2. Introduce a new `src/backends/` facade layer.
3. Use `codex app-server` as the Codex integration boundary.
4. Use a companion built on the official Claude Agent SDK as the Claude integration boundary.
5. Introduce a new native `backend.channel.*` bridge instead of extending `network.*` beyond HTTP and SSE responsibilities.

## References

- `src/opencode/ARCHITECTURE.md`
- `docs/opencode-mobile-client-reference.md`
- `docs/network-bridge-api-spec.md`
- OpenAI Codex `codex-rs/app-server/README.md`
- Anthropic Claude Code Agent SDK and Remote Control sources reviewed during repository research
