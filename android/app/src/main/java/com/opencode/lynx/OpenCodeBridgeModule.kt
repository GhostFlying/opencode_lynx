package com.opencode.lynx

import com.lynx.jsbridge.LynxContextModule
import com.lynx.jsbridge.LynxMethod
import com.lynx.react.bridge.Callback
import com.lynx.react.bridge.JavaOnlyArray
import com.lynx.react.bridge.JavaOnlyMap
import com.lynx.react.bridge.ReadableMap
import com.lynx.tasm.behavior.LynxContext

/**
 * Lynx native module exposing host capabilities to the JS layer.
 * Registers as "nativeBridge" to match the JS native-bridge.ts module name.
 */
class OpenCodeBridgeModule(context: LynxContext, obj: Any?) : LynxContextModule(context, obj) {
    companion object {
        const val NAME = "nativeBridge"
        private const val CODE_SUCCEEDED = 1
        private const val CODE_FAILED = 0
        private const val CODE_INVALID_PARAM = -3
        private const val CODE_NO_HANDLER = -2
    }

    private val requestTransport: NetworkRequestTransport by lazy {
        NetworkRequestOkHttpTransport()
    }

    private val sseTransport: NetworkSseTransport by lazy {
        NetworkSseOkHttpTransport()
    }

    @LynxMethod
    fun call(methodName: String, params: ReadableMap?, callback: Callback?) {
        if (methodName.isEmpty()) {
            callback?.invoke(makeResponse(CODE_INVALID_PARAM, "Missing method name", null))
            return
        }

        val data: ReadableMap? = try { params?.getMap("data") } catch (_: Exception) { null }

        when (methodName) {
            "network.request" -> handleNetworkRequest(data, callback)
            "network.sse.open" -> handleSseOpen(data, callback)
            "network.sse.close" -> handleSseClose(data, callback)
            "storage.set" -> handleStorageSet(data, callback)
            "storage.get" -> handleStorageGet(data, callback)
            "storage.remove" -> handleStorageRemove(data, callback)
            "diagnostic.report" -> handleDiagnosticReport(data, callback)
            "navigation.open" -> handleNavigationOpen(data, callback)
            "navigation.close" -> handleNavigationClose(callback)
            else -> callback?.invoke(makeResponse(CODE_NO_HANDLER, "Method '$methodName' not registered", null))
        }
    }

    // MARK: - Network

    private fun handleNetworkRequest(params: ReadableMap?, callback: Callback?) {
        val path = params?.getString("path", "") ?: ""
        if (path.isBlank()) {
            callback?.invoke(makeResponse(CODE_INVALID_PARAM, "Invalid payload", errorResult("invalid_payload")))
            return
        }

        val headers = readMapAsStringMap(try { params?.getMap("headers") } catch (_: Exception) { null })
        val bodyRaw = try { params?.getString("body") } catch (_: Exception) { null }

        Thread {
            val result = requestTransport.execute(NetworkRequestPayload(
                path = path.trim(),
                method = params?.getString("method", null),
                headers = headers,
                body = bodyRaw,
            ))

            val data = JavaOnlyMap()
            data.putBoolean("ok", result.ok)
            data.putInt("status", result.statusCode)
            data.putInt("status_code", result.statusCode)
            val headersMap = JavaOnlyMap()
            result.headers.forEach { (k, v) -> headersMap.putString(k, v) }
            data.putMap("headers", headersMap)
            if (result.body != null) data.putString("body", result.body.toString())
            result.errorCode?.let { data.putString("error_code", it); data.putString("reason", it) }
            result.errorMessage?.let { data.putString("error_message", it) }

            val code = if (result.errorCode != null) CODE_FAILED else CODE_SUCCEEDED
            callback?.invoke(makeResponse(code, result.errorMessage, data))
        }.start()
    }

