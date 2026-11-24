// silos/kernel-kinds.ts — the published catalog of KERNEL KINDS (Silo
// Standard v0, docs/standard/catalogs.md «Kernel kinds»). A silo
// whose source is `kernel` reads no one's files: it declares presentation
// over data the kernel already holds, and this catalog is the contract — the
// kind's states (with which is terminal), its fields with their types, the
// envelope fields and the roles. Names here are STABLE: entries are only
// added (renaming or retiring one is a major of the standard), the same rule
// as slots and archetypes.
//
// Kernel kinds go UNQUALIFIED (`process`) and their names are reserved: a
// silo's own kinds are always qualified by the silo (`invoices/invoice`), so
// nothing can squat a kernel kind's name.
//
// The words of `reads` are what the install dialog says the silo reads — a
// kernel source has no paths to list, so the catalog says it in plain words.

export const KERNEL_KINDS_VERSION = 'kernel-kinds/v0'

export type KernelFieldType = 'string' | 'number' | 'timestamp' | 'boolean'

export interface KernelKind {
  // what the install dialog says this silo reads (there are no paths)
  reads: string
  // the field each envelope name reads from — fixed by the kernel, not the manifest
  envelope: { id: string; state: string; at: string; updatedBy: string }
  // `quiet`: reaching this terminal state is no work done — Home's Done
  // today and the digest never list it (a process exiting is not something
  // anyone finished; a delivered wake, a done execution are)
  states: Array<{ value: string; terminal: boolean; quiet?: true }>
  fields: Record<string, { type: KernelFieldType; optional?: boolean }>
  roles: { due?: string }
  // 'producers': the kernel writes these records ABOUT
  // the agents the operator binds to the presenting silo's producer role —
  // so that silo names an AGENT role (never `kernel`), may carry
  // producer.instructions (what the bound agents are told) and never a
  // sync, and its brief names no record routes: the agents write nothing
  // in it. Absent: the kernel is the producer and nobody is bound (process).
  binds?: 'producers'
  // the record hangs from a record of ANOTHER silo,
  // which the kernel resolves and writes in `field` (the parent's record
  // key): `hub: 'task'` = a task of the built-in plans silo. A manifest
  // over this kind may declare the anchor `{hub: 'task', from: 'parent'}`
  // (only then: the validator refuses it over any other kind). Absent: the
  // records hang from nothing but the platform.
  parent?: { hub: 'task'; field: string }
  // the KERNEL-VERBS this kind admits (names of KERNEL_VERBS): the kernel's
  // own mutations of its records that a manifest over this kind may declare
  // (`{verb: kernel-verb, name, kind, when?}`). Absent: read-only — open/ack.
  verbs?: string[]
  // fields whose words NAME something the pages can open: `field`
  // says the conversation whose folder is in `folder` and id in `id` (both
  // fields the kernel writes, absent when there is nothing to open — a
  // deleted conversation). A list grouped by such a field makes the group's
  // heading that door (views.ts `group.opens`). Absent: words only.
  refs?: Record<string, { hub: 'conversation'; folder: string; id: string }>
}

