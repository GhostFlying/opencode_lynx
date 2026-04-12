interface PatchPartData {
  type: 'patch'
  hash?: string
  files?: string[]
}

export interface PatchPartProps {
  part: PatchPartData
}

function basename(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx >= 0 ? path.slice(idx + 1) : path
}

const MAX_VISIBLE_FILES = 5

export function PatchPartView({ part }: PatchPartProps) {
  const hash = part.hash
    ? part.hash.length > 8 ? part.hash.slice(0, 8) : part.hash
    : null

  const files = part.files ?? []
  const total = files.length
  const visible = total > MAX_VISIBLE_FILES ? files.slice(0, MAX_VISIBLE_FILES - 1) : files
  const remaining = total > MAX_VISIBLE_FILES ? total - visible.length : 0

  const summary = total === 1 ? '1 file changed' : `${total} files changed`

  return (
    <view className="patch-card">
      <view className="patch-header">
        <view className="patch-dot" />
        <text className="patch-label">Patch</text>
        {hash ? <text className="patch-hash">{hash}</text> : null}
      </view>

      {visible.map((f, i) => (
        <text className="patch-file" key={`pf-${i}`}>{basename(f)}</text>
      ))}
      {remaining > 0
        ? <text className="patch-more">+ {remaining} more</text>
        : null}

      <text className="patch-summary">{summary}</text>
    </view>
  )
}
