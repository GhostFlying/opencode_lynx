/**
 * @typedef {'ios' | 'android' | 'both'} ChangedPlatform
 * @typedef {{ status: string, path?: string, fromPath?: string, toPath?: string }} ChangedFile
 */

const SHARED_PREFIXES = [
  'src/',
  'resource/',
]

const SHARED_FILES = new Set([
  'app.config.ts',
  'package.json',
  'pnpm-lock.yaml',
])

const IOS_PREFIX = 'ios/'
const ANDROID_PREFIX = 'android/'

/**
 * @param {string} rawPath
 * @returns {string}
 */
function normalizePath(rawPath) {
  return rawPath.replaceAll('\\', '/').trim()
}

/**
 * @param {string} path
 * @returns {ChangedPlatform}
 */
function classifyPath(path) {
  const normalized = normalizePath(path)

  if (normalized.length === 0) {
    return 'both'
  }

  if (SHARED_FILES.has(normalized)) {
    return 'both'
  }

  if (SHARED_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
    return 'both'
  }

  if (normalized.startsWith(IOS_PREFIX)) {
    return 'ios'
  }

  if (normalized.startsWith(ANDROID_PREFIX)) {
    return 'android'
  }

  return 'both'
}

/**
 * @param {ChangedFile} change
 * @returns {string[]}
 */
function extractCandidatePaths(change) {
  const paths = new Set()
  const status = (change.status ?? '').toUpperCase()

  if (status.startsWith('R')) {
    if (typeof change.fromPath === 'string') {
      paths.add(change.fromPath)
    }

    if (typeof change.toPath === 'string') {
      paths.add(change.toPath)
    }

    if (typeof change.path === 'string') {
      paths.add(change.path)
    }

    return [...paths]
  }

  if (typeof change.path === 'string') {
    paths.add(change.path)
  }

  if (typeof change.fromPath === 'string') {
    paths.add(change.fromPath)
  }

  if (typeof change.toPath === 'string') {
    paths.add(change.toPath)
  }

  return [...paths]
}

/**
 * Classify changed paths into platform impact, using conservative fallback.
 * Unknown or unmatched paths intentionally fail-closed to `both`.
 *
 * @param {ChangedFile[]} changes
 * @returns {ChangedPlatform}
 */
export function classifyChangedPlatform(changes) {
  if (!Array.isArray(changes) || changes.length === 0) {
    return 'both'
  }

  let hasIOS = false
  let hasAndroid = false

  for (const change of changes) {
    const candidatePaths = extractCandidatePaths(change)

    if (candidatePaths.length === 0) {
      return 'both'
    }

    for (const path of candidatePaths) {
      const classification = classifyPath(path)

      if (classification === 'both') {
        return 'both'
      }

      if (classification === 'ios') {
        hasIOS = true
      }

      if (classification === 'android') {
        hasAndroid = true
      }

      if (hasIOS && hasAndroid) {
        return 'both'
      }
    }
  }

  if (hasIOS) {
    return 'ios'
  }

  if (hasAndroid) {
    return 'android'
  }

  return 'both'
}
