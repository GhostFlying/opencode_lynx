import { describe, expect, it } from 'vitest'

import {
  V1_DEFAULT_WORKSPACE,
  resolveDirectory,
  resolveWorkspaceSelector,
} from '../config.js'
import type {
  OpencodeClientScope,
  OpencodeWorkspaceSelector,
  OpencodeWrapperConfig,
} from '../types.js'

describe('single-workspace policy (v1)', () => {
  it('uses deterministic default workspace when none provided', () => {
    const selector = resolveWorkspaceSelector({}, undefined)

    expect(selector).toEqual<OpencodeWorkspaceSelector>({ id: V1_DEFAULT_WORKSPACE })
  })

  it('allows default workspace override explicitly', () => {
    const config: Pick<OpencodeWrapperConfig, 'workspace'> = {
      workspace: { id: V1_DEFAULT_WORKSPACE },
    }
    const scope: Pick<OpencodeClientScope, 'workspace'> = {
      workspace: { id: V1_DEFAULT_WORKSPACE },
    }

    const selector = resolveWorkspaceSelector(config, scope)

    expect(selector).toEqual({ id: V1_DEFAULT_WORKSPACE })
  })

  it('guards non-default workspace override at runtime', () => {
    const scope: Pick<OpencodeClientScope, 'workspace'> = {
      workspace: { id: 'another-workspace' },
    }

    expect(() => resolveWorkspaceSelector({}, scope)).toThrow(
      'Single-workspace mode only allows workspace "default" in v1.',
    )
  })

  it('guards disallowed workspace in config at runtime', () => {
    const config: Pick<OpencodeWrapperConfig, 'workspace'> = {
      workspace: { id: 'custom-workspace' },
    }

    expect(() => resolveWorkspaceSelector(config, undefined)).toThrow(
      'Single-workspace mode only allows workspace "default" in v1.',
    )
  })

  it('still resolves directory while enforcing workspace policy seam', () => {
    const config: Pick<OpencodeWrapperConfig, 'directory' | 'workspace'> = {
      directory: '/repo/default',
      workspace: { id: V1_DEFAULT_WORKSPACE },
    }
    const scope: OpencodeClientScope = {
      directory: '/repo/override',
      workspace: { id: V1_DEFAULT_WORKSPACE },
    }

    expect(resolveDirectory(config, scope)).toBe('/repo/override')
  })
})
