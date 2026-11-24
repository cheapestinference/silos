// local-holds — every settings file an unattended launch skips rides its
// flag tier for the scopes spec's keys, in both directions, in the engine's
// order (rule 14: the run loads what the screen says, and never more).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { filesCarry, skippedFiles, withFilesCarried } from '../src/harnesses/claude-code/local-holds.js'
import { withLaunchEntries } from '../src/harnesses/claude-code/loads/launch-entries.js'
import { sdkTurnSkills } from '../src/harnesses/claude-code/headless.js'

let root = ''
let folder = ''
let home = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'local-holds-'))
  folder = join(root, 'project')
  home = join(root, 'home')
  mkdirSync(join(folder, '.claude'), { recursive: true })
  mkdirSync(join(home, '.claude'), { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})
const local = (o: unknown): void => writeFileSync(join(folder, '.claude', 'settings.local.json'), JSON.stringify(o))
const user = (o: unknown): void => writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(o))
const repo = (o: unknown): void => writeFileSync(join(folder, '.claude', 'settings.json'), JSON.stringify(o))
const WITH_PROJECT = ['user', 'project']
const USER_ONLY = ['user']
const turn = (base: Record<string, unknown> = {}, sources: string[] = WITH_PROJECT, onlyRemoves = false): Record<string, unknown> =>
  withFilesCarried(base, filesCarry(folder, { sources, home, onlyRemoves }), { onlyRemoves })
