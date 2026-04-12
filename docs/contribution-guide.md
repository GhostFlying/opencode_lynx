# Contribution Guide

This document defines the local contribution rules for this repository.

It focuses on contribution policy and commit conventions. For environment setup, install, test, build, and run commands, use `./build-instructions.md`.

## Read this when

- you are preparing commits
- you are reviewing contribution workflow
- you are updating repository process docs

## Commit message policy

All commit titles must use a typed prefix and a lowercase title.

Required format:

```txt
type: lowercase summary
```

Examples:

```txt
feat: add session list page scaffold
fix: correct navigation scheme handling
optimize: reduce unnecessary rerenders in message list
docs: update build instructions
test: add app render coverage for main page
refactor: split opencode client state helpers
chore: refresh generated autolink metadata
```

## Rules for commit titles

1. Start with a category prefix such as `feat:`, `fix:`, or `optimize:`.
2. The title after the prefix must be lowercase.
3. Keep the title concise and specific.
4. Prefer describing the user-visible or repository-level intent, not a vague file list.

## Recommended commit types

- `feat:` for new features
- `fix:` for bug fixes
- `optimize:` for performance improvements
- `docs:` for documentation-only changes
- `test:` for test changes
- `refactor:` for structural code changes without feature behavior changes
- `chore:` for maintenance, tooling, or generated-file updates

## Contribution workflow

When your change is ready:

1. check whether related documentation exists in the same directory as the code you changed and under `./docs/`
2. if the change affects documented behavior, structure, constraints, workflow, or usage, update that documentation in the same change
3. run the public repo validation commands:
   - `pnpm run test:ci`
   - `pnpm build`
4. if your change affects iOS or Android host behavior, startup routing, or deeplink flows, run one or more optional platform smoke commands:
   - `pnpm run gate:ios-deeplink-smoke`
   - `pnpm run gate:ios-smoke`
   - `pnpm run gate:android-deeplink-smoke`
   - `pnpm run gate:android-smoke`
5. use a typed lowercase commit title
6. keep commit scope focused and reviewable

## Maintainer-only tooling

The repository still contains `scripts/local-gate`, but it is a maintainer-only experimental tool and not part of the public contribution contract.

For current maintainer usage and limitations, see `./development/local-gate-wip.md`.

For project build validation and command ordering, see `./build-instructions.md`.

## Related docs

- `./build-instructions.md`
- `./lynx-vs-web.md`
- `./development/local-gate-wip.md`
- `../AGENTS.md`
