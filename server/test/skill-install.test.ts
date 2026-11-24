import { describe, expect, it } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { SkillCopyFollower, skillReleaseStamp, staleSkillCopies, syncSkillCopies } from '../src/skill-install.js'
import { heldDirFor, holdSkill } from '../src/skill-states.js'
import { skillTreeHash } from '../src/skill-releases.js'

function fixture() {
  const src = mkdtempSync(join(tmpdir(), 'plugin-'))
  for (const name of ['responsibility', 'heartbeat', 'team-plan']) {
    mkdirSync(join(src, name), { recursive: true })
    writeFileSync(join(src, name, 'SKILL.md'), `# ${name}\n`)
  }
  const folder = mkdtempSync(join(tmpdir(), 'agent-'))
  return { src, folder, dataDir: mkdtempSync(join(tmpdir(), 'data-')) }
}

describe("syncSkillCopies — an untouched older release follows Silos, an edited copy stays the operator's", () => {
  const sha = (t: string): string => createHash('sha256').update(t).digest('hex')
  function shipped(releases: Record<string, string[]>) {
    const { src, folder, dataDir } = fixture()
    writeFileSync(join(src, 'releases.json'), JSON.stringify(releases))
    const put = (name: string, text: string): void => {
      mkdirSync(join(folder, '.claude', 'skills', name), { recursive: true })
      writeFileSync(join(folder, '.claude', 'skills', name, 'SKILL.md'), text)
    }
    const read = (name: string): string => readFileSync(join(folder, '.claude', 'skills', name, 'SKILL.md'), 'utf8')
    return { src, folder, put, read, dataDir }
  }

  it('replaces a copy whose text Silos once shipped, keeps an edited one, leaves an absent one absent', () => {
    const { src, folder, put, read } = shipped({
      'team-plan': [sha('old plan v1\n'), sha('# team-plan\n')],
      heartbeat: [sha('# heartbeat\n')],
    })
    put('team-plan', 'old plan v1\n')
    put('heartbeat', 'my own heartbeat\n')
    const r = syncSkillCopies(src, folder)
    expect(r).toEqual([
      { name: 'heartbeat', state: 'edited' },
      { name: 'team-plan', state: 'updated' },
    ])
    expect(read('team-plan')).toBe('# team-plan\n')
    expect(read('heartbeat')).toBe('my own heartbeat\n')
    expect(existsSync(join(folder, '.claude', 'skills', 'responsibility'))).toBe(false)
    expect(syncSkillCopies(src, folder)).toContainEqual({ name: 'team-plan', state: 'current' })
  })

  // a repo that is itself an agent folder links the skill it ships
  // (.claude/skills/team-plan → ../../plugin/skills/team-plan) instead of
  // copying it: the link is the operator's structure, never rewritten
  it('a skill that is a symlink is never replaced: current while it points at what Silos ships, left alone otherwise', () => {
    const { src, folder, dataDir } = shipped({ 'team-plan': [sha('old plan v1\n'), sha('# team-plan\n')] })
    const skills = join(folder, '.claude', 'skills')
    mkdirSync(skills, { recursive: true })
    const link = join(skills, 'team-plan')
    symlinkSync(join(src, 'team-plan'), link)
    expect(syncSkillCopies(src, folder, dataDir)).toEqual([{ name: 'team-plan', state: 'current' }])
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    // the same link pointing at an older release elsewhere (a worktree at another commit)
    const older = join(folder, 'older', 'team-plan')
    mkdirSync(older, { recursive: true })
    writeFileSync(join(older, 'SKILL.md'), 'old plan v1\n')
    rmSync(link)
    symlinkSync(older, link)
    expect(syncSkillCopies(src, folder, dataDir)).toEqual([{ name: 'team-plan', state: 'edited' }])
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(older, 'SKILL.md'), 'utf8')).toBe('old plan v1\n')
  })

  it('without a manifest nothing is recognised, so nothing is overwritten', () => {
    const { src, folder } = fixture()
    mkdirSync(join(folder, '.claude', 'skills', 'team-plan'), { recursive: true })
    writeFileSync(join(folder, '.claude', 'skills', 'team-plan', 'SKILL.md'), 'old plan v1\n')
    expect(syncSkillCopies(src, folder)).toEqual([{ name: 'team-plan', state: 'edited' }])
    expect(readFileSync(join(folder, '.claude', 'skills', 'team-plan', 'SKILL.md'), 'utf8')).toBe('old plan v1\n')
  })
})

