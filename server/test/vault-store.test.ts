// vault-store.test.ts — the Vault: validation (env-var hygiene, reserved
// names), owner-only file permissions, scope precedence for envFor, and
// masking. Values must never leave the server readable.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, statSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VaultStore, maskEntry, validateEntryName } from '../src/vault-store.js'

let store: VaultStore, path: string

beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), 'deck-vault-')), 'vault.json')
  store = new VaultStore(path)
  store.load()
})

describe('validateEntryName', () => {
  it('accepts UPPER_SNAKE and rejects everything else', () => {
    expect(validateEntryName('STRIPE_KEY')).toBeNull()
    expect(validateEntryName('stripe_key')).not.toBeNull()
    expect(validateEntryName('1BAD')).not.toBeNull()
    expect(validateEntryName('WITH-DASH')).not.toBeNull()
  })

  it('rejects the shell basics and the provider layer prefixes', () => {
    expect(validateEntryName('PATH')).not.toBeNull()
    expect(validateEntryName('HOME')).not.toBeNull()
    expect(validateEntryName('CLAUDE_CONFIG_DIR')).not.toBeNull()
    expect(validateEntryName('ANTHROPIC_API_KEY')).not.toBeNull()
  })

  it("rejects SILOS_* — Silos' own wiring, which an agent's shell filters by its own list", () => {
    expect(validateEntryName('SILOS_PROVIDER_KEY')).toBe('SILOS_* names belong to Silos itself')
    expect(validateEntryName('SILOS_MY_KEY')).not.toBeNull()
    expect(validateEntryName('SILOSX_KEY')).toBeNull()
  })
})

describe('create', () => {
  it('creates and persists with owner-only permissions (0600)', () => {
    store.create({ name: 'STRIPE_KEY', value: 'sk-123', scope: { type: 'global' } })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const again = new VaultStore(path)
    again.load()
    expect(again.list()).toHaveLength(1)
    expect(again.list()[0]!.value).toBe('sk-123')
  })

  it('rejects a duplicate name in the same scope, allows it in another', () => {
    store.create({ name: 'KEY_A', value: 'v', scope: { type: 'global' } })
    expect(() => store.create({ name: 'KEY_A', value: 'v2', scope: { type: 'global' } })).toThrow()
    expect(() => store.create({ name: 'KEY_A', value: 'v2', scope: { type: 'agent', agentId: 'finance' } })).not.toThrow()
  })

  it('rejects an empty value and an invalid scope', () => {
    expect(() => store.create({ name: 'KEY_B', value: '', scope: { type: 'global' } })).toThrow()
    expect(() => store.create({ name: 'KEY_B', value: 'v', scope: { type: 'folder', folder: 'relative' } })).toThrow()
    expect(() => store.create({ name: 'KEY_B', value: 'v', scope: { type: 'nope' } })).toThrow()
  })
})

describe('envFor — precedence agent > folder > global', () => {
  beforeEach(() => {
    store.create({ name: 'TOKEN', value: 'global', scope: { type: 'global' } })
    store.create({ name: 'TOKEN', value: 'folder', scope: { type: 'folder', folder: '/a/proj' } })
    store.create({ name: 'TOKEN', value: 'agent', scope: { type: 'agent', agentId: 'finance' } })
    store.create({ name: 'ONLY_FOLDER', value: 'f', scope: { type: 'folder', folder: '/a/proj' } })
  })

  it('the most specific scope wins the name', () => {
    expect(store.envFor('finance', '/a/proj')['TOKEN']).toBe('agent')
    expect(store.envFor('writer', '/a/proj')['TOKEN']).toBe('folder')
    expect(store.envFor('writer', '/elsewhere')['TOKEN']).toBe('global')
    expect(store.envFor(null, null)['TOKEN']).toBe('global')
  })

  it('a folder scope covers the folder and what is under it, respecting boundaries', () => {
    expect(store.envFor(null, '/a/proj/sub')['ONLY_FOLDER']).toBe('f')
    expect(store.envFor(null, '/a/projX')['ONLY_FOLDER']).toBeUndefined()
  })
})

