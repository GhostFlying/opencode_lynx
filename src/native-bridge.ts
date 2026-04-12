/**
 * Native bridge adapter for Lynx.
 *
 * Wraps calls through the `nativeBridge` Lynx native module. The native side
 * returns `{ code, msg, data, protocolVersion }` where `code === 1` is
 * success and `code === 0` is failure.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const NATIVE_SUCCESS_CODE = 1
const DEFAULT_TIMEOUT_MS = 30_000

interface CallbackResponse {
  code: number
  msg?: string
  data?: unknown
}

function getContainerID(): string {
  try {
    if (typeof lynx !== 'undefined' && lynx && lynx.__globalProps) {
      return (lynx.__globalProps as Record<string, unknown>).containerID as string ?? ''
    }
    return ''
  } catch {
    return ''
  }
}

function getLynxContext(): typeof lynx {
  if (typeof lynx === 'object' && lynx && typeof lynx.getJSModule === 'function') {
    return lynx
  }
  throw new Error('Lynx context not available.')
}

const lynxNativeBridge = {
  call(
    methodMap: string | { module: string; method: string },
    params: unknown,
    callback: (response: CallbackResponse) => void,
    _options: Record<string, unknown> = {},
  ): void {
    if (typeof callback !== 'function') {
      console.error('[lynxNativeBridge] callback must be a function')
      return
    }

    let module: string
    let method: string

    if (typeof methodMap === 'object' && methodMap !== null) {
      if (!methodMap.module || typeof methodMap.module !== 'string') {
        callback({ code: -1, msg: 'Invalid module name' })
        return
      }
      if (!methodMap.method || typeof methodMap.method !== 'string') {
        callback({ code: -1, msg: 'Invalid method name' })
        return
      }
      module = methodMap.module
      method = methodMap.method
    } else if (typeof methodMap === 'string' && methodMap.trim()) {
      module = 'nativeBridge'
      method = methodMap
    } else {
      callback({ code: -1, msg: 'Invalid methodMap' })
      return
    }

    if (typeof NativeModules === 'undefined') {
      callback({ code: -2, msg: 'NativeModules is not available.' })
      return
    }

    if (!(NativeModules as Record<string, any>)[module]) {
      callback({ code: -3, msg: `Native module "${module}" is not registered.` })
      return
    }

    if (typeof (NativeModules as Record<string, any>)[module].call !== 'function') {
      callback({ code: -4, msg: `Native module "${module}" does not have a callable "call" method.` })
      return
    }

    try {
      ;(NativeModules as Record<string, any>)[module].call(method, {
        containerID: getContainerID(),
        protocolVersion: '1.0.0',
        data: params ?? null,
      }, callback)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      callback({ code: -5, msg: `Bridge call failed: ${errorMsg}` })
    }
  },

  on(eventName: string, callback: (event: unknown) => void): (event: unknown) => void {
    if (!eventName || typeof eventName !== 'string') {
      throw new Error('eventName must be a non-empty string')
    }
    if (typeof callback !== 'function') {
      throw new Error('callback must be a function')
    }

    const context = getLynxContext()
    const eventEmitter = context.getJSModule('GlobalEventEmitter') as {
      addListener?: (name: string, cb: (event: unknown) => void, ctx: unknown) => void
    }
    if (!eventEmitter || typeof eventEmitter.addListener !== 'function') {
      throw new Error('GlobalEventEmitter is not available')
    }

    eventEmitter.addListener(eventName, callback, this)
    return callback
  },

  off(eventName: string, callback: (event: unknown) => void): void {
    if (!eventName || typeof eventName !== 'string') {
      throw new Error('eventName must be a non-empty string')
    }
    if (typeof callback !== 'function') {
      throw new Error('callback must be a function')
    }

    const context = getLynxContext()
    const eventEmitter = context.getJSModule('GlobalEventEmitter') as {
      removeListener?: (name: string, cb: (event: unknown) => void) => void
    }
    if (!eventEmitter || typeof eventEmitter.removeListener !== 'function') {
      throw new Error('GlobalEventEmitter is not available')
    }

    eventEmitter.removeListener(eventName, callback)
  },

  callAsync(
    methodMap: string | { module: string; method: string },
    params: unknown,
    options: Record<string, unknown> = {},
    timeout: number = DEFAULT_TIMEOUT_MS,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Bridge call timeout after ${timeout}ms`))
      }, timeout)

      this.call(methodMap, params, (response: CallbackResponse) => {
        clearTimeout(timer)

        if (response.code === NATIVE_SUCCESS_CODE) {
          resolve(response.data)
        } else {
          const msg = response.msg ?? `Bridge call failed (code: ${response.code})`
          reject(new Error(msg))
        }
      }, options)
    })
  },
}

export default lynxNativeBridge
