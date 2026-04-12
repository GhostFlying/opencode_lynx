/**
 * Async key-value storage backed by the native `storage.*` bridge methods
 * (see `ios/OpenCodeLynx/.../StorageServiceImpl.swift`).
 *
 * Lynx does NOT implement Web Storage — `localStorage` is a bare IIFE
 * parameter that stays `undefined` at runtime, so any `localStorage.getItem`
 * call throws silently. Use this module instead for anything that must
 * survive across LynxView instances or cold starts.
 *
 * The native side namespaces all keys with `opencodelynx.` in
 * NSUserDefaults, so callers pass short, unprefixed keys here.
 */

import lynxNativeBridge from './native-bridge.js'

const METHOD_GET = 'storage.get'
const METHOD_SET = 'storage.set'
const METHOD_REMOVE = 'storage.remove'

export async function storageGet(key: string): Promise<string | null> {
  if (!key) return null
  try {
    const data = (await lynxNativeBridge.callAsync(METHOD_GET, { key })) as
      | { value?: string | null }
      | null
      | undefined
    if (!data || typeof data.value !== 'string') return null
    return data.value
  } catch {
    return null
  }
}

export async function storageSet(key: string, value: string): Promise<void> {
  if (!key) return
  try {
    await lynxNativeBridge.callAsync(METHOD_SET, { key, value })
  } catch {
    // best-effort: persistence failure shouldn't crash the caller
  }
}

export async function storageRemove(key: string): Promise<void> {
  if (!key) return
  try {
    await lynxNativeBridge.callAsync(METHOD_REMOVE, { key })
  } catch {
    // best-effort
  }
}
