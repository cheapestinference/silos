// skill-states.test.ts — the three states of a (skill, folder): hold moves
// the folder copy to <dataDir>/skills-held/<folderKey>/, activate moves it
// back, add copies a plugin skill in. Temp dirs only — never the real
// ~/.silos or ~/.claude.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mungePath } from '../src/agent-registry.js'
import {
  activateSkill,
  activeSkillNames,
  addSkill,
  heldDirFor,
  heldSkills,
  heldStoreFolder,
  holdSkill,
  moveDir,
  preludeSkillNames,
  silosSkillNames,
} from '../src/skill-states.js'
import { syncSkillCopies } from '../src/skill-install.js'

let base: string, dataDir: string, folder: string, plugin: string
const dirs: string[] = []

function mkSkill(root: string, name: string, description = `does ${name}`): void {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, 'SKILL.md'), `---\ndescription: ${description}\n---\nbody of ${name}\n`)
  writeFileSync(join(root, name, 'extra.txt'), 'sidecar')
}

const skillsRoot = (f: string): string => join(f, '.claude', 'skills')

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'skill-states-'))
  dirs.push(base)
  dataDir = join(base, 'data')
  folder = join(base, 'project')
  plugin = join(base, 'plugin-skills')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(skillsRoot(folder), { recursive: true })
  mkdirSync(plugin, { recursive: true })
})

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('holdSkill', () => {
  it('moves the whole skill directory into the held store — nothing left in the folder', () => {
    mkSkill(skillsRoot(folder), 'team-plan')
    holdSkill(dataDir, folder, 'team-plan')
    expect(existsSync(join(skillsRoot(folder), 'team-plan'))).toBe(false)
    const held = join(heldDirFor(dataDir, folder), 'team-plan')
    expect(readFileSync(join(held, 'SKILL.md'), 'utf8')).toContain('body of team-plan')
    expect(readFileSync(join(held, 'extra.txt'), 'utf8')).toBe('sidecar') // the whole dir, not just SKILL.md
  })

  it('refuses a skill that is not in the folder, with clear words', () => {
    expect(() => holdSkill(dataDir, folder, 'ghost')).toThrow(/"ghost" is not in .*nothing to turn off/)
  })

  it('refuses when a held copy of that name already exists', () => {
    mkSkill(skillsRoot(folder), 'dup')
    holdSkill(dataDir, folder, 'dup')
    mkSkill(skillsRoot(folder), 'dup') // a copy reappears in the folder
    expect(() => holdSkill(dataDir, folder, 'dup')).toThrow(/held copy of "dup" already exists/)
  })

  it('validates the name: separators, dots-only and empty are rejected before touching disk', () => {
    for (const bad of ['..', '.', '...', 'a/b', 'a\\b', '', 'a b']) {
      expect(() => holdSkill(dataDir, folder, bad)).toThrow(/invalid skill name/)
    }
  })

  it('a skill dir that is a symlink out of the folder is refused (realpath containment)', () => {
    const outside = join(base, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'SKILL.md'), 'secret')
    symlinkSync(outside, join(skillsRoot(folder), 'evil'))
    expect(() => holdSkill(dataDir, folder, 'evil')).toThrow(/resolves outside/)
    expect(existsSync(join(outside, 'SKILL.md'))).toBe(true) // the target was never moved
  })
})

