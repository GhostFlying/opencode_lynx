export type BackendFacadeErrorCode =
  | 'unsupported_backend'
  | 'invalid_backend_input'

interface BackendFacadeErrorOptions {
  cause?: unknown
}

export class BackendFacadeError extends Error {
  readonly code: BackendFacadeErrorCode
  readonly cause?: unknown

  constructor(
    message: string,
    code: BackendFacadeErrorCode,
    options: BackendFacadeErrorOptions = {},
  ) {
    super(message)
    this.name = 'BackendFacadeError'
    this.code = code
    this.cause = options.cause
  }
}
