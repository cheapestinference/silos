// silos/worktrees.ts — the kernel kind `worktree` (the built-in System silo,
// docs/standard/reference/system.silo.json, its second view): the git
// worktrees conversations left on this machine. Moment 1 «What's
// happening?»: 45 worktrees had piled up on one machine — Claude Code's
// subagent isolation (it removes one only when the agent changed nothing),
// conversations following a «feature = worktree + branch» workflow, people
// by hand — and nothing closed them. Whether one was safe to close took a
// human: is it merged, does a process live in it, is its conversation still
// working. The same question as the `process` kind (what conversations left
// on this machine), so the same silo.
//
// WHAT IS A RECORD. For every project folder Silos knows (siloLocations
// .projects(): the main checkouts of the agents' territories) that is a git
// MAIN checkout, `git worktree list --porcelain`: one record per LINKED
// worktree — never the main checkout, never a prunable entry (its folder is
// gone). The id is `wt-<hash of its real path and the birth of its .git
// file>`: a worktree re-created at the same path is a new record.
//
// THE FACTS. Measured against the project's default branch (origin/HEAD's
// branch when the repo has one locally, else the main checkout's branch,
// else main/master): `ahead` — its commits, merges aside, not reachable from
// it (a merge brings nothing of its own: what it joins is counted on its
// own side); `landed` — of those, the ones patch-equivalent to a commit of
// the default branch (`git cherry`: a branch whose commits were
// cherry-picked is NOT unmerged work — on the machine that asked for this,
// 9 of 11 «unmerged» worktrees were exactly that); `changes` — tracked files
// modified or staged; `leftovers` — untracked entries. `processes` — live
// processes whose cwd is inside, read from the table the `process` kind
// already scans (ProcessRecords.inside: /proc is scanned once).
//
// THE CONVERSATION. Whoever made or works it: the sessions the engines place
// in it (HarnessReader.worktreeSessions — a transcript the engine moved
// there when its conversation entered the worktree, a child session spawned
// into it) and the conversations whose cwd is inside; else a process inside
// that carries a session id; else none («No conversation»).
//
// STATES. in-use — a live process inside, or its conversation runs (the one
// liveness rule the `process` kind reads: ConversationFacts.running) · merged
// — nothing of it is missing from the default branch (ahead − landed = 0)
// and no tracked change · unmerged — commits or tracked changes the default
// branch lacks · removed — terminal and quiet, kept WORKTREE_RETENTION_MS.
// in-use wins over the other two.
//
// REMOVAL (the kernel-verb remove-worktree, and Silos itself). ONE path:
// removeRecord re-reads the live facts at the moment (still a linked
// worktree of a project Silos knows, not the main checkout, not locked,
// merged, no tracked change, no process inside — the table read afresh —,
// its conversation not running) and refuses in words when any moved. Then:
// a git bundle of the branch into Silos' trash when it landed only by patch
// (recoverable: `git fetch <bundle> <branch>`); every file git does not
// track — untracked AND ignored (a gitignored plan or .env is data too) —
// MOVED into the same trash folder (repo invariant 3: deleting is moving to
// ~/.silos/trash; trash-purge.ts empties it after 30 days); `git worktree
// remove` (never --force: a tracked change refuses it); the branch deleted
// (-d when it is an ancestor of the default branch, -D only after its
// bundle). Never the stash. The answer says what it did.
//
// SILOS CLOSES THE MERGED ONES. Each tick, a worktree that is merged, not in
// use, removable, and idle for WORKTREE_IDLE_CLOSE_MS — from the latest of
// its last commit, the birth of its .git file and the last time Silos saw it
// in use or changing (HEAD or `git status` moved; kept in this kind's store)
// — is removed through removeRecord with removedBy `silos`. An unmerged
// worktree is NEVER removed by Silos, whatever its age. Always on (the
// System silo has no owner setting of its own; SILOS_NO_WORKTREE_SCAN=1
// turns the whole scan off — isolated test servers).
//
// THE EVENT LOOP. git runs async (execFile, a timeout), a few at a time, on
// a tick that never overlaps itself; per worktree only `git status` runs on
// every tick — the commit counts are cached by (HEAD, default branch tip).
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { cp, mkdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { atomicWriteJson, backupCorruptJson } from '../json-store.js'
import type { KernelRecord, KernelRecordSource } from './kernel-kinds.js'
import { PROCESS_RETENTION_MS, type ConversationFacts, type ConversationLookup } from './processes.js'

// the built-in silo that presents this kind (beside `process`)
export const WORKTREE_SILO = 'system'
export const WORKTREE_TICK_MS = 60_000
// a merged worktree nobody touched this long is closed by Silos
export const WORKTREE_IDLE_CLOSE_MS = 6 * 3600_000
export const WORKTREE_RETENTION_MS = PROCESS_RETENTION_MS
export const GIT_TIMEOUT_MS = 20_000
export const GIT_CONCURRENCY = 4
// removals Silos makes by itself in one tick (the rest wait for the next)
export const AUTO_REMOVE_PER_TICK = 5
// the folder of Silos' trash where removed worktrees' leftovers and bundles go
export const WORKTREE_TRASH_FOLDER = 'worktrees'

export type WorktreeState = 'in-use' | 'merged' | 'unmerged' | 'removed'

// ── git ─────────────────────────────────────────────────────────────────────

export type GitResult = { ok: true; out: string } | { ok: false; code: number | null; err: string }
export type GitRun = (cwd: string, args: readonly string[]) => Promise<GitResult>

/** git, asynchronously, bounded: an inherited GIT_DIR / GIT_WORK_TREE would
 *  answer for another repo, so no GIT_* passes; no prompt; C locale. */
export function execGit(o: { timeoutMs?: number } = {}): GitRun {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GIT_TERMINAL_PROMPT = '0'
  env.LC_ALL = 'C'
  return (cwd, args) =>
    new Promise((res) => {
      execFile(
        'git',
        ['-C', cwd, ...args],
        { encoding: 'utf8', timeout: o.timeoutMs ?? GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env },
        (err, stdout, stderr) => {
          if (!err) {
            res({ ok: true, out: stdout })
            return
          }
          const code = (err as { code?: unknown }).code
          res({ ok: false, code: typeof code === 'number' ? code : null, err: String(stderr || err.message).trim() })
        },
      )
    })
}

export interface WorktreeEntry {
  path: string
  head: string | null
  branch: string | null
  bare: boolean
  locked: boolean
  prunable: boolean
}

/** `git worktree list --porcelain`: the main checkout first, then each linked one. */
export function parseWorktreeList(out: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let cur: WorktreeEntry | null = null
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), head: null, branch: null, bare: false, locked: false, prunable: false }
      entries.push(cur)
      continue
    }
    if (!cur) continue
    if (line.startsWith('HEAD ')) cur.head = line.slice(5).trim() || null
    else if (line.startsWith('branch '))
      cur.branch =
        line
          .slice(7)
          .trim()
          .replace(/^refs\/heads\//, '') || null
    else if (line === 'bare') cur.bare = true
    else if (line === 'locked' || line.startsWith('locked ')) cur.locked = true
    else if (line === 'prunable' || line.startsWith('prunable ')) cur.prunable = true
  }
  return entries
}

