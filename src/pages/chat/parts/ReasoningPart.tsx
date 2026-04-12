import { useCallback, useState } from '@lynx-js/react'

interface ReasoningPartData {
  type: 'reasoning'
  text?: string
}

export interface ReasoningPartProps {
  part: ReasoningPartData
}

export function ReasoningPartView({ part }: ReasoningPartProps) {
  const [expanded, setExpanded] = useState(false)
  const text = part.text ?? ''

  const handleToggle = useCallback(() => {
    'background only'
    setExpanded(prev => !prev)
  }, [])

  if (text.length === 0) {
    return null
  }

  return (
    <view className="reasoning-card">
      <view className="reasoning-header" bindtap={handleToggle}>
        <text className="reasoning-label">Thinking...</text>
        <text className="reasoning-toggle">{expanded ? '\u25B2' : '\u25BC'}</text>
      </view>
      {expanded
        ? <text className="reasoning-text">{text}</text>
        : null}
    </view>
  )
}