describe('agents scope — one vault, manageable visibility', () => {
  it('normalizes the legacy single-agent form to a one-element list, in create and from disk', () => {
    store.create({ name: 'LEGACY', value: 'v', scope: { type: 'agent', agentId: 'finance' } })
    expect(store.list()[0]!.scope).toEqual({ type: 'agents', agentIds: ['finance'] })
    const again = new VaultStore(path)
    again.load()
    expect(again.list()[0]!.scope).toEqual({ type: 'agents', agentIds: ['finance'] })
  })

  it('an agents entry reaches every named agent and nobody else', () => {
    store.create({ name: 'SHARED', value: 'v', scope: { type: 'agents', agentIds: ['finance', 'builder'] } })
    expect(store.envFor('finance', null)['SHARED']).toBe('v')
    expect(store.envFor('builder', null)['SHARED']).toBe('v')
    expect(store.envFor('writer', null)['SHARED']).toBeUndefined()
  })

  it('canonicalizes the list (dedup + sort) and rejects an empty one', () => {
    const e = store.create({ name: 'CANON', value: 'v', scope: { type: 'agents', agentIds: ['builder', 'finance', 'builder'] } })
    expect(e.scope).toEqual({ type: 'agents', agentIds: ['builder', 'finance'] })
    expect(() => store.create({ name: 'EMPTY', value: 'v', scope: { type: 'agents', agentIds: [] } })).toThrow()
  })

  it('on a name collision within the tier, the shorter list wins; equal lengths → the newer entry', () => {
    store.create({ name: 'TOKEN_X', value: 'wide', scope: { type: 'agents', agentIds: ['finance', 'builder', 'writer'] } })
    store.create({ name: 'TOKEN_X', value: 'narrow', scope: { type: 'agents', agentIds: ['finance'] } })
    expect(store.envFor('finance', null)['TOKEN_X']).toBe('narrow')
    expect(store.envFor('builder', null)['TOKEN_X']).toBe('wide')
    const a = store.create({ name: 'TOKEN_Y', value: 'older', scope: { type: 'agents', agentIds: ['finance', 'builder'] } })
    store.create({ name: 'TOKEN_Y', value: 'newer', scope: { type: 'agents', agentIds: ['finance', 'writer'] } })
    // createdAt can land on the same millisecond — force the order the test names.
    ;(a as { createdAt: string }).createdAt = '2020-01-01T00:00:00.000Z'
    expect(store.envFor('finance', null)['TOKEN_Y']).toBe('newer')
  })
})

describe('setScope — visibility edited in place', () => {
  it('changes who sees the entry without touching the value', () => {
    const e = store.create({ name: 'MOVABLE', value: 'v', scope: { type: 'agents', agentIds: ['finance'] } })
    const updated = store.setScope(e.id, { type: 'agents', agentIds: ['builder', 'finance'] })
    expect(updated.value).toBe('v')
    expect(store.envFor('builder', null)['MOVABLE']).toBe('v')
    const again = new VaultStore(path)
    again.load()
    expect(again.list()[0]!.scope).toEqual({ type: 'agents', agentIds: ['builder', 'finance'] })
  })

  it('rejects an unknown id, an invalid scope, and a duplicate name+scope', () => {
    const e = store.create({ name: 'DUP', value: 'v', scope: { type: 'global' } })
    store.create({ name: 'DUP', value: 'v2', scope: { type: 'agents', agentIds: ['finance'] } })
    expect(() => store.setScope('nope', { type: 'global' })).toThrow('entry not found')
    expect(() => store.setScope(e.id, { type: 'agents', agentIds: [] })).toThrow('invalid scope')
    expect(() => store.setScope(e.id, { type: 'agents', agentIds: ['finance'] })).toThrow(/already exists/)
  })
})

describe('remove + masking', () => {
  it('remove deletes by id; maskEntry never exposes the value', () => {
    const e = store.create({ name: 'SECRET_ONE', value: 'sk-abcdef123456', scope: { type: 'global' } })
    expect(maskEntry(e).value).not.toContain('abcdef')
    expect(store.remove(e.id)).toBe(true)
    expect(store.remove(e.id)).toBe(false)
    expect(store.list()).toHaveLength(0)
  })
})

