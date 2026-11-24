// silo-worktrees.test.ts — the kernel kind `worktree` (the System silo's
// second view, silos/worktrees.ts) over REAL temporary git repos: the states
// (merged by ancestry and by patch, unmerged by commit and by tracked change,
// in use by a process and by a live conversation), attribution, the guard,
// remove-worktree's refusals and what it leaves in the trash (leftovers, a
// bundle the branch is recoverable from), Silos closing merged idle ones
// (never unmerged), the main checkout never listed nor removed; and the
// manifest with its two kernel sources. Fixtures are generic; the clock is
// injected (commit dates and the .git file's birth are pinned to it).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KERNEL_KINDS, kernelFeeds } from '../src/silos/kernel-kinds.js'
import { validateSilo } from '../src/silos/validator.js'
import { SiloReader } from '../src/silos/reader.js'
import { purgeTrash } from '../src/trash-purge.js'
import { ProcessRecords, SILOS_SESSION_KEY, type ConversationFacts } from '../src/silos/processes.js'
import { WORKTREE_IDLE_CLOSE_MS, WORKTREE_TRASH_FOLDER, WorktreeRecords, parseStatus, parseWorktreeList } from '../src/silos/worktrees.js'
import type { ProcEntry } from '../src/silos/proc-table.js'

const T0 = Date.parse('2026-11-21T10:00:00Z')
const DAY = 24 * 3600_000
const REF = join(import.meta.dirname, '..', '..', 'docs', 'standard', 'reference', 'system.silo.json')

let dir: string
let proj: string
let trash: string
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'silos-wt-')))
  proj = join(dir, 'shop')
  trash = join(dir, 'data', 'trash')
  mkdirSync(proj)
  git(proj, 'init', '-q', '-b', 'main')
  commit(proj, 'readme', 'a')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// git as a person at the keyboard — every date pinned a day before T0
function git(cwd: string, ...args: string[]): string {
  const at = `${Math.floor((T0 - DAY) / 1000)} +0000`
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'op',
      GIT_AUTHOR_EMAIL: 'op@example.test',
      GIT_COMMITTER_NAME: 'op',
      GIT_COMMITTER_EMAIL: 'op@example.test',
      GIT_AUTHOR_DATE: at,
      GIT_COMMITTER_DATE: at,
      GIT_CONFIG_NOSYSTEM: '1',
    },
  })
}
function commit(cwd: string, file: string, text: string): string {
  writeFileSync(join(cwd, file), text)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-q', '-m', `${file}: ${text}`)
  return git(cwd, 'rev-parse', 'HEAD').trim()
}
// a worktree on a new branch, its .git file born a day before T0
function worktree(name: string, branch = name): string {
  const p = join(proj, '.claude', 'worktrees', name)
  git(proj, 'worktree', 'add', '-q', '-b', branch, p)
  const s = (T0 - DAY) / 1000
  utimesSync(join(p, '.git'), s, s)
  return p
}

interface World {
  src: WorktreeRecords
  now: number
  procs: Map<string, { count: number; sessions: string[] }> // dir → what runs inside
  procsReadable: boolean
  sessions: Map<string, string[]> // dir → sessions the engines place there
  facts: Map<string, ConversationFacts | null>
  changes: number
}
function world(o: { autoRemove?: boolean } = {}): World {
  const w: World = {
    src: null as unknown as WorktreeRecords,
    now: T0,
    procs: new Map(),
    procsReadable: true,
    sessions: new Map(),
    facts: new Map(),
    changes: 0,
  }
  w.src = new WorktreeRecords({
    file: join(dir, 'data', 'silos', 'kernel', 'worktree', 'worktrees.json'),
    trashDir: trash,
    projects: () => [proj],
    sessionsIn: async (wts) => new Map(wts.map((x) => [x.dir, w.sessions.get(x.dir) ?? []])),
    conversations: (ids) => new Map(ids.map((id) => [id, w.facts.get(id) ?? null])),
    inside: async (dirs) => (w.procsReadable ? new Map(dirs.map((d) => [d, w.procs.get(d) ?? { count: 0, sessions: [] }])) : null),
    now: () => w.now,
    onChange: () => {
      w.changes++
    },
    ...(o.autoRemove !== undefined ? { autoRemove: o.autoRemove } : {}),
  })
  return w
}
const conv = (session: string, running: boolean, title = 'Stripe checkout'): ConversationFacts => ({
  session,
  folder: '-home-op-shop',
  agent: 'writer',
  title,
  running,
})
const byPath = (w: World): Map<string, Record<string, unknown>> => new Map(w.src.records().map((r) => [String(r.value.path), r.value]))
const branches = (): string[] => git(proj, 'branch', '--format=%(refname:short)').trim().split('\n').filter(Boolean).sort()

