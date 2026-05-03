# Codex Backend Smoke Recipe

This is the manual review-time recipe for validating the Codex backend
end-to-end on a real device/simulator. The Lynx bundle and native
containers are already built and verified by the M3.5 automated steps;
this doc covers the interactive UI flow that requires a human in front
of the device.

Two levels of validation are described:

- **Gate A (mock server)** — drives the app against
  `scripts/mock-codex-server.mjs`. This is the standard smoke. Does not
  require the real codex CLI.
- **Gate B (real codex CLI)** — optional. Drives the app against
  `codex app-server --listen ws://...`. Catches wire-shape regressions
  the in-process mock cannot.

## 1. Pre-reqs

- `pnpm install` has been run at repo root.
- Lynx bundles built: `pnpm build` (already done if M3.5 automation
  was run; otherwise run it now).
- iOS: a booted simulator (Xcode → Simulator → device) — confirm with
  `xcrun simctl list devices booted`.
- Android: an emulator started in Android Studio AVD or
  `adb devices` shows at least one emulator/device.
- For Gate B only: `codex --version` confirms the CLI is on PATH (the
  v0.125.0+ subcommand `codex app-server` is required).

## 2. Boot the mock server (Gate A)

From a dedicated terminal at repo root:

```sh
pnpm mock:codex-server --port 7777 --scenario approvals
```

Scenarios:

- `approvals` — round-trips one `commandExecution/requestApproval`
  request from the server. The user is expected to tap "Accept" in the
  app; the mock then logs the JSON-RPC response.
- `tools` — exercises the tool-call streaming surface
  (`item.collabAgentToolCall`, function-call deltas).
- `happy-path` — minimum flow: `turn/started` → assistant message
  delta → `turn/completed`. No approvals, no tools.

Leave the terminal in the foreground so you can watch the JSON-RPC
traffic. The mock prints every inbound and outbound frame.

## 3. iOS simulator flow

In a second terminal:

```sh
pnpm run:ios
```

Notes:

- The runner (`scripts/run-ios-strict.mjs`) currently has a regex bug
  (see `MEMORY.md`) that misreads the `<UDID>) (Booted)` form of
  `simctl list devices booted` as "no booted simulator". If it complains
  about not finding a simulator and the destination "iPhone 16" cannot
  be matched, run the explicit pipeline instead:

  ```sh
  pnpm build
  xcodebuild build \
    -workspace ios/OpenCodeLynx.xcworkspace \
    -scheme OpenCodeLynx \
    -destination "platform=iOS Simulator,id=<BOOTED_UDID>" \
    -configuration Debug -quiet
  APP=$(find ~/Library/Developer/Xcode/DerivedData -type d \
    -name OpenCodeLynx.app -path "*/Debug-iphonesimulator/*" | head -1)
  xcrun simctl install <BOOTED_UDID> "$APP"
  xcrun simctl launch <BOOTED_UDID> dev.opencode.lynx.app
  ```

  Get the booted UDID from `xcrun simctl list devices booted`.

In the launched app:

1. On the connection form, tap the **Codex** pill. The form should
   re-render with Codex-only fields (host, port, secure, optional
   bearer token).
2. Enter:
   - **Host**: `127.0.0.1`
   - **Port**: `7777`
   - **Token**: leave empty (mock does not require auth)
   - **Secure**: off (mock listens plain `ws://`)
3. Tap **Connect**. Expect the session list page to load.
4. Tap **+** to start a new session. Send any prompt, e.g.
   "hello codex".
5. Expect:
   - Streaming assistant text in the message column.
   - With `--scenario approvals`, an approval card appears mid-stream.
     Tap **Accept**.
6. Watch the mock terminal: it should log the inbound `turn/start`
   from the device, the streamed notifications it emitted, and (for
   approvals) the JSON-RPC response with
   `{ result: { decision: 'accept' } }`.

## 4. Android emulator flow

Mock binds to host `127.0.0.1`. The emulator's loopback is its own,
so first reverse-forward the host port into the emulator:

```sh
adb reverse tcp:7777 tcp:7777
```

Then build/install/launch:

```sh
pnpm run:android
```

In the app, the form sequence is identical to iOS. With `adb reverse`
in place, the emulator can use `127.0.0.1:7777` directly.

## 5. Log capture (debugging only)

If the flow misbehaves, capture device logs:

- iOS:
  ```sh
  xcrun simctl spawn booted log stream \
    --predicate 'process == "OpenCodeLynx"' --level debug
  ```
- Android:
  ```sh
  adb logcat | grep -i 'opencode\|backend\.'
  ```

Key signals to look for in the mock terminal:

- `initialize` from device → response with `userAgent` etc.
- `initialized` notification (no response).
- `model/list` → response with `data: [...]`.
- `thread/start` → response with `result.thread.id`.
- `turn/start` → response with `turn.id`, then a stream of
  `turn/started`, `item/started`, `item/updated`, `item/completed`,
  `turn/completed` notifications.
- For approvals: `item/commandExecution/requestApproval` server
  request, then a JSON-RPC response from the app with `decision`.

## 6. Gate B — real codex CLI (optional, deferred)

Gate B verifies that the wire shapes the in-process fixture models
match the real `codex app-server` behavior.

Loopback (no auth):

```sh
codex app-server --listen ws://127.0.0.1:7777
```

For non-loopback (e.g. the simulator binding to a LAN IP, or another
machine), use `--ws-auth capability-token`:

```sh
codex app-server \
  --listen ws://0.0.0.0:7777 \
  --ws-auth capability-token=/path/to/token-file
```

Then either provide the token in the app's bearer-token field, or use
`--ws-auth signed-bearer-token=<secret>` and provide the matching JWT
in the app form. (Real codex on loopback explicitly does not require a
token, so for the standard simulator/emulator-on-localhost case you
can skip auth.)

The interactive flow is identical to Gate A. If wire shapes diverge
(unexpected error frames, missing fields, different notification
names), capture both the mock fixture's expected frame and the real
server's frame, and feed the diff back into
`src/backends/codex/__tests__/mock-server/fixture.mjs` so the
in-process mock and the real server agree.

## 7. Cleanup

- iOS: `xcrun simctl terminate <UDID> dev.opencode.lynx.app`
- Android: stop the app from the launcher (or `adb shell am force-stop
  dev.opencode.lynx.app`)
- Mock server: Ctrl-C in its terminal. The runner handles SIGINT/SIGTERM
  with a clean shutdown line in its log.