// copies used to follow Silos only at boot and only in the
// folder — a merge without a restart left them stale, a held copy came back
// on with its old text, and a personal copy (never Silos' to write) was
// never named.
describe('SkillCopyFollower — copies follow each release, held ones too; personal ones are only named', () => {
  const sha = (t: string): string => createHash('sha256').update(t).digest('hex')
  function world() {
    const src = mkdtempSync(join(tmpdir(), 'plugin-'))
    mkdirSync(join(src, 'team-plan'), { recursive: true })
    writeFileSync(join(src, 'team-plan', 'SKILL.md'), 'v2\n')
    writeFileSync(join(src, 'releases.json'), JSON.stringify({ 'team-plan': [sha('v1\n'), sha('v2\n')] }))
    const folder = mkdtempSync(join(tmpdir(), 'agent-'))
    const dataDir = mkdtempSync(join(tmpdir(), 'data-'))
    const personal = mkdtempSync(join(tmpdir(), 'personal-'))
    const at = (root: string, text: string): string => {
      mkdirSync(join(root, 'team-plan'), { recursive: true })
      writeFileSync(join(root, 'team-plan', 'SKILL.md'), text)
      return join(root, 'team-plan', 'SKILL.md')
    }
    const lines: string[] = []
    const follower = new SkillCopyFollower({
      pluginSkillsDir: src,
      dataDir,
      folders: () => [folder],
      personalRoots: () => [personal, personal],
      log: (l) => {
        lines.push(l)
      },
    })
    return { src, folder, dataDir, personal, at, lines, follower }
  }

  it('a held untouched release is brought current (where: held); an edited held copy stays', () => {
    const { src, folder, dataDir, at } = world()
    at(join(folder, '.claude', 'skills'), 'v1\n')
    holdSkill(dataDir, folder, 'team-plan')
    const held = join(heldDirFor(dataDir, folder), 'team-plan', 'SKILL.md')
    expect(syncSkillCopies(src, folder, dataDir)).toEqual([{ name: 'team-plan', state: 'updated', where: 'held' }])
    expect(readFileSync(held, 'utf8')).toBe('v2\n')
    writeFileSync(held, 'mine\n')
    expect(syncSkillCopies(src, folder, dataDir)).toEqual([{ name: 'team-plan', state: 'edited', where: 'held' }])
    expect(readFileSync(held, 'utf8')).toBe('mine\n')
  })

  it('tick runs a pass at first, then only when plugin/skills (or the folders) change', () => {
    const { src, folder, at, follower, lines } = world()
    const copy = at(join(folder, '.claude', 'skills'), 'v1\n')
    expect(follower.tick()).toBe(true)
    expect(readFileSync(copy, 'utf8')).toBe('v2\n')
    expect(follower.tick()).toBe(false)
    // a new release lands (a merge): the copy follows on the next tick
    writeFileSync(join(src, 'team-plan', 'SKILL.md'), 'v3 longer\n')
    writeFileSync(join(src, 'releases.json'), JSON.stringify({ 'team-plan': [sha('v1\n'), sha('v2\n'), sha('v3 longer\n')] }))
    expect(follower.tick()).toBe(true)
    expect(readFileSync(copy, 'utf8')).toBe('v3 longer\n')
    expect(lines.filter((l) => l.startsWith('skills updated in'))).toHaveLength(2)
  })

  it('a stale personal copy is named once and never written; an unknown text or the current one is not named', () => {
    const { src, personal, at, follower, lines } = world()
    const copy = at(personal, 'v1\n')
    follower.tick()
    expect(readFileSync(copy, 'utf8')).toBe('v1\n')
    const stale = lines.filter((l) => l.includes('older Silos release of team-plan'))
    expect(stale).toHaveLength(1) // the same root twice is read once
    expect(stale[0]).toContain(join(personal, 'team-plan'))
    expect(staleSkillCopies(src, [personal])).toEqual([{ name: 'team-plan', dir: join(personal, 'team-plan') }])
    writeFileSync(copy, 'my own team-plan\n')
    expect(staleSkillCopies(src, [personal])).toEqual([])
    writeFileSync(copy, 'v2\n')
    expect(staleSkillCopies(src, [personal])).toEqual([])
  })

  it('the release stamp moves when a SKILL.md or releases.json changes', () => {
    const { src } = world()
    const a = skillReleaseStamp(src)
    expect(skillReleaseStamp(src)).toBe(a)
    writeFileSync(join(src, 'team-plan', 'SKILL.md'), 'v2 but longer\n')
    expect(skillReleaseStamp(src)).not.toBe(a)
  })
})

