interface StepStartPartData {
  type: 'step-start'
  snapshot?: string
}

export interface StepStartPartProps {
  part: StepStartPartData
}

export function StepStartPartView({ part }: StepStartPartProps) {
  const hash = part.snapshot
    ? part.snapshot.length > 8 ? part.snapshot.slice(0, 8) : part.snapshot
    : null

  return (
    <view className="step-start-card">
      <view className="step-start-dot" />
      <text className="step-start-label">Step</text>
      {hash ? <text className="step-start-hash">{hash}</text> : null}
    </view>
  )
}
