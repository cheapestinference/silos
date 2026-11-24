// personal-instructions.test.ts — your personal CLAUDE.md and rules off in
// ONE project (harnesses/claude-code/personal-instructions.ts through the one
// writer): «off» writes the exact absolute paths of every login's personal
// files into the folder's claudeMdExcludes, «on» takes out exactly those and
// keeps every other entry and key; a second click writes nothing; another
// settings file that already lists them decides (409); a home folder and a
// corrupt file are refused untouched. And the neutral route: the engines of
// the folder's agents are asked, an agent bearer is refused. Temp dirs only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoadsSwitchError, type PersonalInput } from '../src/harnesses/contract.js'
import { claudePersonalState, claudePersonalSwitch, personalEntries } from '../src/harnesses/claude-code/personal-instructions.js'
import { filesCarry, withFilesCarried } from '../src/harnesses/claude-code/local-holds.js'
import '../src/harnesses/index.js'
import { folderPersonal, switchFolderPersonal } from '../src/folder-personal.js'
import { cleanEntries, setPersonalEntry, withLaunchEntries } from '../src/harnesses/claude-code/loads/launch-entries.js'
import { defaultConsoleCommand } from '../src/harnesses/claude-code/console.js'
import { LoadsScopesStore } from '../src/loads-scopes.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import type { QueryArgs, SdkMessage, SdkQueryHandle } from '../src/harnesses/claude-code/sdk-types.js'

let root = '',
  folder = '',
  home = '',
  extra = '',
  managed = ''
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-')))
  folder = join(root, 'project')
  home = join(root, 'home')
  extra = join(root, 'data', 'claude-accounts', 'work')
  managed = join(root, 'managed')
  for (const d of [join(folder, '.claude'), join(home, '.claude'), extra, managed]) mkdirSync(d, { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const localFile = (): string => join(folder, '.claude', 'settings.local.json')
const readLocal = (): Record<string, unknown> => JSON.parse(readFileSync(localFile(), 'utf8')) as Record<string, unknown>
const writeLocal = (o: unknown): void => writeFileSync(localFile(), typeof o === 'string' ? o : JSON.stringify(o))
const input = (over: Partial<PersonalInput> = {}): PersonalInput => ({ folder, home, loginDirs: [join(home, '.claude'), extra], managedDir: managed, ...over })
const refusal = (fn: () => void): LoadsSwitchError => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(LoadsSwitchError)
    return e as LoadsSwitchError
  }
  return expect.unreachable('should have refused')
}

describe('the exact paths in and out', () => {
  it("off writes each login's CLAUDE.md and rules — absolute, as the engine names them", () => {
    expect(claudePersonalState(input()).state).toBe('on')
    claudePersonalSwitch(input(), 'off')
    expect(readLocal().claudeMdExcludes).toEqual([
      join(home, '.claude', 'CLAUDE.md'),
      `${join(home, '.claude', 'rules')}/**`,
      join(extra, 'CLAUDE.md'),
      `${join(extra, 'rules')}/**`,
    ])
    const st = claudePersonalState(input())
    expect(st).toMatchObject({ state: 'off', logins: 2 })
    expect(st.entries).toEqual(readLocal().claudeMdExcludes)
  })

  it("no login given: the machine's own ~/.claude", () => {
    expect(personalEntries([join(home, '.claude')])).toEqual([join(home, '.claude', 'CLAUDE.md'), `${join(home, '.claude', 'rules')}/**`])
    claudePersonalSwitch(input({ loginDirs: undefined }), 'off')
    expect(readLocal().claudeMdExcludes).toEqual([join(home, '.claude', 'CLAUDE.md'), `${join(home, '.claude', 'rules')}/**`])
  })

  it('on removes exactly those entries; other entries and keys are kept', () => {
    writeLocal({ claudeMdExcludes: ['**/vendor/CLAUDE.md', join(home, '.claude', 'CLAUDE.md')], enabledPlugins: { 'kit@market': false } })
    expect(claudePersonalState(input()).state).toBe('partly')
    claudePersonalSwitch(input(), 'off')
    expect(readLocal().claudeMdExcludes).toEqual([
      '**/vendor/CLAUDE.md',
      join(home, '.claude', 'CLAUDE.md'),
      `${join(home, '.claude', 'rules')}/**`,
      join(extra, 'CLAUDE.md'),
      `${join(extra, 'rules')}/**`,
    ])
    claudePersonalSwitch(input(), 'on')
    expect(readLocal()).toEqual({ claudeMdExcludes: ['**/vendor/CLAUDE.md'], enabledPlugins: { 'kit@market': false } })
  })

  it('on with nothing else left drops the key; a second click writes nothing', () => {
    writeLocal({ model: 'opus' })
    claudePersonalSwitch(input(), 'off')
    const once = readFileSync(localFile(), 'utf8')
    claudePersonalSwitch(input(), 'off')
    expect(readFileSync(localFile(), 'utf8')).toBe(once)
    claudePersonalSwitch(input(), 'on')
    expect(readLocal()).toEqual({ model: 'opus' })
    const after = readFileSync(localFile(), 'utf8')
    claudePersonalSwitch(input(), 'on')
    expect(readFileSync(localFile(), 'utf8')).toBe(after)
  })

  it('what the switch wrote rides an unattended turn', () => {
    claudePersonalSwitch(input(), 'off')
    expect(withFilesCarried({}, filesCarry(folder, { sources: ['user', 'project'], home })).claudeMdExcludes).toEqual(claudePersonalState(input()).entries)
  })
})