describe("a copy Silos itself wrote stays Silos' own (skill-copies-written.json)", () => {
  it('a text synced mid-edit — in no release — is still updated on the next pass, not called edited', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const base = mkdtempSync(join(tmpdir(), 'written-'))
    const plugin = join(base, 'plugin')
    const folder = join(base, 'proj')
    const data = join(base, 'data')
    mkdirSync(join(plugin, 'demo'), { recursive: true })
    mkdirSync(join(folder, '.claude', 'skills', 'demo'), { recursive: true })
    mkdirSync(data)
    writeFileSync(join(plugin, 'releases.json'), JSON.stringify({ demo: [] }))
    writeFileSync(join(folder, '.claude', 'skills', 'demo', 'SKILL.md'), 'mid-edit text')
    writeFileSync(join(plugin, 'demo', 'SKILL.md'), 'mid-edit text')
    expect(syncSkillCopies(plugin, folder, data).map((c) => c.state)).toEqual(['current'])
    writeFileSync(join(plugin, 'demo', 'SKILL.md'), 'final text')
    expect(syncSkillCopies(plugin, folder, data).map((c) => c.state)).toEqual(['updated'])
    expect(readFileSync(join(folder, '.claude', 'skills', 'demo', 'SKILL.md'), 'utf8')).toBe('final text')
    writeFileSync(join(folder, '.claude', 'skills', 'demo', 'SKILL.md'), 'the operator wrote this')
    expect(syncSkillCopies(plugin, folder, data).map((c) => c.state)).toEqual(['edited'])
  })
})

// a sync REPLACES the whole skill directory, so the hash that decides
// «untouched older release» covers the whole directory too — an operator's
// edit to a file beside SKILL.md is theirs, and a file a release added or
// changed beside it is part of that release. A skill that is only its
// SKILL.md hashes as before (the migration: no install changes state).
describe('the skill hash covers what a sync replaces — the whole directory', () => {
  const sha = (t: string): string => createHash('sha256').update(t).digest('hex')
  function multi() {
    const src = mkdtempSync(join(tmpdir(), 'plugin-'))
    mkdirSync(join(src, 'tool', 'scripts'), { recursive: true })
    writeFileSync(join(src, 'tool', 'SKILL.md'), '# tool v2\n')
    writeFileSync(join(src, 'tool', 'scripts', 'run.sh'), 'echo v2\n')
    const folder = mkdtempSync(join(tmpdir(), 'agent-'))
    const copy = join(folder, '.claude', 'skills', 'tool')
    const put = (skill: string, script: string | null): void => {
      rmSync(copy, { recursive: true, force: true })
      mkdirSync(join(copy, 'scripts'), { recursive: true })
      writeFileSync(join(copy, 'SKILL.md'), skill)
      if (script !== null) writeFileSync(join(copy, 'scripts', 'run.sh'), script)
    }
    return { src, folder, copy, put }
  }

  it("a skill that is only SKILL.md hashes to that file's sha256 — every existing release and record still matches", () => {
    const d = mkdtempSync(join(tmpdir(), 'one-'))
    writeFileSync(join(d, 'SKILL.md'), '# only\n')
    expect(skillTreeHash(d)).toBe(sha('# only\n'))
    expect(skillTreeHash(mkdtempSync(join(tmpdir(), 'none-')))).toBeNull()
  })

  it("an edit to a file beside SKILL.md makes the copy the operator's: never overwritten", () => {
    const { src, folder, copy, put } = multi()
    put('# tool v1\n', 'echo v1\n')
    const v1 = skillTreeHash(copy)!
    writeFileSync(join(src, 'releases.json'), JSON.stringify({ tool: [v1, skillTreeHash(join(src, 'tool'))] }))
    put('# tool v1\n', 'echo mine\n') // SKILL.md untouched, the script edited
    expect(syncSkillCopies(src, folder)).toEqual([{ name: 'tool', state: 'edited' }])
    expect(readFileSync(join(copy, 'scripts', 'run.sh'), 'utf8')).toBe('echo mine\n')
  })

  it('an untouched older release follows — its other files too; a release that only changed a script is still a change', () => {
    const { src, folder, copy, put } = multi()
    put('# tool v2\n', 'echo v1\n') // same SKILL.md as now, older script
    const old = skillTreeHash(copy)!
    writeFileSync(join(src, 'releases.json'), JSON.stringify({ tool: [old, skillTreeHash(join(src, 'tool'))] }))
    expect(syncSkillCopies(src, folder)).toEqual([{ name: 'tool', state: 'updated' }])
    expect(readFileSync(join(copy, 'scripts', 'run.sh'), 'utf8')).toBe('echo v2\n')
    expect(syncSkillCopies(src, folder)).toEqual([{ name: 'tool', state: 'current' }])
  })

  it('a file added to or removed from the tree changes its hash', () => {
    const { copy, put } = multi()
    put('# tool v2\n', 'echo v2\n')
    const a = skillTreeHash(copy)
    writeFileSync(join(copy, 'extra.md'), 'x')
    expect(skillTreeHash(copy)).not.toBe(a)
    put('# tool v2\n', null)
    expect(skillTreeHash(copy)).not.toBe(a)
  })

  it('the release stamp moves when a file beside SKILL.md changes', () => {
    const { src } = multi()
    const a = skillReleaseStamp(src)
    writeFileSync(join(src, 'tool', 'scripts', 'run.sh'), 'echo v3 longer\n')
    expect(skillReleaseStamp(src)).not.toBe(a)
  })
})
