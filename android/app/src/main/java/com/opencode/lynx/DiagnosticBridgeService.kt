package com.opencode.lynx

import java.util.concurrent.ConcurrentHashMap

enum class DiagnosticPhase(val wireValue: String) {
    REACT_READY("react_ready"),
    UI_READY("ui_ready");

    companion object {
        fun fromWire(value: String): DiagnosticPhase? = values().firstOrNull { it.wireValue == value }
    }
}

enum class DiagnosticStatus(val wireValue: String) {
    OK("ok"),
    WARNING("warning"),
    ERROR("error");

    companion object {
        fun fromWire(value: String): DiagnosticStatus? = values().firstOrNull { it.wireValue == value }
    }
}

data class DiagnosticPayload(
    val reportId: String,
    val runId: String,
    val timestamp: Double?,
    val phase: String,
    val status: String,
    val reason: String?,
)

data class DiagnosticRecord(
    val reportId: String,
)

data class DiagnosticTransportResult(
    val ok: Boolean,
    val reason: String?,
)

class DiagnosticBridgeStore {
    private val seenKeys = ConcurrentHashMap.newKeySet<String>()

    fun ingest(reportId: String): Boolean {
        return !seenKeys.add(reportId)
    }

    fun reset() {
        seenKeys.clear()
    }
}

object DiagnosticBridgeRuntime {
    val sharedStore = DiagnosticBridgeStore()

    fun resetSharedStateForTests() {
        sharedStore.reset()
    }
}

object DiagnosticBridgeMode {
    private val lock = Any()
    private var testModeOverride: Boolean? = null

    fun setTestModeOverride(enabled: Boolean?) {
        synchronized(lock) {
            testModeOverride = enabled
        }
    }

    fun isEnabled(): Boolean {
        val override = synchronized(lock) { testModeOverride }
        if (override != null) {
            return override
        }
        return java.lang.Boolean.getBoolean("NATIVE_DIAGNOSTIC_BRIDGE_TEST_MODE")
    }
}

interface DiagnosticBridgeService {
    fun report(payload: DiagnosticPayload): DiagnosticTransportResult
}

class DiagnosticBridgeServiceImpl(
    private val modeChecker: () -> Boolean = { DiagnosticBridgeMode.isEnabled() },
    private val store: DiagnosticBridgeStore = DiagnosticBridgeRuntime.sharedStore,
) : DiagnosticBridgeService {
    override fun report(payload: DiagnosticPayload): DiagnosticTransportResult {
        if (!modeChecker()) {
            return makeResult(ok = false, reason = "disabled")
        }

        val validated = validate(payload)
            ?: return makeResult(ok = false, reason = "invalid_payload")

        val isDuplicate = store.ingest(validated.reportId)
        if (isDuplicate) {
            return makeResult(ok = true, reason = "duplicate_ignored")
        }

        return makeResult(ok = true, reason = null)
    }

    private fun validate(payload: DiagnosticPayload): DiagnosticRecord? {
        val reportId = payload.reportId.trim()
        val runId = payload.runId.trim()
        if (reportId.isEmpty() || runId.isEmpty()) {
            return null
        }

        val status = DiagnosticStatus.fromWire(payload.status) ?: return null
        if (DiagnosticPhase.fromWire(payload.phase) == null) {
            return null
        }

        val timestamp = payload.timestamp ?: return null
        if (timestamp <= 0.0) {
            return null
        }

        val reason = payload.reason?.trim().orEmpty()
        if ((status == DiagnosticStatus.WARNING || status == DiagnosticStatus.ERROR) && reason.isEmpty()) {
            return null
        }

        return DiagnosticRecord(
            reportId = reportId,
        )
    }

    private fun makeResult(
        ok: Boolean,
        reason: String?,
    ): DiagnosticTransportResult {
        return DiagnosticTransportResult(
            ok = ok,
            reason = reason,
        )
    }
}
