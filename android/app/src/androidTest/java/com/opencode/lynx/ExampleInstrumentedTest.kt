package com.opencode.lynx

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Rect
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.ViewAssertion
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.test.espresso.matcher.ViewMatchers.isDisplayed
import androidx.test.espresso.matcher.ViewMatchers.withText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiSelector
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicReference
import java.util.regex.Pattern
import org.hamcrest.Description
import org.hamcrest.Matcher
import org.hamcrest.Matchers.allOf
import org.hamcrest.Matchers.startsWith
import org.hamcrest.TypeSafeMatcher
import org.junit.Assume.assumeTrue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONArray
import org.json.JSONObject

@RunWith(AndroidJUnit4::class)
class ExampleInstrumentedTest {
    private val instrumentation
        get() = InstrumentationRegistry.getInstrumentation()

    private data class ReadySignal(
        val phase: String,
        val seq: Int,
        val runId: String,
    )

    private data class ChatExpectation(
        val sessionId: String,
        val sessionTitle: String,
        val visibleMessageSnippet: String,
    )

    private class StubServerUnavailable(message: String, cause: Throwable? = null) : Exception(message, cause)

    private companion object {
        private const val MAIN_READY_MARKER = "qa_main_ready_marker_v1"
        private const val OPEN_SECOND_PAGE_ACTION_MARKER = "qa_open_second_page_action_v1"
        private const val SECOND_READY_MARKER = "qa_second_ready_marker_v1"
        private const val SECOND_CLOSE_ACTION_MARKER = "qa_second_close_action_v1"
        private const val MAIN_READY_SIGNAL_MARKER_PREFIX = "qa_main_ready_signal_v1"
        private const val DEV_SOURCE_MARKER_PREFIX = "qa_dev_source_deeplink_v1"
        private const val DEV_SOURCE_OUTER_BASE = "opencode-lynx://dev-source?target="

        // Timeouts are sized for the slowest environment we still want green:
        // the GitHub Actions x86_64 emulator, which takes 2-3x longer than a
        // local arm64 simulator to boot LynxEnv, parse bundles, and route
        // through the instrumentation runner. `waitForMarker` uses retry
        // buckets (LOGCAT_RETRY_DELAYS_MS) so the effective wall-clock per
        // marker is already this value times that list.
        private const val REACT_READY_TIMEOUT_MS = 300_000L
        private const val UI_READY_TIMEOUT_MS = 300_000L
        private const val TOTAL_READY_TIMEOUT_MS = 300_000L
        private const val DEEPLINK_TOTAL_READY_TIMEOUT_MS = 300_000L
        private const val MARKER_TIMEOUT_MS = 300_000L
        private const val SHORT_ASSERT_TIMEOUT_MS = 1_500L
        private const val POLL_INTERVAL_MS = 100L
        private val LOGCAT_RETRY_DELAYS_MS = longArrayOf(0L, 200L, 500L)
        private const val DEFAULT_STUB_BASE_URL = "http://10.0.2.2:3000"
        private const val STUB_CONNECT_TIMEOUT_MS = 3_000
        private const val STUB_READ_TIMEOUT_MS = 3_000
        private const val SAVED_CONNECTION_PREFS = "opencodelynx"
        private const val SAVED_CONNECTION_KEY = "opencode_connection"
        private const val MISSING_SESSION_ID_ERROR = "No session ID provided."
        private const val MISSING_CONNECTION_ERROR = "No connection payload provided. Go back and reconnect first."

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
        val qaTestTarget = "hybrid://lynxview_page?bundle=qa-test.lynx.bundle&run_id=android_smoke_v1"
        launchAppWithDevSourceDeepLink(target = qaTestTarget)

        assertMainReadinessFlowWithinBudget(totalReadyTimeoutMs = DEEPLINK_TOTAL_READY_TIMEOUT_MS)

        waitForMarker(OPEN_SECOND_PAGE_ACTION_MARKER, MARKER_TIMEOUT_MS)
        openSecondPageViaNavigationMethod()
        waitForMarker(SECOND_READY_MARKER, MARKER_TIMEOUT_MS)
        waitForMarker(SECOND_CLOSE_ACTION_MARKER, MARKER_TIMEOUT_MS)

        closeSecondPageViaNavigationMethod()
    }