/** `git status --porcelain=v1 -z --untracked-files=normal --ignored=traditional`. */
export function parseStatus(out: string): { changes: number; untracked: string[]; ignored: string[] } {
  const t = out.split('\0')
  let changes = 0
  const untracked: string[] = []
  const ignored: string[] = []
  for (let i = 0; i < t.length; i++) {
    const e = t[i]!
    if (e.length < 4) continue
    const xy = e.slice(0, 2)
    const path = e.slice(3)
    if (xy === '??') untracked.push(path)
    else if (xy === '!!') ignored.push(path)
    else {
      changes++
      if (xy[0] === 'R' || xy[0] === 'C') i++ // a rename's second field: the old path
    }
  }
  return { changes, untracked, ignored }
}

// ── the record ──────────────────────────────────────────────────────────────

export interface WorktreeRecord {
  id: string
  state: WorktreeState
  updatedBy: 'kernel'
  path: string
  dir: string
  project: string
  branch?: string
  base?: string
  ahead: number
  landed: number
  changes: number
  leftovers: number
  lastCommitAt: string
  processes: number
  session?: string
  folder?: string
  agent?: string
  conversation?: string
  why?: string
  removedAt?: string
  removedBy?: string
  trash?: string
  // the engine's own bookkeeping — never served
  updatedAt: string
  createdAt: number // the birth of its .git file (ms)
  activeAt?: number // the last time Silos saw it in use or changing
  fp?: string // HEAD + git status, as last read: «changing» is this moving
  locked?: boolean
  procsKnown?: boolean // this machine's processes could be read at the last scan
}

const INTERNAL = new Set(['updatedAt', 'createdAt', 'activeAt', 'fp', 'locked', 'procsKnown'])
const FACTS = [
  'state',
  'path',
  'dir',
  'project',
  'branch',
  'base',
  'ahead',
  'landed',
  'changes',
  'leftovers',
  'lastCommitAt',
  'processes',
  'session',
  'folder',
  'agent',
  'conversation',
  'why',
  'removedAt',
  'removedBy',
  'trash',
  'locked',
  'procsKnown',
] as const

function factsOf(r: WorktreeRecord): string {
  return `${r.id}\0${FACTS.map((f) => String(r[f] ?? '')).join('\0')}`
}

// The guard of remove-worktree: why this record can't be removed, in plain
// words — null: it can (the removal re-checks every fact on live data).
export function removeRefusal(r: Pick<WorktreeRecord, 'state' | 'locked' | 'procsKnown'>): string | null {
  if (r.state === 'removed') return 'it is already removed'
  if (r.state === 'in-use') return 'it is in use'
  if (r.state === 'unmerged') return 'it holds work its default branch does not have'
  if (r.locked) return 'git has it locked'
  if (r.procsKnown === false) return "Silos can't read this machine's processes, so it can't tell whether one runs inside"
  return null
}

