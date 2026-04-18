package com.opencode.lynx

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DevSourceDeepLinkSelectorUnitTest {
    private fun isAllowedTarget(target: String): Boolean {
        val method = DevSourceDeepLinkParser::class.java.getDeclaredMethod(
            "isAllowedTarget",
            String::class.java,
        )
        method.isAccessible = true
        return method.invoke(DevSourceDeepLinkParser, target) as Boolean
    }

    private fun parseIncomingOverrideTarget(target: String): String? {
        val method = DevSourceDeepLinkParser::class.java.getDeclaredMethod(
            "parseIncomingOverrideTarget",
            String::class.java,
        )
        method.isAccessible = true
        return method.invoke(DevSourceDeepLinkParser, target) as String?
    }

    @Test
    fun parserPolicy_allowsMainBundleHybridTarget() {
        val allowed = isAllowedTarget("hybrid://lynxview_page?bundle=main.lynx.bundle&hide_nav_bar=1")
        assertTrue(allowed)
    }

    @Test
    fun parserPolicy_allowsAnyAppOwnedBundleHybridTarget() {
        // Policy aligned with iOS: no bundle-name whitelist. Structural check
        // only — hybrid scheme + lynxview/lynxview_page host + non-empty
        // bundle|url carrier.
        assertTrue(isAllowedTarget("hybrid://lynxview_page?bundle=second.lynx.bundle&title=x"))
        assertTrue(isAllowedTarget("hybrid://lynxview?bundle=chat.lynx.bundle&route_params=%7B%7D"))
    }

    @Test
    fun parserPolicy_rejectsMissingCarrier() {
        assertFalse(isAllowedTarget("hybrid://lynxview_page?hide_nav_bar=1"))
        assertFalse(isAllowedTarget("hybrid://lynxview_page?bundle=&hide_nav_bar=1"))
    }

    @Test
    fun parserPolicy_rejectsNonHybridScheme() {
        val allowed = isAllowedTarget("https://example.com/main.lynx.bundle")
        assertFalse(allowed)
    }

    @Test
    fun parserPolicy_rejectsUnknownInnerHost() {
        assertFalse(isAllowedTarget("hybrid://foo?bundle=main.lynx.bundle"))
    }

    @Test
    fun resolve_fallsBackToDefaultWhenNoIncomingAndNoConsumedOverride() {
        val decision = DevSourceDeepLinkParser.resolve(
            incomingUri = null,
            consumedOverrideScheme = null,
            source = "startup",
        )

        assertEquals(
            "hybrid://lynxview_page?bundle=main.lynx.bundle&hide_nav_bar=1&screen_orientation=portrait",
            decision.selectedScheme,
        )
        assertTrue(decision.logs.any { it.contains("event=decision") && it.contains("reason=fallback_default") })
        assertTrue(decision.logs.any { it.contains("event=transition") && it.contains("to=default_main") })
    }

    @Test
    fun resolve_prefersConsumedOverrideWhenProvided() {
        val consumed = "hybrid://lynxview_page?bundle=main.lynx.bundle&hide_nav_bar=0"

        val decision = DevSourceDeepLinkParser.resolve(
            incomingUri = null,
            consumedOverrideScheme = consumed,
            source = "startup",
        )

        assertEquals(consumed, decision.selectedScheme)
        assertTrue(decision.logs.any { it.contains("event=consumed") && it.contains("target=$consumed") })
        assertTrue(decision.logs.any { it.contains("event=transition") && it.contains("to=startup_override") })
    }

    @Test
    fun resolve_ignoresBlankConsumedOverrideAndFallsBack() {
        val decision = DevSourceDeepLinkParser.resolve(
            incomingUri = null,
            consumedOverrideScheme = "  ",
            source = "startup",
        )

        assertEquals(
            "hybrid://lynxview_page?bundle=main.lynx.bundle&hide_nav_bar=1&screen_orientation=portrait",
            decision.selectedScheme,
        )
        assertTrue(decision.logs.any { it.contains("event=decision") && it.contains("reason=fallback_default") })
    }

    @Test
    fun resolve_preservesNestedRouteParamsReservedCharacters() {
        val decodedTarget =
            "hybrid://lynxview?bundle=.%2Fchat.lynx.bundle&route_params=" +
                "%7B%22sessionId%22%3A%22ses_reserved%22%2C%22sessionTitle%22%3A%22A%20%26%20B%20%3D%20100%25%22%2C%22connection%22%3A%7B%22password%22%3A%22p%2540ss%26word%3D1%22%7D%7D"

        val parsed = parseIncomingOverrideTarget(decodedTarget)

        assertEquals(decodedTarget, parsed)
        assertTrue(parsed!!.contains("route_params=%7B"))
        assertTrue(parsed.contains("%25"))
        assertTrue(parsed.contains("%26"))
        assertTrue(parsed.contains("%3D"))
        assertFalse(parsed.contains("%2526"))
    }

    @Test
    fun parserPolicy_acceptsDecodedChatTargetWithReservedCharactersInRouteParams() {
        val allowed = isAllowedTarget(
            "hybrid://lynxview?bundle=.%2Fchat.lynx.bundle&route_params=" +
                "%7B%22sessionTitle%22%3A%22A%20%26%20B%20%3D%20100%25%22%7D",
        )
        assertTrue(allowed)
    }

    @Test
    fun startupOverrideState_consumesValueExactlyOnce() {
        DevSourceStartupOverrideState.updatePendingScheme("hybrid://lynxview_page?bundle=main.lynx.bundle")

        val firstConsume = DevSourceStartupOverrideState.consumePendingScheme()
        val secondConsume = DevSourceStartupOverrideState.consumePendingScheme()

        assertEquals("hybrid://lynxview_page?bundle=main.lynx.bundle", firstConsume)
        assertNull(secondConsume)
    }

    @Test
    fun startupOverrideState_lastWriteWinsBeforeConsume() {
        DevSourceStartupOverrideState.updatePendingScheme("hybrid://lynxview_page?bundle=first.lynx.bundle")
        DevSourceStartupOverrideState.updatePendingScheme("hybrid://lynxview_page?bundle=second.lynx.bundle")

        val consumed = DevSourceStartupOverrideState.consumePendingScheme()
        val afterConsume = DevSourceStartupOverrideState.consumePendingScheme()

        assertEquals("hybrid://lynxview_page?bundle=second.lynx.bundle", consumed)
        assertNull(afterConsume)
    }

}
