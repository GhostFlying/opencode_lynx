# OpenCode Wrapper Architecture

## Purpose

This directory contains the thin OpenCode integration layer used by the Lynx app.

The wrapper centralizes integration policy that should not leak into page or store code:

- SDK construction and request defaults
- single-workspace v1 constraints
- session-oriented REST access
- SSE parsing and lifecycle handling
- stream reconciliation and resync decisions
- normalized error handling

The wrapper is intentionally thin. It does **not** reimplement the OpenCode SDK, own UI state, or introduce a heavy domain-mapping layer.

## Design goals

- Keep application code transport-agnostic.
- Use `@opencode-ai/sdk` for REST behavior instead of rebuilding endpoints.
- Support **single-workspace runtime behavior** in v1 while preserving a seam for future multi-workspace support.
- Support **multi-session behavior** in v1.
- Make SSE reconnect and reconciliation behavior deterministic and unit-testable.
- Keep direct SDK imports inside the wrapper boundary only.

## Module map

### Public entrypoint

- `index.ts`
  - Barrel export for the wrapper's supported public surface.
  - Consumers should import the gateway and public contract types from here.

### Contracts and configuration

- `types.ts`
  - Shared public contracts for configuration, scope, sessions, events, and gateway shape.
- `network/contract.ts`
  - Frozen v1 cross-platform `network.*` contract.
  - SSE-first capabilities (`request`, `sse.open`, `sse.close`).
  - Bridge method namespace has 3 methods: `network.request`, `network.sse.open`, `network.sse.close`.
  - No global polyfill assumptions, transport calls flow through the namespaced native bridge (`nativeBridge` LynxModule).
- `config.ts`
  - Single-workspace policy enforcement.
  - Directory resolution.
  - Query-string helper used by SSE URL construction.

### REST path

- `client.ts`
  - Wraps `createOpencodeClient` from `@opencode-ai/sdk`.
  - Normalizes base URL and request defaults.
  - Routes all REST requests through the native bridge directly.
  - Converts SDK failures into wrapper errors.
- `sessions.ts`
  - Session-focused repository wrapper.
  - Maps SDK session/message payloads into stable wrapper records.
  - Validates prompt and session inputs before calling the SDK.

### Streaming path

- `events.ts`
  - Declares required v1 SSE event names.
  - Parses raw event payloads into typed known and unknown event envelopes.
  - Routes SSE streams through the native bridge directly.
  - Provides an SSE lifecycle manager with reconnect and backoff behavior.
- `reconcile.ts`
  - Pure reconciliation state machine.
  - Detects duplicate, out-of-order, and gap cases.
  - Returns typed actions instead of performing network side effects.

### Composition

- `errors.ts`
  - Shared normalized error model and classifier utilities.
- `gateway.ts`
  - Composition root for app-facing consumption.
  - Combines sessions, events, scope resolution, and reconcile helpers into one boundary.

## Runtime flow

### REST flow

1. The app calls `createOpencodeGateway(config)`.
2. `gateway.ts` creates the wrapped SDK client.
3. `client.ts` validates config and builds the SDK client with shared defaults.
4. All REST requests are routed through the native bridge via `network.request`.
5. `sessions.ts` executes SDK operations through `WrappedSdkClient.request(...)`.
8. SDK failures are normalized by `errors.ts` before leaving the wrapper.

### SSE flow

1. The app calls `gateway.events.subscribe(...)`.
2. `events.ts` builds the stream URL and lifecycle manager.
3. SSE streams are opened directly through the native bridge via `network.sse.open`.
4. Raw stream messages are parsed into typed events.
6. `reconcile.ts` evaluates dedupe, order, and gap rules.
7. The gateway emits parsed events plus reconciliation context to the caller.
8. If ordering is invalid, the gateway returns a typed `refetchRequired` action and leaves refetch policy to the caller.

### Transport ownership and deferred scope

- SSE ownership stays inside wrapper events infrastructure and is not spread into pages.
- REST ownership stays inside wrapped SDK and bridge-aware fetch routing.
- PTY or websocket transport behavior is intentionally out of scope for this wrapper version.

## Scope model

v1 is intentionally restricted to a single runtime workspace.

- The default workspace is `default`.
- Callers may pass a workspace selector type as a future-facing seam.
- Any runtime attempt to use a non-default workspace is rejected by `config.ts`.

This keeps the public contract extensible without shipping multi-workspace runtime behavior before it is needed.

## Error model

The wrapper exposes normalized error behavior so app code does not need to understand raw SDK or runtime failures.

- `invalid_config`
  - Local configuration or input validation failure.
- `sdk_request_failed`
  - OpenCode SDK request failure after normalization.
- `unknown`
  - Catch-all wrapper-level failure.

Additional category classification (`auth`, `network`, `rate-limit`, `not-found`, `unknown`) helps with caller policy such as retries or user-facing messaging.

Bridge/native transport failures are normalized into deterministic bridge-aware codes in the normalized payload:

- `bridge_unavailable`
- `bridge_timeout`
- `bridge_cancelled`
- `bridge_protocol`
- `stream_closed`

Bridge-aware retry/category policy is fixed:

- retryable + `network`: `bridge_unavailable`, `bridge_timeout`, `stream_closed`
- non-retryable + `unknown`: `bridge_cancelled`, `bridge_protocol`

This bridge taxonomy does not change wrapper public error codes. Wrapper-thrown errors still expose `invalid_config`, `sdk_request_failed`, and `unknown`.

## Testing strategy

The wrapper is verified with deterministic unit tests under `__tests__/`:

- `scope.single-workspace.test.ts`
  - Scope defaults and v1 workspace guard behavior.
- `rest.policy.test.ts`
  - SDK client construction and request normalization.
- `errors.test.ts`
  - Error classification and wrapper error normalization.
- `errors.bridge.test.ts`
  - Bridge-aware normalization for native envelopes and mixed SDK/native failures.
- `sessions.repository.test.ts`
  - Session repository behavior and validation.
- `events.contracts.test.ts`
  - SSE event-name and parsing contracts.
- `network.contracts.test.ts`
  - SSE-first network contract shape.
- `sse.lifecycle.test.ts`
  - Reconnect, stop, and retry budget behavior.
- `sse.reconcile.test.ts`
  - Dedupe and ordering rules.
- `gateway.composition.test.ts`
  - App-facing gateway composition.
- `gateway.integration.test.ts`
  - End-to-end wrapper interoperability with mocks.
- `sdk-boundary.test.ts`
  - Enforcement that SDK imports stay inside the wrapper boundary.

## Boundaries and non-goals

This wrapper must not:

- call OpenCode SDK directly from page components
- own UI state or view concerns
- implement PTY or WebSocket behavior in v1
- implement runtime multi-workspace behavior in v1
- perform automatic refetches inside reconcile logic
- remap every SDK DTO into a separate domain model unnecessarily

## When to extend this wrapper

Extend this layer when the new behavior is integration policy shared across the app, such as:

- auth bootstrap rules
- common headers
- SSE lifecycle ownership
- reconciliation policy
- future workspace scoping rules

Do **not** extend it for page-specific presentation logic or transient UI formatting concerns.
