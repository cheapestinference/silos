import { describe, it, expect } from 'vitest'
import { modeArgs } from '../src/harnesses/opencode/auto-mode.js'
import { opencodeCompat, OPENCODE_MINIMUM } from '../src/harnesses/opencode/version.js'

// The minimum OpenCode lists --auto on its TUI and on `run`, and an older one
// is refused by the compatibility gate before any console or turn starts —
// so the mode's argv is pure: no capability probe, no per-binary fallback.
describe("modeArgs — the cockpit permission mode in OpenCode's dialect", () => {
  it('bypass → --auto', () => {
    expect(modeArgs('bypassPermissions')).toEqual(['--auto'])
  })
  it("plan → OpenCode's built-in plan agent; never --auto", () => {
    expect(modeArgs('plan')).toEqual(['--agent', 'plan'])
  })
  it('acceptEdits → no flag (OpenCode already allows edits by default; its own rules stand)', () => {
    expect(modeArgs('acceptEdits')).toEqual([])
  })
  it('no mode, or an unknown one: OpenCode asks as it would by itself', () => {
    expect(modeArgs(undefined)).toEqual([])
    expect(modeArgs('default')).toEqual([])
  })
})

describe('opencodeCompat — the minimum Silos runs', () => {
  it('declares 1.19.4 (the release every OpenCode fact Silos uses was verified on)', () => {
    expect(OPENCODE_MINIMUM).toBe('1.19.4')
  })
  it('ok at or above it; nothing refused', () => {
    for (const v of ['1.19.4', '1.19.10', '1.20.0', '2.0.0']) expect(opencodeCompat(v)).toMatchObject({ state: 'ok', refuses: [], message: null, update: null })
  })
  it('older → outdated: consoles and turns refused, one line with `opencode upgrade`', () => {
    const c = opencodeCompat('1.14.22')
    expect(c).toMatchObject({
      harness: 'opencode',
      state: 'outdated',
      installed: '1.14.22',
      needed: '1.19.4',
      update: 'opencode upgrade',
      refuses: ['console', 'chat'],
    })
    expect(c.message).toBe('OpenCode 1.14.22 is older than Silos needs (1.19.4) — update it: opencode upgrade')
  })
  it('no version → missing, with the installer', () => {
    const c = opencodeCompat(null)
    expect(c).toMatchObject({ state: 'missing', installed: null, refuses: ['console', 'chat'] })
    expect(c.message).toContain('Silos needs OpenCode 1.19.4 or newer')
    expect(c.message).not.toContain('\n')
  })
})
