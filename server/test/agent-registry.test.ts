import { describe, it, expect, beforeEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { isPackageInstall } from '../src/project-folder.js'
import { SILOS_CHECKOUT } from '../src/territory.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRegistry, mungePath, MASTER_ID } from '../src/agent-registry.js'

let reg: AgentRegistry
let file: string
beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), 'deck-')), 'agents.json')
  reg = new AgentRegistry(file)
  reg.load()
})

describe('mungePath', () => {
  it('mirrors the naming of ~/.claude/projects', () => {
    expect(mungePath('/home/user/acme')).toBe('-home-user-acme')
    expect(mungePath('/home/u/x/.claude/worktrees/t')).toBe('-home-u-x--claude-worktrees-t')
  })
})

describe('load', () => {
  it('no file -> creates one with master', () => {
    expect(reg.get(MASTER_ID)).not.toBeNull()
    expect(JSON.parse(readFileSync(file, 'utf8')).agents[0].id).toBe(MASTER_ID)
  })
})

describe('CRUD', () => {
  it('create + get + list', () => {
    reg.create({ id: 'finance', name: 'FINANCE', folder: '/home/u/ci', skills: ['finance-x'] })
    expect(reg.get('finance')?.name).toBe('FINANCE')
    expect(reg.list().map((a) => a.id)).toContain('finance')
  })
  it('duplicate id and invalid slug throw', () => {
    reg.create({ id: 'finance', name: 'FINANCE', folder: '/home/u/ci' })
    expect(() => reg.create({ id: 'finance', name: 'X', folder: '/x' })).toThrow('duplicate id')
    expect(() => reg.create({ id: 'Mal Id!', name: 'X', folder: '/x' })).toThrow('invalid id')
    expect(() => reg.create({ id: 'ok', name: 'X', folder: 'relative' })).toThrow('absolute path')
  })
  it('archive removes from list() but not list(true); master cannot be archived', () => {
    reg.create({ id: 'finance', name: 'FINANCE', folder: '/x' })
    reg.archive('finance')
    expect(reg.list().find((a) => a.id === 'finance')).toBeUndefined()
    expect(reg.list(true).find((a) => a.id === 'finance')?.archived).toBe(true)
    expect(() => reg.archive(MASTER_ID)).toThrow('master cannot be archived')
  })
  it('update does not allow touching id, and persists', () => {
    reg.create({ id: 'finance', name: 'FINANCE', folder: '/x' })
    reg.update('finance', { name: 'Pepe' })
    const reloaded = new AgentRegistry(file)
    reloaded.load()
    expect(reloaded.get('finance')?.name).toBe('Pepe')
  })
  it('update cannot archive master', () => {
    expect(() => reg.update(MASTER_ID, { archived: true })).toThrow('master cannot be archived')
  })
  it('update can unarchive master', () => {
    reg.update(MASTER_ID, { archived: false })
    expect(reg.get(MASTER_ID)?.archived).toBe(false)
  })
  it('update with non-array skills throws and does not persist', () => {
    reg.create({ id: 'finance', name: 'FINANCE', folder: '/x', skills: ['finance-x'] })
    // @ts-expect-error testing an invalid shape on purpose (e.g. a mistyped patch from HTTP)
    expect(() => reg.update('finance', { skills: 'oops' })).toThrow('skills must be an array of strings')
    const reloaded = new AgentRegistry(file)
    reloaded.load()
    expect(reloaded.get('finance')?.skills).toEqual(['finance-x']) // untouched
  })
  it('update with non-boolean archived throws', () => {
    reg.create({ id: 'finance', name: 'FINANCE', folder: '/x' })
    // @ts-expect-error testing an invalid shape on purpose
    expect(() => reg.update('finance', { archived: 'no' })).toThrow('archived must be a boolean')
  })
  it('create with non-array skills throws', () => {
    // @ts-expect-error testing an invalid shape on purpose
    expect(() => reg.create({ id: 'finance', name: 'FINANCE', folder: '/x', skills: 'oops' })).toThrow('skills must be an array of strings')
  })
  // the mission: text 1–2000, Never ≤ 10 lines of ≤ 200,
  // with the exact 400 words; trimmed, empty Never lines dropped, stamped
  it('create and update validate the mission with its exact words, and persist it stamped', () => {
    const m = reg.create({
      id: 'finance',
      name: 'FINANCE',
      folder: '/x',
      mission: { text: '  Taxes and accounts.  ', never: [' file anything ', '', 'pay anything'] },
    }).mission!
    expect(m.text).toBe('Taxes and accounts.')
    expect(m.never).toEqual(['file anything', 'pay anything'])
    expect(Number.isNaN(Date.parse(m.updatedAt))).toBe(false)
    expect(reg.create({ id: 'bare', name: 'Bare', folder: '/x', mission: { text: 'Answers mail' } }).mission!.never).toEqual([])
    expect(reg.create({ id: 'none', name: 'None', folder: '/x' }).mission).toBeUndefined()

    const TEXT = 'mission.text must be 1–2000 characters'
    const NEVER = 'mission.never must be up to 10 lines of up to 200 characters'
    for (const bad of [{ text: '' }, { text: '   ' }, { text: 'x'.repeat(2001) }, { never: ['a'] }, 'Taxes', ['x'], { text: 42 }]) {
      expect(() => reg.update('finance', { mission: bad })).toThrow(TEXT)
    }
    for (const bad of [
      { text: 'ok', never: 'a' },
      { text: 'ok', never: [1] },
      { text: 'ok', never: Array.from({ length: 11 }, (_, i) => `l${i}`) },
      { text: 'ok', never: ['x'.repeat(201)] },
    ]) {
      expect(() => reg.update('finance', { mission: bad })).toThrow(NEVER)
    }
    expect(() => reg.create({ id: 'bad', name: 'Bad', folder: '/x', mission: { text: '' } })).toThrow(TEXT)
    expect(reg.get('bad')).toBeNull()
    expect(
      reg.update('finance', { mission: { text: 'x'.repeat(2000), never: Array.from({ length: 10 }, () => 'y'.repeat(200)) } }).mission!.never,
    ).toHaveLength(10)
    // nothing odd was persisted by the refused writes; null clears it
    const reloaded = new AgentRegistry(file)
    reloaded.load()
    expect(reloaded.get('finance')!.mission!.text).toBe('x'.repeat(2000))
    expect(reg.update('finance', { mission: null }).mission).toBeUndefined()
    expect('mission' in reg.get('finance')!).toBe(false)
    // an unrelated edit leaves the mission (and its stamp) untouched
    const kept = reg.update('bare', { name: 'Bare 2' }).mission!
    expect(kept.text).toBe('Answers mail')
  })

  // the owner may write missions by hand — a mission without `never`, untrimmed or malformed must load
  // into a shape no turn or screen can crash on
  it('load normalizes a hand-written mission: never ?? [], text trimmed, no text ⇒ no mission', () => {
    writeFileSync(
      file,
      JSON.stringify({
        agents: [
          { id: 'a', name: 'A', folder: '/x', skills: [], mission: { text: '  Books.  ' } },
          { id: 'b', name: 'B', folder: '/x', skills: [], mission: { text: 'Mail.', never: [' pay ', '', 3], updatedAt: '2026-11-10T09:00:00Z' } },
          { id: 'c', name: 'C', folder: '/x', skills: [], mission: { never: ['x'] } },
          { id: 'd', name: 'D', folder: '/x', skills: [], mission: 'just a string' },
        ],
      }),
    )
    const r = new AgentRegistry(file)
    r.load()
    expect(r.get('a')!.mission).toEqual({ text: 'Books.', never: [], updatedAt: '' })
    expect(r.get('b')!.mission).toEqual({ text: 'Mail.', never: ['pay'], updatedAt: '2026-11-10T09:00:00Z' })
    expect('mission' in r.get('c')!).toBe(false)
    expect('mission' in r.get('d')!).toBe(false)
  })

  it('updatedAt moves only when the mission says something new', () => {
    const first = reg.create({ id: 'finance', name: 'FINANCE', folder: '/x', mission: { text: 'Books.', never: ['pay'] } }).mission!
    const stamped = { ...first, updatedAt: '2026-01-01T00:00:00.000Z' }
    reg.get('finance')!.mission = stamped
    expect(reg.update('finance', { mission: { text: ' Books. ', never: ['pay', ''] } }).mission!.updatedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(reg.update('finance', { mission: { text: 'Books.', never: ['pay', 'sign'] } }).mission!.updatedAt).not.toBe('2026-01-01T00:00:00.000Z')
  })

  it('a Never line carrying a newline is refused — it would dodge the 10-line cap', () => {
    reg.create({ id: 'finance', name: 'FINANCE', folder: '/x' })
    expect(() => reg.update('finance', { mission: { text: 'ok', never: ['a\nb\nc'] } })).toThrow('mission.never must be up to 10 lines of up to 200 characters')
  })

  it('a new agent carries no role and no charter any more', () => {
    const a = reg.create({ id: 'finance', name: 'FINANCE', folder: '/x' })
    expect('role' in a).toBe(false)
    expect('systemAppend' in a).toBe(false)
    expect('role' in reg.get(MASTER_ID)!).toBe(false)
  })

  // Shape only (nothing odd reaches agents.json): the clamp/HH:MM strictness
  // lives on the PATCH route (autonomy.ts parseBeatField) — see the comment
  // in validateOptionalFields on the import cycle that keeps it there.
})

describe('load normalizes master', () => {
  it('master hand-archived in the file -> load() unarchives it', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'deck-')), 'agents.json')
    writeFileSync(
      f,
      JSON.stringify({ agents: [{ id: MASTER_ID, name: 'Master', emoji: '🎛️', role: '', folder: null, skills: [], default: true, archived: true }] }),
    )
    const r = new AgentRegistry(f)
    r.load()
    expect(r.get(MASTER_ID)?.archived).toBeFalsy()
  })
})

