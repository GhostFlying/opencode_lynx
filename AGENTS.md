# AGENTS.md

This file is for coding agents working in this repository.

## Repository Purpose and Current Direction

This repository is a Lynx-based OpenCode mobile client workspace for iOS and Android.

It ships a Lynx app scaffold with a custom container layer that integrates the Lynx SDK directly.

The client connects to a remote OpenCode server and supports session management, prompt submission with streamed assistant output, and real-time status updates. The API surface (REST, SSE, optional WebSocket/PTY) is documented under `./docs/`.

Today, the repo contains both:

- Lynx application code for the mobile client UI and interaction flows
- native and container host code that embeds Lynx and exposes host capabilities

Do not treat this repository as notes only. Do not assume every planned capability is already implemented. The canonical architectural split is **host (native/container) + Lynx app**.

## Read in Advance, Mandatory

Before doing any Lynx-related task in this repository, you **MUST** read these resources in this exact order:

1. Official Lynx `llms.txt`: <https://lynxjs.org/llms.txt>
2. Project-local Lynx guide: `./docs/lynx-vs-web.md`
3. The relevant task-specific docs under `./docs/` for the work you are about to do

Then, for OpenCode mobile client architecture or API integration tasks, also read:

4. `./docs/opencode-mobile-client-reference.md`

Examples of task-specific docs that must be read before starting work:

- `./docs/build-instructions.md` before package-manager, Python venv, install, test, build, simulator, idb, or run-command work
- any other `./docs/*.md` file that directly governs the area you are changing

## Documentation Sync Rule

For **every code change**, you must check whether there is related documentation in:

1. the same directory as the code you are changing
2. `./docs/`

If relevant documentation exists, review it before editing code.
If the code change affects documented behavior, structure, constraints, workflow, or usage, update the documentation in the same change.

Do not treat documentation updates as optional follow-up work when they are needed to keep the repository accurate.

Why this is mandatory:

- Lynx is not the web runtime
- ReactLynx is React-like, but has a dual-thread model and runtime constraints
- The custom container layer provides navigation, storage, and networking via Lynx native modules, not browser APIs
- OpenCode mobile behavior depends on REST, SSE, and optional PTY WebSocket concerns

If you skip this reading order, you are likely to make incorrect web assumptions and incorrect host integration assumptions.

For build/test/package-manager work in particular:

- run `uv venv` before project commands
- use `pnpm` as the default package manager
- run `pnpm install` from the repository root before running build, test, or platform run commands
- if iOS Ruby version requirements are not met, ask the user whether to resolve them via `rbenv` using the version from `./.ruby-version`

## Hard Runtime Warnings, Keep These Front and Center

When implementing or reviewing code, do not assume:

- DOM APIs exist
- `window` or `document` exist
- browser CSS inheritance defaults apply
- `overflow: scroll` makes arbitrary containers scrollable
- React 18 or 19 concurrency behavior applies
- every Lynx or host API is callable from every thread

Always reason about main thread and background thread behavior before choosing where logic runs.

### Lynx vs Web Quick Reference

**1. Dual-thread runtime**
- Lynx uses main thread + background thread; ReactLynx logic may involve both
- Render-phase code must stay pure; do not assume code executes only once

**2. High-frequency interaction needs thread awareness**
- Main-thread script may be required for gesture/scroll/animation responsiveness
- Standard event callbacks can introduce main → background → main latency

**3. Element system is not HTML**
- Built-in elements: `page`, `view`, `text`, `image`, `scroll-view`, `list`, `input`, `textarea`, `overlay`, `frame`, `refresh`, `native-element`, `svg`
- Text must live inside `<text>`; do not treat `<view>` as a DOM node
- Use `scroll-view` / `list` for scrolling, not `overflow: scroll`

**4. Styling and layout differ from browsers**
- CSS inheritance is not enabled by default
- Margin collapsing does not behave like web
- Some width/clip-path behaviors differ; check `box-sizing` assumptions against Lynx docs

**5. React compatibility has boundaries**
- ReactLynx is mainly React 17-compatible
- `useLayoutEffect` assumptions do not transfer directly

**6. Bundle and engine compatibility**
- Bundle `engineVersion` must match the host Lynx engine capability
- Newer bundle requirements can fail on older hosts

See `docs/lynx-vs-web.md` for the full guide.

## Architecture Boundary Rules, Host vs Lynx App

Keep a strict separation between these layers.

### Layer A: Native and container host code

This includes iOS and Android host integration, container routing and lifecycle glue, native module registration, and bridge capability wiring.

Responsibilities:

- embed and start Lynx pages
- register and expose native capabilities to frontend code
- manage host lifecycle, permissions, and platform services
- enforce engine compatibility and packaging constraints

### Layer B: Lynx app code

This includes ReactLynx pages, components, state management, rendering logic, and client-side interaction flows.

Responsibilities:

- implement UI and interaction in Lynx element and event models
- consume only documented, actually available host or container capabilities
- keep render pure and place side effects in appropriate lifecycle paths

