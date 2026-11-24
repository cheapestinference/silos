// pin-follower.test.ts — a model picked inside the OpenCode TUI becomes the
// conversation's pin: the OpenCode id maps back to a Silos provider (a key,
// an imported login, or the engine's own), a pick newer than the pin's last
// write is followed, an older one never reverts a fresh pin.
import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProvidersStore } from '../src/providers-store.js'
import { ConversationPrefsStore } from '../src/conversation-prefs.js'
import { TuiPinFollower } from '../src/pin-follower.js'
import { opencodeRefToPin } from '../src/harnesses/opencode/pin.js'
import type { SessionMeta } from '../src/types.js'

let providers: ProvidersStore
let ci: string
let zz: string
let now = 1_000_000
let prefs: ConversationPrefsStore

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'pinf-'))
  providers = new ProvidersStore(dir)
  ci = providers.create({
    label: 'cheapestinference · mimo-v2.6-flash, deepseek-v4.1-flash',
    baseUrl: 'https://api.cheapestinference.com/anthropic',
    apiKey: 'sk-1',
    models: ['mimo-v2.6-flash', 'deepseek-v4.1-flash'],
  }).id
  zz = providers.create({ kind: 'harness-provider', label: 'Z.ai plan', harness: 'opencode', providerId: 'zai', apiKey: 'zk' }).id
  now = 1_000_000
  prefs = new ConversationPrefsStore(dir, () => now)
})

const meta = (over: Partial<SessionMeta>): SessionMeta =>
  ({ id: 'ses_1', folder: '-home-u-p', title: 'S', skills: [], cwd: '/home/u/p', mtime: 0, size: 0, turnCount: 1, harness: 'opencode', ...over }) as SessionMeta

describe('opencodeRefToPin', () => {
  it("a Silos gateway id → that key, model bare; an imported login id → that row; anything else → the engine's own login with the full id", () => {
    expect(opencodeRefToPin(`silos-${ci}/deepseek-v4.1-flash`, providers)).toEqual({ provider: ci, model: 'deepseek-v4.1-flash' })
    expect(opencodeRefToPin('zai/glm-5.1', providers)).toEqual({ provider: zz, model: 'glm-5.1' })
    expect(opencodeRefToPin('minimax-coding-plan/MiniMax-M3', providers)).toEqual({ provider: null, model: 'minimax-coding-plan/MiniMax-M3' })
    expect(opencodeRefToPin('silos-gone/x', providers)).toBeNull()
    expect(opencodeRefToPin('bare', providers)).toBeNull()
  })
})

describe('TuiPinFollower.onSession', () => {
  it('a pinned conversation follows the TUI only when its model CHANGES between prompts — the first sighting and a repeat are inertia (a relaunch that did not land must not revert the panel)', () => {
    const log: string[] = []
    const f = new TuiPinFollower({ providers, convPrefs: prefs, log: (l) => log.push(l) })
    prefs.patch('-home-u-p', 'ses_1', { provider: ci, model: 'mimo-v2.6-flash' })
    now += 10_000
    // the TUI still on zai after the pick: inertia, twice — nothing written
    expect(f.onSession(meta({ requestedModel: 'zai/glm-5.1', requestedModelAt: now }))).toBeNull()
    expect(f.onSession(meta({ requestedModel: 'zai/glm-5.1', requestedModelAt: now + 1 }))).toBeNull()
    expect(prefs.get('-home-u-p', 'ses_1')).toEqual({ provider: ci, model: 'mimo-v2.6-flash' })
    // the owner picks kimi in the TUI: a change → the pin follows, once
    now += 10_000
    const m = meta({ requestedModel: 'kimi-for-coding/k2p6', requestedModelAt: now })
    expect(f.onSession(m)).toEqual({ provider: null, model: 'kimi-for-coding/k2p6' })
    expect(prefs.get('-home-u-p', 'ses_1')).toEqual({ model: 'kimi-for-coding/k2p6' })
    expect(f.onSession(m)).toBeNull()
    expect(log).toHaveLength(1)
  })

  it('a conversation with no pin at all follows the TUI at first sight (the pin then says what it runs on)', () => {
    const f = new TuiPinFollower({ providers, convPrefs: prefs })
    expect(f.onSession(meta({ requestedModel: 'zai/glm-5.1', requestedModelAt: now }))).toEqual({ provider: zz, model: 'glm-5.1' })
    expect(prefs.get('-home-u-p', 'ses_1')).toEqual({ provider: zz, model: 'glm-5.1' })
  })

  it("never reverts a pin written AFTER the prompt (the panel's pick is the newer decision); a Claude session or a session without a pick is ignored", () => {
    const f = new TuiPinFollower({ providers, convPrefs: prefs })
    const at = now
    now += 5_000
    prefs.patch('-home-u-p', 'ses_1', { provider: ci, model: 'mimo-v2.6-flash' })
    expect(f.onSession(meta({ requestedModel: 'zai/glm-5.1', requestedModelAt: at }))).toBeNull()
    expect(prefs.get('-home-u-p', 'ses_1')).toEqual({ provider: ci, model: 'mimo-v2.6-flash' })
    expect(f.onSession(meta({ harness: 'claude-code', requestedModel: 'zai/glm-5.1', requestedModelAt: now + 1 }))).toBeNull()
    expect(f.onSession(meta({}))).toBeNull()
  })

  it("the engine's own login clears the provider pin and keeps the full provider/model id; a matching pin (default alias) is a no-op", () => {
    const f = new TuiPinFollower({ providers, convPrefs: prefs })
    expect(f.onSession(meta({ requestedModel: 'minimax-coding-plan/MiniMax-M3', requestedModelAt: now + 1 }))).toEqual({
      provider: null,
      model: 'minimax-coding-plan/MiniMax-M3',
    })
    expect(prefs.get('-home-u-p', 'ses_1')).toEqual({ model: 'minimax-coding-plan/MiniMax-M3' })
    now += 10_000
    expect(f.onSession(meta({ requestedModel: 'minimax-coding-plan/MiniMax-M3', requestedModelAt: now }))).toBeNull()
  })
})