// The kernel-verbs (Silo Standard v0, catalogs.md «Kernel-verbs»): an
// ENUMERATED, CLOSED catalog — a manifest names one of these, the kernel does
// the work; a name not here is refused in plain words. Names are STABLE and
// only added (the slot rule). Each is the owner's gesture alone: an agent
// bearer never runs one (it acts from its own shell). `guard`: the boolean
// field the kernel itself writes on every record of the kind — whether the
// verb applies to THAT record now (a page hides the door when false); the
// kernel re-checks it at the gesture, whatever the page showed. `says`: the
// door's word; `pending`: what the door reads from the click until the
// kernel answers («Stopping…» — a stop can take seconds, and a door that
// says nothing reads as broken).
// Which kinds admit a verb is the KIND's entry (`verbs`), said once there.
export interface KernelVerb {
  says: string
  pending: string
  guard: string
  // what the install dialog says the verb lets Silos do (its strong grant)
  grants: string
}
export const KERNEL_VERBS: Readonly<Record<string, KernelVerb>> = {
  // stop a `process` record: re-read the live table, verify the root is the
  // same process (pid AND start time), signal its tree as it is now (SIGTERM,
  // a short grace, SIGKILL the survivors), scan at once — the record reads
  // `exited`, stopped by the owner. Never this server's own tree, never a
  // process of another user.
  'stop-process': {
    says: 'Stop',
    pending: 'Stopping…',
    guard: 'stoppable',
    grants: "stop a process your conversations left running when you ask — SIGTERM, then SIGKILL; never Silos itself, never another user's",
  },
  // remove a `worktree` record (silos/worktrees.ts): re-read the live facts
  // (still a linked worktree of a project Silos knows, not the main
  // checkout, nothing of it missing from the default branch, no tracked
  // change, no process inside, its conversation not running); write a git
  // bundle of the branch into Silos' trash when it landed only by patch;
  // move every file git does not track (untracked and ignored) into the
  // trash; `git worktree remove` (never --force); delete the branch (-d when
  // it is an ancestor of the default branch, -D after the bundle). Never the
  // stash. The record reads `removed`. The same path Silos itself takes for a
  // merged worktree idle past WORKTREE_IDLE_CLOSE_MS.
  'remove-worktree': {
    says: 'Remove',
    pending: 'Removing…',
    guard: 'removable',
    grants:
      "remove a git worktree whose work is all in its project's default branch — its untracked files and a bundle of its branch go to Silos' trash; never one with unmerged work or a process inside",
  },
}

export function kernelVerb(name: string): KernelVerb | null {
  return Object.prototype.hasOwnProperty.call(KERNEL_VERBS, name) ? KERNEL_VERBS[name]! : null
}

