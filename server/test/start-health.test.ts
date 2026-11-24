// start-health.test.ts — start notices and counts (spec tools-origin §6,
// T4): a console's start notice (the sign-in tool pair) and a chat's
// (needsAuthMcpServers) give the same notice once the inventory resolves
// names; counts prefer status readings and fall back to notices, saying
// which; a failing run's first date holds past the readings' cap; an
// account row counts only its own login; a trashed conversation is not
// counted; a cache of the previous version is re-parsed so every
// conversation gets its notice. Temp dirs only — generic fixtures.
import { describe, expect, it, beforeEach } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextAccumulator } from '../src/harnesses/claude-code/context.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { claudeLoadsInventory } from '../src/harnesses/claude-code/loads/inventory.js'
import type { LoadsInput, LoadsNotice, LoadsRow, ResolvedNotice, TurnToolStatus } from '../src/harnesses/contract.js'
import { ToolHealthLedger, READINGS_PER_LOGIN } from '../src/tool-health.js'
import { healthOfRows } from '../src/start-health.js'
import { folderLoads } from '../src/folder-loads.js'
import type { SessionContext, SessionMeta, StartNotice } from '../src/types.js'

const EMAIL = 'sam@example.com'
const OTHER = 'kim@example.com'
const FIGMA = 'plugin:design:figma'
const SKETCH = 'plugin:design:sketch'

const write = (path: string, text: string): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}
const json = (path: string, v: unknown): void => write(path, JSON.stringify(v))
const lines = (...recs: unknown[]): string[] => recs.map((r) => JSON.stringify(r))

let base: string, home: string, folder: string, managed: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'start-health-'))
  home = join(base, 'home')
  folder = join(base, 'proj')
  managed = join(base, 'managed')
  mkdirSync(folder, { recursive: true })
  mkdirSync(managed, { recursive: true })
  // an installed plugin that ships two servers
  const dir = join(base, 'cache', 'design')
  json(join(dir, '.claude-plugin', 'plugin.json'), {
    name: 'design',
    mcpServers: { figma: { type: 'http', url: 'https://figma.example.com/mcp' }, sketch: { type: 'http', url: 'https://sketch.example.com/mcp' } },
  })
  json(join(home, '.claude', 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: { 'design@market': [{ scope: 'user', installPath: dir, version: '1.0.0' }] },
  })
})

const input = (over: Partial<LoadsInput> = {}): LoadsInput => ({
  folder,
  home,
  managedDir: managed,
  recentTranscripts: [],
  seenToolIds: [],
  readings: [],
  ...over,
})
const FAIL = { name: SKETCH, error: 'Dynamic Client Registration rejected (HTTP 403) https://auth.example.com/register?token=abcdef0123456789' }

// the two shapes Claude Code records: a console's start and a chat's
const consoleStart = (at = '2026-11-03T10:00:00.000Z'): string[] =>
  lines(
    { type: 'user', entrypoint: 'cli', cwd: '/home/user/proj', timestamp: at, message: { role: 'user', content: 'hi' } },
    {
      type: 'attachment',
      entrypoint: 'cli',
      timestamp: at,
      attachment: {
        type: 'deferred_tools_delta',
        addedNames: ['Read', 'mcp__plugin_design_figma__authenticate', 'mcp__plugin_design_figma__complete_authentication'],
        failedMcpServers: [FAIL],
        pendingMcpServers: [],
      },
    },
  )
const chatStart = (at = '2026-11-03T10:00:00.000Z'): string[] =>
  lines(
    { type: 'user', entrypoint: 'sdk-ts', cwd: '/home/user/proj', timestamp: at, message: { role: 'user', content: 'hi' } },
    {
      type: 'attachment',
      entrypoint: 'sdk-ts',
      timestamp: at,
      attachment: { type: 'deferred_tools_delta', addedNames: ['Read'], needsAuthMcpServers: [FIGMA], failedMcpServers: [FAIL], pendingMcpServers: [] },
    },
  )
const noticeOf = (ls: string[]): StartNotice => {
  const acc = new ContextAccumulator()
  acc.feedLines(ls)
  return acc.state.start!
}
const asInput = (n: StartNotice, conversation: string, login: string | null, at: number): LoadsNotice => ({
  conversation,
  login,
  at,
  mode: n.mode,
  failed: n.failed,
  needsAuth: n.needsAuth,
  ...(n.needsAuthIds ? { needsAuthIds: n.needsAuthIds } : {}),
})
const servers = (r: ResolvedNotice): ResolvedNotice['servers'] => r.servers.slice().sort((a, b) => a.name.localeCompare(b.name))