describe('the kernel kind `worktree` — states over real repos', () => {
  it('merged by ancestry and by patch, unmerged by commit and by tracked change; the main checkout is never a record', async () => {
    const ff = worktree('ff')
    commit(ff, 'ff.txt', 'x')
    git(proj, 'merge', '-q', '--ff-only', 'ff') // in main by ancestry
    const picked = worktree('picked')
    commit(picked, 'p1.txt', '1')
    commit(picked, 'p2.txt', '2')
    commit(proj, 'other.txt', 'main moved on')
    for (const c of git(picked, 'rev-list', '--reverse', 'main..picked').trim().split('\n')) git(proj, 'cherry-pick', c) // in main by patch
    const ahead = worktree('ahead')
    commit(ahead, 'a.txt', 'not in main')
    const dirty = worktree('dirty')
    writeFileSync(join(dirty, 'readme'), 'edited, not committed')
    writeFileSync(join(dirty, 'notes.txt'), 'untracked')

    const w = world({ autoRemove: false })
    await w.src.tick()
    const r = byPath(w)
    expect([...r.keys()].sort()).toEqual(['.claude/worktrees/ahead', '.claude/worktrees/dirty', '.claude/worktrees/ff', '.claude/worktrees/picked'])
    expect([...r.values()].some((v) => v.dir === proj)).toBe(false)
    expect(r.get('.claude/worktrees/ff')).toMatchObject({
      state: 'merged',
      ahead: 0,
      landed: 0,
      changes: 0,
      branch: 'ff',
      base: 'main',
      removable: true,
      project: proj,
    })
    expect(r.get('.claude/worktrees/picked')).toMatchObject({
      state: 'merged',
      ahead: 2,
      landed: 2,
      removable: true,
      why: 'its 2 commits landed in main by patch (cherry-picked)',
    })
    expect(r.get('.claude/worktrees/ahead')).toMatchObject({ state: 'unmerged', ahead: 1, landed: 0, removable: false, why: '1 commit not in main' })
    expect(r.get('.claude/worktrees/dirty')).toMatchObject({
      state: 'unmerged',
      ahead: 0,
      changes: 1,
      leftovers: 1,
      removable: false,
      why: '1 tracked file changed',
    })
    expect(r.get('.claude/worktrees/ff')!.lastCommitAt).toBe(new Date(T0 - DAY).toISOString())
  })

  it("in use by a process inside it, or by its live conversation — in use wins; attribution by the engines, else by a process's session", async () => {
    const a = worktree('a') // merged (nothing ahead)
    const b = worktree('b')
    commit(b, 'b.txt', 'work')
    const c = worktree('c')
    const d = worktree('d')
    const w = world({ autoRemove: false })
    w.procs.set(a, { count: 2, sessions: [] })
    w.sessions.set(b, ['s-live'])
    w.facts.set('s-live', conv('s-live', true))
    w.procs.set(c, { count: 1, sessions: ['s-proc'] })
    w.facts.set('s-proc', conv('s-proc', false, 'Shipping'))
    w.sessions.set(d, ['s-gone'])
    await w.src.tick()
    const r = byPath(w)
    expect(r.get('.claude/worktrees/a')).toMatchObject({ state: 'in-use', processes: 2, why: '2 processes run inside it', removable: false })
    expect(r.get('.claude/worktrees/b')).toMatchObject({
      state: 'in-use',
      why: 'its conversation is running — 1 commit not in main',
      session: 's-live',
      folder: '-home-op-shop',
      agent: 'writer',
      conversation: 'Stripe checkout',
    })
    expect(r.get('.claude/worktrees/c')).toMatchObject({ state: 'in-use', session: 's-proc', conversation: 'Shipping' })
    expect(r.get('.claude/worktrees/d')).toMatchObject({ state: 'merged', session: 's-gone', conversation: 'a deleted conversation (s-gone)' })
    expect(r.get('.claude/worktrees/d')!.folder).toBeUndefined() // nothing to open
    // the conversation stops: b is what it holds — unmerged
    w.facts.set('s-live', conv('s-live', false))
    await w.src.tick()
    expect(byPath(w).get('.claude/worktrees/b')).toMatchObject({ state: 'unmerged' })
  })

  it("a conversation's branch state: merged / N not in main, by its session or else by its folder on the same branch; none on the main checkout", async () => {
    const done = worktree('done')
    commit(done, 'd.txt', 'x')
    git(proj, 'merge', '-q', '--ff-only', 'done')
    const open = worktree('open')
    for (const n of ['1', '2', '3']) commit(open, `o${n}.txt`, n)
    writeFileSync(join(open, 'readme'), 'edited, not committed')
    const w = world({ autoRemove: false })
    w.sessions.set(open, ['s-open'])
    w.facts.set('s-open', conv('s-open', false))
    await w.src.tick()
    // by its session — wherever its cwd says it is
    expect(w.src.branchStateFor({ session: 's-open', cwd: null, branch: 'open' })).toMatchObject({
      branch: 'open',
      base: 'main',
      merged: false,
      missing: 3,
      changes: 1,
    })
    // no session on record: the worktree at its folder, on its branch
    expect(w.src.branchStateFor({ session: 's-x', cwd: done, branch: 'done' })).toMatchObject({ merged: true, missing: 0, changes: 0, base: 'main' })
    // a folder on another branch than the record's says nothing of this one
    expect(w.src.branchStateFor({ session: 's-x', cwd: done, branch: 'elsewhere' })).toBeNull()
    // the main checkout is never a record: the branch alone
    expect(w.src.branchStateFor({ session: 's-main', cwd: proj, branch: 'main' })).toBeNull()
  })

  it("the guard: a locked worktree, or processes Silos can't read, is never removable", async () => {
    const a = worktree('a')
    git(proj, 'worktree', 'lock', a)
    worktree('b')
    const w = world({ autoRemove: false })
    w.procsReadable = false
    await w.src.tick()
    const r = byPath(w)
    expect(r.get('.claude/worktrees/a')).toMatchObject({ state: 'merged', removable: false })
    expect(r.get('.claude/worktrees/b')).toMatchObject({ state: 'merged', removable: false })
    expect(String(r.get('.claude/worktrees/b')!.why)).toContain("can't read this machine's processes")
  })

  it('a worktree removed outside Silos reads removed; a project that is not a repo lists nothing', async () => {
    const a = worktree('a')
    const w = world({ autoRemove: false })
    await w.src.tick()
    git(proj, 'worktree', 'remove', a)
    await w.src.tick()
    expect(byPath(w).get('.claude/worktrees/a')).toMatchObject({ state: 'removed', removable: false })
    expect(byPath(w).get('.claude/worktrees/a')!.removedBy).toBeUndefined()
    const plain = mkdtempSync(join(dir, 'plain-'))
    const v = new WorktreeRecords({ file: join(dir, 'p.json'), trashDir: trash, projects: () => [plain] })
    await v.tick()
    expect(v.records()).toEqual([])
  })
})