describe('classify', () => {
  beforeEach(() => {
    reg.create({ id: 'builder', name: 'BUILDER', folder: '/home/u/ci', skills: ['builder-x'] })
    reg.create({ id: 'finance', name: 'FINANCE', folder: '/home/u/ci', skills: ['finance-x'] })
    reg.create({ id: 'writer', name: 'Writer', folder: '/home/u/ci', default: true })
    reg.create({ id: 'silos', name: 'Silos', folder: '/home/u/ci/dashboard' })
  })
  const m = (cwd: string | null, skills: string[] = [], folder = '-x') => ({ cwd, folder, skills })

  it('skills break ties within the folder', () => expect(reg.classify(m('/home/u/ci', ['finance-x'])).id).toBe('finance'))
  it('with no skills, the default wins', () => expect(reg.classify(m('/home/u/ci')).id).toBe('writer'))
  it('a subfolder goes to the project (prefix match)', () => expect(reg.classify(m('/home/u/ci/src/api')).id).toBe('writer'))
  it('the deeper folder wins', () => expect(reg.classify(m('/home/u/ci/dashboard/x')).id).toBe('silos'))
  it('a worktree under the project falls into the project', () => expect(reg.classify(m('/home/u/ci/.claude/worktrees/t', ['builder-x'])).id).toBe('builder'))
  it('cwd with no project -> master', () => expect(reg.classify(m('/tmp/other-thing')).id).toBe(MASTER_ID))
  it('with no cwd, uses an exact munged match', () => expect(reg.classify(m(null, [], '-home-u-ci')).id).toBe('writer'))
  it('an archived agent does not classify', () => {
    reg.archive('silos')
    expect(reg.classify(m('/home/u/ci/dashboard/x')).id).toBe('writer')
  })
})