// A conversation's branch, as the header says it beside the branch name:
// whether its work is in the default branch. Read from the records the scan
// already holds — never a git call of its own. `missing` = its commits not in
// `base` (ahead − landed); `changes` = tracked files changed, uncommitted.
export interface BranchState {
  branch: string
  base: string
  merged: boolean
  missing: number
  commits: number // its own commits, landed or not — 0 with no change: a branch that holds nothing yet
  changes: number
  record: string // the worktree record's id — the door lands on it
}

// The record a conversation works in: the one attributed to its session, or
// else the worktree at its folder — either way on the branch it reports
// (a record on another branch says nothing of this one). No record (the main
// checkout, an unknown folder), a removed one or an unknown default branch →
// null: the header shows the branch alone.
export function branchStateOf(records: readonly WorktreeRecord[], q: { session: string; cwd: string | null; branch: string | null }): BranchState | null {
  if (q.branch === null || q.branch === '') return null
  const live = records.filter((r) => r.state !== 'removed' && r.branch === q.branch)
  const r = live.find((x) => x.session === q.session) ?? (q.cwd !== null ? live.find((x) => x.dir === q.cwd) : undefined)
  if (!r || r.base === undefined || r.branch === undefined) return null
  const missing = Math.max(0, r.ahead - r.landed)
  return { branch: r.branch, base: r.base, merged: missing === 0 && r.changes === 0, missing, commits: r.ahead, changes: r.changes, record: r.id }
}

export interface RemoveAnswer {
  id: string
  outcome: 'removed' | 'partial'
  moved: number // leftovers moved to the trash
  bundle: string | null // the branch's bundle, when one was written
  trash: string | null
  says: string
}
export type RemoveResult = { ok: true; value: RemoveAnswer } | { ok: false; code: number; reason: string }

export interface WorktreeRecordsOptions {
  file: string
  trashDir: string // Silos' trash (<dataDir>/trash): what a removal moves lands under worktrees/
  projects: () => readonly string[]
  git?: GitRun
  // false while the Silos side can't answer (the index warming): no scan is judged
  ready?: () => boolean
  // the sessions placed in each worktree (by the engines and the index),
  // per project — absent: none known
  sessionsIn?: (dirs: ReadonlyArray<{ dir: string; createdAt: number }>, project: string) => Promise<Map<string, string[]>>
  conversations?: ConversationLookup
  // live processes inside each dir (ProcessRecords.inside); null: can't tell
  inside?: (dirs: readonly string[], o: { fresh: boolean }) => Promise<Map<string, { count: number; sessions: string[] }> | null>
  now?: () => number
  onChange?: () => void
  retentionMs?: number
  idleCloseMs?: number
  autoRemove?: boolean // default true: Silos closes the merged idle ones
  concurrency?: number
}

interface Facts {
  id: string
  dir: string
  createdAt: number
  branch: string | null
  head: string | null
  locked: boolean
  changes: number
  untracked: string[]
  ignored: string[]
  fp: string
  ahead: number
  landed: number
  ancestor: boolean
  lastCommitAt: number
}

interface Base {
  name: string
  sha: string
}

const iso = (ms: number): string => new Date(ms).toISOString()
const short = (id: string): string => id.slice(0, 8)
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex')
const within = (p: string, dir: string): boolean => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep)

