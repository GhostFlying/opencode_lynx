# local-gate WIP

`local-gate` is a maintainer-only experimental WIP tool for orchestrating repo-owned native smoke commands.

It is kept in the repository because it is still useful for maintainers working on native smoke coverage, but it is not part of the public contribution contract.

## Status

- maintainer-only
- experimental / WIP
- smoke-only orchestration today
- not a public OSS workflow requirement
- not guaranteed to be stable or reproducible across machines

## Current entrypoints

- `scripts/local-gate --mode changed|full --base <git-ref> --platform auto|ios|android|both`
- `pnpm run gate:daily-full`

`gate:daily-full` currently delegates to:

```bash
scripts/local-gate --mode full --platform both
```

## Current stage map

- `ios`
  - `gate:ios-deeplink-smoke`
  - `gate:ios-smoke`
- `android`
  - `gate:android-deeplink-smoke`
  - `gate:android-smoke`
- `both`
  - iOS deeplink smoke
  - iOS smoke
  - Android deeplink smoke
  - Android smoke

The runner lives in `scripts/local-gate-lib/runner.mjs`.

## Maintainer usage boundaries

Use `local-gate` when you want one command to orchestrate repo-owned native smoke checks during maintainer work.

Do not use `local-gate` as:

- a replacement for `pnpm run test:ci`
- a replacement for `pnpm build`
- a public contribution requirement
- a stable CI contract

Public OSS validation should stay on:

```bash
pnpm run test:ci
pnpm build
```

Optional smoke validation can be run directly via the relevant `gate:*` scripts.

## Known limitations

- depends on `node`, `pnpm`, and `git` being on `PATH`
- depends on local simulator / emulator / host tooling state
- uses conservative changed-file classification and often falls back to `both`
- writes artifacts under `.sisyphus/evidence/local-gate/`
- success is based on stage exit codes only

## Not implemented

The following are intentionally **not** part of the current `local-gate` contract:

- diagnostics stages
- warning budget enforcement
- bypass governance
- scheduler governance
- stable CI promotion rules
- cross-machine reproducibility guarantees

If any of those are added later, document them explicitly as planned or implemented behavior instead of treating them as already-shipped contract.