// Cross-session link: third-voice sender → known, NON-archived agent id (or
// null). Honest rule: unique exact match by id/name/name-slug, with one
// retry after stripping a short session suffix ("-e8"). Sockets and
// ambiguity → null. The message carries no session_id: only the SENDER is
// resolved, never the exact thread.
describe('resolveSender (cross-session link)', () => {
  beforeEach(() => {
    reg.create({ id: 'acme', name: 'Acme', folder: '/home/u/ci' })
    reg.create({ id: 'silos', name: 'Silos Dashboard', folder: '/home/u/silos' })
  })
  it('exact match by id (case-insensitive)', () => {
    expect(reg.resolveSender('acme')).toBe('acme')
    expect(reg.resolveSender('ACME')).toBe('acme')
  })
  it('match by name / name-slug', () => {
    expect(reg.resolveSender('Silos Dashboard')).toBe('silos')
    expect(reg.resolveSender('silos-dashboard')).toBe('silos')
  })
  it('a friendly name with a session suffix ("-e8") falls back to the base agent', () => {
    expect(reg.resolveSender('acme-e8')).toBe('acme')
    expect(reg.resolveSender('Acme-C6')).toBe('acme')
  })
  it('no matching agent -> null (plain text, no link)', () => {
    expect(reg.resolveSender('stranger')).toBeNull()
    expect(reg.resolveSender('nobody-x9')).toBeNull()
  })
  it('an archived agent does NOT resolve (no link, honest)', () => {
    reg.archive('silos')
    expect(reg.resolveSender('silos')).toBeNull()
    expect(reg.resolveSender('Silos Dashboard')).toBeNull()
    expect(reg.resolveSender('silos-e8')).toBeNull()
  })
  it('a socket (uds:/…), the "peer" placeholder, and empty -> null', () => {
    expect(reg.resolveSender('uds:/tmp/cc-socks/1234.sock')).toBeNull()
    expect(reg.resolveSender('peer')).toBeNull()
    expect(reg.resolveSender('')).toBeNull()
    expect(reg.resolveSender('a/b')).toBeNull()
    expect(reg.resolveSender(42)).toBeNull()
  })
  it('an ambiguous match (two agents with the same name) -> null', () => {
    reg.create({ id: 'twin-a', name: 'Twin', folder: '/home/u/a' })
    reg.create({ id: 'twin-b', name: 'Twin', folder: '/home/u/b' })
    expect(reg.resolveSender('Twin')).toBeNull()
  })
})

