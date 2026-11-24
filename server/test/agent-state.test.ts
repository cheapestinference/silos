import { describe, expect, it } from 'vitest'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentStateStore } from '../src/agent-state.js'

const mk = () => new AgentStateStore(mkdtempSync(join(tmpdir(), 'agent-state-')))

describe('AgentStateStore', () => {
  it('dirFor creates the per-agent dir 0700 and envFor exposes it as SILOS_AGENT_STATE', () => {
    const store = mk()
    const dir = store.dirFor('finance')
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(store.envFor('finance')).toEqual({ SILOS_AGENT_STATE: dir, SILOS_AGENT_ID: 'finance' })
  })

  it('rejects agent ids that could escape the base dir', () => {
    const store = mk()
    for (const bad of ['../x', 'a/b', '', '.', 'a\\b']) {
      expect(() => store.dirFor(bad)).toThrow(/agent id/)
    }
  })
})