async function eachLimited<T>(items: readonly T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0
  const worker = async (): Promise<void> => {
    while (i < items.length) {
      const t = items[i++]!
      try {
        await fn(t)
      } catch {
        /* one worktree failing never stops the rest */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
}

export class WorktreeRecords implements KernelRecordSource {
  private recs = new Map<string, WorktreeRecord>()
  private loaded = false
  private written: number | null = null
  private ticker: NodeJS.Timeout | null = null
  private ticking = false
  private removing = new Set<string>()
  private counts = new Map<string, { ahead: number; landed: number; ancestor: boolean; lastCommitAt: number }>()
  private chain: Promise<unknown> = Promise.resolve()
  private git: GitRun

  constructor(private o: WorktreeRecordsOptions) {
    this.git = o.git ?? execGit()
  }

  static fileIn(silosRoot: string): string {
    return join(silosRoot, 'kernel', 'worktree', 'worktrees.json')
  }

  private nowMs(): number {
    return this.o.now?.() ?? Date.now()
  }

  // one judgment at a time: a scan and a removal never write the store together
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => undefined)
    return run
  }

  load(): void {
    this.loaded = true
    this.recs.clear()
    if (!existsSync(this.o.file)) return
    let text = ''
    try {
      text = readFileSync(this.o.file, 'utf8')
      const raw = JSON.parse(text) as { records?: unknown; writtenAt?: unknown }
      for (const r of Array.isArray(raw.records) ? raw.records : []) {
        if (
          typeof r === 'object' &&
          r !== null &&
          typeof (r as WorktreeRecord).id === 'string' &&
          typeof (r as WorktreeRecord).state === 'string' &&
          typeof (r as WorktreeRecord).dir === 'string'
        )
          this.recs.set((r as WorktreeRecord).id, r as WorktreeRecord)
      }
      this.written = typeof raw.writtenAt === 'number' ? raw.writtenAt : null
    } catch {
      if (text !== '') backupCorruptJson(this.o.file, text, 'silos')
      this.recs.clear()
    }
  }

  private ensure(): void {
    if (!this.loaded) this.load()
  }

  private persist(now: number): void {
    this.written = now
    mkdirSync(dirname(this.o.file), { recursive: true, mode: 0o700 })
    atomicWriteJson(this.o.file, { version: 1, writtenAt: this.written, records: [...this.recs.values()] }, { mode: 0o600 })
  }

  list(): WorktreeRecord[] {
    this.ensure()
    return [...this.recs.values()].map((r) => ({ ...r }))
  }

  // a conversation's branch state, from the table in memory (see branchStateOf)
  branchStateFor(q: { session: string; cwd: string | null; branch: string | null }): BranchState | null {
    this.ensure()
    return branchStateOf([...this.recs.values()], q)
  }

  // ── reading git ──

  private async listOf(project: string): Promise<{ main: WorktreeEntry; linked: WorktreeEntry[] } | null> {
    const r = await this.git(project, ['worktree', 'list', '--porcelain'])
    if (!r.ok) return null
    const entries = parseWorktreeList(r.out)
    const main = entries[0]
    if (!main || main.bare) return null
    // a project folder that is not its repo's main checkout (a subfolder):
    // the repo's own main checkout speaks for its worktrees, never this one
    const [a, b] = await Promise.all([realpath(main.path).catch(() => main.path), realpath(project).catch(() => project)])
    if (a !== b) return null
    return { main, linked: entries.slice(1).filter((e) => !e.bare && !e.prunable) }
  }

  private async baseOf(project: string, main: WorktreeEntry): Promise<Base | null> {
    const names: string[] = []
    const origin = await this.git(project, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
    if (origin.ok) {
      const n = origin.out.trim()
      const i = n.indexOf('/')
      if (i > 0) names.push(n.slice(i + 1))
    }
    if (main.branch) names.push(main.branch)
    names.push('main', 'master')
    for (const name of [...new Set(names)]) {
      const r = await this.git(project, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}^{commit}`])
      if (r.ok && r.out.trim() !== '') return { name, sha: r.out.trim() }
    }
    return null
  }

  private async factsOf(project: string, base: Base | null, e: WorktreeEntry, opts: { cached: boolean }): Promise<Facts | null> {
    const dir = await realpath(e.path).catch(() => null)
    if (dir === null) return null
    const dotGit = await stat(join(dir, '.git')).catch(() => null)
    if (!dotGit) return null
    const createdAt = Math.round(dotGit.mtimeMs)
    const st = await this.git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignored=traditional'])
    if (!st.ok) return null
    const s = parseStatus(st.out)
    let c = { ahead: 0, landed: 0, ancestor: true, lastCommitAt: createdAt }
    if (e.head) {
      const key = `${e.head}\0${base?.sha ?? ''}`
      const hit = opts.cached ? this.counts.get(key) : undefined
      if (hit) c = hit
      else {
        const log = await this.git(dir, ['log', '-1', '--format=%ct', e.head])
        const at = log.ok ? Number(log.out.trim()) * 1000 : NaN
        c = { ahead: 0, landed: 0, ancestor: false, lastCommitAt: Number.isFinite(at) ? at : createdAt }
        if (base) {
          const [ahead, cherry, anc] = await Promise.all([
            this.git(dir, ['rev-list', '--count', '--no-merges', `${base.sha}..${e.head}`]),
            this.git(dir, ['cherry', base.sha, e.head]),
            this.git(dir, ['merge-base', '--is-ancestor', e.head, base.sha]),
          ])
          if (!ahead.ok || !cherry.ok || (!anc.ok && anc.code !== 1)) return null
          c.ahead = Number(ahead.out.trim()) || 0
          c.landed = cherry.out.split('\n').filter((l) => l.startsWith('- ')).length
          c.ancestor = anc.ok
        }
        if (this.counts.size > 2000) this.counts.clear()
        this.counts.set(key, c)
      }
    }
    return {
      id: `wt-${sha1(`${dir}\0${createdAt}`).slice(0, 12)}`,
      dir,
      createdAt,
      branch: e.branch,
      head: e.head,
      locked: e.locked,
      changes: s.changes,
      untracked: s.untracked,
      ignored: s.ignored,
      fp: sha1(`${e.head ?? ''}\0${st.out}`),
      ...c,
    }
  }

  // the conversation a worktree speaks for, and whether it runs
  private attribute(
    ids: readonly string[],
    procSessions: readonly string[],
    facts: Map<string, ConversationFacts | null>,
  ): { hit: ConversationFacts | null; deleted: string | null; running: boolean } {
    const of = (xs: readonly string[]): ConversationFacts[] => xs.map((id) => facts.get(id) ?? null).filter((f): f is ConversationFacts => f !== null)
    const mine = of(ids)
    const procs = of(procSessions)
    const running = [...mine, ...procs].some((f) => f.running)
    const hit = mine.find((f) => f.running) ?? mine[0] ?? procs.find((f) => f.running) ?? procs[0] ?? null
    return { hit, deleted: hit === null && ids.length > 0 ? ids[0]! : null, running }
  }

  // ── one scan ──

  private async scan(now: number): Promise<boolean> {
    this.ensure()
    const before = [...this.recs.values()].map(factsOf).sort().join('\n')
    const projects = [...new Set(this.o.projects())]
    const conc = this.o.concurrency ?? GIT_CONCURRENCY
    const complete = new Set<string>() // projects whose listing was read
    const seen = new Set<string>()
    const drafts: Array<{ project: string; base: Base | null; f: Facts }> = []
    await eachLimited(projects, 1, async (project) => {
      const l = await this.listOf(project)
      if (!l) {
        // not a repo (or not its main checkout): nothing of it is a worktree
        const r = await this.git(project, ['rev-parse', '--git-dir'])
        if (!r.ok) complete.add(project)
        return
      }
      const base = await this.baseOf(project, l.main)
      let failed = false
      await eachLimited(l.linked, conc, async (e) => {
        const f = await this.factsOf(project, base, e, { cached: true })
        if (f) drafts.push({ project, base, f })
        else if (existsSync(e.path)) failed = true // git failed on a live one: conclude nothing
      })
      if (!failed) complete.add(project)
    })
    // who works each one: the sessions placed in it, the processes inside
    const byProject = new Map<string, Facts[]>()
    for (const d of drafts) byProject.set(d.project, [...(byProject.get(d.project) ?? []), d.f])
    const sessions = new Map<string, string[]>()
    for (const [project, fs] of byProject) {
      const m =
        (await this.o
          .sessionsIn?.(
            fs.map((f) => ({ dir: f.dir, createdAt: f.createdAt })),
            project,
          )
          .catch(() => null)) ?? null
      for (const f of fs) sessions.set(f.dir, m?.get(f.dir) ?? [])
    }
    const inside = this.o.inside
      ? await this.o
          .inside(
            drafts.map((d) => d.f.dir),
            { fresh: false },
          )
          .catch(() => null)
      : null
    const allIds = new Set<string>()
    for (const d of drafts) for (const id of [...(sessions.get(d.f.dir) ?? []), ...(inside?.get(d.f.dir)?.sessions ?? [])]) allIds.add(id)
    const facts = allIds.size > 0 && this.o.conversations ? this.o.conversations([...allIds]) : new Map<string, ConversationFacts | null>()

    const stamp = iso(now)
    for (const { project, base, f } of drafts) {
      seen.add(f.id)
      const prev = this.recs.get(f.id)
      if (prev && prev.state === 'removed') continue // terminal is terminal (a re-created one has another id)
      const procs = inside?.get(f.dir)?.count ?? 0
      const who = this.attribute(sessions.get(f.dir) ?? [], inside?.get(f.dir)?.sessions ?? [], facts)
      const next = this.draft(project, base, f, procs, inside !== null, who, now, prev)
      next.updatedAt = prev && factsOf(prev) === factsOf(next) ? prev.updatedAt : stamp
      this.recs.set(f.id, next)
    }
    const known = new Set(projects)
    for (const r of [...this.recs.values()]) {
      if (seen.has(r.id) || r.state === 'removed') continue
      // its project left Silos: not a case any more (nothing said about it)
      if (!known.has(r.project)) {
        this.recs.delete(r.id)
        continue
      }
      if (!complete.has(r.project)) continue // a failed read concludes nothing
      this.recs.set(r.id, {
        ...r,
        state: 'removed',
        removedAt: stamp,
        why: `it is no longer a worktree of ${basename(r.project)} — removed outside Silos`,
        updatedAt: stamp,
      })
    }
    this.prune(now)
    const moved = [...this.recs.values()].map(factsOf).sort().join('\n') !== before
    if (moved) this.persist(now)
    return moved
  }

  private draft(
    project: string,
    base: Base | null,
    f: Facts,
    procs: number,
    procsKnown: boolean,
    who: { hit: ConversationFacts | null; deleted: string | null; running: boolean },
    now: number,
    prev: WorktreeRecord | undefined,
  ): WorktreeRecord {
    const missing = Math.max(0, f.ahead - f.landed)
    const inUse = procs > 0 || who.running
    const baseName = base?.name ?? 'its default branch'
    const work: string[] = []
    if (missing > 0) work.push(`${plural(missing, 'commit')} not in ${baseName}`)
    if (f.changes > 0) work.push(`${plural(f.changes, 'tracked file')} changed`)
    let state: WorktreeState
    let why: string
    if (inUse) {
      state = 'in-use'
      why = procs > 0 ? `${plural(procs, 'process', 'processes')} ${procs === 1 ? 'runs' : 'run'} inside it` : 'its conversation is running'
      if (work.length > 0) why += ` — ${work.join(', ')}`
    } else if (base === null) {
      state = 'unmerged'
      why = "Silos can't tell this project's default branch, so it can't tell what of it is missing"
    } else if (work.length > 0) {
      state = 'unmerged'
      why = work.join(', ')
    } else {
      state = 'merged'
      why = f.ahead === 0 ? `nothing of it is missing from ${baseName}` : `its ${plural(f.ahead, 'commit')} landed in ${baseName} by patch (cherry-picked)`
      if (f.locked) why += ' — git has it locked, so Silos leaves it'
      else if (!procsKnown) why += " — Silos can't read this machine's processes, so it never removes it"
    }
    const rel = relative(project, f.dir)
    const r: WorktreeRecord = {
      id: f.id,
      state,
      updatedBy: 'kernel',
      updatedAt: '',
      path: rel !== '' && !rel.startsWith('..') ? rel : f.dir,
      dir: f.dir,
      project,
      ...(f.branch ? { branch: f.branch } : {}),
      ...(base ? { base: base.name } : {}),
      ahead: f.ahead,
      landed: f.landed,
      changes: f.changes,
      leftovers: f.untracked.length,
      lastCommitAt: iso(f.lastCommitAt),
      processes: procs,
      why,
      createdAt: f.createdAt,
      fp: f.fp,
      ...(f.locked ? { locked: true } : {}),
      procsKnown,
    }
    // «changing»: HEAD or the files moved since the last look; «in use»: now
    const active = inUse || (prev !== undefined && prev.fp !== undefined && prev.fp !== f.fp) ? now : prev?.activeAt
    if (active !== undefined) r.activeAt = active
    if (who.hit) {
      r.session = who.hit.session
      if (who.hit.folder) r.folder = who.hit.folder
      if (who.hit.agent) r.agent = who.hit.agent
      r.conversation = who.hit.title && who.hit.title.trim() !== '' ? who.hit.title : `an untitled conversation (${short(who.hit.session)})`
    } else if (who.deleted) {
      r.session = who.deleted
      r.conversation = `a deleted conversation (${short(who.deleted)})`
    }
    return r
  }

  // when it was last touched: its last commit, its birth, the last time seen in use or changing
  idleSince(r: Pick<WorktreeRecord, 'lastCommitAt' | 'createdAt' | 'activeAt'>): number {
    return Math.max(Date.parse(r.lastCommitAt) || 0, r.createdAt || 0, r.activeAt ?? 0)
  }

  private prune(now: number): boolean {
    const keep = this.o.retentionMs ?? WORKTREE_RETENTION_MS
    let changed = false
    for (const r of [...this.recs.values()]) {
      if (r.state === 'removed' && r.removedAt && now - Date.parse(r.removedAt) > keep) {
        this.recs.delete(r.id)
        changed = true
      }
    }
    return changed
  }

  // The clock's part (no reading): removed records past retention are pruned.
  expire(now = this.nowMs()): boolean {
    this.ensure()
    const changed = this.prune(now)
    if (changed) this.persist(now)
    return changed
  }

  // The worktrees Silos closes now: merged, removable, idle past the window.
  dueForRemoval(now = this.nowMs()): string[] {
    this.ensure()
    const window = this.o.idleCloseMs ?? WORKTREE_IDLE_CLOSE_MS
    return [...this.recs.values()]
      .filter((r) => r.state === 'merged' && removeRefusal(r) === null && !this.removing.has(r.id) && now - this.idleSince(r) >= window)
      .sort((a, b) => this.idleSince(a) - this.idleSince(b))
      .map((r) => r.id)
  }

  // One scan (the periodic tick), then the removals that are due. Never
  // throws, never overlaps itself.
  async tick(): Promise<boolean> {
    if (this.ticking || this.o.ready?.() === false) return false
    this.ticking = true
    let changed = false
    try {
      changed = await this.serial(() => this.scan(this.nowMs()))
      if (changed) this.notify()
      if (this.o.autoRemove !== false) {
        for (const id of this.dueForRemoval(this.nowMs()).slice(0, AUTO_REMOVE_PER_TICK)) {
          const r = await this.removeRecord(id, { by: 'silos' })
          if (r.ok) {
            changed = true
            console.log(`silos: ${r.value.says}`)
          }
        }
      }
    } catch (err) {
      console.warn('silos: the worktree scan failed —', err instanceof Error ? err.message : err)
    } finally {
      this.ticking = false
    }
    return changed
  }

  private notify(): void {
    try {
      this.o.onChange?.()
    } catch {
      /* a listener never breaks the engine */
    }
  }

  start(opts: { intervalMs?: number; poll?: boolean } = {}): void {
    this.ensure()
    if (this.ticker) return
    const poll = opts.poll !== false
    this.ticker = setInterval(() => {
      if (poll) void this.tick()
      else if (this.expire(this.nowMs())) this.notify()
    }, opts.intervalMs ?? WORKTREE_TICK_MS)
    this.ticker.unref()
    if (this.expire(this.nowMs())) this.notify()
    if (poll) void this.tick()
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
  }

  // ── what the silo reader takes (KernelRecordSource) ──

  records(_now?: number): KernelRecord[] {
    this.ensure()
    return [...this.recs.values()].map((r) => {
      const value = Object.fromEntries(Object.entries(r).filter(([k, v]) => !INTERNAL.has(k) && v !== undefined))
      value.removable = removeRefusal(r) === null
      return { id: r.id, value, writtenAt: Date.parse(r.updatedAt) || 0 }
    })
  }

  lastWrite(): number | null {
    this.ensure()
    return this.written
  }

  // ── remove-worktree ──

  // Remove the record `id`'s worktree (the kernel-verb remove-worktree; Silos
  // itself with by 'silos'). Re-reads every fact live; never throws.
  async removeRecord(id: string, opts: { by?: string } = {}): Promise<RemoveResult> {
    this.ensure()
    const by = opts.by ?? 'owner'
    if (this.removing.has(id)) return { ok: false, code: 409, reason: 'it is being removed already' }
    this.removing.add(id)
    let changed = false
    try {
      return await this.serial(async () => {
        const r = await this.removeNow(id, by)
        changed = r.ok
        return r
      })
    } catch (err) {
      return { ok: false, code: 500, reason: `the removal failed: ${err instanceof Error ? err.message : String(err)}` }
    } finally {
      this.removing.delete(id)
      if (changed) this.notify()
    }
  }

  private async removeNow(id: string, by: string): Promise<RemoveResult> {
    const r = this.recs.get(id)
    if (!r) return { ok: false, code: 404, reason: `no worktree ${id} — it is not listed (removed long ago, or never a record)` }
    const name = r.path
    const refuse = (why: string, code = 409): RemoveResult => ({ ok: false, code, reason: `${name} can't be removed: ${why}` })
    if (r.state === 'removed') return refuse('it is already removed')
    // ── the live facts, read again ──
    if (!this.o.projects().includes(r.project)) return refuse(`${r.project} is not a project Silos knows any more`)
    const l = await this.listOf(r.project)
    if (!l) return refuse(`git can't list the worktrees of ${basename(r.project)} — nothing was touched`, 503)
    const mainReal = await realpath(l.main.path).catch(() => l.main.path)
    if (mainReal === r.dir) return refuse("it is the project's main checkout — never removed")
    let entry: WorktreeEntry | null = null
    for (const e of l.linked)
      if ((await realpath(e.path).catch(() => e.path)) === r.dir) {
        entry = e
        break
      }
    if (!entry) return refuse(`git no longer lists it as a worktree of ${basename(r.project)}`)
    if (entry.locked) return refuse('git has it locked')
    const base = await this.baseOf(r.project, l.main)
    if (!base) return refuse("Silos can't tell the project's default branch")
    const f = await this.factsOf(r.project, base, entry, { cached: false })
    if (!f) return refuse("git can't read it now — nothing was touched", 503)
    if (f.id !== id) return refuse('a different worktree stands at its path now')
    if (f.changes > 0) return refuse(`${plural(f.changes, 'tracked file')} changed in it`)
    if (f.ahead - f.landed > 0) return refuse(`${plural(f.ahead - f.landed, 'commit')} of it ${f.ahead - f.landed === 1 ? 'is' : 'are'} not in ${base.name}`)
    if (!this.o.inside) return refuse("Silos can't read this machine's processes, so it can't tell whether one runs inside", 503)
    const inside = await this.o.inside([f.dir], { fresh: true }).catch(() => null)
    if (!inside) return refuse("Silos can't read this machine's processes, so it can't tell whether one runs inside", 503)
    const procs = inside.get(f.dir) ?? { count: 0, sessions: [] }
    if (procs.count > 0) return refuse(`${plural(procs.count, 'process', 'processes')} ${procs.count === 1 ? 'runs' : 'run'} inside it`)
    const ids =
      (await this.o
        .sessionsIn?.([{ dir: f.dir, createdAt: f.createdAt }], r.project)
        .then((m) => m.get(f.dir) ?? [])
        .catch(() => [] as string[])) ?? []
    const facts = ids.length > 0 && this.o.conversations ? this.o.conversations(ids) : new Map<string, ConversationFacts | null>()
    if (ids.some((x) => facts.get(x)?.running)) return refuse('its conversation is running')

    // ── the gesture ──
    const now = this.nowMs()
    const trash = join(this.o.trashDir, WORKTREE_TRASH_FOLDER, `${iso(now).replace(/[:.]/g, '-')}-${basename(f.dir)}`)
    let bundle: string | null = null
    // a branch that landed only by patch is kept, recoverable, before anything moves
    if (f.branch && !f.ancestor) {
      await mkdir(trash, { recursive: true, mode: 0o700 })
      bundle = join(trash, `${f.branch.replace(/[^A-Za-z0-9._-]/g, '_')}.bundle`)
      const b = await this.git(r.project, ['bundle', 'create', bundle, `refs/heads/${f.branch}`, `^${base.sha}`])
      const v = b.ok ? await this.git(r.project, ['bundle', 'verify', bundle]) : b
      if (!v.ok) return refuse(`git could not write a bundle of ${f.branch} into the trash — nothing was touched (${v.err})`, 500)
    }
    // every file git does not track goes to the trash, never deleted
    let moved = 0
    const leftovers = [...f.untracked, ...f.ignored]
    if (leftovers.length > 0) {
      await mkdir(join(trash, 'leftovers'), { recursive: true, mode: 0o700 })
      for (const rel of leftovers) {
        const clean = rel.replace(/\/+$/, '')
        const src = resolve(f.dir, clean)
        if (!within(src, f.dir) || src === f.dir) continue
        const dst = join(trash, 'leftovers', clean)
        try {
          await mkdir(dirname(dst), { recursive: true, mode: 0o700 })
          await moveTo(src, dst)
          moved++
        } catch (err) {
          return {
            ok: false,
            code: 500,
            reason: `${name} was not removed: ${clean} could not be moved to the trash (${err instanceof Error ? err.message : String(err)}) — ${moved > 0 ? `${plural(moved, 'leftover')} already moved to ${trash}` : 'nothing was moved'}`,
          }
        }
      }
    }
    const rm1 = await this.git(r.project, ['worktree', 'remove', f.dir])
    if (!rm1.ok)
      return {
        ok: false,
        code: 500,
        reason: `git refused to remove ${name} (${rm1.err})${moved > 0 ? ` — its ${plural(moved, 'leftover')} ${moved === 1 ? 'is' : 'are'} in ${trash}` : ''}`,
      }
    // the branch: -d when the default branch holds it, else -D after its bundle
    let branchSaid = ''
    let partial = false
    if (f.branch) {
      let del: GitResult | null = f.ancestor ? await this.git(r.project, ['branch', '-d', f.branch]) : null
      if (!f.ancestor || (del !== null && !del.ok)) {
        // -d judges against the main checkout's HEAD, not the default branch:
        // when it refuses, the branch is kept recoverable first, then -D
        if (bundle === null) {
          await mkdir(trash, { recursive: true, mode: 0o700 })
          const file = join(trash, `${f.branch.replace(/[^A-Za-z0-9._-]/g, '_')}.bundle`)
          if ((await this.git(r.project, ['bundle', 'create', file, `refs/heads/${f.branch}`])).ok) bundle = file
        }
        if (bundle !== null) del = await this.git(r.project, ['branch', '-D', f.branch])
      }
      if (del && del.ok) {
        branchSaid = f.ancestor
          ? ` Branch ${f.branch} deleted — it is in ${base.name}${bundle !== null ? '; a bundle of it is in the trash' : ''}.`
          : ` Branch ${f.branch} deleted — its ${plural(f.ahead, 'commit')} ${f.ahead === 1 ? 'is' : 'are'} in ${base.name} by patch; a bundle of it is in the trash.`
      } else {
        partial = true
        branchSaid = ` Branch ${f.branch} was kept: git refused to delete it${del && !del.ok ? ` (${del.err})` : ''}.`
      }
    }
    const stamp = iso(now)
    const wrote = moved > 0 || bundle !== null
    const whyBy =
      by === 'owner'
        ? 'removed by you'
        : by === 'silos'
          ? `removed by Silos — merged and idle for ${Math.round((this.o.idleCloseMs ?? WORKTREE_IDLE_CLOSE_MS) / 3600_000)} h`
          : `removed by ${by}`
    this.recs.set(id, {
      ...r,
      state: 'removed',
      removedAt: stamp,
      removedBy: by,
      why: whyBy,
      processes: 0,
      updatedAt: stamp,
      ...(wrote ? { trash } : {}),
    })
    this.persist(now)
    const leftSaid = moved > 0 ? ` ${plural(moved, 'leftover')} moved to the trash.` : ''
    const says = `Removed ${name}${by === 'silos' ? ' (merged, idle)' : ''}.${branchSaid}${leftSaid}`
    return { ok: true, value: { id, outcome: partial ? 'partial' : 'removed', moved, bundle, trash: wrote ? trash : null, says } }
  }
}

// a move: a rename, or — across file systems — a copy then the original's
// removal (still a move: the bytes are in the trash before the name goes)
async function moveTo(src: string, dst: string): Promise<void> {
  try {
    await rename(src, dst)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await cp(src, dst, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false })
    await rm(src, { recursive: true })
  }
}
