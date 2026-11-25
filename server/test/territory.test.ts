import { describe, it, expect, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FENCE_REFUSAL_RE, SILOS_CHECKOUT, appliedPrivatePaths, fenceFor, fenceScope, makeTerritory, territoriesOf } from '../src/territory.js'
import { claudeCode } from '../src/harnesses/claude-code/index.js'
import { opencode } from '../src/harnesses/opencode/index.js'
import type { Agent } from '../src/types.js'
import { DEFAULT_PRIVATE, TerritoryStore } from '../src/territory-store.js'

describe('territory fence constants', () => {
  it('FENCE_REFUSAL_RE matches the refusal text observed in the smoke', () => {
    expect(FENCE_REFUSAL_RE.test('<tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>')).toBe(true)
    expect(FENCE_REFUSAL_RE.test('Permission to use Bash with command cat /tmp/tmp.HbuPtN7XxM/secret.txt has been denied.')).toBe(true)
    // through a symlink from inside its own folder (territory-smoke-files.mts, 2.1.331)
    expect(FENCE_REFUSAL_RE.test('Permission to read /home/user/acme/link/secret.txt has been denied.')).toBe(true)
    expect(
      FENCE_REFUSAL_RE.test('<tool_use_error>File is covered by a Read deny rule in your permission settings and cannot be written.</tool_use_error>'),
    ).toBe(true)
    expect(FENCE_REFUSAL_RE.test('File content: hello')).toBe(false)
  })
})

const home = '/home/u',
  dataDir = '/home/u/.silos'
const builder = { id: 'builder', folder: '/home/u/ci', folders: ['/home/u/builder'], skills: [], name: 'Builder', emoji: '', role: '' }
const finance = { id: 'finance', folder: '/home/u/ci', folders: ['/home/u/secrets/finance'], skills: [], name: 'Finance', emoji: '', role: '' }
const silos = { id: 'silos', folder: '/home/u/silos', skills: [], name: 'Silos', emoji: '', role: '' }
const base = { agents: [builder, finance, silos], privatePaths: ['~/secrets', '~/.ssh'], home, dataDir }

describe('fenceFor', () => {
  it('master and archived get no fence', () => {
    expect(fenceFor({ ...base, agent: { ...builder, id: 'master', folder: null }, agentStateDir: '' })).toBeNull()
    expect(fenceFor({ ...base, agent: { ...builder, archived: true }, agentStateDir: '/x' })).toBeNull()
  })
  it('own state dir is never denied, and is an additional directory', () => {
    const f = fenceFor({ ...base, agent: builder, agentStateDir: '/home/u/.silos/agent-state/builder' })!
    expect(f.permissions.additionalDirectories).toEqual(['/home/u/builder', '/home/u/.silos/agent-state/builder'])
    // only its plugin, whole: the rest of its state stays open
    expect(f.permissions.deny.filter((d) => d.includes('agent-state/builder'))).toEqual(['Edit(//home/u/.silos/agent-state/builder/plugin/**)'])
    expect(f.permissions.deny).toContain('Read(//home/u/.silos/agent-state/finance/**)')
    expect(f.permissions.deny).toContain('Edit(//home/u/.silos/agent-state/silos/**)')
  })
  it('silos state and claude sensitive entries are denied for everyone', () => {
    const d = fenceFor({ ...base, agent: silos, agentStateDir: '/home/u/.silos/agent-state/silos' })!.permissions.deny
    for (const p of [
      'Read(//home/u/.silos/agents/**)',
      'Edit(//home/u/.silos/agents/**)',
      'Read(//home/u/.silos/*.json)',
      'Edit(//home/u/.silos/*.json)',
      'Read(//home/u/.silos/token)',
      'Edit(//home/u/.silos/token)',
      'Read(//home/u/.silos/claude-accounts/*/.credentials.json)',
      'Edit(//home/u/.silos/claude-accounts/*/settings*.json)',
      'Read(//home/u/.silos/claude-accounts/*/.claude.json)',
      'Read(//home/u/.silos/claude-accounts/*/history.jsonl)',
      'Read(//home/u/.silos/claude-accounts/*/backups/**)',
      'Read(//home/u/.claude/backups/**)',
      'Read(//home/u/.silos/claude-settings-backups/**)',
      'Read(//home/u/.silos/backups/**)',
      'Read(//home/u/.silos/console-append/**)',
      'Read(//home/u/.silos/accounts/**)',
      'Read(//home/u/.silos/trash/**)',
      'Read(//home/u/.silos/console-env/**)',
      'Read(//home/u/.claude/.credentials.json)',
      'Read(//home/u/.claude/settings*.json)',
      'Edit(//home/u/.claude/settings*.json)',
      'Read(//home/u/.claude/history.jsonl)',
      'Read(//home/u/.claude.json)',
      'Edit(//home/u/.claude.json)',
    ])
      expect(d).toContain(p)
  })
  // a turn that falls back to an extra account keeps
  // its auto memory (<config dir>/projects/<project>/memory) — the account
  // is fenced file by file, like ~/.claude, never as a whole
  it("an extra account's login, settings, history and state are denied; its auto memory is not", () => {
    const d = fenceFor({ ...base, agent: silos, agentStateDir: '/home/u/.silos/agent-state/silos' })!.permissions.deny
    expect(d.some((x) => x.includes('claude-accounts/**'))).toBe(false)
    for (const f of ['.credentials.json', '.claude.json', 'settings.json', 'settings.local.json', 'backups/.claude.json.backup.1']) {
      expect(covered(d, 'Read', `/home/u/.silos/claude-accounts/kai/${f}`), f).toBe(true)
      expect(covered(d, 'Edit', `/home/u/.silos/claude-accounts/kai/${f}`), f).toBe(true)
    }
    expect(covered(d, 'Read', '/home/u/.silos/claude-accounts/kai/history.jsonl')).toBe(true)
    const memory = '/home/u/.silos/claude-accounts/kai/projects/-home-u-silos/memory/MEMORY.md'
    expect(covered(d, 'Read', memory)).toBe(false)
    expect(covered(d, 'Edit', memory)).toBe(false)
  })
  it("other roles' context/ in a shared project is Edit-denied, own is not", () => {
    const d = fenceFor({ ...base, agent: builder, agentStateDir: '/s/builder' })!.permissions.deny
    expect(d).toContain('Edit(//home/u/ci/context/finance/**)')
    expect(d).not.toContain('Edit(//home/u/ci/context/builder/**)')
    expect(d.some((x) => x.startsWith('Read(//home/u/ci/context/'))).toBe(false)
  })
  it('private paths are denied unless inside or containing a territory', () => {
    const builderD = fenceFor({ ...base, agent: builder, agentStateDir: '/s/builder' })!.permissions.deny
    expect(builderD).toContain('Read(//home/u/secrets/**)')
    expect(builderD).toContain('Read(//home/u/.ssh/**)')
    const financeD = fenceFor({ ...base, agent: finance, agentStateDir: '/s/finance' })!.permissions.deny
    expect(financeD.some((x) => x === 'Read(//home/u/secrets/**)' || x === 'Read(//home/u/secrets)')).toBe(false)
  })
  it('territoriesOf dedupes and keeps order', () => {
    expect(territoriesOf({ ...builder, folders: ['/home/u/builder', '/home/u/ci'] })).toEqual(['/home/u/ci', '/home/u/builder'])
  })
  it('engine login secrets (Harness.secretFiles) are denied for every agent; a non-absolute entry is ignored', () => {
    const d = fenceFor({
      ...base,
      agent: builder,
      agentStateDir: '/s/builder',
      engineSecretFiles: ['/home/u/.local/share/opencode/auth.json', 'relative/auth.json'],
    })!.permissions.deny
    expect(d).toContain('Read(//home/u/.local/share/opencode/auth.json)')
    expect(d).toContain('Edit(//home/u/.local/share/opencode/auth.json)')
    expect(d.some((x) => x.includes('relative'))).toBe(false)
  })
})

