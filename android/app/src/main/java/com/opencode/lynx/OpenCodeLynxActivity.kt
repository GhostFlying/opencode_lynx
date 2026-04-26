package com.opencode.lynx

import android.app.Activity
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.lynx.react.bridge.JavaOnlyArray
import com.lynx.service.image.LynxImageService
import com.lynx.tasm.LynxLoadMeta
import com.lynx.tasm.LynxView
import com.lynx.tasm.LynxViewBuilder
import com.lynx.tasm.TemplateData
import com.lynx.tasm.behavior.Behavior
import com.lynx.tasm.behavior.LynxContext
import com.lynx.tasm.behavior.ui.LynxUI
import com.lynx.tasm.behavior.ui.image.UIImage
import com.lynx.tasm.service.LynxServiceCenter
import com.lynx.xelement.XElementBehaviors
import org.json.JSONObject
import java.net.URLDecoder
import java.util.UUID
import kotlin.math.abs
import kotlin.math.max

/**
 * Activity that hosts a LynxView.
 * Receives a "scheme" extra with format: hybrid://lynxview?bundle=...&route_params=...
 *
 * globalProps contract:
 *   - routeParams: parsed JSON object from route_params query value
 *   - queryItems: { key: value } dict of all URL query parameters
 *   - containerID: unique UUID per page
 *   - safeAreaInsets: host-derived { top, right, bottom, left } inset values
 */
class OpenCodeLynxActivity : Activity() {
    companion object {
        @Volatile
        private var lynxImageServiceRegistered = false

        @Synchronized
        private fun ensureLynxImageServiceRegistered() {
            if (lynxImageServiceRegistered) {
                return
            }
            LynxServiceCenter.inst().registerService(LynxImageService.getInstance())
            lynxImageServiceRegistered = true
        }
    }

    private var lynxView: LynxView? = null
    private var pendingBundleName: String? = null
    private var hasRenderedTemplate = false
    private var baseGlobalProps: MutableMap<String, Any> = mutableMapOf()
    private var lastSafeAreaInsets = SafeAreaInsets()
    private var lastKeyboardState = KeyboardEventState()

    override fun onCreate(savedInstanceState: Bundle?) {
        setTheme(androidx.appcompat.R.style.Theme_AppCompat_Light_NoActionBar)
        super.onCreate(savedInstanceState)
        OpenCodeActivityStack.push(this)
        ensureLynxImageServiceRegistered()
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }

        val scheme = intent?.getStringExtra("scheme") ?: ""
        val parsed = parseScheme(scheme)
        pendingBundleName = parsed.bundleName
        baseGlobalProps = parsed.globalProps

        val builder = LynxViewBuilder()

        builder.setTemplateProvider(BuiltinTemplateProvider(applicationContext))
        builder.registerModule(OpenCodeBridgeModule.NAME, OpenCodeBridgeModule::class.java)
        builder.addBehavior(object : Behavior("image", false, true) {
            override fun createUIWithParams(context: LynxContext?, params: Any?): LynxUI<*> {
                return UIImage(context, params)
            }
        })
        builder.addBehaviors(XElementBehaviors().create())
        builder.addBehavior(object : Behavior("x-liquid-glass", false) {
            override fun createUI(context: LynxContext?): LynxUI<*>? {
                return LynxLiquidGlassComponent(context)
            }
        })
        builder.addBehavior(object : Behavior("x-native-tabbar", false) {
            override fun createUI(context: LynxContext?): LynxUI<*>? {
                return LynxNativeTabbarComponent(context)
            }
        })

        val lv = LynxView(this, builder)
        lynxView = lv

