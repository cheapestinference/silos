// switch-proof.test.ts — «a switch proves itself» (spec tools-origin §7
// «Proof», T13): a reading taken after the switch file changed that still
// lists a held thing marks its row; one before it does not (nor one whose
// process started before it); a thing listed as `disabled` does not; a
// check counts as a reading; a held plugin is proven by its servers; a
// hand edit after Silos' own switch falls back to the file's mtime; an
// account row counts only its login's readings. Through the real chain —
// the engine's inventory, the one writer, the ledger, folderLoads. Temp
// dirs only — generic fixtures.
import { describe, expect, it, beforeEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LoadsRow, TurnToolStatusServer } from '../src/harnesses/contract.js'
import { ToolHealthLedger, withHealth } from '../src/tool-health.js'
import { folderLoads, switchFolderLoad, switchFolderOrigin, type FolderLoadsDeps } from '../src/folder-loads.js'
import { changedAtOf, instructionEntryState, withPlaceProof, withProof } from '../src/switch-proof.js'
import { folderInstructionPlaces, switchFolderInstruction } from '../src/folder-instruction-places.js'
import { LoadsScopesStore } from '../src/loads-scopes.js'

const EMAIL = 'sam@example.com'
const OTHER = 'kim@example.com'
const write = (path: string, v: unknown): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, typeof v === 'string' ? v : JSON.stringify(v))
}

let base: string, home: string, folder: string, ledger: ToolHealthLedger, deps: FolderLoadsDeps
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'switch-proof-'))
  home = join(base, 'home')
  folder = join(base, 'proj')
  const managed = join(base, 'managed')
  mkdirSync(managed, { recursive: true })
  write(join(folder, '.mcp.json'), { mcpServers: { github: { type: 'http', url: 'https://gh.example.com/mcp' } } })
  const dir = join(base, 'cache', 'design')
  write(join(dir, '.claude-plugin', 'plugin.json'), { name: 'design', mcpServers: { figma: { type: 'http', url: 'https://figma.example.com/mcp' } } })
  write(join(home, '.claude', 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: { 'design@market': [{ scope: 'user', installPath: dir, version: '1.0.0' }] },
  })
  ledger = new ToolHealthLedger(join(base, 'data', 'tool-health'))
  const index = { allSessions: () => [], getContext: () => null, hasTranscriptFile: () => false, pathOf: () => '' }
  deps = { index, registry: { list: () => [] }, home, managedDir: managed, toolHealth: ledger }
})

const rows = (): LoadsRow[] => folderLoads(deps, folder).rows
const row = (key: string): LoadsRow => {
  const r = rows().find((x) => x.key === key)
  if (!r) throw new Error(`no row ${key}`)
  return r
}
const fileAt = (): number => statSync(join(folder, '.claude', 'settings.local.json')).mtimeMs
let n = 0
const read = (
  servers: TurnToolStatusServer[],
  at: number,
  over: { started?: number; from?: 'turn' | 'check'; login?: string | null; connectorsOn?: boolean } = {},
): void => {
  ledger.record({
    folder,
    conversation: over.from === 'check' ? undefined : `c${++n}`,
    login: over.login ?? null,
    connectorsOn: over.connectorsOn ?? false,
    servers,
    at,
    from: over.from ?? 'turn',
    ...(over.started !== undefined ? { started: over.started } : {}),
    agentId: 'builder',
    via: 'chat',
  })
}