// A corrupt vault.json must never be silently replaced: the read backs the
// raw text up first (0600 — it holds secrets), THEN reads as empty.
describe('public — plain configuration the owner judged not secret', () => {
  it('absent = secret; marked public it shows in clear, is no secret value, and still rides only its scope', () => {
    const k = store.create({ name: 'BILLING_API_KEY', value: 'bk-live-0123456789', scope: { type: 'agents', agentIds: ['billing'] } })
    const p = store.create({ name: 'PROJECT_ID', value: 'acme-public', scope: { type: 'agents', agentIds: ['billing'] }, public: true })
    expect(k.public).toBeUndefined()
    expect(maskEntry(p).value).toBe('acme-public')
    expect(maskEntry(k).value).not.toContain('0123456789')
    expect(store.secretValues().map((x) => x.name)).toEqual(['BILLING_API_KEY'])
    expect(store.envFor('billing', null)).toEqual({ BILLING_API_KEY: 'bk-live-0123456789', PROJECT_ID: 'acme-public' })
    expect(store.envFor('ops', null)).toEqual({})
    expect(store.secretsFor('billing', null)).toEqual(['bk-live-0123456789'])
  })
  it('setPublic flips it in place and persists; the value never changes; only booleans', () => {
    const e = store.create({ name: 'PROJECT_ID', value: 'acme-public', scope: { type: 'global' } })
    store.setPublic(e.id, true)
    const again = new VaultStore(path)
    again.load()
    expect(again.list()[0]).toMatchObject({ public: true, value: 'acme-public' })
    store.setPublic(e.id, false)
    expect(store.list()[0]!.public).toBeUndefined()
    expect(() => store.setPublic(e.id, 'yes')).toThrow('public must be true or false')
    expect(() => store.setPublic('nope', true)).toThrow('entry not found')
  })
  it('secretsFor follows the winner per name: a public agent entry over a secret global one is not redacted', () => {
    store.create({ name: 'PROJECT_ID', value: 'global-secret-value', scope: { type: 'global' } })
    store.create({ name: 'PROJECT_ID', value: 'acme-public', scope: { type: 'agents', agentIds: ['billing'] }, public: true })
    expect(store.secretsFor('billing', null)).toEqual([])
    expect(store.secretsFor('ops', null)).toEqual(['global-secret-value'])
  })
})

// A name covered by two folder entries (nested) is
// resolved by the DEEPEST folder, then the newest — the same for the three
// consumers (env, the agent's view, the signer), never insertion order.
describe('folder tie-break — deepest, then newest, for every consumer', () => {
  const BIND = { baseUrl: 'https://svc.example', inject: { header: 'X-Key', format: '%s' } }
  it('the deeper folder wins whatever the insertion order', () => {
    const deep = store.create({ name: 'API_KEY', value: 'deep', scope: { type: 'folder', folder: '/w/proj/sub' } })
    store.create({ name: 'API_KEY', value: 'shallow', scope: { type: 'folder', folder: '/w/proj' } })
    expect(store.envFor('a1', '/w/proj/sub/x')['API_KEY']).toBe('deep')
    expect(store.envFor('a1', '/w/proj/other')['API_KEY']).toBe('shallow')
    expect(store.viewFor('a1', ['/w/proj/sub']).find((e) => e.name === 'API_KEY')?.id).toBe(deep.id)
    // across the agent's folders: the deepest covering entry, whichever folder it covers
    expect(store.viewFor('a1', ['/w/proj/sub', '/elsewhere']).find((e) => e.name === 'API_KEY')?.id).toBe(deep.id)
    store.setBinding(deep.id, BIND)
    const s = store.signerFor('a1', ['/w/proj/other', '/w/proj/sub'], 'API_KEY')
    expect('entry' in s && s.entry.id).toBe(deep.id)
  })

  it('at equal depth the newer entry wins', () => {
    const older = store.create({ name: 'API_KEY', value: 'older', scope: { type: 'folder', folder: '/w/a' } })
    const newer = store.create({ name: 'API_KEY', value: 'newer', scope: { type: 'folder', folder: '/w/b' } })
    ;(older as { createdAt: string }).createdAt = '2030-01-01T00:00:00.000Z'
    ;(newer as { createdAt: string }).createdAt = '2031-01-01T00:00:00.000Z'
    expect(store.viewFor('a1', ['/w/b', '/w/a']).find((e) => e.name === 'API_KEY')?.id).toBe(newer.id)
    ;(older as { createdAt: string }).createdAt = '2032-01-01T00:00:00.000Z'
    expect(store.viewFor('a1', ['/w/b', '/w/a']).find((e) => e.name === 'API_KEY')?.id).toBe(older.id)
  })
})

