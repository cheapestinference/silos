// contained-writes.test.ts — fourth review round, defect 4: every writer
// that mkdirs then writes under a folder Silos doesn't own outright refuses
// a symlinked component that leads OUTSIDE that folder — never a write (or a
// move, a delete) through it. Reproduced first: with <F>/context → /outside
// and no /outside/shared yet, the first upload wrote /outside/shared/pwn.md.
// One rule (contained-dir.ts), a test per writer and per link position.
// Temp dirs only.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { containedDir, ContainmentError } from '../src/contained-dir.js'
import { safeFileHooks } from '../src/safe-file.js'
import { ContextService } from '../src/context-service.js'
import { activateSkill, addSkill, holdSkill } from '../src/skill-states.js'
import { syncSkillCopies } from '../src/skill-install.js'
import { claudeLoadsSwitch } from '../src/harnesses/claude-code/loads/switch.js'
import { MemoryService } from '../src/memory-service.js'
import { AgentRegistry, mungePath } from '../src/agent-registry.js'

let base: string, F: string, outside: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'contained-'))
  F = join(base, 'proj')
  outside = join(base, 'outside')
  mkdirSync(F, { recursive: true })
  mkdirSync(outside, { recursive: true })
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const empty = (d: string): boolean => readdirSync(d).length === 0

describe('containedDir — the one rule', () => {
  it('creates missing components as real directories and answers the real path', () => {
    expect(containedDir(F, ['a', 'b'], { create: true })).toBe(join(F, 'a', 'b'))
    expect(existsSync(join(F, 'a', 'b'))).toBe(true)
    expect(containedDir(F, ['nope'], { create: false })).toBeNull()
  })

  it('a link leading outside, in any position, refuses — and creates nothing there', () => {
    symlinkSync(outside, join(F, 'context'))
    expect(() => containedDir(F, ['context', 'shared'], { create: true })).toThrow(ContainmentError)
    expect(() => containedDir(F, ['context', 'shared'], { create: false })).toThrow(/leads outside/)
    expect(empty(outside)).toBe(true)
    rmSync(join(F, 'context'))
    mkdirSync(join(F, 'context'))
    symlinkSync(outside, join(F, 'context', 'shared'))
    expect(() => containedDir(F, ['context', 'shared'], { create: true })).toThrow(/context\/shared is a link that leads outside/)
  })

  it('a link that stays inside the folder is followed; a broken link and a file in the way refuse', () => {
    mkdirSync(join(F, 'real-ctx'))
    symlinkSync(join(F, 'real-ctx'), join(F, 'context'))
    expect(containedDir(F, ['context', 'shared'], { create: true })).toBe(join(F, 'real-ctx', 'shared'))
    symlinkSync(join(base, 'gone'), join(F, 'broken'))
    expect(() => containedDir(F, ['broken', 'x'], { create: true })).toThrow(/broken link/)
    writeFileSync(join(F, 'afile'), 'x')
    expect(() => containedDir(F, ['afile', 'x'], { create: true })).toThrow(/not a directory/)
  })

  it('the root itself may be reached through a link (the folder as configured)', () => {
    symlinkSync(F, join(base, 'via'))
    expect(containedDir(join(base, 'via'), ['context'], { create: true })).toBe(join(F, 'context'))
  })
})

