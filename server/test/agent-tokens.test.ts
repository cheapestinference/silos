import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentTokens } from '../src/agent-tokens.js'
import { AgentStateStore } from '../src/agent-state.js'

const mk = () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-tokens-'))
  return { dataDir, tokens: new AgentTokens(dataDir) }
}

describe('AgentTokens', () => {
  it('mints once and reuses; file at <dataDir>/agents/<id>/token, 0600, 32 bytes hex', () => {
    const { dataDir, tokens } = mk()
    const t = tokens.tokenFor('builder')
    expect(t).toMatch(/^[0-9a-f]{64}$/)
    expect(tokens.tokenFor('builder')).toBe(t)
    const file = join(dataDir, 'agents', 'builder', 'token')
    expect(readFileSync(file, 'utf8').trim()).toBe(t)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(join(dataDir, 'agents', 'builder')).mode & 0o777).toBe(0o700)
    // a fresh instance over the same dir reads the same token
    expect(new AgentTokens(dataDir).tokenFor('builder')).toBe(t)
  })

  it('agentIdOf resolves a minted token and returns null for anything else', () => {
    const { tokens } = mk()
    const builder = tokens.tokenFor('builder')
    const finance = tokens.tokenFor('finance')
    expect(tokens.agentIdOf(builder)).toBe('builder')
    expect(tokens.agentIdOf(finance)).toBe('finance')
    expect(tokens.agentIdOf('deadbeef'.repeat(8))).toBeNull()
    expect(tokens.agentIdOf('')).toBeNull()
  })

  it('rotate invalidates the old token', () => {
    const { tokens } = mk()
    const old = tokens.tokenFor('builder')
    const fresh = tokens.rotate('builder')
    expect(fresh).not.toBe(old)
    expect(tokens.agentIdOf(old)).toBeNull()
    expect(tokens.agentIdOf(fresh)).toBe('builder')
    expect(tokens.tokenFor('builder')).toBe(fresh)
  })

  it('revoke deletes the token file: the old bearer stops resolving, the next tokenFor mints a new one', () => {
    const { dataDir, tokens } = mk()
    const old = tokens.tokenFor('builder')
    tokens.revoke('builder')
    expect(existsSync(join(dataDir, 'agents', 'builder', 'token'))).toBe(false)
    expect(tokens.agentIdOf(old)).toBeNull()
    expect(() => tokens.revoke('builder')).not.toThrow() // nothing to revoke: fine
    expect(() => tokens.revoke('never-minted')).not.toThrow()
    const fresh = tokens.tokenFor('builder')
    expect(fresh).not.toBe(old)
    expect(tokens.agentIdOf(fresh)).toBe('builder')
    expect(() => tokens.revoke('../x')).toThrow(/agent id/)
  })

  it('rejects unsafe agent ids', () => {
    const { tokens } = mk()
    for (const bad of ['../x', 'a/b', '', '.']) expect(() => tokens.tokenFor(bad)).toThrow(/agent id/)
  })

  it('AgentStateStore.envFor adds SILOS_AGENT_TOKEN when given a token provider', () => {
    const { dataDir, tokens } = mk()
    const state = new AgentStateStore(join(dataDir, 'agent-state'), tokens)
    expect(state.envFor('builder')).toEqual({
      SILOS_AGENT_STATE: join(dataDir, 'agent-state', 'builder'),
      SILOS_AGENT_ID: 'builder',
      SILOS_AGENT_TOKEN: tokens.tokenFor('builder'),
    })
  })

  it('envFor degrades to state+id (no token) when minting fails, with one warning', () => {
    const { dataDir } = mk()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const state = new AgentStateStore(join(dataDir, 'agent-state'), {
      tokenFor: () => {
        throw new Error('EACCES')
      },
    })
    expect(state.envFor('builder')).toEqual({ SILOS_AGENT_STATE: join(dataDir, 'agent-state', 'builder'), SILOS_AGENT_ID: 'builder' })
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  // identity for every agent,
  // master included — the three master locks are gone.
  it('master holds a token like any agent: tokenFor and rotate mint, agentIdOf resolves it to master', () => {
    const { dataDir, tokens } = mk()
    const t = tokens.tokenFor('master')
    expect(t).toMatch(/^[0-9a-f]{64}$/)
    expect(existsSync(join(dataDir, 'agents', 'master', 'token'))).toBe(true)
    expect(tokens.agentIdOf(t)).toBe('master')
    const fresh = tokens.rotate('master')
    expect(tokens.agentIdOf(t)).toBeNull()
    expect(tokens.agentIdOf(fresh)).toBe('master')
  })

  it("envFor('master') carries SILOS_AGENT_TOKEN and that bearer resolves to master", () => {
    const { dataDir, tokens } = mk()
    const state = new AgentStateStore(join(dataDir, 'agent-state'), tokens)
    const env = state.envFor('master')
    expect(env.SILOS_AGENT_ID).toBe('master')
    expect(env.SILOS_AGENT_TOKEN).toMatch(/^[0-9a-f]{64}$/)
    expect(tokens.agentIdOf(env.SILOS_AGENT_TOKEN!)).toBe('master')
  })

  it('envFor hands every agent its SILOS_AGENT_TOKEN — the fence plays no part (G1)', () => {
    const { dataDir, tokens } = mk()
    const state = new AgentStateStore(join(dataDir, 'agent-state'), tokens)
    expect(state.envFor('builder').SILOS_AGENT_TOKEN).toBe(tokens.tokenFor('builder'))
    expect(existsSync(join(dataDir, 'agents', 'builder', 'token'))).toBe(true)
  })

  // G8-r6: bearers authenticate against MEMORY, loaded at boot — never a
  // read of the disk per request.
  it('a token PLANTED on disk after boot never authenticates', () => {
    const { dataDir, tokens } = mk()
    const builder = tokens.tokenFor('builder')
    // a new agent's file appears after boot
    mkdirSync(join(dataDir, 'agents', 'finance'), { recursive: true })
    const planted = 'ab'.repeat(32)
    writeFileSync(join(dataDir, 'agents', 'finance', 'token'), planted)
    expect(tokens.agentIdOf(planted)).toBeNull()
    // …and minting for it never adopts the planted value
    const minted = tokens.tokenFor('finance')
    expect(minted).not.toBe(planted)
    expect(readFileSync(join(dataDir, 'agents', 'finance', 'token'), 'utf8').trim()).toBe(minted)
    expect(tokens.agentIdOf(planted)).toBeNull()
    // an existing agent's file overwritten after boot: the planted value
    // does not authenticate, the live one still does
    const planted2 = 'cd'.repeat(32)
    writeFileSync(join(dataDir, 'agents', 'builder', 'token'), planted2)
    expect(tokens.agentIdOf(planted2)).toBeNull()
    expect(tokens.agentIdOf(builder)).toBe('builder')
    expect(tokens.tokenFor('builder')).toBe(builder)
  })

  it('tokens on disk at boot are the live ones (a restart keeps every agent its bearer)', () => {
    const { dataDir, tokens } = mk()
    const builder = tokens.tokenFor('builder')
    const reborn = new AgentTokens(dataDir)
    expect(reborn.agentIdOf(builder)).toBe('builder')
  })
})
