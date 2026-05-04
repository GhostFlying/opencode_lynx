interface TextPartData {
  type: 'text'
  text?: string
}

export interface TextPartProps {
  part: TextPartData
  role: string
}

export function TextPartView({ part, role }: TextPartProps) {
  const text = part.text ?? ''
  if (text.length === 0) {
    return null
  }

  let className: string
  if (role === 'user') className = 'msg-text--user'
  else if (role === 'error') className = 'msg-text--error'
  else className = 'msg-text--assistant'
  return <text className={className}>{text}</text>
}
