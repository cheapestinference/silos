// harness-conformance.test.ts — the same assertions over every harness
// Silos runs: what a harness declares (caps, traits, providers,
// ui facts), what its console launch may carry (never a provider key or a
// password in argv; env names shell-safe), and what its session reader
// promises the one SessionIndex (disjoint ids, metas stamped with their
// harness, one 'removed' per remove).
//
// Registry-driven: every ./conformance/*.fixture.ts is one harness (Claude
// Code's ClaudeReader over a JSONL fixture, OpenCode's OpenCodeReader over
// a throwaway DB, the test-only fake third harness's in-memory reader), each
// joined to a SessionIndex the way index.ts does. The fake is registered for
// this file only (beforeAll/afterAll). Nothing real is spawned.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { harnesses, harnessForId, registerHarness, registeredHarnesses } from '../src/harnesses/index.js'
import {
  isFileBacked,
  type ChatTurnHooks,
  type HarnessCaps,
  type HarnessId,
  type HarnessUiFacts,
  type LaunchSpec,
  type ServerHookContext,
} from '../src/harnesses/contract.js'
import type { ChatEvent } from '../src/chat-types.js'
import type { ServerDeps } from '../src/server.js'
import type { PrefsStore } from '../src/prefs-store.js'
import type { TerminalService } from '../src/terminal-service.js'
import type { Agent } from '../src/types.js'
import { fakeHarness, makeFakeHarness } from './fixtures/fake-harness.js'
import { folderLoads, type FolderLoadsDeps } from '../src/folder-loads.js'
import { ToolHealthLedger } from '../src/tool-health.js'
import { KEY, runCleanups, type ConformanceFixture } from './conformance/contract.js'

const modules = import.meta.glob<{ fixture: ConformanceFixture }>('./conformance/*.fixture.ts', { eager: true })
const fixtures: ConformanceFixture[] = Object.keys(modules)
  .sort()
  .map((p) => modules[p]!.fixture)
const byId: [HarnessId, ConformanceFixture][] = fixtures.map((f) => [f.harness.id, f])

let unregisterFake: () => void = () => {}
beforeAll(() => {
  unregisterFake = registerHarness(fakeHarness)
})
afterAll(() => unregisterFake())

const CAPS: (keyof HarnessCaps)[] = ['compaction', 'subagents', 'skills', 'thinking', 'costFromHarness', 'permissionsAsEvents', 'sendToConsole', 'outputStyles']
const UI_KEYS: (keyof HarnessUiFacts)[] = [
  'contextPercent',
  'models',
  'ownLogin',
  'territoryFenced',
  'territoryNote',
  'settingsAbout',
  'loginImport',
  'providerExport',
]
const PASSWORD = 'pw-conf'
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/

function launchSpec(f: ConformanceFixture): LaunchSpec {
  const h = f.harness.id
  return {
    agent: { id: 'conf', name: 'Conf', folder: '/p', framework: h } as Agent,
    cwd: '/p',
    key: 'conf-key-1',
    fence: { permissions: { deny: ['Read(//s/**)'], additionalDirectories: ['/st'] } },
    provider: f.provider,
    env: {
      SILOS_PROVIDER_KEY: KEY,
      OPENCODE_SERVER_PASSWORD: PASSWORD,
      // what the console route always hands an OpenCode launch (harnesses/opencode/index.ts)
      OPENCODE_DB: '/d/agents/conf/opencode.db',
      OPENCODE_CONFIG_CONTENT: '{}',
      SILOS_API: 'http://127.0.0.1:3210',
      SILOS_AGENT_ID: 'conf',
    },
    port: 47123,
  }
}

// what buildServer hands Harness.server — only to see which hooks a harness declares
const hookContext = (): ServerHookContext => ({
  deps: {} as ServerDeps,
  options: undefined,
  helpers: { consoleKeyFor: (m) => m.id, classifyAgentId: () => '', freshConsoles: new Map(), prefs: {} as PrefsStore, terminals: {} as TerminalService },
})