describe('activateSkill', () => {
  it('moves a held skill back into the folder', () => {
    mkSkill(skillsRoot(folder), 'heartbeat')
    holdSkill(dataDir, folder, 'heartbeat')
    activateSkill(dataDir, folder, 'heartbeat')
    expect(readFileSync(join(skillsRoot(folder), 'heartbeat', 'SKILL.md'), 'utf8')).toContain('body of heartbeat')
    expect(existsSync(join(heldDirFor(dataDir, folder), 'heartbeat'))).toBe(false)
  })

  it('names the conflict plainly when a copy reappeared in the folder meanwhile', () => {
    mkSkill(skillsRoot(folder), 'clash')
    holdSkill(dataDir, folder, 'clash')
    mkSkill(skillsRoot(folder), 'clash')
    expect(() => activateSkill(dataDir, folder, 'clash')).toThrow(/copy of "clash" reappeared .* remove one first/)
    expect(existsSync(join(heldDirFor(dataDir, folder), 'clash'))).toBe(true) // the held copy stays put
  })

  it('refuses a name that is not held', () => {
    expect(() => activateSkill(dataDir, folder, 'never-held')).toThrow(/"never-held" is not held .*nothing to turn on/)
  })

  it('creates <folder>/.claude/skills when the folder never had one', () => {
    mkSkill(skillsRoot(folder), 'solo')
    holdSkill(dataDir, folder, 'solo')
    rmSync(join(folder, '.claude'), { recursive: true, force: true })
    activateSkill(dataDir, folder, 'solo')
    expect(existsSync(join(skillsRoot(folder), 'solo', 'SKILL.md'))).toBe(true)
  })
})