// v0: `task-wake`, `execution`, `process`, `worktree`.
export const KERNEL_KINDS: Readonly<Record<string, KernelKind>> = {
  // the WAKES of task mode (server/src/task-mode/): each
  // time an event on a task (its blockers done, its children done, an owner
  // note, its next check passed) calls its bound owner, one record — queued
  // while the owner's conversation is mid-turn or held, delivered when the
  // turn reaches it, superseded when the task moved on before it could be
  // delivered. Written by the kernel about the agents bound to Task mode.
  'task-wake': {
    reads: 'its wakes: each time Silos woke an agent on a task, and why',
    envelope: { id: 'id', state: 'state', at: 'at', updatedBy: 'updatedBy' },
    states: [
      { value: 'queued', terminal: false },
      { value: 'delivered', terminal: true },
      { value: 'superseded', terminal: true },
    ],
    fields: {
      agent: { type: 'string' }, // the bound agent woken
      task: { type: 'string' }, // the task's record key in the plans silo
      ref: { type: 'string' }, // plan#task, as people say it
      title: { type: 'string' }, // the task's title when it fired
      reason: { type: 'string' }, // unblocked · children-done · owner-note · next-check
      says: { type: 'string' }, // the reason in plain words
      at: { type: 'timestamp' }, // when it fired — the envelope's at
      deliveredAt: { type: 'timestamp', optional: true }, // when its turn started
      session: { type: 'string', optional: true }, // the conversation it reached
      held: { type: 'string', optional: true }, // why it waits, in plain words
    },
    roles: {},
    binds: 'producers',
  },
  // the SDD EXECUTIONS (server/src/silos/executions.ts):
  // one record per ledger (.superpowers/sdd/<plan>/progress.md) the kernel
  // already reads — the copy a conversation's ledger left in
  // <dataDir>/executions (it outlives the worktree), or a live ledger in a
  // managed folder's checkouts no conversation is known to have written.
  // running → fixing (a task in a fix round), only while something runs it;
  // stopped (unfinished, nothing runs it); done (every task of the document
  // complete). It hangs from the plan task it executes: the task
  // whose conversations[] holds the session that wrote the ledger, else the
  // task whose `source` names the same document (two literal edges).
  execution: {
    reads: "the SDD ledgers your agents' conversations wrote — read-only",
    envelope: { id: 'id', state: 'state', at: 'updatedAt', updatedBy: 'updatedBy' },
    states: [
      { value: 'running', terminal: false },
      { value: 'fixing', terminal: false },
      { value: 'stopped', terminal: false },
      { value: 'done', terminal: true },
    ],
    fields: {
      title: { type: 'string' }, // the plan document's title (else the ledger's, else its folder name)
      updatedAt: { type: 'timestamp' }, // the ledger's last write — the envelope's at
      done: { type: 'number' }, // tasks complete (of the document's, when there is one)
      total: { type: 'number' }, // the document's task count, else the tasks the ledger names
      totalFrom: { type: 'string' }, // 'document' · 'ledger' — where total comes from
      gone: { type: 'boolean' }, // the ledger is gone (its worktree removed): Silos' copy speaks
      ledger: { type: 'string' }, // the ledger's path
      session: { type: 'string', optional: true }, // the conversation that wrote it
      folder: { type: 'string', optional: true }, // that conversation's folder (as the index names it)
      agent: { type: 'string', optional: true }, // the agent that conversation belongs to
      project: { type: 'string', optional: true }, // the main checkout the document lives in
      doc: { type: 'string', optional: true }, // the document, inside its main checkout
      fixingTask: { type: 'number', optional: true }, // the first task in a fix round (while not done)
      round: { type: 'number', optional: true }, // its round
      task: { type: 'string', optional: true }, // the plan task it hangs from — the plans record key
      taskRef: { type: 'string', optional: true }, // that task as people say it: plan#id
      edge: { type: 'string', optional: true }, // 'conversation' · 'document' — which edge hung it
      otherLedgers: { type: 'number', optional: true }, // ledgers of the same document, no conversation known, folded into this one
      otherLedgersSay: { type: 'string', optional: true }, // those ledgers and how far each got
    },
    roles: {},
    parent: { hub: 'task', field: 'task' },
  },
  // the PROCESSES conversations left on this machine (server/src/silos/
  // processes.ts). A process is a gauge-like thing — a test worker that lives
  // 2 s is not a case — so a record is one process TREE ROOT that either
  // carries a conversation's session id in its environment and was seen alive
  // for MIN_ALIVE_MS across scans, or holds a listening TCP port (recorded at
  // once, conversation or not). running (its conversation runs now, or it
  // belongs to none) · left (alive, nothing of its conversation runs any
  // more) · exited (terminal; kept 24 h, then pruned).
  process: {
    reads: 'the processes your conversations started on this machine and the ports they listen on',
    envelope: { id: 'id', state: 'state', at: 'startedAt', updatedBy: 'updatedBy' },
    states: [
      { value: 'running', terminal: false },
      { value: 'left', terminal: false },
      { value: 'exited', terminal: true, quiet: true },
    ],
    fields: {
      command: { type: 'string' }, // its command line, REDACTED (secrets after token/key/… flags, opaque blobs), ≤ 200 chars
      startedAt: { type: 'timestamp' }, // when the process started (a listener nobody can read: when Silos first saw it) — the envelope's at
      origin: { type: 'string' }, // conversation · silos (this server's own tree) · machine (this user's, no conversation) · other-user (a listener of another user: its process can't be read)
      pid: { type: 'number', optional: true }, // absent: a listener whose process can't be read (another user's)
      cpu: { type: 'number', optional: true }, // percent of one core, averaged between the last two scans (absent: one scan yet, or exited)
      memoryMb: { type: 'number', optional: true }, // resident memory of the tree (absent once exited)
      processes: { type: 'number', optional: true }, // the processes folded into this record: the root and its descendants
      ports: { type: 'string', optional: true }, // the TCP ports the tree listens on: «4391, 5193»
      cwd: { type: 'string', optional: true }, // the root's working directory
      session: { type: 'string', optional: true }, // the conversation it came from (its current session)
      folder: { type: 'string', optional: true }, // that conversation's folder, as the index names it
      agent: { type: 'string', optional: true }, // the agent that conversation belongs to
      conversation: { type: 'string', optional: true }, // its title as Silos shows it, or literally «a deleted conversation (4c440473)»
      why: { type: 'string', optional: true }, // in plain words — left: «its conversation was deleted» · «its conversation is not running»; exited by the owner's stop: «stopped by you»
      exitedAt: { type: 'timestamp', optional: true }, // when a scan first found it gone (or the stop saw it go)
      stoppable: { type: 'boolean', optional: true }, // the kernel's guard of stop-process: running or left, readable, this user's, not Silos' own tree
      stoppedAt: { type: 'timestamp', optional: true }, // when the owner stopped it
      stoppedBy: { type: 'string', optional: true }, // who stopped it: owner
    },
    roles: {},
    verbs: ['stop-process'],
    refs: { conversation: { hub: 'conversation', folder: 'folder', id: 'session' } },
  },
  // the git WORKTREES conversations left on this machine (server/src/silos/
  // worktrees.ts): one record per LINKED worktree of every project folder
  // Silos knows that is a git main checkout (`git worktree list`; the main
  // checkout is never one). in-use (a live process inside, or its
  // conversation runs) · merged (nothing of it is missing from the default
  // branch: every commit an ancestor or patch-equivalent, no tracked change)
  // · unmerged (commits or tracked changes the default branch lacks) ·
  // removed (terminal and quiet; kept 24 h, then pruned).
  worktree: {
    reads: 'the git worktrees of your projects, what of each is not in its default branch, and the conversation that made it',
    envelope: { id: 'id', state: 'state', at: 'lastCommitAt', updatedBy: 'updatedBy' },
    states: [
      { value: 'in-use', terminal: false },
      { value: 'merged', terminal: false },
      { value: 'unmerged', terminal: false },
      { value: 'removed', terminal: true, quiet: true },
    ],
    fields: {
      path: { type: 'string' }, // the worktree's folder, relative to its project when inside it
      dir: { type: 'string' }, // the same, absolute
      project: { type: 'string' }, // the main checkout it belongs to
      branch: { type: 'string', optional: true }, // its branch (absent: a detached HEAD)
      base: { type: 'string', optional: true }, // the project's default branch it is measured against
      ahead: { type: 'number' }, // its commits (merges aside) not reachable from the default branch
      landed: { type: 'number' }, // of those, the ones patch-equivalent to a commit in it (git cherry: cherry-picked)
      changes: { type: 'number' }, // tracked files modified or staged
      leftovers: { type: 'number' }, // untracked entries (git status ??) — they go to the trash on removal
      lastCommitAt: { type: 'timestamp' }, // its HEAD's commit time — the envelope's at
      processes: { type: 'number' }, // live processes whose working directory is inside it
      session: { type: 'string', optional: true }, // the conversation that made or works it (its current session)
      folder: { type: 'string', optional: true }, // that conversation's folder, as the index names it
      agent: { type: 'string', optional: true }, // that conversation's agent
      conversation: { type: 'string', optional: true }, // its title as Silos shows it, or literally «a deleted conversation (4c440473)»
      why: { type: 'string', optional: true }, // the state (and the guard) in plain words
      removable: { type: 'boolean', optional: true }, // the guard of remove-worktree: merged, not in use, not locked, the machine's processes readable
      removedAt: { type: 'timestamp', optional: true }, // when it was removed (or found gone)
      removedBy: { type: 'string', optional: true }, // owner · silos (merged and idle past the window); absent: removed outside Silos
      trash: { type: 'string', optional: true }, // where its leftovers and its branch's bundle went
    },
    roles: {},
    verbs: ['remove-worktree'],
    refs: { conversation: { hub: 'conversation', folder: 'folder', id: 'session' } },
  },
}

