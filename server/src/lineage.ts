import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync } from 'node:fs'
import { backupCorruptJson } from './json-store.js'
import { join } from 'node:path'

// lineage.ts — chains: records "which session this session was born from".
// Same pattern as native.json (NativeStore): flat file in ~/.silos, key
// "<folder>/<id>", atomic write (tmp + rename), injectable path for tests.
// Three birth points feed it — server.ts (fork from "Continue in Silos"),
// resident.ts (a keep thread's rotation) and a console's `/clear` (see
// absorbRotations) — all via record(), which NEVER
// overwrites an existing entry: a session only has one parent, and the
// first one to register it wins.
// `cleared`: ids of children born from a console `/clear` (absorbRotations)
// — a /clear is a new conversation, not a continuation. By
// id, like folderOfKnown: a transcript can move folders, its id can't.
// `owners`: session id → agent id, WHO a session belongs to when that was
// inherited from its origin (a /clear rotation, a `--resume` fork carry no
// marker of their own). Written the moment the inheritance is resolved
// with certainty (session-owner.ts), so burying or purging the origin
// never changes the owner (a Builder thread once read as Writer after a mass
// trash took its root out of the index). By id, like `cleared`.
interface Shape {
  parents: Record<string, string>
  cleared?: string[]
  owners?: Record<string, string>
}

const keyId = (key: string): string => key.slice(key.lastIndexOf('/') + 1)
const keyFolder = (key: string): string => key.slice(0, key.lastIndexOf('/'))
// The project a folder belongs to: a worktree's folder is its project's plus
// `--claude-worktrees-<name>` (cwd `<p>/.claude/worktrees/<name>`, encoded).
// A console's claude can enter one and `/clear` there — still its own past.
const projectOf = (folder: string): string => {
  const i = folder.indexOf('--claude-worktrees-')
  return i === -1 ? folder : folder.slice(0, i)
}

export class LineageStore {
  private cache: Shape | null = null
  // the repair runs on the first pass after a (re)start — keys a previous
  // process recorded wrong — and then only when a pass gives it cause.
  private repaired = false
  // rotations recorded under the parent's folder because the child wasn't
  // indexed yet: they're re-placed once the index learns where they live.
  private provisional = new Set<string>()
  // bumped on every write: callers memoize derived views against it.
  private rev = 0
  private contParents: { rev: number; map: Map<string, string | null> } | null = null
  constructor(private file: string) {}

  get revision(): number {
    return this.rev
  }

  // Every written-down owner, [session id, agent id].
  ownerEntries(): Array<[string, string]> {
    return Object.entries(this.read().owners ?? {})
  }

  // continuationParentIdOf for every recorded child at once (first entry
  // per child id wins, as in the per-id scan), memoized per revision.
  continuationParents(): Map<string, string | null> {
    if (this.contParents?.rev === this.rev) return this.contParents.map
    const map = new Map<string, string | null>()
    for (const [child, parent] of Object.entries(this.read().parents)) {
      const id = keyId(child)
      if (map.has(id)) continue
      map.set(id, projectOf(keyFolder(child)) === projectOf(keyFolder(parent)) ? keyId(parent) : null)
    }
    this.contParents = { rev: this.rev, map }
    return map
  }

  private read(): Shape {
    if (this.cache) return this.cache
    let s: Shape = { parents: {} }
    if (existsSync(this.file)) {
      let text: string | null = null
      try {
        text = readFileSync(this.file, 'utf8')
        const raw = JSON.parse(text) as Shape
        if (raw && typeof raw === 'object' && raw.parents && typeof raw.parents === 'object') s = raw
        else backupCorruptJson(this.file, text, 'lineage')
      } catch {
        // corrupt → keep the only copy, then start fresh (the next write
        // replaces the file; thread chains must never vanish silently)
        if (text !== null) backupCorruptJson(this.file, text, 'lineage')
      }
    }
    this.cache = s
    return s
  }

  // Immediate parent of childKey ("folder/id"), or null if this session
  // wasn't born from another (or we don't know it). It's the only thing
  // SessionView.parentKey exposes — the rest of the chain is resolved by
  // the client, walking these links over the sessions it already has in
  // the overview.
  parentOf(childKey: string): string | null {
    return this.read().parents[childKey] ?? null
  }

  // Same link, by session id alone. Keys bake the folder in, but Claude
  // Code RELOCATES a transcript when the session enters a worktree
  // (`-home-x` → `-home-x--claude-worktrees-w`), so a "folder/id" written
  // yesterday may name a folder the session no longer sits in — on either
  // side of the link. Ids are UUIDs: they are the identity. Returns the
  // parent's id, for the caller to place wherever it lives now.
  parentIdOf(childId: string): string | null {
    for (const [child, parent] of Object.entries(this.read().parents)) {
      if (keyId(child) === childId) return keyId(parent)
    }
    return null
  }

