import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextService, UPLOAD_CAP } from '../src/context-service.js'
import { FileError } from '../src/file-service.js'

let svc: ContextService, folder: string
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'ctx-'))
  svc = new ContextService()
})

const buf = (s: string) => Buffer.from(s, 'utf8')

describe('ContextService.save + list — scopes', () => {
  it('shared lands in <folder>/context/shared/ and gets listed', () => {
    const f = svc.save(folder, 'shared', 'builder', 'report.md', buf('# hi'))
    expect(f.path).toBe(join(folder, 'context', 'shared', 'report.md'))
    expect(f.scope).toBe('shared')
    expect(f.kind).toBe('markdown')
    expect(readFileSync(f.path, 'utf8')).toBe('# hi')
    const { shared, agent } = svc.list([folder], 'builder')
    expect(shared.map((x) => x.name)).toEqual(['report.md'])
    expect(agent).toEqual([])
  })

  it('agent lands in <folder>/context/<id>/ and only THAT agent sees it', () => {
    svc.save(folder, 'agent', 'builder', 'secret.md', buf('x'))
    expect(existsSync(join(folder, 'context', 'builder', 'secret.md'))).toBe(true)
    // builder sees it as private; finance (same folder) does NOT
    expect(svc.list([folder], 'builder').agent.map((x) => x.name)).toEqual(['secret.md'])
    expect(svc.list([folder], 'finance').agent).toEqual([])
  })

  it('shared is visible to EVERY agent in the folder', () => {
    svc.save(folder, 'shared', 'builder', 'common.md', buf('x'))
    expect(svc.list([folder], 'builder').shared.map((x) => x.name)).toEqual(['common.md'])
    expect(svc.list([folder], 'finance').shared.map((x) => x.name)).toEqual(['common.md'])
  })

  it('overwrites by name (same scope) without duplicating', () => {
    svc.save(folder, 'shared', 'builder', 'n.md', buf('v1'))
    svc.save(folder, 'shared', 'builder', 'n.md', buf('v2'))
    expect(svc.list([folder], 'builder').shared).toHaveLength(1)
    expect(readFileSync(join(folder, 'context', 'shared', 'n.md'), 'utf8')).toBe('v2')
  })
})

