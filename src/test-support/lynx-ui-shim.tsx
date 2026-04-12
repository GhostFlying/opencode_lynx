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

export function Input({
  value = '',
  placeholder,
  className = '',
  id,
}: InputProps) {
  return (
    <input
      id={id}
      className={className}
      value={value}
      placeholder={placeholder}
    />
  )
}
