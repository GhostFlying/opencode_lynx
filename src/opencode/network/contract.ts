export interface OpencodeNetworkRequest {
  path: string
  method?: string
  headers?: Record<string, string>
  body?: unknown
}

export interface OpencodeNetworkResponse<TBody = unknown> {
  status: number
  headers: Record<string, string>
  body: TBody
}

export interface OpencodeNetworkSseOpenInput {
  path: string
  headers?: Record<string, string>
  event_name?: string
}

export interface OpencodeNetworkSseHandle {
  id: string
}

export interface OpencodeNetworkSseApi {
  open(input: OpencodeNetworkSseOpenInput): Promise<OpencodeNetworkSseHandle>
  close(handle: OpencodeNetworkSseHandle): Promise<void>
}

export interface OpencodeNetworkApi {
  request<TBody = unknown>(input: OpencodeNetworkRequest): Promise<OpencodeNetworkResponse<TBody>>
  sse: OpencodeNetworkSseApi
}

