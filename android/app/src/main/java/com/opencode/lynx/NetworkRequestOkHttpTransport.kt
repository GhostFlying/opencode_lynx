package com.opencode.lynx

import com.google.net.cronet.okhttptransport.CronetInterceptor
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.SocketTimeoutException
import java.nio.charset.StandardCharsets
import java.util.concurrent.TimeUnit

class NetworkRequestOkHttpTransport(
    private val clientFactory: () -> OkHttpClient = { buildDefaultClient() },
) : NetworkRequestTransport {

    private val client: OkHttpClient by lazy { clientFactory() }

    override fun execute(payload: NetworkRequestPayload): NetworkRequestResult {
        val url = resolveAbsoluteUrl(payload.path)
            ?: return unavailable("Android network.request requires an absolute http(s) URL.")

        val method = payload.method?.trim()?.uppercase()?.ifEmpty { "GET" } ?: "GET"

        try {
            val requestBuilder = Request.Builder().url(url)
            val contentType = applyHeaders(requestBuilder, payload.headers)
            val body = buildBody(payload.body, contentType)

            val resolvedBody = when {
                method == "GET" || method == "HEAD" -> null
                body != null -> body
                else -> ByteArray(0).toRequestBody(null)
            }

            val request = when (method) {
                "GET" -> requestBuilder.get().build()
                "HEAD" -> requestBuilder.head().build()
                else -> requestBuilder.method(method, resolvedBody).build()
            }

            val response = client.newCall(request).execute()
            response.use { resp ->
                val statusCode = resp.code
                val headers = flattenHeaders(resp)
                val responseBody = resp.body?.string()

                return NetworkRequestResult(
                    status = NetworkBridgeMethodStatus.SUCCESS,
                    statusMessage = "ok",
                    ok = statusCode in 200..299,
                    statusCode = statusCode,
                    headers = headers,
                    body = responseBody,
                    errorCode = null,
                    errorMessage = null,
                )
            }
        } catch (e: SocketTimeoutException) {
            return NetworkRequestResult(
                status = NetworkBridgeMethodStatus.FAIL,
                statusMessage = "Request timed out",
                ok = false,
                statusCode = HTTP_STATUS_GATEWAY_TIMEOUT,
                headers = emptyMap(),
                body = null,
                errorCode = ERROR_CODE_TIMEOUT,
                errorMessage = e.message ?: "Request timed out",
            )
        } catch (e: IOException) {
            return NetworkRequestResult(
                status = NetworkBridgeMethodStatus.FAIL,
                statusMessage = "Request failed",
                ok = false,
                statusCode = HTTP_STATUS_BAD_GATEWAY,
                headers = emptyMap(),
                body = null,
                errorCode = ERROR_CODE_PROTOCOL,
                errorMessage = e.message ?: "Request failed",
            )
        } catch (e: Throwable) {
            return NetworkRequestResult(
                status = NetworkBridgeMethodStatus.FAIL,
                statusMessage = "Request execution failed",
                ok = false,
                statusCode = HTTP_STATUS_BAD_GATEWAY,
                headers = emptyMap(),
                body = null,
                errorCode = ERROR_CODE_PROTOCOL,
                errorMessage = e.message ?: "Request execution failed",
            )
        }
    }

    private fun resolveAbsoluteUrl(path: String): String? {
        val trimmed = path.trim()
        if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
            return trimmed
        }
        return null
    }

    private fun applyHeaders(builder: Request.Builder, headers: Map<String, Any>?): String? {
        var contentType: String? = null
        if (headers.isNullOrEmpty()) return null

        for ((key, value) in headers) {
            val name = key.trim()
            if (name.isEmpty()) continue
            val textValue = if (value is String) value else value.toString()
            if (name.equals("content-type", ignoreCase = true)) {
                contentType = textValue
            }
            builder.addHeader(name, textValue)
        }
        return contentType
    }

    private fun buildBody(body: Any?, contentType: String?): okhttp3.RequestBody? {
        val bytes = when (body) {
            null -> return null
            is ByteArray -> body
            is String -> body.toByteArray(StandardCharsets.UTF_8)
            else -> body.toString().toByteArray(StandardCharsets.UTF_8)
        }
        if (bytes.isEmpty()) return null

        val mediaType = contentType?.toMediaTypeOrNull()
            ?: "application/octet-stream".toMediaTypeOrNull()
        return bytes.toRequestBody(mediaType)
    }

    private fun flattenHeaders(response: okhttp3.Response): Map<String, String> {
        val result = mutableMapOf<String, String>()
        for (name in response.headers.names()) {
            result[name] = response.headers.values(name).joinToString(",")
        }
        return result
    }

    private fun unavailable(message: String): NetworkRequestResult {
        return NetworkRequestResult(
            status = NetworkBridgeMethodStatus.FAIL,
            statusMessage = message,
            ok = false,
            statusCode = HTTP_STATUS_SERVICE_UNAVAILABLE,
            headers = emptyMap(),
            body = null,
            errorCode = ERROR_CODE_UNAVAILABLE,
            errorMessage = message,
        )
    }

    companion object {
        private const val HTTP_STATUS_SERVICE_UNAVAILABLE = 503
        private const val HTTP_STATUS_GATEWAY_TIMEOUT = 504
        private const val HTTP_STATUS_BAD_GATEWAY = 502

        private const val ERROR_CODE_UNAVAILABLE = "bridge_unavailable"
        private const val ERROR_CODE_TIMEOUT = "bridge_timeout"
        private const val ERROR_CODE_PROTOCOL = "bridge_protocol"

        private const val DEFAULT_TIMEOUT_MS = 30_000L

        fun buildDefaultClient(
            cronetEngineProvider: CronetEngineProvider = CronetEngineProvider.shared,
            timeoutMs: Long = DEFAULT_TIMEOUT_MS,
        ): OkHttpClient {
            val builder = OkHttpClient.Builder()
                .connectTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                .writeTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                .followRedirects(true)
                .followSslRedirects(true)

            try {
                cronetEngineProvider.startup()
                val engine = cronetEngineProvider.cronetEngine()
                if (engine != null) {
                    builder.addInterceptor(CronetInterceptor.newBuilder(engine).build())
                }
            } catch (_: Throwable) {
                // Fall back to plain OkHttp if Cronet setup fails
            }

            return builder.build()
        }
    }
}