describe('territory normalisation', () => {
  it('territoriesOf strips trailing slashes (not / itself) and dedupes after stripping', () => {
    expect(territoriesOf({ ...builder, folder: '/home/u/ci/', folders: ['/home/u/ci', '/home/u/builder//', '/'] })).toEqual([
      '/home/u/ci',
      '/home/u/builder',
      '/',
    ])
  })
  it('/home/u/ci is not a prefix of /home/u/ci2', () => {
    const ci2 = { ...silos, id: 'ci2', folder: '/home/u/ci2' }
    const d = fenceFor({ ...base, agents: [builder, ci2], privatePaths: ['/home/u/ci2'], agent: builder, agentStateDir: '/s/builder' })!.permissions.deny
    expect(d).toContain('Read(//home/u/ci2/**)')
    expect(d.some((x) => x.includes('/home/u/ci2/context/builder'))).toBe(false)
  })
  it('a private path that contains a territory is not denied for that agent', () => {
    const d = fenceFor({ ...base, privatePaths: ['/home/u'], agent: builder, agentStateDir: '/s/builder' })!.permissions.deny
    expect(d).not.toContain('Read(//home/u/**)')
  })
  it('a trailing slash on a territory still exempts the private path inside it', () => {
    const d = fenceFor({ ...base, privatePaths: ['/home/u/builder/keys'], agent: { ...builder, folders: ['/home/u/builder/'] }, agentStateDir: '/s/builder' })!
      .permissions.deny
    expect(d.some((x) => x.includes('/home/u/builder/keys'))).toBe(false)
  })
})

