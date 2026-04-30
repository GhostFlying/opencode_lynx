import { forwardRef, useImperativeHandle } from '@lynx-js/react'
import type { JSX } from '@lynx-js/react'

type CommonProps = {
  children?: JSX.Element | JSX.Element[] | string
  className?: string
  disabled?: boolean
  id?: string
}

type ButtonProps = CommonProps & {
  onClick?: () => void
}

type InputProps = CommonProps & {
  value?: string
  placeholder?: string
  type?: string
  onInput?: (value: string) => void
}

type TextAreaProps = CommonProps & {
  value?: string
  placeholder?: string
  maxLines?: number
  maxLength?: number
  confirmType?: string
  onInput?: (value: string) => void
  onConfirm?: (value: string) => void
}

type KeyboardAwareRootProps = {
  children?: JSX.Element | JSX.Element[]
  androidStatusBarPlusBottomBarHeight?: number
}

type KeyboardAwareResponderProps = {
  children?: JSX.Element | JSX.Element[]
  className?: string
  as?: string
  scrollviewId?: string
}

type KeyboardAwareTriggerProps = {
  children?: JSX.Element | JSX.Element[]
  className?: string
  offset?: number
}

export function Button({ children, className = '', disabled = false, id, onClick }: ButtonProps) {
  return (
    <view
      id={id}
      className={className}
      data-disabled={disabled ? 'true' : 'false'}
      bindtap={disabled ? undefined : onClick}
    >
      {children}
    </view>
  )
}

type InputImperativeHandle = {
  setValue: (value: string) => Promise<void>
  getValue: () => Promise<{ value: string; selectionStart: number; selectionEnd: number }>
  focus: () => Promise<void>
  blur: () => Promise<void>
  setSelectionRange: (start: number, end: number) => Promise<void>
}

const noopHandle: InputImperativeHandle = {
  setValue: async () => {},
  getValue: async () => ({ value: '', selectionStart: 0, selectionEnd: 0 }),
  focus: async () => {},
  blur: async () => {},
  setSelectionRange: async () => {},
}

export const Input = forwardRef<InputImperativeHandle, InputProps>(function Input(
  { value = '', placeholder, className = '', id }: InputProps,
  ref,
) {
  useImperativeHandle(ref, () => noopHandle, [])
  return (
    <input
      id={id}
      className={className}
      value={value}
      placeholder={placeholder}
    />
  )
})

export const TextArea = forwardRef<InputImperativeHandle, TextAreaProps>(function TextArea(
  { value = '', placeholder, className = '', id }: TextAreaProps,
  ref,
) {
  useImperativeHandle(ref, () => noopHandle, [])
  return (
    <textarea
      id={id}
      className={className}
      value={value}
      placeholder={placeholder}
    />
  )
})

export function KeyboardAwareRoot({ children }: KeyboardAwareRootProps) {
  return <>{children}</>
}

export function KeyboardAwareResponder({ children, className }: KeyboardAwareResponderProps) {
  return <view className={className}>{children}</view>
}

export function KeyboardAwareTrigger({ children, className }: KeyboardAwareTriggerProps) {
  return <view className={className}>{children}</view>
}
