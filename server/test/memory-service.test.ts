import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { AgentRegistry, mungePath } from '../src/agent-registry.js'
import { agentAutoMemoryDir, MemoryService } from '../src/memory-service.js'
import { registerHarness } from '../src/harnesses/registry.js'
import { makeFakeHarness } from './fixtures/fake-harness.js'

let base: string, root: string, dataDir: string, folder: string, memDir: string
let registry: AgentRegistry
let memory: MemoryService

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'deck-mem-'))
  root = join(base, 'projects')
  dataDir = join(base, 'data')
  folder = join(base, 'proj')
  mkdirSync(root, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(base, 'CLAUDE.md'), '# global\n')
  writeFileSync(join(folder, 'CLAUDE.md'), '# project\n')
  memDir = join(root, mungePath(folder), 'memory')
  mkdirSync(memDir, { recursive: true })
  writeFileSync(join(memDir, 'MEMORY.md'), '# index\n')
  writeFileSync(join(memDir, 'card-1.md'), '---\nname: Card one\ndescription: A description\ntype: note\n---\ncontent\n')
  registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  registry.create({ id: 'ag', name: 'Agent', folder })
  memory = new MemoryService(root, dataDir, registry)
})

describe('list', () => {
  it('finds all 3 layers in the temp fixtures', async () => {
    const layers = await memory.list(folder)
    expect(layers.global.exists).toBe(true)
    expect(layers.project?.exists).toBe(true)
    expect(layers.autoMemory).toHaveLength(2)
    const card = layers.autoMemory.find((f) => f.name === 'Card one')
    expect(card?.description).toBe('A description')
    expect(card?.type).toBe('note')
    const idx = layers.autoMemory.find((f) => f.name === 'MEMORY')
    expect(idx?.type).toBe('index')
  })

  it('every entry carries the explicit scope of its layer (the MEMORY index included)', async () => {
    // with an agentId the auto layer is the AGENT's dir (memory per agent)
    const aDir = agentAutoMemoryDir(dataDir, 'ag')
    mkdirSync(aDir, { recursive: true })
    writeFileSync(join(aDir, 'MEMORY.md'), '# index\n')
    writeFileSync(join(aDir, 'note.md'), '---\nname: N\ntype: note\n---\nx\n')
    const layers = await memory.list(folder, 'ag')
    expect(layers.global.scope).toBe('global')
    expect(layers.project?.scope).toBe('project')
    expect(layers.autoMemory).toHaveLength(2)
    expect(layers.autoMemory.every((f) => f.scope === 'auto')).toBe(true)
    expect(layers.autoMemory.find((f) => f.name === 'MEMORY')?.scope).toBe('auto')
    expect(layers.agent?.scope).toBe('agent')
  })

  it('no folder -> only the global layer', async () => {
    const layers = await memory.list()
    expect(layers.global.exists).toBe(true)
    expect(layers.project).toBeNull()
    expect(layers.autoMemory).toEqual([])
  })

  it('an unknown folder -> error', async () => {
    await expect(memory.list('/no/such/folder')).rejects.toThrow('folder not recognized')
  })

  it('the global layer exists even without a CLAUDE.md (exists:false)', async () => {
    const emptyBase = mkdtempSync(join(tmpdir(), 'deck-mem-empty-'))
    const emptyRoot = join(emptyBase, 'projects')
    mkdirSync(emptyRoot, { recursive: true })
    const svc = new MemoryService(emptyRoot, dataDir, registry)
    const layers = await svc.list()
    expect(layers.global.exists).toBe(false)
  })
})