describe('TerritoryStore', () => {
  const mk = () => mkdtempSync(join(tmpdir(), 'terr-'))
  it('enableAtBirth appends the new agent to the fenced ones (once) and persists', () => {
    const d = mk()
    const s = new TerritoryStore(d)
    s.load()
    s.setEnabled(['builder'])
    expect(s.enableAtBirth({ id: 'neo', name: 'Neo' })).toBeUndefined()
    expect(s.enableAtBirth({ id: 'neo', name: 'Neo' })).toBeUndefined()
    expect(s.enabled()).toEqual(['builder', 'neo'])
    const again = new TerritoryStore(d)
    again.load()
    expect(again.enabled()).toEqual(['builder', 'neo'])
  })
  it('a write that fails: enableAtBirth says so, and memory never claims a fence the disk lacks', () => {
    const d = mk()
    writeFileSync(join(d, 'not-a-dir'), '')
    const s = new TerritoryStore(join(d, 'not-a-dir'))
    s.load()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(s.enableAtBirth({ id: 'neo', name: 'Neo' })).toMatch(/^Neo's territory is off — .*It stays Only when told, .*its Settings ›$/)
    } finally {
      warn.mockRestore()
    }
    expect(s.isEnabled('neo')).toBe(false)
  })
  it('defaults when the file is missing', () => {
    const s = new TerritoryStore(mk())
    s.load()
    expect(s.privatePaths()).toEqual(DEFAULT_PRIVATE)
  })
  it('round-trips with mode 0600', () => {
    const d = mk()
    const s = new TerritoryStore(d)
    s.load()
    s.setPrivatePaths(['/a/b', '~/x'])
    const s2 = new TerritoryStore(d)
    s2.load()
    expect(s2.privatePaths()).toEqual(['/a/b', '~/x'])
    expect(statSync(join(d, 'territory.json')).mode & 0o777).toBe(0o600)
  })
  it('rejects a relative path', () => {
    const s = new TerritoryStore(mk())
    s.load()
    expect(() => s.setPrivatePaths(['rel/path'])).toThrow()
  })
  it('falls back to defaults (and warns) when every entry is invalid', () => {
    const d = mk()
    writeFileSync(join(d, 'territory.json'), JSON.stringify({ privatePaths: ['rel', 3] }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = new TerritoryStore(d)
    s.load()
    s.load()
    expect(s.privatePaths()).toEqual(DEFAULT_PRIVATE)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
  it('an explicit empty list is honoured (owner opted out)', () => {
    const d = mk()
    writeFileSync(join(d, 'territory.json'), JSON.stringify({ privatePaths: [] }))
    const s = new TerritoryStore(d)
    s.load()
    expect(s.privatePaths()).toEqual([])
  })
  it('falls back to defaults on a corrupt file', () => {
    const d = mk()
    writeFileSync(join(d, 'territory.json'), '{nope')
    const s = new TerritoryStore(d)
    s.load()
    expect(s.privatePaths()).toEqual(DEFAULT_PRIVATE)
  })
})

// Claude Code matches Read/Edit deny rules gitignore-style: a rule matches a
// path when it matches the path itself OR any of its ancestor directories
// (that is why a bare `<dataDir>/*` would swallow agent-state/<own>).
function ruleRe(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*'
      i++
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}
function covered(deny: string[], tool: 'Read' | 'Edit', path: string): boolean {
  const res = deny.filter((r) => r.startsWith(`${tool}(//`)).map((r) => ruleRe(`/${r.slice(tool.length + 3, -1)}`))
  const segs = path.split('/')
  for (let i = 2; i <= segs.length; i++) {
    const prefix = segs.slice(0, i).join('/')
    if (res.some((re) => re.test(prefix))) return true
  }
  return false
}
function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

// The owner's answers to an agent's permission asks
// live in <dataDir>/asks-replies/<agent>/… — denied to every agent, the
// asking one included, even before the directory exists.
describe('the asks-replies dir is fenced, also on an empty data dir', () => {
  it("Read and Edit denied for the agent's OWN reply dir", () => {
    const home = mkdtempSync(join(tmpdir(), 'terr-empty-'))
    const dataDir = join(home, '.silos') // never created
    const reg = [{ id: 'silos', name: 'Silos', emoji: '', role: '', folder: join(home, 'silos'), skills: [] }] as Agent[]
    const territory = makeTerritory({
      registry: { get: (id: string) => reg.find((a) => a.id === id) ?? null, list: () => reg },
      agentState: { pathFor: (id: string) => join(dataDir, 'agent-state', id) },
      store: { privatePaths: () => [], isEnabled: (id: string) => id === 'silos' },
      home,
      dataDir,
    })
    const deny = territory.fenceFor('silos')!.permissions.deny
    const reply = join(dataDir, 'asks-replies', 'silos', 'ses_1', 'perm_1.reply.json')
    expect(covered(deny, 'Read', reply)).toBe(true)
    expect(covered(deny, 'Edit', reply)).toBe(true)
  })
})

describe('the data dir fence over a real directory', () => {
  const home = mkdtempSync(join(tmpdir(), 'terr-home-'))
  const dataDir = join(home, '.silos')
  const files = [
    'token',
    'agents.json',
    'vault.json',
    'sessions.json',
    'server.env',
    'territory.json',
    'agents.json.bak-orphan',
    'ui.json.bak-rename-123',
    'dev-server.log',
    'some-future-file',
    'agents/builder/token',
    'agents/finance/memory.md',
    'claude-accounts/alt/.credentials.json',
    'accounts/x.json',
    'trash/projects/a.jsonl',
    'consoles/k.json',
    'console-env/k.env',
    'console-append/k.txt',
    'console-rotations/r.json',
    'asks-replies/silos/ses_1/p.reply.json',
    'claude-settings-backups/settings.json.1',
    'backups/agents.json.1',
    'file-backups/f.txt',
    'migrations/m.json',
    'cache/sessions.json',
    'logs/server.log',
    'runs/runs.jsonl',
    'brand-new-dir/x.txt',
    'agent-state/finance/status.json',
    'agent-state/ghost/runmode.json',
    'agent-state/master/x.json',
    'agent-state/silos/status.json',
    'agent-state/silos/messages/m1.json',
  ]
  for (const f of files) {
    mkdirSync(join(dataDir, f, '..'), { recursive: true })
    writeFileSync(join(dataDir, f), 'x')
  }
  const reg: Agent[] = [
    { id: 'master', name: 'Master', emoji: '', role: '', folder: null, skills: [] },
    { id: 'silos', name: 'Silos', emoji: '', role: '', folder: join(home, 'silos'), skills: [] },
    { id: 'finance', name: 'Finance', emoji: '', role: '', folder: join(home, 'ci'), skills: [] },
  ] as Agent[]
  const registry = { get: (id: string) => reg.find((a) => a.id === id) ?? null, list: () => reg }
  const enabled = new Set(['silos'])
  const store = { privatePaths: () => ['~/secrets'], isEnabled: (id: string) => enabled.has(id) }
  const territory = makeTerritory({ registry, agentState: { pathFor: (id: string) => join(dataDir, 'agent-state', id) }, store, home, dataDir })

  it("every file of the data dir is Read- and Edit-denied, except the agent's own state", () => {
    const deny = territory.fenceFor('silos')!.permissions.deny
    const own = join(dataDir, 'agent-state', 'silos')
    for (const f of walk(dataDir)) {
      const mine = f.startsWith(`${own}/`)
      expect([f, covered(deny, 'Read', f)]).toEqual([f, !mine])
      expect([f, covered(deny, 'Edit', f)]).toEqual([f, !mine])
    }
    expect(territory.fenceFor('silos')!.permissions.additionalDirectories).toContain(own)
  })

  it("denies every registered engine's secret files (OpenCode's auth.json), whatever engine the agent runs on", async () => {
    const { authFilePath } = await import('../src/harnesses/opencode/auth-file.js')
    const deny = territory.fenceFor('silos')!.permissions.deny
    expect(deny).toContain(`Read(/${authFilePath(home)})`)
    expect(deny).toContain(`Edit(/${authFilePath(home)})`)
  })

  it('an agent whose territory is off carries only the always-on groups; master and an unknown id no fence', () => {
    const off = territory.fenceFor('finance')!.permissions.deny
    expect(covered(off, 'Read', join(dataDir, 'token'))).toBe(true)
    expect(covered(off, 'Read', join(dataDir, 'agents', 'builder', 'token'))).toBe(true)
    expect(covered(off, 'Read', join(home, 'silos', 'src', 'x.ts'))).toBe(true) // another project's folder
    expect(covered(off, 'Read', join(dataDir, 'agents.json'))).toBe(false) // Silos' other data: open when off
    expect(covered(off, 'Read', join(dataDir, 'agent-state', 'silos', 'status.json'))).toBe(false)
    expect(off.some((r) => r.startsWith('Bash('))).toBe(false)
    expect(territory.fenceFor('master')).toBeNull()
    enabled.add('master')
    expect(territory.fenceFor('master')).toBeNull()
    enabled.delete('master')
    expect(territory.fenceFor('ghost')).toBeNull()
  })

  it('appliedPrivatePaths counts only paths the overlay denies', () => {
    const fence = territory.fenceFor('silos')
    expect(appliedPrivatePaths(fence, ['~/secrets', home, `${home}/silos/keys`], home)).toEqual(['~/secrets'])
    expect(appliedPrivatePaths(null, ['~/secrets'], home)).toEqual([])
  })
})

// The OpenCode console records (<dataDir>/consoles — agent,
// HTTP password, bound id) must be fenced before the dir first exists, or a
// console launched earlier could read passwords and plant records.
describe('the data dir fence over an EMPTY data dir', () => {
  it('denies the fixed dirs that do not exist yet — consoles/** among them — for Read and Edit', () => {
    const home = mkdtempSync(join(tmpdir(), 'terr-empty-'))
    const dataDir = join(home, '.silos')
    mkdirSync(dataDir)
    const reg = [{ id: 'silos', name: 'Silos', emoji: '', role: '', folder: join(home, 'silos'), skills: [] }] as Agent[]
    const territory = makeTerritory({
      registry: { get: (id: string) => reg.find((a) => a.id === id) ?? null, list: () => reg },
      agentState: { pathFor: (id: string) => join(dataDir, 'agent-state', id) },
      store: { privatePaths: () => [], isEnabled: () => true },
      home,
      dataDir,
    })
    const deny = territory.fenceFor('silos')!.permissions.deny
    for (const f of ['consoles/k.json', 'consoles/ses_x.json', 'console-env/k.env', 'agents/builder/token']) {
      expect([f, covered(deny, 'Read', join(dataDir, f))]).toEqual([f, true])
      expect([f, covered(deny, 'Edit', join(dataDir, f))]).toEqual([f, true])
    }
  })
})

describe('TerritoryStore enabled — the rollout gate', () => {
  const mk = () => mkdtempSync(join(tmpdir(), 'terr-en-'))
  it('defaults to [] (nobody fenced) and round-trips next to privatePaths', () => {
    const d = mk()
    const s = new TerritoryStore(d)
    s.load()
    expect(s.enabled()).toEqual([])
    expect(s.isEnabled('silos')).toBe(false)
    s.setEnabled(['silos', 'silos', 'support'])
    s.setPrivatePaths(['~/vault'])
    const s2 = new TerritoryStore(d)
    s2.load()
    expect(s2.enabled()).toEqual(['silos', 'support'])
    expect(s2.privatePaths()).toEqual(['~/vault'])
    expect(s2.isEnabled('support')).toBe(true)
  })
  it('a file without enabled (written before the gate) enables nobody', () => {
    const d = mk()
    writeFileSync(join(d, 'territory.json'), JSON.stringify({ privatePaths: ['~/x'] }))
    const s = new TerritoryStore(d)
    s.load()
    expect(s.enabled()).toEqual([])
  })
})

// Names under the data dir are written into
// deny PATTERNS. A glob character in a name would make the rule match more
// or less than that one entry — and there is no escape both engines read the
// same way (OpenCode: `*`/`?` are wildcards with no escape, `\` is literal,
// `{` breaks its config substitution; Claude Code: gitignore-style, `[…]`
// classes, `\` escapes). So such an entry is never written as a rule: it is
// skipped and reported in `skipped` with the reason — never guessed.
describe('glob characters in data-dir entry names', () => {
  const GLOB_CHARS = ['*', '?', '[', ']', '{', '}', '!', '\\']
  const agent = { id: 'silos', name: 'Silos', emoji: '', role: '', folder: '/home/u/silos', skills: [] } as Agent
  const mk = (entries: { files?: string[]; dirs?: string[] }, stateDirIds: string[] = []) =>
    fenceFor({
      agent,
      agents: [agent],
      privatePaths: [],
      home,
      dataDir,
      agentStateDir: `${dataDir}/agent-state/silos`,
      dataDirEntries: { files: entries.files ?? [], dirs: entries.dirs ?? [] },
      stateDirIds,
    })!

  for (const c of GLOB_CHARS) {
    for (const where of ['file', 'dir', 'state dir'] as const) {
      it(`a ${where} named with ${JSON.stringify(c)} writes no rule and is reported`, () => {
        const name = `a${c}b`
        const fence = where === 'file' ? mk({ files: [name] }) : where === 'dir' ? mk({ dirs: [name] }) : mk({}, [name])
        const path = where === 'state dir' ? `${dataDir}/agent-state/${name}` : `${dataDir}/${name}`
        expect(fence.permissions.deny.filter((r) => r.includes(name))).toEqual([])
        expect(fence.skipped).toEqual([{ path, reason: expect.stringContaining(JSON.stringify(c)) }])
      })
    }
  }

  it("a glob name that would cover the agent-state dir (agent-stat?, agent-*) never denies the agent's own state", () => {
    const fence = mk({ dirs: ['agent-stat?', 'agent-*', '*'], files: ['a*'] })
    const own = `${dataDir}/agent-state/silos/status.json`
    expect(covered(fence.permissions.deny, 'Read', own)).toBe(false)
    expect(covered(fence.permissions.deny, 'Edit', own)).toBe(false)
    expect(fence.skipped?.map((u) => u.path).sort()).toEqual([`${dataDir}/*`, `${dataDir}/a*`, `${dataDir}/agent-*`, `${dataDir}/agent-stat?`].sort())
  })

  it('plain names next to a glob one are still fenced; no skipped field when nothing is skipped', () => {
    const fence = mk({ files: ['plain.json', 'x*'], dirs: ['some-dir'] }, ['ghost'])
    expect(covered(fence.permissions.deny, 'Read', `${dataDir}/plain.json`)).toBe(true)
    expect(covered(fence.permissions.deny, 'Edit', `${dataDir}/some-dir/k`)).toBe(true)
    expect(covered(fence.permissions.deny, 'Read', `${dataDir}/agent-state/ghost/x`)).toBe(true)
    expect(mk({ files: ['plain.json'] }).skipped).toBeUndefined()
  })

  it('the OpenCode translation of a fence over such a data dir does not throw (a "{" used to abort the launch)', async () => {
    const { fenceMapping } = await import('../src/harnesses/opencode/fence.js')
    const fence = mk({ files: ['a{b', 'c}d'], dirs: ['{env:HOME}'] }, ['x{y'])
    expect(() => fenceMapping(fence, { worktree: '/home/u/silos' })).not.toThrow()
  })
})

// The fence read back as places (Settings › Territory, Machinery): every
// group comes from the overlay's own rules, never a second policy.
describe('fenceScope', () => {
  const home = '/home/u'
  const dataDir = '/home/u/.silos'
  const ag = (id: string, folder: string | null, extra: Partial<Agent> = {}): Agent => ({ id, name: id, folder, skills: [], ...extra }) as Agent
  const agents = [ag('builder', '/home/u/ci'), ag('finance', '/home/u/ci'), ag('silos', '/home/u/silos'), ag('master', null)]
  const scopeOf = (a: Agent, privatePaths = ['~/secrets', '~/.ssh']) => {
    const f = fenceFor({ agent: a, agents, privatePaths, home, dataDir, agentStateDir: `${dataDir}/agent-state/${a.id}` })!
    return fenceScope(f, territoriesOf(a), { home, dataDir })
  }

  it('works in its folder and its own state; reads only the other roles of a shared folder; kept out of the rest', () => {
    const s = scopeOf(agents[0]!)
    expect(s.works).toEqual(['~/ci'])
    expect(s.state).toBe('~/.silos/agent-state/builder')
    expect(s.readOnly).toEqual(['~/ci/context/finance'])
    expect(s.blocked.map((b) => b.kind)).toEqual(['projects', 'silos', 'claude', 'agents', 'private'])
    expect(s.blocked.find((b) => b.kind === 'projects')!.paths).toEqual(['~/silos'])
    expect(s.blocked.find((b) => b.kind === 'agents')!.paths).toEqual(['finance', 'master', 'silos'])
    expect(s.blocked.find((b) => b.kind === 'private')!.paths).toEqual(['~/.ssh', '~/secrets'])
    expect(s.blocked.find((b) => b.kind === 'claude')!.paths).toContain('~/.claude/.credentials.json')
  })

  it("an agent alone in its folder reads nobody else's notes", () => {
    expect(scopeOf(agents[2]!).readOnly).toEqual([])
  })

  it('a private path it works inside is not in its kept-out list', () => {
    const s = scopeOf(ag('vault', '/home/u/secrets/vault'))
    expect(s.blocked.find((b) => b.kind === 'private')!.paths).toEqual(['~/.ssh'])
  })
})

// What an engine LOADS is never the agent's to write.
// Claude rules are matched gitignore-style; node's matchesGlob stands
// in a small gitignore-style matcher (`**` crosses `/` and dotfiles, `*`
// stays in one segment) — the real binary is checked by
// scripts/territory-smoke.sh. OpenCode's dialect is in
// opencode-fence.test.ts. Not covered by ANY rule, said here once: an
// interpreter (`python3 -c "open(…).write(…)"`) runs as the same Unix user
// (OS-level isolation would close that class).
describe('fenceFor — what an engine loads', () => {
  const matchesGlob = (path: string, glob: string): boolean =>
    new RegExp(
      `^${glob
        .split('**')
        .map((part) =>
          part
            .split('*')
            .map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
            .join('[^/]*'),
        )
        .join('.*')}$`,
    ).test(path)
  const stateDir = '/home/u/.silos/agent-state/builder'
  const configFiles = (folder: string): string[] => [
    `${folder}/.mcp.json`,
    `${folder}/opencode.json`,
    `${folder}/opencode.jsonc`,
    `${folder}/.opencode/**`,
    '/home/u/.config/opencode/**',
  ]
  const d = fenceFor({ ...base, agent: builder, agentStateDir: stateDir, engineConfigFiles: configFiles })!.permissions.deny
  const denied = (tool: 'Read' | 'Edit', path: string): boolean =>
    d.some((r) => r.startsWith(`${tool}(//`) && matchesGlob(path, `/${r.slice(tool.length + 3, -1)}`))

  it.each(['skills/x/SKILL.md', 'commands/c.md', 'agents/a.md', 'hooks/hooks.json', '.mcp.json', '.claude-plugin/plugin.json'])(
    'its own plugin, whole: %s is not editable, still readable',
    (sub) => {
      expect(denied('Edit', `${stateDir}/plugin/${sub}`)).toBe(true)
      expect(denied('Read', `${stateDir}/plugin/${sub}`)).toBe(false)
    },
  )
  it('the rest of its state dir stays open: proposed/, runmode, notes', () => {
    for (const p of ['proposed/x/SKILL.md', 'runmode.json', 'notes.md']) {
      expect(denied('Edit', `${stateDir}/${p}`)).toBe(false)
      expect(denied('Read', `${stateDir}/${p}`)).toBe(false)
    }
  })
  it.each(['skills/x/SKILL.md', 'commands/c.md', 'agents/a.md', 'plugins/cache/p/skills/y/SKILL.md', 'output-styles/s.md'])(
    'the home layer of every config dir: %s editable by none, readable (a skill reads its own files)',
    (sub) => {
      for (const dir of ['/home/u/.claude', '/home/u/.silos/claude-accounts/kai']) {
        expect(denied('Edit', `${dir}/${sub}`)).toBe(true)
        expect(denied('Read', `${dir}/${sub}`)).toBe(false)
      }
    },
  )
  // an extra account's CLAUDE.md is a symlink to the machine's
  // (accounts.ts FOLLOWED_FILES) — an engine that does not resolve symlinks
  // when matching a deny would write the machine's user memory through it
  it("the user memory: ~/.claude/CLAUDE.md and every account's link to it, neither read nor edited", () => {
    for (const p of ['/home/u/.claude/CLAUDE.md', '/home/u/.silos/claude-accounts/kai/CLAUDE.md']) {
      expect(denied('Read', p)).toBe(true)
      expect(denied('Edit', p)).toBe(true)
    }
  })
  it('in every territory: engine settings neither read nor edited; skills not edited', () => {
    for (const t of ['/home/u/ci', '/home/u/builder']) {
      for (const f of ['settings.json', 'settings.local.json']) {
        expect(denied('Read', `${t}/.claude/${f}`)).toBe(true)
        expect(denied('Edit', `${t}/.claude/${f}`)).toBe(true)
      }
      expect(denied('Edit', `${t}/.claude/skills/x/SKILL.md`)).toBe(true)
      expect(denied('Read', `${t}/.claude/skills/x/SKILL.md`)).toBe(false)
    }
  })
  it.each(['.mcp.json', 'opencode.json', 'opencode.jsonc', '.opencode/agent/a.md'])(
    'configFiles of every registered engine, in every territory: %s not editable',
    (f) => {
      for (const t of ['/home/u/ci', '/home/u/builder']) expect(denied('Edit', `${t}/${f}`)).toBe(true)
    },
  )
  it("OpenCode's global config is not editable", () => {
    expect(denied('Edit', '/home/u/.config/opencode/opencode.json')).toBe(true)
  })
  it('the heartbeat ledger is Silos-only; proposals.json is covered by *.json', () => {
    for (const tool of ['Read', 'Edit'] as const) {
      expect(denied(tool, '/home/u/.silos/heartbeats/builder/ledger.json')).toBe(true)
      expect(denied(tool, '/home/u/.silos/proposals.json')).toBe(true)
    }
  })
  it('no process environment is readable — the pid level and the per-thread one (M3)', () => {
    for (const p of ['/proc/123/environ', '/proc/self/environ', '/proc/123/task/124/environ', '/proc/self/task/9/environ']) expect(denied('Read', p)).toBe(true)
    expect(denied('Read', '/proc/123/status')).toBe(false) // only the environment, not /proc
  })
  it('the widened private defaults hold, each path and what sits under it — the FILE ~/.npmrc included', () => {
    const f = fenceFor({ ...base, privatePaths: [...DEFAULT_PRIVATE], agent: builder, agentStateDir: stateDir })!.permissions.deny
    const covers = (tool: 'Read' | 'Edit', path: string) => f.some((r) => r.startsWith(`${tool}(//`) && matchesGlob(path, `/${r.slice(tool.length + 3, -1)}`))
    for (const p of ['.npmrc', '.aws/credentials', '.config/gh/hosts.yml', '.gnupg/private-keys-v1.d/k.key', '.ssh/id_ed25519', 'secrets/k']) {
      expect([p, covers('Read', `/home/u/${p}`), covers('Edit', `/home/u/${p}`)]).toEqual([p, true, true])
    }
  })
  // the conduct files of EVERY agent folder Silos knows,
  // not only its own — a hook or a skill planted in another agent's folder
  // runs as that agent (the unfenced silos one included). Same per-file
  // shapes as its own folders.
  const conduct = (deny: string[], folder: string) => {
    const has = (tool: 'Read' | 'Edit', p: string) => deny.some((r) => r.startsWith(`${tool}(//`) && matchesGlob(p, `/${r.slice(tool.length + 3, -1)}`))
    return {
      settings: [has('Read', `${folder}/.claude/settings.local.json`), has('Edit', `${folder}/.claude/settings.json`)],
      skills: [has('Read', `${folder}/.claude/skills/x/SKILL.md`), has('Edit', `${folder}/.claude/skills/x/SKILL.md`)],
      config: ['.mcp.json', 'opencode.json', 'opencode.jsonc', '.opencode/plugin/x.js'].map((f) => [
        has('Read', `${folder}/${f}`),
        has('Edit', `${folder}/${f}`),
      ]),
      work: [has('Read', `${folder}/src/app.ts`), has('Edit', `${folder}/src/app.ts`)],
    }
  }
  const sameAsOwn = {
    settings: [true, true],
    skills: [false, true],
    config: [
      [false, true],
      [false, true],
      [false, true],
      [false, true],
    ],
    work: [false, false],
  }
  const otherProject = {
    settings: [true, true],
    skills: [true, true],
    config: [
      [true, true],
      [true, true],
      [true, true],
      [true, true],
    ],
    work: [true, true],
  }
  it("another project's folder, both directions: closed whole — its work, its conduct files", () => {
    // builder (ci + builder) → silos's folder, the unfenced agent's
    expect(conduct(d, '/home/u/silos')).toEqual(otherProject)
    // not transitive: finance shares ci with builder, its second folder is another project to builder
    expect(conduct(d, '/home/u/secrets/finance')).toEqual(otherProject)
    // silos fenced → every folder of builder (folders[] too)
    const s = fenceFor({ ...base, agent: silos, agentStateDir: '/home/u/.silos/agent-state/silos', engineConfigFiles: configFiles })!.permissions.deny
    for (const t of ['/home/u/ci', '/home/u/builder']) expect([t, conduct(s, t)]).toEqual([t, otherProject])
  })
  it("a folder of its own project, nested either way: conduct files fenced like one's own, the work untouched", () => {
    const docs = { id: 'docs', folder: '/home/u/ci/docs', skills: [], name: 'Docs', emoji: '', role: '' }
    const lead = { id: 'lead', folder: '/home/u', skills: [], name: 'Lead', emoji: '', role: '' }
    const a = fenceFor({ ...base, agents: [...base.agents, docs, lead], agent: builder, agentStateDir: stateDir, engineConfigFiles: configFiles })!.permissions
      .deny
    expect(conduct(a, '/home/u/ci/docs')).toEqual(sameAsOwn)
    // a folder AROUND its own is the same project (one relation, both directions)
    expect(conduct(a, '/home/u').work).toEqual([false, false])
    // and the nested agent's notes there: read, never edited
    expect(a).toContain('Edit(//home/u/ci/docs/context/docs/**)')
  })
  it("an archived agent's folder counts too; an agent with no folder adds nothing", () => {
    const old = { id: 'old', folder: '/home/u/old', skills: [], name: 'Old', emoji: '', role: '', archived: true }
    const none = { id: 'nf', folder: null, skills: [], name: 'Nf', emoji: '', role: '' } as unknown as Agent
    const a = fenceFor({ ...base, agents: [...base.agents, old, none], agent: builder, agentStateDir: stateDir, engineConfigFiles: configFiles })!.permissions
      .deny
    expect(conduct(a, '/home/u/old')).toEqual(otherProject)
    // besides its state dir (denied like any other agent's), only that folder's rules are new
    expect(a.filter((r) => !d.includes(r) && !/\/agent-state\/(old|nf)\//.test(r)).every((r) => /\/home\/u\/old(\/|\))/.test(r))).toBe(true)
  })
  it('a folder shared by several agents is written once — the rule count stays per folder, not per agent', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, folder: '/home/u/ci', skills: [], name: `A${i}`, emoji: '', role: '' }))
    const a = fenceFor({ ...base, agents: [...base.agents, ...many], agent: builder, agentStateDir: stateDir, engineConfigFiles: configFiles })!.permissions
      .deny
    expect(a.filter((r) => r.includes('/home/u/ci/.claude/settings') || r.includes('/home/u/ci/.mcp.json'))).toHaveLength(3)
    // only each new agent's state dir and shared notes add rules — no conduct rule per agent
    expect(a.filter((r) => !d.includes(r)).every((r) => /\/(agent-state|home\/u\/ci\/context)\/a\d+\/\*\*\)$/.test(r))).toBe(true)
  })
  it("declared residue: the only command rules are the tmux server's — an interpreter is not covered", () => {
    expect(d.filter((r) => !r.startsWith('Read(') && !r.startsWith('Edit('))).toEqual(['Bash(tmux)', 'Bash(tmux *)'])
    expect(FENCE_REFUSAL_RE.test('Permission to use Bash with command tmux -V has been denied.')).toBe(true)
  })
  it('a private FILE is denied too, not only what sits under it', () => {
    const f = fenceFor({ ...base, privatePaths: ['~/.npmrc'], agent: builder, agentStateDir: stateDir })!.permissions.deny
    expect(f).toContain('Read(//home/u/.npmrc)')
    expect(f).toContain('Edit(//home/u/.npmrc)')
  })
  it('the defaults cover the usual credential homes', () => {
    expect(DEFAULT_PRIVATE).toEqual(['~/secrets', '~/.ssh', '~/.npmrc', '~/.aws', '~/.config/gh', '~/.gnupg'])
  })
  it('makeTerritory asks every registered engine for its configFiles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fence-cfg-'))
    const agent: Agent = { ...builder, folders: [] } as Agent
    const t = makeTerritory({
      registry: { get: (id) => (id === 'builder' ? agent : null), list: () => [agent] },
      agentState: { pathFor: (id) => join(dir, 'agent-state', id) },
      store: { privatePaths: () => [], isEnabled: () => true },
      home: '/home/u',
      dataDir: dir,
    })
    const deny = t.fenceFor('builder')!.permissions.deny
    expect(deny).toContain('Edit(//home/u/ci/.mcp.json)')
    expect(deny).toContain('Edit(//home/u/ci/opencode.json)')
    expect(deny).toContain('Edit(//home/u/.config/opencode/**)')
    expect(deny).toContain(`Edit(/${join(dir, 'agent-state', 'builder', 'plugin')}/**)`)
  })
})

