// opencode-places.test.ts — OpenCode's places (spec scopes §9, T13): every
// line of «Where it loads» on its rows and its switches. This machine is
// the global file (written only while it is strict JSON, refused and named
// otherwise, only its entry, through a symlink); this project, each agent
// and a conversation are LAUNCH places — the switch hands back a payload,
// writes nothing, and the neutral store keeps it (the project's under
// `folders`). Facts above every line — a managed config, OPENCODE_PERMISSION
// — lock them all. Temp homes only: never the real ~/.config/opencode.
import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { opencodeLoadsInventory, opencodeLoadsSwitch } from '../src/harnesses/opencode/loads.js'
import { switchGlobalMcp } from '../src/harnesses/opencode/global-config.js'
import { LoadsSwitchError, type LoadsCarried, type LoadsInput, type LoadsLine } from '../src/harnesses/contract.js'
import { LoadsScopesStore } from '../src/loads-scopes.js'
import { folderLoads, switchFolderLoad, type FolderLoadsDeps } from '../src/folder-loads.js'
import type { Agent } from '../src/types.js'

let base = '',
  home = '',
  folder = '',
  managed = ''
const env = (): NodeJS.ProcessEnv => ({ OPENCODE_TEST_MANAGED_CONFIG_DIR: managed })
const globalFile = (name = 'opencode.json'): string => join(home, '.config', 'opencode', name)
const write = (p: string, v: unknown): void => {
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v, null, 2))
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'oc-places-'))
  home = join(base, 'home')
  folder = join(base, 'proj')
  managed = join(base, 'managed')
  mkdirSync(home, { recursive: true })
  mkdirSync(folder, { recursive: true })
  write(join(folder, 'opencode.json'), {
    mcp: { github: { type: 'local', command: ['gh-mcp'] }, search: { type: 'remote', url: 'https://search.example.com/mcp' } },
  })
})

const input = (carried?: LoadsCarried): LoadsInput => ({ folder, home, recentTranscripts: [], seenToolIds: [], readings: [], ...(carried ? { carried } : {}) })
const linesOf = (key: string, carried?: LoadsCarried): LoadsLine[] => opencodeLoadsInventory(input(carried), env()).rows.find((r) => r.key === key)!.at!
const brief = (ls: LoadsLine[]): string[] =>
  ls.map(
    (l) =>
      `${l.place}${l.agent ? `:${l.agent}` : ''}${l.fact ? `:${l.fact.who}` : ''} ${l.entry ?? '-'}→${l.result}${l.locked ? ' locked' : ''}${l.switch ? ' ⇄' : ''}`,
  )
const carried = (over: Partial<LoadsCarried> = {}): LoadsCarried => ({
  folder: { payload: null },
  agents: [
    { id: 'builder', payload: null },
    { id: 'writer', payload: null },
  ],
  ...over,
})