    private fun handleSseOpen(params: ReadableMap?, callback: Callback?) {
        val path = params?.getString("path", "") ?: ""
        if (path.isBlank()) {
            callback?.invoke(makeResponse(CODE_INVALID_PARAM, "Invalid payload", errorResult("invalid_payload")))
            return
        }

        val headers = readMapAsStringMap(try { params?.getMap("headers") } catch (_: Exception) { null })
        val eventName = params?.getString("event_name", null)?.trim()?.takeIf { it.isNotEmpty() }

        Thread {
            val result = sseTransport.open(NetworkSseOpenPayload(
                path = path.trim(),
                headers = headers,
                eventName = eventName,
                onEvent = { eventName, payload ->
                    // Dispatch SSE event to JS via LynxView.sendGlobalEvent
                    val arr = JavaOnlyArray()
                    val eventMap = JavaOnlyMap()
                    payload.forEach { (k, v) ->
                        when (v) {
                            is String -> eventMap.putString(k, v)
                            is Number -> eventMap.putDouble(k, v.toDouble())
                            is Boolean -> eventMap.putBoolean(k, v)
                            else -> eventMap.putString(k, v.toString())
                        }
                    }
                    arr.pushMap(eventMap)
                    try {
                        mLynxContext?.getLynxView()?.sendGlobalEvent(eventName, arr)
                    } catch (_: Exception) {}
                }
            ))

            val data = JavaOnlyMap()
            result.streamId?.let { data.putString("id", it); data.putString("stream_id", it) }
            result.eventName?.let { data.putString("event_name", it) }
            result.errorCode?.let { data.putString("error_code", it); data.putString("reason", it) }
            result.errorMessage?.let { data.putString("error_message", it) }

            val code = if (result.errorCode != null) CODE_FAILED else CODE_SUCCEEDED
            callback?.invoke(makeResponse(code, result.errorMessage, data))
        }.start()
    }

    private fun handleSseClose(params: ReadableMap?, callback: Callback?) {
        val streamId = (params?.getString("id", "") ?: "").trim()
        if (streamId.isEmpty()) {
            callback?.invoke(makeResponse(CODE_INVALID_PARAM, "Invalid payload", errorResult("invalid_payload")))
            return
        }

        val result = sseTransport.close(NetworkSseClosePayload(id = streamId))
        val data = JavaOnlyMap()
        data.putBoolean("closed", result.closed)
        result.errorCode?.let { data.putString("error_code", it) }
        result.errorMessage?.let { data.putString("error_message", it) }
        val code = if (result.errorCode != null) CODE_FAILED else CODE_SUCCEEDED
        callback?.invoke(makeResponse(code, result.errorMessage, data))
    }

    // MARK: - Storage

    private fun handleStorageSet(params: ReadableMap?, callback: Callback?) {
        val key = (params?.getString("key", "") ?: "").trim()
        if (key.isEmpty()) {
            callback?.invoke(makeResponse(CODE_INVALID_PARAM, "storage.set requires non-empty key", null))
            return
        }
        val value = params?.getString("value", "") ?: ""
        val prefs = mContext.getSharedPreferences("opencodelynx", android.content.Context.MODE_PRIVATE)
        prefs.edit().putString(key, value).apply()
        val r = JavaOnlyMap(); r.putBoolean("ok", true)
        callback?.invoke(makeResponse(CODE_SUCCEEDED, null, r))
    }

    private fun handleStorageGet(params: ReadableMap?, callback: Callback?) {
        val key = (params?.getString("key", "") ?: "").trim()
        if (key.isEmpty()) {
            callback?.invoke(makeResponse(CODE_INVALID_PARAM, "storage.get requires non-empty key", null))
            return
        }
        val prefs = mContext.getSharedPreferences("opencodelynx", android.content.Context.MODE_PRIVATE)
        val stored = prefs.getString(key, null)
        val r = JavaOnlyMap()
        if (stored != null) r.putString("value", stored) else r.putNull("value")
        callback?.invoke(makeResponse(CODE_SUCCEEDED, null, r))
    }

