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
  /** Marker from BackendMessage.backendMeta — if `kind === 'turnError'`,
   *  render the bubble with a distinct error style instead of the
   *  generic assistant variant. Codex's adapter sets this when folding
   *  a terminal `error` notification into the in-adapter store. */
  kind?: string
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

function renderPart(part: unknown, index: number, role: string, isError: boolean) {
  const p = part as { type?: string }
  if (!p || typeof p.type !== 'string') {
    return null
  }

  switch (p.type) {
    case 'text':
      return (
        <TextPartView
          part={p as any}
          role={isError ? 'error' : role}
          key={`part-${index}`}
        />
      )
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

export function MessageBubble({ role, parts, createdAt, kind }: MessageBubbleProps) {
  const isUser = role === 'user'
  const isError = kind === 'turnError'

  let rowClass: string
  let bubbleClass: string
  let roleLabel: string
  let roleClass = 'msg-role'

  if (isError) {
    rowClass = 'msg-row msg-row--system'
    bubbleClass = 'msg-bubble msg-bubble--error'
    roleLabel = 'Turn failed'
    roleClass = 'msg-role msg-role--error'
  } else if (isUser) {
    rowClass = 'msg-row msg-row--user'
    bubbleClass = 'msg-bubble msg-bubble--user'
    roleLabel = 'You'
  } else {
    rowClass = 'msg-row msg-row--assistant'
    bubbleClass = 'msg-bubble msg-bubble--assistant'
    roleLabel = 'Assistant'
  }

  const [showTime, setShowTime] = useState(false)
  const toggleTime = useCallback(() => {
    'background only'
    setShowTime(prev => !prev)
  }, [])

  const timeText = formatTimestamp(createdAt)

  return (
    <view className={rowClass}>
      {showTime && timeText ? <text className="msg-time">{timeText}</text> : null}
      <text className={roleClass}>{roleLabel}</text>
      <view className={bubbleClass} bindtap={toggleTime}>
        {parts.map((part, index) => renderPart(part, index, role, isError))}
      </view>
    </view>
  )
}
