import { describe, expect, it } from 'vitest'

import type { BackendMessage, BackendProviderInfo } from '../types.js'
import {
  findBackendModel,
  findBackendProvider,
  getBackendModelReasoningEffortKeys,
  inferSelectionFromBackendMessages,
  selectionFromBackendMessage,
} from '../ui-mappers.js'

describe('backend UI mappers', () => {
  it('extracts chat selection metadata from assistant messages only', () => {
    const userMessage: BackendMessage = {
      id: 'user-1',
      sessionID: 'session-1',
      role: 'user',
      parts: [],
      backendMeta: {
        providerID: 'anthropic',
        modelID: 'claude',
      },
    }
    const assistantWithoutModel: BackendMessage = {
      id: 'assistant-1',
      sessionID: 'session-1',
      role: 'assistant',
      parts: [],
      backendMeta: {
        providerID: 'anthropic',
      },
    }
    const assistantWithModel: BackendMessage = {
      id: 'assistant-2',
      sessionID: 'session-1',
      role: 'assistant',
      parts: [],
      backendMeta: {
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4',
        agent: 'build',
        variant: 'high',
      },
    }

    expect(selectionFromBackendMessage(userMessage)).toBeNull()
    expect(selectionFromBackendMessage(assistantWithoutModel)).toBeNull()
    expect(selectionFromBackendMessage(assistantWithModel)).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4',
      agent: 'build',
      variant: 'high',
    })
  })

  it('infers the newest assistant selection and defaults missing variant to null', () => {
    const messages: BackendMessage[] = [
      {
        id: 'assistant-older',
        sessionID: 'session-1',
        role: 'assistant',
        parts: [],
        backendMeta: {
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4',
          variant: 'low',
        },
      },
      {
        id: 'assistant-newer',
        sessionID: 'session-1',
        role: 'assistant',
        parts: [],
        backendMeta: {
          providerID: 'openai',
          modelID: 'gpt-5.2',
        },
      },
    ]

    expect(inferSelectionFromBackendMessages(messages)).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.2',
      variant: null,
    })
    expect(inferSelectionFromBackendMessages([])).toBeNull()
  })

  it('finds providers, models, and reasoning effort keys from backend catalog data', () => {
    const catalog: BackendProviderInfo[] = [
      {
        id: 'anthropic',
        name: 'Anthropic',
        models: [
          {
            id: 'claude-sonnet-4',
            name: 'Claude Sonnet 4',
            reasoning: true,
            reasoningEfforts: ['low', 'high'],
          },
        ],
      },
    ]

    expect(findBackendProvider(catalog, 'anthropic')).toBe(catalog[0])
    expect(findBackendProvider(catalog, 'openai')).toBeUndefined()
    expect(findBackendModel(catalog, 'anthropic', 'claude-sonnet-4')).toBe(catalog[0]!.models[0])
    expect(findBackendModel(catalog, 'anthropic', 'missing')).toBeUndefined()
    expect(getBackendModelReasoningEffortKeys(catalog[0]!.models[0])).toEqual(['low', 'high'])
    expect(getBackendModelReasoningEffortKeys(undefined)).toEqual([])
  })
})