describe('remove-worktree', () => {
  it('refuses on live facts: unmerged, a process inside now, a tracked change since the scan, its conversation running', async () => {
    const ahead = worktree('ahead')
    commit(ahead, 'a.txt', 'x')
    const busy = worktree('busy')
    const edited = worktree('edited')
    const talk = worktree('talk')
    const w = world({ autoRemove: false })
    await w.src.tick()
    const id = (p: string): string => String(byPath(w).get(p)!.id)
    expect(await w.src.removeRecord(id('.claude/worktrees/ahead'))).toMatchObject({
      ok: false,
      code: 409,
      reason: ".claude/worktrees/ahead can't be removed: 1 commit of it is not in main",
    })
    w.procs.set(busy, { count: 1, sessions: [] })
    expect(await w.src.removeRecord(id('.claude/worktrees/busy'))).toMatchObject({
      ok: false,
      code: 409,
      reason: ".claude/worktrees/busy can't be removed: 1 process runs inside it",
    })
    writeFileSync(join(edited, 'readme'), 'changed after the scan')
    expect(await w.src.removeRecord(id('.claude/worktrees/edited'))).toMatchObject({
      ok: false,
      code: 409,
      reason: ".claude/worktrees/edited can't be removed: 1 tracked file changed in it",
    })
    w.sessions.set(talk, ['s-1'])
    w.facts.set('s-1', conv('s-1', true))
    expect(await w.src.removeRecord(id('.claude/worktrees/talk'))).toMatchObject({
      ok: false,
      code: 409,
      reason: ".claude/worktrees/talk can't be removed: its conversation is running",
    })
    w.procsReadable = false
    w.sessions.clear()
    expect(await w.src.removeRecord(id('.claude/worktrees/talk'))).toMatchObject({ ok: false, code: 503 })
    // nothing was touched
    expect(existsSync(ahead) && existsSync(busy) && existsSync(edited) && existsSync(talk)).toBe(true)
    expect(existsSync(trash)).toBe(false)
    expect(branches()).toEqual(['ahead', 'busy', 'edited', 'main', 'talk'])
  })

  it('never the main checkout, nor a path git does not list as a worktree of a known project', async () => {
    worktree('a')
    const w = world({ autoRemove: false })
    await w.src.tick()
    const rec = w.src.list()[0]!
    // a store that names the main checkout (hand-edited, or older): refused
    const file = join(dir, 'data', 'silos', 'kernel', 'worktree', 'worktrees.json')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    raw.records.push({ ...rec, id: 'wt-main', dir: proj, path: proj })
    raw.records.push({ ...rec, id: 'wt-stranger', dir: join(dir, 'elsewhere'), path: 'elsewhere' })
    writeFileSync(file, JSON.stringify(raw))
    w.src.load()
    expect(await w.src.removeRecord('wt-main')).toMatchObject({
      ok: false,
      code: 409,
      reason: `${proj} can't be removed: it is the project's main checkout — never removed`,
    })
    expect(await w.src.removeRecord('wt-stranger')).toMatchObject({
      ok: false,
      code: 409,
      reason: "elsewhere can't be removed: git no longer lists it as a worktree of shop",
    })
    expect(existsSync(join(proj, '.git'))).toBe(true)
  })

  it('a branch in main by ancestry: worktree removed, branch -d, leftovers (untracked AND ignored) moved to the trash; the stash untouched', async () => {
    writeFileSync(join(proj, '.gitignore'), 'build/\n')
    git(proj, 'add', '.gitignore')
    git(proj, 'commit', '-q', '-m', 'ignore')
    writeFileSync(join(proj, 'readme'), 'stashed edit')
    git(proj, 'stash', '-q')
    const stashBefore = git(proj, 'stash', 'list')
    const a = worktree('a')
    commit(a, 'a.txt', 'x')
    git(proj, 'merge', '-q', '--ff-only', 'a')
    writeFileSync(join(a, 'notes.md'), 'my notes')
    mkdirSync(join(a, 'build'))
    writeFileSync(join(a, 'build', 'out.js'), 'built')
    const w = world({ autoRemove: false })
    await w.src.tick()
    const rec = byPath(w).get('.claude/worktrees/a')!
    expect(rec).toMatchObject({ state: 'merged', leftovers: 1, removable: true })
    const res = await w.src.removeRecord(String(rec.id))
    expect(res).toMatchObject({
      ok: true,
      value: {
        outcome: 'removed',
        moved: 2,
        bundle: null,
        says: 'Removed .claude/worktrees/a. Branch a deleted — it is in main. 2 leftovers moved to the trash.',
      },
    })
    expect(existsSync(a)).toBe(false)
    expect(parseWorktreeList(git(proj, 'worktree', 'list', '--porcelain')).map((e) => e.path)).toEqual([proj])
    expect(branches()).toEqual(['main'])
    const t = (res as { value: { trash: string } }).value.trash
    expect(t.startsWith(join(trash, WORKTREE_TRASH_FOLDER) + '/')).toBe(true)
    expect(readFileSync(join(t, 'leftovers', 'notes.md'), 'utf8')).toBe('my notes')
    expect(readFileSync(join(t, 'leftovers', 'build', 'out.js'), 'utf8')).toBe('built')
    expect(git(proj, 'stash', 'list')).toBe(stashBefore)
    expect(byPath(w).get('.claude/worktrees/a')).toMatchObject({ state: 'removed', removedBy: 'owner', why: 'removed by you', removable: false, trash: t })
    expect(await w.src.removeRecord(String(rec.id))).toMatchObject({ ok: false, code: 409 })
    // the trash's own purge takes it after its window, like any trashed thing
    expect(purgeTrash(trash, Date.now() + 31 * DAY).removed).toBe(1)
    expect(readdirSync(trash)).toEqual([])
  })

  it('a branch in main only by patch: a bundle first, then -D — the branch is recoverable from the bundle', async () => {
    const p = worktree('picked')
    commit(p, 'p1.txt', '1')
    const tip = commit(p, 'p2.txt', '2')
    commit(proj, 'other.txt', 'main moved on')
    for (const c of git(p, 'rev-list', '--reverse', 'main..picked').trim().split('\n')) git(proj, 'cherry-pick', c)
    const w = world({ autoRemove: false })
    await w.src.tick()
    const res = await w.src.removeRecord(String(byPath(w).get('.claude/worktrees/picked')!.id))
    expect(res.ok).toBe(true)
    const v = (res as { value: { bundle: string; says: string } }).value
    expect(v.says).toBe('Removed .claude/worktrees/picked. Branch picked deleted — its 2 commits are in main by patch; a bundle of it is in the trash.')
    expect(branches()).toEqual(['main'])
    git(proj, 'fetch', '-q', v.bundle, 'refs/heads/picked:refs/heads/picked-back')
    expect(git(proj, 'rev-parse', 'picked-back').trim()).toBe(tip)
  })
})

