import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProvidersStore, maskKey, maskProvider, DEFAULT_PROVIDER_ID } from '../src/providers-store.js'

let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'deck-prov-'))
})
afterEach(() => vi.restoreAllMocks())

function newStore(): ProvidersStore {
  const s = new ProvidersStore(dataDir)
  s.load()
  return s
}

describe('ProvidersStore — CRUD and persistence', () => {
  it('create persists with an atomic write and the file ends up 0600', () => {
    const s = newStore()
    const p = s.create({ label: 'cheapestinference', baseUrl: 'https://api.cheapestinference.com/anthropic', apiKey: 'sk-live-abcdef123456' })
    expect(p.id).toBeTruthy()
    expect(p.kind).toBe('anthropic-compatible')
    const file = join(dataDir, 'providers.json')
    const mode = statSync(file).mode & 0o777
    expect(mode).toBe(0o600)
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { providers: unknown[] }
    expect(raw.providers).toHaveLength(1)
  })

  it('update does an immutable merge: the previous reference is not mutated', () => {
    const s = newStore()
    const p = s.create({ label: 'byok', baseUrl: 'https://x.test', apiKey: 'sk-key-11112222' })
    const before = s.get(p.id)!
    s.update(p.id, { label: 'byok2' })
    expect(before.label).toBe('byok')
    expect(s.get(p.id)?.label).toBe('byok2')
    expect(s.get(p.id)?.apiKey).toBe('sk-key-11112222') // the rest of the fields survive
  })

  it('delete removes it and throws if it does not exist', () => {
    const s = newStore()
    const p = s.create({ label: 'x', baseUrl: 'https://x.test', apiKey: 'sk-key-11112222' })
    s.delete(p.id)
    expect(s.list()).toHaveLength(0)
    expect(() => s.delete(p.id)).toThrow('provider not found')
  })

  it('load with corrupt JSON leaves a .corrupt backup and starts fresh', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(join(dataDir, 'providers.json'), '{this is not json')
    const s = newStore()
    expect(s.list()).toHaveLength(0)
    const backups = readdirSync(dataDir).filter((f) => f.includes('.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(dataDir, backups[0] as string), 'utf8')).toBe('{this is not json')
    expect(warn).toHaveBeenCalled()
  })

  it('load discards invalidly-shaped entries without dumping their content to the log — and leaves a .corrupt backup', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const original = JSON.stringify({
      providers: [
        { id: 'ok1', kind: 'anthropic-compatible', label: 'ok', baseUrl: 'https://x.test', apiKey: 'sk-secret-99998888', createdAt: '2026-01-01' },
        // a hand-edit typo: lowercase 'apikey' — the shape is invalid but the
        // JSON parses; this entry's key must NOT be able to get lost silently.
        { id: 'bad', kind: 'anthropic-compatible', label: 'typo', baseUrl: 'https://y.test', apikey: 'sk-treasure-11112222', createdAt: '2026-01-01' },
      ],
    })
    writeFileSync(join(dataDir, 'providers.json'), original)
    const s = newStore()
    expect(s.list().map((p) => p.id)).toEqual(['ok1'])
    // the warning carries only the id — never the key or the whole object
    for (const call of warn.mock.calls) {
      expect(String(call.join(' '))).not.toContain('sk-treasure')
    }
    // the discard also leaves a backup — the next save() rewrites the file
    // without the broken entry, but its key survives in the .corrupt file
    // for a hand-repair.
    const backups = readdirSync(dataDir).filter((f) => f.includes('.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(dataDir, backups[0] as string), 'utf8')).toBe(original)
    s.create({ label: 'other', baseUrl: 'https://z.test', apiKey: 'sk-new-33334444' })
    expect(readFileSync(join(dataDir, 'providers.json'), 'utf8')).not.toContain('sk-treasure')
    expect(readFileSync(join(dataDir, backups[0] as string), 'utf8')).toContain('sk-treasure-11112222')
  })

  // changing baseUrl without re-pasting the key invalidates it — the key
  // only ever travels to the endpoint it was pasted for.
  it('update with a new baseUrl and no apiKey invalidates the stored key; with a new apiKey it does not', () => {
    const s = newStore()
    const p = s.create({ label: 'x', baseUrl: 'https://a.test', apiKey: 'sk-key-111122223333' })
    const withoutKey = s.update(p.id, { baseUrl: 'https://b.test' })
    expect(withoutKey.apiKey).toBe('')
    expect(maskProvider(withoutKey).apiKey).toBe('') // the UI distinguishes "no key"
    // re-pasting the key restores it; and changing baseUrl WITH a new key keeps it
    const withKey = s.update(p.id, { baseUrl: 'https://c.test', apiKey: 'sk-key-999900001111' })
    expect(withKey.apiKey).toBe('sk-key-999900001111')
    // the same baseUrl (no change) does not touch the key
    const unchanged = s.update(p.id, { baseUrl: 'https://c.test' })
    expect(unchanged.apiKey).toBe('sk-key-999900001111')
    // and an entry with apiKey '' survives load() (a legal state, not discarded)
    s.update(p.id, { baseUrl: 'https://d.test' })
    const reloaded = newStore()
    expect(reloaded.get(p.id)?.apiKey).toBe('')
  })
})

describe('masking', () => {
  it('maskKey leaves sk-…last4 and never the full key; keys of <=12 chars not even that', () => {
    expect(maskKey('sk-live-abcdef123456')).toBe('sk-…3456')
    expect(maskKey('tok_abcdefgh9999')).toBe('…9999')
    expect(maskKey('short')).toBe('…')
    // with 9-12 chars the last 4 would be a substantial fraction of the
    // secret — threshold raised to <=12.
    expect(maskKey('sk-123456789')).toBe('…') // 12 chars
    expect(maskKey('sk-1234567890')).toBe('sk-…7890') // 13 chars
  })

  it('listMasked/maskProvider never expose the full key', () => {
    const s = newStore()
    s.create({ label: 'x', baseUrl: 'https://x.test', apiKey: 'sk-live-abcdef123456' })
    const masked = s.listMasked()[0]!
    expect(masked.apiKey).toBe('sk-…3456')
    expect(JSON.stringify(masked)).not.toContain('sk-live-abcdef123456')
    // maskProvider does not mutate the original
    const p = s.list()[0]!
    const m = maskProvider(p)
    expect(m.apiKey).toBe('sk-…3456')
    expect(p.apiKey).toBe('sk-live-abcdef123456')
  })
})

describe('id resolution', () => {
  it("resolve('default'), undefined and '' all fall back to the machine's account", () => {
    const s = newStore()
    for (const id of [undefined, 'default', '']) {
      const r = s.resolve(id as string | undefined)
      expect(r).toMatchObject({ id: DEFAULT_PROVIDER_ID, kind: 'claude-account', configDir: null })
    }
  })

  it('resolve account:<name> returns the config dir if the directory exists', () => {
    mkdirSync(join(dataDir, 'claude-accounts', 'work'), { recursive: true })
    const s = newStore()
    const r = s.resolve('account:work')
    expect(r).toMatchObject({ kind: 'claude-account', configDir: join(dataDir, 'claude-accounts', 'work') })
    expect(s.resolve('account:missing')).toBeNull()
  })

  // an 'account:../..' hand-edited into agents.json must not resolve an
  // arbitrary directory as CLAUDE_CONFIG_DIR.
  it('resolve account:<name> validates the name before the join — no traversal', () => {
    // a REAL sibling directory outside claude-accounts/: this is where the traversal would point
    mkdirSync(join(dataDir, 'outside'), { recursive: true })
    const s = newStore()
    expect(s.resolve('account:../outside')).toBeNull()
    expect(s.resolve('account:..')).toBeNull()
    expect(s.resolve('account:With Uppercase')).toBeNull()
  })

  it('knownIds includes default, accounts and persisted providers', () => {
    mkdirSync(join(dataDir, 'claude-accounts', 'alt'), { recursive: true })
    const s = newStore()
    const p = s.create({ label: 'x', baseUrl: 'https://x.test', apiKey: 'sk-key-11112222' })
    expect(s.knownIds()).toEqual(['default', 'account:alt', p.id])
  })

  it('resolveForAgent tolerates an unknown id: default + a single warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = newStore()
    const r1 = s.resolveForAgent('finance', 'deleted-a-while-ago')
    const r2 = s.resolveForAgent('finance', 'deleted-a-while-ago')
    expect(r1.id).toBe(DEFAULT_PROVIDER_ID)
    expect(r2.id).toBe(DEFAULT_PROVIDER_ID)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

// OpenCode provider kinds: a key for a provider OpenCode
// already catalogues, and a passthrough to OpenCode's own login.
describe('ProvidersStore — OpenCode kinds', () => {
  it('harness-provider persists harness/providerId/key and resolves with its key', () => {
    const s = newStore()
    const p = s.create({
      kind: 'harness-provider',
      label: 'MiniMax plan',
      harness: 'opencode',
      providerId: 'minimax-coding-plan',
      apiKey: 'mm-secret-key-123456',
    })
    expect(p).toMatchObject({ kind: 'harness-provider', harness: 'opencode', providerId: 'minimax-coding-plan', apiKey: 'mm-secret-key-123456' })
    expect('baseUrl' in p).toBe(false)
    const raw = JSON.parse(readFileSync(join(dataDir, 'providers.json'), 'utf8')) as { providers: Array<Record<string, unknown>> }
    expect(raw.providers[0]).toMatchObject({ kind: 'harness-provider', harness: 'opencode', providerId: 'minimax-coding-plan' })
    // survives a reload (the shape check knows the kind)
    const again = newStore()
    expect(again.resolve(p.id)).toEqual({
      id: p.id,
      kind: 'harness-provider',
      label: 'MiniMax plan',
      harness: 'opencode',
      providerId: 'minimax-coding-plan',
      apiKey: 'mm-secret-key-123456',
    })
    expect(again.knownIds()).toContain(p.id)
  })

  it('harness-native persists without any key and resolves as a passthrough', () => {
    const s = newStore()
    const p = s.create({ kind: 'harness-native', label: 'Z.ai (OpenCode login)', harness: 'opencode', providerId: 'zai' })
    expect('apiKey' in p).toBe(false)
    expect(newStore().resolve(p.id)).toEqual({ id: p.id, kind: 'harness-native', label: 'Z.ai (OpenCode login)', harness: 'opencode', providerId: 'zai' })
    expect(maskProvider(p)).toEqual(p)
  })

  it('create validates per kind', () => {
    const s = newStore()
    expect(() => s.create({ kind: 'harness-provider', label: 'x', harness: 'opencode', apiKey: 'k-1234567890' })).toThrow(/providerId/)
    expect(() => s.create({ kind: 'harness-provider', label: 'x', harness: 'opencode', providerId: 'Bad/Id', apiKey: 'k-1234567890' })).toThrow(/providerId/)
    expect(() => s.create({ kind: 'harness-provider', label: 'x', harness: 'opencode', providerId: '-lead', apiKey: 'k-1234567890' })).toThrow(/providerId/)
    expect(() => s.create({ kind: 'harness-provider', label: 'x', harness: 'opencode', providerId: 'zai' })).toThrow(/apiKey/)
    expect(() => s.create({ kind: 'harness-native', label: 'x', harness: 'opencode', providerId: 'zai', apiKey: 'k-1234567890' })).toThrow(/apiKey/)
    expect(() => s.create({ kind: 'harness-native', label: 'x', harness: 'opencode', providerId: 'zai', baseUrl: 'https://x' })).toThrow(/baseUrl/)
    expect(() =>
      s.create({ kind: 'harness-provider', label: 'x', harness: 'opencode', providerId: 'zai', apiKey: 'k-1234567890', baseUrl: 'https://x' }),
    ).toThrow(/baseUrl/)
    expect(() => s.create({ kind: 'harness-native', label: 'x', providerId: 'zai' })).toThrow(/harness/)
    expect(() => s.create({ kind: 'anthropic-compatible', label: 'x', baseUrl: 'https://x', apiKey: 'k-1234567890', providerId: 'zai' })).toThrow(/providerId/)
    expect(() => s.create({ kind: 'anthropic-compatible', label: 'x', apiKey: 'k-1234567890' })).toThrow(/baseUrl/)
    expect(s.list()).toEqual([]) // nothing half-written
  })

  it('masking hides a harness-provider key as it does an anthropic-compatible one', () => {
    const s = newStore()
    s.create({ kind: 'harness-provider', label: 'Kimi', harness: 'opencode', providerId: 'kimi-for-coding', apiKey: 'sk-kimi-abcdef123456' })
    const [m] = s.listMasked()
    expect(m).toMatchObject({ apiKey: 'sk-…3456', providerId: 'kimi-for-coding' })
    expect(JSON.stringify(s.listMasked())).not.toContain('abcdef')
  })

  it('update validates per kind; a providerId change without a key invalidates the key', () => {
    const s = newStore()
    const hp = s.create({ kind: 'harness-provider', label: 'MiniMax', harness: 'opencode', providerId: 'minimax-coding-plan', apiKey: 'mm-secret-key-123456' })
    const hn = s.create({ kind: 'harness-native', label: 'Z.ai', harness: 'opencode', providerId: 'zai' })
    const ac = s.create({ label: 'ci', baseUrl: 'https://x.test', apiKey: 'sk-key-11112222' })
    expect(() => s.update(hp.id, { baseUrl: 'https://evil.test' })).toThrow(/baseUrl/)
    expect(() => s.update(hn.id, { apiKey: 'k-1234567890' })).toThrow(/apiKey/)
    expect(() => s.update(ac.id, { providerId: 'zai' })).toThrow(/providerId/)
    expect(() => s.update(hn.id, { providerId: 'Bad Id' })).toThrow(/providerId/)
    // the key only ever goes to the provider it was pasted for
    expect(s.update(hp.id, { providerId: 'zai' }).apiKey).toBe('')
    expect(s.update(hp.id, { providerId: 'kimi-for-coding', apiKey: 'new-key-1234567890' }).apiKey).toBe('new-key-1234567890')
    expect(s.update(hn.id, { providerId: 'kimi-for-coding' })).toMatchObject({ kind: 'harness-native', providerId: 'kimi-for-coding' })
  })

  it('load discards a harness entry with a broken shape (and backs the file up)', () => {
    writeFileSync(
      join(dataDir, 'providers.json'),
      JSON.stringify({
        providers: [
          { id: 'a', kind: 'harness-provider', label: 'x', harness: 'opencode', providerId: 'zai', apiKey: 'k', createdAt: 'now' },
          { id: 'b', kind: 'harness-native', label: 'x', harness: 'opencode', createdAt: 'now' },
          { id: 'c', kind: 'harness-native', label: 'x', harness: 'opencode', providerId: 'zai', apiKey: 'k', createdAt: 'now' },
        ],
      }),
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = newStore()
    expect(s.list().map((p) => p.id)).toEqual(['a'])
  })
})