describe('addSkill', () => {
  it('copies a plugin skill into the folder — the source stays', () => {
    mkSkill(plugin, 'support-inbox')
    expect(addSkill(plugin, dataDir, folder, 'support-inbox')).toBe('support-inbox')
    expect(readFileSync(join(skillsRoot(folder), 'support-inbox', 'SKILL.md'), 'utf8')).toContain('body of support-inbox')
    expect(existsSync(join(plugin, 'support-inbox', 'SKILL.md'))).toBe(true)
  })

  it('a plugin-qualified name ("silos:team-plan") lands under its base name', () => {
    mkSkill(plugin, 'team-plan')
    expect(addSkill(plugin, dataDir, folder, 'silos:team-plan')).toBe('team-plan')
    expect(existsSync(join(skillsRoot(folder), 'team-plan', 'SKILL.md'))).toBe(true)
  })

  it('refuses a name that is not a plugin skill, with honest words', () => {
    expect(() => addSkill(plugin, dataDir, folder, 'invented')).toThrow(/not one of Silos' plugin skills/)
  })

  it('refuses when the folder already has it, or a held copy exists', () => {
    mkSkill(plugin, 'repe')
    addSkill(plugin, dataDir, folder, 'repe')
    expect(() => addSkill(plugin, dataDir, folder, 'repe')).toThrow(/"repe" is already in/)
    holdSkill(dataDir, folder, 'repe')
    expect(() => addSkill(plugin, dataDir, folder, 'repe')).toThrow(/held copy of "repe" exists .* turn it on instead/)
  })
})

describe('heldSkills + the held store key', () => {
  it('lists held skills with the description from their SKILL.md frontmatter, tolerant of a missing one', () => {
    mkSkill(skillsRoot(folder), 'alpha', 'first one')
    mkdirSync(join(skillsRoot(folder), 'beta'), { recursive: true }) // no SKILL.md at all
    holdSkill(dataDir, folder, 'alpha')
    holdSkill(dataDir, folder, 'beta')
    expect(heldSkills(dataDir, folder)).toEqual([{ name: 'alpha', description: 'first one' }, { name: 'beta' }])
  })

  it('no held store yet → empty list, nothing created', () => {
    expect(heldSkills(dataDir, folder)).toEqual([])
    expect(existsSync(join(dataDir, 'skills-held'))).toBe(false)
  })

  it('two folders hold under two keys — holding in one never shows in the other', () => {
    const other = join(base, 'other-folder')
    mkdirSync(skillsRoot(other), { recursive: true })
    mkSkill(skillsRoot(folder), 'mine')
    holdSkill(dataDir, folder, 'mine')
    expect(heldDirFor(dataDir, folder)).not.toBe(heldDirFor(dataDir, other))
    expect(heldSkills(dataDir, other)).toEqual([])
    expect(heldSkills(dataDir, folder).map((h) => h.name)).toEqual(['mine'])
  })

  it('proj.one and proj-one (one munged key once) are two stores: a hold in one is invisible to, and cannot be turned on from, the other', () => {
    const dotted = join(base, 'proj.one')
    const dashed = join(base, 'proj-one')
    expect(mungePath(dotted)).toBe(mungePath(dashed)) // the collision the old key had
    mkdirSync(skillsRoot(dotted), { recursive: true })
    mkdirSync(skillsRoot(dashed), { recursive: true })
    mkSkill(skillsRoot(dotted), 'team-plan')
    holdSkill(dataDir, dotted, 'team-plan')
    expect(heldDirFor(dataDir, dotted)).not.toBe(heldDirFor(dataDir, dashed))
    expect(heldSkills(dataDir, dashed)).toEqual([])
    expect(() => activateSkill(dataDir, dashed, 'team-plan')).toThrow(/not held for this folder/)
    expect(heldSkills(dataDir, dotted).map((h) => h.name)).toEqual(['team-plan'])
  })

  it('the key reads back to its folder (the path is stored in the store) and fits one path segment for any folder length', () => {
    mkSkill(skillsRoot(folder), 'mine')
    holdSkill(dataDir, folder, 'mine')
    expect(heldStoreFolder(heldDirFor(dataDir, folder))).toBe(folder)
    const deep = join(base, ...Array.from({ length: 40 }, (_, i) => `level-${i}-with-a-long-name`))
    expect(heldDirFor(dataDir, deep).slice(join(dataDir, 'skills-held').length + 1).length).toBeLessThan(64)
  })

  // A symlinked folder and its target are ONE folder to the engine (it reads
  // <folder>/.claude/skills through the link): one store.
  it('a symlinked folder and its target share ONE store: a hold via the link is held for the target, and the reverse', () => {
    const linkC = join(base, 'linkC')
    symlinkSync(folder, linkC)
    mkSkill(skillsRoot(folder), 'team-plan')
    holdSkill(dataDir, linkC, 'team-plan')
    expect(heldDirFor(dataDir, linkC)).toBe(heldDirFor(dataDir, folder))
    expect(heldSkills(dataDir, folder).map((h) => h.name)).toEqual(['team-plan'])
    // the target can't add another copy over the held one…
    mkSkill(plugin, 'team-plan')
    expect(() => addSkill(plugin, dataDir, folder, 'team-plan')).toThrow(/held copy/)
    // …and turns it on for both
    activateSkill(dataDir, folder, 'team-plan')
    expect(heldSkills(dataDir, linkC)).toEqual([])
    expect(existsSync(join(skillsRoot(linkC), 'team-plan', 'SKILL.md'))).toBe(true)
    // the marker names the real folder
    holdSkill(dataDir, folder, 'team-plan')
    expect(heldStoreFolder(heldDirFor(dataDir, linkC))).toBe(realpathSync(folder))
  })

  it('a chain of links (l → linkC → realC) resolves to the same store', () => {
    const linkC = join(base, 'linkC'),
      l = join(base, 'l')
    symlinkSync(folder, linkC)
    symlinkSync(linkC, l)
    mkSkill(skillsRoot(folder), 'mine')
    holdSkill(dataDir, l, 'mine')
    expect(heldSkills(dataDir, folder).map((h) => h.name)).toEqual(['mine'])
    expect(heldSkills(dataDir, linkC).map((h) => h.name)).toEqual(['mine'])
  })

  it('a folder that does not exist (yet) keys by its resolved path — no throw', () => {
    const ghost = join(base, 'not-there')
    expect(heldSkills(dataDir, ghost)).toEqual([])
    expect(heldDirFor(dataDir, ghost)).toBe(heldDirFor(dataDir, ghost + '/'))
  })
})

describe('moveDir — one copy, whatever fails', () => {
  const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code })

  it('a read-only folder (EACCES on rename) refuses the hold and leaves exactly one copy, in the folder', () => {
    mkSkill(skillsRoot(folder), 'locked')
    chmodSync(skillsRoot(folder), 0o555)
    try {
      expect(() => holdSkill(dataDir, folder, 'locked')).toThrow(/EACCES|permission/i)
    } finally {
      chmodSync(skillsRoot(folder), 0o755)
    }
    expect(existsSync(join(skillsRoot(folder), 'locked', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(heldDirFor(dataDir, folder), 'locked'))).toBe(false)
  })

  // only the src → dest rename crosses devices; a rename next to the source
  // (same device) is real
  const crossDevice =
    (src: string, dest: string): typeof renameSync =>
    (a, b) => {
      if (a === src && b === dest) throw errno('EXDEV')
      renameSync(a, b)
    }

  it('only EXDEV falls back to copy + rm: a simulated cross-device rename still moves the whole dir', () => {
    mkSkill(skillsRoot(folder), 'far')
    const src = join(skillsRoot(folder), 'far')
    const dest = join(base, 'elsewhere')
    moveDir(src, dest, { renameSync: crossDevice(src, dest), cpSync, rmSync })
    expect(existsSync(src)).toBe(false)
    expect(readFileSync(join(dest, 'extra.txt'), 'utf8')).toBe('sidecar')
    expect(readdirSync(join(folder, '.claude'))).toEqual(['skills']) // nothing left aside
  })

  it('any other rename refusal is rethrown with nothing copied', () => {
    mkSkill(skillsRoot(folder), 'stay')
    const src = join(skillsRoot(folder), 'stay')
    const dest = join(base, 'never')
    expect(() =>
      moveDir(src, dest, {
        renameSync: () => {
          throw errno('EPERM')
        },
        cpSync,
        rmSync,
      }),
    ).toThrow('EPERM')
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(join(src, 'SKILL.md'))).toBe(true)
  })

  it('EXDEV + a source that cannot be moved away after the copy: the copy is rolled back — one copy, whole, at the source', () => {
    mkSkill(skillsRoot(folder), 'stuck')
    const src = join(skillsRoot(folder), 'stuck')
    const dest = join(base, 'half')
    const rn: typeof renameSync = (a, b) => {
      if (a === src) throw errno(b === dest ? 'EXDEV' : 'EACCES')
      renameSync(a, b)
    }
    expect(() => moveDir(src, dest, { renameSync: rn, cpSync, rmSync })).toThrow('EACCES')
    expect(existsSync(dest)).toBe(false)
    expect(readFileSync(join(src, 'SKILL.md'), 'utf8')).toContain('body of stuck')
    expect(readFileSync(join(src, 'extra.txt'), 'utf8')).toBe('sidecar')
  })

  // the double failure: removing the source fails partway AND the restore
  // copy fails — the old code left a PARTIAL source next to the full copy.
  // The source is now moved aside (one atomic rename, same device) before
  // anything is deleted: the source path is whole or gone, never partial,
  // and no restore copy is ever needed.
  it('EXDEV + removal that fails partway: the source path is never left partial — the move stands, whole, at dest', () => {
    mkSkill(skillsRoot(folder), 'torn')
    const src = join(skillsRoot(folder), 'torn')
    const dest = join(base, 'torn-dest')
    let cpCalls = 0
    const cp: typeof cpSync = (a, b, o) => {
      cpCalls++
      cpSync(a, b, o)
    }
    // rm deletes SKILL.md then fails on the rest — a partial tree wherever it runs
    const rm: typeof rmSync = (p, o) => {
      if (typeof p === 'string' && p !== dest && existsSync(join(p, 'extra.txt'))) {
        rmSync(join(p, 'SKILL.md'), { force: true })
        throw errno('EACCES')
      }
      rmSync(p, o)
    }
    moveDir(src, dest, { renameSync: crossDevice(src, dest), cpSync: cp, rmSync: rm })
    expect(cpCalls).toBe(1) // no restore copy
    expect(existsSync(src)).toBe(false) // not a partial source
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toContain('body of torn')
    expect(readFileSync(join(dest, 'extra.txt'), 'utf8')).toBe('sidecar')
    // nothing partial is left where the engine (or the held listing) looks
    expect(readdirSync(skillsRoot(folder))).toEqual([])
  })

  it('EXDEV + a copy that fails midway removes what landed — the source untouched', () => {
    mkSkill(skillsRoot(folder), 'partial')
    const src = join(skillsRoot(folder), 'partial')
    const dest = join(base, 'partial-dest')
    const cp: typeof cpSync = () => {
      mkdirSync(dest, { recursive: true })
      writeFileSync(join(dest, 'SKILL.md'), 'half')
      throw errno('ENOSPC')
    }
    expect(() => moveDir(src, dest, { renameSync: crossDevice(src, dest), cpSync: cp, rmSync })).toThrow('ENOSPC')
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(join(src, 'SKILL.md'))).toBe(true)
  })
})

