import { useCallback, useState } from '@lynx-js/react'

interface ToolState {
  status?: string
  input?: unknown
  output?: string
  error?: string
  title?: string
}

interface ToolPartData {
  type: 'tool'
  tool?: string
  callID?: string
  state?: ToolState
}

export interface ToolPartProps {
  part: ToolPartData
}

function dotClass(status: string | undefined): string {
  switch (status) {
    case 'running':
      return 'tool-dot tool-dot--running'
    case 'completed':
      return 'tool-dot tool-dot--completed'
    case 'error':
      return 'tool-dot tool-dot--error'
    default:
      return 'tool-dot tool-dot--pending'
  }
}

function formatInput(input: unknown): string {
  if (input === undefined || input === null) {
    return ''
  }
  if (typeof input === 'string') {
    return input
  }
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

function truncate(str: string, max: number): string {
  if (str.length <= max) {
    return str
  }
  return str.slice(0, max) + '...'
}

export function ToolPartView({ part }: ToolPartProps) {
  const [expanded, setExpanded] = useState(false)
  const state = part.state
  const status = state?.status ?? 'pending'
  const toolName = part.tool ?? 'unknown'
  const title = state?.title

  const handleToggle = useCallback(() => {
    'background only'
    setExpanded(prev => !prev)
  }, [])

  const inputStr = formatInput(state?.input)
  const outputStr = state?.output ?? ''
  const errorStr = state?.error ?? ''
  const hasDetails = inputStr.length > 0 || outputStr.length > 0 || errorStr.length > 0

  return (
    <view className="tool-card">
      <view className="tool-header">
        <view className={dotClass(status)} />
        <text className="tool-name">{toolName}</text>
        <text className="tool-status">{status}</text>
      </view>

      {title ? <text className="tool-title">{title}</text> : null}

      {status === 'error' && errorStr.length > 0
        ? <text className="tool-error-text">{truncate(errorStr, 200)}</text>
        : null}

      {hasDetails
        ? (
          <view className="tool-toggle" bindtap={handleToggle}>
            <text className="tool-toggle-text">
              {expanded ? 'Hide details' : 'Show details'}
            </text>
          </view>
        )
        : null}

      {expanded && inputStr.length > 0
        ? (
          <view>
            <text className="tool-content-label">Input</text>
            <text className="tool-content">{truncate(inputStr, 1000)}</text>
          </view>
        )
        : null}

      {expanded && outputStr.length > 0
        ? (
          <view>
            <text className="tool-content-label">Output</text>
            <text className="tool-content">{truncate(outputStr, 1000)}</text>
          </view>
        )
        : null}
    </view>
  )
}
