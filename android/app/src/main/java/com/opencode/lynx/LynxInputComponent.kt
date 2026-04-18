// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.
package com.opencode.lynx

import android.content.Context
import android.graphics.Color
import android.text.InputType
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import androidx.appcompat.widget.AppCompatEditText
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.lynx.react.bridge.Callback
import com.lynx.react.bridge.JavaOnlyMap
import com.lynx.react.bridge.ReadableMap
import com.lynx.tasm.behavior.LynxContext
import com.lynx.tasm.behavior.LynxProp
import com.lynx.tasm.behavior.LynxUIMethod
import com.lynx.tasm.behavior.LynxUIMethodConstants
import com.lynx.tasm.behavior.ui.LynxUI
import com.lynx.tasm.event.LynxCustomEvent

class LynxInputComponent(
  context: LynxContext?,
  private val multiline: Boolean = false,
) : LynxUI<AppCompatEditText>(context) {

  private companion object {
    const val IME_RETRY_DELAY_MS = 120L
    const val IME_MAX_ATTEMPTS = 20
  }

  private class ServedAwareEditText(context: Context) : AppCompatEditText(context) {
    var onInputConnectionCreated: (() -> Unit)? = null
    var onWindowFocusGained: (() -> Unit)? = null

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
      val connection = super.onCreateInputConnection(outAttrs)
      if (connection != null) {
        post { onInputConnectionCreated?.invoke() }
      }
      return connection
    }

    override fun onCheckIsTextEditor(): Boolean {
      return true
    }

    override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
      super.onWindowFocusChanged(hasWindowFocus)
      if (hasWindowFocus) {
        post { onWindowFocusGained?.invoke() }
      }
    }
  }

  private var pendingShowSoftInputRequest = false
  private var hasInputConnection = false
  private var imeRetryInFlight = false

  override fun createView(context: Context): AppCompatEditText {
    return ServedAwareEditText(context).apply {
      if (multiline) {
        minLines = 2
        maxLines = 6
        setSingleLine(false)
        gravity = Gravity.TOP or Gravity.START
        setHorizontallyScrolling(false)
      } else {
        setLines(1)
        setSingleLine()
        gravity = Gravity.CENTER_VERTICAL
        setHorizontallyScrolling(true)
      }
      background = null
      imeOptions = EditorInfo.IME_ACTION_NONE
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
      isFocusable = true
      isFocusableInTouchMode = true
      isClickable = true
      showSoftInputOnFocus = true
      setPadding(0, 0, 0, 0)
      onInputConnectionCreated = {
        hasInputConnection = true
        if (pendingShowSoftInputRequest) {
          scheduleImeVisibility()
        }
      }
      onWindowFocusGained = {
        if (pendingShowSoftInputRequest) {
          scheduleImeVisibility()
        }
      }
      addTextChangedListener(object : TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
        override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
        override fun afterTextChanged(s: Editable?) {
          emitEvent("input", mapOf("value" to (s?.toString() ?: "")))
        }
      })
      onFocusChangeListener = View.OnFocusChangeListener { _, hasFocus ->
        if (hasFocus) {
          pendingShowSoftInputRequest = true
          val imm = context.getSystemService(InputMethodManager::class.java)
          imm?.viewClicked(this)
          emitEvent("focus", mapOf("value" to (text?.toString() ?: "")))
          post { scheduleImeVisibility() }
        } else {
          pendingShowSoftInputRequest = false
          hasInputConnection = false
          imeRetryInFlight = false
          emitEvent("blur", mapOf("value" to (text?.toString() ?: "")))
        }
      }
    }
  }

  override fun onLayoutUpdated() {
    super.onLayoutUpdated()
    val paddingTop = mPaddingTop + mBorderTopWidth
    val paddingBottom = mPaddingBottom + mBorderBottomWidth
    val paddingLeft = mPaddingLeft + mBorderLeftWidth
    val paddingRight = mPaddingRight + mBorderRightWidth
    mView.setPadding(paddingLeft, paddingTop, paddingRight, paddingBottom)
  }

  @LynxProp(name = "value")
  fun setValueProp(value: String) {
    if (value != mView.text.toString()) {
      mView.setText(value)
    }
  }

  @LynxUIMethod
  fun focus(params: ReadableMap, callback: Callback) {
    val focused = mView.requestFocusFromTouch() || mView.requestFocus()
    if (focused) {
      pendingShowSoftInputRequest = true
      val imm = mView.context.getSystemService(InputMethodManager::class.java)
      imm?.viewClicked(mView)
      mView.post { scheduleImeVisibility() }
      callback.invoke(LynxUIMethodConstants.SUCCESS)
    } else {
      callback.invoke(LynxUIMethodConstants.UNKNOWN, "fail to focus")
    }
  }

  @LynxUIMethod
  fun blur(_params: ReadableMap, callback: Callback) {
    try {
      mView.clearFocus()
      val imm = lynxContext.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
      imm.hideSoftInputFromWindow(mView.windowToken, 0)
      callback.invoke(LynxUIMethodConstants.SUCCESS)
    } catch (error: Throwable) {
      callback.invoke(
        LynxUIMethodConstants.UNKNOWN,
        error.message ?: "fail to blur",
      )
    }
  }

  @LynxUIMethod
  fun setValue(params: ReadableMap, callback: Callback) {
    try {
      val value = params.getString("value", "") ?: ""
      if (value != mView.text.toString()) {
        mView.setText(value)
      }
      callback.invoke(LynxUIMethodConstants.SUCCESS)
    } catch (error: Throwable) {
      callback.invoke(
        LynxUIMethodConstants.UNKNOWN,
        error.message ?: "fail to set value",
      )
    }
  }

  @LynxUIMethod
  fun getValue(_params: ReadableMap, callback: Callback) {
    val result = JavaOnlyMap()
    result.putString("value", mView.text?.toString() ?: "")
    result.putInt("selectionStart", mView.selectionStart.coerceAtLeast(0))
    result.putInt("selectionEnd", mView.selectionEnd.coerceAtLeast(0))
    callback.invoke(LynxUIMethodConstants.SUCCESS, result)
  }

  @LynxUIMethod
  fun setSelectionRange(params: ReadableMap, callback: Callback) {
    try {
      val textLength = mView.text?.length ?: 0
      val selectionStart = params.getInt("selectionStart", 0).coerceIn(0, textLength)
      val selectionEnd = params
        .getInt("selectionEnd", selectionStart)
        .coerceIn(selectionStart, textLength)
      mView.setSelection(selectionStart, selectionEnd)
      callback.invoke(LynxUIMethodConstants.SUCCESS)
    } catch (error: Throwable) {
      callback.invoke(
        LynxUIMethodConstants.PARAM_INVALID,
        error.message ?: "invalid selection range",
      )
    }
  }

  private fun scheduleImeVisibility() {
    if (!pendingShowSoftInputRequest || imeRetryInFlight) {
      return
    }
    imeRetryInFlight = true
    requestImeVisibility(maxAttempts = IME_MAX_ATTEMPTS)
  }

  private fun requestImeVisibility(maxAttempts: Int): Boolean {
    if (maxAttempts <= 0) {
      imeRetryInFlight = false
      return false
    }
    val imm = mView.context.getSystemService(InputMethodManager::class.java) ?: return false
    if (!pendingShowSoftInputRequest) {
      imeRetryInFlight = false
      return false
    }
    if (!mView.isAttachedToWindow || mView.windowToken == null || !mView.isFocused || !mView.hasWindowFocus() || !mView.isShown) {
      mView.postDelayed({ requestImeVisibility(maxAttempts - 1) }, IME_RETRY_DELAY_MS)
      return false
    }

    imm.viewClicked(mView)

    if (!imm.isActive(mView)) {
      imm.restartInput(mView)
    }

    imm.viewClicked(mView)
    val shownByImm = imm.showSoftInput(mView, InputMethodManager.SHOW_IMPLICIT)
    ViewCompat.getWindowInsetsController(mView)?.show(WindowInsetsCompat.Type.ime())

    mView.postDelayed({
      val visible = ViewCompat.getRootWindowInsets(mView)?.isVisible(WindowInsetsCompat.Type.ime()) == true
      if (visible) {
        pendingShowSoftInputRequest = false
        imeRetryInFlight = false
      } else {
        requestImeVisibility(maxAttempts - 1)
      }
    }, IME_RETRY_DELAY_MS)
    return true
  }

  @LynxProp(name = "placeholder")
  fun setPlaceHolder(value: String) {
    mView.hint = value
  }

  @LynxProp(name = "text-color")
  fun setTextColor(value: String) {
    var rawValue = value
    if (rawValue.startsWith("#")) {
      rawValue = rawValue.substring(1)
    }
    val textColor = "#" + rawValue
    val hintColor = "#40" + rawValue
    mView.setHintTextColor(Color.parseColor(hintColor))
    mView.setTextColor(Color.parseColor(textColor))
  }

  private fun emitEvent(name: String, value: Map<String, Any>?) {
    val detail = LynxCustomEvent(sign, name)
    value?.forEach { (key, v) -> detail.addDetail(key, v) }
    lynxContext.eventEmitter.sendCustomEvent(detail)
  }
}