describe('list — what each auto note is and whether the index names it', () => {
  it("reads type and origin nested under metadata (Claude Code's current shape)", async () => {
    writeFileSync(
      join(memDir, 'nested.md'),
      '---\nname: nested\ndescription: "Learned once"\nmetadata:\n  node_type: memory\n  type: feedback\n  originSessionId: 87b9fd25-00cb\n  modified: 2026-10-08T09:31:26Z\n---\nbody\n',
    )
    const n = (await memory.list(folder)).autoMemory.find((f) => f.name === 'nested')!
    expect(n.type).toBe('feedback')
    expect(n.origin).toBe('87b9fd25-00cb')
    expect(n.writtenAt).toBe(Date.parse('2026-10-08T09:31:26Z'))
    expect(n.description).toBe('Learned once')
  })
  it('a top-level type wins over a nested one; a later top-level key closes metadata', async () => {
    writeFileSync(join(memDir, 'both.md'), '---\nname: both\nmetadata:\n  type: project\ntype: user\n---\n')
    expect((await memory.list(folder)).autoMemory.find((f) => f.name === 'both')!.type).toBe('user')
  })
  it('inIndex says whether MEMORY.md links the note; the index carries its line count and size', async () => {
    writeFileSync(join(memDir, 'MEMORY.md'), '# index\n- [Card one](card-1.md) — A description\n')
    writeFileSync(join(memDir, 'lost.md'), '---\nname: lost\n---\n')
    const auto = (await memory.list(folder)).autoMemory
    expect(auto.find((f) => f.name === 'Card one')!.inIndex).toBe(true)
    expect(auto.find((f) => f.name === 'lost')!.inIndex).toBe(false)
    const idx = auto.find((f) => f.type === 'index')!
    expect(idx.lines).toBe(2)
    expect(idx.size).toBeGreaterThan(0)
  })
  it('no MEMORY.md → inIndex is unknown (absent), never false', async () => {
    const { rmSync } = await import('node:fs')
    rmSync(join(memDir, 'MEMORY.md'))
    expect((await memory.list(folder)).autoMemory.find((f) => f.name === 'Card one')!.inIndex).toBeUndefined()
  })
})

describe('read', () => {
  it('reads the content of an allowed layer', async () => {
    expect(await memory.read(join(folder, 'CLAUDE.md'))).toBe('# project\n')
    expect(await memory.read(join(base, 'CLAUDE.md'))).toBe('# global\n')
    expect(await memory.read(join(memDir, 'card-1.md'))).toContain('content')
  })

  it('a nonexistent file inside an allowed path -> "not found"', async () => {
    await expect(memory.read(join(memDir, 'missing.md'))).rejects.toThrow('not found')
  })
})

describe('write', () => {
  it('makes a backup BEFORE writing, then writes atomically', async () => {
    const target = join(folder, 'CLAUDE.md')
    const { backup } = await memory.write(target, '# new content\n')
    expect(backup).toBeTruthy()
    expect(existsSync(backup!)).toBe(true)
    expect(readFileSync(backup!, 'utf8')).toBe('# project\n') // the PREVIOUS content, not the new one
    expect(readFileSync(target, 'utf8')).toBe('# new content\n')
    expect(backup).toContain(join(dataDir, 'memory-backups'))
  })

  it('the first write of a new card produces no backup (nothing to preserve)', async () => {
    const target = join(memDir, 'new.md')
    const { backup } = await memory.write(target, '# new\n')
    expect(backup).toBeNull()
    expect(readFileSync(target, 'utf8')).toBe('# new\n')
  })

  it('never overwrites an existing backup across successive writes', async () => {
    const target = join(folder, 'CLAUDE.md')
    const r1 = await memory.write(target, 'v1')
    const r2 = await memory.write(target, 'v2')
    expect(r1.backup).not.toBe(r2.backup)
    expect(readFileSync(r1.backup!, 'utf8')).toBe('# project\n')
    expect(readFileSync(r2.backup!, 'utf8')).toBe('v1')
    expect(readFileSync(target, 'utf8')).toBe('v2')
  })
})

