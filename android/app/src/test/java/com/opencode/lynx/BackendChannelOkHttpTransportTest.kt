package com.opencode.lynx

import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

private class EchoServerListener : WebSocketListener() {
    val opened = CountDownLatch(1)
    val received = LinkedBlockingQueue<String>()
    val recordedHeaders = LinkedBlockingQueue<RecordedRequest>()
    @Volatile var serverSocket: WebSocket? = null

    override fun onOpen(webSocket: WebSocket, response: Response) {
        serverSocket = webSocket
        opened.countDown()
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
        received.offer(text)
        webSocket.send(text)
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        webSocket.close(code, reason)
    }
}

class BackendChannelOkHttpTransportTest {
    private lateinit var server: MockWebServer
    private lateinit var listener: EchoServerListener

    @Before
    fun setUp() {
        server = MockWebServer()
        listener = EchoServerListener()
        server.enqueue(MockResponse().withWebSocketUpgrade(listener))
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun newTransport(): BackendChannelOkHttpTransport {
        return BackendChannelOkHttpTransport(
            clientFactory = { pingMs ->
                OkHttpClient.Builder()
                    .connectTimeout(5, TimeUnit.SECONDS)
                    .readTimeout(0, TimeUnit.MILLISECONDS)
                    .pingInterval(pingMs.coerceAtLeast(0L), TimeUnit.MILLISECONDS)
                    .build()
            },
        )
    }

    private fun wsUrl() = "ws://${server.hostName}:${server.port}/socket"

    @Test
    fun openConnectsAndEmitsOpenState() {
        val openLatch = CountDownLatch(1)
        val states = LinkedBlockingQueue<Map<String, Any>>()

        val result = newTransport().open(BackendChannelOpenPayload(
            url = wsUrl(),
            headers = mapOf("Authorization" to "Bearer test"),
            pingIntervalMs = 0L,
            onOpen = { openLatch.countDown() },
            onState = { state -> states.offer(state) },
        ))

        assertEquals(BackendChannelStatus.SUCCESS, result.status)
        assertNotNull(result.channelId)
        assertTrue(openLatch.await(5, TimeUnit.SECONDS))

        // Server saw the Authorization header.
        assertTrue(listener.opened.await(5, TimeUnit.SECONDS))
        val recordedRequest = server.takeRequest(5, TimeUnit.SECONDS)
        assertNotNull(recordedRequest)
        assertEquals("Bearer test", recordedRequest!!.getHeader("Authorization"))

        val openState = states.poll(5, TimeUnit.SECONDS)
        assertNotNull(openState)
        assertEquals("open", openState!!["state"])
    }

    @Test
    fun sendForwardsTextFrameAndEchoIsDelivered() {
        val openLatch = CountDownLatch(1)
        val frames = LinkedBlockingQueue<String>()

        val transport = newTransport()
        val openResult = transport.open(BackendChannelOpenPayload(
            url = wsUrl(),
            headers = null,
            pingIntervalMs = 0L,
            onOpen = { openLatch.countDown() },
            onTextFrame = { text -> frames.offer(text) },
            onState = { },
        ))
        assertTrue(openLatch.await(5, TimeUnit.SECONDS))

        val sent = transport.send(BackendChannelSendPayload(
            channelId = openResult.channelId!!,
            text = "{\"ping\":1}",
        ))
        assertEquals(BackendChannelStatus.SUCCESS, sent.status)
        assertTrue(sent.sent)

        val echoed = frames.poll(5, TimeUnit.SECONDS)
        assertEquals("{\"ping\":1}", echoed)
    }

    @Test
    fun sendOnUnknownChannelFails() {
        val res = newTransport().send(BackendChannelSendPayload(channelId = "ghost", text = "{}"))
        assertEquals(BackendChannelStatus.FAIL, res.status)
        assertEquals("channel_closed", res.errorCode)
        assertFalse(res.sent)
    }

    @Test
    fun closeStopsTransportAndEmitsClosedState() {
        val openLatch = CountDownLatch(1)
        val states = LinkedBlockingQueue<Map<String, Any>>()

        val transport = newTransport()
        val result = transport.open(BackendChannelOpenPayload(
            url = wsUrl(),
            headers = null,
            pingIntervalMs = 0L,
            onOpen = { openLatch.countDown() },
            onState = { state -> states.offer(state) },
        ))
        assertTrue(openLatch.await(5, TimeUnit.SECONDS))
        // Drain the open state.
        states.poll(5, TimeUnit.SECONDS)

        val close = transport.close(BackendChannelClosePayload(
            channelId = result.channelId!!,
            code = 1000,
            reason = "bye",
        ))
        assertEquals(BackendChannelStatus.SUCCESS, close.status)
        assertTrue(close.closed)

        val closedState = states.poll(5, TimeUnit.SECONDS)
        assertNotNull(closedState)
        assertEquals("closed", closedState!!["state"])

        // Subsequent send fails because the registry dropped the entry.
        val sendAfter = transport.send(BackendChannelSendPayload(channelId = result.channelId!!, text = "{}"))
        assertEquals("channel_closed", sendAfter.errorCode)
    }

    @Test
    fun rejectsNonWsUrl() {
        val res = newTransport().open(BackendChannelOpenPayload(
            url = "http://example.com",
            headers = null,
            pingIntervalMs = 0L,
        ))
        assertEquals(BackendChannelStatus.INVALID_PARAM, res.status)
        assertEquals("invalid_payload", res.errorCode)
        assertNull(res.channelId)
    }

    @Test
    fun concurrentChannelsAreIsolated() {
        // Second mock server for the second channel.
        val server2 = MockWebServer()
        val listener2 = EchoServerListener()
        server2.enqueue(MockResponse().withWebSocketUpgrade(listener2))
        server2.start()

        try {
            val open1 = CountDownLatch(1)
            val open2 = CountDownLatch(1)
            val frames1 = LinkedBlockingQueue<String>()
            val frames2 = LinkedBlockingQueue<String>()

            val transport = newTransport()

            val a = transport.open(BackendChannelOpenPayload(
                url = wsUrl(),
                headers = null,
                pingIntervalMs = 0L,
                onOpen = { open1.countDown() },
                onTextFrame = { frames1.offer(it) },
            ))
            val b = transport.open(BackendChannelOpenPayload(
                url = "ws://${server2.hostName}:${server2.port}/socket",
                headers = null,
                pingIntervalMs = 0L,
                onOpen = { open2.countDown() },
                onTextFrame = { frames2.offer(it) },
            ))

            assertTrue(open1.await(5, TimeUnit.SECONDS))
            assertTrue(open2.await(5, TimeUnit.SECONDS))

            transport.send(BackendChannelSendPayload(channelId = a.channelId!!, text = "to-a"))
            transport.send(BackendChannelSendPayload(channelId = b.channelId!!, text = "to-b"))

            assertEquals("to-a", frames1.poll(5, TimeUnit.SECONDS))
            assertEquals("to-b", frames2.poll(5, TimeUnit.SECONDS))

            // Closing one does not affect the other.
            transport.close(BackendChannelClosePayload(channelId = a.channelId!!, code = null, reason = null))
            transport.send(BackendChannelSendPayload(channelId = b.channelId!!, text = "still-alive"))
            assertEquals("still-alive", frames2.poll(5, TimeUnit.SECONDS))
        } finally {
            server2.shutdown()
        }
    }
}