describe('a switch proves itself', () => {
  it('a reading after the switch that still lists the held server marks its row; one before it does not', () => {
    switchFolderLoad(deps, folder, 'mcp:project:github', 'off')
    const t = fileAt()
    read([{ name: 'github', status: 'connected' }], t - 60_000)
    expect(row('mcp:project:github').state).toBe('held')
    expect(row('mcp:project:github').proof).toBeUndefined()
    read([{ name: 'github', status: 'connected' }], t + 5_000)
    expect(row('mcp:project:github').proof).toMatchObject({
      name: 'github',
      status: 'connected',
      by: 'item',
      read: { from: 'turn', via: 'chat', agent: 'builder' },
    })
  })

  it('a turn whose process started before the switch is not proof, even read after it', () => {
    switchFolderLoad(deps, folder, 'mcp:project:github', 'off')
    const t = fileAt()
    read([{ name: 'github', status: 'connected' }], t + 5_000, { started: t - 1_000 })
    expect(row('mcp:project:github').proof).toBeUndefined()
  })

  it('a thing listed as disabled is not loaded: no proof', () => {
    switchFolderLoad(deps, folder, 'mcp:project:github', 'off')
    read([{ name: 'github', status: 'disabled' }], fileAt() + 5_000)
    expect(row('mcp:project:github').proof).toBeUndefined()
    // any other status is listed — a failure too
    read([{ name: 'github', status: 'failed', error: 'refused' }], fileAt() + 6_000)
    expect(row('mcp:project:github').proof).toMatchObject({ status: 'failed' })
  })

  it('a check counts as a reading', () => {
    switchFolderLoad(deps, folder, 'mcp:project:github', 'off')
    const t = fileAt()
    read([{ name: 'github', status: 'connected' }], t + 3_000, { from: 'check', started: t + 1_000 })
    expect(row('mcp:project:github').proof).toMatchObject({ read: { from: 'check' } })
  })

  it('a held plugin is proven by a reading that lists one of its servers; the row turned back on has none', () => {
    switchFolderLoad(deps, folder, 'plugin:design@market', 'off')
    read([{ name: 'plugin:design:figma', status: 'needs-auth' }], fileAt() + 5_000)
    expect(row('plugin:design@market').proof).toMatchObject({ name: 'plugin:design:figma', by: 'item' })
    switchFolderLoad(deps, folder, 'plugin:design@market', 'on')
    expect(row('plugin:design@market').proof).toBeUndefined()
  })

  it('a plugin server denied alone is proven by its own name', () => {
    switchFolderLoad(deps, folder, 'server:design@market:figma', 'off')
    read([{ name: 'plugin:design:figma', status: 'connected' }], fileAt() + 5_000)
    expect(row('server:design@market:figma').proof).toMatchObject({ name: 'plugin:design:figma' })
    expect(row('plugin:design@market').proof).toBeUndefined()
  })

  it('the row’s own switch time is used while nothing else wrote the file; a hand edit since falls back to the file’s mtime', () => {
    switchFolderLoad(deps, folder, 'mcp:project:github', 'off')
    const own = ledger.switches(folder)[0]!
    expect(own).toMatchObject({ key: 'mcp:project:github', to: 'off', mtime: fileAt() })
    // a reading after the switch: proof
    read([{ name: 'github', status: 'connected' }], own.at + 10_000)
    expect(row('mcp:project:github').proof).toBeDefined()
    // the record outlives the readings' own writes
    ledger.forget('nobody')
    ledger.forget(`c${n}`, folder)
    expect(ledger.switches(folder)).toEqual([own])
    read([{ name: 'github', status: 'connected' }], own.at + 10_000)
    // the file edited by hand later (another key): only a reading after THAT counts
    const later = new Date(own.at + 20_000)
    utimesSync(join(folder, '.claude', 'settings.local.json'), later, later)
    expect(row('mcp:project:github').proof).toBeUndefined()
    read([{ name: 'github', status: 'connected' }], own.at + 30_000)
    expect(row('mcp:project:github').proof).toBeDefined()
  })

  it('a click that writes nothing keeps no record', () => {
    switchFolderLoad(deps, folder, 'mcp:project:github', 'off')
    const first = ledger.switches(folder)
    switchFolderLoad(deps, folder, 'mcp:project:github', 'off')
    expect(ledger.switches(folder)).toEqual(first)
  })

  it('connectors off by the origin key: a reading on that login that lists one proves it, another login’s does not', () => {
    // a connector the login sends, seen once before the origin went off
    read([{ name: 'claude.ai Gmail', status: 'connected', source: 'claudeai' }], 1_000, { login: EMAIL, connectorsOn: true })
    write(join(folder, '.claude', 'settings.local.json'), { disableClaudeAiConnectors: true })
    const t = fileAt()
    const key = `connector:${EMAIL}:claude.ai Gmail`
    expect(row(key).state).toBe('available')
    expect(row(key).proof).toBeUndefined()
    read([{ name: 'claude.ai Gmail', status: 'connected', source: 'claudeai' }], t + 5_000, { login: OTHER })
    expect(row(key).proof).toBeUndefined()
    read([{ name: 'claude.ai Gmail', status: 'connected', source: 'claudeai' }], t + 6_000, { login: EMAIL })
    expect(row(key).proof).toMatchObject({ by: 'origin', read: { login: EMAIL } })
  })

  it('an origin head records its own switch time, and the rows that origin holds read it', () => {
    read([{ name: 'claude.ai Gmail', status: 'connected', source: 'claudeai' }], 1_000, { login: EMAIL, connectorsOn: true })
    switchFolderOrigin(deps, folder, 'connectors', 'off')
    const own = ledger.switches(folder)[0]!
    expect(own).toMatchObject({ key: 'origin:connectors', to: 'off', mtime: fileAt() })
    const held = row(`connector:${EMAIL}:claude.ai Gmail`)
    expect(held.heldHere).toMatchObject({ by: 'origin' })
    // the head's time, not the file's, while nothing else wrote it since
    expect(changedAtOf(held, own.mtime, [{ ...own, at: own.mtime + 7 }])).toBe(own.mtime + 7)
    expect(changedAtOf(held, own.mtime + 1, [{ ...own, at: own.mtime + 7 }])).toBe(own.mtime + 1)
    read([{ name: 'claude.ai Gmail', status: 'connected', source: 'claudeai' }], own.at + 5_000, { login: EMAIL })
    expect(row(`connector:${EMAIL}:claude.ai Gmail`).proof).toMatchObject({ by: 'origin' })
    // a head click that writes nothing keeps no record
    switchFolderOrigin(deps, folder, 'connectors', 'off')
    expect(ledger.switches(folder)).toEqual([own])
  })
})