describe('the lines — every layer an override, both ways', () => {
  it("machine ‹ the repository's file ‹ this project ‹ each agent; each line its own switch; the project's line kept by Silos", () => {
    write(globalFile(), { mcp: { github: { enabled: false } } })
    expect(brief(linesOf('mcp:project:github', carried()))).toEqual(['machine off→off ⇄', 'project -→off ⇄', 'agent:builder -→off ⇄', 'agent:writer -→off ⇄'])
    const lines = linesOf(
      'mcp:project:github',
      carried({
        folder: { payload: { mcp: { github: { enabled: true } } } },
        agents: [
          { id: 'builder', payload: { mcp: { github: { enabled: false } } } },
          { id: 'writer', payload: null },
        ],
      }),
    )
    expect(brief(lines)).toEqual(['machine off→off ⇄', 'project on→on ⇄', 'agent:builder off→off ⇄', 'agent:writer -→on ⇄'])
    // the machine names its file; a launch place none (Silos keeps it)
    expect(lines.find((l) => l.place === 'machine')?.keptIn).toBe('~/.config/opencode/opencode.json')
    expect(lines.find((l) => l.place === 'project')?.keptIn).toBeUndefined()
    // the repository's file is a fact between them, when it says
    write(join(folder, 'opencode.json'), { mcp: { github: { type: 'local', command: ['gh-mcp'], enabled: true } } })
    expect(brief(linesOf('mcp:project:github', carried()))).toEqual([
      'machine off→off ⇄',
      'fact:repository on→on',
      'project -→on ⇄',
      'agent:builder -→on ⇄',
      'agent:writer -→on ⇄',
    ])
    // a conversation follows the project unless it says
    expect(brief(linesOf('mcp:project:github', carried({ conversation: { id: 'ses_1', payload: { mcp: { github: { enabled: false } } } } }))).at(-1)).toBe(
      'conversation off→off ⇄',
    )
  })

  it("the row: the project's result is its state, its plain switch the project's", () => {
    const inv = opencodeLoadsInventory(input(carried({ folder: { payload: { mcp: { search: { enabled: false } } } } })), env())
    const row = inv.rows.find((r) => r.key === 'mcp:project:search')!
    expect(row).toMatchObject({ state: 'held', family: 'override', switch: { names: ['search'] } })
    expect(row.decidedBy).toBeUndefined()
  })

  it('facts above every line: a managed config and OPENCODE_PERMISSION lock them all — the row names what decides, no switch', () => {
    write(join(managed, 'opencode.json'), { mcp: { github: { enabled: false } } })
    const lines = linesOf('mcp:project:github', carried({ folder: { payload: { mcp: { github: { enabled: true } } } } }))
    expect(brief(lines)).toEqual([
      'fact:organization off→off',
      'machine -→off locked',
      'project on→off locked',
      'agent:builder -→off locked',
      'agent:writer -→off locked',
    ])
    const row = opencodeLoadsInventory(input(carried()), env()).rows.find((r) => r.key === 'mcp:project:github')!
    expect(row.switch).toBeUndefined()
    expect(row.decidedBy).toEqual({ file: `${managed}/opencode.json`, key: 'mcp.github.enabled' })
    expect(() => opencodeLoadsSwitch(input(carried()), 'mcp:project:github', 'on', { scope: 'agent', agent: 'builder', payload: null }, env())).toThrow(
      LoadsSwitchError,
    )
    // the environment over everything: a deny of the server's tools
    const permEnv = { ...env(), OPENCODE_PERMISSION: JSON.stringify({ 'search_*': 'deny' }) }
    const s = opencodeLoadsInventory(input(carried()), permEnv).rows.find((r) => r.key === 'mcp:project:search')!
    expect(brief(s.at!)[0]).toBe('fact:engine off→off')
    expect(s.state).toBe('held')
    expect(s.decidedBy).toEqual({ file: 'OPENCODE_PERMISSION', key: 'search_*' })
  })

  it('names are data: a server named `__proto__` has its own lines', () => {
    write(join(folder, 'opencode.json'), '{"mcp":{"__proto__":{"type":"local","command":["x"]}}}')
    const lines = linesOf(
      'mcp:project:__proto__',
      carried({ agents: [{ id: 'builder', payload: JSON.parse('{"mcp":{"__proto__":{"enabled":false}}}') as unknown }] }),
    )
    expect(brief(lines)).toEqual(['machine -→on ⇄', 'project -→on ⇄', 'agent:builder off→off ⇄'])
  })
})

