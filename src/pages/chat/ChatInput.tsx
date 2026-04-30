import { useCallback, useRef } from '@lynx-js/react'
import { KeyboardAwareTrigger, TextArea } from '@lynx-js/lynx-ui'

export interface ChatInputSelection {
  agentLabel: string
  modelLabel: string
  effortLabel: string
}

export interface ChatInputProps {
  onSend: (text: string) => void
  disabled?: boolean
  selection: ChatInputSelection
  variantAvailable: boolean
  areaStyle?: Record<string, string>
  onOpenAgentPicker: () => void
  onOpenModelPicker: () => void
  onOpenEffortPicker: () => void
}

export function ChatInput({
  onSend,
  disabled,
  selection,
  variantAvailable,
  areaStyle,
  onOpenAgentPicker,
  onOpenModelPicker,
  onOpenEffortPicker,
}: ChatInputProps) {
  const textRef = useRef('')

  const handleInput = useCallback((value: string) => {
    'background only'
    textRef.current = value
  }, [])

  const handleConfirm = useCallback(() => {
    'background only'
    const text = textRef.current.trim()
    if (!text || disabled) return
    onSend(text)
    textRef.current = ''
    lynx
      .createSelectorQuery()
      .select('#chat-textarea')
      .invoke({ method: 'setValue', params: { value: '' } })
      .exec()
  }, [onSend, disabled])

  // Allow typing even while previous send is in flight — only the send action is gated.

  const handleSendTap = useCallback(() => {
    'background only'
    handleConfirm()
  }, [handleConfirm])

  const handleAgentTap = useCallback(() => {
    'background only'
    onOpenAgentPicker()
  }, [onOpenAgentPicker])

  const handleModelTap = useCallback(() => {
    'background only'
    onOpenModelPicker()
  }, [onOpenModelPicker])

  const handleEffortTap = useCallback(() => {
    'background only'
    if (!variantAvailable) return
    onOpenEffortPicker()
  }, [onOpenEffortPicker, variantAvailable])

  return (
    <view id="chat-input-area" className="chat-input-area" style={areaStyle}>
      <view className="chat-input-card">
        {/* Textarea */}
        <KeyboardAwareTrigger>
          <TextArea
            id="chat-textarea"
            className="chat-textarea"
            style={{ color: '#0e191f' }}
            placeholder="输入消息..."
            maxLines={2}
            maxLength={4096}
            confirmType="send"
            onInput={handleInput}
            onConfirm={handleConfirm}
          />
        </KeyboardAwareTrigger>

        {/* Toolbar inside card */}
        <view className="chat-input-toolbar">
          <view className="chat-input-left">
            <view className="chat-chip" bindtap={handleAgentTap}>
              <text className="chat-chip-text">{selection.agentLabel}</text>
              <text className="chat-chip-caret">{'\u25BE'}</text>
            </view>
            <view className="chat-chip" bindtap={handleModelTap}>
              <text className="chat-chip-text">{selection.modelLabel}</text>
              <text className="chat-chip-caret">{'\u25BE'}</text>
            </view>
            {variantAvailable ? (
              <view className="chat-chip" bindtap={handleEffortTap}>
                <text className="chat-chip-text">{selection.effortLabel}</text>
                <text className="chat-chip-caret">{'\u25BE'}</text>
              </view>
            ) : (
              <view className="chat-chip chat-chip--disabled">
                <text className="chat-chip-text">{selection.effortLabel}</text>
                <text className="chat-chip-caret">{'\u25BE'}</text>
              </view>
            )}
          </view>

          {/* When disabled, do not wire bindtap at all — the click chain never fires. */}
          {disabled ? (
            <view className="chat-send-btn chat-send-btn--disabled">
              <text className="chat-send-icon">{'\u2191'}</text>
            </view>
          ) : (
            <view className="chat-send-btn" bindtap={handleSendTap}>
              <text className="chat-send-icon">{'\u2191'}</text>
            </view>
          )}
        </view>
      </view>
    </view>
  )
}