// spec scopes §7 «Proof» per place (T12): an agent's entry by that agent's
// readings after the entry's own `at`; the machine's by a reading after the
// user file changed, never where a narrower place turns the thing back; a
// conversation's by its own thread's starts after it; an «on» unproven by a
// reading that lists none of its servers; a holder's reading never marks
// the project's line; a plugin with no server gets nothing.
describe('a switch proves itself, per place', () => {
  let scopes: LoadsScopesStore
  beforeEach(() => {
    write(join(home, '.claude.json'), { mcpServers: { search: { command: 'search-mcp' } } })
    // a plugin with no server
    const bare = join(base, 'cache', 'notes')
    write(join(bare, '.claude-plugin', 'plugin.json'), { name: 'notes' })
    write(join(home, '.claude', 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: {
        'design@market': [{ scope: 'user', installPath: join(base, 'cache', 'design'), version: '1.0.0' }],
        'notes@market': [{ scope: 'user', installPath: bare, version: '1.0.0' }],
      },
    })
    mkdirSync(join(base, 'data'), { recursive: true })
    scopes = new LoadsScopesStore(join(base, 'data'))
    const agents = [
      { id: 'builder', name: 'Builder', folder },
      { id: 'writer', name: 'Writer', folder },
    ] as unknown as ReturnType<FolderLoadsDeps['registry']['list']>
    deps = { ...deps, registry: { list: () => agents }, loadsScopes: scopes }
  })
  const by = (agent: string | null, servers: TurnToolStatusServer[], at: number, over: { started?: number; conversation?: string } = {}): void => {
    ledger.record({
      folder,
      conversation: over.conversation ?? `p${++n}`,
      login: null,
      connectorsOn: false,
      servers,
      at,
      from: 'turn',
      ...(over.started !== undefined ? { started: over.started } : {}),
      ...(agent ? { agentId: agent } : {}),
      via: 'chat',
    })
  }
  const line = (key: string, place: string, agent?: string) => row(key).at?.find((l) => l.place === place && (agent === undefined || l.agent === agent))
  const atOf = (agent: string, key: string): number => scopes.get('agents', agent, 'claude-code')!.at[key]!
  const userFileAt = (): number => statSync(join(home, '.claude', 'settings.json')).mtimeMs

  it('an agent’s «off» is proven only by that agent’s readings started after its own entry — a later click on another row moves nothing', () => {
    switchFolderLoad(deps, folder, 'mcp:project:github', 'off', { scope: 'agent', agent: 'builder' })
    const at = atOf('builder', 'mcp:project:github')
    // another agent's reading, and builder's from a process started before
    by('writer', [{ name: 'github', status: 'connected' }], at + 5_000)
    by('builder', [{ name: 'github', status: 'connected' }], at + 6_000, { started: at - 1 })
    expect(line('mcp:project:github', 'agent', 'builder')?.proof).toBeUndefined()
    by('builder', [{ name: 'github', status: 'connected' }], at + 7_000, { started: at + 1_000 })
    expect(line('mcp:project:github', 'agent', 'builder')?.proof).toMatchObject({ to: 'off', name: 'github', read: { agent: 'builder', agentName: 'Builder' } })
    expect(line('mcp:project:github', 'agent', 'writer')?.proof).toBeUndefined()
    // a click on another row later: this entry keeps its own time, the proof stands
    switchFolderLoad(deps, folder, 'plugin:design@market', 'off', { scope: 'agent', agent: 'builder' })
    expect(atOf('builder', 'mcp:project:github')).toBe(at)
    expect(line('mcp:project:github', 'agent', 'builder')?.proof).toBeDefined()
    // a newer start of builder that no longer lists it: it took
    by('builder', [{ name: 'other', status: 'connected' }], at + 9_000, { started: at + 8_000 })
    expect(line('mcp:project:github', 'agent', 'builder')?.proof).toBeUndefined()
  })

  it('a reading of a holding agent never marks the project’s line', () => {
    switchFolderLoad(deps, folder, 'plugin:design@market', 'off')
    switchFolderLoad(deps, folder, 'plugin:design@market', 'on', { scope: 'agent', agent: 'builder' })
    const at = atOf('builder', 'plugin:design@market')
    by('builder', [{ name: 'plugin:design:figma', status: 'connected' }], at + 5_000, { started: at + 1 })
    expect(row('plugin:design@market').proof).toBeUndefined()
    expect(line('plugin:design@market', 'agent', 'builder')?.proof).toBeUndefined()
    // a reading of an agent that holds nothing still proves the project's
    by('writer', [{ name: 'plugin:design:figma', status: 'connected' }], at + 6_000, { started: at + 2 })
    expect(row('plugin:design@market').proof).toMatchObject({ name: 'plugin:design:figma' })
  })

  it('an agent’s «on» is unproven by a reading that lists none of the plugin’s servers and proven by one that does', () => {
    switchFolderLoad(deps, folder, 'plugin:design@market', 'off')
    switchFolderLoad(deps, folder, 'plugin:design@market', 'on', { scope: 'agent', agent: 'builder' })
    const at = atOf('builder', 'plugin:design@market')
    by('builder', [{ name: 'github', status: 'connected' }], at + 5_000, { started: at + 1 })
    expect(line('plugin:design@market', 'agent', 'builder')?.proof).toEqual(expect.objectContaining({ to: 'on' }))
    expect(line('plugin:design@market', 'agent', 'builder')?.proof?.name).toBeUndefined()
    // listed as disabled is not loaded either
    by('builder', [{ name: 'plugin:design:figma', status: 'disabled' }], at + 6_000, { started: at + 2 })
    expect(line('plugin:design@market', 'agent', 'builder')?.proof).toMatchObject({ to: 'on' })
    by('builder', [{ name: 'plugin:design:figma', status: 'failed', error: 'refused' }], at + 7_000, { started: at + 3 })
    expect(line('plugin:design@market', 'agent', 'builder')?.proof).toBeUndefined()
  })

  it('a machine «off» is proven by a reading after the user file changed — its own switch record timed — never by one taken where a narrower place turns it back on', () => {
    switchFolderLoad(deps, folder, 'plugin:design@market', 'off', { scope: 'machine' })
    const rec = ledger.switches(folder, 'machine')[0]!
    expect(rec).toMatchObject({ key: 'plugin:design@market', to: 'off', mtime: userFileAt() })
    // the folder's own records are untouched: one place, one file
    expect(ledger.switches(folder)).toEqual([])
    // what each place expects is the proof's input, never sent
    expect(rows().some((r) => 'expect' in r)).toBe(false)
    by('writer', [{ name: 'plugin:design:figma', status: 'connected' }], rec.at - 5_000)
    expect(line('plugin:design@market', 'machine')?.proof).toBeUndefined()
    by('writer', [{ name: 'plugin:design:figma', status: 'connected' }], rec.at + 5_000, { started: rec.at + 1 })
    expect(line('plugin:design@market', 'machine')?.proof).toMatchObject({ to: 'off', name: 'plugin:design:figma', read: { agent: 'writer' } })
    // builder turns it back on: builder's readings load it by right
    switchFolderLoad(deps, folder, 'plugin:design@market', 'on', { scope: 'agent', agent: 'builder' })
    const at = atOf('builder', 'plugin:design@market')
    by('writer', [{ name: 'other', status: 'connected' }], at + 10_000, { started: at + 6_000 })
    by('builder', [{ name: 'plugin:design:figma', status: 'connected' }], at + 11_000, { started: at + 6_000 })
    expect(line('plugin:design@market', 'machine')?.proof).toBeUndefined()
    // the project turns it back on: the machine's entry decides nothing here
    switchFolderLoad(deps, folder, 'plugin:design@market', 'on')
    by('writer', [{ name: 'plugin:design:figma', status: 'connected' }], at + 12_000, { started: at + 6_000 })
    expect(line('plugin:design@market', 'machine')?.proof).toBeUndefined()
  })

  it('a machine entry changed by hand since: only a reading after THAT counts (the file’s mtime)', () => {
    switchFolderLoad(deps, folder, 'mcp:user:search', 'off', { scope: 'machine' })
    const rec = ledger.switches(folder, 'machine')[0]!
    by('writer', [{ name: 'search', status: 'connected' }], rec.at + 5_000, { started: rec.at + 1 })
    expect(line('mcp:user:search', 'machine')?.proof).toMatchObject({ to: 'off', name: 'search' })
    const later = new Date(rec.at + 20_000)
    utimesSync(join(home, '.claude', 'settings.json'), later, later)
    expect(line('mcp:user:search', 'machine')?.proof).toBeUndefined()
  })

  it('a conversation’s entry is proven only by its own thread’s starts after it (the thread the server resolves)', () => {
    write(join(base, 'data', 'loads-scopes.json'), {
      agents: {},
      conversations: { t1: { 'claude-code': { entries: { disabledMcpjsonServers: ['github'] }, at: { 'mcp:project:github': 10_000 } } } },
      folders: {},
      undo: {},
    })
    scopes.load()
    const lines = [
      { place: 'project', result: 'on' },
      { place: 'conversation', conversation: 't1', entry: 'off', result: 'off' },
    ] as LoadsRow['at']
    const github: LoadsRow = { ...row('mcp:project:github'), at: lines!, expect: [{ scope: 'conversation', conversation: 't1', to: 'off', names: ['github'] }] }
    const times = {
      machine: () => null,
      agent: () => null,
      conversation: (t: string, k: string) => scopes.get('conversations', t, 'claude-code')?.at[k] ?? null,
    }
    const threadOf = (s: string): string | null => (s === 's1' || s === 's1-resumed' ? 't1' : s)
    const reading = (conversation: string, at: number, started: number) => ({
      at,
      started,
      login: null,
      from: 'turn' as const,
      conversation,
      servers: [{ name: 'github', status: 'connected' as const }],
    })
    const proofOf = (rs: ReturnType<typeof reading>[]) =>
      withPlaceProof([github], rs, [], times, threadOf)[0]!.at!.find((l) => l.place === 'conversation')!.proof
    // another thread, and its own start before the entry: nothing
    expect(proofOf([reading('s2', 20_000, 15_000), reading('s1', 19_000, 9_000)])).toBeUndefined()
    // its resumed session, started after: proven
    expect(proofOf([reading('s1-resumed', 20_000, 15_000)])).toMatchObject({ to: 'off', name: 'github' })
    // a reading of the holding conversation never marks the project's line
    const held: LoadsRow = { ...github, heldHere: { by: 'item', names: ['github'] }, state: 'held' }
    expect(withProof([held], [reading('s1', 20_000, 15_000)], [], 1_000, [], threadOf)[0]!.proof).toBeUndefined()
    expect(withProof([held], [reading('s9', 20_000, 15_000)], [], 1_000, [], threadOf)[0]!.proof).toBeDefined()
    // nor its health: the holding thread's reading is skipped, another's read
    const failing = (conversation: string, at: number) => ({ ...reading(conversation, at, at), servers: [{ name: 'github', status: 'failed' as const }] })
    const heldThread = { ...github, at: lines!.map((l) => (l.place === 'conversation' ? { ...l, conversation: 's1' } : l)) }
    expect(withHealth([heldThread], [failing('s1', 30_000), reading('s2', 20_000, 15_000)])[0]!.health).toMatchObject({ status: 'connected' })
  })

  it('a plugin with no server gets no proof at any place', () => {
    // the machine keeps it off, one agent turns it on: a reading that lists none of its (no) servers proves nothing
    switchFolderLoad(deps, folder, 'plugin:notes@market', 'off', { scope: 'machine' })
    switchFolderLoad(deps, folder, 'plugin:notes@market', 'on', { scope: 'agent', agent: 'builder' })
    by('builder', [{ name: 'github', status: 'connected' }], Date.now() + 60_000, { started: Date.now() + 30_000 })
    expect(row('plugin:notes@market').at?.some((l) => l.proof)).toBe(false)
  })
})