        val container = FrameLayout(this)
        container.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        )
        container.addView(lv, ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ))
        setContentView(container)
        ViewCompat.setOnApplyWindowInsetsListener(container) { _, windowInsets ->
            handleWindowInsets(windowInsets)
            windowInsets
        }
        ViewCompat.requestApplyInsets(container)

        // Fallback: if the insets listener hasn't fired by the end of the
        // next layout pass (observed under some instrumented-test / headless
        // runs on API 34 where `requestApplyInsets` does not re-dispatch),
        // render the template with zero safe-area so the page still loads.
        // Any later insets callback will update globalProps via
        // updateGlobalProps in handleWindowInsets.
        container.post {
            if (!hasRenderedTemplate) {
                val bundleName = pendingBundleName ?: "main.lynx.bundle"
                hasRenderedTemplate = true
                renderTemplateWithGlobalProps(lv, bundleName, baseGlobalPropsWithSafeArea(lastSafeAreaInsets))
            }
        }
    }

    override fun onDestroy() {
        lynxView?.destroy()
        OpenCodeActivityStack.remove(this)
        super.onDestroy()
    }

    private data class ParsedScheme(
        val bundleName: String,
        val globalProps: MutableMap<String, Any>,
    )

    private data class SafeAreaInsets(
        val top: Int = 0,
        val right: Int = 0,
        val bottom: Int = 0,
        val left: Int = 0,
    )

    private data class KeyboardEventState(
        val visible: Boolean = false,
        val heightPx: Int = 0,
    )

    private fun handleWindowInsets(windowInsets: WindowInsetsCompat) {
        val systemInsets = windowInsets.getInsets(
            WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
        )
        val safeAreaInsets = SafeAreaInsets(
            top = systemInsets.top,
            right = systemInsets.right,
            bottom = systemInsets.bottom,
            left = systemInsets.left,
        )
        val imeInsets = windowInsets.getInsets(WindowInsetsCompat.Type.ime())
        val keyboardHeightPx = max(0, imeInsets.bottom - safeAreaInsets.bottom)
        val keyboardVisible = keyboardHeightPx > 0 && windowInsets.isVisible(WindowInsetsCompat.Type.ime())
        val nextKeyboardState = KeyboardEventState(
            visible = keyboardVisible,
            heightPx = if (keyboardVisible) keyboardHeightPx else 0,
        )

        val safeAreaChanged = safeAreaInsets != lastSafeAreaInsets
        val keyboardChanged = nextKeyboardState.visible != lastKeyboardState.visible ||
            abs(nextKeyboardState.heightPx - lastKeyboardState.heightPx) > 1

        if (!safeAreaChanged && !keyboardChanged && hasRenderedTemplate) {
            return
        }

        val globalProps = baseGlobalPropsWithSafeArea(safeAreaInsets)
        val lv = lynxView ?: return
        if (!hasRenderedTemplate) {
            val bundleName = pendingBundleName ?: "main.lynx.bundle"
            lastSafeAreaInsets = safeAreaInsets
            lastKeyboardState = nextKeyboardState
            hasRenderedTemplate = true
            renderTemplateWithGlobalProps(lv, bundleName, globalProps)
            dispatchKeyboardEvent(lv, nextKeyboardState, force = nextKeyboardState.visible)
            return
        }

        if (safeAreaChanged) {
            lastSafeAreaInsets = safeAreaInsets
            lv.updateGlobalProps(globalProps)
        }
        if (keyboardChanged) {
            dispatchKeyboardEvent(lv, nextKeyboardState)
        }
    }

    private fun baseGlobalPropsWithSafeArea(insets: SafeAreaInsets): MutableMap<String, Any> {
        val globalProps = baseGlobalProps.toMutableMap()
        globalProps["safeAreaInsets"] = mapOf(
            "top" to insets.top,
            "right" to insets.right,
            "bottom" to insets.bottom,
            "left" to insets.left,
        )
        return globalProps
    }

    private fun renderTemplateWithGlobalProps(
        lv: LynxView,
        bundleName: String,
        globalProps: Map<String, Any>,
    ) {
        val metaBuilder = LynxLoadMeta.Builder()
        metaBuilder.setUrl(bundleName)
        metaBuilder.setInitialData(TemplateData.empty())
        metaBuilder.setGlobalProps(TemplateData.fromMap(globalProps))
        lv.loadTemplate(metaBuilder.build())
    }

    private fun dispatchKeyboardEvent(
        lynxView: LynxView,
        state: KeyboardEventState,
        force: Boolean = false,
    ) {
        if (!force &&
            state.visible == lastKeyboardState.visible &&
            abs(state.heightPx - lastKeyboardState.heightPx) <= 1
        ) {
            return
        }

        lastKeyboardState = state
        val args = JavaOnlyArray()
        args.pushString(if (state.visible) "on" else "off")
        args.pushInt(if (state.visible) state.heightPx else 0)
        lynxView.sendGlobalEvent("keyboardstatuschanged", args)
    }

    private fun parseScheme(scheme: String): ParsedScheme {
        val decodedScheme = try { URLDecoder.decode(scheme, "UTF-8") } catch (_: Exception) { scheme }
        val uri = Uri.parse(decodedScheme)
        var bundleName = uri.getQueryParameter("bundle") ?: "main.lynx.bundle"
        if (bundleName.startsWith("./")) {
            bundleName = bundleName.removePrefix("./")
        }

        // Collect all query items
        val queryItems = mutableMapOf<String, String>()
        uri.queryParameterNames.forEach { key ->
            queryItems[key] = uri.getQueryParameter(key) ?: ""
        }

        // Parse route_params as JSON object (URL-decoded then JSON-parsed)
        val routeParamsRaw = uri.getQueryParameter("route_params")
        val routeParamsObject: Any? = if (!routeParamsRaw.isNullOrEmpty()) {
            try {
                val decoded = URLDecoder.decode(routeParamsRaw, "UTF-8")
                val json = JSONObject(decoded)
                jsonObjectToMap(json)
            } catch (_: Exception) {
                routeParamsRaw
            }
        } else null

        val globalProps = mutableMapOf<String, Any>()
        globalProps["queryItems"] = queryItems
        globalProps["containerID"] = UUID.randomUUID().toString().lowercase()
        if (routeParamsObject != null) {
            globalProps["routeParams"] = routeParamsObject
        }

        return ParsedScheme(bundleName, globalProps)
    }

    private fun jsonObjectToMap(json: JSONObject): Map<String, Any> {
        val map = mutableMapOf<String, Any>()
        json.keys().forEach { key ->
            val value = json.get(key)
            map[key] = when (value) {
                is JSONObject -> jsonObjectToMap(value)
                is org.json.JSONArray -> jsonArrayToList(value)
                JSONObject.NULL -> ""
                else -> value
            }
        }
        return map
    }

    private fun jsonArrayToList(arr: org.json.JSONArray): List<Any> {
        return (0 until arr.length()).map { i ->
            val value = arr.get(i)
            when (value) {
                is JSONObject -> jsonObjectToMap(value)
                is org.json.JSONArray -> jsonArrayToList(value)
                JSONObject.NULL -> ""
                else -> value
            }
        }
    }

}

/**
 * Simple activity stack tracker for navigation.close support.
 */
object OpenCodeActivityStack {
    private val stack = mutableListOf<Activity>()

    val topActivity: Activity?
        get() = synchronized(stack) { stack.lastOrNull() }

    fun push(activity: Activity) {
        synchronized(stack) { stack.add(activity) }
    }

    fun remove(activity: Activity) {
        synchronized(stack) { stack.remove(activity) }
    }
}