describe.each(byId)('harness %s', (id, f) => {
  const h = f.harness

  it('is registered under its id', () => {
    expect(h.id).toBe(id)
    expect(harnesses[id]).toBe(h)
    expect(h.label).not.toBe('')
  })

  it('declares all 8 caps as booleans', () => {
    expect(Object.keys(h.caps).sort()).toEqual([...CAPS].sort())
    for (const c of CAPS) expect(typeof h.caps[c]).toBe('boolean')
  })

  it('caps.outputStyles and the style lister come together; a style rides the console only where the cap says so', () => {
    expect(typeof h.outputStyles === 'function').toBe(h.caps.outputStyles)
    const argv = h.console.command({ ...launchSpec(f), outputStyle: 'Explanatory' }).join('\u0000')
    if (!h.caps.outputStyles) expect(argv).not.toContain('Explanatory')
  })

  it("a new console's argv carries neither the provider key nor the server password", () => {
    const argv = h.console.command(launchSpec(f))
    expect(argv.length).toBeGreaterThan(0)
    const joined = argv.join('\u0000')
    expect(joined).not.toContain(KEY)
    expect(joined).not.toContain(PASSWORD)
    // and a resume neither
    expect(h.console.command({ ...launchSpec(f), resumeId: f.resumeId }).join('\u0000')).not.toContain(KEY)
  })

  it('console env names are shell-safe', () => {
    const env = h.console.env(launchSpec(f))
    for (const k of Object.keys(env)) expect(k).toMatch(ENV_NAME)
  })

  it('a non-fallback console whose id Silos chooses is born under an id it owns', () => {
    if (h.fallback || h.console.idDiscovery !== 'silos-chosen') return
    expect(h.console.newSessionId).toBeTypeOf('function')
    expect(harnessForId(h.console.newSessionId!())).toBe(id)
  })

  it("deletion 'trash' only over a file-backed reader, and only on the fallback", () => {
    if (h.traits.deletion === 'trash') {
      expect(f.fileBacked).toBe(true)
      // the trash route moves files under the fallback's root (SessionStore,
      // holder scan, lineage); registerHarness refuses it elsewhere too
      expect(h.fallback, `${id} declares deletion 'trash' but is not the fallback — use 'hide'`).toBe(true)
    }
  })

  it('a harness whose permissions arrive as events answers them itself', () => {
    if (h.caps.permissionsAsEvents) expect(h.server?.(hookContext()).answer).toBeTypeOf('function')
  })

  it('a harness whose console pins the model reads its own model ids into a pin', () => {
    // pin-follower.ts asks the engine (requestedModelPin), never one dialect for all
    if (h.traits.consolePinsModel) expect(h.requestedModelPin).toBeTypeOf('function')
  })

  it('names at least one provider kind it can run', () => {
    expect(h.providers.kinds.length).toBeGreaterThan(0)
  })

  it('declares every UI fact', () => {
    for (const k of UI_KEYS) expect(Object.hasOwn(h.ui, k)).toBe(true)
  })

  it('its model catalogue file is relative to the data dir', () => {
    if (h.models) expect(isAbsolute(h.models.file)).toBe(false)
  })

  if (f.headless) {
    const make = f.headless.bind(f)
    it('every event a turn yields is emitted to hooks.emit too, in order', async () => {
      const emitted: [string, ChatEvent][] = []
      const hooks: ChatTurnHooks = {
        providerFor: () => ({ provider: null, onFallback: null }),
        appendFor: () => '',
        onRateLimit: () => {},
        onErrorText: () => {},
        emit: (agentId, ev) => {
          emitted.push([agentId, ev])
        },
      }
      const { engine, agent, input } = make(hooks)
      const yielded: ChatEvent[] = []
      for await (const ev of engine.send(agent, input)) yielded.push(ev)
      expect(yielded.length).toBeGreaterThan(0)
      expect(emitted.map(([, ev]) => ev)).toEqual(yielded)
      for (const [agentId] of emitted) expect(agentId).toBe(agent.id)
    })
  }
})

it('exactly one registered harness is the fallback', () => {
  expect(registeredHarnesses().filter((h) => h.fallback).length).toBe(1)
})