describe('write — MEMORY.md index line for a new auto-memory note', () => {
  const note = '---\nname: New note\ndescription: What it says\ntype: project\n---\nbody\n'

  it('creating a new note appends its index line to MEMORY.md', async () => {
    await memory.write(join(memDir, 'new.md'), note)
    expect(readFileSync(join(memDir, 'MEMORY.md'), 'utf8')).toBe('# index\n- [New note](new.md) — What it says\n')
  })

  it('MEMORY.md missing -> it is created with the line (no frontmatter -> basename, no dash)', async () => {
    const idx = join(memDir, 'MEMORY.md')
    const { rmSync } = await import('node:fs')
    rmSync(idx)
    await memory.write(join(memDir, 'loose.md'), '# no frontmatter\n')
    expect(readFileSync(idx, 'utf8')).toBe('- [loose.md](loose.md)\n')
  })

  it('MEMORY.md without a trailing newline -> the new line does not glue onto the previous one', async () => {
    const idx = join(memDir, 'MEMORY.md')
    writeFileSync(idx, '# index\n- [Card one](card-1.md) — A description')
    await memory.write(join(memDir, 'new.md'), note)
    expect(readFileSync(idx, 'utf8')).toBe('# index\n- [Card one](card-1.md) — A description\n- [New note](new.md) — What it says\n')
  })

  it('overwriting an EXISTING note does not duplicate its line', async () => {
    const idx = join(memDir, 'MEMORY.md')
    writeFileSync(idx, '# index\n- [Card one](card-1.md) — A description\n')
    await memory.write(join(memDir, 'new.md'), note)
    const after1 = readFileSync(idx, 'utf8')
    expect(after1.match(/\]\(new\.md\)/g)).toHaveLength(1)
    await memory.write(join(memDir, 'new.md'), note.replace('body', 'body v2'))
    expect(readFileSync(idx, 'utf8')).toBe(after1)
    await memory.write(join(memDir, 'card-1.md'), 'rewritten')
    expect(readFileSync(idx, 'utf8')).toBe(after1)
  })

  it('a failed index write is healed by the retry: the note exists, MEMORY.md lacks it -> the line is appended', async () => {
    const idx = join(memDir, 'MEMORY.md')
    const { rmSync } = await import('node:fs')
    // the index write fails (MEMORY.md is a directory): the note lands, write() rejects
    rmSync(idx)
    mkdirSync(idx)
    await expect(memory.write(join(memDir, 'new.md'), note)).rejects.toThrow()
    expect(readFileSync(join(memDir, 'new.md'), 'utf8')).toBe(note)
    // the index is writable again; the retry finds the note already on disk
    rmSync(idx, { recursive: true })
    writeFileSync(idx, '# index\n')
    await memory.write(join(memDir, 'new.md'), note)
    expect(readFileSync(idx, 'utf8')).toBe('# index\n- [New note](new.md) — What it says\n')
  })

  it('only auto-memory notes are indexed (MEMORY.md itself, project and agent layers never touch the index)', async () => {
    const idx = join(memDir, 'MEMORY.md')
    const { rmSync } = await import('node:fs')
    rmSync(idx)
    await memory.write(idx, '# fresh index\n')
    expect(readFileSync(idx, 'utf8')).toBe('# fresh index\n')
    await memory.write(join(folder, 'CLAUDE.md'), '# p2\n')
    await memory.write(join(dataDir, 'agents', 'ag', 'memory.md'), '# a\n')
    expect(readFileSync(idx, 'utf8')).toBe('# fresh index\n')
  })
})

describe('list — the "agent" layer (v1.1/C)', () => {
  it('no agentId -> agent is null', async () => {
    const layers = await memory.list(folder)
    expect(layers.agent).toBeNull()
  })

  it('with the agentId of an active agent -> agent describes the file (even if it does not exist yet)', async () => {
    const layers = await memory.list(undefined, 'ag')
    expect(layers.agent).not.toBeNull()
    expect(layers.agent?.exists).toBe(false)
    expect(layers.agent?.name).toBe('Agent memory')
    expect(layers.agent?.path).toBe(join(dataDir, 'agents', 'ag', 'memory.md'))
  })

  it('an unknown agentId -> error', async () => {
    await expect(memory.list(undefined, 'missing')).rejects.toThrow('agent not recognized')
  })

  it('an archived agent -> error (out of play, same as its CLAUDE.md)', async () => {
    registry.archive('ag')
    await expect(memory.list(undefined, 'ag')).rejects.toThrow('agent not recognized')
  })
})