describe('start notices', () => {
  it('a console (the sign-in tool pair) and a chat (needsAuthMcpServers) give the same notice', () => {
    const c = noticeOf(consoleStart())
    const s = noticeOf(chatStart())
    expect(c.mode).toBe('console')
    expect(s.mode).toBe('chat')
    // the console knows the sign-in only by its tool-name id — kept as is
    expect(c.needsAuth).toEqual([])
    expect(c.needsAuthIds).toEqual(['plugin_design_figma'])
    // the reason is cleaned before it is kept
    expect(c.failed).toEqual([{ name: SKETCH, reason: 'Dynamic Client Registration rejected (HTTP 403) auth.example.com' }])
    const inv = claudeLoadsInventory(input({ notices: [asInput(c, 'c1', EMAIL, 2), asInput(s, 's1', EMAIL, 1)] }))
    const [rc, rs] = inv.notices!
    expect(servers(rc!)).toEqual(servers(rs!))
    expect(servers(rc!)).toEqual([
      { name: FIGMA, status: 'needs-auth' },
      { name: SKETCH, status: 'failed', reason: c.failed[0]!.reason },
    ])
  })

  // a start as Claude Code writes it: its delta, then its initial skill
  // listing, before any reply; mid-conversation deltas come after replies
  const listing = (at: string): string[] =>
    lines({ type: 'attachment', entrypoint: 'cli', timestamp: at, attachment: { type: 'skill_listing', content: '', names: [], isInitial: true } })
  const reply = (at: string): string[] =>
    lines({ type: 'assistant', entrypoint: 'cli', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })
  const delta = (at: string, failed: unknown[]): string[] =>
    lines({ type: 'attachment', entrypoint: 'cli', timestamp: at, attachment: { type: 'deferred_tools_delta', addedNames: [], failedMcpServers: failed } })
  const first = (): string[] => [...consoleStart(), ...listing('2026-11-03T10:00:00.000Z'), ...reply('2026-11-03T10:00:05.000Z')]

  it("a mid-conversation delta does not replace the start's notice", () => {
    const n = noticeOf([...first(), ...delta('2026-11-03T11:00:00.000Z', [])])
    expect(n.failed.map((f) => f.name)).toEqual([SKETCH])
  })

  it('a later start replaces it: its own delta — or, with none, a clean notice (the old failure does not carry over)', () => {
    // restarted, its delta names no failure
    expect(noticeOf([...first(), ...delta('2026-11-04T09:00:00.000Z', []), ...listing('2026-11-04T09:00:00.000Z')]).failed).toEqual([])
    // restarted, no delta at all
    const clean = noticeOf([...first(), ...reply('2026-11-03T12:00:00.000Z'), ...listing('2026-11-04T09:00:00.000Z')])
    expect(clean.failed).toEqual([])
    expect(clean.needsAuthIds).toBeUndefined()
    expect(clean.at).toBe('2026-11-04T09:00:00.000Z')
    // a mid-conversation delta before the restart is not that start's
    expect(
      noticeOf([...first(), ...delta('2026-11-03T11:00:00.000Z', [FAIL]), ...reply('2026-11-03T11:00:05.000Z'), ...listing('2026-11-04T09:00:00.000Z')]).failed,
    ).toEqual([])
    // restarted, and it failed again: the new start's failure
    expect(noticeOf([...first(), ...delta('2026-11-04T09:00:00.000Z', [FAIL]), ...listing('2026-11-04T09:00:00.000Z')]).failed.map((f) => f.name)).toEqual([
      SKETCH,
    ])
  })

  it('an id no known name has stays an id with its row; an id two names share is dropped, never guessed', () => {
    const odd = { failed: [], needsAuth: [], needsAuthIds: ['claude_ai_Calendar', 'plugin_design_a_b'] }
    // two known names with one id: «plugin:design:a b» and «plugin:design:a_b»
    const dir = join(base, 'cache', 'design')
    json(join(dir, '.claude-plugin', 'plugin.json'), { name: 'design', mcpServers: { 'a b': { command: 'x' }, a_b: { command: 'y' } } })
    const inv = claudeLoadsInventory(input({ notices: [{ conversation: 'c1', login: EMAIL, at: 1, mode: 'console', ...odd }] }))
    expect(inv.notices![0]!.servers).toEqual([{ name: 'claude_ai_Calendar', status: 'needs-auth' }])
    expect(inv.rows.find((r) => r.name === 'claude_ai_Calendar')).toMatchObject({ exact: false, observed: { from: 'tool-id' } })
  })

  // the sign-in door is the engine's (loads/sign-in.ts): a connector is
  // connected in claude.ai, never from a conversation; a server known by its
  // exact name gets a console (an SDK chat has no authenticate tool —
  // measured 24-11) whose sentence names it so; a row known only by its
  // tool-name id gets a console with the engine's own menu (/mcp)
  it('each waiting row carries its door: connector → the claude.ai page, exact server → a console naming it, tool-id only → a console with /mcp', () => {
    const n = { failed: [], needsAuth: [FIGMA, 'claude.ai Google Calendar'], needsAuthIds: ['claude_ai_Google_Drive', 'tracker_x'] }
    const inv = claudeLoadsInventory(input({ notices: [{ conversation: 'c1', login: EMAIL, at: 1, mode: 'console', ...n }] }))
    const door = (name: string): LoadsRow['signIn'] => inv.rows.find((r) => r.name === name)!.signIn
    expect(door(FIGMA)).toEqual({ via: 'console', draft: expect.stringContaining(`"${FIGMA}"`) })
    expect((door(FIGMA) as { draft: string }).draft).not.toContain('plugin_design_figma')
    expect(door('claude.ai Google Calendar')).toEqual({ via: 'link', url: 'https://claude.ai/settings/connectors', where: 'claude.ai' })
    expect(door('claude_ai_Google_Drive')).toMatchObject({ via: 'link', url: 'https://claude.ai/settings/connectors' })
    expect(door('tracker_x')).toEqual({ via: 'console', draft: '/mcp', menu: true })
    // a plugin carries none: its servers do
    expect(inv.rows.find((r) => r.kind === 'plugin')!.signIn).toBeUndefined()
  })

  it('a session cache of the previous version is re-parsed: the conversation gets its notice', async () => {
    const root = join(base, 'projects')
    const cache = join(base, 'sessions-cache.json')
    write(join(root, '-home-user-proj', 'c1.jsonl'), consoleStart().join('\n') + '\n')
    const idx = claudeSessionIndex(root, cache)
    await idx.init()
    expect(idx.getContext('-home-user-proj', 'c1')?.start?.needsAuthIds).toEqual(['plugin_design_figma'])
    await idx.flushCache()
    // the same file under the previous version, its context without a notice
    const j = JSON.parse((await import('node:fs')).readFileSync(cache, 'utf8')) as {
      version: number
      files: Record<string, { context?: Partial<SessionContext> }>
    }
    expect(j.version).toBeGreaterThan(47)
    for (const f of Object.values(j.files)) delete f.context?.start
    writeFileSync(cache, JSON.stringify({ ...j, version: 47 }))
    const again = claudeSessionIndex(root, cache)
    await again.init()
    expect(again.getContext('-home-user-proj', 'c1')?.start?.failed.map((f) => f.name)).toEqual([SKETCH])
  })
})

