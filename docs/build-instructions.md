# Build Instructions

This document is the project-wide build and run guide for this repository.

The repository uses a Lynx app scaffold with a custom container layer. Lynx / ReactLynx app code, Android host code, and iOS host code all build from the repository root.

## Scope

- Lynx / ReactLynx app code lives under `./src`
- Android host code lives under `./android`
- iOS host code lives under `./ios`
- package management and app scripts live in the root `./package.json`
- build, test, and platform run commands should be executed from the repository root

## Core rules

1. Before running project commands, initialize a Python virtual environment with `uv venv`.
2. Use `pnpm` as the default package manager from the repository root.
3. Before running build, test, or platform run commands, run `pnpm install` from the repository root.
4. Do not assume dependencies or host-side tooling already exist in a fresh checkout.
5. Use Node.js `^22 || ^24` to match the root `package.json`.

## Environment preparation

From the repository root:

```bash
uv venv
uv pip install fb-idb  # optional, only when simulator automation needs idb
pnpm install
```

## Quick start

For a normal validation pass from the repository root:

```bash
uv venv
pnpm install
pnpm run test:ci
pnpm build
```

For the OpenCode backend-facade production page migration, also run the
server-backed iOS and Android UI flows against the CI stub server. These are
the acceptance gates for confirming that saved connections, session routing,
message loading, and route params still work through the facade.

## Common commands

Run these after `uv venv` and `pnpm install`:

```bash
pnpm test
pnpm run test:ci
pnpm build
pnpm run:ios
pnpm run:android
```

Optional native smoke commands:

```bash
pnpm run gate:ios-deeplink-smoke
pnpm run gate:ios-smoke
pnpm run gate:android-deeplink-smoke
pnpm run gate:android-smoke
```

Use those optional smoke commands when a change affects native host behavior, startup routing, or deeplink handling.
The required iOS and Android deeplink smoke paths launch the dedicated
`qa-test.lynx.bundle` so they can verify startup routing and second-page
navigation without coupling those assertions to the production
`main.lynx.bundle` UI. `gate:android-smoke` runs broader Android
instrumentation coverage and is useful as an optional local check when you are
intentionally validating production main-flow behavior.

## Maintainer-only local-gate note

The repository still contains `scripts/local-gate`, but it is a maintainer-only experimental WIP smoke orchestrator.

It is not part of the public contribution contract, and it does not currently implement governance, warning-budget, or diagnostics workflows.

For current usage, limits, and stage map details, see `./development/local-gate-wip.md`.

## Ruby and CocoaPods

The repository pins a preferred Ruby version in `./.ruby-version`.

If iOS commands fail because the current Ruby version does not satisfy project requirements:

1. ask whether to resolve it with `rbenv`
2. if approved, install `rbenv` and `ruby-build`
3. install the version from `./.ruby-version`
4. run `rbenv local <version>`
5. verify with `ruby -v`

Typical setup flow after approval:

```bash
brew install rbenv ruby-build
rbenv install 3.2.10
rbenv local 3.2.10
ruby -v
```

## Validation environment troubleshooting

### Quick preflight checklist

Before spending time on a failing validation run, check these first from the repository root:

```bash
uv venv
pnpm install
node -v
xcrun simctl list devices booted
ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
"$ANDROID_HOME/platform-tools/adb" start-server
"$ANDROID_HOME/platform-tools/adb" devices -l
"$ANDROID_HOME/emulator/emulator" -list-avds
```

If any of those fail, fix the environment first instead of debugging app logic.

### Node.js engine mismatch (`^22 || ^24` required)

Observed symptom in this repo:

- `pnpm test`, `pnpm run test:ci`, or targeted Vitest runs fail under Node `v18.x`
- error text includes:

```txt
The requested module 'node:util' does not provide an export named 'styleText'
```

Recommended fix:

1. switch your active Node version to `22.x` or `24.x`
2. rerun `pnpm install`
3. retry the test/build command

### iOS smoke verification: rebuild bundle assets before `xcodebuild`

If you changed files under `src/**`, rebuild the Lynx bundles before rerunning iOS smoke:

```bash
pnpm build
pnpm run gate:ios-smoke
```

Do not skip the build step before iOS smoke when page content changed.

### iOS server-backed main flow

The OpenCode facade page migration requires the iOS server-backed main flow to
run with a live CI fixture server. A missing fixture server is a failure for
this acceptance path, not a skip:

```bash
uv venv
pnpm install
pnpm build
mkdir -p .ci-logs
node scripts/ci/stub-opencode-server.mjs > .ci-logs/stub-server.log 2>&1 &
STUB_SERVER_PID=$!
trap 'kill "$STUB_SERVER_PID" 2>/dev/null || true; wait "$STUB_SERVER_PID" 2>/dev/null || true' EXIT
until curl -fsS http://127.0.0.1:3000/session >/dev/null; do sleep 1; done
xcodebuild test \
  -workspace ios/OpenCodeLynx.xcworkspace \
  -scheme OpenCodeLynxUITests \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  '-only-testing:OpenCodeLynxUITests/OpenCodeLynxUITests/testMainFlowOpensChatWithSavedConnectionAndRouteParams'
```

### `pnpm run:ios-device` — deploy to a real iPhone

Frequent on-device dev iteration uses `pnpm run:ios-device`, which builds Lynx
bundles, signs the Xcode app for a real device, installs via `devicectl`,
and launches.

One-time setup:

1. Open Xcode → **Settings → Accounts** and sign in with the Apple ID that
   owns your `IOS_DEVELOPMENT_TEAM` (paid or free both work; free has 7-day
   resigning, max 3 sideloaded apps, 100 device registrations / year).
2. Connect the device via USB, trust this Mac on the device, and optionally
   enable **Window → Devices and Simulators → Connect via network** for
   wireless redeploys.
3. Copy `.env.ios.local.example` to `.env.ios.local` and fill in:
   ```sh
   cp .env.ios.local.example .env.ios.local
   $EDITOR .env.ios.local
   ```
   - `IOS_DEVICE_UDID` — get from `xcrun xctrace list devices`
   - `IOS_DEVELOPMENT_TEAM` — 10-char Team ID (the OU= field of the
     development certificate, **not** the cert UID printed by
     `security find-identity`)

Day-to-day:

```sh
pnpm run:ios-device
```

Optional speed-ups for tight iteration loops:

```sh
IOS_SKIP_POD_INSTALL=1 pnpm run:ios-device     # skip pod install
IOS_SKIP_LYNX_BUILD=1 pnpm run:ios-device      # native-only iteration
```

If `xcodebuild` complains that no provisioning profile matches, the most
common cause is the Apple ID is not signed in to Xcode (the CLI cannot
inject accounts; it only signs). The first build also auto-registers the
device under your team — that requires `-allowProvisioningUpdates`, which
the script already sets.

### `pnpm run:ios` strict launch verification

This repository wraps the iOS build with a strict verification step in `scripts/run-ios-strict.mjs`.

Current behavior:

1. build Lynx bundles via `pnpm build`
2. run `pod install`
3. build the Xcode project via `xcodebuild`
4. find or boot a simulator
5. install and launch the app via `xcrun simctl`
6. return non-zero if launch verification fails

If `pnpm run:ios` fails after build, check these first:

- a simulator is booted
- the built app is installed in that simulator
- the effective iOS bundle identifier matches the Xcode target value

Useful manual checks:

```bash
xcrun simctl list devices booted
xcrun simctl listapps booted | grep -n "OpenCodeLynx"
```

### iOS simulator and `xcodebuild` notes

Useful preflight:

```bash
xcodebuild -showdestinations -workspace ios/OpenCodeLynx.xcworkspace -scheme OpenCodeLynxUITests
xcrun simctl list devices booted
```

What has been useful in this repo:

- check simulator boot state before blaming app code
- prefer an explicit simulator destination string such as `platform=iOS Simulator,name=iPhone 16`
- `xcodebuild` logs are noisy and often include unrelated Pod deployment-target warnings
- use the targeted test-case lines and final `** TEST SUCCEEDED **` / `** TEST FAILED **` markers as authoritative pass/fail signals

### Android SDK discovery and emulator preflight

This repo cannot assume Android tools are already on `PATH`.

Use `ANDROID_HOME` first:

```bash
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$ANDROID_HOME/platform-tools:$PATH"
"$ANDROID_HOME/emulator/emulator" -list-avds
"$ANDROID_HOME/platform-tools/adb" start-server
"$ANDROID_HOME/platform-tools/adb" devices -l
```

If no device is connected, launch the known AVD and wait for it:

```bash
"$ANDROID_HOME/emulator/emulator" -avd opencode_api34 -no-snapshot-load -netdelay none -netspeed full
"$ANDROID_HOME/platform-tools/adb" wait-for-device
"$ANDROID_HOME/platform-tools/adb" devices -l
```

### Android smoke command order

For smoke changes that touch Lynx pages or native Android test code, this order is the most reliable:

```bash
uv venv
pnpm install
pnpm build
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
"$ANDROID_HOME/platform-tools/adb" start-server
"$ANDROID_HOME/platform-tools/adb" wait-for-device
pnpm run gate:android-deeplink-smoke
```

Run `pnpm run gate:android-smoke` separately when you intentionally want the
broader Android instrumentation class, including server-backed production
main-flow coverage.

### Android server-backed UI tests

The Android server-backed UI flow uses the CI OpenCode fixture server from the host machine.
Start it on the host loopback address, wait for `/session`, and pass the Android emulator
host alias (`10.0.2.2`) into the instrumentation runner:

```bash
uv venv
pnpm install
pnpm build
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
"$ANDROID_HOME/platform-tools/adb" start-server
"$ANDROID_HOME/platform-tools/adb" wait-for-device
mkdir -p .ci-logs
node scripts/ci/stub-opencode-server.mjs > .ci-logs/stub-server.log 2>&1 &
STUB_SERVER_PID=$!
trap 'kill "$STUB_SERVER_PID" 2>/dev/null || true; wait "$STUB_SERVER_PID" 2>/dev/null || true' EXIT
until curl -fsS http://127.0.0.1:3000/session >/dev/null; do sleep 1; done
./android/gradlew -p android -PincludeX86ForCI \
  -Pandroid.testInstrumentationRunnerArguments.opencodelynx_stub_base_url=http://10.0.2.2:3000 \
  -Pandroid.testInstrumentationRunnerArguments.opencodelynx_require_stub_server=true \
  :app:connectedDebugAndroidTest
```

Use `127.0.0.1:3000` for host-side readiness checks. Inside the Android emulator,
`127.0.0.1` is the emulator itself, so the app/test runner must use
`http://10.0.2.2:3000` to reach the host fixture server. The iOS Simulator can
use host `127.0.0.1` directly. The Android debug manifest permits cleartext
HTTP so this local fixture path works without changing release-network policy.
Keep the fixture process running for the whole instrumented test: the app also
opens `/global/event` as a server-sent events stream after the saved connection
loads.

### LSP and tooling gaps

These are known environment limitations, not necessarily code defects:

- JSON LSP diagnostics may be unavailable because `biome` is not installed
- Markdown LSP diagnostics are not configured in this workspace
- Kotlin LSP may time out during initialization
- Swift LSP may report module-import failures even when `xcodebuild` succeeds

Practical rule:

- when LSP is unavailable, use the platform-native verifier for the affected area instead of assuming the file is broken

## Recommended verification order

When validating project changes:

1. `uv venv`
2. `pnpm install`
3. `pnpm run test:ci`
4. `pnpm build`
5. if native behavior changed, run the relevant optional smoke commands

## Mock WebSocket echo for `backend.channel.*`

The `backend.channel.*` native bridge exposes a WebSocket to Lynx JS for the
Codex backend. To smoke-test the bridge end-to-end against a real socket,
boot the local echo server:

```
pnpm mock:ws-echo --port 7777
```

The server accepts every text frame and echoes it back. Reach it from each
platform:

- **iOS Simulator** — dial `ws://127.0.0.1:7777` directly (loopback works
  out of the box).
- **Android Emulator** — first run `adb reverse tcp:7777 tcp:7777`, then
  dial `ws://127.0.0.1:7777`. (The reverse mapping forwards the
  emulator's loopback to the host.)

This is a **frame echo**, not a Codex protocol mock — Codex JSON-RPC
fixtures arrive in Phase 2.

## Common mistakes to avoid

- running project commands before `uv venv`
- running tests or builds before `pnpm install`
- mixing package managers casually in the same scaffold
- running app commands from anywhere other than the repository root
- assuming copied native assets are already up to date without rebuilding
- trying to resolve Ruby version mismatches ad hoc instead of checking `./.ruby-version`

## Related docs

- `./contribution-guide.md`
- `./lynx-vs-web.md`
- `./opencode-mobile-client-reference.md`
- `./development/local-gate-wip.md`
- `../AGENTS.md`