describe('agent memory — read/write (v1.1/C)', () => {
  it('the first write creates the dataDir/agents/<id>/ directory (which does not exist yet) with no backup', async () => {
    const target = join(dataDir, 'agents', 'ag', 'memory.md')
    expect(existsSync(target)).toBe(false)
    const { backup } = await memory.write(target, '# agent notes\n')
    expect(backup).toBeNull()
    expect(readFileSync(target, 'utf8')).toBe('# agent notes\n')
  })

  it('successive writes back up under memory-backups/<agentId>/', async () => {
    const target = join(dataDir, 'agents', 'ag', 'memory.md')
    await memory.write(target, 'v1')
    const { backup } = await memory.write(target, 'v2')
    expect(backup).toBeTruthy()
    expect(backup).toContain(join(dataDir, 'memory-backups', 'ag'))
    expect(readFileSync(backup!, 'utf8')).toBe('v1')
    expect(readFileSync(target, 'utf8')).toBe('v2')
  })

  it('reads content already written', async () => {
    const target = join(dataDir, 'agents', 'ag', 'memory.md')
    await memory.write(target, 'memory content')
    expect(await memory.read(target)).toBe('memory content')
  })

  it('the memory of an archived agent -> not allowed (neither read nor write)', async () => {
    const target = join(dataDir, 'agents', 'ag', 'memory.md')
    await memory.write(target, 'something') // while it was still active
    registry.archive('ag')
    await expect(memory.read(target)).rejects.toThrow('not allowed')
    await expect(memory.write(target, 'something else')).rejects.toThrow('not allowed')
  })

  it('the memory of an agent that does not exist in the registry -> not allowed', async () => {
    const target = join(dataDir, 'agents', 'ghost', 'memory.md')
    await expect(memory.write(target, 'x')).rejects.toThrow('not allowed')
  })
})

describe('allowlist — only the 3 allowed roots', () => {
  it('a .. traversal landing outside the roots -> rejected', async () => {
    const traversal = join(memDir, '..', '..', 'secret.md')
    await expect(memory.read(traversal)).rejects.toThrow('not allowed')
  })

  it('a symlink that escapes the allowed tree -> rejected', async () => {
    const secret = join(base, 'secret.md')
    writeFileSync(secret, 'top secret')
    const link = join(memDir, 'link.md')
    symlinkSync(secret, link)
    await expect(memory.read(link)).rejects.toThrow('not allowed')
  })

  it('a file with no .md extension inside memory/ -> rejected', async () => {
    const other = join(memDir, 'note.txt')
    writeFileSync(other, 'x')
    await expect(memory.read(other)).rejects.toThrow('not allowed')
  })

  it('a file nested in a subfolder of memory/ -> rejected (only directly inside is allowed)', async () => {
    const sub = join(memDir, 'sub')
    mkdirSync(sub)
    const nested = join(sub, 'x.md')
    writeFileSync(nested, 'x')
    await expect(memory.read(nested)).rejects.toThrow('not allowed')
  })

  it('an arbitrary path under home (not CLAUDE.md, not memory/) -> rejected', async () => {
    const arbitrary = join(base, 'other.md')
    writeFileSync(arbitrary, 'x')
    await expect(memory.read(arbitrary)).rejects.toThrow('not allowed')
  })

  it('the CLAUDE.md of a folder that belongs to no registered agent -> rejected', async () => {
    const otherFolder = join(base, 'no-agent')
    mkdirSync(otherFolder, { recursive: true })
    writeFileSync(join(otherFolder, 'CLAUDE.md'), 'x')
    await expect(memory.read(join(otherFolder, 'CLAUDE.md'))).rejects.toThrow('not allowed')
  })

  it('write also respects the allowlist', async () => {
    await expect(memory.write(join(base, 'other.md'), 'x')).rejects.toThrow('not allowed')
  })
})

