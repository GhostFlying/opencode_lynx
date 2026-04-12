package com.opencode.lynx

object DevSourceStartupOverrideState {
    @Volatile
    private var pendingScheme: String? = null

    fun updatePendingScheme(scheme: String?) {
        pendingScheme = scheme
    }

    fun consumePendingScheme(): String? {
        val value = pendingScheme
        pendingScheme = null
        return value
    }
}