describe('ContextService (agent and folder context routes) — save and remove', () => {
  const ctx = new ContextService()
  const pwn = Buffer.from('pwn')

  it('context → outside, no shared yet: the first upload refuses and writes nothing outside (the reproduced escape)', () => {
    symlinkSync(outside, join(F, 'context'))
    expect(() => ctx.save(F, 'shared', '', 'pwn.md', pwn)).toThrow(/leads outside/)
    expect(existsSync(join(outside, 'shared'))).toBe(false)
    expect(empty(outside)).toBe(true)
  })

  it('context → outside with shared already there: refused too', () => {
    mkdirSync(join(outside, 'shared'))
    symlinkSync(outside, join(F, 'context'))
    expect(() => ctx.save(F, 'shared', '', 'pwn.md', pwn)).toThrow(/leads outside/)
    expect(empty(join(outside, 'shared'))).toBe(true)
  })

  it('context/shared → outside and context/<agent> → outside: refused', () => {
    mkdirSync(join(F, 'context'))
    symlinkSync(outside, join(F, 'context', 'shared'))
    symlinkSync(outside, join(F, 'context', 'finance'))
    expect(() => ctx.save(F, 'shared', '', 'pwn.md', pwn)).toThrow(/leads outside/)
    expect(() => ctx.save(F, 'agent', 'finance', 'pwn.md', pwn)).toThrow(/leads outside/)
    expect(empty(outside)).toBe(true)
  })

  it('remove through a link leading outside refuses — the outside file stays', () => {
    writeFileSync(join(outside, 'keep.md'), 'k')
    mkdirSync(join(F, 'context'))
    symlinkSync(outside, join(F, 'context', 'shared'))
    expect(() => ctx.remove(F, 'shared', '', 'keep.md')).toThrow(/leads outside/)
    expect(existsSync(join(outside, 'keep.md'))).toBe(true)
  })

  it('a file name that is itself a link: remove drops the link, never its target; save replaces it', () => {
    writeFileSync(join(outside, 'target.md'), 't')
    mkdirSync(join(F, 'context', 'shared'), { recursive: true })
    symlinkSync(join(outside, 'target.md'), join(F, 'context', 'shared', 'l.md'))
    ctx.save(F, 'shared', '', 'l.md', Buffer.from('mine'))
    expect(readFileSync(join(outside, 'target.md'), 'utf8')).toBe('t')
    symlinkSync(join(outside, 'target.md'), join(F, 'context', 'shared', 'l2.md'))
    ctx.remove(F, 'shared', '', 'l2.md')
    expect(existsSync(join(outside, 'target.md'))).toBe(true)
  })

  it('race (sixth review round): context/shared swapped for a link outside while the upload is written — refused, nothing outside', () => {
    mkdirSync(join(F, 'context', 'shared'), { recursive: true })
    safeFileHooks.afterOpen = () => {
      renameSync(join(F, 'context', 'shared'), join(F, 'context', 'shared.real'))
      symlinkSync(outside, join(F, 'context', 'shared'))
    }
    try {
      expect(() => ctx.save(F, 'shared', '', 'pwn.md', pwn)).toThrow(/became a link|not where Silos verified it/)
    } finally {
      safeFileHooks.afterOpen = null
    }
    expect(empty(outside)).toBe(true)
  })

  it('plain folders still work, and a link within the folder is followed', () => {
    expect(ctx.save(F, 'shared', '', 'a.md', pwn).path).toBe(join(F, 'context', 'shared', 'a.md'))
    const G = join(base, 'g')
    mkdirSync(join(G, 'inner'), { recursive: true })
    symlinkSync(join(G, 'inner'), join(G, 'context'))
    ctx.save(G, 'shared', '', 'b.md', pwn)
    expect(existsSync(join(G, 'inner', 'shared', 'b.md'))).toBe(true)
    ctx.remove(G, 'shared', '', 'b.md')
    expect(existsSync(join(G, 'inner', 'shared', 'b.md'))).toBe(false)
  })
})

