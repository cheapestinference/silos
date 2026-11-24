// skill-held-engines.test.ts — "held" means OFF on BOTH engines.
//   Claude Code: the engine loads <folder>/.claude/skills; a held skill has
//     been moved out, so the folder no longer carries it (activeSkillNames —
//     what the SDK turn's emphasis line derives from) and nothing else hands
//     it to the engine.
//   OpenCode: every launch ALSO hands Silos' plugin/skills as a skills.paths
//     root, so moving the folder copy alone left the skill loaded — active
//     and held at once. The launch config now denies each held name through
//     OpenCode's own gate, permission.skill (assemble.ts).
// Temp dirs only — never the real ~/.silos or a project folder.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentStateStore } from '../src/agent-state.js'
import { activeSkillNames, holdSkill } from '../src/skill-states.js'
import {
  assembleOpencode,
  deniableHeldSkills,
  heldSkillsFor,
  opencodeLoadsPersonalSkills,
  skillNamesIn,
  withHeldSkillsDenied,
} from '../src/harnesses/opencode/assemble.js'
import { defaultSkillsPath } from '../src/harnesses/opencode/launch.js'
import { briefingText } from '../src/harnesses/briefing.js'
import type { Agent } from '../src/types.js'

let base: string, dataDir: string, folder: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'held-engines-'))
  dataDir = join(base, 'data')
  folder = join(base, 'project')
  for (const n of ['team-plan', 'heartbeat']) {
    mkdirSync(join(folder, '.claude', 'skills', n), { recursive: true })
    writeFileSync(join(folder, '.claude', 'skills', n, 'SKILL.md'), `---\nname: ${n}\ndescription: ${n}\n---\n`)
  }
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

const agent = (framework: 'opencode' | 'claude-code'): Agent => ({ id: 'oc', name: 'Oc', folder, skills: [], framework }) as unknown as Agent

function assemble(carried?: unknown[]): { permission?: Record<string, unknown>; skills?: { paths: string[] } } {
  const agentState = new AgentStateStore(join(dataDir, 'agent-state'))
  const a = agent('opencode')
  const out = assembleOpencode({ agents: () => [a], agentState, dataDir, home: base, silosApi: 'http://127.0.0.1:1' }, a, folder, {
    provider: null,
    model: null,
    ...(carried ? { carried } : {}),
  })
  return JSON.parse(out.configContent) as { permission?: Record<string, unknown>; skills?: { paths: string[] } }
}

describe('held = off on Claude Code', () => {
  it('a held skill is no longer among the skills the folder loads', () => {
    expect(activeSkillNames(folder)).toEqual(['heartbeat', 'team-plan'])
    holdSkill(dataDir, folder, 'team-plan')
    expect(activeSkillNames(folder)).toEqual(['heartbeat'])
  })
})

describe('held = off on OpenCode', () => {
  it('nothing held: the launch config carries no skill permission (no key invented)', () => {
    const cfg = assemble()
    expect(cfg.skills?.paths.length).toBe(1) // Silos' plugin/skills root, as always
    expect(cfg.permission).toBeUndefined()
  })

  it("a held skill is DENIED in the launch config — the plugin/skills root can't bring it back", () => {
    holdSkill(dataDir, folder, 'team-plan')
    const cfg = assemble()
    expect(cfg.skills?.paths.length).toBe(1)
    expect(cfg.permission).toEqual({ skill: { 'team-plan': 'deny' } })
  })

  it('every held name is denied, after any earlier rule (last match wins), without dropping the fence rules', () => {
    const fenced = { edit: { '*': 'allow' as const }, skill: { 'team-*': 'allow' as const, 'team-plan': 'allow' as const } }
    const out = withHeldSkillsDenied(fenced, ['heartbeat', 'team-plan'])
    expect(out?.edit).toEqual({ '*': 'allow' })
    expect(Object.entries(out?.skill as Record<string, string>)).toEqual([
      ['team-*', 'allow'],
      ['heartbeat', 'deny'],
      ['team-plan', 'deny'],
    ])
    // a bare action becomes the catch-all it meant, and the denies still come last
    expect(Object.entries(withHeldSkillsDenied({ skill: 'allow' }, ['x'])?.skill as Record<string, string>)).toEqual([
      ['*', 'allow'],
      ['x', 'deny'],
    ])
    expect(withHeldSkillsDenied(null, [])).toBeNull()
  })

  it("held names come from the agent's folder (and a different launch cwd's own store)", () => {
    holdSkill(dataDir, folder, 'heartbeat')
    expect(heldSkillsFor(dataDir, agent('opencode'), folder)).toEqual(['heartbeat'])
    const wt = join(base, 'worktree')
    mkdirSync(join(wt, '.claude', 'skills', 'solo'), { recursive: true })
    writeFileSync(join(wt, '.claude', 'skills', 'solo', 'SKILL.md'), '---\nname: solo\n---\n')
    holdSkill(dataDir, wt, 'solo')
    expect(heldSkillsFor(dataDir, agent('opencode'), wt)).toEqual(['heartbeat', 'solo'])
  })
})