// ---- counts
const row = (rows: LoadsRow[], name: string): LoadsRow => rows.find((r) => r.name === name)!
const resolvedNotice = (
  conversation: string,
  at: number,
  srv: ResolvedNotice['servers'],
  login: string | null = EMAIL,
  mode: 'console' | 'chat' = 'console',
): ResolvedNotice => ({ conversation, login, at, mode, servers: srv })

describe('counts', () => {
  let ledger: ToolHealthLedger, clock: number
  const rec = (conversation: string, srv: TurnToolStatus['servers'], over: Partial<TurnToolStatus> = {}): void => {
    clock += 1000
    ledger.record({ folder, conversation, turnId: `turn-${clock}`, agentId: 'builder', login: EMAIL, via: 'chat', connectorsOn: false, servers: srv, ...over })
  }
  const rows = (notices: ResolvedNotice[] = []): LoadsRow[] =>
    healthOfRows(claudeLoadsInventory(input()).rows, ledger.readings(folder), ledger.runs(folder), notices)
  beforeEach(() => {
    clock = Date.parse('2026-11-03T00:00:00Z')
    ledger = new ToolHealthLedger(join(base, 'data', 'tool-health'), () => clock)
  })

  it('status readings are preferred: the kept run, from readings — and its first date holds past the cap', () => {
    const first = clock + 1000
    for (let i = 0; i < READINGS_PER_LOGIN + 5; i++)
      rec(`c${i}`, [
        { name: SKETCH, status: 'failed', error: 'refused' },
        { name: FIGMA, status: 'connected' },
      ])
    expect(ledger.readings(folder)).toHaveLength(READINGS_PER_LOGIN)
    // a notice says otherwise: readings win
    const r = row(rows([resolvedNotice('n1', clock + 1, [{ name: SKETCH, status: 'needs-auth' }])]), SKETCH)
    expect(r.health).toMatchObject({ status: 'failed', read: { from: 'turn' }, count: { from: 'readings', n: READINGS_PER_LOGIN + 5, since: first } })
    expect(r.health!.count!.of).toBeUndefined()
    expect(row(rows(), FIGMA).health?.count).toBeUndefined()
  })

  it("a server failing some of the window's times: «n of the last m», from readings", () => {
    rec('a', [{ name: SKETCH, status: 'failed', error: 'refused' }])
    rec('b', [{ name: SKETCH, status: 'failed', error: 'refused' }])
    rec('c', [{ name: SKETCH, status: 'connected' }])
    expect(row(rows(), SKETCH).health).toMatchObject({ status: 'connected', count: { from: 'readings', n: 2, of: 3 } })
  })

  it('no reading lists it: the notices, said as notices — the run, and whether all were console starts', () => {
    const notices = [
      resolvedNotice('n3', 3000, [
        { name: SKETCH, status: 'failed', reason: 'refused' },
        { name: FIGMA, status: 'needs-auth' },
      ]),
      resolvedNotice('n2', 2000, [{ name: SKETCH, status: 'failed', reason: 'refused' }]),
      resolvedNotice('n1', 1000, []),
    ]
    const rs = rows(notices)
    expect(row(rs, SKETCH).health).toMatchObject({
      status: 'failed',
      reason: 'refused',
      read: { from: 'notice', at: 3000, mode: 'console' },
      count: { from: 'notices', n: 2, since: 2000, consoles: true },
    })
    expect(row(rs, FIGMA).health).toMatchObject({ status: 'needs-auth', read: { from: 'notice' } })
    // a chat among them: not «console starts»
    const mixed = rows([resolvedNotice('n4', 4000, [{ name: SKETCH, status: 'failed' }], EMAIL, 'chat'), ...notices])
    expect(row(mixed, SKETCH).health!.count).toMatchObject({ from: 'notices', n: 3, since: 2000 })
    expect(row(mixed, SKETCH).health!.count!.consoles).toBeUndefined()
    // the newest notice no longer names it: no health, nothing claimed
    expect(row(rows([resolvedNotice('n5', 5000, []), ...notices]), SKETCH).health).toBeUndefined()
  })

  it('a Claude account row counts only the readings and notices of its own login', () => {
    // a connector row, on EMAIL
    const conn = 'claude.ai Calendar'
    rec('a', [{ name: conn, status: 'failed', error: 'refused', source: 'claudeai' }], { login: EMAIL })
    rec('b', [{ name: conn, status: 'failed', error: 'refused', source: 'claudeai' }], { login: OTHER })
    rec('c', [{ name: conn, status: 'failed', error: 'refused', source: 'claudeai' }], { login: OTHER })
    const inv = claudeLoadsInventory(
      input({
        readings: ledger.readings(folder).map((r) => ({
          at: r.at,
          login: r.login,
          servers: r.servers.map((s) => ({ name: s.name, status: s.status, ...(s.source ? { source: s.source } : {}) })),
        })),
      }),
    )
    const out = healthOfRows(inv.rows, ledger.readings(folder), ledger.runs(folder), [])
    const mine = out.find((r) => r.kind === 'connector' && r.origin.login === EMAIL)!
    const theirs = out.find((r) => r.kind === 'connector' && r.origin.login === OTHER)!
    expect(mine.health!.count).toMatchObject({ from: 'readings', n: 1 })
    expect(theirs.health!.count).toMatchObject({ from: 'readings', n: 2 })
    // notices on another login are not counted for an account row
    const nrows = healthOfRows(
      claudeLoadsInventory(
        input({ notices: [{ conversation: 'x', login: OTHER, at: 9, mode: 'console', failed: [{ name: conn, reason: '' }], needsAuth: [] }] }),
      ).rows,
      [],
      [],
      [resolvedNotice('x', 9, [{ name: conn, status: 'failed' }], OTHER)],
    )
    const observed = nrows.find((r) => r.name === conn)!
    expect(observed.origin.login).toBe(OTHER)
    expect(observed.health?.count).toMatchObject({ n: 1 })
    const { health: _h, ...bare } = observed
    void _h
    const onEmail = healthOfRows(
      [{ ...bare, key: 'connector:mine', origin: { ...observed.origin, login: EMAIL } }],
      [],
      [],
      [resolvedNotice('x', 9, [{ name: conn, status: 'failed' }], OTHER)],
    )
    expect(onEmail[0]!.health).toBeUndefined()
  })

  it('placeholders are never counted', () => {
    const dir = join(base, 'cache', 'design')
    json(join(dir, '.claude-plugin', 'plugin.json'), {
      name: 'design',
      mcpServers: { mail: { type: 'http', url: '' }, sketch: { type: 'http', url: 'https://sketch.example.com/mcp' } },
    })
    rec('a', [{ name: 'plugin:design:mail', status: 'failed', error: 'No URL configured for this server', noAddress: true }])
    const r = row(rows([resolvedNotice('n', 1, [{ name: 'plugin:design:mail', status: 'failed' }])]), 'plugin:design:mail')
    expect(r.placeholder).toBeDefined()
    expect(r.health).toBeUndefined()
  })

  it('a trashed conversation is not counted: its reading leaves the window, what it gave the run leaves the run', () => {
    rec('a', [{ name: SKETCH, status: 'failed', error: 'refused' }])
    rec('b', [{ name: SKETCH, status: 'failed', error: 'refused' }])
    rec('b', [{ name: SKETCH, status: 'failed', error: 'refused' }])
    expect(row(rows(), SKETCH).health!.count).toMatchObject({ n: 3 })
    ledger.forget('b', folder)
    expect(ledger.readings(folder).map((r) => r.conversation)).toEqual(['a'])
    expect(row(rows(), SKETCH).health!.count).toMatchObject({ n: 1 })
    ledger.forget('a')
    expect(ledger.runs(folder)).toEqual([])
    expect(row(rows(), SKETCH).health).toBeUndefined()
  })
})