describe("a launch place's switch — the payload back, nothing written", () => {
  it('an entry only where the place differs from what it follows (rule 12); every other entry kept', () => {
    const start = { mcp: { search: { enabled: false } }, permission: { skill: { drafts: 'deny' } } }
    const off = opencodeLoadsSwitch(input(carried({ folder: { payload: start } })), 'mcp:project:github', 'off', { scope: 'project', payload: start }, env())
    expect(off).toEqual({
      payload: { mcp: { search: { enabled: false }, github: { enabled: false } }, permission: { skill: { drafts: 'deny' } } },
      changed: true,
      held: true,
    })
    // back on: what it follows — the entry goes
    const on = opencodeLoadsSwitch(
      input(carried({ folder: { payload: off!.payload } })),
      'mcp:project:github',
      'on',
      { scope: 'project', payload: off!.payload },
      env(),
    )
    expect(on).toEqual({ payload: start, changed: true, held: false })
    // idempotent
    expect(
      opencodeLoadsSwitch(input(carried({ folder: { payload: start } })), 'mcp:project:github', 'on', { scope: 'project', payload: start }, env()),
    ).toMatchObject({ changed: false })
    // an agent «on» under the project's «off» is written (an override kind)
    const projOff = { mcp: { github: { enabled: false } } }
    const a = opencodeLoadsSwitch(
      input(carried({ folder: { payload: projOff } })),
      'mcp:project:github',
      'on',
      { scope: 'agent', agent: 'builder', payload: null },
      env(),
    )
    expect(a).toEqual({ payload: { mcp: { github: { enabled: true } } }, changed: true, held: true })
    // nothing was written anywhere
    expect(existsSync(globalFile())).toBe(false)
    expect(JSON.parse(readFileSync(join(folder, 'opencode.json'), 'utf8')).mcp.github).toEqual({ type: 'local', command: ['gh-mcp'] })
  })

  it("an agent that is not the folder's is 404; a row it does not list is 404", () => {
    expect(() => opencodeLoadsSwitch(input(carried()), 'mcp:project:github', 'off', { scope: 'agent', agent: 'stranger', payload: null }, env())).toThrow(
      /not an agent of this project/,
    )
    expect(() => opencodeLoadsSwitch(input(carried()), 'mcp:project:nope', 'off', { scope: 'project', payload: null }, env())).toThrow(/unknown row/)
  })

  it("through the neutral store: the project's plain click lands under `folders`, writes no file, and the row reads it back", () => {
    mkdirSync(join(base, 'data'), { recursive: true })
    const scopes = new LoadsScopesStore(join(base, 'data'))
    const deps: FolderLoadsDeps = {
      index: { allSessions: () => [], getContext: () => undefined, hasTranscriptFile: () => false, pathOf: () => '' } as unknown as FolderLoadsDeps['index'],
      registry: { list: () => [{ id: 'builder', name: 'Builder', folder, framework: 'opencode' } as Agent] },
      home,
      loadsScopes: scopes,
    }
    switchFolderLoad(deps, folder, 'mcp:project:github', 'off')
    expect(scopes.payloadOf('folders', folder, 'opencode')).toEqual({ mcp: { github: { enabled: false } } })
    expect(Object.keys(scopes.get('folders', folder, 'opencode')!.at)).toEqual(['mcp:project:github'])
    expect(scopes.payloadOf('agents', 'builder', 'opencode')).toBeNull()
    expect(existsSync(globalFile())).toBe(false)
    const row = folderLoads(deps, folder).rows.find((r) => r.key === 'mcp:project:github')!
    expect(row.state).toBe('held')
    // the agent's line, then: its own entry over the project's
    switchFolderLoad(deps, folder, 'mcp:project:github', 'on', { scope: 'agent', agent: 'builder' })
    expect(scopes.payloadOf('agents', 'builder', 'opencode')).toEqual({ mcp: { github: { enabled: true } } })
    // the store survives a reload
    const again = new LoadsScopesStore(join(base, 'data'))
    again.load()
    expect(again.payloadOf('folders', folder, 'opencode')).toEqual({ mcp: { github: { enabled: false } } })
  })
})

