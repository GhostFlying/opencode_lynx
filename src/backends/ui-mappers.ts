import type {
  BackendMessage,
  BackendModelInfo,
  BackendProviderInfo,
} from './types.js'

export interface BackendChatSelection {
  agent?: string
  providerID: string
  modelID: string
  variant: string | null
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

export function selectionFromBackendMessage(
  message: BackendMessage,
): BackendChatSelection | null {
  if (message.role !== 'assistant') {
    return null
  }

  const meta = message.backendMeta ?? {}
  const providerID = readString(meta.providerID)
  const modelID = readString(meta.modelID)

  if (!providerID || !modelID) {
    return null
  }

  return {
    ...(readString(meta.agent) ? { agent: readString(meta.agent) } : {}),
    providerID,
    modelID,
    variant: readString(meta.variant) ?? null,
  }
}

export function inferSelectionFromBackendMessages(
  messages: ReadonlyArray<BackendMessage>,
): Partial<BackendChatSelection> | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const selection = selectionFromBackendMessage(messages[i]!)
    if (selection) {
      return selection
    }
  }

  return null
}

export function findBackendProvider(
  catalog: ReadonlyArray<BackendProviderInfo>,
  providerID: string,
): BackendProviderInfo | undefined {
  return catalog.find(provider => provider.id === providerID)
}

export function findBackendModel(
  catalog: ReadonlyArray<BackendProviderInfo>,
  providerID: string,
  modelID: string,
): BackendModelInfo | undefined {
  return findBackendProvider(catalog, providerID)?.models.find(model => model.id === modelID)
}

export function getBackendModelReasoningEffortKeys(
  model: BackendModelInfo | undefined,
): string[] {
  return [...(model?.reasoningEfforts ?? [])]
}