describe('what decides elsewhere, and what is refused', () => {
  it('another settings file that lists one decides: a fact, both directions refused', () => {
    writeFileSync(join(extra, 'settings.json'), JSON.stringify({ claudeMdExcludes: [join(extra, 'CLAUDE.md')] }))
    const st = claudePersonalState(input())
    expect(st.state).toBe('off')
    expect(st.decidedBy).toEqual({ file: join(extra, 'settings.json'), key: 'claudeMdExcludes' })
    expect(refusal(() => claudePersonalSwitch(input(), 'on')).status).toBe(409)
    expect(existsSync(localFile())).toBe(false)
  })

  it('a corrupt local file, or a claudeMdExcludes that is not a list, is refused untouched', () => {
    writeLocal('{ nope')
    expect(claudePersonalState(input()).refused).toMatch(/not valid JSON/)
    expect(refusal(() => claudePersonalSwitch(input(), 'off')).status).toBe(409)
    expect(readFileSync(localFile(), 'utf8')).toBe('{ nope')
    writeLocal({ claudeMdExcludes: 'x' })
    expect(refusal(() => claudePersonalSwitch(input(), 'off')).status).toBe(409)
    expect(readLocal()).toEqual({ claudeMdExcludes: 'x' })
  })

  it('a home folder is refused: nothing under ~/.claude is written', () => {
    const st = claudePersonalState(input({ folder: home }))
    expect(st.refused).toBeTruthy()
    expect(refusal(() => claudePersonalSwitch(input({ folder: home }), 'off')).status).toBe(409)
    expect(existsSync(join(home, '.claude', 'settings.local.json'))).toBe(false)
  })
})

describe('the neutral seam', () => {
  const agent = (over: Record<string, unknown> = {}) => ({ id: 'builder', name: 'Builder', folder, framework: 'claude-code', ...over })
  const deps = (agents: unknown[]) => ({
    registry: { list: () => agents as never },
    home,
    managedDir: managed,
    loginDirs: () => [join(home, '.claude'), extra],
  })

  it("asks the folder's engines and switches through them", () => {
    const d = deps([agent()])
    expect(folderPersonal(d, folder).engines.map((e) => [e.id, e.state])).toEqual([['claude-code', 'on']])
    switchFolderPersonal(d, folder, 'off')
    expect(folderPersonal(d, folder).engines[0]!.state).toBe('off')
    expect((readLocal().claudeMdExcludes as string[]).length).toBe(4)
  })

  it('an engine without the switch adds no row and refuses the click', () => {
    const d = deps([agent({ framework: 'opencode' })])
    expect(folderPersonal(d, folder).engines).toEqual([])
    expect(() => switchFolderPersonal(d, folder, 'off')).toThrow(LoadsSwitchError)
    expect(existsSync(localFile())).toBe(false)
  })
})