    // Split from a single multi-phase testDeeplink* into three @Tests so
    // each phase emits its own INSTRUMENTATION_STATUS_CODE to ddmlib.
    // The harness's "no output from instrumentation" timeout (~60s) kept
    // firing inside the merged test because all three phases lived
    // between a single start/end STATUS pair, giving ddmlib no heartbeat.
    // Per-@Test now finishes in well under that window.

    @Test
    fun testDeeplinkColdStartAcceptedTargetConsumesAndTransitions() {
        val acceptedTarget = "hybrid://lynxview_page?bundle=qa-test.lynx.bundle&run_id=android_deeplink_accept_v1"
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
    }

    @Test
    fun testDeeplinkLauncherIntentFallsBackToDefaultMainWithoutConsume() {
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
    }

    @Test
    fun testDeeplinkInvalidTargetFailsClosedToDefaultMain() {
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
    }

    @Test
    fun testDeeplinkConsumeOnceReroutesToDefaultMainOnRelaunch() {
        val startupTarget = "hybrid://lynxview_page?bundle=second.lynx.bundle&title=Second%20Page&screen_orientation=portrait"
        launchAppWithDevSourceDeepLink(target = startupTarget, clearLogcat = true)
        waitForMarker("qa_second_ready_marker_v1", MARKER_TIMEOUT_MS)

        // Relaunch without deep link — the startup override was consumed on the
        // first launch, so the second launch should fall back to default main.
        clearAppLogcat()
        launchApp(clearLogcat = false)

        waitForMarker(
            "$DEV_SOURCE_MARKER_PREFIX|event=decision|source=startup|reason=fallback_default",
            MARKER_TIMEOUT_MS,
        )
        waitForMarker(
            "$DEV_SOURCE_MARKER_PREFIX|event=transition|source=startup|to=default_main",
            MARKER_TIMEOUT_MS,
        )
        assertMarkerAbsent("qa_second_ready_marker_v1", SHORT_ASSERT_TIMEOUT_MS)
    }

    @Test
    fun testDeeplinkChatRouteParamsPopulateTitleAndSessionID() {
        val routeParams =
            """{"sessionId":"ses_e2e","sessionTitle":"Route Params OK","connection":{"ip":"127.0.0.1","port":"3000","password":""}}"""
        val target = "hybrid://lynxview?bundle=chat.lynx.bundle&route_params=${Uri.encode(routeParams)}"
        launchAppWithDevSourceDeepLink(target = target, clearLogcat = true)

        val hasSessionTitle = waitForTextInLynxUI("Route Params OK", 60_000L)
        if (!hasSessionTitle) {
            val rootUI = getLynxRootUI()
            if (rootUI != null) {
                android.util.Log.d("OpenCodeLynxTest", "--- Dumping Lynx UI tree texts ---")
                dumpLynxUITexts(rootUI)
            } else {
                android.util.Log.d("OpenCodeLynxTest", "rootUI is null")
            }
        }
        assertTrue(
            "Expected session title 'Route Params OK' in Lynx UI tree",
            hasSessionTitle,
        )

        val rootUI = getLynxRootUI()
        val hasNoSessionIdError = rootUI == null || !isTextInLynxUI(rootUI, "No session ID provided.")
        assertTrue(
            "Unexpected error 'No session ID provided.' in chat page",
            hasNoSessionIdError,
        )
    }

