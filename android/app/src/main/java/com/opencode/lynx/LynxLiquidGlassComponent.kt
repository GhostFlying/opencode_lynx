package com.opencode.lynx

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.os.Build
import android.view.View
import android.view.ViewOutlineProvider
import android.widget.FrameLayout
import com.lynx.tasm.behavior.LynxContext
import com.lynx.tasm.behavior.LynxProp
import com.lynx.tasm.behavior.ui.UIGroup
import kotlin.math.max

private fun parseLength(value: String?, fallback: Float): Float {
  if (value.isNullOrBlank()) {
    return fallback
  }
  val trimmed = value.trim()
  val numeric = if (trimmed.endsWith("px")) trimmed.dropLast(2) else trimmed
  return numeric.toFloatOrNull()?.takeIf { it > 0f } ?: fallback
}

private fun parseAlpha(value: String?, fallback: Float): Float {
  if (value.isNullOrBlank()) {
    return fallback
  }
  return value.toFloatOrNull()?.coerceIn(0f, 1f) ?: fallback
}

internal class LiquidGlassLayout(context: Context) : FrameLayout(context) {
  private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
  }
  private val path = Path()
  private val rect = RectF()

  var cornerRadiusPx: Float = 24f
    set(value) {
      field = max(0f, value)
      invalidateOutline()
      invalidate()
    }

  var variant: String = "bar"
    set(value) {
      field = value
      updatePalette()
    }

  var tintAlpha: Float = 0.18f
    set(value) {
      field = value.coerceIn(0f, 1f)
      updatePalette()
    }

  init {
    setWillNotDraw(false)
    clipToOutline = false
    clipChildren = false
    clipToPadding = false
    elevation = 18f
    outlineProvider = object : ViewOutlineProvider() {
      override fun getOutline(view: View, outline: Outline) {
        outline.setRoundRect(0, 0, view.width, view.height, cornerRadiusPx)
      }
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      // Keep the hook for future stronger Android glass treatment without changing the JS API.
      setRenderEffect(null)
    }
    updatePalette()
  }

  private fun updatePalette() {
    val fillAlpha = if (variant == "card") tintAlpha + 0.06f else tintAlpha
    fillPaint.style = Paint.Style.FILL
    fillPaint.color = Color.argb((fillAlpha * 255).toInt(), 255, 250, 244)

    strokePaint.strokeWidth = 1.5f * resources.displayMetrics.density
    strokePaint.color = Color.argb((0.28f * 255).toInt(), 255, 255, 255)
    invalidate()
  }

  override fun dispatchDraw(canvas: Canvas) {
    rect.set(0f, 0f, width.toFloat(), height.toFloat())
    path.reset()
    path.addRoundRect(rect, cornerRadiusPx, cornerRadiusPx, Path.Direction.CW)
    canvas.drawPath(path, fillPaint)
    canvas.drawPath(path, strokePaint)
    super.dispatchDraw(canvas)
  }
}

internal class LynxLiquidGlassComponent(context: LynxContext?) : UIGroup<LiquidGlassLayout>(context) {
  override fun createView(context: Context): LiquidGlassLayout {
    return LiquidGlassLayout(context)
  }

  @LynxProp(name = "variant")
  fun setVariant(value: String) {
    mView.variant = value
  }

  @LynxProp(name = "corner-radius")
  fun setCornerRadius(value: String) {
    mView.cornerRadiusPx = parseLength(value, 24f)
  }

  @LynxProp(name = "tint-alpha")
  fun setTintAlpha(value: String) {
    mView.tintAlpha = parseAlpha(value, 0.18f)
  }
}
