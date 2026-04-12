package com.opencode.lynx

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Outline
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Build
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewOutlineProvider
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.util.Log
import com.lynx.tasm.behavior.LynxContext
import com.lynx.tasm.behavior.LynxProp
import com.lynx.tasm.behavior.ui.LynxUI
import com.lynx.tasm.event.LynxCustomEvent

private fun dp(context: Context, value: Float): Int {
  return TypedValue.applyDimension(
    TypedValue.COMPLEX_UNIT_DIP,
    value,
    context.resources.displayMetrics
  ).toInt()
}

private fun colorInt(hex: String): Int {
  return Color.parseColor(hex)
}

private class NativeTabbarItemView(
  context: Context,
  iconRes: Int,
  defaultLabel: String
) : LinearLayout(context) {
  private val iconView = ImageView(context)
  private val labelView = TextView(context)
  private var selectedState = false
  private var highlightedState = false

  var label: String = defaultLabel
    set(value) {
      field = value
      labelView.text = value
    }

  init {
    orientation = VERTICAL
    gravity = Gravity.CENTER
    minimumHeight = dp(context, 54f)
    val verticalPadding = dp(context, 6f)
    val horizontalPadding = dp(context, 10f)
    setPadding(horizontalPadding, verticalPadding, horizontalPadding, verticalPadding)
    clipToOutline = true
    outlineProvider = object : ViewOutlineProvider() {
      override fun getOutline(view: View, outline: Outline) {
        outline.setRoundRect(0, 0, view.width, view.height, dp(context, 15f).toFloat())
      }
    }
    isClickable = true
    isFocusable = true

    iconView.setImageResource(iconRes)
    iconView.imageTintList = ColorStateList.valueOf(colorInt("#575A52"))
    val iconParams = LayoutParams(dp(context, 18f), dp(context, 18f))
    addView(iconView, iconParams)

    labelView.text = defaultLabel
    labelView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f)
    labelView.typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    labelView.paintFlags = labelView.paintFlags or Paint.SUBPIXEL_TEXT_FLAG
    labelView.letterSpacing = 0.01f
    labelView.setTextColor(colorInt("#575A52"))
    val labelParams = LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT)
    labelParams.topMargin = dp(context, 3f)
    addView(labelView, labelParams)

    updateAppearance(false)
  }

  fun updateAppearance(selected: Boolean, highlighted: Boolean = false) {
    selectedState = selected
    highlightedState = highlighted
    iconView.imageTintList = ColorStateList.valueOf(
      if (selected) colorInt("#FFFFFF") else colorInt("#575A52")
    )
    labelView.setTextColor(if (selected) colorInt("#FFFFFF") else colorInt("#575A52"))

    val fill = GradientDrawable().apply {
      cornerRadius = dp(context, 15f).toFloat()
      setColor(
        if (selected) {
          if (highlighted) Color.argb(148, 131, 140, 122) else Color.argb(117, 131, 140, 122)
        } else {
          if (highlighted) Color.argb(189, 255, 255, 255) else Color.argb(153, 255, 255, 255)
        }
      )
      setStroke(
        dp(context, 1f),
        if (selected) {
          if (highlighted) Color.argb(31, 255, 255, 255) else Color.argb(41, 255, 255, 255)
        } else {
          if (highlighted) Color.argb(87, 195, 186, 166) else Color.argb(61, 195, 186, 166)
        }
      )
    }
    background = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
      RippleDrawable(
        ColorStateList.valueOf(Color.argb(if (selected) 18 else 14, 255, 255, 255)),
        fill,
        null
      )
    } else {
      fill
    }
  }
}

internal class NativeTabbarLayout(context: Context) : LinearLayout(context) {
  private val sessionsItem = NativeTabbarItemView(
    context,
    R.drawable.ic_tab_sessions,
    "Sessions"
  )
  private val settingsItem = NativeTabbarItemView(
    context,
    R.drawable.ic_tab_settings,
    "Settings"
  )

  var onSelectionChange: ((String) -> Unit)? = null

  var selectedValue: String = "sessions"
    set(value) {
      val next = if (value == "settings") "settings" else "sessions"
      field = next
      applySelection()
    }

  var pressedValue: String = ""
    set(value) {
      field = if (value == "settings" || value == "sessions") value else ""
      applySelection()
    }

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER
    weightSum = 2f
    clipChildren = false
    clipToPadding = false

    sessionsItem.layoutParams = LayoutParams(0, LayoutParams.MATCH_PARENT, 1f).apply {
      marginEnd = dp(context, 5f)
    }
    settingsItem.layoutParams = LayoutParams(0, LayoutParams.MATCH_PARENT, 1f).apply {
      marginStart = dp(context, 5f)
    }

    sessionsItem.setOnClickListener {
      Log.i("OpenCodeTabbar", "native_tabbar_android_tap value=sessions current=$selectedValue")
      if (selectedValue != "sessions") {
        selectedValue = "sessions"
        Log.i("OpenCodeTabbar", "native_tabbar_android_selected value=$selectedValue")
        onSelectionChange?.invoke(selectedValue)
      }
    }
    settingsItem.setOnClickListener {
      Log.i("OpenCodeTabbar", "native_tabbar_android_tap value=settings current=$selectedValue")
      if (selectedValue != "settings") {
        selectedValue = "settings"
        Log.i("OpenCodeTabbar", "native_tabbar_android_selected value=$selectedValue")
        onSelectionChange?.invoke(selectedValue)
      }
    }

    addView(sessionsItem)
    addView(settingsItem)
    applySelection()
  }

  fun setSessionsLabel(value: String) {
    sessionsItem.label = value
  }

  fun setSettingsLabel(value: String) {
    settingsItem.label = value
  }

  private fun applySelection() {
    sessionsItem.updateAppearance(selectedValue == "sessions", pressedValue == "sessions")
    settingsItem.updateAppearance(selectedValue == "settings", pressedValue == "settings")
  }
}

internal class LynxNativeTabbarComponent(context: LynxContext?) : LynxUI<NativeTabbarLayout>(context) {
  override fun createView(context: Context): NativeTabbarLayout {
    return NativeTabbarLayout(context).apply {
      onSelectionChange = { value ->
        emitChangeEvent(value)
      }
    }
  }

  @LynxProp(name = "selected")
  fun setSelected(value: String) {
    mView.selectedValue = value
  }

  @LynxProp(name = "pressed")
  fun setPressed(value: String) {
    mView.pressedValue = value
  }

  @LynxProp(name = "sessions-label")
  fun setSessionsLabel(value: String) {
    mView.setSessionsLabel(value)
  }

  @LynxProp(name = "settings-label")
  fun setSettingsLabel(value: String) {
    mView.setSettingsLabel(value)
  }

  private fun emitChangeEvent(value: String) {
    Log.i("OpenCodeTabbar", "native_tabbar_android_emit tabchange value=$value sign=$sign")
    val detail = LynxCustomEvent(sign, "tabchange")
    detail.addDetail("value", value)
    lynxContext.eventEmitter.sendCustomEvent(detail)
  }
}