const skill = (dir: string, name: string): void => {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\n---\n`)
}
const ACC = '22222222-2222-2222-2222-222222222222'
const batch = (): string => join(home, '.claude', 'skills', 'synced', `11111111-1111-1111-1111-111111111111_${ACC}`)

describe("the files a launch skips, in the engine's order", () => {
  it("with projectSettings the local file rides; without it the repository's, then the local one; reading all, nothing", () => {
    expect(skippedFiles(WITH_PROJECT)).toEqual(['local'])
    expect(skippedFiles(USER_ONLY)).toEqual(['project', 'local'])
    expect(skippedFiles(['user', 'project', 'local'])).toEqual([])
    local({ enabledPlugins: { 'kit@market': false } })
    const base = { disableAllHooks: true }
    expect(withFilesCarried(base, filesCarry(folder, { sources: ['user', 'project', 'local'], home }))).toBe(base)
  })

  it('every key of the local file rides — enabledPlugins true and skillOverrides as written among them', () => {
    user({ enabledPlugins: { 'kit@market': false, 'drive@synced': false }, skillOverrides: { morning: 'off' } })
    local({
      disabledMcpjsonServers: ['mail'],
      enabledPlugins: { 'kit@market': true, 'drive@synced': true, 'old@market': false },
      deniedMcpServers: [{ serverName: 'plugin:kit:files' }, { serverName: 'claude.ai Drive' }],
      syncClaudeAiPlugins: false,
      syncClaudeAiSkills: false,
      disableClaudeAiConnectors: true,
      claudeMdExcludes: ['/home/user/.claude/CLAUDE.md'],
      skillOverrides: { morning: 'name-only', notes: 'on', deploy: 'user-invocable-only', digest: 'off' },
    })
    expect(turn()).toEqual({
      disabledMcpjsonServers: ['mail'],
      enabledPlugins: { 'kit@market': true, 'drive@synced': true, 'old@market': false },
      deniedMcpServers: [{ serverName: 'plugin:kit:files' }, { serverName: 'claude.ai Drive' }],
      syncClaudeAiPlugins: false,
      syncClaudeAiSkills: false,
      disableClaudeAiConnectors: true,
      claudeMdExcludes: ['/home/user/.claude/CLAUDE.md'],
      // a local name-only lifts the machine's «off», as a start that reads the file does
      skillOverrides: { morning: 'name-only', notes: 'on', deploy: 'user-invocable-only', digest: 'off' },
    })
  })

  it("without projectSettings: the repository's file first, the local one over it; lists from both are joined", () => {
    user({ enabledPlugins: { 'kit@market': false } })
    repo({
      enabledPlugins: { 'kit@market': true, 'lint@market': true },
      skillOverrides: { notes: 'off', deploy: 'on' },
      disabledMcpjsonServers: ['db'],
      deniedMcpServers: [{ serverName: 'a' }],
      syncClaudeAiSkills: false,
    })
    local({
      enabledPlugins: { 'lint@market': false },
      skillOverrides: { notes: 'on' },
      disabledMcpjsonServers: ['mail', 'db'],
      deniedMcpServers: [{ serverName: 'a' }, { serverName: 'b' }],
    })
    const s = turn({}, USER_ONLY)
    expect(s.enabledPlugins).toEqual({ 'kit@market': true, 'lint@market': false })
    expect(s.skillOverrides).toEqual({ notes: 'on', deploy: 'on' })
    expect(s.disabledMcpjsonServers).toEqual(['db', 'mail'])
    expect(s.deniedMcpServers).toEqual([{ serverName: 'a' }, { serverName: 'b' }])
    // the engine does not read the account's skills head from the repository's file
    expect('syncClaudeAiSkills' in s).toBe(false)
    // with projectSettings the repository's file is the engine's to read: only the local one rides
    expect(turn({}, WITH_PROJECT).enabledPlugins).toEqual({ 'lint@market': false })
  })

  it('no other key of either file rides: permissions, hooks, env, enableAllProjectMcpServers, an «on» of an off-only kind, an unknown value', () => {
    const hostile = {
      permissions: { allow: ['Bash'] },
      hooks: { Stop: [] },
      env: { A: '1' },
      enableAllProjectMcpServers: true,
      enabledMcpjsonServers: ['mail'],
      apiKeyHelper: '/bin/x',
      syncClaudeAiPlugins: true,
      syncClaudeAiSkills: true,
      disableClaudeAiConnectors: false,
      skillOverrides: { odd: 'sometimes' },
      enabledPlugins: { 'kit@market': 'yes' },
    }
    repo(hostile)
    local(hostile)
    const fence = { permissions: { deny: ['Read(//home/user/.silos/*.json)'] }, disableAllHooks: true }
    expect(turn(fence, USER_ONLY)).toEqual(fence)
  })

  it('no file, a corrupt file or an array carries nothing', () => {
    expect(turn({ a: 1 }, USER_ONLY)).toEqual({ a: 1 })
    writeFileSync(join(folder, '.claude', 'settings.local.json'), '{ not json')
    repo([1, 2])
    expect(turn({ a: 1 }, USER_ONLY)).toEqual({ a: 1 })
  })

  it("a skipped file's override never rides over a file the launch reads above it", () => {
    user({ enabledPlugins: { 'kit@market': true }, skillOverrides: { notes: 'on' }, deniedMcpServers: [{ serverName: 'a' }] })
    repo({ enabledPlugins: { 'kit@market': false }, skillOverrides: { notes: 'off' } })
    // a launch that drops the machine's file but reads the repository's
    const s = turn({}, ['project'])
    expect(s.enabledPlugins).toBeUndefined()
    expect(s.skillOverrides).toBeUndefined()
    expect(s.deniedMcpServers).toEqual([{ serverName: 'a' }])
  })
})

describe('the overlay: what the launch carries, the files, the agent, its thread', () => {
  it('later wins for an override kind, lists are joined, and the fence is untouched', () => {
    repo({ enabledPlugins: { 'kit@market': true, 'style@x': true }, deniedMcpServers: [{ serverName: 'repo' }] })
    local({ enabledPlugins: { 'drive@market': false }, skillOverrides: { notes: 'off' } })
    const base = { permissions: { deny: ['Bash(rm:*)'] }, disableAllHooks: true, enabledPlugins: { 'style@x': false } }
    const agent = {
      enabledPlugins: { 'drive@market': true, 'kit@market': false },
      deniedMcpServers: [{ serverName: 'agent' }],
      skillOverrides: { notes: 'name-only' },
    }
    const thread = { enabledPlugins: { 'kit@market': true }, deniedMcpServers: [{ serverName: 'thread' }], permissions: { allow: ['Bash'] } }
    const s = withLaunchEntries(turn(base, USER_ONLY), [agent, thread])
    expect(s.enabledPlugins).toEqual({ 'style@x': true, 'kit@market': true, 'drive@market': true })
    expect(s.deniedMcpServers).toEqual([{ serverName: 'repo' }, { serverName: 'agent' }, { serverName: 'thread' }])
    expect(s.skillOverrides).toEqual({ notes: 'name-only' })
    expect(s.permissions).toEqual(base.permissions)
  })

  it('a heartbeat, with or without its tools, gets every «off» and no «on» from any place', () => {
    user({ enabledPlugins: { 'kit@market': false }, skillOverrides: { morning: 'off' } })
    repo({ enabledPlugins: { 'lint@market': true, 'old@market': false }, skillOverrides: { notes: 'name-only' }, deniedMcpServers: [{ serverName: 'repo' }] })
    local({ enabledPlugins: { 'kit@market': true }, skillOverrides: { morning: 'on', notes: 'on', deploy: 'off' }, syncClaudeAiPlugins: false })
    const agent = { enabledPlugins: { 'kit@market': true, 'drive@market': false }, skillOverrides: { morning: 'on', digest: 'off' } }
    const thread = { enabledPlugins: { 'lint@market': true }, disabledMcpjsonServers: ['mail'], skillOverrides: { deploy: 'on' } }
    for (const sources of [USER_ONLY, WITH_PROJECT]) {
      const s = withLaunchEntries(turn({ disableAllHooks: true }, sources, true), [agent, thread], { onlyRemoves: true })
      const plugins = s.enabledPlugins as Record<string, boolean>
      expect(Object.values(plugins).every((v) => v === false)).toBe(true)
      expect(plugins['drive@market']).toBe(false)
      expect(s.skillOverrides).toMatchObject({ deploy: 'off', digest: 'off' })
      expect((s.skillOverrides as Record<string, string>).morning).toBeUndefined()
      expect(s.disabledMcpjsonServers).toEqual(['mail'])
      expect(s.syncClaudeAiPlugins).toBe(false)
    }
    // the repository's «off» rides a heartbeat that skips it
    const beat = turn({}, USER_ONLY, true)
    expect(beat.enabledPlugins).toEqual({ 'old@market': false })
    expect(beat.skillOverrides).toEqual({ notes: 'name-only', deploy: 'off' })
    expect(beat.deniedMcpServers).toEqual([{ serverName: 'repo' }])
  })

  it("instruction files and auto memory: the local file's claudeMdExcludes and autoMemoryEnabled ride a launch that skips it; a heartbeat takes only «off»", () => {
    local({ claudeMdExcludes: [join(folder, 'CLAUDE.md')], autoMemoryEnabled: false })
    for (const sources of [USER_ONLY, WITH_PROJECT]) {
      const s = turn({}, sources)
      expect(s.claudeMdExcludes).toEqual([join(folder, 'CLAUDE.md')])
      expect(s.autoMemoryEnabled).toBe(false)
      expect(turn({}, sources, true)).toMatchObject({ claudeMdExcludes: [join(folder, 'CLAUDE.md')], autoMemoryEnabled: false })
    }
    // a launch that reads the local file carries nothing of it
    expect(turn({}, ['user', 'project', 'local'])).toEqual({})
    // «on» over the user file's «off» rides a turn — never a heartbeat
    user({ autoMemoryEnabled: false })
    local({ autoMemoryEnabled: true })
    expect(turn({}, WITH_PROJECT).autoMemoryEnabled).toBe(true)
    expect(turn({}, WITH_PROJECT, true).autoMemoryEnabled).toBeUndefined()
    // the repository's value never rides over the local file the turn reads above it
    repo({ autoMemoryEnabled: false })
    local({ autoMemoryEnabled: true })
    expect(withFilesCarried({}, filesCarry(folder, { sources: ['user', 'local'], home })).autoMemoryEnabled).toBeUndefined()
  })

  it("a launch started in a worktree of the folder carries the folder's own excludes, each said for the worktree's root too", () => {
    local({ claudeMdExcludes: [join(folder, 'CLAUDE.md'), `${folder}/.claude/worktrees/*/CLAUDE.md`] })
    const wt = join(folder, '.claude', 'worktrees', 'fix')
    mkdirSync(wt, { recursive: true })
    expect(filesCarry(wt, { sources: ['user', 'project', 'local'], home }).claudeMdExcludes).toEqual([
      join(folder, 'CLAUDE.md'),
      join(wt, 'CLAUDE.md'),
      `${folder}/.claude/worktrees/*/CLAUDE.md`,
    ])
  })

  it("a heartbeat's carried skill keeps the most restrictive value any file gives: off > user-invocable-only > name-only", () => {
    user({ skillOverrides: { a: 'off', b: 'user-invocable-only' } })
    local({ skillOverrides: { a: 'name-only', b: 'name-only', c: 'name-only' } })
    expect(turn({}, WITH_PROJECT, true).skillOverrides).toEqual({ a: 'off', b: 'user-invocable-only', c: 'name-only' })
  })
})

describe("a skill name two copies share (personal and the account's)", () => {
  beforeEach(() => {
    skill(join(home, '.claude', 'skills'), 'notes')
    skill(join(home, '.claude', 'skills'), 'solo')
    skill(batch(), 'notes')
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: ACC } }))
  })

  it('is carried only where it restricts, at the most restrictive of the files; a name of one copy, as written', () => {
    user({ skillOverrides: { notes: 'off', solo: 'off' } })
    local({ skillOverrides: { notes: 'on', solo: 'on' } })
    // an «on» from the flag tier would reach both copies: not carried
    expect(turn().skillOverrides).toEqual({ solo: 'on' })
    local({ skillOverrides: { notes: 'name-only' } })
    expect(turn().skillOverrides).toEqual({ notes: 'off' })
    user({})
    expect(turn().skillOverrides).toEqual({ notes: 'name-only' })
  })

  it("the briefing's skill set follows the same carry", () => {
    user({ skillOverrides: { solo: 'off' } })
    local({ skillOverrides: { solo: 'on', notes: 'off' } })
    const skills = (sources: string[], onlyRemoves = false): string[] => sdkTurnSkills(folder, sources, null, home, undefined, turn({}, sources, onlyRemoves))
    // read as the local file: the account's notes still loads, solo is lifted
    expect(sdkTurnSkills(folder, ['user', 'project', 'local'], null, home)).toEqual(['notes', 'solo'])
    // carried in a run's flag tier: notes is gone in both copies, solo is lifted as on screen
    expect(skills(WITH_PROJECT)).toEqual(['solo'])
    // a heartbeat: no «on» — solo stays off
    expect(skills(WITH_PROJECT, true)).toEqual([])
    // an agent's entry in the same flag tier counts too
    expect(
      sdkTurnSkills(folder, WITH_PROJECT, null, home, undefined, withLaunchEntries(turn({}, WITH_PROJECT), [{ skillOverrides: { solo: 'off' } }])),
    ).toEqual([])
  })
})

describe('names are data', () => {
  it('__proto__ and constructor are entries, never the prototype', () => {
    writeFileSync(
      join(folder, '.claude', 'settings.local.json'),
      '{"enabledPlugins":{"__proto__":false,"constructor":true},"skillOverrides":{"__proto__":"off","toString":"name-only"}}',
    )
    const s = turn()
    expect(Object.keys(s.enabledPlugins as object)).toEqual(['__proto__', 'constructor'])
    expect(Object.getPrototypeOf(s.enabledPlugins)).toBe(Object.prototype)
    expect(Object.keys(s.skillOverrides as object)).toEqual(['__proto__', 'toString'])
    expect(JSON.parse(JSON.stringify(s)).skillOverrides).toEqual(JSON.parse('{"__proto__":"off","toString":"name-only"}'))
  })
})