// spec scopes T10: personal instructions off for ONE agent, for ONE
// conversation — the launch places keep the choice, never a path; every
// launch computes the entries for every login dir known then.
describe('for one agent, for one conversation — carried at launch', () => {
  const OFF = { personalInstructions: 'off' }
  const entriesFor = (...dirs: string[]): string[] => dirs.flatMap((d) => [join(d, 'CLAUDE.md'), `${join(d, 'rules')}/**`])

  it('the payload keeps the choice; the launch carries the entries for every login dir, computed at launch', () => {
    const { payload } = setPersonalEntry(null, 'off')
    expect(payload).toEqual(OFF)
    expect(JSON.stringify(payload)).not.toContain('CLAUDE.md')
    const s = withLaunchEntries({ permissions: { deny: ['Read(//x)'] } }, [payload], { loginDirs: [join(home, '.claude'), extra] })
    expect(s.claudeMdExcludes).toEqual(entriesFor(join(home, '.claude'), extra))
    expect(s.permissions).toEqual({ deny: ['Read(//x)'] })
    // the choice is not an engine key: it never rides as itself
    expect('personalInstructions' in s).toBe(false)
  })

  it('a login added later is covered — the same payload, the logins of each launch', () => {
    const later = join(root, 'data', 'claude-accounts', 'later')
    const payload = setPersonalEntry(null, 'off').payload
    expect(withLaunchEntries({}, [payload], { loginDirs: [join(home, '.claude')] }).claudeMdExcludes).toEqual(entriesFor(join(home, '.claude')))
    expect(withLaunchEntries({}, [payload], { loginDirs: [join(home, '.claude'), later] }).claudeMdExcludes).toEqual(entriesFor(join(home, '.claude'), later))
  })

  it('the allowlist admits the choice in its «off» value only — never a path list, never another value', () => {
    expect(cleanEntries({ claudeMdExcludes: ['/etc/CLAUDE.md'] })).toBeNull()
    expect(cleanEntries({ personalInstructions: 'on' })).toBeNull()
    expect(cleanEntries({ personalInstructions: true })).toBeNull()
    expect(cleanEntries({ ...OFF, claudeMdExcludes: ['/etc/CLAUDE.md'] })).toEqual(OFF)
    const s = withLaunchEntries({}, [{ ...OFF, claudeMdExcludes: ['/etc/CLAUDE.md'] }], { loginDirs: [extra] })
    expect(s.claudeMdExcludes).toEqual(entriesFor(extra))
    // joined with what the launch already excludes (the project's file, carried)
    expect(withLaunchEntries({ claudeMdExcludes: ['**/vendor/CLAUDE.md'] }, [OFF], { loginDirs: [extra] }).claudeMdExcludes).toEqual([
      '**/vendor/CLAUDE.md',
      ...entriesFor(extra),
    ])
    // a removal: a heartbeat's sealed regime carries it too
    expect(withLaunchEntries({}, [OFF], { onlyRemoves: true, loginDirs: [extra] }).claudeMdExcludes).toEqual(entriesFor(extra))
    // none kept: byte-identical
    const base = { theme: 'light' }
    expect(withLaunchEntries(base, [], { loginDirs: [extra] })).toBe(base)
  })

  it("a console's --settings and a chat turn's options carry it, against the logins read at that launch", async () => {
    const argv = defaultConsoleCommand({ sessionId: 's1', carried: [OFF], loginDirs: [join(home, '.claude'), extra] })
    expect((JSON.parse(argv[argv.indexOf('--settings') + 1]!) as Record<string, unknown>).claudeMdExcludes).toEqual(entriesFor(join(home, '.claude'), extra))
    const registry = new AgentRegistry(join(root, 'agents.json'))
    registry.load()
    registry.create({ id: 'builder', name: 'Builder', folder })
    const calls: QueryArgs[] = []
    const queryFn = (args: QueryArgs): SdkQueryHandle => {
      calls.push(args)
      const script: SdkMessage[] = [
        { type: 'system', subtype: 'init', session_id: 'sess-1' },
        { type: 'result', subtype: 'success', session_id: 'sess-1', total_cost_usd: 0 },
      ]
      return {
        async *[Symbol.asyncIterator]() {
          for (const m of script) yield m
        },
        async interrupt() {
          return { status: 'interrupted' }
        },
      }
    }
    const logins = [join(home, '.claude')]
    const chat = new ChatService({
      registry,
      native: new NativeStore(join(root, 'native.json')),
      queryFn,
      loadsCarried: () => [OFF],
      loginDirs: () => [...logins],
    })
    const send = async (turnId: string): Promise<void> => {
      for await (const _ of chat.send({ turnId, agentId: 'builder', text: 'hi' })) void _
    }
    await send('t1')
    logins.push(extra) // a login added after the click
    await send('t2')
    const excludes = (c: QueryArgs): unknown => ((c.options as Record<string, unknown>).settings as Record<string, unknown>).claudeMdExcludes
    expect(excludes(calls[0]!)).toEqual(entriesFor(join(home, '.claude')))
    expect(excludes(calls[1]!)).toEqual(entriesFor(join(home, '.claude'), extra))
  })
})

