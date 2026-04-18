package com.opencode.lynx

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import androidx.appcompat.app.AppCompatActivity

class SplashActivity : AppCompatActivity() {
    private companion object {
        private const val TAG = "SplashActivity"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        OpenCodeActivityStack.push(this)
        launchLynxPage(incomingUri = intent?.data)
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        launchLynxPage(incomingUri = intent?.data)
    }

    private fun launchLynxPage(incomingUri: Uri?) {
        val source = if (incomingUri != null) "cold_start" else "startup"
        val resolved = DevSourceDeepLinkParser.resolve(
            incomingUri = incomingUri,
            consumedOverrideScheme = DevSourceStartupOverrideState.consumePendingScheme(),
            source = source,
        )
        resolved.logs.forEach { Log.i(TAG, it) }

        val intent = Intent(this, OpenCodeLynxActivity::class.java)
        intent.putExtra("scheme", resolved.selectedScheme)
        startActivity(intent)
        finish()
    }

    override fun onDestroy() {
        OpenCodeActivityStack.remove(this)
        super.onDestroy()
    }
}
