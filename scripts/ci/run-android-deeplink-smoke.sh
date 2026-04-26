#!/usr/bin/env bash
# Runs Android deeplink smoke tests one instrumentation method at a time.
# Separate invocations keep startup override state isolated and make "0 tests"
# failures point at the exact method selector that went stale.
# Extra arguments are passed through to Gradle, for example CI's
# -PincludeX86ForCI flag for the x86_64 emulator image.

set -eo pipefail

TEST_CLASS="com.opencode.lynx.ExampleInstrumentedTest"
GRADLE_EXTRA_ARGS=("$@")
TEST_METHODS=(
  "testDeeplinkColdStartAcceptedTargetConsumesAndTransitions"
  "testDeeplinkLauncherIntentFallsBackToDefaultMainWithoutConsume"
  "testDeeplinkInvalidTargetFailsClosedToDefaultMain"
  "testDeeplinkConsumeOnceReroutesToDefaultMainOnRelaunch"
  "testDeeplinkChatRouteParamsPopulateTitleAndSessionID"
)

run_gradle_for_method() {
  local method_name="$1"
  shift

  ./android/gradlew -p android "${GRADLE_EXTRA_ARGS[@]}" :app:connectedDebugAndroidTest "$@" \
    -Pandroid.testInstrumentationRunnerArguments.class="${TEST_CLASS}#${method_name}"
}

run_method_with_retries() {
  local method_name="$1"
  local tmp
  tmp=$(mktemp)

  set +e
  run_gradle_for_method "${method_name}" 2>&1 | tee "${tmp}"
  local status=${PIPESTATUS[0]}

  if [ "${status}" -ne 0 ] && grep -q "AndroidTestDeviceInfoPlugin" "${tmp}" && grep -q "meminfo" "${tmp}"; then
    : > "${tmp}"
    run_gradle_for_method "${method_name}" -Pandroid.experimental.androidTest.useUnifiedTestPlatform=false 2>&1 | tee "${tmp}"
    status=${PIPESTATUS[0]}
  fi

  if [ "${status}" -ne 0 ] && grep -q "Could not receive test results from the test executor" "${tmp}"; then
    : > "${tmp}"
    run_gradle_for_method "${method_name}" 2>&1 | tee "${tmp}"
    status=${PIPESTATUS[0]}
  fi
  set -e

  if grep -q "Starting 0 tests" "${tmp}" || grep -q "No tests found" "${tmp}"; then
    echo "gate:android-deeplink-smoke failed: zero tests executed for ${method_name}" >&2
    rm -f "${tmp}"
    exit 4
  fi

  rm -f "${tmp}"
  return "${status}"
}

for method_name in "${TEST_METHODS[@]}"; do
  echo "gate:android-deeplink-smoke: running ${TEST_CLASS}#${method_name}"
  run_method_with_retries "${method_name}"
done