describe('the launch places through the neutral seam', () => {
  const agents = [
    { id: 'builder', name: 'Builder', folder: '', framework: 'claude-code' },
    { id: 'writer', name: 'Writer', folder: '', framework: 'claude-code' },
  ]
  let store: LoadsScopesStore
  beforeEach(() => {
    for (const a of agents) a.folder = folder
    mkdirSync(join(root, 'data'), { recursive: true })
    store = new LoadsScopesStore(join(root, 'data'))
    store.load()
  })
  const deps = () => ({
    registry: { list: () => agents as never },
    home,
    managedDir: managed,
    loginDirs: () => [join(home, '.claude'), extra],
    loadsScopes: store,
  })
  const lineOf = (fp: ReturnType<typeof folderPersonal>, place: string, agent?: string) =>
    fp.engines[0]!.at!.find((l) => l.place === place && (agent === undefined || l.agent === agent))
  const allEntries = (): string[] => [
    join(home, '.claude', 'CLAUDE.md'),
    `${join(home, '.claude', 'rules')}/**`,
    join(extra, 'CLAUDE.md'),
    `${join(extra, 'rules')}/**`,
  ]

  it("an agent's «off» is kept by Silos with its own time; nothing under the folder or ~/.claude is written; the project's switch is unchanged", () => {
    switchFolderPersonal(deps(), folder, 'off', { scope: 'agent', agent: 'builder' })
    expect(store.get('agents', 'builder', 'claude-code')).toMatchObject({ entries: { personalInstructions: 'off' }, at: { personal: expect.any(Number) } })
    expect(existsSync(localFile())).toBe(false)
    expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false)
    const fp = folderPersonal(deps(), folder)
    expect(fp.engines[0]!.state).toBe('on')
    expect(lineOf(fp, 'agent', 'builder')).toMatchObject({ entry: 'off', result: 'off', agentName: 'Builder' })
    expect(lineOf(fp, 'agent', 'writer')).toMatchObject({ result: 'on' })
    expect(lineOf(fp, 'agent', 'writer')!.entry).toBeUndefined()
    // an agent's page sees its own line only among the agents
    expect(
      folderPersonal(deps(), folder, { as: 'writer' })
        .engines[0]!.at!.filter((l) => l.place === 'agent')
        .map((l) => l.agent),
    ).toEqual(['writer'])
    // the project's switch writes its own file as before, and locks the agent lines below it
    switchFolderPersonal(deps(), folder, 'off')
    expect(readLocal().claudeMdExcludes).toEqual(allEntries())
    const after = folderPersonal(deps(), folder)
    expect(lineOf(after, 'agent', 'writer')).toMatchObject({ result: 'off', locked: { why: 'wider', at: 'project' } })
    expect(lineOf(after, 'agent', 'writer')!.switch).toBeUndefined()
    expect(refusal(() => switchFolderPersonal(deps(), folder, 'off', { scope: 'agent', agent: 'writer' })).status).toBe(409)
    // «on» removes the agent's own entry; the record goes with it; the project's file is untouched
    switchFolderPersonal(deps(), folder, 'on', { scope: 'agent', agent: 'builder' })
    expect(store.get('agents', 'builder', 'claude-code')).toBeNull()
    expect(readLocal().claudeMdExcludes).toEqual(allEntries())
  })

  it("one conversation's «off» is kept under its thread; a conversation whose agent keeps them out is locked", () => {
    const conv = { thread: 'thread-1', agent: 'builder' }
    switchFolderPersonal(deps(), folder, 'off', { scope: 'conversation', conversation: conv })
    expect(store.get('conversations', 'thread-1', 'claude-code')).toMatchObject({
      entries: { personalInstructions: 'off' },
      at: { personal: expect.any(Number) },
    })
    expect(store.get('agents', 'builder', 'claude-code')).toBeNull()
    expect(lineOf(folderPersonal(deps(), folder, { conv }), 'conversation')).toMatchObject({ conversation: 'thread-1', entry: 'off', result: 'off' })
    // a conversation line only when one is asked
    expect(lineOf(folderPersonal(deps(), folder), 'conversation')).toBeUndefined()
    switchFolderPersonal(deps(), folder, 'on', { scope: 'conversation', conversation: conv })
    switchFolderPersonal(deps(), folder, 'off', { scope: 'agent', agent: 'builder' })
    expect(lineOf(folderPersonal(deps(), folder, { conv }), 'conversation')).toMatchObject({ result: 'off', locked: { why: 'wider', at: 'agent' } })
    expect(refusal(() => switchFolderPersonal(deps(), folder, 'off', { scope: 'conversation', conversation: conv })).status).toBe(409)
  })

  it("an agent that is not the folder's is 404; an engine without the switch has no lines", () => {
    expect(refusal(() => switchFolderPersonal(deps(), folder, 'off', { scope: 'agent', agent: 'finance' })).status).toBe(404)
    const oc = { ...deps(), registry: { list: () => [{ id: 'builder', name: 'Builder', folder, framework: 'opencode' }] as never } }
    expect(folderPersonal(oc, folder).engines).toEqual([])
    expect(refusal(() => switchFolderPersonal(oc, folder, 'off', { scope: 'agent', agent: 'builder' })).status).toBe(409)
  })

  it('the machine line is the file itself: a door, never a switch', () => {
    const m = lineOf(folderPersonal(deps(), folder), 'machine')!
    expect(m.switch).toBeUndefined()
    expect(m.door?.where).toMatch(/Memories/)
  })
})
