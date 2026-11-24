import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureRolePluginManifest, rolePluginDir, rolePluginFor, roleSkillNames, roleSkillsDir, withRoleSkills } from '../src/role-plugin.js'

const stateDir = (): string => mkdtempSync(join(tmpdir(), 'role-plugin-'))
const addSkill = (dir: string, name: string): void => {
  mkdirSync(join(dir, 'plugin', 'skills', name), { recursive: true })
  writeFileSync(join(dir, 'plugin', 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: x\n---\n`)
}

describe('roleSkillNames', () => {
  it('lists only directories holding a SKILL.md, sorted; empty when nothing exists', () => {
    const s = stateDir()
    expect(roleSkillNames(s)).toEqual([])
    addSkill(s, 'invoices')
    addSkill(s, 'close-month')
    mkdirSync(join(s, 'plugin', 'skills', 'empty'), { recursive: true }) // no SKILL.md
    writeFileSync(join(s, 'plugin', 'skills', 'README.md'), 'not a skill')
    expect(roleSkillNames(s)).toEqual(['close-month', 'invoices'])
  })
})

describe('rolePluginFor', () => {
  it('null without skills (putting a skill there IS the switch), the plugin dir with one', () => {
    const s = stateDir()
    expect(rolePluginFor('finance', s)).toBeNull()
    addSkill(s, 'invoices')
    expect(rolePluginFor('finance', s)).toBe(join(s, 'plugin'))
  })
  it('the plugin dir for an active own MCP server with no skill; the skills root stays out of the SkillLoad', () => {
    const s = stateDir()
    mkdirSync(join(s, 'plugin'), { recursive: true })
    writeFileSync(join(s, 'plugin', '.mcp.json'), '{"mcpServers":{}}')
    expect(rolePluginFor('finance', s)).toBeNull()
    writeFileSync(join(s, 'plugin', '.mcp.json'), '{"mcpServers":{"books":{"command":"srv"}}}')
    expect(rolePluginFor('finance', s)).toBe(join(s, 'plugin'))
    expect(withRoleSkills({ claudePlugins: false }, 'finance', s)).toEqual({ claudePlugins: false })
    // only the engine file counts: a held server loads nothing
    writeFileSync(join(s, 'plugin', '.mcp.json'), 'not json')
    writeFileSync(join(s, 'plugin', '.silos-held.mcp.json'), '{"mcpServers":{"books":{"command":"srv"}}}')
    expect(rolePluginFor('finance', s)).toBeNull()
  })
  it('null for an unsafe agent id or a missing state dir', () => {
    const s = stateDir()
    addSkill(s, 'invoices')
    expect(rolePluginFor('we{ird', s)).toBeNull()
    expect(rolePluginFor('a/b', s)).toBeNull()
    expect(rolePluginFor('finance', null)).toBeNull()
  })
})

describe('withRoleSkills', () => {
  it("appends the role root (plugin = the agent id) to the engine's SkillLoad only when the role has skills", () => {
    const s = stateDir()
    const load = { claudePlugins: true }
    expect(withRoleSkills(load, 'finance', s)).toEqual(load)
    addSkill(s, 'invoices')
    expect(withRoleSkills(load, 'finance', s)).toEqual({ claudePlugins: true, roots: [{ plugin: 'finance', dir: join(s, 'plugin', 'skills') }] })
    expect(withRoleSkills({ claudePlugins: false, roots: [{ plugin: 'silos', dir: '/x' }] }, 'finance', s).roots).toEqual([
      { plugin: 'silos', dir: '/x' },
      { plugin: 'finance', dir: join(s, 'plugin', 'skills') },
    ])
    expect(withRoleSkills(load, 'finance', null)).toEqual(load)
  })
})

describe('ensureRolePluginManifest', () => {
  it('writes .claude-plugin/plugin.json named as the agent, once, and never overwrites', () => {
    const s = stateDir()
    addSkill(s, 'invoices')
    const dir = rolePluginDir(s)
    ensureRolePluginManifest(dir, 'finance', 'Finance')
    const manifest = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8'))
    expect(manifest.name).toBe('finance')
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), '{"name":"custom"}')
    ensureRolePluginManifest(dir, 'finance', 'Finance')
    expect(JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('custom')
  })
  it('roleSkillsDir points inside the plugin dir', () => {
    const s = stateDir()
    expect(roleSkillsDir(s)).toBe(join(s, 'plugin', 'skills'))
    expect(existsSync(roleSkillsDir(s))).toBe(false)
  })
})