describe('Silos closes the merged ones by itself', () => {
  it('only merged, removable and idle past the window — measured from the last time it was seen in use; never an unmerged one, whatever its age', async () => {
    const merged = worktree('merged')
    const old = worktree('old')
    commit(old, 'o.txt', 'never merged')
    const w = world()
    w.procs.set(merged, { count: 1, sessions: [] }) // in use at T0
    await w.src.tick()
    expect(byPath(w).get('.claude/worktrees/merged')!.state).toBe('in-use')
    w.procs.clear()
    w.now = T0 + WORKTREE_IDLE_CLOSE_MS - 3600_000
    await w.src.tick()
    expect(byPath(w).get('.claude/worktrees/merged')).toMatchObject({ state: 'merged', removable: true })
    expect(existsSync(merged)).toBe(true)
    w.now = T0 + WORKTREE_IDLE_CLOSE_MS
    await w.src.tick()
    expect(byPath(w).get('.claude/worktrees/merged')).toMatchObject({ state: 'removed', removedBy: 'silos', why: 'removed by Silos — merged and idle for 6 h' })
    expect(existsSync(merged)).toBe(false)
    w.now = T0 + 400 * DAY
    await w.src.tick()
    expect(existsSync(old)).toBe(true)
    expect(branches()).toEqual(['main', 'old'])
  })

  it('a change to its files counts as activity: the window starts again', async () => {
    const m = worktree('m')
    const w = world()
    w.now = T0 - DAY + 3600_000 // a fresh worktree
    await w.src.tick()
    writeFileSync(join(m, 'scratch.txt'), 'someone is working here')
    w.now = T0
    await w.src.tick() // the files moved: active now
    expect(existsSync(m)).toBe(true)
    w.now = T0 + WORKTREE_IDLE_CLOSE_MS - 60_000
    await w.src.tick()
    expect(existsSync(m)).toBe(true)
    w.now = T0 + WORKTREE_IDLE_CLOSE_MS
    await w.src.tick()
    expect(existsSync(m)).toBe(false)
    expect(readdirSync(join(trash, WORKTREE_TRASH_FOLDER)).length).toBe(1) // its scratch file went to the trash
  })
})