describe('folders (extra territories)', () => {
  it('create round-trips folders through the file, trailing slashes stripped', () => {
    reg.create({ id: 'builder', name: 'BUILDER', folder: '/home/u/ci', folders: ['/home/u/builder/', '/home/u/ops'] })
    const again = new AgentRegistry(file)
    again.load()
    expect(again.get('builder')!.folders).toEqual(['/home/u/builder', '/home/u/ops'])
  })
  it('create rejects relative, duplicate, equal-to-folder, non-array and >16 entries', () => {
    const mk = (id: string, folders: unknown) => () => reg.create({ id, name: 'X', folder: '/home/u/ci', folders } as never)
    expect(mk('a', ['rel/x'])).toThrow(/absolute/)
    expect(mk('b', ['/x', '/x/'])).toThrow(/duplicate/)
    expect(mk('c', ['/home/u/ci/'])).toThrow(/folder/)
    expect(mk('d', '/x')).toThrow(/array/)
    expect(
      mk(
        'e',
        Array.from({ length: 17 }, (_, i) => `/x${i}`),
      ),
    ).toThrow(/16/)
    expect(reg.list().map((a) => a.id)).toEqual([MASTER_ID])
  })
  it('update sets, validates against the effective folder, and [] clears', () => {
    reg.create({ id: 'builder', name: 'BUILDER', folder: '/home/u/ci' })
    expect(reg.update('builder', { folders: ['/home/u/builder'] }).folders).toEqual(['/home/u/builder'])
    expect(() => reg.update('builder', { folder: '/home/u/builder' })).toThrow(/folder/)
    expect(() => reg.update('builder', { folders: ['nope'] })).toThrow(/absolute/)
    reg.update('builder', { folders: [] })
    expect('folders' in reg.get('builder')!).toBe(false)
  })
  it('master has no folders, and / is never a territory', () => {
    expect(() => reg.update(MASTER_ID, { folders: ['/home/u/x'] })).toThrow('master has no folders')
    expect(() => reg.create({ id: 'root', name: 'R', folder: '/home/u/ci', folders: ['/'] })).toThrow(/\//)
    expect(() => reg.create({ id: 'root2', name: 'R', folder: '/home/u/ci', folders: ['///'] })).toThrow()
    reg.create({ id: 'ok', name: 'Ok', folder: '/home/u/ci' })
    expect(() => reg.update('ok', { folders: ['/'] })).toThrow()
  })
  it('classifyWithRule says which rule matched', () => {
    reg.create({ id: 'builder', name: 'BUILDER', folder: '/home/u/ci', folders: ['/home/u/builder'] })
    expect(reg.classifyWithRule({ cwd: '/home/u/ci/x', folder: '-x', skills: [] })).toMatchObject({ via: 'primary', agent: { id: 'builder' } })
    expect(reg.classifyWithRule({ cwd: '/home/u/builder', folder: '-x', skills: [] })).toMatchObject({ via: 'secondary', agent: { id: 'builder' } })
    expect(reg.classifyWithRule({ cwd: '/tmp', folder: '-x', skills: [] })).toMatchObject({ via: 'master', agent: { id: MASTER_ID } })
  })
  it('classify: a cwd inside a secondary territory of exactly one agent goes to it', () => {
    reg.create({ id: 'builder', name: 'BUILDER', folder: '/home/u/ci', folders: ['/home/u/builder'] })
    reg.create({ id: 'ops', name: 'Ops', folder: '/home/u/ops', folders: ['/home/u/shared'] })
    reg.create({ id: 'writer', name: 'Writer', folder: '/home/u/writer', folders: ['/home/u/shared'] })
    expect(reg.classify({ cwd: '/home/u/builder/x', folder: '-x', skills: [] }).id).toBe('builder')
    expect(reg.classify({ cwd: '/home/u/builder2', folder: '-x', skills: [] }).id).toBe(MASTER_ID)
    // ambiguous secondary: today's behaviour (master)
    expect(reg.classify({ cwd: '/home/u/shared', folder: '-x', skills: [] }).id).toBe(MASTER_ID)
    // a primary folder always wins over someone's secondary territory
    reg.create({ id: 'own', name: 'Own', folder: '/home/u/builder/deep' })
    expect(reg.classify({ cwd: '/home/u/builder/deep/a', folder: '-x', skills: [] }).id).toBe('own')
  })
})

// the project folder check (project-folder.ts): every folder a door writes
// goes through it, on its REAL path. A machine of its own: a home with the
// Projects folder, Silos' data dir and the engine's config dir in it.
describe('the project folder check at create and update', () => {
  let home: string, data: string, checked: AgentRegistry
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'pf-home-'))
    data = join(home, '.silos')
    for (const d of [data, join(home, '.claude'), join(home, 'Silos'), join(home, 'work', 'shop', 'src')]) mkdirSync(d, { recursive: true })
    checked = new AgentRegistry(join(data, 'agents.json'), { folderCheck: { home, dataDir: data } })
    checked.load()
  })
  const refusal = (fn: () => unknown): { status: number; message: string } => {
    try {
      fn()
    } catch (err) {
      return { status: (err as { status?: number }).status ?? 0, message: (err as Error).message }
    }
    throw new Error('not refused')
  }
  const birth = (id: string, folder: string, folders?: string[]) => checked.create({ id, name: id, folder, ...(folders ? { folders } : {}) })

  it("refuses the home folder, /, Silos' data dir, the engine's config dir and the Projects folder — and what sits in or holds them", () => {
    for (const f of [
      home,
      '/',
      data,
      join(data, 'agent-state', 'x'),
      join(home, '.claude'),
      join(home, '.claude', 'skills'),
      join(home, 'Silos'),
      join(home, '..'),
    ]) {
      expect(refusal(() => birth('builder', f)).status, f).toBe(400)
    }
    expect(checked.get('builder')).toBeNull()
  })

  it('refuses a folder holding another project or inside one; the very folder of one is joining it', () => {
    const shop = join(home, 'work', 'shop')
    birth('builder', shop)
    expect(refusal(() => birth('finance', join(shop, 'src'))).status).toBe(409)
    expect(refusal(() => birth('finance', join(home, 'work'))).message).toMatch(/holds the project at/)
    expect(birth('finance', `${shop}/`).folder).toBe(shop)
    // an archived agent's folder is out of play
    checked.archive('builder')
    checked.archive('finance')
    expect(birth('ops', join(shop, 'src')).folder).toBe(join(shop, 'src'))
  })

  it('judges the real path: a symlink to a forbidden place is refused, one to a free folder is stored resolved', () => {
    symlinkSync(join(home, '.claude'), join(home, 'work', 'looks-fine'))
    expect(refusal(() => birth('builder', join(home, 'work', 'looks-fine'))).message).toMatch(/really/)
    symlinkSync(join(home, 'work', 'shop'), join(home, 'alias'))
    expect(birth('builder', join(home, 'alias')).folder).toBe(join(home, 'work', 'shop'))
  })

  it('a new folder under a symlinked Projects folder passes and is stored at its real place', () => {
    const disk = mkdtempSync(join(tmpdir(), 'pf-disk-'))
    rmSync(join(home, 'Silos'), { recursive: true })
    symlinkSync(disk, join(home, 'Silos'))
    expect(birth('builder', join(home, 'Silos', 'books')).folder).toBe(join(disk, 'books'))
    // the Projects folder itself, by either name, stays refused
    expect(refusal(() => birth('finance', disk)).status).toBe(400)
  })

  it('folders[] goes through the same check, at birth and on update; the folders it already has are not re-judged', () => {
    const shop = join(home, 'work', 'shop')
    birth('builder', shop)
    expect(refusal(() => birth('finance', join(home, 'work', 'books'), [join(shop, 'src')])).status).toBe(409)
    birth('finance', join(home, 'work', 'books'))
    expect(refusal(() => checked.update('finance', { folders: [join(home, '.claude')] })).status).toBe(400)
    expect(refusal(() => checked.update('finance', { folders: [join(shop, 'src')] })).status).toBe(409)
    // its own folders never nest either
    expect(refusal(() => checked.update('finance', { folders: [join(home, 'work', 'books', 'old')] })).status).toBe(409)
    expect(checked.get('finance')?.folders).toBeUndefined()
    expect(checked.update('finance', { folders: [shop] }).folders).toEqual([shop])
    expect(refusal(() => checked.update('finance', { folder: home })).status).toBe(400)
    expect(checked.get('finance')?.folder).toBe(join(home, 'work', 'books'))
    // an unrelated patch of an agent with a folder written before the rule passes
    writeFileSync(join(data, 'agents.json'), JSON.stringify({ agents: [...checked.list(true), { id: 'legacy', name: 'Legacy', folder: home, skills: [] }] }))
    checked.load()
    expect(checked.update('legacy', { name: 'Old', folder: home }).name).toBe('Old')
  })

  it("Silos' git checkout is a code folder like any other; only an installed package is Silos' own", () => {
    expect(birth('builder', SILOS_CHECKOUT).folder).toBe(realpathSync(SILOS_CHECKOUT))
    expect(isPackageInstall(SILOS_CHECKOUT)).toBe(false)
    const pkg = join(home, 'lib', 'node_modules', 'silosplatform')
    mkdirSync(pkg, { recursive: true })
    expect(isPackageInstall(pkg)).toBe(true)
    mkdirSync(join(pkg, '.git'))
    expect(isPackageInstall(pkg)).toBe(false)
  })

  it('bringing an archived agent back judges its folders again', () => {
    const shop = join(home, 'work', 'shop')
    birth('builder', join(shop, 'src'))
    checked.archive('builder')
    birth('finance', shop)
    expect(refusal(() => checked.unarchive('builder')).status).toBe(409)
    expect(checked.get('builder')?.archived).toBe(true)
  })

  it('the audit names every in-play agent whose folder breaks the rule, archived ones apart, and changes nothing', () => {
    const shop = join(home, 'work', 'shop')
    const agents = [
      { id: 'builder', name: 'Builder', folder: shop, skills: [] },
      { id: 'finance', name: 'Finance', folder: join(shop, 'src'), skills: [] },
      { id: 'desk', name: 'Desk', folder: home, skills: [] },
      { id: 'gone', name: 'Gone', folder: data, skills: [], archived: true },
      { id: 'fine', name: 'Fine', folder: join(home, 'work', 'books'), skills: [] },
    ]
    writeFileSync(join(data, 'agents.json'), JSON.stringify({ agents }))
    checked.load()
    const before = readFileSync(join(data, 'agents.json'), 'utf8')
    const found = checked.auditFolders()
    // fine's own folder is fine — but it sits inside desk's project (the home)
    expect(found.map((o) => o.agentId).sort()).toEqual(['builder', 'desk', 'finance', 'fine'])
    expect(found.find((o) => o.agentId === 'fine')?.reason).toMatch(/inside the project at/)
    expect(found.find((o) => o.agentId === 'desk')?.reason).toMatch(/home folder/)
    expect(readFileSync(join(data, 'agents.json'), 'utf8')).toBe(before)
  })
})
