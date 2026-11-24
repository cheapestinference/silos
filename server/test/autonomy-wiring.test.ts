// The env var must reach BOTH engines through the same merge points the
// Vault already uses — test at those seams, not through a live server.
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentStateStore } from '../src/agent-state.js'

describe('agent-state env seam', () => {
  it('envFor merges after provider env without clobbering unrelated keys', () => {
    const state = new AgentStateStore(mkdtempSync(join(tmpdir(), 'wire-')))
    const merged = { FOO: 'bar', ...state.envFor('finance') }
    expect(merged.FOO).toBe('bar')
    expect(merged.SILOS_AGENT_STATE).toContain('finance')
  })
})
