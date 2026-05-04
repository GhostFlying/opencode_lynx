# Followup — Chat Selection Initialization Gating

Status: **deferred from PR #11** (Codex Phase 3). Captured here for a
future focused PR.

## Problem

`src/pages/chat/App.tsx` seeds its `selection` state from a hardcoded
constant on mount:

```ts
const FALLBACK_SELECTION: ChatSelection = {
  agent: 'build',
  providerID: 'anthropic',
  modelID: 'claude-sonnet-4-20250514',
  variant: null,
}
```

The catalog (`client.catalog.providers()`) and stored-selection lookup
both fetch asynchronously. Until one of them resolves and applies a
real selection, the page is rendering with the fallback values. If the
user types and hits send before that, the prompt payload carries the
hardcoded `anthropic / claude-sonnet-4-20250514` model id.

## Affected backends

This is **not Codex-specific**, but visibility differs:

| Backend | Behavior today |
|---|---|
| OpenCode (anthropic / claude-sonnet config) | Usually masked because the fallback happens to match the most common deployment. Latent bug. |
| OpenCode (other providers / models / dated id no longer offered) | First send rejected by server with provider-or-model-not-found. Recovers after user picks something in the model picker. |
| OpenCode (catalog fetch fails) | Silent (`catch {}` in the catalog effect). Selection stays at fallback; first send may be rejected. |
| Codex | 100% reproducible on a fresh session — Codex has no `anthropic` provider. Flagged as P1 by the Codex bot review of PR #11. |

## Why deferred

PR #11 originally landed a targeted patch that omitted the `model`
field from the payload while the selection was uninitialized, letting
the backend pick its own default. On further review the user pointed
out a more correct UX:

1. Don't let the user send before the selection is real.
2. Surface catalog-fetch failures so the user understands why the
   composer is disabled.
3. Display a placeholder model label (e.g. `Loading…`) instead of the
   misleading `claude-sonnet-4-20250514` fallback.

These changes also fix the latent OpenCode case, which is broader than
the Codex review's scope. Splitting it out into a focused PR avoids
expanding the review surface of PR #11 and lets the OpenCode-impacting
behavior change ship with its own test plan.

The targeted "omit model" patch was reverted on `feat/codex-backend-phase-3`
(commit `2067982`).

## Implementation sketch

In `src/pages/chat/App.tsx`:

1. Add `[selectionReady, setSelectionReady] = useState(false)`. Mirror
   it next to every site that flips `selectionInitializedRef.current`
   to `true` (search the file — there are four: storage hydration,
   message-inferred selection, catalog default seeding, and the
   fixture/dev branch).

2. Pass `disabled={sending || !selectionReady}` to `<ChatInput>`.

3. Compute the model label conditionally so the picker never shows
   the fallback id:
   ```ts
   const modelLabel = selectionReady
     ? deriveModelLabel(selection, providersCatalog)
     : 'Loading…'
   ```

4. Replace the silent `catch {}` in the catalog-loading effect:
   ```ts
   } catch (err) {
     if (cancelled) return
     // Only surface when the user is actually stuck. If storage
     // already hydrated a selection, catalog failure is non-fatal —
     // the picker just shows an empty list and stored selection is
     // honored.
     if (!selectionInitializedRef.current) {
       const message = err instanceof Error && err.message.trim().length > 0
         ? `Failed to load model catalog: ${err.message}`
         : 'Failed to load model catalog.'
       setError(message)
     }
   }
   ```
   Optional follow-up: a Retry affordance next to the error.

## Test plan

Extend `src/pages/chat/__tests__/App.test.tsx`:

- **Codex new-session, catalog pending** — `catalog.providers()` returns
  a Promise that never resolves. Assert composer renders disabled and
  `prompt()` is never called even after a tap event.
- **Codex new-session, catalog resolves** — happy path; composer enables
  once catalog seeds the selection.
- **Catalog rejects** — assert the user-visible error message is set and
  `prompt()` is never called.
- **Existing-session with stored selection** — composer enables
  immediately (storage path sets `selectionReady` before catalog
  resolves).
- **OpenCode happy path unchanged** — existing test should still pass
  without modification because it already waits on `catalog.agents` /
  `catalog.providers` before tapping the composer.

## Out of scope

- Allowing send with a "last-used selection" cached across launches —
  would need persistent storage extensions and a UX decision about
  whether to surface "using your last model" affordance.
- Changing `FALLBACK_SELECTION` to a per-backend default — partial fix
  that still races on slow catalog and doesn't address fetch failures.

## Acceptance criteria

- A fresh new-session against any backend (especially Codex) cannot
  send before catalog or stored selection seeds the selection state.
- Catalog fetch failures are visible to the user.
- Existing tests continue to pass with the same assertions; new tests
  cover the gating behavior.
