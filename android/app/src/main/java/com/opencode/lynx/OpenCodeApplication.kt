package com.opencode.lynx

import android.app.Application
import com.facebook.drawee.backends.pipeline.Fresco
import com.facebook.imagepipeline.core.ImagePipelineConfig
import com.facebook.imagepipeline.memory.PoolConfig
import com.facebook.imagepipeline.memory.PoolFactory

class OpenCodeApplication : Application() {

    override fun onCreate() {
        super.onCreate()
        initFresco()
        // Lynx SDK initialization happens lazily when LynxViewBuilder is first used.
    }

    private fun initFresco() {
        val factory = PoolFactory(PoolConfig.newBuilder().build())
        val builder = ImagePipelineConfig.newBuilder(applicationContext).setPoolFactory(factory)
        Fresco.initialize(applicationContext, builder.build())
    }
}
