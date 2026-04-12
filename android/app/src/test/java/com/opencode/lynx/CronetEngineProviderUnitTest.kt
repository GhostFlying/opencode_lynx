package com.opencode.lynx

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class CronetEngineProviderUnitTest {
    private class CountingHandle(
        private val onShutdown: () -> Unit,
    ) : CronetEngineHandle {
        override fun shutdown() {
            onShutdown()
        }
    }

    @Test
    fun sharedInstanceIsSingletonLike() {
        assertSame(CronetEngineProvider.shared, CronetEngineProvider.shared)
    }

    @Test
    fun availabilityIsNotStartedBeforeStartup() {
        val provider = CronetEngineProvider(
            contextProvider = CronetContextProvider { null },
            factory = CronetEngineFactory { _, _ -> CountingHandle {} },
        )

        val availability = provider.availability()

        assertFalse(availability.available)
        assertEquals(CronetEngineProvider.STATE_NOT_STARTED, availability.state)
        assertEquals(CronetEngineProvider.REASON_STARTUP_REQUIRED, availability.reason)
    }

    @Test
    fun startupBuildsOnceAndReusesInitializedEngine() {
        var createdCount = 0
        var shutdownCount = 0

        val provider = CronetEngineProvider(
            contextProvider = CronetContextProvider { null },
            factory = CronetEngineFactory { _, _ ->
                createdCount += 1
                CountingHandle { shutdownCount += 1 }
            },
        )

        val first = provider.startup(
            CronetStartupConfig(
                userAgent = "agent-a",
                storagePath = "/tmp/cronet-a",
            ),
        )
        val second = provider.startup(
            CronetStartupConfig(
                userAgent = "agent-b",
                storagePath = "/tmp/cronet-b",
            ),
        )

        assertTrue(first.available)
        assertEquals(CronetEngineProvider.STATE_READY, first.state)
        assertTrue(second.available)
        assertEquals(1, createdCount)
        assertEquals(0, shutdownCount)
        assertEquals("agent-a", provider.currentStartupConfig()?.userAgent)
        assertEquals("/tmp/cronet-a", provider.currentStartupConfig()?.storagePath)
    }

    @Test
    fun initFailureDowngradesAvailabilityDeterministically() {
        val provider = CronetEngineProvider(
            contextProvider = CronetContextProvider { null },
            factory = CronetEngineFactory { _, _ -> throw IllegalStateException("test_init_failure") },
        )

        val startup = provider.startup(CronetStartupConfig())
        val availability = provider.availability()

        assertFalse(startup.available)
        assertEquals(CronetEngineProvider.STATE_INIT_FAILED, startup.state)
        assertEquals("test_init_failure", startup.reason)

        assertFalse(availability.available)
        assertEquals(CronetEngineProvider.STATE_INIT_FAILED, availability.state)
        assertEquals("test_init_failure", availability.reason)
    }

    @Test
    fun shutdownGuardsFutureStartupAndDoesNotCrashOnRepeatedCalls() {
        var createdCount = 0
        var shutdownCount = 0

        val provider = CronetEngineProvider(
            contextProvider = CronetContextProvider { null },
            factory = CronetEngineFactory { _, _ ->
                createdCount += 1
                CountingHandle { shutdownCount += 1 }
            },
        )

        provider.startup(CronetStartupConfig())
        val firstShutdown = provider.shutdown()
        val secondShutdown = provider.shutdown()
        val startupAfterShutdown = provider.startup(CronetStartupConfig(userAgent = "should-not-start"))
        val availability = provider.availability()

        assertEquals(1, createdCount)
        assertEquals(1, shutdownCount)

        assertFalse(firstShutdown.available)
        assertEquals(CronetEngineProvider.STATE_SHUTDOWN_GUARDED, firstShutdown.state)
        assertEquals(CronetEngineProvider.REASON_SHUTDOWN_GUARD, firstShutdown.reason)

        assertFalse(secondShutdown.available)
        assertEquals(CronetEngineProvider.STATE_SHUTDOWN_GUARDED, secondShutdown.state)
        assertEquals(CronetEngineProvider.REASON_ALREADY_SHUTDOWN, secondShutdown.reason)

        assertFalse(startupAfterShutdown.available)
        assertEquals(CronetEngineProvider.STATE_SHUTDOWN_GUARDED, startupAfterShutdown.state)
        assertEquals(CronetEngineProvider.REASON_SHUTDOWN_GUARD, startupAfterShutdown.reason)

        assertFalse(availability.available)
        assertEquals(CronetEngineProvider.STATE_SHUTDOWN_GUARDED, availability.state)
        assertEquals(CronetEngineProvider.REASON_SHUTDOWN_GUARD, availability.reason)
        assertNull(availability.reason?.takeIf { it.isEmpty() })
    }
}