    @Test
    fun testMainFlowOpensChatWithSavedConnectionAndRouteParams() {
        clearSavedConnection()
        try {
            val stubBaseUrl = instrumentationStubBaseUrl()
            val requireStubServer = instrumentationRequireStubServer()
            val chatExpectation = fetchChatExpectationOrSkip(stubBaseUrl, requireStubServer)
            seedSavedConnectionForStub(stubBaseUrl)

            launchApp(clearLogcat = true)

            assertTrue(
                "Expected fixture session '${chatExpectation.sessionTitle}' in Lynx UI tree",
                waitForTextInLynxUI(chatExpectation.sessionTitle, MARKER_TIMEOUT_MS),
            )

            openSessionByVisibleTitle(chatExpectation.sessionTitle, MARKER_TIMEOUT_MS)

            assertTrue(
                "Expected chat title '${chatExpectation.sessionTitle}' in Lynx UI tree",
                waitForTextInLynxUI(chatExpectation.sessionTitle, MARKER_TIMEOUT_MS),
            )
            assertTrue(
                "Expected message snippet '${chatExpectation.visibleMessageSnippet}' for session ${chatExpectation.sessionId} in Lynx UI tree",
                waitForTextInLynxUI(chatExpectation.visibleMessageSnippet, MARKER_TIMEOUT_MS),
            )
            assertTextAbsentInLynxUI(MISSING_SESSION_ID_ERROR, SHORT_ASSERT_TIMEOUT_MS)
            assertTextAbsentInLynxUI(MISSING_CONNECTION_ERROR, SHORT_ASSERT_TIMEOUT_MS)
        } finally {
            clearSavedConnection()
        }
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
        val qaTestTarget = "hybrid://lynxview_page?bundle=qa-test.lynx.bundle&run_id=android_timeout_v1"
        launchAppWithDevSourceDeepLink(target = qaTestTarget)

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
        // Reset global state so one test's deep-link consumption does not
        // leak into the next test.
        DevSourceStartupOverrideState.updatePendingScheme(null)
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
        DevSourceStartupOverrideState.updatePendingScheme(null)
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
        // Match the marker only when it is immediately followed by end-of-line.
        // A longer marker (e.g. ...|reason=consumed|target=...) must NOT match.
        val exactPattern = Pattern.compile(Pattern.quote(marker) + "$")
        do {
            val logLines = readAppLogcat()
            if (exactPattern.matcher(logLines).find()) {
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

    private fun instrumentationStubBaseUrl(): String {
        val configured = InstrumentationRegistry.getArguments().getString("opencodelynx_stub_base_url")
        return (configured?.takeIf { it.isNotBlank() } ?: DEFAULT_STUB_BASE_URL).trim().trimEnd('/')
    }

    private fun instrumentationRequireStubServer(): Boolean {
        val raw = InstrumentationRegistry.getArguments().getString("opencodelynx_require_stub_server")
            ?.trim()
            ?.lowercase()
            ?: return false
        return raw == "true" || raw == "1" || raw == "yes"
    }

    private fun fetchChatExpectationOrSkip(stubBaseUrl: String, requireStubServer: Boolean): ChatExpectation {
        try {
            return fetchFirstSessionChatExpectation(stubBaseUrl)
        } catch (error: StubServerUnavailable) {
            if (requireStubServer) {
                throw AssertionError("Required OpenCode stub server unavailable at $stubBaseUrl", error)
            }
            assumeTrue(
                "Skipping main-flow parity test; OpenCode stub server unavailable at $stubBaseUrl (${error.message})",
                false,
            )
            throw AssertionError("Unreachable after assumption failure", error)
        }
    }

    private fun fetchFirstSessionChatExpectation(stubBaseUrl: String): ChatExpectation {
        val sessions = JSONArray(httpGetFromStub(stubBaseUrl, "/session"))
        val firstSession = sessions.optJSONObject(0)
            ?: throw AssertionError("OpenCode stub server returned no sessions")
        val sessionId = firstSession.optString("id").trim()
        val sessionTitle = firstSession.optString("title").trim()
        if (sessionId.isEmpty() || sessionTitle.isEmpty()) {
            throw AssertionError("OpenCode stub server returned a session without id/title")
        }

        val messages = JSONArray(httpGetFromStub(stubBaseUrl, "/session/${Uri.encode(sessionId)}/message"))
        val visibleMessage = firstVisibleMessageText(messages)
        return ChatExpectation(
            sessionId = sessionId,
            sessionTitle = sessionTitle,
            visibleMessageSnippet = visibleSnippet(visibleMessage),
        )
    }

    private fun httpGetFromStub(stubBaseUrl: String, path: String): String {
        val url = URL("$stubBaseUrl$path")
        val connection = try {
            url.openConnection() as HttpURLConnection
        } catch (error: IOException) {
            throw StubServerUnavailable("Failed to open connection for $url", error)
        }

        try {
            connection.requestMethod = "GET"
            connection.connectTimeout = STUB_CONNECT_TIMEOUT_MS
            connection.readTimeout = STUB_READ_TIMEOUT_MS
            connection.useCaches = false

            val status = connection.responseCode
            val body = if (status in 200..299) {
                connection.inputStream.bufferedReader().use { it.readText() }
            } else {
                connection.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()
            }

            if (status !in 200..299) {
                throw StubServerUnavailable("GET $url returned HTTP $status: $body")
            }
            return body
        } catch (error: IOException) {
            throw StubServerUnavailable("GET $url failed: ${error.message}", error)
        } finally {
            connection.disconnect()
        }
    }

    private fun firstVisibleMessageText(messages: JSONArray): String {
        for (messageIndex in 0 until messages.length()) {
            val message = messages.optJSONObject(messageIndex) ?: continue
            val parts = message.optJSONArray("parts") ?: continue
            for (partIndex in 0 until parts.length()) {
                val part = parts.optJSONObject(partIndex) ?: continue
                if (part.optString("type") != "text") {
                    continue
                }
                val text = normalizeVisibleText(part.optString("text"))
                if (text.length >= 12) {
                    return text
                }
            }
        }
        throw AssertionError("OpenCode stub server returned no stable visible text message")
    }

    private fun visibleSnippet(text: String): String {
        return if (text.length <= 80) {
            text
        } else {
            text.take(80).trim()
        }
    }

    private fun seedSavedConnectionForStub(stubBaseUrl: String) {
        val uri = Uri.parse(stubBaseUrl)
        val host = uri.host?.takeIf { it.isNotBlank() }
            ?: throw AssertionError("Invalid stub base URL host: $stubBaseUrl")
        val port = when {
            uri.port > 0 -> uri.port
            uri.scheme == "https" -> 443
            else -> 80
        }
        val connectionJson = JSONObject()
            .put("ip", host)
            .put("port", port.toString())
            .put("password", "")
            .toString()
        val committed = instrumentation.targetContext
            .getSharedPreferences(SAVED_CONNECTION_PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(SAVED_CONNECTION_KEY, connectionJson)
            .commit()
        if (!committed) {
            throw AssertionError("Failed to seed saved OpenCode connection")
        }
    }

    private fun clearSavedConnection() {
        instrumentation.targetContext
            .getSharedPreferences(SAVED_CONNECTION_PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove(SAVED_CONNECTION_KEY)
            .commit()
    }

    private fun openSessionByVisibleTitle(sessionTitle: String, timeoutMs: Long) {
        val deadline = SystemClock.elapsedRealtime() + timeoutMs
        val tapErrors = mutableListOf<Throwable>()

        do {
            try {
                val device = UiDevice.getInstance(instrumentation)
                val objectByText = device.findObject(UiSelector().textContains(sessionTitle))
                if (objectByText.exists()) {
                    objectByText.click()
                    instrumentation.waitForIdleSync()
                    return
                }
            } catch (error: Throwable) {
                tapErrors.add(error)
            }

            try {
                onView(allOf(withText(sessionTitle), isDisplayed())).perform(click())
                instrumentation.waitForIdleSync()
                return
            } catch (error: Throwable) {
                tapErrors.add(error)
            }

            try {
                if (tapLynxTextCenter(sessionTitle)) {
                    instrumentation.waitForIdleSync()
                    return
                }
            } catch (error: Throwable) {
                tapErrors.add(error)
            }

            SystemClock.sleep(POLL_INTERVAL_MS)
        } while (SystemClock.elapsedRealtime() < deadline)

        val rootUI = getLynxRootUI()
        if (rootUI != null) {
            android.util.Log.d("OpenCodeLynxTest", "--- Dumping Lynx UI tree texts before tap failure ---")
            dumpLynxUITexts(rootUI)
        }
        throw AssertionError("Timed out tapping session title '$sessionTitle'", tapErrors.lastOrNull())
    }

    private fun tapLynxTextCenter(target: String): Boolean {
        val rootUI = getLynxRootUI() ?: return false
        val targetUI = findTextNodeInLynxUI(rootUI, target) ?: return false
        val rect = rectForLynxUI(targetUI) ?: return false
        if (rect.width() <= 0 || rect.height() <= 0) {
            return false
        }
        return UiDevice.getInstance(instrumentation).click(rect.centerX(), rect.centerY())
    }

    private fun rectForLynxUI(ui: Any): Rect? {
        val windowRect = invokeRectMethod(ui, "getRectToWindow")
        if (windowRect != null && windowRect.width() > 0 && windowRect.height() > 0) {
            return windowRect
        }

        val localRect = invokeRectMethod(ui, "getBoundingClientRect")
            ?: invokeRectMethod(ui, "getBound")
            ?: return null
        val lynxView = findLynxView() ?: return localRect
        val location = IntArray(2)
        lynxView.getLocationOnScreen(location)
        return Rect(
            localRect.left + location[0],
            localRect.top + location[1],
            localRect.right + location[0],
            localRect.bottom + location[1],
        )
    }

    private fun invokeRectMethod(ui: Any, methodName: String): Rect? {
        return try {
            ui.javaClass.getMethod(methodName).invoke(ui) as? Rect
        } catch (_: Exception) {
            null
        }
    }

    private fun assertTextAbsentInLynxUI(target: String, timeoutMs: Long) {
        val deadline = SystemClock.elapsedRealtime() + timeoutMs
        do {
            val rootUI = getLynxRootUI()
            if (rootUI != null && isTextInLynxUI(rootUI, target)) {
                throw AssertionError("Unexpected text '$target' in Lynx UI tree")
            }
            SystemClock.sleep(POLL_INTERVAL_MS)
        } while (SystemClock.elapsedRealtime() < deadline)
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
        return runShell("timeout 3 logcat -d -v brief -s SplashActivity lynx TestRunner")
    }

    private fun runShell(command: String): String {
        instrumentation.uiAutomation.executeShellCommand(command).use { parcelFd ->
            ParcelFileDescriptor.AutoCloseInputStream(parcelFd).bufferedReader().use { reader ->
                return reader.readText()
            }
        }
    }

    private fun findLynxView(): View? {
        try {
            val activityThread = Class.forName("android.app.ActivityThread")
            val currentActivityThread = activityThread.getMethod("currentActivityThread").invoke(null)
            val activitiesField = activityThread.getDeclaredField("mActivities")
            activitiesField.isAccessible = true
            @Suppress("UNCHECKED_CAST")
            val activities = activitiesField.get(currentActivityThread) as Map<Any, Any>
            for (activityRecord in activities.values) {
                val activityRecordClass = activityRecord.javaClass
                val pausedField = activityRecordClass.getDeclaredField("paused")
                pausedField.isAccessible = true
                if (!pausedField.getBoolean(activityRecord)) {
                    val activityField = activityRecordClass.getDeclaredField("activity")
                    activityField.isAccessible = true
                    val activity = activityField.get(activityRecord) as? Activity ?: continue
                    return findLynxViewInTree(activity.window.decorView)
                }
            }
        } catch (_: Exception) {
            // ignore
        }
        return null
    }

    private fun findLynxViewInTree(root: View): View? {
        val simpleName = root.javaClass.simpleName
        if (simpleName == "LynxView" || simpleName == "UIBodyView") return root
        if (root is ViewGroup) {
            for (i in 0 until root.childCount) {
                val result = findLynxViewInTree(root.getChildAt(i))
                if (result != null) return result
            }
        }
        return null
    }

    private fun getLynxRootUI(): Any? {
        val lynxView = findLynxView() ?: return null
        val lynxContext = lynxView.javaClass.getMethod("getLynxContext").invoke(lynxView) ?: return null
        val uiOwner = lynxContext.javaClass.getMethod("getLynxUIOwner").invoke(lynxContext) ?: return null
        return uiOwner.javaClass.getMethod("getRootUI").invoke(uiOwner)
    }

    private fun normalizeVisibleText(value: String): String {
        return value.replace(Regex("\\s+"), " ").trim()
    }

    private fun lynxTextMatches(text: String, target: String): Boolean {
        if (text.contains(target)) return true
        val normalizedText = normalizeVisibleText(text)
        val normalizedTarget = normalizeVisibleText(target)
        return normalizedTarget.isNotEmpty() && normalizedText.contains(normalizedTarget)
    }

    private fun readTextFromLynxUI(ui: Any?): String? {
        if (ui == null) return null
        val clazz = ui.javaClass
        if (!clazz.simpleName.contains("Text")) {
            return null
        }

        for (methodName in listOf("getText", "getOriginText", "getAccessibilityLabel")) {
            try {
                val text = clazz.getMethod(methodName).invoke(ui) as? CharSequence
                if (!text.isNullOrBlank()) {
                    return text.toString()
                }
            } catch (_: Exception) {
                // This Lynx text implementation does not expose that accessor.
            }
        }

        try {
            val view = clazz.getMethod("getView").invoke(ui) as? TextView
            val text = view?.text
            if (!text.isNullOrBlank()) {
                return text.toString()
            }
        } catch (_: Exception) {
            // Flattened text nodes do not always own an Android TextView.
        }

        return null
    }

    private fun findTextInLynxUI(ui: Any?): String? {
        if (ui == null) return null
        val clazz = ui.javaClass
        val ownText = readTextFromLynxUI(ui)
        if (!ownText.isNullOrBlank()) {
            return ownText
        }
        try {
            val childrenMethod = clazz.getMethod("getChildren")
            @Suppress("UNCHECKED_CAST")
            val children = childrenMethod.invoke(ui) as? List<Any>
            children?.forEach { child ->
                val result = findTextInLynxUI(child)
                if (result != null) return result
            }
        } catch (_: Exception) {
            // not a branch node
        }
        return null
    }

    private fun findTextNodeInLynxUI(ui: Any?, target: String): Any? {
        if (ui == null) return null
        val clazz = ui.javaClass
        val ownText = readTextFromLynxUI(ui)
        if (ownText != null && lynxTextMatches(ownText, target)) {
            return ui
        }
        try {
            val childrenMethod = clazz.getMethod("getChildren")
            @Suppress("UNCHECKED_CAST")
            val children = childrenMethod.invoke(ui) as? List<Any>
            children?.forEach { child ->
                val result = findTextNodeInLynxUI(child, target)
                if (result != null) return result
            }
        } catch (_: Exception) {
            // not a branch node
        }
        return null
    }

    private fun isTextInLynxUI(ui: Any?, target: String): Boolean {
        if (ui == null) return false
        val clazz = ui.javaClass
        val ownText = readTextFromLynxUI(ui)
        if (ownText != null && lynxTextMatches(ownText, target)) {
            return true
        }
        try {
            val childrenMethod = clazz.getMethod("getChildren")
            @Suppress("UNCHECKED_CAST")
            val children = childrenMethod.invoke(ui) as? List<Any>
            children?.forEach { child ->
                if (isTextInLynxUI(child, target)) return true
            }
        } catch (_: Exception) {
            // not a branch node
        }
        return false
    }

    private fun waitForTextInLynxUI(target: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.elapsedRealtime() + timeoutMs
        do {
            val rootUI = getLynxRootUI()
            if (rootUI != null && isTextInLynxUI(rootUI, target)) {
                return true
            }
            SystemClock.sleep(POLL_INTERVAL_MS)
        } while (SystemClock.elapsedRealtime() < deadline)
        return false
    }

    private fun dumpLynxUITexts(ui: Any?, prefix: String = "") {
        if (ui == null) return
        val clazz = ui.javaClass
        val ownText = readTextFromLynxUI(ui)
        if (ownText != null) {
            android.util.Log.d("OpenCodeLynxTest", "$prefix${clazz.simpleName}: text='$ownText'")
        }
        try {
            val childrenMethod = clazz.getMethod("getChildren")
            @Suppress("UNCHECKED_CAST")
            val children = childrenMethod.invoke(ui) as? List<Any>
            children?.forEachIndexed { i, child ->
                dumpLynxUITexts(child, "$prefix  [$i]")
            }
        } catch (_: Exception) {
            // not a branch node
        }
    }
}
