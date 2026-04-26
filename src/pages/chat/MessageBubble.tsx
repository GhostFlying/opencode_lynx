import { useCallback, useState } from '@lynx-js/react'

import { TextPartView } from './parts/TextPart.js'
import { ToolPartView } from './parts/ToolPart.js'
import { ReasoningPartView } from './parts/ReasoningPart.js'
import { StepStartPartView } from './parts/StepStartPart.js'
import { StepFinishPartView } from './parts/StepFinishPart.js'
import { PatchPartView } from './parts/PatchPart.js'
import { GenericPartView } from './parts/GenericPart.js'

export interface MessageBubbleProps {
  role: string
  parts: ReadonlyArray<unknown>
  createdAt?: string
}

function formatTimestamp(iso: string | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  if (sameDay) return `${hh}:${mm}`
  const mo = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${mo}-${d} ${hh}:${mm}`
}

function renderPart(part: unknown, index: number, role: string) {
  const p = part as { type?: string }
  if (!p || typeof p.type !== 'string') {
    return null
  }

  switch (p.type) {
    case 'text':
      return <TextPartView part={p as any} role={role} key={`part-${index}`} />
    case 'tool':
      return <ToolPartView part={p as any} key={`part-${index}`} />
    case 'reasoning':
      return <ReasoningPartView part={p as any} key={`part-${index}`} />
    case 'step-start':
      return <StepStartPartView part={p as any} key={`part-${index}`} />
    case 'step-finish':
      return <StepFinishPartView part={p as any} key={`part-${index}`} />
    case 'patch':
      return <PatchPartView part={p as any} key={`part-${index}`} />
    default:
      return <GenericPartView part={p as any} key={`part-${index}`} />
  }
}

export function MessageBubble({ role, parts, createdAt }: MessageBubbleProps) {
  const isUser = role === 'user'
  const rowClass = isUser ? 'msg-row msg-row--user' : 'msg-row msg-row--assistant'
  const bubbleClass = isUser ? 'msg-bubble msg-bubble--user' : 'msg-bubble msg-bubble--assistant'
  const roleLabel = isUser ? 'You' : 'Assistant'

  const [showTime, setShowTime] = useState(false)
  const toggleTime = useCallback(() => {
    'background only'
    setShowTime(prev => !prev)
  }, [])

  const timeText = formatTimestamp(createdAt)

  return (
    <view className={rowClass}>
      {showTime && timeText ? <text className="msg-time">{timeText}</text> : null}
      <text className="msg-role">{roleLabel}</text>
      <view className={bubbleClass} bindtap={toggleTime}>
        {parts.map((part, index) => renderPart(part, index, role))}
      </view>
    </view>
  )
}
