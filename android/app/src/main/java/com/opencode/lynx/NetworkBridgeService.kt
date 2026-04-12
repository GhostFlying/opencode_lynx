package com.opencode.lynx

enum class NetworkBridgeMethodStatus {
    SUCCESS,
    INVALID_PARAM,
    FAIL,
}

data class NetworkRequestPayload(
    val path: String,
    val method: String?,
    val headers: Map<String, Any>?,
    val body: Any?,
)

data class NetworkRequestResult(
    val status: NetworkBridgeMethodStatus,
    val statusMessage: String,
    val ok: Boolean,
    val statusCode: Int,
    val headers: Map<String, String>,
    val body: Any?,
    val errorCode: String?,
    val errorMessage: String?,
)

data class NetworkSseOpenPayload(
    val path: String,
    val headers: Map<String, Any>?,
    val onEvent: ((eventName: String, payload: Map<String, Any>) -> Unit)? = null,
)

data class NetworkSseOpenResult(
    val status: NetworkBridgeMethodStatus,
    val statusMessage: String,
    val streamId: String?,
    val eventName: String?,
    val errorCode: String?,
    val errorMessage: String?,
)

data class NetworkSseClosePayload(
    val id: String,
)

data class NetworkSseCloseResult(
    val status: NetworkBridgeMethodStatus,
    val statusMessage: String,
    val closed: Boolean,
    val errorCode: String?,
    val errorMessage: String?,
)

interface NetworkRequestTransport {
    fun execute(payload: NetworkRequestPayload): NetworkRequestResult
}

interface NetworkSseTransport {
    fun open(payload: NetworkSseOpenPayload): NetworkSseOpenResult
    fun close(payload: NetworkSseClosePayload): NetworkSseCloseResult
}

interface NetworkBridgeService {
    fun request(payload: NetworkRequestPayload): NetworkRequestResult
    fun openSse(payload: NetworkSseOpenPayload): NetworkSseOpenResult
    fun closeSse(payload: NetworkSseClosePayload): NetworkSseCloseResult
}

class NetworkBridgeServiceImpl(
    private val requestTransport: NetworkRequestTransport = NetworkRequestOkHttpTransport(),
    private val sseTransport: NetworkSseTransport = NetworkSseOkHttpTransport(),
) : NetworkBridgeService {

    override fun request(payload: NetworkRequestPayload): NetworkRequestResult {
        val path = payload.path.trim()
        val method = payload.method?.trim()?.uppercase().orEmpty().ifEmpty { "GET" }

        if (path.isEmpty() || !isAbsoluteUrl(path)) {
            return invalidRequestResult("Invalid network.request payload")
        }

        if (method !in ALLOWED_METHODS) {
            return invalidRequestResult("Invalid network.request payload")
        }

        return requestTransport.execute(
            payload = NetworkRequestPayload(
                path = path,
                method = method,
                headers = payload.headers,
                body = payload.body,
            ),
        )
    }

    override fun openSse(payload: NetworkSseOpenPayload): NetworkSseOpenResult {
        val path = payload.path.trim()
        if (path.isEmpty() || !isAbsoluteUrl(path)) {
            return NetworkSseOpenResult(
                status = NetworkBridgeMethodStatus.INVALID_PARAM,
                statusMessage = "Invalid network.sse.open payload",
                streamId = null,
                eventName = null,
                errorCode = "invalid_param",
                errorMessage = "Invalid network.sse.open payload",
            )
        }

        return sseTransport.open(
            NetworkSseOpenPayload(
                path = path,
                headers = payload.headers,
                onEvent = payload.onEvent,
            ),
        )
    }

    override fun closeSse(payload: NetworkSseClosePayload): NetworkSseCloseResult {
        val streamId = payload.id.trim()
        if (streamId.isEmpty()) {
            return NetworkSseCloseResult(
                status = NetworkBridgeMethodStatus.INVALID_PARAM,
                statusMessage = "Invalid network.sse.close payload",
                closed = false,
                errorCode = "invalid_param",
                errorMessage = "Invalid network.sse.close payload",
            )
        }

        return sseTransport.close(
            NetworkSseClosePayload(
                id = streamId,
            ),
        )
    }

    private fun invalidRequestResult(message: String): NetworkRequestResult {
        return NetworkRequestResult(
            status = NetworkBridgeMethodStatus.INVALID_PARAM,
            statusMessage = message,
            ok = false,
            statusCode = 400,
            headers = emptyMap(),
            body = null,
            errorCode = "invalid_param",
            errorMessage = message,
        )
    }

    private fun isAbsoluteUrl(path: String): Boolean {
        return path.startsWith("http://") || path.startsWith("https://")
    }

    companion object {
        val shared: NetworkBridgeServiceImpl by lazy {
            NetworkBridgeServiceImpl()
        }

        private val ALLOWED_METHODS = setOf(
            "GET",
            "POST",
            "PUT",
            "PATCH",
            "DELETE",
            "HEAD",
            "OPTIONS",
        )
    }
}