// R5 — Files: an agent's file tools open its own projects; another
// project's folder and the engine's stores of that project are closed,
// territory switch or not, and so are the credentials Silos keeps. The
// engine's side (a symlink from inside its own folder, the temp store) is
// scripts/territory-smoke-files.mts on the real binary.
describe('the other-projects group and the credentials — R5', () => {
  const H = '/home/user',
    D = '/home/user/.silos',
    TMP = '/tmp'
  const ag = (id: string, folder: string | null, extra: Partial<Agent> = {}): Agent =>
    ({ id, name: id, emoji: '', role: '', skills: [], folder, ...extra }) as Agent
  const builder = ag('builder', '/home/user/acme')
  const docs = ag('docs', '/home/user/acme/docs')
  const maker = ag('maker', '/home/user/beta')
  const site = ag('site', '/home/user/acme-web')
  const deep = ag('deep', '/home/user/acme/web') // munges like acme-web
  const scribe = ag('scribe', '/home/user/acme/notes', { folders: ['/home/user/beta'] })
  const gone = ag('gone', '/home/user/old', { archived: true })
  const all = [builder, docs, maker, site, deep, scribe, gone, ag('master', null)]
  const stores = (folder: string, own: readonly string[]) =>
    [claudeCode, opencode].flatMap((h) => h.projectStores?.(folder, { home: H, dataDir: D, own }) ?? [])
  const fence = (agent: Agent, extra: Partial<Parameters<typeof fenceFor>[0]> = {}) =>
    fenceFor({
      agent,
      agents: all,
      privatePaths: [],
      home: H,
      dataDir: D,
      agentStateDir: `${D}/agent-state/${agent.id}`,
      projectStores: stores,
      ...extra,
    })!
  const projectsOf = (agent: Agent, extra: Partial<Parameters<typeof fenceFor>[0]> = {}) => fence(agent, extra).permissions.deny
  const uid = process.getuid?.() ?? 0

  it('a disjoint folder of another agent and its engine stores: Read and Edit denied; a nested one, and a folder around its own, are not', () => {
    const d = projectsOf(builder)
    for (const p of [
      '/home/user/beta/src/x.ts',
      '/home/user/beta',
      '/home/user/beta/plans/tasks.plan.json',
      '/home/user/old/notes.md',
      `${H}/.claude/projects/-home-user-beta/s1.jsonl`,
      `${H}/.claude/projects/-home-user-beta/memory/MEMORY.md`,
      `${D}/claude-accounts/kai/projects/-home-user-beta/s1.jsonl`,
      `${tmpdir()}/claude-${uid}/-home-user-beta/s1/scratchpad/x`,
    ]) {
      expect([p, covered(d, 'Read', p), covered(d, 'Edit', p)]).toEqual([p, true, true])
    }
    for (const p of ['/home/user/acme/docs/README.md', '/home/user/acme/notes/n.md', `${H}/.claude/projects/-home-user-acme-docs/s1.jsonl`]) {
      expect([p, covered(d, 'Read', p), covered(d, 'Edit', p)]).toEqual([p, false, false])
    }
    // the nested agent sees its parent's folder open too
    expect(covered(projectsOf(docs), 'Read', '/home/user/acme/plans/tasks.plan.json')).toBe(false)
  })

  it('not transitive: scribe bridges acme and beta, builder and maker stay closed to each other; scribe has both open', () => {
    expect(covered(projectsOf(maker), 'Read', '/home/user/acme/x')).toBe(true)
    const s = projectsOf(scribe)
    expect(covered(s, 'Read', '/home/user/acme/x')).toBe(false)
    expect(covered(s, 'Read', '/home/user/beta/x')).toBe(false)
    expect(covered(s, 'Read', '/home/user/acme-web/x')).toBe(true)
  })

  it('the sibling prefix is another project: /home/user/acme-web closed to builder, and the reverse', () => {
    expect(covered(projectsOf(builder), 'Read', '/home/user/acme-web/x')).toBe(true)
    expect(covered(projectsOf(site), 'Edit', '/home/user/acme/x')).toBe(true)
  })

  it('a store the engine names like one of its own (acme/web · acme-web): transcripts closed, memory/ open, said with why', () => {
    const f = fence(deep)
    const d = f.permissions.deny
    const store = `${H}/.claude/projects/-home-user-acme-web`
    expect(covered(d, 'Read', `${store}/0f9c2e1a-1111-2222-3333-444455556666.jsonl`)).toBe(true)
    expect(covered(d, 'Read', `${store}/0f9c2e1a-1111-2222-3333-444455556666/subagents/agent-a.jsonl`)).toBe(true)
    expect(covered(d, 'Read', `${store}/memory/MEMORY.md`)).toBe(false)
    expect(covered(d, 'Edit', `${store}/memory/notes.md`)).toBe(false)
    expect(f.skipped?.some((u) => u.path === store && /memory\/ stays open/.test(u.reason))).toBe(true)
    // the folder itself is closed whole: only the store's name collides
    expect(covered(d, 'Read', '/home/user/acme-web/src/x.ts')).toBe(true)
    // a store that EXTENDS its own name (its subfolder's conversations live there): partly too
    expect(fence(builder).skipped?.some((u) => u.path === store)).toBe(true)
  })

  it("PROPERTY: no deny rule matches a path inside its own folders, its state dir, a config dir's skills, the checkout's plugin/context — with an agent holding the home folder", () => {
    const lead = ag('lead', H)
    const many = [...all, lead, ag('srv', SILOS_CHECKOUT), ag('tmpy', `${TMP}/work`)]
    for (const a of many.filter((x) => x.folder !== null && !x.archived && x.id !== 'master')) {
      const d = fenceFor({
        agent: a,
        agents: many,
        privatePaths: [...DEFAULT_PRIVATE],
        home: H,
        dataDir: D,
        agentStateDir: `${D}/agent-state/${a.id}`,
        projectStores: stores,
        mustReach: [
          { path: SILOS_CHECKOUT, what: 'Silos' },
          { path: TMP, what: 'the temp dir' },
        ],
      })!.permissions.deny
      const reach = [
        ...territoriesOf(a).flatMap((t) => [`${t}/src/x.ts`, `${t}/plans/tasks.plan.json`, `${t}/context/${a.id}/n.md`]),
        `${D}/agent-state/${a.id}/status.json`,
        `${D}/agent-state/${a.id}/proposed/s/SKILL.md`,
        `${H}/.claude/skills/x/SKILL.md`,
        `${D}/claude-accounts/kai/skills/x/reference.md`,
        `${SILOS_CHECKOUT}/plugin/context/reference/tasks.md`,
        `${H}/.claude/projects/${territoriesOf(a)[0]!.replace(/[/.]/g, '-')}/memory/MEMORY.md`,
      ]
      for (const p of reach) expect([a.id, p, covered(d, 'Read', p)]).toEqual([a.id, p, false])
    }
  })

  it('a folder that holds what every agent must reach is never closed, and says why', () => {
    // a data dir outside home, inside another agent's folder
    const data = '/srv/ops/.silos'
    const f = fenceFor({
      agent: maker,
      agents: [maker, ag('ops', '/srv/ops'), ag('srv', SILOS_CHECKOUT)],
      privatePaths: [],
      home: H,
      dataDir: data,
      agentStateDir: `${data}/agent-state/maker`,
      mustReach: [{ path: SILOS_CHECKOUT, what: 'Silos itself' }],
    })!
    expect(f.permissions.deny.some((r) => r === 'Read(//srv/ops)' || r === 'Read(//srv/ops/**)')).toBe(false)
    expect(covered(f.permissions.deny, 'Read', `${data}/agent-state/maker/status.json`)).toBe(false)
    expect(f.skipped?.find((u) => u.path === '/srv/ops')?.reason).toMatch(/data dir/)
    expect(f.skipped?.find((u) => u.path === SILOS_CHECKOUT)?.reason).toMatch(/Silos itself/)
  })

  it("the disk's reading only removes a deny: its own folder under another spelling stays open", () => {
    const alias = ag('alias', '/srv/acme') // the same directory as /home/user/acme on disk
    const canonical = (p: string): string => p.replace(/^\/srv\/acme(?=\/|$)/, '/home/user/acme')
    const d = fenceFor({
      agent: builder,
      agents: [builder, alias],
      privatePaths: [],
      home: H,
      dataDir: D,
      agentStateDir: `${D}/agent-state/builder`,
      canonical,
    })!.permissions.deny
    expect(covered(d, 'Read', '/srv/acme/x')).toBe(false)
  })

  it("another project's worktrees and the conversations started below its folder are closed with it", () => {
    const d = projectsOf(builder, {
      worktreesOf: (f) => (f === '/home/user/beta' ? ['/home/user/beta-wt'] : []),
      sessionCwds: ['/home/user/beta/api', '/home/user/acme/x'],
    })
    expect(covered(d, 'Read', '/home/user/beta-wt/src/x.ts')).toBe(true)
    expect(covered(d, 'Read', `${H}/.claude/projects/-home-user-beta-wt/s.jsonl`)).toBe(true)
    expect(covered(d, 'Read', `${H}/.claude/projects/-home-user-beta-api/s.jsonl`)).toBe(true)
    expect(covered(d, 'Read', `${H}/.claude/projects/-home-user-acme-x/s.jsonl`)).toBe(false)
  })

  it('territory off keeps exactly the two always-on groups; on adds the rest', () => {
    const offF = fence(builder, { on: false })
    const onF = fence(builder)
    const off = offF.permissions.deny
    const projectRules = new Set(offF.projects!.rules)
    const credential = (r: string): boolean =>
      /^(Read|Edit)\(\/\/home\/user\/\.silos\/(token|sessions\.json|live-turns\.json|vault\.json|providers\.json|silos-id\.json|server\.env|(agents|console-env|seals|held|push)\/\*\*)\)$/.test(
        r,
      ) || /^Read\(\/\/proc\/(\*|\*\*)\/(environ|cmdline)\)$/.test(r)
    expect(off.filter((r) => !projectRules.has(r) && !credential(r))).toEqual([])
    expect(off.filter(credential)).toHaveLength(2 * 12 + 4)
    expect(onF.permissions.deny.length).toBeGreaterThan(off.length)
    for (const r of off) expect(onF.permissions.deny).toContain(r)
  })

  it('master and an agent without a folder keep no rule', () => {
    expect(fenceFor({ agent: ag('master', null), agents: all, privatePaths: [], home: H, dataDir: D, agentStateDir: '' })).toBeNull()
    expect(fenceFor({ agent: ag('loose', null), agents: all, privatePaths: [], home: H, dataDir: D, agentStateDir: '', on: false })).toBeNull()
  })

  it('fenceScope reads the group back as «other projects» and lists what stayed open', () => {
    const s = fenceScope(fence(deep), territoriesOf(deep), { home: H, dataDir: D })
    expect(s.blocked[0]).toEqual({
      kind: 'projects',
      paths: ['/home/user/acme-web', '/home/user/acme/docs', '/home/user/acme/notes', '/home/user/beta', '/home/user/old'].map((p) => p.replace(H, '~')),
    })
    expect(s.open.some((o) => o.path === '~/.claude/projects/-home-user-acme-web')).toBe(true)
    // a store's rules never leak into another group
    expect(s.blocked.find((b) => b.kind === 'claude')?.paths.some((p) => p.includes('/projects/'))).toBeFalsy()
  })

  it("the adapter reads a folder's git worktrees and the index's conversations", () => {
    const root = mkdtempSync(join(tmpdir(), 'terr-wt-'))
    const beta = join(root, 'beta'),
      wt = join(root, 'beta-wt'),
      acme = join(root, 'acme')
    mkdirSync(join(beta, '.git', 'worktrees', 'w1'), { recursive: true })
    writeFileSync(join(beta, '.git', 'worktrees', 'w1', 'gitdir'), `${wt}/.git\n`)
    mkdirSync(acme)
    const reg = [ag('builder', acme), ag('maker', beta)]
    const t = makeTerritory({
      registry: { get: (id) => reg.find((a) => a.id === id) ?? null, list: () => reg },
      agentState: { pathFor: (id) => join(root, '.silos', 'agent-state', id) },
      store: { privatePaths: () => [], isEnabled: () => false },
      home: root,
      dataDir: join(root, '.silos'),
      sessionCwds: () => [join(beta, 'api'), null],
    })
    const d = t.fenceFor('builder')!.permissions.deny
    expect(covered(d, 'Read', join(wt, 'x'))).toBe(true)
    expect(covered(d, 'Read', join(root, '.claude', 'projects', join(beta, 'api').replace(/[/.]/g, '-'), 's.jsonl'))).toBe(true)
    expect(covered(d, 'Read', join(acme, 'x'))).toBe(false)
  })
})