describe('ContextService — security (containment)', () => {
  it('rejects names with a path or ".." (collapses to an invalid basename)', () => {
    expect(() => svc.save(folder, 'shared', 'builder', '../escape.md', buf('x'))).toThrow(FileError)
    expect(() => svc.save(folder, 'shared', 'builder', 'sub/dir.md', buf('x'))).toThrow(FileError)
    expect(() => svc.save(folder, 'shared', 'builder', '..', buf('x'))).toThrow(FileError)
    // a dot-name would be hidden by the listing's walk: refused, never written
    let err: unknown
    try {
      svc.save(folder, 'shared', 'builder', '.env.example', buf('x'))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(FileError)
    expect(err).toMatchObject({ status: 400, message: 'names starting with a dot are not allowed' })
    expect(existsSync(join(folder, 'context', 'shared', '.env.example'))).toBe(false)
    // nothing escaped the folder
    expect(existsSync(join(folder, 'escape.md'))).toBe(false)
  })

  it('an agent without a folder (master) has no context -> an honest error', () => {
    expect(() => svc.list([null as unknown as string], 'master')).toThrow(FileError)
    expect(() => svc.save(null as unknown as string, 'shared', 'master', 'x.md', buf('y'))).toThrow(FileError)
  })

  it('the upload cap is enforced (413)', () => {
    expect(() => svc.save(folder, 'shared', 'builder', 'big.bin', Buffer.alloc(UPLOAD_CAP + 1))).toThrow(FileError)
  })

  it('deleting a symlink inside context/ removes ONLY the link, never the file it points to', () => {
    // seed a file outside and a symlink inside shared/
    const outside = join(folder, 'outside.md')
    writeFileSync(outside, 'secret')
    const sharedDir = join(folder, 'context', 'shared')
    mkdirSync(sharedDir, { recursive: true })
    symlinkSync(outside, join(sharedDir, 'link.md'))
    // the name is contained (a plain basename inside shared/): deletes the
    // LINK, not the target — rmSync on a symlink removes the link itself.
    svc.remove(folder, 'shared', 'builder', 'link.md')
    expect(existsSync(join(sharedDir, 'link.md'))).toBe(false)
    expect(existsSync(outside)).toBe(true) // the original, untouched
  })
})

describe('ContextService.remove', () => {
  it('deletes the file from the right scope and is idempotent', () => {
    svc.save(folder, 'agent', 'builder', 'a.md', buf('x'))
    svc.remove(folder, 'agent', 'builder', 'a.md')
    expect(svc.list([folder], 'builder').agent).toEqual([])
    // a second call does not blow up
    expect(() => svc.remove(folder, 'agent', 'builder', 'a.md')).not.toThrow()
  })
})

describe('ContextService.awarenessNote', () => {
  it('with no files -> null (does not clutter the systemPrompt)', () => {
    expect(svc.awarenessNote(folder, 'builder')).toBeNull()
  })

  it('lists shared + own files with paths the agent can read', () => {
    svc.save(folder, 'shared', 'builder', 'common.pdf', buf('x'))
    svc.save(folder, 'agent', 'builder', 'mine.md', buf('y'))
    const note = svc.awarenessNote(folder, 'builder')!
    expect(note).toContain('context/shared/common.pdf')
    expect(note).toContain('context/builder/mine.md')
    // mentions that they're read with Read on demand (no preload)
    expect(note.toLowerCase()).toContain('read')
  })

  it("an agent only sees ITS OWN private files in the note, never another agent's", () => {
    svc.save(folder, 'agent', 'finance', 'from-finance.md', buf('x'))
    expect(svc.awarenessNote(folder, 'builder')).toBeNull() // builder has nothing
    expect(svc.awarenessNote(folder, 'finance')).toContain('context/finance/from-finance.md')
  })
})

describe('awarenessNote — "new since your last turn"', () => {
  it('lists files newer than newSince on top under the news heading; without newSince, the plain list', async () => {
    const { ContextService, CONTEXT_NEWS_HEADING } = await import('../src/context-service.js')
    const { mkdtempSync, utimesSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const folder = mkdtempSync(join(tmpdir(), 'ctx-news-'))
    const svc = new ContextService()
    const old = svc.save(folder, 'shared', 'finance', 'old.md', Buffer.from('x'))
    utimesSync(old.path, new Date(1_000), new Date(1_000))
    svc.save(folder, 'agent', 'finance', '036-08-26.pdf', Buffer.from('%PDF'))
    const plain = svc.awarenessNote(folder, 'finance')!
    expect(plain).not.toContain(CONTEXT_NEWS_HEADING)
    const note = svc.awarenessNote(folder, 'finance', { newSince: 5_000 })!
    expect(note.startsWith(`# Context files\n\n${CONTEXT_NEWS_HEADING}\n- context/finance/036-08-26.pdf\n`)).toBe(true)
    expect(note).toContain('- context/shared/old.md') // the full list still follows
    expect(svc.awarenessNote(folder, 'finance', { newSince: Date.now() + 60_000 })).not.toContain(CONTEXT_NEWS_HEADING)
  })
})

describe('ContextService — deliverables at depth, across territories, and produced()', () => {
  it('lists context files to depth 4, relative paths, across every territory; the cap and deeper levels never throw', () => {
    const a = mkdtempSync(join(tmpdir(), 'ctx-a-')),
      b = mkdtempSync(join(tmpdir(), 'ctx-b-'))
    mkdirSync(join(a, 'context', 'builder', 'analysis'), { recursive: true })
    writeFileSync(join(a, 'context', 'builder', 'analysis', '16-audit.md'), '# x')
    mkdirSync(join(a, 'context', 'builder', 'a', 'b', 'c', 'd', 'e'), { recursive: true })
    writeFileSync(join(a, 'context', 'builder', 'a', 'b', 'c', 'd', 'e', 'too-deep.md'), 'x')
    mkdirSync(join(b, 'context', 'builder'), { recursive: true })
    writeFileSync(join(b, 'context', 'builder', 'plan.md'), 'x')
    const svc = new ContextService()
    const { agent } = svc.list([a, b], 'builder')
    expect(agent.map((f) => [f.folder, f.rel])).toEqual([
      [a, 'analysis/16-audit.md'],
      [b, 'plan.md'],
    ])
    expect(agent[0]).toMatchObject({ name: '16-audit.md', scope: 'agent', path: join(a, 'context', 'builder', 'analysis', '16-audit.md') })
  })
  it("produced(): the agent's own folder minus Silos' bookkeeping, scope own", () => {
    const s = mkdtempSync(join(tmpdir(), 'state-'))
    for (const f of ['runmode.json', 'status.json', 'status.log.jsonl', 'watch-state.json', 'token']) writeFileSync(join(s, f), '{}')
    for (const d of ['inbox', 'asks', 'births', 'opencode', 'support']) {
      mkdirSync(join(s, d))
      writeFileSync(join(s, d, 'x.json'), '{}')
    }
    mkdirSync(join(s, 'reports'))
    writeFileSync(join(s, 'reports', 'q4.md'), '# q4')
    writeFileSync(join(s, 'notes.md'), 'n')
    const out = new ContextService().produced(s)
    expect(out.map((f) => f.rel)).toEqual(['notes.md', 'reports/q4.md'])
    expect(out[0]).toMatchObject({ scope: 'own', folder: s, name: 'notes.md' })
    expect(new ContextService().produced(join(s, 'missing'))).toEqual([])
  })
  it('stops at 200 entries and skips symlinks that leave the scope root', () => {
    const a = mkdtempSync(join(tmpdir(), 'ctx-cap-'))
    const dir = join(a, 'context', 'shared')
    mkdirSync(dir, { recursive: true })
    for (let i = 0; i < 250; i++) writeFileSync(join(dir, `f${String(i).padStart(3, '0')}.md`), 'x')
    expect(new ContextService().list([a], 'builder').shared).toHaveLength(200)
    const o = mkdtempSync(join(tmpdir(), 'outside-'))
    writeFileSync(join(o, 'secret.md'), 's')
    const c = mkdtempSync(join(tmpdir(), 'ctx-link-'))
    mkdirSync(join(c, 'context', 'builder'), { recursive: true })
    symlinkSync(join(o, 'secret.md'), join(c, 'context', 'builder', 'leak.md'))
    symlinkSync(o, join(c, 'context', 'builder', 'leakdir'))
    expect(new ContextService().list([c], 'builder').agent).toEqual([])
  })
  it('rows follow the territory order given (primary first), even when the primary path sorts after the secondary', () => {
    const secondary = mkdtempSync(join(tmpdir(), 'ctx-a-sec-')),
      primary = mkdtempSync(join(tmpdir(), 'ctx-z-pri-'))
    expect(primary > secondary).toBe(true)
    for (const f of [primary, secondary]) {
      mkdirSync(join(f, 'context', 'builder'), { recursive: true })
      mkdirSync(join(f, 'context', 'shared'), { recursive: true })
      writeFileSync(join(f, 'context', 'builder', 'b.md'), 'x')
      writeFileSync(join(f, 'context', 'builder', 'a.md'), 'x')
      writeFileSync(join(f, 'context', 'shared', 's.md'), 'x')
    }
    const { shared, agent } = new ContextService().list([primary, secondary], 'builder')
    expect(agent.map((f) => [f.folder, f.rel])).toEqual([
      [primary, 'a.md'],
      [primary, 'b.md'],
      [secondary, 'a.md'],
      [secondary, 'b.md'],
    ])
    expect(shared.map((f) => f.folder)).toEqual([primary, secondary])
  })
  it("maxDepth 0 lists only the scope root's own files; awarenessNote keeps its top-level output", () => {
    const a = mkdtempSync(join(tmpdir(), 'ctx-depth-'))
    mkdirSync(join(a, 'context', 'builder', 'analysis'), { recursive: true })
    writeFileSync(join(a, 'context', 'builder', 'top.md'), 'x')
    writeFileSync(join(a, 'context', 'builder', 'analysis', 'deep.md'), 'x')
    mkdirSync(join(a, 'context', 'shared'), { recursive: true })
    writeFileSync(join(a, 'context', 'shared', 'common.md'), 'x')
    const svc = new ContextService()
    const flat = svc.list([a], 'builder', { maxDepth: 0 })
    expect(flat.agent.map((f) => f.rel)).toEqual(['top.md'])
    expect(flat.shared.map((f) => f.rel)).toEqual(['common.md'])
    expect(svc.list([a], 'builder').agent.map((f) => f.rel)).toEqual(['analysis/deep.md', 'top.md'])
    expect(svc.awarenessNote(a, 'builder')).toBe(
      [
        '# Context files',
        '',
        'Reference files available in this workspace — read them with the Read tool when relevant (they are not preloaded):',
        '',
        'Shared (all agents in this folder):',
        '- context/shared/common.md',
        '',
        'Yours (private to this agent):',
        '- context/builder/top.md',
      ].join('\n'),
    )
  })
  it('never walks dot-entries or node_modules, at any level (.git objects, in-flight .x.tmp-* saves)', () => {
    const a = mkdtempSync(join(tmpdir(), 'ctx-skip-'))
    const dir = join(a, 'context', 'builder')
    mkdirSync(join(dir, '.git', 'objects', 'ab'), { recursive: true })
    for (let i = 0; i < 250; i++) writeFileSync(join(dir, '.git', 'objects', 'ab', `o${i}`), 'x')
    writeFileSync(join(dir, '.x.tmp-1'), 'x')
    mkdirSync(join(dir, 'sub', 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(dir, 'sub', 'node_modules', 'pkg', 'index.js'), 'x')
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'y.js'), 'x')
    writeFileSync(join(dir, 'sub', '.hidden.md'), 'x')
    writeFileSync(join(dir, 'sub', 'real.md'), 'x')
    writeFileSync(join(dir, 'report.md'), 'x')
    expect(new ContextService().list([a], 'builder').agent.map((f) => f.rel)).toEqual(['report.md', 'sub/real.md'])
  })
  it('every visited entry (directories too) counts toward a 2000-stat budget: a sea of empty folders stops the walk', () => {
    const a = mkdtempSync(join(tmpdir(), 'ctx-budget-'))
    const dir = join(a, 'context', 'builder')
    for (let i = 0; i < 2100; i++) mkdirSync(join(dir, `d${String(i).padStart(4, '0')}`), { recursive: true })
    writeFileSync(join(dir, 'd2099', 'late.md'), 'x')
    writeFileSync(join(dir, 'a-early.md'), 'x') // sorts before the d* folders: visited first
    const { agent } = new ContextService().list([a], 'builder')
    expect(agent.map((f) => f.rel)).toEqual(['a-early.md']) // d2099/late.md lies past the budget
  })
})

describe("ContextService — conversation scope (one thread's own files)", () => {
  const T1 = 'aaaaaaaa-1111-4111-8111-111111111111'
  const T2 = 'bbbbbbbb-2222-4222-8222-222222222222'
  it("a thread is told its own folder, never another thread's; the agent listing never includes conversations/", () => {
    svc.save(folder, 'conversation', 'builder', 'brief.md', buf('one'), T1)
    svc.save(folder, 'conversation', 'builder', 'other.md', buf('two'), T2)
    svc.save(folder, 'agent', 'builder', 'ref.md', buf('r'))
    mkdirSync(join(folder, 'context', 'builder', 'work', 'conversations'), { recursive: true })
    writeFileSync(join(folder, 'context', 'builder', 'work', 'conversations', 'deep.md'), 'x') // skipped at every depth
    const l = svc.list([folder], 'builder', { thread: T1 })
    expect(l.agent.map((f) => f.rel)).toEqual(['ref.md'])
    expect(l.conversation.map((f) => f.rel)).toEqual(['brief.md'])
    expect(svc.list([folder], 'builder').conversation).toEqual([])
    const note = svc.awarenessNote(folder, 'builder', { thread: { id: T1, folder, cwd: folder } })!
    expect(note).toContain(`- context/builder/conversations/${T1}/brief.md`)
    expect(note).not.toContain('other.md')
    expect(svc.awarenessNote(folder, 'builder')).not.toContain('brief.md')
    expect(svc.conversationThreads(folder, 'builder')).toEqual([T1, T2])
  })
  it('an id that is a path is refused; a symlinked conversations dir or thread dir is refused, never followed', () => {
    for (const bad of ['../x', '..', 'a/b', 'short', '', `${T1}/..`]) {
      expect(() => svc.save(folder, 'conversation', 'builder', 'x.md', buf('x'), bad)).toThrow(FileError)
    }
    expect(() => svc.save(folder, 'conversation', 'builder', 'x.md', buf('x'))).toThrow(FileError)
    // conversations → a folder elsewhere inside the same tree
    const other = join(folder, 'context', 'builder', 'elsewhere')
    mkdirSync(other, { recursive: true })
    symlinkSync(other, join(folder, 'context', 'builder', 'conversations'))
    expect(() => svc.save(folder, 'conversation', 'builder', 'x.md', buf('x'), T1)).toThrow(FileError)
    expect(svc.list([folder], 'builder', { thread: T1 }).conversation).toEqual([])
    // conversations/<T1> → conversations/<T2>: T2's files never read as T1's
    const f2 = mkdtempSync(join(tmpdir(), 'ctx-conv-'))
    mkdirSync(join(f2, 'context', 'builder', 'conversations', T2), { recursive: true })
    writeFileSync(join(f2, 'context', 'builder', 'conversations', T2, 'secret.md'), 's')
    symlinkSync(join(f2, 'context', 'builder', 'conversations', T2), join(f2, 'context', 'builder', 'conversations', T1))
    expect(() => svc.save(f2, 'conversation', 'builder', 'x.md', buf('x'), T1)).toThrow(FileError)
    expect(svc.list([f2], 'builder', { thread: T1 }).conversation).toEqual([])
    expect(svc.conversationThreads(f2, 'builder')).toEqual([T2])
    // the reserved name never lands at the agent's top level
    expect(() => svc.save(f2, 'agent', 'builder', 'conversations', buf('x'))).toThrow(FileError)
  })
  it("promote renames a regular file up to the agent's top level and refuses to overwrite", () => {
    svc.save(folder, 'conversation', 'builder', 'list.csv', buf('a,b'), T1)
    const moved = svc.promote(folder, 'builder', T1, 'list.csv')
    expect(moved.path).toBe(join(folder, 'context', 'builder', 'list.csv'))
    expect(readFileSync(moved.path, 'utf8')).toBe('a,b')
    expect(existsSync(join(folder, 'context', 'builder', 'conversations', T1, 'list.csv'))).toBe(false)
    svc.save(folder, 'conversation', 'builder', 'list.csv', buf('new'), T1)
    expect(() => svc.promote(folder, 'builder', T1, 'list.csv')).toThrow(expect.objectContaining({ status: 409 }))
    expect(readFileSync(moved.path, 'utf8')).toBe('a,b')
    // a link is never moved
    symlinkSync(moved.path, join(folder, 'context', 'builder', 'conversations', T1, 'link.csv'))
    expect(() => svc.promote(folder, 'builder', T1, 'link.csv')).toThrow(expect.objectContaining({ status: 400 }))
    expect(() => svc.promote(folder, 'builder', T1, 'missing.csv')).toThrow(expect.objectContaining({ status: 404 }))
  })
})
