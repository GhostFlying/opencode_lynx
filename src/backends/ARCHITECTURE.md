# Backends Architecture

## Purpose

This directory contains the provider-neutral contract layer for future
multi-backend support.

Its job is to define the shape that higher layers should depend on without
forcing `src/opencode/` to become a fake generic transport layer.

Current stage:

- phase 2 early internal implementation
- types, registry, facade, and OpenCode adapter exist
- Codex and Claude remain unimplemented
- adapter behavior is covered by focused unit tests intended to support a
  future page-level switch from direct `src/opencode/` imports to the facade
- OpenCode facade readiness is also covered by local mock HTTP/SSE integration
  tests, not only object-level stubs
- current pages still consume `src/opencode/` directly

## Design Rules

- Keep `src/opencode/` as the OpenCode-specific integration boundary.
- Keep provider-neutral contracts thin and UI-oriented.
- Do not invent a fake common wire protocol for OpenCode, Codex, and Claude.
- Do not move host/native responsibilities into this layer.

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
  - thin helper layer for future page migration, so current page code can move
    connection/config/client creation onto the backend facade incrementally

## Deferred Work

The following items are intentionally not implemented yet:

- Codex adapter
- Claude adapter
- backend-native bridge contracts

Those arrive in later phases after OpenCode parity is validated.
