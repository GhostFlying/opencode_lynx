#!/usr/bin/env bash
# Runs the Android instrumented test gate with a host-side OpenCode fixture.
# The workflow invokes this through the emulator-runner action; keeping the
# orchestration in bash preserves Gradle's exit status while still collecting
# useful logs on failure.

set -o pipefail

if [ -n "${GITHUB_WORKSPACE:-}" ]; then
  cd "$GITHUB_WORKSPACE"
fi

mkdir -p .ci-logs

STUB_SERVER_PID=
LOGCAT_PID=

cleanup() {
  if [ -n "${LOGCAT_PID}" ]; then
    kill "${LOGCAT_PID}" 2>/dev/null || true
    wait "${LOGCAT_PID}" 2>/dev/null || true
    LOGCAT_PID=
  fi

  if [ -n "${STUB_SERVER_PID}" ]; then
    kill "${STUB_SERVER_PID}" 2>/dev/null || true
    wait "${STUB_SERVER_PID}" 2>/dev/null || true
    STUB_SERVER_PID=
  fi
}

trap cleanup EXIT

adb logcat -c || true
adb logcat -v threadtime > .ci-logs/logcat-live.txt 2>&1 &
LOGCAT_PID=$!

node scripts/ci/stub-opencode-server.mjs > .ci-logs/stub-server.log 2>&1 &
STUB_SERVER_PID=$!

stub_ready=0
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:3000/session >/dev/null 2>&1; then
    stub_ready=1
    echo "stub OpenCode server ready at http://127.0.0.1:3000/session"
    break
  fi
  if ! kill -0 "${STUB_SERVER_PID}" 2>/dev/null; then
    echo "stub OpenCode server exited before becoming ready"
    break
  fi
  sleep 1
done

if [ "${stub_ready}" -eq 1 ]; then
  ./android/gradlew -p android -PincludeX86ForCI \
    -Pandroid.testInstrumentationRunnerArguments.opencodelynx_stub_base_url=http://10.0.2.2:3000 \
    -Pandroid.testInstrumentationRunnerArguments.opencodelynx_require_stub_server=true \
    :app:connectedDebugAndroidTest 2>&1 \
    | tee .ci-logs/android-instrumented-tests.log
  gradle_exit=${PIPESTATUS[0]}
else
  gradle_exit=1
  {
    echo "stub OpenCode server did not become ready at http://127.0.0.1:3000/session"
    echo "--- .ci-logs/stub-server.log ---"
    tail -200 .ci-logs/stub-server.log 2>/dev/null || true
  } | tee .ci-logs/android-instrumented-tests.log
fi

cleanup

timeout 30 adb logcat -d -v threadtime \
    -s SplashActivity lynx TestRunner OpenCodeApplication AndroidRuntime System.err ActivityManager \
  > .ci-logs/logcat-filtered.txt 2>&1 || echo "logcat-filtered dump exit $?" >> .ci-logs/logcat-filtered.txt
timeout 10 adb devices -l > .ci-logs/adb-devices-final.txt 2>&1 || true
timeout 10 adb get-state >> .ci-logs/adb-devices-final.txt 2>&1 || true

if [ -d android/app/build/outputs/androidTest-results/connected ]; then
  cp -r android/app/build/outputs/androidTest-results/connected \
    .ci-logs/android-test-results || true
fi

echo "--- .ci-logs/ contents at script end ---"
ls -la .ci-logs/ || true

exit "${gradle_exit}"
