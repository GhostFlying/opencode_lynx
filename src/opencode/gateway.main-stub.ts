/**
 * Main-thread stub for the gateway module.
 *
 * On Lynx's main thread (Lepus / QuickJS), only UI rendering runs.
 * Event handlers, effects, and business logic run on the background thread.
 * The real gateway module imports @opencode-ai/sdk which references Web APIs
 * (Headers, Response, etc.) at module scope — these don't exist on the main
 * thread and would crash. This stub provides the same export shape so the
 * main-thread component code can be evaluated without errors.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createOpencodeGateway(): any {
  throw new Error('createOpencodeGateway is not available on the Lynx main thread.')
}

export const OpenCodeGateway = {
  create: createOpencodeGateway,
} as const