  // Same link, restricted to a CONTINUATION: the parent was recorded in the
  // same PROJECT as the child (a /clear rotation, a `--resume` twin) — a
  // fork from another project is a different conversation, not this one's
  // past. A worktree counts as its project: the console's claude may have
  // entered one before the /clear, and keys follow the transcript there.
  continuationParentIdOf(childId: string): string | null {
    for (const [child, parent] of Object.entries(this.read().parents)) {
      if (keyId(child) === childId) return projectOf(keyFolder(child)) === projectOf(keyFolder(parent)) ? keyId(parent) : null
    }
    return null
  }

  // The folder a session id was recorded under, on either side of a link.
  // Lineage remembers a session after its transcript is buried
  // (Maintenance trashes history; the link is what keeps a console ONE
  // thread), so a key the index no longer knows can still be placed.
  folderOfKnown(id: string): string | null {
    for (const [child, parent] of Object.entries(this.read().parents)) {
      if (keyId(child) === id) return keyFolder(child)
      if (keyId(parent) === id) return keyFolder(parent)
    }
    return null
  }

  // Was this session born from a console `/clear`? (see Shape.cleared)
  isClear(childId: string): boolean {
    return this.read().cleared?.includes(childId) ?? false
  }

  // The agent a session was resolved to belong to, if that was ever
  // written down (see Shape.owners) — null otherwise.
  ownerOf(id: string): string | null {
    return this.read().owners?.[id] ?? null
  }

  // Never overwrites: the origin decided once (same rule as record()).
  recordOwner(id: string, agentId: string): void {
    const s = this.read()
    if (s.owners?.[id] !== undefined) return
    this.write({ ...s, owners: { ...(s.owners ?? {}), [id]: agentId } })
  }

  // Never overwrites an existing entry — a session registers its parent
  // only once, first to arrive (fork or rotation) wins.
  record(childKey: string, parentKey: string): void {
    const s = this.read()
    if (s.parents[childKey] !== undefined) return
    s.parents[childKey] = parentKey
    this.write(s)
  }

  private write(s: Shape): void {
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n')
    renameSync(tmp, this.file)
    this.cache = s
    this.rev++
  }

  // Re-places every key, on both sides of every link, in the folder its
  // session lives in NOW — rotations recorded under the parent's folder
  // before the fix (a /clear inside a worktree: a key no endpoint
  // could resolve), and transcripts relocated since. An id the index
  // doesn't know (buried, never written) keeps the folder it was recorded
  // under. Order is kept — tipOf's "last child wins" reads it — and an id
  // that collapses onto an existing child key loses to the first, as in
  // record(). Writes only when something moved.
  private repair(folderOf: (id: string) => string | null, complete: boolean): void {
    const s = this.read()
    const place = (key: string): string => {
      const now = folderOf(keyId(key))
      return now === null ? key : `${now}/${keyId(key)}`
    }
    const parents: Record<string, string> = {}
    let changed = false
    for (const [child, parent] of Object.entries(s.parents)) {
      const c = place(child)
      const p = place(parent)
      if (c !== child || p !== parent) changed = true
      if (parents[c] !== undefined) {
        changed = true
        continue
      }
      parents[c] = p
    }
    for (const id of this.provisional) if (folderOf(id) !== null) this.provisional.delete(id)
    if (complete) this.repaired = true // a mid-scan pass doesn't count as the restart's repair
    if (changed) this.write({ ...s, parents })
  }

  // Full ancestor chain of key, from nearest to farthest — resolves
  // transitively (rotation after rotation, fork after fork) with an
  // anti-cycle guard: an already-seen parent cuts the chain short instead
  // of looping forever (should never happen with record() protecting the
  // first write, but a hand-edited lineage.json isn't ruled out).
  chainOf(key: string): string[] {
    const parents = this.read().parents
    const seen = new Set<string>([key])
    const chain: string[] = []
    let cur = key
    for (;;) {
      const parent = parents[cur]
      if (parent === undefined || seen.has(parent)) break
      chain.push(parent)
      seen.add(parent)
      cur = parent
    }
    return chain
  }

  // The far end of a key's DESCENDANT chain: follows child links while
  // they're unambiguous. With several children (pre-fix star data) the
  // most recently recorded one wins — object key order is insertion
  // order, so "last child registered" is the console's latest rotation.
  tipOf(key: string): string {
    const parents = this.read().parents
    let cur = key
    const seen = new Set<string>([cur])
    for (;;) {
      let next: string | null = null
      for (const [child, parent] of Object.entries(parents)) {
        if (parent === cur) next = child // last match wins (insertion order)
      }
      if (next === null || seen.has(next)) return cur
      seen.add(next)
      cur = next
    }
  }