it("no two non-fallback harnesses claim the same id (every fixture's sampleId)", () => {
  for (const f of fixtures) {
    const claimants = registeredHarnesses().filter((h) => !h.fallback && h.ownsId?.(f.sampleId))
    expect(claimants.length).toBeLessThanOrEqual(1)
  }
})

// ---- instructions: the list Memory draws and writes are judged against -----
// (spec memory-places T2/T3) — every engine that declares it answers rows
// with origin, reach, when and weight; listing writes nothing; a path it
// does not list is never read through it; an editable row lies inside the
// folder, a login dir or the projects root, and says nothing read-only

/** Every file under `dir` with its bytes — a listing must leave it as it was. */
function snapshot(dir: string): string {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out.push(`${p}:${readFileSync(p, 'utf8')}`)
    }
  }
  walk(dir)
  return out.sort().join('\n')
}

describe.each(byId.filter(([, f]) => f.harness.instructions !== undefined))('instructions %s', (_id, f) => {
  it('rows say origin, reach, when and weight; listing writes nothing; an unlisted path is refused', async () => {
    const base = mkdtempSync(join(tmpdir(), 'conf-instr-'))
    const home = join(base, 'home'),
      login = join(home, '.claude'),
      folder = join(base, 'proj')
    for (const [p, text] of [
      [join(folder, 'CLAUDE.md'), 'p'],
      [join(folder, 'AGENTS.md'), 'a'],
      [join(folder, 'CLAUDE.local.md'), 'l'],
      [join(folder, 'web', 'CLAUDE.md'), 'w'],
      [join(login, 'CLAUDE.md'), 'mine'],
      [join(home, '.config', 'opencode', 'AGENTS.md'), 'g'],
    ] as const) {
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, text)
    }
    const before = snapshot(base)
    const input = { folder, home, loginDirs: [login], projectsRoot: join(login, 'projects'), transcripts: [] }
    const list = await f.harness.instructions!.list(input)
    expect(list.rows.length).toBeGreaterThan(0)
    expect(snapshot(base)).toBe(before)
    const roots = [folder, login, join(login, 'projects')]
    for (const r of list.rows) {
      expect(r.origin).toBeTruthy()
      expect(r.reach.launches.length).toBeGreaterThan(0)
      expect(['start', 'on-demand']).toContain(r.when.at)
      expect(['loaded', 'disk']).toContain(r.weight.as)
      if (r.editable) {
        expect(r.readOnly).toBeUndefined()
        expect(roots.some((d) => r.real === d || r.real.startsWith(d + '/'))).toBe(true)
      } else {
        expect(r.readOnly).toBeTruthy()
      }
    }
    for (const p of list.places) expect(roots.some((d) => p.path === d || p.path.startsWith(d + '/'))).toBe(true)
    await expect(f.harness.instructions!.read(input, join(base, 'elsewhere.md'))).rejects.toThrow('not listed')
  })
})

// ---- loads: what an engine does not add, its rows never claim --------------

/** A folder that every engine's inventory has something in (both engines'
 *  project files), one agent of `engine` there, and a status reading that
 *  names every server — folderLoads over it. */