describe('the pieces', () => {
  it("parses git's porcelain: worktree list (main first, locked, prunable) and status (renames carry two paths)", () => {
    expect(
      parseWorktreeList(
        'worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /r/w\nHEAD def\ndetached\nlocked\n\nworktree /gone\nHEAD 123\nbranch refs/heads/x\nprunable gitdir file points to non-existent location\n',
      ),
    ).toEqual([
      { path: '/r', head: 'abc', branch: 'main', bare: false, locked: false, prunable: false },
      { path: '/r/w', head: 'def', branch: null, bare: false, locked: true, prunable: false },
      { path: '/gone', head: '123', branch: 'x', bare: false, locked: false, prunable: true },
    ])
    expect(parseStatus(' M a\0R  new\0old\0?? n.txt\0!! build/\0')).toEqual({ changes: 2, untracked: ['n.txt'], ignored: ['build/'] })
  })

  it("ProcessRecords.inside counts this user's processes by working directory from the last scan — fresh reads the table again", async () => {
    const p = (pid: number, cwd: string, env: Record<string, string> = {}): ProcEntry => ({
      pid,
      ppid: 1,
      startTicks: pid,
      startedAt: T0,
      comm: 'node',
      argv: ['node'],
      cwd,
      cpuSeconds: 0,
      rssBytes: 0,
      env,
    })
    let reads = 0
    const src = new ProcessRecords({
      file: join(dir, 'pr.json'),
      sessionKeys: () => [SILOS_SESSION_KEY],
      engineCommands: () => new Set(),
      now: () => T0,
      table: {
        read: async () => {
          reads++
          return { at: T0, uid: 1000, procs: [p(5, '/w/a'), p(6, '/w/a/sub', { [SILOS_SESSION_KEY]: 's-1' }), p(7, '/w/ab')], listeners: [], complete: true }
        },
      },
    })
    expect(await src.inside(['/w/a'])).toBeNull() // no scan yet: nothing to tell from
    await src.tick()
    expect(reads).toBe(1)
    expect(await src.inside(['/w/a', '/w/b'])).toEqual(
      new Map([
        ['/w/a', { count: 2, sessions: ['s-1'] }],
        ['/w/b', { count: 0, sessions: [] }],
      ]),
    )
    expect(reads).toBe(1)
    await src.inside(['/w/a'], { fresh: true })
    expect(reads).toBe(2)
  })
})

