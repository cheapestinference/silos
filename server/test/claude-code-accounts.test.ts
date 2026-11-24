import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, statSync, lstatSync, readlinkSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountsService } from '../src/harnesses/claude-code/accounts.js'
import { ClaudeIdentityReader, type AuthStatusCall } from '../src/harnesses/claude-code/auth-status.js'
import { fakeIdentity, fakeSignIn } from './helpers/fake-claude-auth.js'

let dataDir: string, fakeHomeClaude: string
beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'deck-acc-'))
  dataDir = join(base, 'silos')
  fakeHomeClaude = join(base, 'dot-claude')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(fakeHomeClaude, { recursive: true })
})

function svc(): AccountsService {
  return new AccountsService({ dataDir, defaultConfigDir: fakeHomeClaude, identity: fakeIdentity(fakeHomeClaude) })
}

describe('AccountsService.list', () => {
  it("always includes default; loggedIn/email/plan are Claude's own answer", async () => {
    const a = await svc().list()
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ name: 'default', configDir: null, providerId: 'default', loggedIn: false, email: null, plan: null })
    expect(a[0]).not.toHaveProperty('displayName')

    fakeSignIn(fakeHomeClaude, { email: 'owner@test.dev', subscriptionType: 'max', orgName: 'Acme' })
    const b = await svc().list()
    expect(b[0]).toMatchObject({ loggedIn: true, email: 'owner@test.dev', plan: 'Max' })
  })

  it('a file Claude writes is never read as a login: .credentials.json alone is not «signed in»', async () => {
    writeFileSync(join(fakeHomeClaude, '.credentials.json'), '{}')
    expect((await svc().list())[0]).toMatchObject({ loggedIn: false })
  })

  it('an API-key login (no email, no subscription) is signed in all the same', async () => {
    fakeSignIn(fakeHomeClaude, { authMethod: 'api_key' })
    expect((await svc().list())[0]).toMatchObject({ loggedIn: true, email: null, plan: null })
  })

  it('lists extra accounts under claude-accounts/ with their providerId account:<name>', async () => {
    const dir = join(dataDir, 'claude-accounts', 'work')
    mkdirSync(dir, { recursive: true })
    fakeSignIn(dir, { email: 'work@test.dev' })
    const accounts = await svc().list()
    expect(accounts.map((c) => c.name)).toEqual(['default', 'work'])
    expect(accounts[1]).toMatchObject({ providerId: 'account:work', configDir: dir, loggedIn: true, email: 'work@test.dev' })
  })

  it('an account with no login yet is listed honestly: loggedIn false, email null', async () => {
    mkdirSync(join(dataDir, 'claude-accounts', 'pending'), { recursive: true })
    const accounts = await svc().list()
    expect(accounts[1]).toMatchObject({ name: 'pending', loggedIn: false, email: null, plan: null })
  })

  it("asks each account under ITS config dir — the machine's with none", async () => {
    const dir = join(dataDir, 'claude-accounts', 'alt')
    mkdirSync(dir, { recursive: true })
    const calls: AuthStatusCall[] = []
    const identity = new ClaudeIdentityReader({
      home: '/h',
      bin: () => '/bin/claude',
      runner: async (c) => {
        calls.push(c)
        return { code: 1, stdout: '' }
      },
    })
    await new AccountsService({ dataDir, defaultConfigDir: fakeHomeClaude, identity }).list()
    expect(calls.map((c) => c.env.CLAUDE_CONFIG_DIR ?? null).sort()).toEqual([dir, null].sort())
    for (const c of calls) expect(c.args).toEqual(['auth', 'status', '--json'])
  })
})

describe('AccountsService.create', () => {
  it("creates the directory as 0700 and returns the login command for the owner's terminal", () => {
    const r = svc().create('work')
    expect(r.configDir).toBe(join(dataDir, 'claude-accounts', 'work'))
    expect(r.command).toBe(`CLAUDE_CONFIG_DIR=${r.configDir} claude auth login`)
    expect(statSync(r.configDir).mode & 0o777).toBe(0o700)
  })

  it('rejects invalid names, the reserved "default", and duplicates', () => {
    const s = svc()
    expect(() => s.create('With Uppercase')).toThrow('invalid name')
    expect(() => s.create('default')).toThrow('reserved')
    s.create('two')
    expect(() => s.create('two')).toThrow('already exists')
  })
})

describe('AccountsService.verify', () => {
  it('reports logged-in and email once the login has happened — fresh, never a kept answer', async () => {
    const s = svc()
    const { configDir } = s.create('alt')
    expect(await s.verify('alt')).toMatchObject({ loggedIn: false })
    fakeSignIn(configDir, { email: 'alt@test.dev', subscriptionType: 'pro' })
    expect(await s.verify('alt')).toMatchObject({ loggedIn: true, email: 'alt@test.dev', plan: 'Pro' })
  })

  it('a nonexistent account throws', async () => {
    await expect(svc().verify('nothing')).rejects.toThrow('account not found')
  })
})

