package com.opencode.lynx

import android.app.Application
import android.util.Log
import com.facebook.drawee.backends.pipeline.Fresco
import com.facebook.imagepipeline.core.ImagePipelineConfig
import com.facebook.imagepipeline.memory.PoolConfig
import com.facebook.imagepipeline.memory.PoolFactory
import com.lynx.service.image.LynxImageService
import com.lynx.service.log.LynxLogService
import com.lynx.tasm.LynxEnv
import com.lynx.tasm.service.LynxServiceCenter

class OpenCodeApplication : Application() {

    override fun onCreate() {
        super.onCreate()
        initFresco()
        initLynxEnv()
    }

    private fun initFresco() {
        val factory = PoolFactory(PoolConfig.newBuilder().build())
        val builder = ImagePipelineConfig.newBuilder(applicationContext).setPoolFactory(factory)
        Fresco.initialize(applicationContext, builder.build())
    }

    private fun initLynxEnv() {
        // LynxEnv must be initialized on the main thread before any LynxView
        // is instantiated, otherwise renderTemplateUrl fails with
        // "LynxEnv has not been prepared successfully!" (sub_code 10202).
        //
        // Register LynxLogService so JS `console.info` / `console.warn` from
        // Lynx bundles reaches Android logcat — without it the default log
        // channel is native-only, which means our QA markers emitted via
        // console.info never appear in instrumented tests that grep logcat.
        //
        // Guard with try/catch so a native-init failure (e.g. missing .so on
        // some emulator ABIs) doesn't tear down the whole app — the Lynx
        // screens will report their own error in that case.
        try {
            LynxServiceCenter.inst().initialize(this)
            LynxServiceCenter.inst().registerService(LynxLogService)
            LynxServiceCenter.inst().registerService(LynxImageService.getInstance())
            LynxLogService.switchLogToSystem(true)
            LynxEnv.inst().init(this, null, null, null)
        } catch (t: Throwable) {
            Log.e("OpenCodeApplication", "LynxEnv.init failed", t)
        }
    }
}