function loadsOf(engine: string, names: string[] = ['github', 'search']): ReturnType<typeof folderLoads> {
  const base = mkdtempSync(join(tmpdir(), 'conf-loads-'))
  const folder = join(base, 'proj'),
    home = join(base, 'home')
  mkdirSync(folder, { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(folder, '.mcp.json'), JSON.stringify({ mcpServers: Object.fromEntries(names.map((n) => [n, { command: 'x' }])) }))
  writeFileSync(join(folder, 'opencode.json'), JSON.stringify({ mcp: Object.fromEntries(names.map((n) => [n, { type: 'local', command: ['x'] }])) }))
  const toolHealth = new ToolHealthLedger(join(base, 'data', 'tool-health'))
  toolHealth.record({
    folder,
    login: null,
    connectorsOn: false,
    servers: names.map((name) => ({ name, status: 'failed' as const, error: 'down', source: 'project' })),
  })
  const deps: FolderLoadsDeps = {
    index: { allSessions: () => [], getContext: () => undefined, hasTranscriptFile: () => false, pathOf: () => '' } as unknown as FolderLoadsDeps['index'],
    registry: { list: () => [{ id: 'conf', name: 'Conf', folder, framework: engine } as Agent] },
    home,
    toolHealth,
  }
  return folderLoads(deps, folder)
}

describe.each(byId.filter(([, f]) => f.harness.loads !== undefined))('loads %s', (id, f) => {
  const l = f.harness.loads!
  const bare = !l.switch && !l.check
  it(`${bare ? 'switches and checks nothing: no switchable row, no reading, no class' : 'says what it adds to its rows'}`, () => {
    const got = loadsOf(id)
    expect(got.rows.length).toBeGreaterThan(0)
    expect(got.engines).toEqual([
      {
        id,
        label: f.harness.label,
        ...(l.readsStatus ? { readsStatus: true } : {}),
        ...(l.switch ? { switches: true } : {}),
        ...(l.check ? { checks: true } : {}),
        ...(l.scopes ? { scopes: l.scopes } : {}),
      },
    ])
    // places (spec scopes §9): a row's lines name only places the engine declares
    if (!l.scopes)
      for (const r of got.rows) {
        expect(r.at).toBeUndefined()
        expect(r.family).toBeUndefined()
      }
    else for (const r of got.rows) for (const line of r.at ?? []) if (line.place !== 'fact') expect(l.scopes.map((s) => s.id)).toContain(line.place)
    if (!l.switch)
      for (const r of got.rows) {
        expect(r.switch).toBeUndefined()
        expect(r.refused).toBeUndefined()
      }
    if (!l.readsStatus) for (const r of got.rows) expect(r.health).toBeUndefined()
    if (bare) {
      expect(l.readsStatus).toBeUndefined()
      expect(l.sends).toBeUndefined()
      // no starting-set class (§8): no Welcome step, no Settings block
      expect((l as unknown as Record<string, unknown>).startingSet).toBeUndefined()
      // a row it cannot switch names the file that decides it
      for (const r of got.rows) expect(r.decidedBy?.file).toBeTruthy()
    }
  })
  // spec scopes §9: an engine declares its places — each row then has ONE
  // line per place it can name (a project line always), a launch place
  // keeps nothing of its own to name (Silos keeps it) and a switch sits
  // only on a place it declares — or it declares none and keeps the single
  // project switch, its rows with no line at all
  it(`${l.scopes ? 'declares its places: one project line per row, launch places kept by Silos' : 'keeps the single switch: no place, no line'}`, () => {
    const got = loadsOf(id)
    if (!l.scopes) {
      for (const r of got.rows) expect(r.at).toBeUndefined()
      return
    }
    const ids = l.scopes.map((s) => s.id)
    expect(ids).toContain('project')
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of l.scopes) if (s.carrier === 'launch') expect(s.keptIn).toBeUndefined()
    for (const r of got.rows) {
      if (!r.at) continue
      expect(r.family).toBeDefined()
      expect(r.at.filter((x) => x.place === 'project')).toHaveLength(1)
      for (const x of r.at) if (x.switch) expect(ids).toContain(x.place)
      // a place's switch exists only on an engine that switches
      if (!l.switch) for (const x of r.at) expect(x.switch).toBeUndefined()
    }
  })
})

it('an engine whose inventory claims a switch or places it does not have gets no switchable row and no line', () => {
  const liar = makeFakeHarness({ id: 'fake-liar', label: 'Liar', prefix: 'fakeliar_' })
  const off = registerHarness({
    ...liar,
    loads: {
      inventory: (input) => ({
        engine: 'Liar',
        folder: input.folder,
        logins: [],
        notes: [],
        rows: [
          {
            key: 'mcp:project:github',
            engine: 'Liar',
            kind: 'mcp',
            name: 'github',
            label: 'github',
            exact: true,
            origin: { owner: 'project', carrier: 'x.json' },
            state: 'active',
            switch: { names: ['github'] },
          },
          {
            key: 'mcp:project:search',
            engine: 'Liar',
            kind: 'mcp',
            name: 'search',
            label: 'search',
            exact: true,
            origin: { owner: 'project', carrier: 'x.json' },
            state: 'active',
            refused: { why: 'home' },
            family: 'off-only',
            at: [{ place: 'project', result: 'on' }],
          },
        ],
      }),
    },
  })
  try {
    const got = loadsOf('fake-liar')
    expect(got.rows.map((r) => r.key).sort()).toEqual(['mcp:project:github', 'mcp:project:search'])
    for (const r of got.rows) {
      expect(r.switch).toBeUndefined()
      expect(r.refused).toBeUndefined()
      expect(r.health).toBeUndefined()
      expect(r.at).toBeUndefined()
      expect(r.family).toBeUndefined()
    }
    expect(got.engines).toEqual([{ id: 'fake-liar', label: 'Liar' }])
  } finally {
    off()
  }
})