describe('this machine — the global file', () => {
  it('writes only its entry: every other key, server and definition kept; «on» removes it; a bare entry goes with it', () => {
    write(globalFile(), {
      $schema: 'https://opencode.ai/config.json',
      theme: 'x',
      mcp: { github: { type: 'local', command: ['gh-mcp'] }, other: { type: 'local', command: ['o'] } },
    })
    opencodeLoadsSwitch(input(carried()), 'mcp:user:github', 'off', { scope: 'machine' }, env())
    expect(JSON.parse(readFileSync(globalFile(), 'utf8'))).toEqual({
      $schema: 'https://opencode.ai/config.json',
      theme: 'x',
      mcp: { github: { type: 'local', command: ['gh-mcp'], enabled: false }, other: { type: 'local', command: ['o'] } },
    })
    expect(brief(linesOf('mcp:user:github', carried()))[0]).toBe('machine off→off ⇄')
    opencodeLoadsSwitch(input(carried()), 'mcp:user:github', 'on', { scope: 'machine' }, env())
    expect(JSON.parse(readFileSync(globalFile(), 'utf8')).mcp.github).toEqual({ type: 'local', command: ['gh-mcp'] })
    // a server of the folder's file: a bare entry, and «on» takes it away
    opencodeLoadsSwitch(input(carried()), 'mcp:project:search', 'off', { scope: 'machine' }, env())
    expect(JSON.parse(readFileSync(globalFile(), 'utf8')).mcp.search).toEqual({ enabled: false })
    expect(switchGlobalMcp(home, 'search', 'off')).toBe(false) // idempotent
    opencodeLoadsSwitch(input(carried()), 'mcp:project:search', 'on', { scope: 'machine' }, env())
    expect('search' in JSON.parse(readFileSync(globalFile(), 'utf8')).mcp).toBe(false)
  })

  it('absent: created; a file with comments, not JSON or not an object is refused, named, untouched — and its line has no switch', () => {
    switchGlobalMcp(home, 'github', 'off')
    expect(JSON.parse(readFileSync(globalFile(), 'utf8'))).toEqual({ mcp: { github: { enabled: false } } })
    for (const [name, text] of [
      ['opencode.jsonc', '{ // mine\n "mcp": {} }'],
      ['opencode.json', '[1]'],
    ] as const) {
      const b = mkdtempSync(join(tmpdir(), 'oc-refuse-'))
      const h = join(b, 'home')
      const f = join(h, '.config', 'opencode', name)
      write(f, text)
      expect(() => switchGlobalMcp(h, 'github', 'off')).toThrow(new RegExp(`~/\\.config/opencode/${name.replace('.', '\\.')}`))
      try {
        switchGlobalMcp(h, 'github', 'off')
      } catch (e) {
        expect((e as LoadsSwitchError).status).toBe(409)
      }
      expect(readFileSync(f, 'utf8')).toBe(text)
      const line = opencodeLoadsInventory({ ...input(carried()), home: h }, env())
        .rows.find((r) => r.key === 'mcp:project:github')!
        .at!.find((l) => l.place === 'machine')!
      expect(line.switch).toBeUndefined()
      expect(line.refused?.reason).toContain(name)
    }
    // an entry of another shape is refused too
    write(globalFile(), { mcp: { github: true } })
    expect(() => switchGlobalMcp(home, 'github', 'off')).toThrow(/mcp\."github" is not an object/)
  })

  it('the file OpenCode reads last is the one written: a strict-JSON .jsonc', () => {
    write(globalFile('opencode.json'), { mcp: {} })
    write(globalFile('opencode.jsonc'), { mcp: {} })
    switchGlobalMcp(home, 'github', 'off')
    expect(JSON.parse(readFileSync(globalFile('opencode.jsonc'), 'utf8')).mcp.github).toEqual({ enabled: false })
    expect(JSON.parse(readFileSync(globalFile('opencode.json'), 'utf8'))).toEqual({ mcp: {} })
  })

  it('a symlinked file is written through: the link stays a link', () => {
    const real = join(base, 'dotfiles', 'opencode.json')
    write(real, { mcp: {} })
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
    symlinkSync(real, globalFile())
    switchGlobalMcp(home, 'github', 'off')
    expect(lstatSync(globalFile()).isSymbolicLink()).toBe(true)
    expect(JSON.parse(readFileSync(real, 'utf8')).mcp.github).toEqual({ enabled: false })
  })
})
