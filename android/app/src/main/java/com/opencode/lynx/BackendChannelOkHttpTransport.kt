package com.opencode.lynx

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

enum class BackendChannelStatus { SUCCESS, INVALID_PARAM, FAIL }

data class BackendChannelOpenPayload(
    val url: String,
    val headers: Map<String, String>?,
    val pingIntervalMs: Long = 30_000L,
    val onOpen: (() -> Unit)? = null,
    val onTextFrame: ((String) -> Unit)? = null,
    val onState: ((Map<String, Any>) -> Unit)? = null,
)

data class BackendChannelOpenResult(
    val status: BackendChannelStatus,
    val statusMessage: String,
    val channelId: String?,
    val errorCode: String?,
    val errorMessage: String?,
)

data class BackendChannelSendPayload(
    val channelId: String,
    val text: String,
)

data class BackendChannelSendResult(
    val status: BackendChannelStatus,
    val sent: Boolean,
    val errorCode: String?,
    val errorMessage: String?,
)

data class BackendChannelClosePayload(
    val channelId: String,
    val code: Int?,
    val reason: String?,
)

data class BackendChannelCloseResult(
    val status: BackendChannelStatus,
    val closed: Boolean,
    val errorCode: String?,
    val errorMessage: String?,
)

interface BackendChannelTransport {
    fun open(payload: BackendChannelOpenPayload): BackendChannelOpenResult
    fun send(payload: BackendChannelSendPayload): BackendChannelSendResult
    fun close(payload: BackendChannelClosePayload): BackendChannelCloseResult
}

class BackendChannelOkHttpTransport(
    private val clientFactory: (Long) -> OkHttpClient = { pingMs ->
        OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(pingMs.coerceAtLeast(0L), TimeUnit.MILLISECONDS)
            .build()
    },
    private val channelIdFactory: (Long) -> String = { "channel-$it" },
) : BackendChannelTransport {

    private val counter = AtomicLong(0)
    private val sessions = ConcurrentHashMap<String, ChannelSession>()

    override fun open(payload: BackendChannelOpenPayload): BackendChannelOpenResult {
        val url = payload.url.trim()
        if (!isWsUrl(url)) {
            return BackendChannelOpenResult(
                status = BackendChannelStatus.INVALID_PARAM,
                statusMessage = "Invalid backend.channel.open payload",
                channelId = null,
                errorCode = "invalid_payload",
                errorMessage = "url must be ws:// or wss://",
            )
        }

        val channelId = channelIdFactory(counter.incrementAndGet())
        val client = clientFactory(payload.pingIntervalMs)

        val requestBuilder = Request.Builder().url(url)
        payload.headers?.forEach { (k, v) -> requestBuilder.addHeader(k, v) }

        val session = ChannelSession(
            channelId = channelId,
            onOpen = payload.onOpen,
            onTextFrame = payload.onTextFrame,
            onState = payload.onState,
        )

        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (session.terminated.get()) return
                session.onOpen?.invoke()
                session.onState?.invoke(mapOf("state" to "open"))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (session.terminated.get()) return
                session.onTextFrame?.invoke(text)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                if (session.terminated.get()) return
                session.onState?.invoke(mapOf("state" to "error", "error" to "non_json_frame"))
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (!session.terminated.compareAndSet(false, true)) return
                sessions.remove(session.channelId)
                val state = mutableMapOf<String, Any>("state" to "closed", "code" to code)
                if (reason.isNotEmpty()) state["reason"] = reason
                session.onState?.invoke(state)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (!session.terminated.compareAndSet(false, true)) return
                sessions.remove(session.channelId)
                val state = mutableMapOf<String, Any>(
                    "state" to "error",
                    "error" to (t.message ?: t.javaClass.simpleName),
                )
                response?.let { state["code"] = it.code }
                session.onState?.invoke(state)
            }
        }

        // Register before kicking off the socket so a fast `onFailure` /
        // `onClosed` cannot run `sessions.remove(...)` against an empty map
        // and leave a terminated session re-inserted afterwards.
        sessions[channelId] = session
        val ws = client.newWebSocket(requestBuilder.build(), listener)
        session.webSocket = ws

        return BackendChannelOpenResult(
            status = BackendChannelStatus.SUCCESS,
            statusMessage = "ok",
            channelId = channelId,
            errorCode = null,
            errorMessage = null,
        )
    }

    override fun send(payload: BackendChannelSendPayload): BackendChannelSendResult {
        val session = sessions[payload.channelId]
            ?: return BackendChannelSendResult(
                status = BackendChannelStatus.FAIL,
                sent = false,
                errorCode = "channel_closed",
                errorMessage = "channel not found",
            )

        if (session.terminated.get()) {
            return BackendChannelSendResult(
                status = BackendChannelStatus.FAIL,
                sent = false,
                errorCode = "channel_closed",
                errorMessage = "channel is closed",
            )
        }

        val ok = try {
            session.webSocket?.send(payload.text) ?: false
        } catch (e: Exception) {
            return BackendChannelSendResult(
                status = BackendChannelStatus.FAIL,
                sent = false,
                errorCode = "transport_error",
                errorMessage = e.message ?: e.javaClass.simpleName,
            )
        }
        return if (ok) {
            BackendChannelSendResult(BackendChannelStatus.SUCCESS, true, null, null)
        } else {
            BackendChannelSendResult(BackendChannelStatus.FAIL, false, "transport_error", "send rejected by transport")
        }
    }

    override fun close(payload: BackendChannelClosePayload): BackendChannelCloseResult {
        val session = sessions.remove(payload.channelId)
            ?: return BackendChannelCloseResult(BackendChannelStatus.SUCCESS, false, null, null)

        // Mark terminal before draining the socket so any racing
        // WebSocketListener callback that arrives after this point becomes a
        // no-op and cannot deliver further frames or state events to the
        // application.
        if (!session.terminated.compareAndSet(false, true)) {
            return BackendChannelCloseResult(BackendChannelStatus.SUCCESS, true, null, null)
        }

        val code = payload.code ?: 1000

        // Emit the terminal state event ourselves rather than relying on
        // OkHttp's `onClosed` callback — that callback short-circuits because
        // we already flipped `terminated`. Mirrors iOS, which also emits the
        // closed state from inside `cancel()`.
        val state = mutableMapOf<String, Any>("state" to "closed", "code" to code)
        payload.reason?.let { state["reason"] = it }
        try { session.onState?.invoke(state) } catch (_: Exception) {}

        val ws = session.webSocket
        var graceful = false
        try {
            graceful = ws?.close(code, payload.reason) ?: false
        } catch (_: Exception) {
            // Fall through to cancel.
        }
        if (!graceful) {
            try { ws?.cancel() } catch (_: Exception) {}
        }
        return BackendChannelCloseResult(BackendChannelStatus.SUCCESS, true, null, null)
    }

    private fun isWsUrl(url: String): Boolean {
        return url.startsWith("ws://") || url.startsWith("wss://")
    }

    private class ChannelSession(
        val channelId: String,
        val onOpen: (() -> Unit)?,
        val onTextFrame: ((String) -> Unit)?,
        val onState: ((Map<String, Any>) -> Unit)?,
    ) {
        @Volatile var webSocket: WebSocket? = null
        val terminated = AtomicBoolean(false)
    }
}
