// loads-skills.test.ts — Claude Code's skills of a claude.ai account and the
// three positions per skill (loads/skills.ts through the one writer,
// local-settings.ts): each position writes or removes exactly its entry of
// the folder's .claude/settings.local.json and keeps every other key; a
// value Silos doesn't write is shown and kept; the origin's head writes or
// removes only `syncClaudeAiSkills`; adding one account skill while the
// origin is off leaves every other one known off (rule 4); what another
// file decides, a home folder, a broken file are refused; the personal
// skills folder and ~/.claude are never written. The briefing's skill set
// (sdkTurnSkills, which consoles share) counts the login's account skills,
// then leaves out what is off; the catalog lists account skills per login.
// Temp dirs only — the real ~/.claude and ~/.silos are never touched.
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoadsSwitchError, type LoadsCarriedSwitch, type LoadsSkillAsk, type LoadsSkillLine, type LoadsSkillsInput } from '../src/harnesses/contract.js'
import { carriedSkillKeys, claudeLoadsSkills, claudeSkillPlaces, claudeSkillSwitch } from '../src/harnesses/claude-code/loads/skills.js'
import { folderSkillPlaces, switchFolderSkill } from '../src/folder-loads.js'
import { LoadsScopesStore } from '../src/loads-scopes.js'
import { fallbackHarness } from '../src/harnesses/registry.js'
import { sdkTurnSkills } from '../src/harnesses/claude-code/headless.js'
import { filesCarry, withFilesCarried } from '../src/harnesses/claude-code/local-holds.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { CompleteService } from '../src/complete-service.js'

const ORG = '00000000-0000-4000-8000-00000000000a'
const ACC = '00000000-0000-4000-8000-00000000000b'
const ACC2 = '00000000-0000-4000-8000-00000000000c'