  // Where a conversation IS now: the most recently active session among
  // the key ITSELF and every descendant (BFS over child links), by
  // transcript activity. A session is superseded only by a descendant that
  // moved LATER than it — a /clear rotation (its child is newer) still
  // hands over, while a stale child (an SDK fork born at once by an old
  // bug, untouched for hours under a console written every minute) never
  // steals the thread. A descendant whose activity is
  // unknown (not indexed) never wins; the key itself always competes, at
  // -Infinity when unknown. Ties keep the key. Bounded and cycle-safe.
  // tipOf ("last child wins") stays for absorbRotations' chaining.
  recentTipOf(key: string, mtimeOf: (key: string) => number | null): string {
    const parents = this.read().parents
    const children = new Map<string, string[]>()
    for (const [child, parent] of Object.entries(parents)) {
      const list = children.get(parent)
      if (list) list.push(child)
      else children.set(parent, [child])
    }
    let best = key
    let bestMtime = mtimeOf(key) ?? -Infinity
    const seen = new Set<string>([key])
    const queue = [key]
    while (queue.length > 0 && seen.size < 256) {
      const cur = queue.shift() as string
      for (const child of children.get(cur) ?? []) {
        if (seen.has(child)) continue
        seen.add(child)
        queue.push(child)
        const m = mtimeOf(child)
        // a tie goes to the descendant: a /clear child written in the same
        // instant as its parent IS where the thread continues
        if (m !== null && m >= bestMtime) {
          best = child
          bestMtime = m
        }
      }
    }
    return best
  }

  // A console's `/clear`: Claude Code doesn't empty the transcript, it
  // rotates to a NEW session id and a new JSONL that carries no mark of
  // where it came from (unlike a `--resume` fork). The console's claude
  // runs a SessionStart hook (matcher "clear", see rotationHookCommand in
  // terminal-service) that files `<dir>/<newId>.json = {from: consoleKey}`.
  // This turns those files into records — the new session hangs from the
  // console's latest session, so the sidebar keeps ONE thread and
  // consoleKeyFor reattaches to the running claude instead of starting a
  // `--resume` twin over the same file. A file whose parent isn't indexed
  // yet is left for a later pass; garbage is removed.
  // Returns the child keys absorbed in this pass — the caller re-announces
  // those sessions (their already-broadcast metas carried no parentKey, so
  // the sidebar was showing a second, orphan row until something else
  // touched the session — the "duplicate daughter" the owner saw).
  // `indexComplete`: whether folderOf answers from a finished scan. The
  // restart repair waits for it — run against a half-built index (the
  // first session events arrive mid-scan) it found nothing to move, counted
  // itself done, and a key recorded in the wrong folder stayed wrong for
  // good (a /clear inside a worktree once lost its console).
  absorbRotations(dir: string, folderOf: (id: string) => string | null, mtimeOf?: (key: string) => number | null, indexComplete = true): string[] {
    let names: string[]
    try {
      names = readdirSync(dir).filter((n) => n.endsWith('.json'))
    } catch {
      names = []
    }
    const absorbed: string[] = []
    for (const name of names) {
      const path = join(dir, name)
      const childId = name.slice(0, -'.json'.length)
      let from: unknown
      try {
        from = (JSON.parse(readFileSync(path, 'utf8')) as { from?: unknown }).from
      } catch {
        rmSync(path, { force: true })
        continue
      }
      if (typeof from !== 'string' || !/^[\w-]+$/.test(childId)) {
        rmSync(path, { force: true })
        continue
      }
      // where the console's first session lives NOW — or, once the owner has
      // buried it (Maintenance), where lineage recorded it: burying history
      // never breaks the chain. Unknown to both: a later pass.
      const folder = folderOf(from) ?? this.folderOfKnown(from)
      if (folder === null) continue
      // The child sits where its OWN transcript is: not always the parent's
      // folder — the console's claude may have entered a worktree before the
      // /clear. The hook can beat the watcher to it (or the JSONL isn't
      // written until the first prompt), so an unindexed child is recorded
      // under the parent's folder and re-placed by a later pass's repair —
      // deferring the file instead would hold the link hostage to a
      // transcript that may never be written.
      const own = folderOf(childId)
      if (own === null) this.provisional.add(childId)
      const childKey = `${own ?? folder}/${childId}`
      // LINEAR, not star: the hook always files the CONSOLE
      // key (the first session id) as `from`, but the honest parent of a
      // new rotation is the console's LATEST session — hanging every
      // /clear off the first one made the sidebar ("2 earlier", connected
      // components) and the column (strict ancestor walk: 1) disagree,
      // with the middle sibling missing from the chain.
      // ...and "latest" means most recently ACTIVE (recentTipOf): "last
      // child recorded" hung a /clear off a stale SDK twin once one had
      // been recorded under the console.
      this.record(childKey, mtimeOf ? this.recentTipOf(`${folder}/${from}`, mtimeOf) : this.tipOf(`${folder}/${from}`))
      const s = this.read()
      if (!(s.cleared ?? []).includes(childId)) this.write({ ...s, cleared: [...(s.cleared ?? []), childId] })
      rmSync(path, { force: true })
      absorbed.push(childKey)
    }
    // cheap to skip: on a session event (every transcript line) there's
    // usually nothing absorbed and no provisional child placed since.
    if ((!this.repaired && indexComplete) || absorbed.length > 0 || [...this.provisional].some((id) => folderOf(id) !== null))
      this.repair(folderOf, indexComplete)
    return absorbed
  }
}