// spec memory-places T3 — a write is allowed only on a file the server
// itself lists (Harness.instructions.list for that folder or login), never
// by its name under a folder; new files only at the list's fixed places
describe('the write boundary — only what the server lists', () => {
  let home: string, login: string, extra: string, proj: string, svc: MemoryService, data: string, reg: AgentRegistry
  beforeEach(() => {
    const b = mkdtempSync(join(tmpdir(), 'mem-places-'))
    home = join(b, 'home')
    login = join(home, '.claude')
    extra = join(b, 'accounts', 'sam')
    proj = join(home, 'work', 'proj')
    data = join(b, 'data')
    for (const d of [join(login, 'projects'), extra, proj, data]) mkdirSync(d, { recursive: true })
    reg = new AgentRegistry(join(data, 'agents.json'))
    reg.load()
    reg.create({ id: 'builder', name: 'Builder', folder: proj })
    svc = new MemoryService(join(login, 'projects'), data, reg, { instructions: { home, loginDirs: () => [login, extra] } })
  })
  const put = (rel: string, text = 'x'): string => {
    const p = join(proj, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, text)
    return p
  }

  it("a listed file of every kind is written (the machine's with confirmed)", async () => {
    put('CLAUDE.md', 'Read @AGENTS.md')
    const files = [
      put('AGENTS.md'),
      put('.claude/CLAUDE.md'),
      put('.claude/rules/api.md'),
      put('CLAUDE.local.md'),
      put('web/CLAUDE.md'),
      put('web/.claude/rules/ui.md'),
      join(proj, 'CLAUDE.md'),
    ]
    for (const f of files) {
      await svc.write(f, `new ${f}`)
      expect(readFileSync(f, 'utf8')).toBe(`new ${f}`)
    }
    mkdirSync(join(login, 'rules'), { recursive: true })
    writeFileSync(join(login, 'CLAUDE.md'), 'mine')
    writeFileSync(join(login, 'rules', 'style.md'), 'rule')
    for (const f of [join(login, 'CLAUDE.md'), join(login, 'rules', 'style.md')]) {
      await svc.write(f, 'machine', { confirmed: true })
      expect(readFileSync(f, 'utf8')).toBe('machine')
    }
    const note = join(login, 'projects', mungePath(proj), 'memory', 'learned.md')
    await svc.write(note, '---\nname: learned\n---\nbody\n')
    expect(readFileSync(join(dirname(note), 'MEMORY.md'), 'utf8')).toContain('](learned.md)')
  })

  it('new files only at the fixed places — one plain name in a rules folder', async () => {
    for (const f of [join(proj, 'CLAUDE.md'), join(proj, 'CLAUDE.local.md'), join(proj, '.claude', 'rules', 'style.md')]) {
      await svc.write(f, 'new')
      expect(existsSync(f)).toBe(true)
    }
    await svc.write(join(login, 'rules', 'mine.md'), 'r', { confirmed: true })
    await svc.write(join(extra, 'CLAUDE.md'), 'sam', { confirmed: true })
    for (const f of [
      join(proj, '.claude', 'rules', 'deep', 'x.md'),
      join(proj, '.claude', 'rules', '.hidden.md'),
      join(proj, '.claude', 'rules', 'x.txt'),
      join(proj, 'notes.md'),
      join(proj, 'web', 'CLAUDE.md'),
      join(proj, '.claude', 'CLAUDE.md'),
      join(proj, 'AGENTS.md'),
    ]) {
      await expect(svc.write(f, 'x'), f).rejects.toThrow('not allowed')
      expect(existsSync(f)).toBe(false)
    }
  })

  it('refused: a right name the scan does not list, anything under .git or node_modules, traversal, a link out of its root', async () => {
    let deep = proj
    for (let i = 0; i < 8; i++) deep = join(deep, `d${i}`)
    const unlisted = put(join(deep.slice(proj.length + 1), 'CLAUDE.md'), 'deep')
    const refused = [
      unlisted,
      put('.git/CLAUDE.md'),
      join(proj, '.git', 'info', 'CLAUDE.md'),
      put('node_modules/pkg/CLAUDE.md'),
      put('.cache/CLAUDE.md'),
      join(proj, 'web', '..', '..', 'CLAUDE.md'),
      `${proj}/.claude/rules/../../../CLAUDE.local.md`,
    ]
    writeFileSync(join(home, 'secret.md'), 'secret')
    symlinkSync(join(home, 'secret.md'), join(proj, 'CLAUDE.md'))
    for (const f of refused) await expect(svc.write(f, 'x'), f).rejects.toThrow(/not allowed|read-only/)
    await expect(svc.write(join(proj, 'CLAUDE.md'), 'x')).rejects.toThrow('read-only')
    expect(readFileSync(join(home, 'secret.md'), 'utf8')).toBe('secret')
    expect(readFileSync(unlisted, 'utf8')).toBe('deep')
  })

  it('refused: a new file at a place linked out of its root (a rules folder, an auto-memory dir)', async () => {
    const outside = join(home, 'outside')
    mkdirSync(outside, { recursive: true })
    mkdirSync(join(proj, '.claude'), { recursive: true })
    symlinkSync(outside, join(proj, '.claude', 'rules'))
    mkdirSync(join(login, 'projects', mungePath(proj)), { recursive: true })
    symlinkSync(outside, join(login, 'projects', mungePath(proj), 'memory'))
    await expect(svc.write(join(proj, '.claude', 'rules', 'x.md'), 'x')).rejects.toThrow('not allowed')
    await expect(svc.write(join(login, 'projects', mungePath(proj), 'memory', 'n.md'), 'x')).rejects.toThrow('not allowed')
    expect(readdirSync(outside)).toEqual([])
  })

  it("refused: a login dir's other files — only its own CLAUDE.md and rules", async () => {
    writeFileSync(join(login, 'settings.json'), '{}')
    mkdirSync(join(login, 'agents'), { recursive: true })
    for (const f of [
      join(login, 'settings.json'),
      join(login, 'agents', 'x.md'),
      join(login, 'notes.md'),
      join(login, 'projects', 'x.md'),
      join(login, 'rules', 'sub', 'x.md'),
      join(extra, 'settings.json'),
    ]) {
      await expect(svc.write(f, 'x', { confirmed: true }), f).rejects.toThrow('not allowed')
    }
    expect(readFileSync(join(login, 'settings.json'), 'utf8')).toBe('{}')
  })

  it('a machine file without confirmed: refused (409), nothing written', async () => {
    writeFileSync(join(login, 'CLAUDE.md'), 'mine')
    await expect(svc.write(join(login, 'CLAUDE.md'), 'x')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('confirm') })
    await expect(svc.write(join(login, 'rules', 'new.md'), 'x')).rejects.toMatchObject({ status: 409 })
    expect(readFileSync(join(login, 'CLAUDE.md'), 'utf8')).toBe('mine')
    expect(existsSync(join(login, 'rules', 'new.md'))).toBe(false)
  })

  it('refused: an archived agent — its folder and its memory', async () => {
    put('CLAUDE.md', 'p')
    await svc.write(join(data, 'agents', 'builder', 'memory.md'), 'm')
    reg.archive('builder')
    await expect(svc.write(join(proj, 'CLAUDE.md'), 'x')).rejects.toThrow('not allowed')
    await expect(svc.write(join(proj, 'CLAUDE.md'), 'x', { folder: proj })).rejects.toThrow('folder not recognized')
    await expect(svc.write(join(data, 'agents', 'builder', 'memory.md'), 'x')).rejects.toThrow('not allowed')
  })

  it('a home-folder agent: its CLAUDE.md, edited or created — every other file of it refused, saying why', async () => {
    reg.create({ id: 'house', name: 'House', folder: home })
    await svc.write(join(home, 'CLAUDE.md'), 'created')
    await svc.write(join(home, 'CLAUDE.md'), 'edited')
    expect(readFileSync(join(home, 'CLAUDE.md'), 'utf8')).toBe('edited')
    writeFileSync(join(home, 'CLAUDE.local.md'), 'l')
    mkdirSync(join(home, 'sub'), { recursive: true })
    writeFileSync(join(home, 'sub', 'CLAUDE.md'), 's')
    for (const f of [join(home, 'CLAUDE.local.md'), join(home, 'sub', 'CLAUDE.md')]) {
      await expect(svc.write(f, 'x', { folder: home }), f).rejects.toThrow(/read-only: .*config folder/)
    }
    await expect(svc.write(join(home, 'AGENTS.md'), 'x', { folder: home })).rejects.toThrow('not allowed')
    expect(readFileSync(join(home, 'CLAUDE.local.md'), 'utf8')).toBe('l')
  })

  it('a moved auto memory: listed read-only, naming the file that moved it — the default place refused too', async () => {
    const moved = join(home, 'notes')
    mkdirSync(moved, { recursive: true })
    writeFileSync(join(moved, 'MEMORY.md'), 'idx')
    mkdirSync(join(proj, '.claude'), { recursive: true })
    writeFileSync(join(proj, '.claude', 'settings.local.json'), JSON.stringify({ autoMemoryDirectory: moved }))
    const rows = (await svc.list(proj)).rows!
    expect(rows.find((r) => r.real === join(moved, 'MEMORY.md'))).toMatchObject({ editable: false, movedBy: join(proj, '.claude', 'settings.local.json') })
    await expect(svc.write(join(moved, 'MEMORY.md'), 'x')).rejects.toThrow(/not allowed|read-only/)
    await expect(svc.write(join(moved, 'MEMORY.md'), 'x', { folder: proj })).rejects.toThrow('read-only')
    await expect(svc.write(join(login, 'projects', mungePath(proj), 'memory', 'n.md'), 'x')).rejects.toThrow('not allowed')
  })

  it('backups keyed by the path relative to the root: three files of one name never share a folder', async () => {
    const files = [put('CLAUDE.md', 'top'), put('.claude/CLAUDE.md', 'dot'), put('web/CLAUDE.md', 'web')]
    const backups = []
    for (const f of files) backups.push((await svc.write(f, 'new')).backup!)
    const seg = join(data, 'memory-backups', mungePath(proj))
    expect(backups.map((b) => dirname(b))).toEqual([seg, join(seg, '.claude'), join(seg, 'web')])
    expect(backups.map((b) => readFileSync(b, 'utf8'))).toEqual(['top', 'dot', 'web'])
  })

  it('the ignore line: only on a create that asks, only when <folder>/.git is a directory', async () => {
    const exclude = join(proj, '.git', 'info', 'exclude')
    // asked, but the folder's git is elsewhere (a worktree's .git file): nothing written
    writeFileSync(join(proj, '.git'), 'gitdir: /elsewhere')
    expect(await svc.write(join(proj, 'CLAUDE.local.md'), 'a', { ignoreLine: true })).toMatchObject({ ignored: false })
    rmSync(join(proj, '.git'))
    rmSync(join(proj, 'CLAUDE.local.md'))
    mkdirSync(join(proj, '.git'))
    // not asked: nothing written
    await svc.write(join(proj, 'CLAUDE.local.md'), 'b')
    expect(existsSync(exclude)).toBe(false)
    rmSync(join(proj, 'CLAUDE.local.md'))
    // asked, on a create, with .git a directory: the line, once
    expect(await svc.write(join(proj, 'CLAUDE.local.md'), 'c', { ignoreLine: true })).toMatchObject({ ignored: true })
    expect(readFileSync(exclude, 'utf8')).toBe('CLAUDE.local.md\n')
    // an edit never writes it
    writeFileSync(exclude, '')
    expect((await svc.write(join(proj, 'CLAUDE.local.md'), 'd', { ignoreLine: true })).ignored).toBeUndefined()
    expect(readFileSync(exclude, 'utf8')).toBe('')
  })

  it('read: any listed row opens; an unlisted file does not', async () => {
    put('.claude/rules/api.md', 'rule')
    writeFileSync(join(home, 'secret.md'), 'secret')
    expect(await svc.read(join(proj, '.claude', 'rules', 'api.md'), proj)).toBe('rule')
    expect(await svc.read(join(proj, '.claude', 'rules', 'api.md'))).toBe('rule')
    await expect(svc.read(join(home, 'secret.md'), proj)).rejects.toThrow('not allowed')
  })
})

