export interface SafeAreaInsets {
  top: number
  right: number
  bottom: number
  left: number
}

const ZERO_SAFE_AREA: SafeAreaInsets = {
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toInsetNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

export function px(value: number): string {
  if (!Number.isFinite(value) || value === 0) {
    return '0'
  }
  return `${value}px`
}

export function readSafeAreaInsetsFromGlobalProps(): SafeAreaInsets {
  if (typeof lynx === 'undefined') {
    return ZERO_SAFE_AREA
  }

  const globalProps = lynx.__globalProps
  if (!isRecord(globalProps)) {
    return ZERO_SAFE_AREA
  }

  const safeAreaInsets = globalProps.safeAreaInsets
  if (!isRecord(safeAreaInsets)) {
    return ZERO_SAFE_AREA
  }

  return {
    top: toInsetNumber(safeAreaInsets.top),
    right: toInsetNumber(safeAreaInsets.right),
    bottom: toInsetNumber(safeAreaInsets.bottom),
    left: toInsetNumber(safeAreaInsets.left),
  }
}