let base: string, home: string, folder: string, managed: string
const write = (path: string, v: unknown): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, typeof v === 'string' ? v : JSON.stringify(v))
}
const localFile = (): string => join(folder, '.claude', 'settings.local.json')
const readLocal = (): Record<string, unknown> => JSON.parse(readFileSync(localFile(), 'utf8')) as Record<string, unknown>
const skill = (dir: string, name: string, description = `${name} does things`): void =>
  write(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`)
const batchDir = (acc = ACC, configDir = join(home, '.claude')): string => join(configDir, 'skills', 'synced', `${ORG}_${acc}`)
const input = (over: Partial<LoadsSkillsInput> = {}): LoadsSkillsInput => ({ folder, home, managedDir: managed, recentTranscripts: () => [], ...over })
const set = (name: string, to: string, from: 'account' | 'personal' = 'account'): void => claudeSkillSwitch(input(), { kind: 'skill', name, from }, to)
const origin = (to: 'on' | 'off'): void => claudeSkillSwitch(input(), { kind: 'origin' }, to)
const refusedWith = (fn: () => void): LoadsSwitchError => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(LoadsSwitchError)
    return e as LoadsSwitchError
  }
  return expect.unreachable('should have refused')
}
/** every file under a dir with its size and mtime — what «never touched» compares */
const snapshot = (dir: string): string[] => {
  const out: string[] = []
  const walk = (d: string): void => {
    let names: string[] = []
    try {
      names = readdirSync(d)
    } catch {
      return
    }
    for (const n of names.sort()) {
      const p = join(d, n)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else out.push(`${p}:${st.size}:${st.mtimeMs}:${readFileSync(p, 'utf8')}`)
    }
  }
  walk(dir)
  return out
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'silos-skills-'))
  home = join(base, 'home')
  folder = join(base, 'proj')
  managed = join(base, 'managed')
  mkdirSync(folder, { recursive: true })
  // the account sends brief, digest and notes; the machine has two personal skills
  for (const n of ['brief', 'digest', 'notes']) skill(batchDir(), n)
  write(join(batchDir(), 'manifest.json'), { skills: [] })
  skill(join(home, '.claude', 'skills'), 'vps-notes')
  skill(join(home, '.claude', 'skills'), 'notes') // a namesake of an account skill
})

describe('the three positions of a skill', () => {
  it('on · name only · off write and remove exactly their entry, every other key kept, idempotent', () => {
    write(localFile(), { permissions: { allow: ['Bash(ls)'] }, enabledPlugins: { 'x@y': false } })
    set('brief', 'name-only')
    expect(readLocal()).toEqual({ permissions: { allow: ['Bash(ls)'] }, enabledPlugins: { 'x@y': false }, skillOverrides: { brief: 'name-only' } })
    set('brief', 'off')
    set('vps-notes', 'off', 'personal')
    expect(readLocal().skillOverrides).toEqual({ brief: 'off', 'vps-notes': 'off' })
    const before = readFileSync(localFile(), 'utf8')
    set('brief', 'off') // a second click in the same direction writes nothing
    expect(readFileSync(localFile(), 'utf8')).toBe(before)
    set('brief', 'on')
    expect(readLocal().skillOverrides).toEqual({ 'vps-notes': 'off' })
    set('vps-notes', 'on', 'personal')
    // on is NO entry: the key goes when it empties
    expect(readLocal()).toEqual({ permissions: { allow: ['Bash(ls)'] }, enabledPlugins: { 'x@y': false } })
  })

  it('another value found in the file is shown, and kept when another skill switches', () => {
    write(localFile(), { skillOverrides: { digest: 'user-invocable-only', later: 'some-future-value', odd: 7 } })
    expect(claudeLoadsSkills(input()).overrides.find((o) => o.name === 'digest')).toEqual({ name: 'digest', value: 'user-invocable-only' })
    set('brief', 'off')
    expect(readLocal().skillOverrides).toEqual({ digest: 'user-invocable-only', later: 'some-future-value', odd: 7, brief: 'off' })
    set('brief', 'on')
    expect(readLocal().skillOverrides).toEqual({ digest: 'user-invocable-only', later: 'some-future-value', odd: 7 })
  })

  it('the personal skills folder and ~/.claude are never written', () => {
    const claude = snapshot(join(home, '.claude'))
    set('vps-notes', 'off', 'personal')
    set('notes', 'name-only', 'personal')
    origin('off')
    set('brief', 'name-only')
    origin('on')
    set('vps-notes', 'on', 'personal')
    expect(snapshot(join(home, '.claude'))).toEqual(claude)
    expect(readdirSync(join(home, '.claude', 'skills')).sort()).toEqual(['notes', 'synced', 'vps-notes'])
  })

  it('a name is data: constructor becomes a plain entry; __proto__ — a name settings cannot store — is refused, nothing written', () => {
    skill(batchDir(), '__proto__')
    skill(batchDir(), 'constructor')
    // measured (T1, CLI 2.1.331): Claude Code ignores any position for __proto__
    expect(refusedWith(() => set('__proto__', 'off')).status).toBe(409)
    expect(() => readFileSync(localFile())).toThrow()
    set('constructor', 'name-only')
    const raw = readFileSync(localFile(), 'utf8')
    expect(JSON.parse(raw).skillOverrides).toEqual(JSON.parse('{"constructor":"name-only"}'))
    expect(({} as Record<string, unknown>).constructor).toBe(Object)
  })

  it('refuses: an unknown name 404, a position it does not write, another file deciding, a home folder, a broken file', () => {
    expect(refusedWith(() => set('nobody', 'off')).status).toBe(404)
    expect(refusedWith(() => set('vps-notes', 'off')).status).toBe(404) // a personal skill is not the account's
    expect(refusedWith(() => set('brief', 'user-invocable-only')).status).toBe(409)
    // the machine's head keeps every account skill off: the project can't add one (off-only)
    write(join(home, '.claude', 'settings.json'), { skillOverrides: { digest: 'off' }, syncClaudeAiSkills: false })
    expect(refusedWith(() => set('digest', 'on')).status).toBe(409)
    expect(refusedWith(() => origin('on')).message).toContain('syncClaudeAiSkills')
    // managed settings decide: no place here changes it
    write(join(managed, 'managed-settings.json'), { skillOverrides: { brief: 'off' } })
    expect(refusedWith(() => set('brief', 'on')).message).toContain('managed settings')
    expect(claudeLoadsSkills(input()).overrides.find((o) => o.name === 'brief')?.decidedBy).toEqual({ file: 'managed settings', key: 'skillOverrides.brief' })
    write(join(managed, 'managed-settings.json'), {})
    write(join(home, '.claude', 'settings.json'), {})
    write(localFile(), '{ not json')
    expect(refusedWith(() => set('brief', 'off')).status).toBe(409)
    expect(readFileSync(localFile(), 'utf8')).toBe('{ not json')
    write(localFile(), { skillOverrides: ['brief'] })
    expect(refusedWith(() => set('brief', 'off')).status).toBe(409)
    expect(readLocal()).toEqual({ skillOverrides: ['brief'] })
    // the home folder: its .claude is the engine's own config dir
    const homeIn = (over: Partial<LoadsSkillsInput>): LoadsSkillsInput => ({ ...input(), folder: home, ...over })
    expect(claudeLoadsSkills(homeIn({})).refused).toEqual({ why: 'home' })
    expect(refusedWith(() => claudeSkillSwitch(homeIn({}), { kind: 'skill', name: 'brief', from: 'account' }, 'off')).status).toBe(409)
    expect(() => readFileSync(join(home, '.claude', 'settings.local.json'))).toThrow()
  })
})

describe('the origin head and rule 4', () => {
  it('Off writes only syncClaudeAiSkills: false; On removes it and nothing else', () => {
    write(localFile(), { skillOverrides: { brief: 'off' } })
    origin('off')
    expect(readLocal()).toEqual({ skillOverrides: { brief: 'off' }, syncClaudeAiSkills: false })
    expect(claudeLoadsSkills(input()).origin).toEqual({ on: false })
    origin('on')
    expect(readLocal()).toEqual({ skillOverrides: { brief: 'off' } })
  })

  it('adding one account skill while the origin is off: the origin key goes, every other one known stays off — a personal namesake untouched', () => {
    write(localFile(), { syncClaudeAiSkills: false, skillOverrides: { digest: 'name-only' } })
    skill(batchDir(ACC2), 'roster') // another login's batch: known at the click too
    set('brief', 'on')
    // digest keeps the owner's own entry; notes is also a personal skill —
    // one local entry would hide the personal one, so it is not written
    expect(readLocal()).toEqual({ skillOverrides: { digest: 'name-only', roster: 'off' } })
  })
})

describe('the briefing’s skill set — SDK turns and consoles (sdkTurnSkills)', () => {
  const claudeJson = (acc: string): void => write(join(home, '.claude.json'), { oauthAccount: { accountUuid: acc } })
  it('counts the login’s account skills — by its account id, else the only batch — then leaves out what is off', () => {
    skill(batchDir(ACC2), 'roster')
    // two batches, no account id: none is the login's for sure
    expect(sdkTurnSkills(folder, ['user', 'project', 'local'], null, home)).toEqual(['notes', 'vps-notes'])
    claudeJson(ACC)
    expect(sdkTurnSkills(folder, ['user', 'project', 'local'], null, home)).toEqual(['brief', 'digest', 'notes', 'vps-notes'])
    write(localFile(), { skillOverrides: { brief: 'off', digest: 'name-only', 'vps-notes': 'user-invocable-only' } })
    expect(sdkTurnSkills(folder, ['user', 'project', 'local'], null, home)).toEqual(['digest', 'notes'])
    write(localFile(), { syncClaudeAiSkills: false })
    expect(sdkTurnSkills(folder, ['user', 'project', 'local'], null, home)).toEqual(['notes', 'vps-notes'])
  })

  it('a login of its own: its own dir and .claude.json', () => {
    const own = join(base, 'accounts', 'second')
    skill(batchDir(ACC2, own), 'roster')
    skill(join(own, 'skills'), 'own-personal')
    write(join(own, '.claude.json'), { oauthAccount: { accountUuid: ACC2 } })
    expect(sdkTurnSkills(folder, ['user'], own, home)).toEqual(['own-personal', 'roster'])
  })

  it('a shared name: the local file hides only the personal copy; carried in the flag tier (no local source) it hides both', () => {
    claudeJson(ACC)
    write(localFile(), { skillOverrides: { notes: 'off' } })
    // read as the local layer: the account's `notes` still loads
    expect(sdkTurnSkills(folder, ['user', 'project', 'local'], null, home)).toContain('notes')
    // an unattended turn (no local source; the file rides its flag tier): both gone
    const sources = ['user', 'project']
    const flag = withFilesCarried({}, filesCarry(folder, { sources, home }))
    expect(sdkTurnSkills(folder, sources, null, home, undefined, flag)).toEqual(['brief', 'digest', 'vps-notes'])
  })

  it('an unattended turn: a local «off» rides the flag tier over a gentler user entry', () => {
    claudeJson(ACC)
    write(join(home, '.claude', 'settings.json'), { skillOverrides: { brief: 'name-only' } })
    write(localFile(), { skillOverrides: { brief: 'off' } })
    const sources = ['user', 'project']
    expect(sdkTurnSkills(folder, sources, null, home, undefined, withFilesCarried({}, filesCarry(folder, { sources, home })))).not.toContain('brief')
    expect(sdkTurnSkills(folder, ['user', 'project', 'local'], null, home)).not.toContain('brief')
  })

  // the folder's own copies take every tier too — what a console's append
  // and an attended turn read (the engine reads the files itself; the flag
  // tier carries the agent's and the conversation's entries)
  it("a folder copy: off from the local, the repository's, the machine's file or the flag tier; a narrower «on» restores it", () => {
    skill(join(folder, '.claude', 'skills'), 'deploy')
    const all = ['user', 'project', 'local']
    const has = (flag?: Record<string, unknown>): boolean => sdkTurnSkills(folder, all, null, home, managed, flag ?? null).includes('deploy')
    expect(has()).toBe(true)
    write(localFile(), { skillOverrides: { deploy: 'off' } })
    expect(has()).toBe(false)
    expect(has({ skillOverrides: { deploy: 'on' } })).toBe(true)
    write(localFile(), {})
    write(join(folder, '.claude', 'settings.json'), { skillOverrides: { deploy: 'user-invocable-only' } })
    expect(has()).toBe(false)
    write(localFile(), { skillOverrides: { deploy: 'name-only' } }) // still callable: named
    expect(has()).toBe(true)
    write(localFile(), {})
    write(join(folder, '.claude', 'settings.json'), {})
    write(join(home, '.claude', 'settings.json'), { skillOverrides: { deploy: 'off' } })
    expect(has()).toBe(false)
    write(join(home, '.claude', 'settings.json'), {})
    expect(has(carriedSkillKeys([{ skillOverrides: { deploy: 'off' } }]) ?? undefined)).toBe(false)
    // managed above all
    write(join(managed, 'managed-settings.json'), { skillOverrides: { deploy: 'off' } })
    expect(has({ skillOverrides: { deploy: 'on' } })).toBe(false)
  })

  it("a personal skill shadowing a folder copy: an «off» for it leaves the name out; a name settings can't store takes no entry", () => {
    skill(join(folder, '.claude', 'skills'), 'vps-notes') // `vps-notes` is also personal
    write(localFile(), { skillOverrides: { 'vps-notes': 'off' } })
    expect(sdkTurnSkills(folder, ['user', 'project', 'local'], null, home)).not.toContain('vps-notes')
    skill(join(folder, '.claude', 'skills'), '__proto__')
    write(localFile(), '{"skillOverrides":{"__proto__":"off"}}')
    expect(sdkTurnSkills(folder, ['user', 'project', 'local'], null, home)).toContain('__proto__')
  })
})

describe('the skills catalog lists what the account sends', () => {
  it('per login, with each position; off or origin-off is «could add»; a personal skill off is held; a shared name says so', async () => {
    const registry = new AgentRegistry(join(base, 'agents.json'))
    registry.load()
    registry.create({ id: 'builder', name: 'Builder', folder, skills: [] })
    const root = join(base, 'projects')
    mkdirSync(root, { recursive: true })
    const index = claudeSessionIndex(root, join(base, 'cache.json'))
    await index.init()
    const svc = new CompleteService(registry, index, join(home, '.claude', 'skills'), undefined, undefined, undefined, managed, () => ({
      skills: claudeLoadsSkills(input()),
      switches: true,
    }))
    write(localFile(), { skillOverrides: { brief: 'off', digest: 'name-only', 'vps-notes': 'off' } })
    const cat = await svc.folderCatalog(folder)
    const acct = cat.filter((e) => e.source === 'account')
    expect(acct.map((e) => [e.name, e.state, e.position ?? 'on'])).toEqual([
      ['brief', 'available', 'off'],
      ['digest', 'active', 'name-only'],
      ['notes', 'active', 'on'],
    ])
    expect(acct[0]).toMatchObject({ account: { login: null, unmatched: true }, switches: true, origin: { on: true, switches: true } })
    expect(cat.find((e) => e.name === 'vps-notes')).toMatchObject({ source: 'user', state: 'held', position: 'off', switches: true })
    expect(cat.filter((e) => e.name === 'notes').map((e) => [e.source, e.sameName])).toEqual([
      ['user', true],
      ['account', true],
    ])
    write(localFile(), { syncClaudeAiSkills: false })
    expect((await svc.folderCatalog(folder)).filter((e) => e.source === 'account').every((e) => e.state === 'available' && e.origin?.on === false)).toBe(true)
  })
})

// spec scopes T9 — a skill at every place: this machine (the user's own
// file), this project (its local file, or Silos' held store for a folder
// copy), each agent (the payload Silos keeps, carried at launch).
describe('where a skill loads — every place (scopes T9)', () => {
  const userFile = (): string => join(home, '.claude', 'settings.json')
  const readUser = (): Record<string, unknown> => JSON.parse(readFileSync(userFile(), 'utf8')) as Record<string, unknown>
  const carried = (payload: unknown = null): Partial<LoadsSkillsInput> => ({
    carried: {
      agents: [
        { id: 'builder', payload },
        { id: 'writer', payload: null },
      ],
    },
  })
  const at = (name: string, from: LoadsSkillAsk['from'], over: Partial<LoadsSkillsInput> = {}, extra: Partial<LoadsSkillAsk> = {}): LoadsSkillLine[] =>
    claudeSkillPlaces(input({ ...carried(), ...over }), [{ name, from, ...extra }])[0]!.lines
  const lineAt = (lines: LoadsSkillLine[], place: string, agent?: string): LoadsSkillLine | undefined =>
    lines.find((l) => l.place === place && (agent === undefined || l.agent === agent))
  const agentSet = (name: string, from: 'account' | 'personal' | 'project', to: string, payload: unknown = null): LoadsCarriedSwitch =>
    claudeSkillSwitch(input(carried(payload)), { kind: 'skill', name, from }, to, { scope: 'agent', agent: 'builder', payload }) as LoadsCarriedSwitch
  const machineSet = (name: string, from: 'account' | 'personal' | 'project', to: string): void => {
    claudeSkillSwitch(input(), { kind: 'skill', name, from }, to, { scope: 'machine' })
  }

  it('each place writes and removes exactly its entry — the machine its file, the project its file, an agent only its payload', () => {
    write(userFile(), { hooks: { Stop: [] }, skillOverrides: { other: 'off' } })
    write(localFile(), { permissions: { allow: ['Bash(ls)'] } })
    const local = readFileSync(localFile(), 'utf8')
    machineSet('vps-notes', 'personal', 'name-only')
    expect(readUser()).toEqual({ hooks: { Stop: [] }, skillOverrides: { other: 'off', 'vps-notes': 'name-only' } })
    expect(readFileSync(localFile(), 'utf8')).toBe(local)
    machineSet('vps-notes', 'personal', 'name-only') // idempotent
    machineSet('vps-notes', 'personal', 'on') // the broadest place: «on» is no entry
    expect(readUser()).toEqual({ hooks: { Stop: [] }, skillOverrides: { other: 'off' } })
    // an agent's entry: the payload, returned — nothing under the folder or ~/.claude
    const claude = snapshot(join(home, '.claude'))
    const a = agentSet('brief', 'account', 'off')
    expect(a).toEqual({ payload: { skillOverrides: { brief: 'off' } }, changed: true, held: true })
    expect(agentSet('brief', 'account', 'on', a.payload)).toEqual({ payload: null, changed: true, held: false })
    // the allowlist on the way in: nothing but §3's keys survives
    expect(agentSet('brief', 'account', 'off', { skillOverrides: { brief: 'off' }, permissions: { allow: ['*'] } }).payload).toEqual({
      skillOverrides: { brief: 'off' },
    })
    expect(snapshot(join(home, '.claude'))).toEqual(claude)
    expect(readFileSync(localFile(), 'utf8')).toBe(local)
    expect(
      refusedWith(() =>
        claudeSkillSwitch(input(carried()), { kind: 'skill', name: 'brief', from: 'account' }, 'off', { scope: 'agent', agent: 'stranger', payload: null }),
      ).status,
    ).toBe(404)
  })

  it('«on» is written only where it must override a wider «off», removed where the place follows anyway', () => {
    write(userFile(), { skillOverrides: { 'vps-notes': 'off' } })
    expect(lineAt(at('vps-notes', 'personal'), 'project')?.result).toBe('off')
    set('vps-notes', 'on', 'personal')
    expect(readLocal().skillOverrides).toEqual({ 'vps-notes': 'on' }) // on here — off on the rest of this machine
    expect(lineAt(at('vps-notes', 'personal'), 'project')).toMatchObject({ entry: 'on', result: 'on' })
    set('vps-notes', 'off', 'personal') // the same as the machine: no entry of its own
    expect(readLocal().skillOverrides).toBeUndefined()
    write(userFile(), {})
    set('vps-notes', 'on', 'personal')
    expect(readLocal().skillOverrides).toBeUndefined()
    // an agent: «on» over the project's «off», removed when it follows
    write(localFile(), { skillOverrides: { digest: 'off' } })
    expect(agentSet('digest', 'account', 'on').payload).toEqual({ skillOverrides: { digest: 'on' } })
    const lines = at('digest', 'account', carried({ skillOverrides: { digest: 'on' } }))
    expect(lineAt(lines, 'agent', 'builder')).toMatchObject({ entry: 'on', result: 'on' })
    expect(lineAt(lines, 'agent', 'writer')).toMatchObject({ result: 'off' })
    expect(agentSet('digest', 'account', 'off', { skillOverrides: { digest: 'on' } })).toMatchObject({ payload: null, held: false })
  })

  it('precedence: flag › local › repository › machine, both ways; managed settings lock every line', () => {
    write(userFile(), { skillOverrides: { brief: 'off' } })
    write(join(folder, '.claude', 'settings.json'), { skillOverrides: { brief: 'name-only' } })
    let lines = at('brief', 'account', carried({ skillOverrides: { brief: 'off' } }))
    expect(lines.map((l) => [l.place, l.entry ?? '-', l.result])).toEqual([
      ['account', '-', 'on'],
      ['machine', 'off', 'off'],
      ['fact', 'name-only', 'name-only'],
      ['project', '-', 'name-only'],
      ['agent', 'off', 'off'],
      ['agent', '-', 'name-only'],
    ])
    write(join(managed, 'managed-settings.json'), { skillOverrides: { brief: 'on' } })
    lines = at('brief', 'account')
    expect(
      lines
        .filter((l) => l.place !== 'account' && l.fact?.who !== 'organization')
        .every((l) => l.locked?.why === 'organization' && l.result === 'on' && !l.positions),
    ).toBe(true)
    expect(refusedWith(() => machineSet('brief', 'account', 'off')).status).toBe(409)
    expect(readUser()).toEqual({ skillOverrides: { brief: 'off' } })
  })

  it('a project skill: no machine line, its agent lines only turn it off, locked while the copy is out of the folder', () => {
    skill(join(folder, '.claude', 'skills'), 'deploy')
    const lines = at('deploy', 'project')
    expect(lineAt(lines, 'machine')).toBeUndefined()
    expect(lineAt(lines, 'project')).toMatchObject({ result: 'on', store: true, positions: ['on', 'off'] })
    expect(lineAt(lines, 'agent', 'builder')?.positions).toEqual(['on', 'off'])
    expect(refusedWith(() => machineSet('deploy', 'project', 'off')).status).toBe(409)
    expect(refusedWith(() => agentSet('deploy', 'project', 'name-only')).status).toBe(409)
    expect(refusedWith(() => set('deploy', 'off', 'personal')).status).toBe(404)
    expect(agentSet('deploy', 'project', 'off').payload).toEqual({ skillOverrides: { deploy: 'off' } })
    expect(() => readFileSync(userFile())).toThrow()
    // held: out in Silos' store — an agent can't bring it back alone
    const held = at('deploy', 'project', {}, { held: true })
    expect(lineAt(held, 'project')).toMatchObject({ entry: 'off', result: 'off' })
    expect(lineAt(held, 'agent', 'builder')).toMatchObject({ result: 'off', locked: { why: 'wider', at: 'project' } })
  })

  it('a skill the engine locks — a plugin’s, a reserved name — has inert lines and no write is attempted; one that disables model invocation does not', () => {
    skill(batchDir(), '__proto__')
    write(userFile(), { skillOverrides: {} })
    const user = readFileSync(userFile(), 'utf8')
    for (const lines of [at('superpowers:brainstorming', 'plugin'), at('__proto__', 'account')]) {
      const places = lines.filter((l) => l.place !== 'account')
      expect(places.map((l) => l.place)).toEqual(['machine', 'project', 'agent', 'agent'])
      expect(places.every((l) => l.locked?.why === 'engine' && l.positions === undefined)).toBe(true)
    }
    expect(refusedWith(() => machineSet('__proto__', 'account', 'off')).status).toBe(409)
    expect(refusedWith(() => agentSet('__proto__', 'account', 'off')).status).toBe(409)
    expect(readFileSync(userFile(), 'utf8')).toBe(user)
    expect(() => readFileSync(localFile())).toThrow()
    // measured (T1): an «off» at user, local and flag tiers hides it — ordinary lines
    write(join(home, '.claude', 'skills', 'manual', 'SKILL.md'), '---\nname: manual\ndescription: by hand only\ndisable-model-invocation: true\n---\nbody\n')
    const manual = at('manual', 'personal')
    expect(manual.every((l) => !l.locked && l.positions?.length === 3)).toBe(true)
    machineSet('manual', 'personal', 'off')
    expect(readUser().skillOverrides).toEqual({ manual: 'off' })
  })

  it('a name two skills share: each line says which copies it reaches; the project’s entry leaves the account copy loading', () => {
    write(localFile(), { skillOverrides: { notes: 'off' } })
    const personal = at('notes', 'personal')
    const account = at('notes', 'account')
    expect(lineAt(personal, 'machine')).toMatchObject({ reaches: ['personal', 'account'], unmeasured: ['account'] })
    expect(lineAt(personal, 'project')).toMatchObject({ reaches: ['personal'], result: 'off' })
    expect(lineAt(personal, 'agent', 'builder')).toMatchObject({ reaches: ['personal', 'account'] })
    expect(lineAt(account, 'project')).toMatchObject({ entry: 'off', result: 'on' }) // measured 23-11
    // a personal skill and a project copy of the same name: the copy is shadowed — said
    skill(join(folder, '.claude', 'skills'), 'vps-notes')
    expect(lineAt(at('vps-notes', 'personal'), 'project')).toMatchObject({ reaches: ['personal', 'project'], unmeasured: ['project'] })
    // a name only one copy has says nothing of copies
    expect(lineAt(at('brief', 'account'), 'project')?.reaches).toBeUndefined()
  })

  it('the briefing’s skill set leaves out what an agent’s or the machine’s entry turns off, keeps what an «on» restores; a heartbeat takes no «on»', () => {
    write(join(home, '.claude.json'), { oauthAccount: { accountUuid: ACC } })
    skill(join(folder, '.claude', 'skills'), 'deploy')
    const turn = (payloads: unknown[], onlyRemoves = false): string[] =>
      sdkTurnSkills(folder, ['user', 'project', 'local'], null, home, managed, carriedSkillKeys(payloads, onlyRemoves))
    expect(turn([])).toEqual(['brief', 'deploy', 'digest', 'notes', 'vps-notes'])
    // the agent's entries: a personal, an account and a project skill off; a shared name both copies
    expect(turn([{ skillOverrides: { 'vps-notes': 'off', brief: 'off', deploy: 'off', notes: 'off' } }])).toEqual(['digest'])
    // the machine's entry
    write(userFile(), { skillOverrides: { digest: 'off' } })
    expect(turn([])).not.toContain('digest')
    // an agent's «on» restores it over the machine's «off» — not in a heartbeat
    expect(turn([{ skillOverrides: { digest: 'on' } }])).toContain('digest')
    expect(turn([{ skillOverrides: { digest: 'on' } }], true)).not.toContain('digest')
    // managed settings above the flag tier
    write(join(managed, 'managed-settings.json'), { skillOverrides: { brief: 'off' } })
    expect(turn([{ skillOverrides: { brief: 'on' } }])).not.toContain('brief')
    // the account's head carried for an agent
    expect(turn([{ syncClaudeAiSkills: false }])).toEqual(['deploy', 'notes', 'vps-notes'])
  })

  it('an agent’s entry is kept by Silos under the skill’s own key, through the folder’s engine; an agent of another folder is 404', async () => {
    const registry = new AgentRegistry(join(base, 'agents.json'))
    registry.load()
    registry.create({ id: 'builder', name: 'Builder', folder, skills: [] })
    registry.create({ id: 'elsewhere', name: 'Elsewhere', folder: join(base, 'other'), skills: [] })
    mkdirSync(join(base, 'data'), { recursive: true })
    const store = new LoadsScopesStore(join(base, 'data'))
    const root = join(base, 'projects')
    mkdirSync(root, { recursive: true })
    const index = claudeSessionIndex(root, join(base, 'cache.json'))
    await index.init()
    const deps = { index, registry, home, managedDir: managed, loadsScopes: store }
    const engine = fallbackHarness().id
    switchFolderSkill(deps, folder, engine, { kind: 'skill', name: 'brief', from: 'account' }, 'off', { scope: 'agent', agent: 'builder' })
    expect(store.get('agents', 'builder', engine)).toMatchObject({ entries: { skillOverrides: { brief: 'off' } }, at: { 'skill:brief': expect.any(Number) } })
    expect(() => readFileSync(localFile())).toThrow()
    const places = folderSkillPlaces(deps, folder, engine, [{ name: 'brief', from: 'account' }])!
    expect(lineAt(places[0]!.lines, 'agent', 'builder')).toMatchObject({ agentName: 'Builder', entry: 'off', result: 'off' })
    expect(
      refusedWith(() =>
        switchFolderSkill(deps, folder, engine, { kind: 'skill', name: 'brief', from: 'account' }, 'off', { scope: 'agent', agent: 'elsewhere' }),
      ).status,
    ).toBe(404)
    // the catalog carries each row's lines
    const svc = new CompleteService(
      registry,
      index,
      join(home, '.claude', 'skills'),
      undefined,
      undefined,
      undefined,
      managed,
      () => ({ skills: claudeLoadsSkills(input()), switches: true }),
      (a, asks) => folderSkillPlaces(deps, a.folder!, engine, asks),
    )
    const cat = await svc.folderCatalog(folder)
    expect(cat.find((e) => e.source === 'account' && e.name === 'brief')?.at?.map((l) => l.place)).toEqual(['account', 'machine', 'project', 'agent'])
    expect(cat.find((e) => e.name === 'vps-notes')?.at?.some((l) => l.place === 'machine')).toBe(true)
  })

  // spec scopes T5 (T9's seam): ONE conversation's line — after its agent's,
  // the conversation's entry wins both ways; kept under its thread only
  it("a conversation follows its agent, overrides it both ways, and its entry is kept under its thread — never the agent's nor a file", async () => {
    const conv = (payload: unknown = null): Partial<LoadsSkillsInput> => ({
      carried: { agents: [{ id: 'builder', payload: { skillOverrides: { digest: 'off' } } }], conversation: { id: 'thread-1', agent: 'builder', payload } },
    })
    // its agent keeps digest off: the conversation follows it, then turns it on here
    expect(lineAt(at('digest', 'account', conv()), 'conversation')).toMatchObject({ result: 'off', conversation: 'thread-1' })
    expect(lineAt(at('digest', 'account', conv()), 'conversation')?.entry).toBeUndefined()
    const on = claudeSkillSwitch(input(conv()), { kind: 'skill', name: 'digest', from: 'account' }, 'on', {
      scope: 'conversation',
      agent: 'builder',
      payload: null,
    }) as LoadsCarriedSwitch
    expect(on).toEqual({ payload: { skillOverrides: { digest: 'on' } }, changed: true, held: true })
    expect(lineAt(at('digest', 'account', conv(on.payload)), 'conversation')).toMatchObject({ entry: 'on', result: 'on' })
    // back to what its agent says: no entry
    expect(
      claudeSkillSwitch(input(conv(on.payload)), { kind: 'skill', name: 'digest', from: 'account' }, 'off', {
        scope: 'conversation',
        agent: 'builder',
        payload: on.payload,
      }),
    ).toMatchObject({ payload: null, held: false })
    // a project skill held out of the folder: locked here, saying where
    expect(
      refusedWith(() =>
        claudeSkillSwitch(
          input({ carried: { agents: [], conversation: { id: 't', payload: null } } }),
          { kind: 'skill', name: 'nope', from: 'project' },
          'off',
          { scope: 'conversation', payload: null },
        ),
      ).status,
    ).toBe(404)
    // through the neutral store: under the thread, never the agent's entries nor a file
    const registry = new AgentRegistry(join(base, 'agents.json'))
    registry.load()
    registry.create({ id: 'builder', name: 'Builder', folder, skills: [] })
    mkdirSync(join(base, 'data'), { recursive: true })
    const store = new LoadsScopesStore(join(base, 'data'))
    const root = join(base, 'projects')
    mkdirSync(root, { recursive: true })
    const index = claudeSessionIndex(root, join(base, 'cache.json'))
    await index.init()
    const deps = { index, registry, home, managedDir: managed, loadsScopes: store }
    const engine = fallbackHarness().id
    const claude = snapshot(join(home, '.claude'))
    switchFolderSkill(deps, folder, engine, { kind: 'skill', name: 'brief', from: 'account' }, 'off', {
      scope: 'conversation',
      conversation: { thread: 'thread-1', agent: 'builder', sessions: ['s1'] },
    })
    expect(store.get('conversations', 'thread-1', engine)).toMatchObject({
      entries: { skillOverrides: { brief: 'off' } },
      at: { 'skill:brief': expect.any(Number) },
    })
    expect(store.get('agents', 'builder', engine)).toBeNull()
    expect(() => readFileSync(localFile())).toThrow()
    expect(snapshot(join(home, '.claude'))).toEqual(claude)
    const places = folderSkillPlaces(deps, folder, engine, [{ name: 'brief', from: 'account' }], { thread: 'thread-1', agent: 'builder', sessions: ['s1'] })!
    expect(lineAt(places[0]!.lines, 'conversation')).toMatchObject({ entry: 'off', result: 'off' })
    // a page (no conversation asked) carries no conversation line
    expect(lineAt(folderSkillPlaces(deps, folder, engine, [{ name: 'brief', from: 'account' }])![0]!.lines, 'conversation')).toBeUndefined()
  })
})