    private fun handleStorageRemove(params: ReadableMap?, callback: Callback?) {
        val key = (params?.getString("key", "") ?: "").trim()
        if (key.isEmpty()) {
            callback?.invoke(makeResponse(CODE_INVALID_PARAM, "storage.remove requires non-empty key", null))
            return
        }
        val prefs = mContext.getSharedPreferences("opencodelynx", android.content.Context.MODE_PRIVATE)
        prefs.edit().remove(key).apply()
        val r = JavaOnlyMap(); r.putBoolean("ok", true)
        callback?.invoke(makeResponse(CODE_SUCCEEDED, null, r))
    }

    // MARK: - Diagnostic

    private fun handleDiagnosticReport(params: ReadableMap?, callback: Callback?) {
        val reportId = (params?.getString("report_id", "") ?: "").trim()
        val runId = (params?.getString("run_id", "") ?: "").trim()
        val phase = (params?.getString("phase", "") ?: "").trim()
        val status = (params?.getString("status", "") ?: "").trim()
        val reason = (params?.getString("reason", "") ?: "").trim()

        if (reportId.isEmpty() || runId.isEmpty()) {
            val r = JavaOnlyMap(); r.putBoolean("ok", false); r.putString("reason", "invalid_payload")
            callback?.invoke(makeResponse(CODE_INVALID_PARAM, "Invalid diagnostic payload", r))
            return
        }

        val validPhases = setOf("react_ready", "ui_ready")
        val validStatuses = setOf("ok", "warning", "error")
        if (phase !in validPhases || status !in validStatuses) {
            val r = JavaOnlyMap(); r.putBoolean("ok", false); r.putString("reason", "invalid_payload")
            callback?.invoke(makeResponse(CODE_INVALID_PARAM, "Invalid diagnostic payload", r))
            return
        }

        if ((status == "warning" || status == "error") && reason.isEmpty()) {
            val r = JavaOnlyMap(); r.putBoolean("ok", false); r.putString("reason", "invalid_payload")
            callback?.invoke(makeResponse(CODE_INVALID_PARAM, "Invalid diagnostic payload", r))
            return
        }

        val r = JavaOnlyMap(); r.putBoolean("ok", true)
        callback?.invoke(makeResponse(CODE_SUCCEEDED, null, r))
    }

    // MARK: - Navigation

    private fun handleNavigationOpen(params: ReadableMap?, callback: Callback?) {
        val scheme = params?.getString("scheme", "") ?: ""
        if (scheme.isEmpty()) {
            callback?.invoke(makeResponse(CODE_INVALID_PARAM, "navigation.open requires a scheme", null))
            return
        }
        val activity = OpenCodeActivityStack.topActivity
        if (activity != null) {
            val intent = android.content.Intent(activity, OpenCodeLynxActivity::class.java)
            intent.putExtra("scheme", scheme)
            activity.startActivity(intent)
        }
        callback?.invoke(makeResponse(CODE_SUCCEEDED, null, null))
    }

    private fun handleNavigationClose(callback: Callback?) {
        OpenCodeActivityStack.topActivity?.finish()
        callback?.invoke(makeResponse(CODE_SUCCEEDED, null, null))
    }

    // MARK: - Helpers

    private fun makeResponse(code: Int, msg: String?, data: JavaOnlyMap?): JavaOnlyMap {
        val response = JavaOnlyMap()
        response.putInt("code", code)
        if (msg != null) response.putString("msg", msg)
        if (data != null) response.putMap("data", data)
        response.putString("protocolVersion", "1.1.0")
        return response
    }

    private fun errorResult(errorCode: String): JavaOnlyMap {
        val r = JavaOnlyMap()
        r.putBoolean("ok", false)
        r.putString("error_code", errorCode)
        return r
    }

    private fun readMapAsStringMap(map: ReadableMap?): Map<String, String> {
        if (map == null) return emptyMap()
        val result = mutableMapOf<String, String>()
        val iter = map.keySetIterator()
        while (iter.hasNextKey()) {
            val key = iter.nextKey()
            result[key] = map.getString(key, "") ?: ""
        }
        return result
    }
}