### Non-negotiable boundary behavior

- Do not hide host responsibilities inside Lynx UI abstractions
- Do not claim a native API is usable unless host registration exists
- Do not block Lynx UI work on speculative host features, gate and degrade explicitly
- Do not describe planned capabilities as if they are already shipped

## Container and Bridge Guidance

If a task involves navigation, storage, or global props:

1. Check the custom bridge implementation (`OpenCodeBridgeModule` on iOS/Android) and project docs first
2. Verify host side registration status in this repo before relying on the API
3. If capability is planned but missing, document that clearly and provide fallback behavior

Repository-owned host UI currently also includes custom elements:

- `x-liquid-glass` for glass / frosted surfaces
- `x-native-tabbar` for native-owned bottom tab interaction where press/selection feedback comes from the platform control rather than Lynx event timing

Host containers on both iOS and Android inject `safeAreaInsets` through `lynx.__globalProps` using the shape `{ top, right, bottom, left }`. For full-screen pages, prefer those host-provided inset values over CSS `env(safe-area-inset-*)` when layout must match native viewport geometry exactly.

Do not default to browser routing, `localStorage`, or browser media assumptions.

Bridge methods now include `backend.channel.{open,send,close}` for long-lived bidirectional WebSocket channels (used by the Codex adapter). Server→client frames flow through pre-allocated event names dispatched via `LynxContext.sendGlobalEvent`. Reconnect ownership lives in JS (`src/backends/codex/protocol.ts`), not native — native is transport-only. See `docs/network-bridge-api-spec.md` for the wire contract. Codex is now a selectable backend kind alongside OpenCode (`BackendKind = 'opencode' | 'codex'` in production; `claude` remains declared but unimplemented).

## Current Top-level Structure

The repository follows a standard rspeedy layout at the repo root.

- `src/`
  - Lynx and ReactLynx app code, page entries, assets, and app-level tests
- `ios/`
  - iOS host app, Lynx embedding setup, custom container integration, native capability registration, platform config
- `android/`
  - Android host app, Lynx embedding setup, custom container integration, native capability registration, platform config
- `resource/`
  - shared app resources wired through `lynx.config.ts`
- `lynx.config.ts`
  - Rspeedy app configuration, page routing, asset copy paths, and platform identifiers
- `docs/`
  - architecture notes, runtime guidance, integration plans, capability status and decisions
- `scripts/`
  - repo automation, local tooling scripts, validation helpers

Do not document or recreate a nonexistent `apps/lynx-mobile` + `host/*` split. The repo follows a standard Lynx scaffold layout at the repo root. If a dedicated transport layer or shared package becomes necessary later, add it intentionally instead of pre-creating package boundaries before they are needed.

Names can be adjusted later, but separation of concern must stay clear: Lynx UI code and host native code must not blur together.

## Source and Reference Priority

When answering or implementing, prefer references in this order:

1. <https://lynxjs.org/llms.txt>
2. specific official Lynx docs linked from there
3. `docs/lynx-vs-web.md`
4. `docs/opencode-mobile-client-reference.md` for OpenCode client behavior
5. `lynx-family/lynx-examples`
6. Lynx source repositories under `lynx-family`

## Keep Shared Guidance Docs Aligned

When project understanding changes, update these together when relevant:

- `docs/lynx-vs-web.md`
- `docs/opencode-mobile-client-reference.md`
- `README.md`
- `AGENTS.md`

Do not update only one file when a cross-cutting assumption changes.

## What Good Agent Output Looks Like Here

Good output in this repository should:

- explain Lynx differences from web assumptions clearly
- call out thread-model implications early
- distinguish Lynx framework behavior from host or container behavior
- state whether a capability is existing or planned
- point to official docs and examples
- avoid inventing unsupported platform behavior

## Quick Links

- Official Lynx `llms.txt`: <https://lynxjs.org/llms.txt>
- Official Lynx docs home: <https://lynxjs.org/>
- Official ReactLynx intro: <https://lynxjs.org/react/introduction.md>
- Thinking in ReactLynx: <https://lynxjs.org/react/thinking-in-reactlynx.md>
- Rendering lifecycle: <https://lynxjs.org/react/lifecycle.md>
- Main thread script: <https://lynxjs.org/react/main-thread-script.md>
- Built-in elements: <https://lynxjs.org/api/elements/built-in/>
- Compatibility: <https://lynxjs.org/guide/compatibility.md>
- Official Lynx agent guidance: <https://lynxjs.org/next/ai/agentsmd.html>
- Local guide: `./docs/lynx-vs-web.md`
- OpenCode mobile reference: `./docs/opencode-mobile-client-reference.md`
- Multi-backend client plan: `./docs/multi-backend-client-plan.md` — selectable backend kinds: `opencode`, `codex` (Claude planned)
- Backend channel bridge contract: `./docs/network-bridge-api-spec.md`