export function kernelKind(name: string): KernelKind | null {
  return Object.prototype.hasOwnProperty.call(KERNEL_KINDS, name) ? KERNEL_KINDS[name]! : null
}

// The kernel sources of a manifest (none: a silo over files).
export function kernelSourcesOf(manifest: Record<string, unknown>): Array<{ id: string; kind: string }> {
  const spec = manifest.spec as { sources?: unknown } | undefined
  const sources = Array.isArray(spec?.sources) ? spec.sources : []
  return sources
    .filter(
      (x): x is { id: unknown; root: string; kind: string } =>
        typeof x === 'object' && x !== null && (x as { root?: unknown }).root === 'kernel' && typeof (x as { kind?: unknown }).kind === 'string',
    )
    .map((x) => ({ id: String(x.id), kind: x.kind }))
}

// Which of the manifest's kinds each kernel source feeds (source id → kind
// name). ONE kernel source feeds the silo's one top-level kind, whatever its
// name (task-mode presents `task-wake` as `wake`). SEVERAL (System
// 0.3.0: processes and worktrees, one silo — the same question, «what
// conversations left on this machine») each feed the top-level kind NAMED
// LIKE the kernel kind they present — the name is the link, nothing else
// to declare. A problem in plain words when the kinds and sources don't
// pair one to one.
export function kernelFeeds(manifest: Record<string, unknown>): Map<string, string> | { problem: string } {
  const sources = kernelSourcesOf(manifest)
  const spec = manifest.spec as { kinds?: unknown } | undefined
  const top = typeof spec?.kinds === 'object' && spec.kinds !== null ? Object.keys(spec.kinds as object) : []
  if (sources.length === 1) {
    if (top.length === 1) return new Map([[sources[0]!.id, top[0]!]])
    return { problem: `this silo declares ${top.length} kinds and nothing says which source feeds which — v0 reads silos with one kind per manifest` }
  }
  const out = new Map<string, string>()
  for (const s of sources) {
    if (!top.includes(s.kind))
      return {
        problem: `source ${s.id} presents the kernel kind ${s.kind}, and no kind of this silo is named ${s.kind} — with several kernel sources, each feeds the kind named like the kernel kind it presents`,
      }
    if ([...out.values()].includes(s.kind)) return { problem: `two kernel sources present ${s.kind} — one source per kernel kind` }
    out.set(s.id, s.kind)
  }
  const unfed = top.filter((k) => ![...out.values()].includes(k))
  if (unfed.length > 0)
    return { problem: `no source feeds ${unfed.join(', ')} — with several kernel sources, every kind is named like the kernel kind one of them presents` }
  return out
}

