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
    private val ALLOWED_BUNDLES = setOf(
        "main.lynx.bundle",
        "./main.lynx.bundle",
        ".%2Fmain.lynx.bundle",
        "chat.lynx.bundle",
        "./chat.lynx.bundle",
        ".%2Fchat.lynx.bundle",
        "second.lynx.bundle",
        "./second.lynx.bundle",
        ".%2Fsecond.lynx.bundle",
    )

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
        val query = uri.encodedQuery ?: return null
        val targetPrefix = "target="
        val targetStart = query.indexOf(targetPrefix)
        if (targetStart < 0) return null
        val encodedTarget = query.substring(targetStart + targetPrefix.length)
        val decoded = Uri.decode(encodedTarget)
        return parseIncomingOverrideTarget(decoded)
    }

    private fun parseIncomingOverrideTarget(target: String): String? {
        return target.takeIf { isAllowedTarget(it) }
    }

    private fun isAllowedTarget(target: String): Boolean {
        // Pure-string validation so the same code runs under both Android
        // framework (instrumented) and plain JVM unit tests without a
        // Robolectric shadow for `android.net.Uri`.
        val schemeSep = target.indexOf("://")
        if (schemeSep <= 0) return false
        if (target.substring(0, schemeSep) != "hybrid") return false
        val afterScheme = target.substring(schemeSep + 3)
        val hostEnd = afterScheme.indexOfAny(charArrayOf('?', '/', '#'))
        val host = if (hostEnd < 0) afterScheme else afterScheme.substring(0, hostEnd)
        if (host !in ALLOWED_INNER_HOSTS) return false
        val queryStart = afterScheme.indexOf('?')
        if (queryStart < 0) return false
        val query = afterScheme.substring(queryStart + 1)
        val pairs = query.split('&')
        return pairs.any { pair ->
            val eq = pair.indexOf('=')
            if (eq <= 0) return@any false
            val key = pair.substring(0, eq)
            val value = pair.substring(eq + 1)
            (key == "bundle" || key == "url") && value.isNotEmpty()
        }
    }

    private val ALLOWED_INNER_HOSTS = setOf("lynxview_page", "lynxview")
}
