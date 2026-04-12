interface StepFinishPartData {
  type: 'step-finish'
  reason?: string
  cost?: number
  tokens?: {
    total?: number
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
}

export interface StepFinishPartProps {
  part: StepFinishPartData
}

function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export function StepFinishPartView({ part }: StepFinishPartProps) {
  const tokens = part.tokens
  const reason = part.reason

  const segments: string[] = []
  if (tokens?.input) segments.push(`in ${formatTokenCount(tokens.input)}`)
  if (tokens?.output) segments.push(`out ${formatTokenCount(tokens.output)}`)
  if (tokens?.reasoning) segments.push(`reasoning ${formatTokenCount(tokens.reasoning)}`)
  if (tokens?.cache?.read) segments.push(`cache ${formatTokenCount(tokens.cache.read)}`)

  const costStr = part.cost != null && part.cost > 0
    ? `$${part.cost.toFixed(4)}`
    : null

  const reasonLabel = reason === 'stop' ? 'Done' : reason === 'tool-calls' ? 'Tools' : reason ?? ''

  return (
    <view className="step-finish-card">
      <view className="step-finish-header">
        <view className="step-finish-dot" />
        <text className="step-finish-label">{reasonLabel}</text>
        {costStr ? <text className="step-finish-cost">{costStr}</text> : null}
      </view>
      {segments.length > 0
        ? <text className="step-finish-tokens">{segments.join('  ')}</text>
        : null}
    </view>
  )
}