// ---- readers -----------------------------------------------------------------

const IDS = fixtures.map((f) => f.sampleId)

afterEach(() => runCleanups())

describe.each(byId)('reader %s', (id, f) => {
  const make = () => f.reader()

  it('ownership of ids is disjoint across harnesses, and agrees with the id router', async () => {
    const r = await make()
    expect(r.harness).toBe(id)
    for (const x of IDS) expect(r.ownsId(x)).toBe(harnessForId(x) === id)
  })

  it('list() after init() returns only metas of its own harness', async () => {
    const r = await make()
    const metas = r.list()
    expect(metas.length).toBeGreaterThan(0)
    for (const m of metas) expect(m.harness).toBe(r.harness)
  })

  it("remove() emits exactly one 'removed'", async () => {
    const r = await make()
    const removed: [string, string][] = []
    r.index.on('removed', (folder: string, sid: string) => removed.push([folder, sid]))
    r.index.remove(r.victim.folder, r.victim.id)
    await new Promise((res) => setTimeout(res, 20)) // a late watcher echo would land here
    expect(removed).toEqual([[r.victim.folder, r.victim.id]])
    expect(r.list().some((m) => m.id === r.victim.id)).toBe(false)
  })
})

// unknownRemove: what remove() of a never-seen id answers — false = "not
// known", the index stays silent; undefined (void) = the reader cannot tell
// (OpenCode hides Silos-side), the index announces once.
describe.each(byId.map(([id, f]) => [id, f, f.fileBacked, f.unknownRemove] as const))(
  'reader %s — optional contract members',
  (id, f, fileBacked, unknownRemove) => {
    const make = () => f.reader()

    it(`remove() of an unknown id answers ${String(unknownRemove)}, and the index emits accordingly`, async () => {
      const r = await make()
      expect(r.harness).toBe(id)
      expect(r.ownsId(r.unknown.id)).toBe(true)
      expect(r.reader.remove(r.unknown.folder, r.unknown.id)).toBe(unknownRemove)
      const removed: string[] = []
      r.index.on('removed', (_f: string, sid: string) => removed.push(sid))
      r.index.remove(r.unknown.folder, r.unknown.id)
      expect(removed).toEqual(unknownRemove === false ? [] : [r.unknown.id])
    })

    it('list() never includes an id the reader calls hidden()', async () => {
      const r = await make()
      for (const m of r.list()) expect(r.reader.hidden?.(m.folder, m.id) ?? false).toBe(false)
      if (r.hiddenOne) {
        expect(r.reader.hidden?.(r.hiddenOne.folder, r.hiddenOne.id)).toBe(true)
        expect(r.reader.getMeta(r.hiddenOne.folder, r.hiddenOne.id)).not.toBeNull()
        expect(r.list().some((m) => m.id === r.hiddenOne!.id)).toBe(false)
        expect(r.index.allSessions().some((m) => m.id === r.hiddenOne!.id)).toBe(false)
      }
    })

    it(`isFileBacked is ${String(fileBacked)} (the routes that need files rely on it)`, async () => {
      const r = await make()
      expect(isFileBacked(r.reader)).toBe(fileBacked)
    })
  },
)

it('every registered harness has a fixture, and every fixture its harness registered', () => {
  expect(Object.keys(harnesses).sort()).toEqual(fixtures.map((f) => f.harness.id).sort())
  for (const f of fixtures) expect(harnesses[f.harness.id]).toBe(f.harness)
  expect(Object.keys(harnesses)).toContain('fake')
})