// Memory per agent (t48): the agent's own auto-memory dir
// (<dataDir>/agents/<id>/memory) is a first-class layer — listed on the
// agent's page in place of the folder's, writable with its own index and
// backups, and closed to anything that is not an active agent's dir.
describe("memory per agent — the agent's own auto-memory dir", () => {
  it("list with an agentId lists the agent dir as the auto layer and swaps the folder's auto rows", async () => {
    const aDir = agentAutoMemoryDir(dataDir, 'ag')
    mkdirSync(aDir, { recursive: true })
    writeFileSync(join(aDir, 'MEMORY.md'), '- [Own note](own-note.md)\n')
    writeFileSync(join(aDir, 'own-note.md'), '---\nname: Own note\ndescription: mine\ntype: note\n---\nx\n')
    const layers = await memory.list(folder, 'ag')
    expect(layers.autoDir).toBe(aDir)
    expect(layers.autoMemory.map((f) => f.name).sort()).toEqual(['MEMORY', 'Own note'])
    expect(layers.autoMemory.find((f) => f.type !== 'index')!.author).toBe('ag')
    const autoRows = (layers.rows ?? []).filter((r) => r.origin === 'auto')
    expect(autoRows.length).toBeGreaterThan(0)
    expect(autoRows.every((r) => r.path.startsWith(aDir))).toBe(true)
    expect(autoRows.some((r) => r.kind === 'auto-index' && r.when.at === 'start')).toBe(true)
    // the folder page (no agent) keeps the folder's own dir
    const folderLayers = await memory.list(folder)
    expect(folderLayers.autoDir).toBe(memDir)
    expect(folderLayers.autoMemory.some((f) => f.path === join(memDir, 'card-1.md'))).toBe(true)
  })

  it('writes a note in the agent dir: indexed in ITS MEMORY.md, backed up under its own segment, readable back', async () => {
    const aDir = agentAutoMemoryDir(dataDir, 'ag')
    mkdirSync(aDir, { recursive: true })
    const p = join(aDir, 'fact.md')
    await memory.write(p, '---\nname: Fact\ndescription: d\ntype: note\n---\nbody\n')
    expect(readFileSync(join(aDir, 'MEMORY.md'), 'utf8')).toContain('](fact.md)')
    await memory.write(p, '---\nname: Fact\n---\nbody 2\n')
    expect(readdirSync(join(dataDir, 'memory-backups', 'agent-ag')).some((f) => f.startsWith('fact'))).toBe(true)
    expect(await memory.read(p)).toContain('body 2')
  })

  it('an agent of an engine without auto memory keeps the folder view: no swap, no agent-dir writes', async () => {
    const unregister = registerHarness(makeFakeHarness())
    try {
      registry.create({ id: 'fk', name: 'Fake', folder, framework: 'fake' })
      const layers = await memory.list(folder, 'fk')
      expect(layers.autoScope).toBe('folder')
      expect(layers.autoDir).toBe(memDir)
      expect(layers.autoMemory.some((f) => f.path === join(memDir, 'card-1.md'))).toBe(true)
      const bad = join(dataDir, 'agents', 'fk', 'memory', 'x.md')
      await expect(memory.write(bad, 'y')).rejects.toThrow('not allowed')
    } finally {
      unregister()
    }
  })

  it('a dir of nobody is refused, read and write', async () => {
    const bad = join(dataDir, 'agents', 'nobody', 'memory', 'x.md')
    mkdirSync(dirname(bad), { recursive: true })
    writeFileSync(bad, 'x')
    await expect(memory.write(bad, 'y')).rejects.toThrow('not allowed')
    await expect(memory.read(bad)).rejects.toThrow('not allowed')
  })
})
