# opencode_lynx

Workspace for building a Lynx mobile client for AI coding-agent backends, targeting iOS and Android. Currently supports two selectable backend kinds:

- **OpenCode** — REST + SSE (and optional PTY WebSocket)
- **Codex** — `codex app-server` JSON-RPC 2.0 over WebSocket
- *Claude Code* — declared but not yet implemented

## Project goal

Build a production-oriented mobile client that connects to a remote backend and supports:

- session list and session management
- prompt submission and streamed assistant output
- real-time status and message updates
- approval round-trips (Codex)
- optional terminal-style features when needed

> **Note:** Lynx is a non-web runtime with a dual-thread model. See [AGENTS.md](./AGENTS.md) for runtime warnings and architecture rules before contributing.

> **Status:** Work in progress. The app scaffold, native bridge, and core UI flows are functional on iOS and Android simulators, but the project is not yet production-ready or publicly released.

## Repository layout

```txt
src/                       # Lynx / ReactLynx pages, assets, and app tests
android/                   # Android host project
ios/                       # iOS host project
resource/                  # Shared app resources configured via lynx.config.ts
lynx.config.ts             # Rspeedy app configuration
package.json               # Build scripts and JS dependencies
docs/                      # Architecture notes, platform constraints, API references
scripts/                   # Repository tooling and validation helpers
```

## Quick start

```bash
uv venv               # initialize Python environment
pnpm install           # install dependencies
pnpm test              # run tests
pnpm build             # build Lynx bundles
pnpm run:ios           # build and run on iOS simulator
pnpm run:android       # build and run on Android
```

See [docs/build-instructions.md](./docs/build-instructions.md) for the full workflow.

## Documentation

| Doc | Purpose |
|-----|---------|
| [AGENTS.md](./AGENTS.md) | **Start here for development** — required reading order, runtime warnings, architecture rules |
| [docs/lynx-vs-web.md](./docs/lynx-vs-web.md) | Lynx runtime model vs web assumptions |
| [docs/opencode-mobile-client-reference.md](./docs/opencode-mobile-client-reference.md) | OpenCode API scope and transport model |
| [docs/multi-backend-client-plan.md](./docs/multi-backend-client-plan.md) | Provider-neutral backend architecture for OpenCode / Codex / Claude |
| [docs/codex-smoke-recipe.md](./docs/codex-smoke-recipe.md) | Manual end-to-end smoke recipe for the Codex backend (mock + real CLI) |
| [docs/build-instructions.md](./docs/build-instructions.md) | Full build, test, and run workflow |
| [docs/network-bridge-api-spec.md](./docs/network-bridge-api-spec.md) | Native bridge method API specification |
| [docs/contribution-guide.md](./docs/contribution-guide.md) | Contribution workflow and style requirements |

## License

Apache-2.0 — see [LICENSE](./LICENSE).
