# Backends Architecture

## Purpose

This directory contains the provider-neutral contract layer for future
multi-backend support.

Its job is to define the shape that higher layers should depend on without
forcing `src/opencode/` to become a fake generic transport layer.

Current stage:

- OpenCode production page path is migrated to this facade
- types, registry, facade, and OpenCode adapter exist
- Codex adapter implemented (sessions, streaming, approvals, catalog) against
  `codex app-server` over WebSocket
- Claude adapter remains unimplemented
- adapter behavior is covered by focused unit tests and page-level facade
  migration tests
- OpenCode facade readiness is also covered by local mock HTTP/SSE integration
  tests, not only object-level stubs
- Codex adapter readiness is covered by an in-process mock `app-server` JSON-RPC
  integration test
- `main` and `chat` pages consume `BackendClient` from this layer instead of
  importing the OpenCode wrapper directly

## Design Rules

- Keep `src/opencode/` as the OpenCode-specific integration boundary.
- Keep provider-neutral contracts thin and UI-oriented.
- Do not invent a fake common wire protocol for OpenCode, Codex, and Claude.
- Do not move host/native responsibilities into this layer.
- Page code should depend on `BackendClient`; direct `src/opencode/` imports
  belong in the OpenCode adapter, wrapper tests, and documentation only.

## Current Contents

- `types.ts`
  - shared backend-neutral contracts for sessions, messages, catalog, events,
    capabilities, subscriptions, and backend targets
- `index.ts`
  - barrel re-export for the contract surface
- `errors.ts`
  - facade-layer typed errors (`unsupported_backend`, `invalid_backend_input`)
- `registry.ts`
  - internal backend factory registry, with OpenCode registered by default
- `facade.ts`
  - thin entrypoint that validates the backend target and resolves a client
- `opencode/adapter.ts`
  - thin adapter that maps the current OpenCode gateway into the shared
    backend-neutral contract
- `opencode/page-migration.ts`
  - thin helper layer used by page code for OpenCode connection/config/client
    creation through the backend facade
- `codex/adapter.ts`
  - thin adapter that maps `codex app-server` JSON-RPC into the shared
    backend-neutral contract
- `codex/protocol.ts`
  - JSON-RPC 2.0 client over `backend.channel.*`, owns reconnect, request
    correlation, and notification fan-out
- `codex/channel.ts`
  - WebSocket channel abstraction over the native `backend.channel.*` bridge,
    with state and message subscriptions
- `codex/mapper.ts`
  - Codex notification → unified event translation (sessions, deltas, tool
    lifecycle, approvals)
- `codex/page-migration.ts`
  - thin helper layer used by page code for Codex connection/config/client
    creation through the backend facade
- `ui-mappers.ts`
  - small page-facing helpers for backend-neutral chat selection inference and
    catalog lookup

## Deferred Work

The following items are intentionally not implemented yet:

- Claude adapter
- Codex agent picker surface (capability `agentPicker: false` in v1)
- Codex reconnect tuning beyond the v1 fixed schedule

Those arrive in later phases after OpenCode and Codex parity is validated.
