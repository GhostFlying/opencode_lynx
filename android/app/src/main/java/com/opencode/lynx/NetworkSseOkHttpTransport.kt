package com.opencode.lynx

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

class NetworkSseOkHttpTransport(
    private val clientFactory: () -> OkHttpClient = { NetworkRequestOkHttpTransport.buildDefaultClient() },
    private val openTimeoutMs: Long = 30_000L,
    private val defaultRetryDelayMs: Long = 1_000L,
    private val maxRetryDelayMs: Long = 30_000L,
    private val reconnectEnabled: Boolean = true,
) : NetworkSseTransport {

    private val client: OkHttpClient by lazy { clientFactory() }
    private val streamCounter = AtomicLong(0)
    private val sessions = ConcurrentHashMap<String, SseSession>()

    override fun open(payload: NetworkSseOpenPayload): NetworkSseOpenResult {
        val url = resolveAbsoluteUrl(payload.path)
            ?: return failOpen("Android network.sse.open requires an absolute http(s) URL.")

        val streamId = "stream-${streamCounter.incrementAndGet()}"
        val eventName = "network.sse.event.$streamId"

        val session = SseSession(
            streamId = streamId,
            eventName = eventName,
            url = url,
            headers = normalizeHeaders(payload.headers),
            onEvent = payload.onEvent,
            retryDelayMs = AtomicLong(defaultRetryDelayMs.coerceAtLeast(0L)),
        )
        sessions[streamId] = session

        val openResult = startEventSource(session, awaitOpen = true)
        if (!openResult) {
            cleanupSession(streamId)
            val errorMessage = session.lastError.get() ?: "SSE open failed"
            return failOpen(errorMessage, ERROR_CODE_PROTOCOL)
        }

        return NetworkSseOpenResult(
            status = NetworkBridgeMethodStatus.SUCCESS,
            statusMessage = "ok",
            streamId = streamId,
            eventName = eventName,
            errorCode = null,
            errorMessage = null,
        )
    }

    override fun close(payload: NetworkSseClosePayload): NetworkSseCloseResult {
        val session = sessions.remove(payload.id)
        if (session == null) {
            return NetworkSseCloseResult(
                status = NetworkBridgeMethodStatus.SUCCESS,
                statusMessage = "ok",
                closed = false,
                errorCode = null,
                errorMessage = null,
            )
        }

        disposeSession(session)
        return NetworkSseCloseResult(
            status = NetworkBridgeMethodStatus.SUCCESS,
            statusMessage = "ok",
            closed = true,
            errorCode = null,
            errorMessage = null,
        )
    }

    private fun startEventSource(session: SseSession, awaitOpen: Boolean): Boolean {
        if (session.closed.get()) return false

        val openLatch = if (awaitOpen) CountDownLatch(1) else null
        val openSuccess = AtomicBoolean(false)

        val requestBuilder = Request.Builder().url(session.url).get()
        for ((name, value) in session.headers) {
            requestBuilder.addHeader(name, value)
        }
        val lastEventId = session.lastEventId.get()?.trim()?.takeIf { it.isNotEmpty() }
        if (lastEventId != null) {
            requestBuilder.addHeader("Last-Event-ID", lastEventId)
        }

        val listener = object : EventSourceListener() {
            override fun onOpen(eventSource: EventSource, response: Response) {
                if (session.closed.get()) {
                    eventSource.cancel()
                    openLatch?.countDown()
                    return
                }
                session.opened.set(true)
                session.reconnectAttempt.set(0)
                openSuccess.set(true)
                openLatch?.countDown()
            }

            override fun onEvent(
                eventSource: EventSource,
                id: String?,
                type: String?,
                data: String,
            ) {
                if (session.closed.get()) return

                id?.let { session.lastEventId.set(it) }

                val payload = mutableMapOf<String, Any>(
                    "stream_id" to session.streamId,
                    "event_name" to session.eventName,
                    "event" to (type ?: "message"),
                    "data" to data,
                )
                id?.let { payload["id"] = it }

                try {
                    session.onEvent?.invoke(session.eventName, payload)
                } catch (_: Throwable) {
                }
            }

            override fun onFailure(
                eventSource: EventSource,
                t: Throwable?,
                response: Response?,
            ) {
                session.lastError.set(t?.message ?: "SSE connection failed")

                if (!session.opened.get()) {
                    openLatch?.countDown()
                    return
                }

                if (session.closed.get()) return

                scheduleReconnect(session)
            }

            override fun onClosed(eventSource: EventSource) {
                if (session.closed.get()) return
                scheduleReconnect(session)
            }
        }

        val factory = EventSources.createFactory(client)
        val eventSource = factory.newEventSource(requestBuilder.build(), listener)
        session.activeSource.getAndSet(eventSource)?.cancel()

        if (openLatch != null) {
            val opened = openLatch.await(openTimeoutMs, TimeUnit.MILLISECONDS)
            if (!opened) {
                eventSource.cancel()
                session.lastError.set("SSE open timed out after ${openTimeoutMs}ms")
                return false
            }
            return openSuccess.get()
        }

        return true
    }

    private fun scheduleReconnect(session: SseSession) {
        if (!reconnectEnabled || session.closed.get()) return

        val attempt = session.reconnectAttempt.incrementAndGet()
        val baseDelay = session.retryDelayMs.get().coerceIn(0L, maxRetryDelayMs)
        val backoffShift = minOf(attempt - 1, 5)
        val delayMs = (baseDelay * (1L shl backoffShift)).coerceAtMost(maxRetryDelayMs)

        val future = session.scheduler.schedule(
            {
                if (!session.closed.get()) {
                    startEventSource(session, awaitOpen = false)
                }
            },
            delayMs,
            TimeUnit.MILLISECONDS,
        )
        session.reconnectFuture.getAndSet(future)?.cancel(true)
    }

    private fun normalizeHeaders(headers: Map<String, Any>?): Map<String, String> {
        if (headers.isNullOrEmpty()) return emptyMap()
        val normalized = mutableMapOf<String, String>()
        for ((key, value) in headers) {
            val name = key.trim()
            if (name.isEmpty()) continue
            normalized[name] = value.toString()
        }
        return normalized
    }

    private fun resolveAbsoluteUrl(path: String): String? {
        val trimmed = path.trim()
        if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
            return trimmed
        }
        return null
    }

    private fun cleanupSession(streamId: String) {
        val session = sessions.remove(streamId) ?: return
        disposeSession(session)
    }

    private fun disposeSession(session: SseSession) {
        session.closed.set(true)
        session.reconnectFuture.getAndSet(null)?.cancel(true)
        session.activeSource.getAndSet(null)?.cancel()
        try {
            session.scheduler.shutdownNow()
        } catch (_: Throwable) {
        }
    }

    private fun failOpen(
        message: String,
        errorCode: String = ERROR_CODE_UNAVAILABLE,
    ): NetworkSseOpenResult {
        return NetworkSseOpenResult(
            status = NetworkBridgeMethodStatus.FAIL,
            statusMessage = message,
            streamId = null,
            eventName = null,
            errorCode = errorCode,
            errorMessage = message,
        )
    }

    private class SseSession(
        val streamId: String,
        val eventName: String,
        val url: String,
        val headers: Map<String, String>,
        val onEvent: ((eventName: String, payload: Map<String, Any>) -> Unit)?,
        val retryDelayMs: AtomicLong,
        val reconnectAttempt: AtomicInteger = AtomicInteger(0),
        val opened: AtomicBoolean = AtomicBoolean(false),
        val closed: AtomicBoolean = AtomicBoolean(false),
        val lastEventId: AtomicReference<String?> = AtomicReference(null),
        val lastError: AtomicReference<String?> = AtomicReference(null),
        val activeSource: AtomicReference<EventSource?> = AtomicReference(null),
        val reconnectFuture: AtomicReference<ScheduledFuture<*>?> = AtomicReference(null),
        val scheduler: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor(),
    )

    companion object {
        private const val ERROR_CODE_UNAVAILABLE = "bridge_unavailable"
        private const val ERROR_CODE_PROTOCOL = "bridge_protocol"
    }
}