// Shared transcripts: an account's config dir points projects/, sessions/
// and plugins/ at the machine account's, so whatever claude writes under
// CLAUDE_CONFIG_DIR=<account> lands where the index, the console's lock
// scan and --resume already look. Credentials stay the account's own
// (refresh tokens rotate; a shared credentials file breaks the others).
describe('AccountsService — shared transcripts (symlinked projects/sessions/plugins)', () => {
  const SHARED = ['projects', 'sessions', 'plugins'] as const

  it('create() links the three dirs to the machine account (creating the targets if missing)', async () => {
    const { configDir } = svc().create('alt')
    for (const d of SHARED) {
      expect(lstatSync(join(configDir, d)).isSymbolicLink()).toBe(true)
      expect(readlinkSync(join(configDir, d))).toBe(join(fakeHomeClaude, d))
      expect(existsSync(join(fakeHomeClaude, d))).toBe(true)
    }
    expect((await svc().verify('alt')).shared).toBe(true)
  })

  it('list() adds the links to an account created before this existed, idempotently, and reports shared: true', async () => {
    const dir = join(dataDir, 'claude-accounts', 'old')
    mkdirSync(dir, { recursive: true })
    const first = await svc().list()
    expect(first[1]).toMatchObject({ name: 'old', shared: true })
    for (const d of SHARED) expect(lstatSync(join(dir, d)).isSymbolicLink()).toBe(true)
    const second = await svc().list() // nothing to redo, nothing thrown
    expect(second[1]).toMatchObject({ name: 'old', shared: true })
  })

  it('a real projects/ dir WITH transcripts is never replaced — shared: false and the dir stays', async () => {
    const dir = join(dataDir, 'claude-accounts', 'own')
    mkdirSync(join(dir, 'projects', '-x'), { recursive: true })
    writeFileSync(join(dir, 'projects', '-x', 's.jsonl'), '{}')
    const a = await svc().list()
    expect(a[1]).toMatchObject({ name: 'own', shared: false })
    expect(lstatSync(join(dir, 'projects')).isSymbolicLink()).toBe(false)
    expect(existsSync(join(dir, 'projects', '-x', 's.jsonl'))).toBe(true)
  })

  it('an EMPTY real projects/ dir (claude created it, nothing inside) is replaced by the link', async () => {
    const dir = join(dataDir, 'claude-accounts', 'fresh')
    mkdirSync(join(dir, 'projects'), { recursive: true })
    const a = await svc().list()
    expect(a[1]).toMatchObject({ name: 'fresh', shared: true })
    expect(lstatSync(join(dir, 'projects')).isSymbolicLink()).toBe(true)
  })

  it("output-styles follows the operator's dir only when it exists — never created in ~/.claude, never deciding shared", async () => {
    const dir = join(dataDir, 'claude-accounts', 'styl')
    mkdirSync(dir, { recursive: true })
    expect((await svc().list())[1]).toMatchObject({ name: 'styl', shared: true })
    expect(existsSync(join(fakeHomeClaude, 'output-styles'))).toBe(false)
    expect(existsSync(join(dir, 'output-styles'))).toBe(false)
    mkdirSync(join(fakeHomeClaude, 'output-styles'))
    writeFileSync(join(fakeHomeClaude, 'output-styles', 'terse.md'), '---\nname: Terse\n---\nBe brief.')
    svc().follow()
    expect(readlinkSync(join(dir, 'output-styles'))).toBe(join(fakeHomeClaude, 'output-styles'))
    expect(existsSync(join(dir, 'output-styles', 'terse.md'))).toBe(true)
  })

  it("an account's own real output-styles dir is left alone", async () => {
    const dir = join(dataDir, 'claude-accounts', 'mine')
    mkdirSync(join(dir, 'output-styles'), { recursive: true })
    writeFileSync(join(dir, 'output-styles', 'own.md'), 'x')
    mkdirSync(join(fakeHomeClaude, 'output-styles'), { recursive: true })
    expect((await svc().list())[1]).toMatchObject({ name: 'mine', shared: true })
    expect(lstatSync(join(dir, 'output-styles')).isSymbolicLink()).toBe(false)
    expect(existsSync(join(dir, 'output-styles', 'own.md'))).toBe(true)
  })

  it("the machine's personal rules are followed like its CLAUDE.md — an account's own rules dir is left alone", async () => {
    mkdirSync(join(fakeHomeClaude, 'rules'), { recursive: true })
    writeFileSync(join(fakeHomeClaude, 'rules', 'style.md'), '# always')
    const follows = join(dataDir, 'claude-accounts', 'rul')
    mkdirSync(follows, { recursive: true })
    const own = join(dataDir, 'claude-accounts', 'own')
    mkdirSync(join(own, 'rules'), { recursive: true })
    writeFileSync(join(own, 'rules', 'mine.md'), 'x')
    await svc().list()
    expect(readlinkSync(join(follows, 'rules'))).toBe(join(fakeHomeClaude, 'rules'))
    expect(existsSync(join(follows, 'rules', 'style.md'))).toBe(true)
    expect(lstatSync(join(own, 'rules')).isSymbolicLink()).toBe(false)
    expect(existsSync(join(own, 'rules', 'style.md'))).toBe(false)
  })

  it("an account follows EVERY key of the machine's settings — retention, plugins, hooks, model, effort — and keeps only what the machine doesn't set", async () => {
    const dir = join(dataDir, 'claude-accounts', 'kai')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ model: 'fable', theme: 'dark', cleanupPeriodDays: 30, onlyMine: true }))
    writeFileSync(
      join(fakeHomeClaude, 'settings.json'),
      JSON.stringify({
        model: 'opus',
        theme: 'light',
        cleanupPeriodDays: 180,
        effortLevel: 'high',
        enabledPlugins: { 'stripe@official': true, 'github@official': false },
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/x/session-start.sh' }] }] },
      }),
    )
    svc().follow()
    const own = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    expect(own).toEqual({
      model: 'opus',
      theme: 'light',
      cleanupPeriodDays: 180,
      effortLevel: 'high',
      onlyMine: true,
      enabledPlugins: { 'stripe@official': true, 'github@official': false },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/x/session-start.sh' }] }] },
    })
    // idempotent: a second look writes nothing new
    const before = statSync(join(dir, 'settings.json')).mtimeMs
    svc().follow()
    expect(statSync(join(dir, 'settings.json')).mtimeMs).toBe(before)
  })

  it('a key the machine DROPS leaves the account too — but only when the account still holds the copy Silos wrote', async () => {
    const dir = join(dataDir, 'claude-accounts', 'drop')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(fakeHomeClaude, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [] }, statusLine: { type: 'command', command: 'x' } }))
    svc().follow()
    // the account changes statusLine on its own; then the machine drops both keys
    const own = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ ...own, statusLine: { type: 'command', command: 'mine' } }))
    writeFileSync(join(fakeHomeClaude, 'settings.json'), JSON.stringify({}))
    svc().follow()
    const after = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    expect(after.hooks).toBeUndefined()
    expect(after.statusLine).toEqual({ type: 'command', command: 'mine' })
  })

  it("the machine's credentials and endpoint never follow through env — the account stays its own login", async () => {
    const dir = join(dataDir, 'claude-accounts', 'envs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(fakeHomeClaude, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://gw', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } }),
    )
    svc().follow()
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).env).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' })
  })

  it('an account settings.json that does not parse is never clobbered', async () => {
    const dir = join(dataDir, 'claude-accounts', 'broken')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'settings.json'), '{ not json')
    writeFileSync(join(fakeHomeClaude, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 180 }))
    mkdirSync(join(dataDir, 'claude-accounts', 'fine'), { recursive: true })
    // the follow answers who followed — and names the one that did not (never in silence)
    expect(svc().follow()).toEqual([
      { name: 'broken', followed: false, why: 'account-unreadable', file: join(dir, 'settings.json') },
      { name: 'fine', followed: true },
    ])
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe('{ not json')
    // the machine's own file unreadable: nobody is known to follow
    writeFileSync(join(fakeHomeClaude, 'settings.json'), '[1]')
    expect(
      svc()
        .follow()
        .map((f) => f.followed),
    ).toEqual([false, false])
  })

  it("personal skills are linked one by one — never synced, never over the account's own, gone ones unlinked", async () => {
    const dir = join(dataDir, 'claude-accounts', 'sk')
    mkdirSync(join(dir, 'skills', 'synced'), { recursive: true })
    mkdirSync(join(dir, 'skills', 'mine'), { recursive: true })
    for (const n of ['vps-ssh', 'mine', 'synced']) mkdirSync(join(fakeHomeClaude, 'skills', n), { recursive: true })
    svc().follow()
    expect(readlinkSync(join(dir, 'skills', 'vps-ssh'))).toBe(join(fakeHomeClaude, 'skills', 'vps-ssh'))
    expect(lstatSync(join(dir, 'skills', 'mine')).isSymbolicLink()).toBe(false)
    expect(lstatSync(join(dir, 'skills', 'synced')).isSymbolicLink()).toBe(false)
    rmSync(join(fakeHomeClaude, 'skills', 'vps-ssh'), { recursive: true })
    svc().follow()
    expect(existsSync(join(dir, 'skills', 'vps-ssh'))).toBe(false)
    expect(() => lstatSync(join(dir, 'skills', 'vps-ssh'))).toThrow()
  })

  it("the operator's CLAUDE.md is followed when it exists", async () => {
    const dir = join(dataDir, 'claude-accounts', 'mem')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(fakeHomeClaude, 'CLAUDE.md'), 'be kind')
    svc().follow()
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('be kind')
  })

  it('the machine account itself is shared by definition', async () => {
    expect((await svc().list())[0]).toMatchObject({ name: 'default', shared: true })
  })
})
