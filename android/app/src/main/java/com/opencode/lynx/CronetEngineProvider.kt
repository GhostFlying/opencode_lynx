package com.opencode.lynx

import android.content.Context
import org.chromium.net.CronetEngine
import org.chromium.net.UrlRequest
import java.util.concurrent.Executor

data class CronetStartupConfig(
    val userAgent: String? = null,
    val storagePath: String? = null,
    val enableQuic: Boolean = true,
    val enableHttp2: Boolean = true,
    val enableBrotli: Boolean = true,
)

data class CronetEngineAvailability(
    val available: Boolean,
    val state: String,
    val reason: String? = null,
)

fun interface CronetContextProvider {
    fun context(): Context?
}

fun interface CronetAvailabilitySource {
    fun availability(): CronetEngineAvailability
}

interface CronetEngineHandle {
    fun shutdown()

    fun engine(): CronetEngine? {
        return null
    }

    fun newUrlRequestBuilder(
        url: String,
        callback: UrlRequest.Callback,
        executor: Executor,
    ): UrlRequest.Builder? {
        return null
    }
}

fun interface CronetEngineFactory {
    fun create(
        context: Context?,
        config: CronetStartupConfig,
    ): CronetEngineHandle
}

private class DefaultCronetEngineFactory : CronetEngineFactory {
    override fun create(
        context: Context?,
        config: CronetStartupConfig,
    ): CronetEngineHandle {
        val resolvedContext = context
            ?: throw IllegalStateException("missing_application_context")

        val builder = CronetEngine.Builder(resolvedContext)
            .enableQuic(config.enableQuic)
            .enableHttp2(config.enableHttp2)
            .enableBrotli(config.enableBrotli)

        config.userAgent
            ?.trim()
            ?.takeIf { it.isNotEmpty() }
            ?.let { builder.setUserAgent(it) }

        config.storagePath
            ?.trim()
            ?.takeIf { it.isNotEmpty() }
            ?.let { builder.setStoragePath(it) }

        val engine = builder.build()
        return object : CronetEngineHandle {
            override fun engine(): CronetEngine = engine

            override fun shutdown() {
                engine.shutdown()
            }

            override fun newUrlRequestBuilder(
                url: String,
                callback: UrlRequest.Callback,
                executor: Executor,
            ): UrlRequest.Builder {
                return engine.newUrlRequestBuilder(url, callback, executor)
            }
        }
    }
}

class CronetEngineProvider(
    private val contextProvider: CronetContextProvider = CronetContextProvider { resolveApplicationContext() },
    private val factory: CronetEngineFactory = DefaultCronetEngineFactory(),
) : CronetAvailabilitySource {

    private val lock = Any()
    private var startupConfig: CronetStartupConfig? = null
    private var engineHandle: CronetEngineHandle? = null
    private var initFailureReason: String? = null
    private var shutdownGuarded: Boolean = false

    fun startup(config: CronetStartupConfig = CronetStartupConfig()): CronetEngineAvailability {
        synchronized(lock) {
            if (shutdownGuarded) {
                return unavailable(
                    state = STATE_SHUTDOWN_GUARDED,
                    reason = REASON_SHUTDOWN_GUARD,
                )
            }

            val existingEngine = engineHandle
            if (existingEngine != null) {
                return available()
            }

            startupConfig = config

            return try {
                engineHandle = factory.create(
                    context = contextProvider.context(),
                    config = config,
                )
                initFailureReason = null
                available()
            } catch (error: Throwable) {
                engineHandle = null
                initFailureReason = error.message
                    ?.takeIf { it.isNotBlank() }
                    ?: error::class.java.simpleName
                unavailable(
                    state = STATE_INIT_FAILED,
                    reason = initFailureReason,
                )
            }
        }
    }

    fun shutdown(): CronetEngineAvailability {
        synchronized(lock) {
            if (shutdownGuarded) {
                return unavailable(
                    state = STATE_SHUTDOWN_GUARDED,
                    reason = REASON_ALREADY_SHUTDOWN,
                )
            }

            shutdownGuarded = true
            val handle = engineHandle
            engineHandle = null
            initFailureReason = null

            try {
                handle?.shutdown()
            } catch (_: Throwable) {
            }

            return unavailable(
                state = STATE_SHUTDOWN_GUARDED,
                reason = REASON_SHUTDOWN_GUARD,
            )
        }
    }

    fun currentStartupConfig(): CronetStartupConfig? {
        synchronized(lock) {
            return startupConfig
        }
    }

    fun cronetEngine(): CronetEngine? {
        synchronized(lock) {
            return engineHandle?.engine()
        }
    }

    fun newUrlRequestBuilder(
        url: String,
        callback: UrlRequest.Callback,
        executor: Executor,
    ): UrlRequest.Builder? {
        synchronized(lock) {
            return engineHandle?.newUrlRequestBuilder(url, callback, executor)
        }
    }

    override fun availability(): CronetEngineAvailability {
        synchronized(lock) {
            if (shutdownGuarded) {
                return unavailable(
                    state = STATE_SHUTDOWN_GUARDED,
                    reason = REASON_SHUTDOWN_GUARD,
                )
            }

            if (engineHandle != null) {
                return available()
            }

            if (initFailureReason != null) {
                return unavailable(
                    state = STATE_INIT_FAILED,
                    reason = initFailureReason,
                )
            }

            return unavailable(
                state = STATE_NOT_STARTED,
                reason = REASON_STARTUP_REQUIRED,
            )
        }
    }

    private fun available(): CronetEngineAvailability {
        return CronetEngineAvailability(
            available = true,
            state = STATE_READY,
            reason = null,
        )
    }

    private fun unavailable(
        state: String,
        reason: String?,
    ): CronetEngineAvailability {
        return CronetEngineAvailability(
            available = false,
            state = state,
            reason = reason,
        )
    }

    companion object {
        const val STATE_READY = "ready"
        const val STATE_NOT_STARTED = "not_started"
        const val STATE_INIT_FAILED = "init_failed"
        const val STATE_SHUTDOWN_GUARDED = "shutdown_guarded"

        const val REASON_STARTUP_REQUIRED = "startup_required"
        const val REASON_SHUTDOWN_GUARD = "shutdown_guard"
        const val REASON_ALREADY_SHUTDOWN = "already_shutdown"

        val shared: CronetEngineProvider by lazy {
            CronetEngineProvider()
        }

        private fun resolveApplicationContext(): Context? {
            return try {
                val activityThreadClass = Class.forName("android.app.ActivityThread")
                val currentApplicationMethod = activityThreadClass.getMethod("currentApplication")
                currentApplicationMethod.invoke(null) as? Context
            } catch (_: Throwable) {
                null
            }
        }
    }
}