// OpenCode filters skills BY NAME, and loads the operator's ~/.claude/skills
// by default: denying a held name that also exists as a personal skill would
// turn the personal one off too — Silos never does. The launch
// leaves such a name loading; the catalog says so on the held row.
describe('a held name with a personal twin on OpenCode', () => {
  const personal = (n: string): void => {
    mkdirSync(join(base, '.claude', 'skills', n), { recursive: true })
    writeFileSync(join(base, '.claude', 'skills', n, 'SKILL.md'), `---\nname: ${n}\n---\n`)
  }

  it('is NOT denied (the personal copy keeps loading); the other held names still are', () => {
    holdSkill(dataDir, folder, 'team-plan')
    holdSkill(dataDir, folder, 'heartbeat')
    personal('team-plan')
    const cfg = assemble()
    expect(cfg.permission).toEqual({ skill: { heartbeat: 'deny' } })
  })

  it("is denied when OpenCode's own env switches stop it loading personal skills", () => {
    personal('team-plan')
    expect(deniableHeldSkills(['team-plan', 'heartbeat'], base, false)).toEqual(['team-plan', 'heartbeat'])
    expect(deniableHeldSkills(['team-plan', 'heartbeat'], base, true)).toEqual(['heartbeat'])
  })

  it('the env switches OpenCode 1.19.4 reads (true/1/yes/on) — any one of the three', () => {
    expect(opencodeLoadsPersonalSkills({})).toBe(true)
    expect(opencodeLoadsPersonalSkills({ OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1' })).toBe(false)
    expect(opencodeLoadsPersonalSkills({ OPENCODE_DISABLE_CLAUDE_CODE: 'true' })).toBe(false)
    expect(opencodeLoadsPersonalSkills({ OPENCODE_DISABLE_EXTERNAL_SKILLS: 'Yes' })).toBe(false)
    expect(opencodeLoadsPersonalSkills({ OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '0' })).toBe(true)
  })
})

// OpenCode's briefing names the skills its skills.paths
// hand it — a held (denied) one gets its .without recipe instead.
describe('the OpenCode briefing follows its skills.paths', () => {
  const contextMd = () => readFileSync(join(dataDir, 'agent-state', 'oc', 'opencode', 'context.md'), 'utf8')
  it('every Silos skill rides skills.paths: every .with fragment', () => {
    assemble()
    expect(contextMd().startsWith(briefingText(skillNamesIn([defaultSkillsPath()])))).toBe(true)
    expect(contextMd()).toContain('`team-plan` skill')
  })
  it('a held team-plan is denied, so the briefing carries the recipe without the skill', () => {
    holdSkill(dataDir, folder, 'team-plan')
    assemble()
    expect(contextMd().startsWith(briefingText(skillNamesIn([defaultSkillsPath()]).filter((n) => n !== 'team-plan')))).toBe(true)
    expect(contextMd()).not.toContain('`team-plan` skill')
    // (the briefing trim, on purpose) without the skill the Tasks rule names
    // the file that holds the claim recipe instead of carrying it
    const ref = /`([^`]+\/reference\/tasks\.md)`/.exec(contextMd())?.[1]
    expect(ref && readFileSync(ref, 'utf8')).toContain('/api/tasks/claim')
  })
  it("a deny a launch place carries (an agent's, a conversation's) is not named either", () => {
    const withoutTeamPlan = briefingText(skillNamesIn([defaultSkillsPath()]).filter((n) => n !== 'team-plan'))
    expect((assemble([{ permission: { skill: { 'team-plan': 'deny' } } }]).permission as { skill: Record<string, string> }).skill['team-plan']).toBe('deny')
    expect(contextMd().startsWith(withoutTeamPlan)).toBe(true)
    // nothing denied: the briefing as before
    assemble([{ mcp: { docs: { enabled: false } } }])
    expect(contextMd().startsWith(briefingText(skillNamesIn([defaultSkillsPath()])))).toBe(true)
  })
})

describe('role skills on OpenCode (role-plugin.ts)', () => {
  it("a role with skills: its plugin/skills joins skills.paths after Silos' own; without skills it does not", () => {
    expect(assemble().skills!.paths).toHaveLength(1)
    const roleSkill = join(dataDir, 'agent-state', 'oc', 'plugin', 'skills', 'invoices')
    mkdirSync(roleSkill, { recursive: true })
    writeFileSync(join(roleSkill, 'SKILL.md'), '---\nname: invoices\ndescription: x\n---\n')
    const paths = assemble().skills!.paths
    expect(paths).toHaveLength(2)
    expect(paths[1]).toBe(join(dataDir, 'agent-state', 'oc', 'plugin', 'skills'))
  })
})