describe('activeSkillNames', () => {
  it('lists the folder dirs that carry a SKILL.md, sorted; a folder without the dir → []', () => {
    mkSkill(skillsRoot(folder), 'zeta')
    mkSkill(skillsRoot(folder), 'alfa')
    mkdirSync(join(skillsRoot(folder), 'no-md'), { recursive: true })
    expect(activeSkillNames(folder)).toEqual(['alfa', 'zeta'])
    expect(activeSkillNames(join(base, 'missing'))).toEqual([])
  })
  // the engine loads a skill entry that is a symlink to a directory: Silos
  // must say the same, or the briefing tells the session it lacks the skill
  it('a skill that is a symlink to a directory with a SKILL.md is active; a dangling link is not', () => {
    mkSkill(join(base, 'elsewhere'), 'linked')
    mkdirSync(skillsRoot(folder), { recursive: true })
    symlinkSync(join(base, 'elsewhere', 'linked'), join(skillsRoot(folder), 'linked'))
    symlinkSync(join(base, 'nowhere'), join(skillsRoot(folder), 'dangling'))
    expect(activeSkillNames(folder)).toEqual(['linked'])
  })
})

describe("preludeSkillNames — Silos' own skills before the cut", () => {
  it("puts the plugin's skills first, the rest alphabetically, then caps", () => {
    for (const n of ['heartbeat', 'responsibility', 'team-plan', 'other-plugin-only']) mkSkill(plugin, n)
    for (const n of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'heartbeat', 'responsibility', 'team-plan']) mkSkill(skillsRoot(folder), n)
    expect(preludeSkillNames(folder, 8, plugin)).toEqual(['heartbeat', 'responsibility', 'team-plan', 'a1', 'a2', 'a3', 'a4', 'a5'])
    // a plugin skill the folder doesn't carry is never named
    expect(preludeSkillNames(folder, 20, plugin)).not.toContain('other-plugin-only')
  })
  it('an unreadable plugin dir → plain alphabetical order, never a guessed list', () => {
    for (const n of ['zeta', 'team-plan', 'alfa']) mkSkill(skillsRoot(folder), n)
    expect(silosSkillNames(join(base, 'missing'))).toEqual([])
    expect(preludeSkillNames(folder, 8, join(base, 'missing'))).toEqual(['alfa', 'team-plan', 'zeta'])
  })
  it('the real plugin ships heartbeat and team-plan', () => {
    expect(silosSkillNames()).toEqual(expect.arrayContaining(['heartbeat', 'team-plan']))
  })
})

describe('boot sync never resurrects a held skill', () => {
  it('syncSkillCopies leaves a held skill out of the folder and out of its report', () => {
    // a real plugin dir with a releases manifest, installed into the folder
    mkSkill(plugin, 'team-plan')
    mkSkill(plugin, 'heartbeat')
    writeFileSync(join(plugin, 'releases.json'), JSON.stringify({ 'team-plan': [], heartbeat: [] }))
    addSkill(plugin, dataDir, folder, 'team-plan')
    addSkill(plugin, dataDir, folder, 'heartbeat')
    expect(existsSync(join(skillsRoot(folder), 'team-plan', 'SKILL.md'))).toBe(true)

    holdSkill(dataDir, folder, 'team-plan')
    const copies = syncSkillCopies(plugin, folder)
    // the boot sync only updates copies ALREADY present — the held one is
    // neither reinstalled nor reported
    expect(existsSync(join(skillsRoot(folder), 'team-plan'))).toBe(false)
    expect(copies.map((c) => c.name).sort()).toEqual(['heartbeat'])
    // and the held copy itself was not touched
    expect(heldSkills(dataDir, folder).map((h) => h.name)).toEqual(['team-plan'])
  })
})