describe('skill states (hold / activate / add) and the autonomy install/sync', () => {
  let data: string, plugin: string
  beforeEach(() => {
    data = join(base, 'data')
    plugin = join(base, 'plugin')
    for (const n of ['team-plan', 'heartbeat', 'responsibility', 'extra']) {
      mkdirSync(join(plugin, n), { recursive: true })
      writeFileSync(join(plugin, n, 'SKILL.md'), `---\ndescription: ${n}\n---\nx`)
    }
  })

  it('.claude → outside: add refuses and copies nothing outside', () => {
    symlinkSync(outside, join(F, '.claude'))
    expect(() => addSkill(plugin, data, F, 'team-plan')).toThrow(/leads outside/)
    expect(empty(outside)).toBe(true)
  })

  it('.claude/skills → outside: hold never moves the outside skill, activate never lands outside', () => {
    mkdirSync(join(outside, 'theirs'))
    writeFileSync(join(outside, 'theirs', 'SKILL.md'), 'x')
    mkdirSync(join(F, '.claude'))
    symlinkSync(outside, join(F, '.claude', 'skills'))
    expect(() => holdSkill(data, F, 'theirs')).toThrow(/leads outside/)
    expect(existsSync(join(outside, 'theirs', 'SKILL.md'))).toBe(true)
    // a held copy (put there by an earlier, legitimate hold) never moves out
    rmSync(join(F, '.claude', 'skills'))
    mkdirSync(join(F, '.claude', 'skills', 'mine'), { recursive: true })
    writeFileSync(join(F, '.claude', 'skills', 'mine', 'SKILL.md'), 'x')
    holdSkill(data, F, 'mine')
    rmSync(join(F, '.claude', 'skills'), { recursive: true })
    symlinkSync(outside, join(F, '.claude', 'skills'))
    expect(() => activateSkill(data, F, 'mine')).toThrow(/leads outside/)
    expect(existsSync(join(outside, 'mine'))).toBe(false)
  })

  it('syncSkillCopies leaves a symlinked .claude/skills leading outside alone', () => {
    mkdirSync(join(F, '.claude'))
    symlinkSync(outside, join(F, '.claude', 'skills'))
    expect(empty(outside)).toBe(true)
    // an older copy sitting outside is never rewritten through the link
    mkdirSync(join(outside, 'team-plan'))
    writeFileSync(join(outside, 'team-plan', 'SKILL.md'), 'old')
    expect(syncSkillCopies(plugin, F)).toEqual([])
    expect(readFileSync(join(outside, 'team-plan', 'SKILL.md'), 'utf8')).toBe('old')
  })

  it('plain folders: add lands in the folder', () => {
    addSkill(plugin, data, F, 'extra')
    expect(existsSync(join(F, '.claude', 'skills', 'extra', 'SKILL.md'))).toBe(true)
  })
})

describe('MCP hold — <folder>/.claude/settings.local.json', () => {
  const hold = (folder: string, name: string): void =>
    claudeLoadsSwitch(
      { folder, home: join(base, 'home'), managedDir: join(base, 'no-managed'), recentTranscripts: [], seenToolIds: [], readings: [] },
      `mcp:project:${name}`,
      'off',
    )
  beforeEach(() => writeFileSync(join(F, '.mcp.json'), JSON.stringify({ mcpServers: { github: { type: 'http', url: 'https://gh.example' } } })))

  it('.claude → outside: the hold refuses and writes no settings outside', () => {
    symlinkSync(outside, join(F, '.claude'))
    expect(() => hold(F, 'github')).toThrow(/leads outside/)
    expect(empty(outside)).toBe(true)
  })

  it('a plain folder: the settings land in the folder', () => {
    hold(F, 'github')
    expect(JSON.parse(readFileSync(join(F, '.claude', 'settings.local.json'), 'utf8'))).toBeTruthy()
  })
})

describe('memory writes resolve every existing ancestor before creating anything (pinned)', () => {
  it('an auto-memory dir linked outside is refused — nothing written there', async () => {
    const root = join(base, 'projects')
    const data = join(base, 'mdata')
    mkdirSync(join(root, mungePath(F)), { recursive: true })
    mkdirSync(data, { recursive: true })
    symlinkSync(outside, join(root, mungePath(F), 'memory'))
    const registry = new AgentRegistry(join(data, 'agents.json'))
    registry.load()
    registry.create({ id: 'writer', name: 'Writer', folder: F })
    const memory = new MemoryService(root, data, registry)
    await expect(memory.write(join(root, mungePath(F), 'memory', 'pwn.md'), 'x')).rejects.toThrow(/not allowed/)
    expect(empty(outside)).toBe(true)
  })
})
