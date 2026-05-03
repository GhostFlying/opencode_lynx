import { useCallback, useEffect, useRef } from '@lynx-js/react'
import type { InputRef } from '@lynx-js/lynx-ui'
import { Input, KeyboardAwareTrigger } from '@lynx-js/lynx-ui'

export interface NewSessionCardProps {
  directory: string
  knownDirectories: string[]
  agentLabel: string
  modelLabel: string
  effortLabel: string
  variantAvailable: boolean
  agentPickerEnabled?: boolean
  onDirectoryInput: (next: string) => void
  onPickDirectory: (dir: string) => void
  onOpenAgent: () => void
  onOpenModel: () => void
  onOpenEffort: () => void
}

interface DirectoryChipProps {
  dir: string
  active: boolean
  onTap: (dir: string) => void
}

function DirectoryChip({ dir, active, onTap }: DirectoryChipProps) {
  const handleTap = useCallback(() => {
    'background only'
    onTap(dir)
  }, [dir, onTap])
  const className = active ? 'new-session-card__chip new-session-card__chip--active' : 'new-session-card__chip'
  return (
    <view className={className} bindtap={handleTap}>
      <text className="new-session-card__chip-text">{dir}</text>
    </view>
  )
}

export function NewSessionCard({
  directory,
  knownDirectories,
  agentLabel,
  modelLabel,
  effortLabel,
  variantAvailable,
  agentPickerEnabled = true,
  onDirectoryInput,
  onPickDirectory,
  onOpenAgent,
  onOpenModel,
  onOpenEffort,
}: NewSessionCardProps) {
  const handleInput = useCallback((value: string) => {
    'background only'
    onDirectoryInput(value)
  }, [onDirectoryInput])

  // Uncontrolled input (defaultValue + ref) keeps native typing snappy. We sync
  // via setValue ONLY when the parent's value diverges from what the user is
  // typing — i.e., when a chip tap programmatically changes the directory.
  const inputRef = useRef<InputRef>(null)
  const lastSyncedRef = useRef<string>(directory)
  useEffect(() => {
    if (directory !== lastSyncedRef.current) {
      lastSyncedRef.current = directory
      inputRef.current?.setValue(directory).catch(() => {})
    }
  }, [directory])

  return (
    <view className="new-session-card">
      <view className="new-session-card__header">
        <text className="new-session-card__eyebrow">New session</text>
        <text className="new-session-card__title">Configure and send your first message</text>
      </view>

      <view className="new-session-card__field">
        <text className="new-session-card__label">Working directory</text>
        <KeyboardAwareTrigger className="new-session-card__input-wrap">
          <Input
            ref={inputRef}
            className="new-session-card__input"
            style={{ color: '#0e191f' }}
            defaultValue={directory}
            placeholder="/path/to/your/repo"
            onInput={handleInput}
          />
        </KeyboardAwareTrigger>
        {knownDirectories.length > 0 ? (
          <scroll-view
            className="new-session-card__chip-row"
            scroll-orientation="horizontal"
          >
            {knownDirectories.map((dir) => (
              <DirectoryChip
                key={dir}
                dir={dir}
                active={dir === directory}
                onTap={onPickDirectory}
              />
            ))}
          </scroll-view>
        ) : null}
      </view>

      {agentPickerEnabled ? (
        <view className="new-session-card__field">
          <text className="new-session-card__label">Agent</text>
          <view className="new-session-card__pill" bindtap={onOpenAgent}>
            <text className="new-session-card__pill-text">{agentLabel}</text>
            <text className="new-session-card__pill-caret">{'▾'}</text>
          </view>
        </view>
      ) : null}

      <view className="new-session-card__field">
        <text className="new-session-card__label">Model</text>
        <view className="new-session-card__pill" bindtap={onOpenModel}>
          <text className="new-session-card__pill-text">{modelLabel}</text>
          <text className="new-session-card__pill-caret">{'▾'}</text>
        </view>
      </view>

      {variantAvailable ? (
        <view className="new-session-card__field">
          <text className="new-session-card__label">Effort</text>
          <view className="new-session-card__pill" bindtap={onOpenEffort}>
            <text className="new-session-card__pill-text">{effortLabel}</text>
            <text className="new-session-card__pill-caret">{'▾'}</text>
          </view>
        </view>
      ) : null}

      <text className="new-session-card__hint">
        Type your first message below — the session is created on send.
      </text>
    </view>
  )
}
