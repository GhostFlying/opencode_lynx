#!/usr/bin/env bash
# Runs the required Android instrumented gate.
#
# Keep this focused on the dedicated qa-test bundle deeplink/navigation smoke
# path. Broader server-backed main-bundle flows are useful as optional coverage,
# but they should not make this required CI job depend on production UI content.

set -o pipefail

if [ -n "${GITHUB_WORKSPACE:-}" ]; then
  cd "$GITHUB_WORKSPACE"
fi

mkdir -p .ci-logs

LOGCAT_PID=

cleanup() {
  if [ -n "${LOGCAT_PID}" ]; then
    kill "${LOGCAT_PID}" 2>/dev/null || true
    wait "${LOGCAT_PID}" 2>/dev/null || true
    LOGCAT_PID=
  fi
}

trap cleanup EXIT

adb logcat -c || true
adb logcat -v threadtime > .ci-logs/logcat-live.txt 2>&1 &
LOGCAT_PID=$!

bash scripts/ci/run-android-deeplink-smoke.sh -PincludeX86ForCI 2>&1 \
  | tee .ci-logs/android-instrumented-tests.log
gradle_exit=${PIPESTATUS[0]}

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
