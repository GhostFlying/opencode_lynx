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

  const className = role === 'user' ? 'msg-text--user' : 'msg-text--assistant'
  return <text className={className}>{text}</text>
}