// The kernel kind that presents the manifest's kind `kindName` (null: a
// silo over files, or a kind no kernel source feeds).
export function kernelKindFor(manifest: Record<string, unknown>, kindName: string): KernelKind | null {
  const feeds = kernelFeeds(manifest)
  if (!(feeds instanceof Map)) return null
  const src = kernelSourcesOf(manifest).find((s) => feeds.get(s.id) === kindName)
  return src ? kernelKind(src.kind) : null
}

// The quiet terminal states of the kernel kinds a manifest presents, as
// `<kind>\0<state>` (empty for a silo over files, or kinds with none).
export function quietEndsOf(manifest: Record<string, unknown>): Set<string> {
  const feeds = kernelFeeds(manifest)
  if (!(feeds instanceof Map)) return new Set()
  const out = new Set<string>()
  for (const s of kernelSourcesOf(manifest)) {
    const kind = feeds.get(s.id)
    for (const st of kernelKind(s.kind)?.states ?? []) if (st.quiet === true && kind !== undefined) out.add(`${kind}\0${st.value}`)
  }
  return out
}

// One record a kernel kind holds, as a reader takes it: its id, its value
// (the catalog's fields + the envelope's), and when the kernel last wrote it.
export interface KernelRecord {
  id: string
  value: Record<string, unknown>
  writtenAt: number
}

// What the kernel publishes of one kind to the silo reader.
export interface KernelRecordSource {
  records(now: number): KernelRecord[]
  lastWrite(): number | null
}

// kind name → its source (null: this Silos holds no such data right now)
export type KernelKindSources = (kind: string) => KernelRecordSource | null
