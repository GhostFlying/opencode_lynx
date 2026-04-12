package com.opencode.lynx

import android.net.Uri

data class DevSourceDecision(
    val selectedScheme: String,
    val logs: List<String>,
)

object DevSourceDeepLinkParser {
    private const val MARKER_PREFIX = "qa_dev_source_deeplink_v1"
    private const val OUTER_SCHEME = "opencode-lynx"
    private const val OUTER_HOST = "dev-source"
    private const val FALLBACK_SCHEME = "hybrid://lynxview_page?bundle=main.lynx.bundle&hide_nav_bar=1&screen_orientation=portrait"

    fun resolve(
        incomingUri: Uri?,
        consumedOverrideScheme: String?,
        source: String,
    ): DevSourceDecision {
        val logs = mutableListOf<String>()

        var acceptedFromIncoming: String? = null
        if (incomingUri != null) {
            logs += "$MARKER_PREFIX|event=incoming|source=$source|target=$incomingUri"
            acceptedFromIncoming = parseIncomingOverride(incomingUri)
            if (acceptedFromIncoming != null) {
                logs += "$MARKER_PREFIX|event=decision|source=$source|reason=accepted|target=$acceptedFromIncoming"
            } else {
                logs += "$MARKER_PREFIX|event=decision|source=$source|reason=invalid_target"
            }
        }

        val selected = when {
            !consumedOverrideScheme.isNullOrBlank() -> {
                logs += "$MARKER_PREFIX|event=consumed|source=startup|reason=consumed|target=$consumedOverrideScheme"
                consumedOverrideScheme
            }
            !acceptedFromIncoming.isNullOrBlank() -> {
                logs += "$MARKER_PREFIX|event=consumed|source=startup|reason=consumed|target=$acceptedFromIncoming"
                acceptedFromIncoming
            }
            else -> {
                logs += "$MARKER_PREFIX|event=decision|source=startup|reason=fallback_default"
                FALLBACK_SCHEME
            }
        }

        val transitionTarget = if (selected == FALLBACK_SCHEME) "default_main" else "startup_override"
        logs += "$MARKER_PREFIX|event=transition|source=startup|to=$transitionTarget${selected.takeIf { it != FALLBACK_SCHEME }?.let { "|target=$it" } ?: ""}"

        return DevSourceDecision(selectedScheme = selected, logs = logs)
    }

    private fun parseIncomingOverride(uri: Uri): String? {
        if (uri.scheme != OUTER_SCHEME || uri.host != OUTER_HOST) {
            return null
        }
        val encodedTarget = uri.getQueryParameter("target") ?: return null
        val decoded = Uri.decode(encodedTarget)
        return decoded.takeIf { isAllowedTarget(it) }
    }

    private fun isAllowedTarget(target: String): Boolean {
        return target.startsWith("hybrid://lynxview_page?") && target.contains("bundle=main.lynx.bundle")
    }
}
