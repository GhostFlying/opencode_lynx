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

    @Test
    fun parserPolicy_allowsMainBundleHybridTarget() {
        val allowed = isAllowedTarget("hybrid://lynxview_page?bundle=main.lynx.bundle&hide_nav_bar=1")
        assertTrue(allowed)
    }

    @Test
    fun parserPolicy_rejectsMissingMainBundleEvenIfHybridPage() {
        val allowed = isAllowedTarget("hybrid://lynxview_page?bundle=other.bundle&hide_nav_bar=1")
        assertFalse(allowed)
    }

    @Test
    fun parserPolicy_rejectsNonHybridScheme() {
        val allowed = isAllowedTarget("https://example.com/main.lynx.bundle")
        assertFalse(allowed)
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