// t5: no agent writes a file an engine loads from above a project — in every
// folder above a known agent's folder, and in the Projects folder and above
// it; reading stays open (a file already there is the owner's)
describe('fenceFor — what an engine loads from above a project', () => {
  const H = '/home/user',
    D = '/home/user/.silos',
    P = '/home/user/Silos'
  const ag = (id: string, folder: string): Agent => ({ id, name: id, emoji: '', role: '', skills: [], folder })
  const app = ag('builder', `${P}/app`)
  const books = ag('finance', '/home/user/code/books')
  const above = (dir: string): string[] => [claudeCode, opencode].flatMap((h) => h.loadedFromAbove?.(dir, H) ?? [])
  const fence = (agent: Agent, agents: Agent[], extra: Partial<Parameters<typeof fenceFor>[0]> = {}): string[] =>
    fenceFor({
      agent,
      agents,
      privatePaths: [],
      home: H,
      dataDir: D,
      agentStateDir: `${D}/agent-state/${agent.id}`,
      loadedFromAbove: above,
      projectsFolder: P,
      ...extra,
    })!.permissions.deny

  const loaded = [
    `${P}/CLAUDE.md`,
    `${P}/CLAUDE.local.md`,
    `${P}/AGENTS.md`,
    `${P}/CONTEXT.md`,
    `${P}/.claude/CLAUDE.md`,
    `${P}/.claude/rules/style.md`,
    `${P}/.claude/settings.json`,
    `${P}/.claude/skills/x/SKILL.md`,
    `${P}/.mcp.json`,
    `${P}/opencode.json`,
    `${P}/.opencode/agent/a.md`,
    '/home/user/CLAUDE.md',
    '/home/user/CLAUDE.local.md',
    '/home/user/AGENTS.md',
    '/home/CLAUDE.md',
    // above another agent's folder, outside the Projects folder
    '/home/user/code/CLAUDE.md',
    '/home/user/code/.claude/rules/r.md',
  ]
  it.each([true, false])('territory on=%s: edits denied in every folder above a project and in the Projects folder; reads open', (on) => {
    const d = fence(app, [app, books], { on })
    for (const p of loaded) {
      expect(covered(d, 'Edit', p), p).toBe(true)
      expect(covered(d, 'Read', p), p).toBe(false)
    }
  })
  it("the agent's own project stays its own: its CLAUDE.md, AGENTS.md and rules are not denied", () => {
    const d = fence(app, [app, books])
    for (const f of ['CLAUDE.md', 'AGENTS.md', 'CLAUDE.local.md', '.claude/rules/r.md']) expect(covered(d, 'Edit', `${P}/app/${f}`), f).toBe(false)
  })
  it('an empty Projects folder is covered: a project born there later inherits the rule', () => {
    const d = fence(books, [books])
    expect(covered(d, 'Edit', `${P}/CLAUDE.md`)).toBe(true)
    expect(covered(d, 'Edit', `${P}/AGENTS.md`)).toBe(true)
  })
  it("a folder that is a known project (or inside one) is never an «above»: its files are that project's", () => {
    // a registry without the folder check could hold a project inside another
    const outer = ag('builder', '/home/user/work'),
      inner = ag('finance', '/home/user/work/sub')
    const d = fence(outer, [outer, inner])
    expect(covered(d, 'Edit', '/home/user/work/CLAUDE.md')).toBe(false)
    expect(covered(d, 'Edit', '/home/user/CLAUDE.md')).toBe(true)
  })
  it('never inside a place every agent must reach: the config dir and the data dir keep their own rules', () => {
    const without = new Set(fence(app, [app], { on: false, loadedFromAbove: undefined }))
    const added = fence(app, [app], { on: false }).filter((r) => !without.has(r))
    expect(added.length).toBeGreaterThan(0)
    expect(added.filter((r) => r.startsWith('Edit(//home/user/.claude/') || r.startsWith('Edit(//home/user/.silos/'))).toEqual([])
    const extra = fence(app, [app], { on: false, mustReach: [{ path: `${P}/.opencode`, what: 'a shared place' }] })
    expect(covered(extra, 'Edit', `${P}/.opencode/agent/a.md`)).toBe(false)
    expect(covered(extra, 'Edit', `${P}/CLAUDE.md`)).toBe(true)
  })
  it('the user rules ~/.claude/rules/** are not editable (every session loads them), still readable', () => {
    const d = fence(app, [app])
    expect(covered(d, 'Edit', '/home/user/.claude/rules/style.md')).toBe(true)
    expect(covered(d, 'Read', '/home/user/.claude/rules/style.md')).toBe(false)
    for (const p of ['/home/user/CLAUDE.md', '/home/user/AGENTS.md', '/home/user/CLAUDE.local.md']) expect(covered(d, 'Read', p), p).toBe(false)
  })
  it('makeTerritory asks every registered engine and the Projects folder it is given', () => {
    const t = makeTerritory({
      registry: { get: (id) => (id === app.id ? app : null), list: () => [app] },
      agentState: { pathFor: (id) => `${D}/agent-state/${id}` },
      store: { privatePaths: () => [], isEnabled: () => false },
      home: H,
      dataDir: D,
      projectsFolder: () => P,
    })
    const d = t.fenceFor(app.id)!.permissions.deny
    expect(covered(d, 'Edit', `${P}/CLAUDE.md`)).toBe(true)
    expect(covered(d, 'Edit', `${P}/opencode.jsonc`)).toBe(true)
  })
})
