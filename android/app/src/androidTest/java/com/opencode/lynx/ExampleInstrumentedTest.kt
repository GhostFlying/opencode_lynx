package com.opencode.lynx

import android.content.Intent
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.view.View
import android.widget.TextView
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.ViewAssertion
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.test.espresso.matcher.ViewMatchers.isDisplayed
import androidx.test.espresso.matcher.ViewMatchers.withText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.atomic.AtomicReference
import java.util.regex.Pattern
import org.hamcrest.Matcher
import org.hamcrest.Matchers.allOf
import org.hamcrest.Matchers.startsWith
import org.junit.Assume.assumeTrue
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ExampleInstrumentedTest {
    private val instrumentation
        get() = InstrumentationRegistry.getInstrumentation()

    private data class ReadySignal(
        val phase: String,
        val seq: Int,
        val runId: String,
    )

    private companion object {
        private const val MAIN_READY_MARKER = "qa_main_ready_marker_v1"
        private const val OPEN_SECOND_PAGE_ACTION_MARKER = "qa_open_second_page_action_v1"
        private const val SECOND_READY_MARKER = "qa_second_ready_marker_v1"
        private const val SECOND_CLOSE_ACTION_MARKER = "qa_second_close_action_v1"
        private const val MAIN_READY_SIGNAL_MARKER_PREFIX = "qa_main_ready_signal_v1"
        private const val DEV_SOURCE_MARKER_PREFIX = "qa_dev_source_deeplink_v1"
        private const val DEV_SOURCE_OUTER_BASE = "opencode-lynx://dev-source?target="

        private const val REACT_READY_TIMEOUT_MS = 15_000L
        private const val UI_READY_TIMEOUT_MS = 20_000L
        private const val TOTAL_READY_TIMEOUT_MS = 40_000L
        private const val DEEPLINK_TOTAL_READY_TIMEOUT_MS = 90_000L
        private const val MARKER_TIMEOUT_MS = 30_000L
        private const val SHORT_ASSERT_TIMEOUT_MS = 1_500L
        private const val POLL_INTERVAL_MS = 100L
        private val LOGCAT_RETRY_DELAYS_MS = longArrayOf(0L, 200L, 500L)

        private val LOGCAT_LINE_PATTERN =
            Pattern.compile("\\\"(qa_[^\\\"]+)\\\"|phase=([a-z_]+)\\|seq=(\\d+)\\|run_id=([^\\\\s\\\"]+)")
        private val LOGCAT_READY_SIGNAL_INLINE_PATTERN =
            Pattern.compile("(qa_main_ready_signal_v1\\|phase=([a-z_]+)\\|seq=(\\d+)\\|run_id=([^\\s\\\"]+))")
        private val LOGCAT_PAYLOAD_PHASE_PATTERN =
            Pattern.compile("phase:\\s*\\\"([a-z_]+)\\\"")
        private val LOGCAT_PAYLOAD_SEQ_PATTERN =
            Pattern.compile("seq:\\s*(\\d+)")
        private val LOGCAT_PAYLOAD_RUN_ID_PATTERN =
            Pattern.compile("run_id:\\s*\\\"([^\\\"]+)\\\"")
    }

    @Test
    fun testSmokeCorePathLaunchSecondCloseAndOrderedReadiness() {
        launchApp()
        assertMainReadinessFlowWithinBudget(totalReadyTimeoutMs = DEEPLINK_TOTAL_READY_TIMEOUT_MS)

        waitForMarker(OPEN_SECOND_PAGE_ACTION_MARKER, MARKER_TIMEOUT_MS)
        openSecondPageViaNavigationMethod()
        waitForMarker(SECOND_READY_MARKER, MARKER_TIMEOUT_MS)
        waitForMarker(SECOND_CLOSE_ACTION_MARKER, MARKER_TIMEOUT_MS)

        closeSecondPageViaNavigationMethod()
    }

    @Test
    fun testDeeplinkSmokeLaunchWithRealIngressAcceptedInvalidFallbackAndConsumeOnceRelaunch() {
        val acceptedTarget = "hybrid://lynxview_page?bundle=main.lynx.bundle&run_id=android_deeplink_accept_v1"
        launchAppWithDevSourceDeepLink(target = acceptedTarget)

        waitForMarker(
            "$DEV_SOURCE_MARKER_PREFIX|event=decision|source=cold_start|reason=accepted|target=$acceptedTarget",
            MARKER_TIMEOUT_MS,
        )
        waitForMarker(
            "$DEV_SOURCE_MARKER_PREFIX|event=consumed|source=startup|reason=consumed|target=$acceptedTarget",
            MARKER_TIMEOUT_MS,
        )
        waitForMarker(
            "$DEV_SOURCE_MARKER_PREFIX|event=transition|source=startup|to=startup_override|target=$acceptedTarget",
            MARKER_TIMEOUT_MS,
        )
        assertMainReadinessFlowWithinBudget(totalReadyTimeoutMs = DEEPLINK_TOTAL_READY_TIMEOUT_MS)

        launchApp(clearLogcat = true)

        waitForMarker(
            "$DEV_SOURCE_MARKER_PREFIX|event=decision|source=startup|reason=fallback_default",
            MARKER_TIMEOUT_MS,
        )
        waitForMarker(
            "$DEV_SOURCE_MARKER_PREFIX|event=transition|source=startup|to=default_main",
            MARKER_TIMEOUT_MS,
        )
        assertMarkerAbsent(
            marker = "$DEV_SOURCE_MARKER_PREFIX|event=consumed|source=startup|reason=consumed",
            timeoutMs = SHORT_ASSERT_TIMEOUT_MS,
        )
        assertMainReadinessFlowWithinBudget(totalReadyTimeoutMs = DEEPLINK_TOTAL_READY_TIMEOUT_MS)

        launchRawDeepLinkApp(
            rawDeepLink = "opencode-lynx://dev-source?target=%",
            clearLogcat = true,
        )

        waitForMarker(
            "$DEV_SOURCE_MARKER_PREFIX|event=decision|source=cold_start|reason=invalid_target",
            MARKER_TIMEOUT_MS,
        )
        waitForMarker(
            "$DEV_SOURCE_MARKER_PREFIX|event=decision|source=startup|reason=fallback_default",
            MARKER_TIMEOUT_MS,
        )
        waitForMarker(
            "$DEV_SOURCE_MARKER_PREFIX|event=transition|source=startup|to=default_main",
            MARKER_TIMEOUT_MS,
        )
        assertMarkerAbsent(
            marker = "$DEV_SOURCE_MARKER_PREFIX|event=consumed|source=startup|reason=consumed",
            timeoutMs = SHORT_ASSERT_TIMEOUT_MS,
        )
        assertMainReadinessFlowWithinBudget()
    }

    @Test
    fun testMarkerFailurePathFailsClosedOnMissingMarker() {
        assumeFailureMode("marker")
        launchApp()
        waitForMarker("qa_missing_marker_v1", 1_000L)
    }

    @Test
    fun testTimeoutFailurePathFailsClosedOnMissingUiReadySignal() {
        assumeFailureMode("timeout")
        launchApp()

        waitForMarker(MAIN_READY_MARKER, MARKER_TIMEOUT_MS)

        val impossibleRunId = "qa_timeout_run_id_v1"
        waitForReadySignalForRunId(
            phase = "ui_ready",
            seq = 2,
            runId = impossibleRunId,
            timeoutMs = 1_000L,
        )
    }

    private fun launchApp(clearLogcat: Boolean = true) {
        if (clearLogcat) {
            clearAppLogcat()
        }
        val appContext = instrumentation.targetContext
        val intent = appContext.packageManager
            .getLaunchIntentForPackage(appContext.packageName)
            ?: throw AssertionError("Unable to resolve launch intent for ${appContext.packageName}")

        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        appContext.startActivity(intent)
        instrumentation.waitForIdleSync()
    }

    private fun launchAppWithDevSourceDeepLink(target: String, clearLogcat: Boolean = true) {
        launchRawDeepLinkApp(rawDeepLink = "$DEV_SOURCE_OUTER_BASE${Uri.encode(target)}", clearLogcat = clearLogcat)
    }

    private fun launchRawDeepLinkApp(rawDeepLink: String, clearLogcat: Boolean = true) {
        if (clearLogcat) {
            clearAppLogcat()
        }

        val appContext = instrumentation.targetContext
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(rawDeepLink)).apply {
            setClassName(appContext.packageName, "com.opencode.lynx.SplashActivity")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        }

        appContext.startActivity(intent)
        instrumentation.waitForIdleSync()
    }

    private fun assertMainReadinessFlowWithinBudget(totalReadyTimeoutMs: Long = TOTAL_READY_TIMEOUT_MS) {
        val launchStartedAt = SystemClock.elapsedRealtime()

        waitForMarker(MAIN_READY_MARKER, MARKER_TIMEOUT_MS)

        val reactReadySignal = waitForReadySignal(phase = "react_ready", seq = 1, timeoutMs = REACT_READY_TIMEOUT_MS)
        val uiWaitStartedAt = SystemClock.elapsedRealtime()

        val elapsedAfterReact = uiWaitStartedAt - launchStartedAt
        val remainingTotalBudget = totalReadyTimeoutMs - elapsedAfterReact
        if (remainingTotalBudget <= 0L) {
            throw AssertionError("Total readiness cap exceeded before waiting for ui_ready: elapsed=${elapsedAfterReact}ms cap=${totalReadyTimeoutMs}ms")
        }

        val uiReadySignal = waitForReadySignalForRunId(
            phase = "ui_ready",
            seq = 2,
            runId = reactReadySignal.runId,
            timeoutMs = minOf(UI_READY_TIMEOUT_MS, remainingTotalBudget),
        )

        val uiElapsedFromReact = SystemClock.elapsedRealtime() - uiWaitStartedAt
        if (uiElapsedFromReact > UI_READY_TIMEOUT_MS) {
            throw AssertionError("ui_ready exceeded phase timeout of ${UI_READY_TIMEOUT_MS}ms: elapsed=${uiElapsedFromReact}ms")
        }

        val totalReadyElapsed = SystemClock.elapsedRealtime() - launchStartedAt
        if (totalReadyElapsed > totalReadyTimeoutMs) {
            throw AssertionError("Total readiness exceeded ${totalReadyTimeoutMs}ms: elapsed=${totalReadyElapsed}ms")
        }

        assertOrderedReadiness(reactReadySignal, uiReadySignal)
    }

    private fun waitForMarker(marker: String, timeoutMs: Long): String {
        return waitForMarkerInLogcat(marker, timeoutMs)
    }

    private fun clickText(text: String, timeoutMs: Long) {
        waitForMarker(text, timeoutMs)
        onView(allOf(withText(text), isDisplayed())).perform(click())
    }

    private fun openSecondPageViaNavigationMethod() {
        val appContext = instrumentation.targetContext
        val secondPageScheme = "hybrid://lynxview_page?bundle=second.lynx.bundle&title=Second%20Page&screen_orientation=portrait"
        val intent = android.content.Intent(appContext, OpenCodeLynxActivity::class.java)
        intent.putExtra("scheme", secondPageScheme)
        intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
        appContext.startActivity(intent)
        instrumentation.waitForIdleSync()
    }

    private fun closeSecondPageViaNavigationMethod() {
        OpenCodeActivityStack.topActivity?.finish()
        instrumentation.waitForIdleSync()
    }

    private fun waitForText(viewTextMatcher: Matcher<View>, description: String, timeoutMs: Long): String {
        val deadline = SystemClock.elapsedRealtime() + timeoutMs
        var lastError: Throwable?

        do {
            try {
                val textRef = AtomicReference<String>()
                onView(allOf(viewTextMatcher, isDisplayed()))
                    .check(matches(isDisplayed()))
                    .check(captureText(textRef))
                return textRef.get()
            } catch (error: Throwable) {
                lastError = error
                SystemClock.sleep(POLL_INTERVAL_MS)
            }
        } while (SystemClock.elapsedRealtime() < deadline)

        throw AssertionError("Timed out waiting for marker [$description] within ${timeoutMs}ms", lastError)
    }

    private fun waitForTextToDisappear(text: String, timeoutMs: Long) {
        val deadline = SystemClock.elapsedRealtime() + timeoutMs
        do {
            if (!isTextDisplayed(text)) {
                return
            }
            SystemClock.sleep(POLL_INTERVAL_MS)
        } while (SystemClock.elapsedRealtime() < deadline)

        throw AssertionError("Timed out waiting for marker to disappear: $text")
    }

    private fun assertMarkerAbsent(marker: String, timeoutMs: Long) {
        val deadline = SystemClock.elapsedRealtime() + timeoutMs
        do {
            val logLines = readAppLogcat()
            if (logLines.contains(marker)) {
                throw AssertionError("Unexpected marker observed in logcat: $marker")
            }
            SystemClock.sleep(POLL_INTERVAL_MS)
        } while (SystemClock.elapsedRealtime() < deadline)
    }

    private fun isTextDisplayed(text: String): Boolean {
        return try {
            onView(allOf(withText(text), isDisplayed())).check(matches(isDisplayed()))
            true
        } catch (_: Throwable) {
            false
        }
    }

    private fun captureText(output: AtomicReference<String>): ViewAssertion {
        return ViewAssertion { view, noViewFoundException ->
            if (noViewFoundException != null) {
                throw noViewFoundException
            }

            val textView = view as? TextView
                ?: throw AssertionError("Expected TextView marker node, got ${view?.javaClass?.name}")
            output.set(textView.text?.toString().orEmpty())
        }
    }

    private fun waitForReadySignal(phase: String, seq: Int, timeoutMs: Long): ReadySignal {
        val label = waitForReadySignalInLogcat(phase = phase, seq = seq, timeoutMs = timeoutMs)
        val parsed = parseReadySignal(label)
        assertEquals(phase, parsed.phase)
        assertEquals(seq, parsed.seq)
        return parsed
    }

    private fun waitForReadySignalForRunId(phase: String, seq: Int, runId: String, timeoutMs: Long): ReadySignal {
        val label = waitForReadySignalInLogcat(phase = phase, seq = seq, runId = runId, timeoutMs = timeoutMs)
        val parsed = parseReadySignal(label)
        assertEquals(phase, parsed.phase)
        assertEquals(seq, parsed.seq)
        assertEquals(runId, parsed.runId)
        return parsed
    }

    private fun parseReadySignal(label: String): ReadySignal {
        val expectedPrefix = "$MAIN_READY_SIGNAL_MARKER_PREFIX|"
        if (!label.startsWith(expectedPrefix)) {
            throw AssertionError("Malformed readiness signal: $label")
        }

        val segments = label.split("|").drop(1)
        val values = mutableMapOf<String, String>()
        for (segment in segments) {
            val pair = segment.split("=", limit = 2)
            if (pair.size != 2) {
                throw AssertionError("Malformed readiness segment [$segment] in signal [$label]")
            }
            values[pair[0]] = pair[1]
        }

        val phase = values["phase"]
            ?: throw AssertionError("Missing phase in readiness signal: $label")
        val seq = values["seq"]?.toIntOrNull()
            ?: throw AssertionError("Missing/invalid seq in readiness signal: $label")
        val runId = values["run_id"]
            ?: throw AssertionError("Missing run_id in readiness signal: $label")

        if (runId.isBlank()) {
            throw AssertionError("Blank run_id in readiness signal: $label")
        }

        return ReadySignal(phase = phase, seq = seq, runId = runId)
    }

    private fun assertOrderedReadiness(first: ReadySignal, second: ReadySignal) {
        assertEquals("react_ready", first.phase)
        assertEquals(1, first.seq)
        assertEquals("ui_ready", second.phase)
        assertEquals(2, second.seq)
        assertEquals(first.runId, second.runId)
    }

    private fun assumeFailureMode(expectedMode: String) {
        val configuredMode = InstrumentationRegistry.getArguments().getString("qa_failure_mode")
        assumeTrue(
            "Skipping failure-path test; set -Pandroid.testInstrumentationRunnerArguments.qa_failure_mode=$expectedMode to enable",
            configuredMode == expectedMode,
        )
    }

    private fun clearAppLogcat() {
        runShell("logcat -c")
    }

    private fun waitForMarkerInLogcat(marker: String, timeoutMs: Long): String {
        return waitForLogcatMatchWithRetries(
            description = "marker [$marker]",
            timeoutMs = timeoutMs,
        ) { logLines ->
            if (logLines.contains(marker)) marker else null
        }
    }

    private fun waitForReadySignalInLogcat(
        phase: String,
        seq: Int,
        runId: String? = null,
        timeoutMs: Long,
    ): String {
        return waitForLogcatMatchWithRetries(
            description = buildString {
                append("readiness signal phase=")
                append(phase)
                append(" seq=")
                append(seq)
                if (runId != null) {
                    append(" run_id=")
                    append(runId)
                }
            },
            timeoutMs = timeoutMs,
        ) { logLines ->
            for (line in logLines.lineSequence()) {
                val parsed = parseReadySignalFromLogLine(line) ?: continue
                if (parsed.phase != phase || parsed.seq != seq) {
                    continue
                }
                if (runId != null && parsed.runId != runId) {
                    continue
                }
                return@waitForLogcatMatchWithRetries "$MAIN_READY_SIGNAL_MARKER_PREFIX|phase=${parsed.phase}|seq=${parsed.seq}|run_id=${parsed.runId}"
            }
            null
        }
    }

    private fun waitForLogcatMatchWithRetries(
        description: String,
        timeoutMs: Long,
        matcher: (logLines: String) -> String?,
    ): String {
        val attemptCount = LOGCAT_RETRY_DELAYS_MS.size
        val perAttemptBudget = maxOf(POLL_INTERVAL_MS, timeoutMs / attemptCount)
        var lastError: AssertionError? = null

        for (attemptIndex in 0 until attemptCount) {
            try {
                return waitForLogcatMatchSingleAttempt(
                    description = description,
                    timeoutMs = perAttemptBudget,
                    matcher = matcher,
                )
            } catch (error: AssertionError) {
                lastError = error
                val retryDelay = LOGCAT_RETRY_DELAYS_MS[attemptIndex]
                if (attemptIndex < attemptCount - 1 && retryDelay > 0L) {
                    SystemClock.sleep(retryDelay)
                }
            }
        }

        throw AssertionError(
            "Timed out waiting for $description in logcat after $attemptCount bounded attempts (${perAttemptBudget * attemptCount}ms total)",
            lastError,
        )
    }

    private fun waitForLogcatMatchSingleAttempt(
        description: String,
        timeoutMs: Long,
        matcher: (logLines: String) -> String?,
    ): String {
        val deadline = SystemClock.elapsedRealtime() + timeoutMs
        do {
            val logLines = readAppLogcat()
            val matched = matcher(logLines)
            if (matched != null) {
                return matched
            }
            SystemClock.sleep(POLL_INTERVAL_MS)
        } while (SystemClock.elapsedRealtime() < deadline)

        throw AssertionError("Timed out waiting for $description in logcat within ${timeoutMs}ms")
    }

    private fun parseReadySignalFromLogLine(line: String): ReadySignal? {
        val inlineSignalMatcher = LOGCAT_READY_SIGNAL_INLINE_PATTERN.matcher(line)
        if (inlineSignalMatcher.find()) {
            val phase = inlineSignalMatcher.group(2)
            val seq = inlineSignalMatcher.group(3)?.toIntOrNull()
            val runId = inlineSignalMatcher.group(4)
            if (phase != null && seq != null && !runId.isNullOrBlank()) {
                return ReadySignal(phase = phase, seq = seq, runId = runId)
            }
        }

        val matcher = LOGCAT_LINE_PATTERN.matcher(line)
        var markerValue: String? = null
        var phase: String? = null
        var seq: Int? = null
        var runId: String? = null

        while (matcher.find()) {
            if (matcher.group(1) != null) {
                markerValue = matcher.group(1)
            }
            if (matcher.group(2) != null) {
                phase = matcher.group(2)
                seq = matcher.group(3)?.toIntOrNull()
                runId = matcher.group(4)
            }
        }

        if (phase == null || seq == null || runId.isNullOrBlank()) {
            val payloadPhase = LOGCAT_PAYLOAD_PHASE_PATTERN.matcher(line).let {
                if (it.find()) it.group(1) else null
            }
            val payloadSeq = LOGCAT_PAYLOAD_SEQ_PATTERN.matcher(line).let {
                if (it.find()) it.group(1)?.toIntOrNull() else null
            }
            val payloadRunId = LOGCAT_PAYLOAD_RUN_ID_PATTERN.matcher(line).let {
                if (it.find()) it.group(1) else null
            }

            if (payloadPhase == null || payloadSeq == null || payloadRunId.isNullOrBlank()) {
                return null
            }

            return ReadySignal(phase = payloadPhase, seq = payloadSeq, runId = payloadRunId)
        }

        if (markerValue != null && !markerValue.startsWith(MAIN_READY_SIGNAL_MARKER_PREFIX)) {
            return null
        }

        return ReadySignal(phase = phase, seq = seq, runId = runId)
    }

    private fun readAppLogcat(): String {
        return runShell("logcat -d -v brief -s SplashActivity lynx TestRunner")
    }

    private fun runShell(command: String): String {
        instrumentation.uiAutomation.executeShellCommand(command).use { parcelFd ->
            ParcelFileDescriptor.AutoCloseInputStream(parcelFd).bufferedReader().use { reader ->
                return reader.readText()
            }
        }
    }
}
