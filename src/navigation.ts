/**
 * Navigation module: opens and closes Lynx pages via the native bridge.
 *
 * Calls the native `navigation.open` / `navigation.close` bridge methods
 * through the lynxNativeBridge adapter.
 */

import lynxNativeBridge from './native-bridge.js'

export function open(
  params: { scheme: string },
  callback?: (result: unknown) => void,
): void {
  lynxNativeBridge.call('navigation.open', params, (response) => {
    callback?.(response.data)
  })
}

export function close(): void {
  lynxNativeBridge.call('navigation.close', null, () => {})
}