describe('the folder: notices from the listed conversations only', () => {
  it('a conversation the index no longer lists (trashed) gives no notice; the basis says what health rests on', () => {
    const ctx = (n: StartNotice): SessionContext => ({ flags: { accountEmail: EMAIL }, tools: [], start: n }) as unknown as SessionContext
    const metas: SessionMeta[] = [
      { id: 'c2', folder: '-home-user-proj', cwd: folder, mtime: 2000 } as SessionMeta,
      { id: 'c1', folder: '-home-user-proj', cwd: folder, mtime: 1000 } as SessionMeta,
    ]
    const contexts = new Map([
      ['c2', ctx(noticeOf(consoleStart('2026-11-03T10:00:00.000Z')))],
      ['c1', ctx(noticeOf(consoleStart('2026-11-02T10:00:00.000Z')))],
    ])
    const index = {
      allSessions: () => metas,
      getContext: (_f: string, id: string) => contexts.get(id) ?? null,
      hasTranscriptFile: () => false,
      pathOf: () => '',
    }
    const registry = { list: () => [] }
    const loads = (): ReturnType<typeof folderLoads> => folderLoads({ index, registry, home, managedDir: managed }, folder)
    let out = loads()
    expect(out.basis).toEqual({ readings: 0, notices: 2, consoles: 2 })
    expect(row(out.rows, SKETCH).health).toMatchObject({ read: { from: 'notice' }, count: { from: 'notices', n: 2, consoles: true } })
    expect(row(out.rows, FIGMA).health).toMatchObject({ status: 'needs-auth' })
    metas.splice(0, 1) // c2 trashed: the index lists it no more
    out = loads()
    expect(out.basis.notices).toBe(1)
    expect(row(out.rows, SKETCH).health!.count).toMatchObject({ n: 1 })
  })
})