describe('binding — delivered ⇄ signed', () => {
  const BIND = { baseUrl: 'https://svc.example/v1/', inject: { header: 'Authorization', format: 'Bearer %s' } }
  const roster = (ok: string[], seeing: string[] = []) => ({ hasIdentity: (id: string) => ok.includes(id), agentsSeeing: () => seeing })

  it('normalizes the binding, persists it, and takes the entry out of env and secrets', () => {
    const e = store.create({ name: 'SVC_KEY', value: 'sk-1', scope: { type: 'agents', agentIds: ['a1'] }, binding: BIND })
    expect(e.binding).toEqual({ baseUrl: 'https://svc.example/v1', inject: { header: 'Authorization', format: 'Bearer %s' } })
    expect(store.envFor('a1', null)).toEqual({})
    expect(store.secretsFor('a1', null)).toEqual([])
    const again = new VaultStore(path)
    again.load()
    expect(again.list()[0]!.binding).toEqual(e.binding)
    expect(again.envFor('a1', null)).toEqual({})
    expect(again.credentialsFor('a1', [])).toEqual([{ name: 'SVC_KEY', signed: true }])
  })

  it('the winner is resolved first: a signed winner never uncovers an outer delivered entry, nor the reverse', () => {
    store.create({ name: 'SVC_KEY', value: 'global-v', scope: { type: 'global' } })
    const own = store.create({ name: 'SVC_KEY', value: 'own-v', scope: { type: 'agents', agentIds: ['a1'] }, binding: BIND })
    expect(store.envFor('a1', null)['SVC_KEY']).toBeUndefined()
    expect(store.envFor('a2', null)['SVC_KEY']).toBe('global-v')
    store.setBinding(own.id, null)
    store.setBinding(store.list()[0]!.id, BIND)
    expect(store.envFor('a1', null)['SVC_KEY']).toBe('own-v')
    expect(store.signerFor('a1', [], 'SVC_KEY')).toEqual({ refused: 'not-signed' })
    expect(store.signerFor('a2', [], 'SVC_KEY')).toMatchObject({ entry: { value: 'global-v' } })
    expect(store.signerFor('a2', [], 'NOPE')).toEqual({ refused: 'not-visible' })
  })

  it('refuses a header name outside the token charset, a transport header, and a format without one %s', () => {
    const e = store.create({ name: 'SVC_KEY', value: 'v', scope: { type: 'global' } })
    expect(() => store.setBinding(e.id, { baseUrl: 'https://s.example', inject: { header: 'X Key', format: '%s' } })).toThrow(/header name/)
    expect(() => store.setBinding(e.id, { baseUrl: 'https://s.example', inject: { header: 'X-Key\r\nEvil', format: '%s' } })).toThrow(/header name/)
    expect(() => store.setBinding(e.id, { baseUrl: 'https://s.example', inject: { header: 'Host', format: '%s' } })).toThrow(/transport/)
    expect(() => store.setBinding(e.id, { baseUrl: 'https://s.example', inject: { header: 'X-Key', format: 'none' } })).toThrow(/%s/)
    expect(() => store.setBinding(e.id, { baseUrl: 'https://s.example', inject: { header: 'X-Key', format: '%s%s' } })).toThrow(/%s/)
    expect(() => store.setBinding(e.id, { baseUrl: 'ftp://s.example', inject: { header: 'X-Key' } })).toThrow(/http/)
    expect(() => store.setBinding(e.id, { baseUrl: 'https://u:p@s.example', inject: { header: 'X-Key' } })).toThrow(/credentials/)
    expect(() => store.setBinding(e.id, { baseUrl: 'https://s.example/?k=1', inject: { header: 'X-Key' } })).toThrow(/query/)
    expect(store.list()[0]!.binding).toBeUndefined()
  })

  it('checks the RESULTING value: a CR/LF or control char in the secret (or the format) is refused at bind time', () => {
    const crlf = store.create({ name: 'BAD_KEY', value: 'abc\r\nX-Evil: 1', scope: { type: 'global' } })
    expect(() => store.setBinding(crlf.id, BIND)).toThrow(/line break or a control character/)
    const tab = store.create({ name: 'TAB_KEY', value: 'a\tb', scope: { type: 'global' } })
    expect(() => store.setBinding(tab.id, BIND)).toThrow(/control character/)
    const ok = store.create({ name: 'OK_KEY', value: 'fine', scope: { type: 'global' } })
    expect(() => store.setBinding(ok.id, { baseUrl: 'https://s.example', inject: { header: 'X-Key', format: '%s\n' } })).toThrow(/control character/)
    expect(() => store.create({ name: 'NEW_KEY', value: 'x\ny', scope: { type: 'global' }, binding: BIND })).toThrow(/line break/)
    expect(store.list().map((e) => e.name)).not.toContain('NEW_KEY')
  })

  it('a public entry is never signed, and a signed one is never made public', () => {
    const p = store.create({ name: 'PROJECT_ID', value: 'acme', scope: { type: 'global' }, public: true })
    expect(() => store.setBinding(p.id, BIND)).toThrow(/public/)
    const s = store.create({ name: 'SVC_KEY', value: 'v', scope: { type: 'global' }, binding: BIND })
    expect(() => store.setPublic(s.id, true)).toThrow(/signed/)
  })

  it('agents scope: refused while an agent named lacks identity — naming it; folder/global: warned, bound', () => {
    expect(() => store.create({ name: 'SVC_KEY', value: 'v', scope: { type: 'agents', agentIds: ['a1', 'ghost'] }, binding: BIND }, roster(['a1']))).toThrow(
      /identity — ghost has none/,
    )
    expect(store.list()).toHaveLength(0)
    const warnings: string[] = []
    const f = store.create({ name: 'SVC_KEY', value: 'v', scope: { type: 'folder', folder: '/w' }, binding: BIND }, roster(['a1'], ['a1', 'old']), warnings)
    expect(f.binding).toBeDefined()
    expect(warnings).toEqual([expect.stringContaining('old sees this entry but cannot sign')])
    // moving a signed entry into an agents scope keeps the rule
    expect(() => store.setScope(f.id, { type: 'agents', agentIds: ['old'] }, roster(['a1']))).toThrow(/old has none/)
    expect(store.list()[0]!.scope).toEqual({ type: 'folder', folder: '/w' })
  })

  it('writeOwn may bind its own; a rotation keeps the binding and re-checks the new value; null hands it back', () => {
    const { entry } = store.writeOwn('a1', { name: 'OWN_KEY', value: 'v1', binding: BIND })
    expect(entry.binding?.baseUrl).toBe('https://svc.example/v1')
    expect(store.envFor('a1', null)).toEqual({})
    store.writeOwn('a1', { name: 'OWN_KEY', value: 'v2' })
    expect(store.list()[0]!.binding).toBeDefined()
    expect(() => store.writeOwn('a1', { name: 'OWN_KEY', value: 'v3\r\nX: y' })).toThrow(/line break/)
    expect(store.list()[0]!.value).toBe('v2')
    store.writeOwn('a1', { name: 'OWN_KEY', value: 'v4', binding: null })
    expect(store.envFor('a1', null)).toEqual({ OWN_KEY: 'v4' })
  })
})

describe('corrupt vault.json', () => {
  it('backs up to .corrupt-* before reading as empty, with owner-only perms', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dir = mkdtempSync(join(tmpdir(), 'deck-vault-'))
    const file = join(dir, 'vault.json')
    writeFileSync(file, '{this is not json')
    const s = new VaultStore(file)
    s.load()
    expect(s.list()).toEqual([])
    const backups = readdirSync(dir).filter((f) => f.startsWith('vault.json.corrupt-'))
    expect(backups.length).toBe(1)
    expect(readFileSync(join(dir, backups[0]!), 'utf8')).toBe('{this is not json')
    expect(statSync(join(dir, backups[0]!)).mode & 0o777).toBe(0o600)
  })
})
