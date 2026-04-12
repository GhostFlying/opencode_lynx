import { useCallback, useState } from '@lynx-js/react'

export interface PickerOption {
  key: string
  title: string
  subtitle?: string
  disabled?: boolean
}

export interface PickerOverlayProps {
  title: string
  options: PickerOption[]
  selectedKey?: string
  emptyText?: string
  searchable?: boolean
  searchPlaceholder?: string
  onSelect: (key: string) => void
  onClose: () => void
}

/**
 * Bottom-sheet picker used by the chat input's agent/model/effort chips.
 *
 * Layout: translucent backdrop that closes on tap + a rounded sheet pinned to
 * the bottom of the viewport. We rely on `catchtap` on the sheet to stop the
 * backdrop's tap-to-close from firing when users interact inside the list.
 *
 * When `searchable` is true, a filter input appears between title and list.
 */
export function PickerOverlay({
  title,
  options,
  selectedKey,
  emptyText,
  searchable,
  searchPlaceholder,
  onSelect,
  onClose,
}: PickerOverlayProps) {
  const [query, setQuery] = useState('')

  const handleBackdropTap = useCallback(() => {
    'background only'
    onClose()
  }, [onClose])

  const handleSheetTap = useCallback(() => {
    'background only'
    // Intentional no-op — `catchtap` swallows the event so the backdrop's
    // close handler doesn't fire.
  }, [])

  const handleSearchInput = useCallback((e: { detail: { value: string } }) => {
    'background only'
    setQuery(e.detail.value)
  }, [])

  const trimmed = query.trim().toLowerCase()
  const filtered = searchable && trimmed.length > 0
    ? options.filter((opt) => {
        if (opt.title.toLowerCase().includes(trimmed)) return true
        if (opt.subtitle && opt.subtitle.toLowerCase().includes(trimmed)) return true
        return false
      })
    : options

  return (
    <view className="picker-overlay" bindtap={handleBackdropTap}>
      <view className="picker-sheet" catchtap={handleSheetTap}>
        <view className="picker-handle" />
        <text className="picker-title">{title}</text>
        {searchable ? (
          <view className="picker-search">
            <input
              className="picker-search-input"
              style={{ color: '#0e191f' }}
              placeholder={searchPlaceholder ?? 'Search...'}
              bindinput={handleSearchInput}
            />
          </view>
        ) : null}
        {filtered.length === 0 ? (
          <view className="picker-empty">
            <text className="picker-empty-text">
              {searchable && trimmed.length > 0
                ? 'No matches'
                : (emptyText ?? 'No options available')}
            </text>
          </view>
        ) : (
          <scroll-view
            scroll-orientation="vertical"
            className="picker-list"
          >
            {filtered.map((opt) => (
              <PickerRow
                key={opt.key}
                option={opt}
                selected={opt.key === selectedKey}
                onSelect={onSelect}
              />
            ))}
          </scroll-view>
        )}
      </view>
    </view>
  )
}

interface PickerRowProps {
  option: PickerOption
  selected: boolean
  onSelect: (key: string) => void
}

function PickerRow({ option, selected, onSelect }: PickerRowProps) {
  const handleTap = useCallback(() => {
    'background only'
    if (option.disabled) return
    onSelect(option.key)
  }, [option.key, option.disabled, onSelect])

  const rowClass = option.disabled
    ? 'picker-row picker-row--disabled'
    : selected
      ? 'picker-row picker-row--selected'
      : 'picker-row'

  return (
    <view className={rowClass} bindtap={handleTap}>
      <text className={selected ? 'picker-check picker-check--on' : 'picker-check'}>
        {selected ? '\u2713' : ''}
      </text>
      <view className="picker-text">
        <text className="picker-row-title">{option.title}</text>
        {option.subtitle ? (
          <text className="picker-row-sub">{option.subtitle}</text>
        ) : null}
      </view>
    </view>
  )
}