describe('the catalog entry and the manifest', () => {
  it('KERNEL_KINDS.worktree: in-use · merged · unmerged · removed (terminal, quiet), at = lastCommitAt, admits remove-worktree', () => {
    const k = KERNEL_KINDS.worktree!
    expect(k.states).toEqual([
      { value: 'in-use', terminal: false },
      { value: 'merged', terminal: false },
      { value: 'unmerged', terminal: false },
      { value: 'removed', terminal: true, quiet: true },
    ])
    expect(k.envelope.at).toBe('lastCommitAt')
    expect(k.verbs).toEqual(['remove-worktree'])
  })

  it('system.silo.json validates with two kernel sources, each feeding the kind named like it; the reader reads both', async () => {
    const m = JSON.parse(readFileSync(REF, 'utf8'))
    const v = validateSilo(m, { now: T0 })
    expect(v.errors).toEqual([])
    expect(v.wants).toEqual([]) // every field it uses (a view's label too) is the standard's
    expect(kernelFeeds(m)).toEqual(
      new Map([
        ['processes', 'process'],
        ['worktrees', 'worktree'],
      ]),
    )
    expect(m.spec.actions).toContainEqual({ verb: 'kernel-verb', name: 'remove-worktree', kind: 'worktree', when: 'removable' })
    worktree('a')
    const w = world({ autoRemove: false })
    await w.src.tick()
    const r = new SiloReader({ agentStates: () => [], projects: () => [] }, (k) => (k === 'worktree' ? w.src : null)).read('system', m, { now: T0 })
    expect(r.unreadable).toEqual([])
    expect(r.problems).toEqual([])
    expect(r.records.map((x) => [x.kind, x.record.identity, x.record.state])).toEqual([['worktree', 'a', 'merged']])
    // a kernel source whose kind no kind of the silo is named like: refused
    const bad = JSON.parse(readFileSync(REF, 'utf8'))
    bad.spec.kinds.wt = bad.spec.kinds.worktree
    delete bad.spec.kinds.worktree
    expect(validateSilo(bad, { now: T0 }).errors.map((e) => [e.check, e.where])).toContainEqual([3, 'spec.sources'])
    // a remove-worktree declared on processes: refused (process admits stop-process only)
    const wrong = JSON.parse(readFileSync(REF, 'utf8'))
    wrong.spec.actions.push({ verb: 'kernel-verb', name: 'remove-worktree', kind: 'process' })
    expect(validateSilo(wrong, { now: T0 }).errors.map((e) => e.message)).toContain(
      'remove-worktree does not act on the kernel kind process — it admits stop-process',
    )
  })
})
