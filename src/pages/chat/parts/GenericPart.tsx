interface GenericPartData {
  type: string
  filename?: string
  mime?: string
  files?: string[]
  name?: string
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
  }
}

export interface GenericPartProps {
  part: GenericPartData
}

function renderDetail(part: GenericPartData): string {
  switch (part.type) {
    case 'file': {
      const name = part.filename ?? 'unnamed'
      const mime = part.mime ?? ''
      return mime ? `${name} (${mime})` : name
    }
    case 'patch': {
      const files = part.files ?? []
      if (files.length === 0) return 'No files'
      return files.join(', ')
    }
    case 'agent':
      return part.name ?? 'sub-agent'
    case 'step-start':
      return 'Step started'
    case 'step-finish': {
      const tokens = part.tokens
      if (!tokens) return 'Step finished'
      const parts: string[] = []
      if (tokens.input) parts.push(`in:${tokens.input}`)
      if (tokens.output) parts.push(`out:${tokens.output}`)
      if (tokens.reasoning) parts.push(`reasoning:${tokens.reasoning}`)
      const costStr = part.cost != null ? ` | $${part.cost.toFixed(4)}` : ''
      return parts.join(' ') + costStr
    }
    case 'snapshot':
      return 'Snapshot'
    default:
      return part.type
  }
}

export function GenericPartView({ part }: GenericPartProps) {
  return (
    <view className="generic-card">
      <text className="generic-type">{part.type}</text>
      <text className="generic-detail">{renderDetail(part)}</text>
    </view>
  )
}