// An instruction file's entry for ONE conversation (spec memory-places §6,
// T5): starts come from start markers only; the replay in force decides.
describe("an instruction file's proof, for one conversation", () => {
  const F = { paths: ['/p/CLAUDE.md'], onDemand: false, exists: true }
  const seen = (inForce: string[], starts: number[] = [], nested: { path: string; at: number }[] = []) => ({ inForce, starts, nested })

  it('no start after the entry is pending — a start before it proves nothing', () => {
    expect(instructionEntryState('off', 100, F, seen(['/p/CLAUDE.md'], [50]))).toEqual({ state: 'pending', since: 100 })
    expect(instructionEntryState('off', 100, F, seen([]), [])).toEqual({ state: 'pending', since: 100 })
  })

  it("a start with no record after the entry: still loaded, never «not read»; the entry's own time decides what counts", () => {
    expect(instructionEntryState('off', 100, F, seen(['/p/CLAUDE.md'], [10, 150]))).toMatchObject({ state: 'didnt-take', read: 150 })
    // the same start from the ledger's marker alone
    expect(instructionEntryState('off', 100, F, seen(['/p/CLAUDE.md'], [10]), [160])).toMatchObject({ state: 'didnt-take', read: 160 })
    // an entry made after that start: pending again
    expect(instructionEntryState('off', 170, F, seen(['/p/CLAUDE.md'], [10]), [160]).state).toBe('pending')
  })

  it('proven by `removed` or a new base without it, and by a fresh conversation with no record', () => {
    expect(instructionEntryState('off', 100, F, seen(['/p/CLAUDE.local.md'], [150]))).toMatchObject({ state: 'in-effect', read: 150 })
    expect(instructionEntryState('off', 100, F, seen([], [150]))).toMatchObject({ state: 'in-effect' })
  })

  it("an on-demand file never «didn't take» from absence — only a load after a start after the entry proves it", () => {
    const N = { paths: ['/p/web/CLAUDE.md'], onDemand: true, exists: true }
    expect(instructionEntryState('off', 100, N, seen([], [150])).state).toBe('pending')
    expect(instructionEntryState('off', 100, N, seen([], [150], [{ path: '/p/web/CLAUDE.md', at: 120 }])).state).toBe('pending')
    expect(instructionEntryState('off', 100, N, seen([], [150], [{ path: '/p/web/CLAUDE.md', at: 170 }]))).toMatchObject({ state: 'didnt-take', read: 170 })
  })

  it('an «on» (auto memory): in force is in effect; absent where there is a file to load did not take', () => {
    const A = { paths: ['/home/user/.claude/projects/k/memory/MEMORY.md'], onDemand: false, exists: true }
    expect(instructionEntryState('on', 100, A, seen(A.paths, [150])).state).toBe('in-effect')
    expect(instructionEntryState('on', 100, A, seen([], [150])).state).toBe('didnt-take')
    expect(instructionEntryState('on', 100, { ...A, exists: false }, seen([], [150])).state).toBe('pending')
  })

  it("end to end: the thread's transcripts through the engine's reader, timed by the entry's own `at`", async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-iproof-'))
    const folder = join(base, 'proj'),
      home = join(base, 'home'),
      data = join(base, 'data')
    for (const d of [join(home, '.claude'), folder, data]) mkdirSync(d, { recursive: true })
    const claude = join(folder, 'CLAUDE.md')
    writeFileSync(claude, '# p\n')
    const store = new LoadsScopesStore(data)
    const line = (o: unknown): string => JSON.stringify(o)
    const iso = (ms: number): string => new Date(ms).toISOString()
    const hook = (ms: number) => line({ type: 'attachment', timestamp: iso(ms), attachment: { type: 'hook_success', hookEvent: 'SessionStart' } })
    const said = (ms: number) => line({ type: 'assistant', timestamp: iso(ms), message: {} })
    const file = join(base, 's1.jsonl'),
      file2 = join(base, 's2.jsonl')
    let second = false
    const index = {
      allSessions: () =>
        [
          { id: 's1', folder: 'k', cwd: folder, mtime: 1 },
          { id: 's2', folder: 'k', cwd: folder, mtime: 2 },
        ] as never,
      hasTranscriptFile: (id: string) => id === 's1' || (id === 's2' && second),
      pathOf: (_f: string, id: string) => (id === 's1' ? file : file2),
    }
    const deps = {
      registry: { list: () => [{ id: 'builder', name: 'Builder', folder }] as never },
      index,
      home,
      loginDirs: () => [join(home, '.claude')],
      projectsRoot: join(home, '.claude', 'projects'),
      managedDir: join(base, 'managed'),
      loadsScopes: store,
    }
    const conv = { thread: 's1', agent: 'builder', sessions: ['s1', 's2'] }
    const here = async () =>
      (await folderInstructionPlaces(deps, folder, { conv })).engines[0]!.rows.find((r) => r.path === claude)!.at.find((l) => l.place === 'conversation')!.here
    const t0 = Date.now() - 60_000
    writeFileSync(
      file,
      [
        hook(t0),
        line({ type: 'attachment', timestamp: iso(t0 + 1), attachment: { type: 'instructions', files: [{ path: claude, type: 'Project', content: 'x' }] } }),
        said(t0 + 2),
      ].join('\n') + '\n',
    )
    await switchFolderInstruction(deps, folder, claude, 'off', { scope: 'conversation', conversation: conv })
    const at = store.get('conversations', 's1', 'claude-code')!.at[`instruction:${claude}`]!
    expect((await here())?.state).toBe('pending')
    // a start after the entry with no record since: nothing changed — still loaded
    writeFileSync(file, readFileSync(file, 'utf8') + [hook(at + 1000), said(at + 1001)].join('\n') + '\n')
    expect((await here())?.state).toBe('didnt-take')
    // the next start records it removed: proven
    writeFileSync(
      file,
      readFileSync(file, 'utf8') +
        line({
          type: 'attachment',
          timestamp: iso(at + 2000),
          attachment: { type: 'instructions', changed: true, reason: 'session_start', files: [], removed: [claude] },
        }) +
        '\n',
    )
    expect((await here())?.state).toBe('in-effect')
    // a later session of the thread that started fresh and loaded nothing: proven too
    writeFileSync(file, readFileSync(file, 'utf8').split('\n').slice(0, 5).join('\n') + '\n')
    second = true
    writeFileSync(file2, [hook(at + 3000), said(at + 3001)].join('\n') + '\n')
    expect((await here())?.state).toBe('in-effect')
  })
})
