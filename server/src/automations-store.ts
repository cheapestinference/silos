// automations-store.ts — resident: persistence for Automation
// (~/.silos/automations.json, atomic tmp+rename
// write — same pattern as agent-registry.ts/native-store.ts) and for Run
// (~/.silos/runs/<automationId>.jsonl, APPEND-ONLY:
// each state change for a run is a new line; the "current" state is the
// last line seen for that id — folded in listRuns()). The runs file ROTATES
// once it exceeds RUNS_ROTATE_BYTES (current → .jsonl.1, a single
// generation retained — see rotateRunsIfNeeded); all readers fold both
// generations transparently.
import { existsSync, readFileSync, renameSync, mkdirSync, appendFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { atomicWriteJson, backupCorruptJson } from './json-store.js'
import { join } from 'node:path'
import type { Automation, Run } from './automations-types.js'
import { MANUAL_CAUSE } from './automations-types.js'
import { validateTrigger, validateThread } from './automations-validate.js'

interface Shape {
  automations: Automation[]
}

// runs.jsonl rotation (hygiene, a known v1.x follow-up): threshold by SIZE
// (2MB), not entry count — the check is an O(1) statSync per file (counting
// entries would mean reading the whole thing on every sweep), and size
// bounds the TWO resources rotation protects: disk, and the cost of
// folding the file line by line in listRuns(). An entry-count cap wouldn't
// reliably bound either: a Run line varies >10x (a webhook/watch
// promptOverride can reach ~4KB versus ~150 bytes for a normal snapshot).
// 2MB ≈ 5-15k typical snapshots — comfortably above the "~600 runs in a bad
// afternoon" hazard case, so rotation is rare and the two retained
// generations always cover the window consumers need (daily budget, retries).
export const RUNS_ROTATE_BYTES = 2 * 1024 * 1024

// Minimal shape check for a persisted Automation — prevents a hand-edited
// entry (or partial corruption) from surviving load() with a
// malformed `trigger`/`thread` that would later blow up in tick() (e.g.
// `a.trigger.kind` on a missing trigger) with a synchronous TypeError. Does
// not validate against AgentRegistry (a missing/archived agentId is already
// tolerated at runtime — executeChatTurn marks it 'failed', no need to
// discard the whole automation over that).
function isValidAutomationShape(v: unknown): v is Automation {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  if (typeof o.id !== 'string' || o.id === '') return false
  if (typeof o.name !== 'string') return false
  if (typeof o.agentId !== 'string') return false
  if (typeof o.prompt !== 'string') return false
  if (typeof o.createdAt !== 'string') return false
  if (typeof o.approval !== 'boolean') return false
  if (typeof o.keepAlive !== 'boolean') return false
  if (typeof o.paused !== 'boolean') return false
  try {
    // trigger.tz was stored unchecked before the validator learned zones: a
    // persisted cron with an unknown tz still loads (the resident pauses it
    // when it can't schedule it) instead of vanishing from the file.
    const trigger = o.trigger as Record<string, unknown> | null
    validateTrigger(trigger !== null && typeof trigger === 'object' && trigger.kind === 'cron' ? { ...trigger, tz: undefined } : trigger)
    validateThread(o.thread)
  } catch {
    return false
  }
  return true
}

// The daily budget bounds the turns the model actually works, not the
// attempts: once, nine SDK-400 rejections used up 12/day and the healthy
// runs after them were skipped. A run spends budget when:
//   - it finished 'ok' (it worked a whole turn);
//   - it failed or is waiting for a reset AFTER the model produced output
//     (`produced: true` — a timeout mid-work, a crash after tool calls);
//   - it is still pending or in flight (queued/waiting_approval/running):
//     it is about to spend one, so a burst can't overrun the cap.
// It never spends budget when it was skipped, or failed/hit a limit before
// the model produced anything (`produced: false`). Records written before
// `produced` existed count as not produced unless they ran into the timeout
// (half an hour of work by definition).
// A run of an owner's GESTURE («Run now», cause MANUAL_CAUSE) never spends
// the cron's budget (a class rule: an owner's gesture consumes no cron's
// budget): three «Run now» in a day leave the cron its own.
export function countsAgainstBudget(r: Run): boolean {
  if (r.cause === MANUAL_CAUSE) return false
  switch (r.status) {
    case 'skipped':
      return false
    case 'ok':
      return true
    case 'queued':
    case 'waiting_approval':
    case 'running':
      return true
    case 'failed':
    case 'waiting_reset':
      return r.produced ?? r.error === 'timeout'
    default:
      return true
  }
}

// a run still in a live state: it must finish (or be approved/skipped)
const isOpenRun = (r: Run): boolean => r.status === 'running' || r.status === 'queued' || r.status === 'waiting_approval'

export class AutomationsStore {
  private automations: Automation[] = []
  private file: string
  private runsDir: string
  // In-memory index of the LATEST run snapshot seen per automation —
  // maintained in O(1) on every appendRun(). Previously, tick() re-read and
  // folded the ENTIRE runs.jsonl of every automation on EVERY tick (every
  // 30s) just to check the most recent run's state; the file is still the
  // append-only source of truth, this map is only a cache over it — warmed
  // lazily (first query after a process restart) by reading the file once
  // via listRuns().
  private latestRunCache = new Map<string, Run | null>()
  // …and, warmed with it (one read of the file), each automation's run ids
  // and its OPEN runs (running · queued · waiting_approval) — so a run is
  // found BY ITS ID, never by being the last line written: a skip row
  // appended while a run is in flight does not make the run «not the
  // latest», and the re-write of an older run (its terminal row, its audit,
  // its price) never makes it «the latest» either.
  private runIndex = new Map<string, { ids: Set<string>; open: Map<string, Run> }>()
  private runsRotateBytes: number

  constructor(
    private dataDir: string,
    opts?: { runsRotateBytes?: number },
  ) {
    this.file = join(dataDir, 'automations.json')
    this.runsDir = join(dataDir, 'runs')
    this.runsRotateBytes = opts?.runsRotateBytes ?? RUNS_ROTATE_BYTES
  }

  load(): void {
    mkdirSync(this.runsDir, { recursive: true })
    if (!existsSync(this.file)) return
    const text = readFileSync(this.file, 'utf8')
    let raw: Shape
    try {
      raw = JSON.parse(text) as Shape
    } catch {
      // Corrupt JSON — never overwritten without a trace. The next write
      // (e.g. a normal tick's update()) would otherwise have rewritten the
      // whole file with automations:[] and lost the original corrupt file
      // (which might have been recoverable by hand).
      backupCorruptJson(this.file, text, 'automations-store')
      this.automations = []
      return
    }
    const list = Array.isArray(raw.automations) ? raw.automations : []
    const good: Automation[] = []
    for (const entry of list) {
      if (isValidAutomationShape(entry)) {
        good.push(entry)
      } else {
        const id = typeof (entry as { id?: unknown })?.id === 'string' ? (entry as { id: string }).id : '?'
        console.warn(`automations-store: entry discarded for invalid shape in automations.json (id=${id})`)
      }
    }
    this.automations = good
  }

  // Backs up the corrupt file BEFORE starting fresh — never overwrites an
  // existing backup (same anti-collision criterion as
  // memory-service.ts backupBeforeWrite / session-store.trash).
  list(): Automation[] {
    return [...this.automations]
  }

  get(id: string): Automation | null {
    return this.automations.find((a) => a.id === id) ?? null
  }

  create(a: Automation): Automation {
    if (this.get(a.id)) throw new Error('duplicate id')
    this.automations.push(a)
    this.save()
    return a
  }

  // IMMUTABLE merge — an earlier version used `Object.assign(a, patch)`,
  // which mutated in place the same object already living in
  // `this.automations` AND that any caller might have captured in a local
  // variable for a long stretch (the resident holds its `const a` for an
  // entire run, up to 30 min — runTimeoutMs). With shared mutation, that
  // captured `a` stops being a fixed snapshot: an owner PATCH mid-run
  // "leaks" live into decisions the resident makes later in the SAME
  // function assuming the state that held at the START (e.g. `a.keepAlive`
  // read while handling an end-of-run error, which must reflect what was
  // true when the run was decided, not whatever the owner changed in the
  // meantime). Now every update() reads the CURRENT state of the array
  // (never a caller's stale reference), builds a NEW object
  // `{...current, ...patch}`, and swaps the entry in — a caller that
  // already had a captured reference keeps its fixed snapshot intact, and
  // when that caller eventually writes its own patch (e.g.
  // safeStoreUpdate({thread})), it does so over the most recent state
  // (including any concurrent, unrelated PATCH), merging only ITS fields —
  // last-writer-wins per FIELD, never per whole object.
  update(id: string, patch: Partial<Omit<Automation, 'id'>>): Automation {
    const idx = this.automations.findIndex((a) => a.id === id)
    if (idx === -1) throw new Error('automation not found')
    const merged = { ...this.automations[idx], ...patch } as Automation
    this.automations[idx] = merged
    this.save()
    return merged
  }

  delete(id: string): void {
    const before = this.automations.length
    this.automations = this.automations.filter((a) => a.id !== id)
    if (this.automations.length === before) throw new Error('automation not found')
    this.save()
  }

  save(): void {
    atomicWriteJson(this.file, { automations: this.automations })
  }

  runsPath(automationId: string): string {
    return join(this.runsDir, `${automationId}.jsonl`)
  }

  // Rotated-out generation: a single one (.1) — disk bounded to ~2×threshold
  // per automation. History older than the .1 is dropped on purpose (it's
  // hygiene history, not a ledger).
  private rotatedRunsPath(automationId: string): string {
    return this.runsPath(automationId) + '.1'
  }

  // A run snapshot — NEVER rewrites/deletes previous lines. A new run (an
  // id never written) becomes the latest; a re-write of a run already
  // written (its terminal row, its audit, its price — runs fold by id, last
  // line wins) moves the latest only when it IS the latest. Latest = the run
  // created last (first appearance), exactly what a cold listRuns says.
  appendRun(automationId: string, run: Run): void {
    const ix = this.indexOf(automationId) // warmed BEFORE the line is written
    mkdirSync(this.runsDir, { recursive: true })
    appendFileSync(this.runsPath(automationId), JSON.stringify(run) + '\n')
    const isNew = !ix.ids.has(run.id)
    ix.ids.add(run.id)
    if (isOpenRun(run)) ix.open.set(run.id, run)
    else ix.open.delete(run.id)
    if (isNew || this.latestRunCache.get(automationId)?.id === run.id) this.latestRunCache.set(automationId, run)
  }

  private indexOf(automationId: string): { ids: Set<string>; open: Map<string, Run> } {
    const known = this.runIndex.get(automationId)
    if (known) return known
    const all = this.listRuns(automationId)
    const ix = {
      ids: new Set(all.map((r) => r.id)),
      open: new Map(
        all
          .filter(isOpenRun)
          .reverse()
          .map((r) => [r.id, r] as const),
      ),
    }
    this.runIndex.set(automationId, ix)
    if (!this.latestRunCache.has(automationId)) this.latestRunCache.set(automationId, all[0] ?? null)
    return ix
  }

  /** A run BY ITS ID (its latest snapshot), or null — what every re-write
   *  and every judgment of a run reads, never «the latest run». */
  runById(automationId: string, runId: string): Run | null {
    const open = this.indexOf(automationId).open.get(runId)
    if (open) return open
    const latest = this.latestRun(automationId)
    if (latest?.id === runId) return latest
    return this.listRuns(automationId).find((r) => r.id === runId) ?? null
  }

  /** The automation's OPEN runs (running · queued · waiting_approval), oldest
   *  first — whichever lines were appended after them. */
  openRuns(automationId: string): Run[] {
    return [...this.indexOf(automationId).open.values()]
  }

  // «One money» (Usage): a CLOSED run that never said
  // its price gets the one its transcript says — a new line for its id
  // (runs fold by id, last line wins), never over a price it said.
  // 'later' while it still runs.
  patchRunCost(automationId: string, runId: string, cost: { costUsd: number; model?: string; priced: boolean }): 'done' | 'later' | 'skip' {
    const run = this.runById(automationId, runId)
    if (!run) return 'skip'
    if (run.status === 'running' || run.status === 'queued') return 'later'
    if (typeof run.costUsd === 'number') return 'skip'
    const patched: Run = { ...run, costUsd: cost.costUsd, priced: cost.priced, ...(cost.model && !run.model ? { model: cost.model } : {}) }
    this.appendRun(automationId, patched)
    return 'done'
  }

  // Latest run snapshot for an automation, O(1) after the first query
  // (which warms the cache by reading the file once). Identical semantics
  // to listRuns(automationId, 1)[0] — the file remains the source of
  // truth, this is only a cache over it.
  latestRun(automationId: string): Run | null {
    const cached = this.latestRunCache.get(automationId)
    if (cached !== undefined) return cached
    const r = this.listRuns(automationId, 1)[0] ?? null
    this.latestRunCache.set(automationId, r)
    return r
  }

  // Runs for an automation, one per id (the last snapshot seen), ordered
  // with the most recent first (by order of FIRST appearance, which
  // matches each run's creation order). Reads BOTH generations (.1 first,
  // then current) and folds in that order — a run "straddling" the
  // rotation (a 'running' snapshot in the .1, terminal in the current one)
  // comes out as ONE with its latest state, exactly as without rotation.
  // Consumers (the UI's /runs route, runsToday, findRun, pendingApprovals,
  // a cold latestRun) never see the rotation at all.
  listRuns(automationId: string, limit?: number): Run[] {
    const byId = new Map<string, Run>()
    const order: string[] = []
    for (const path of [this.rotatedRunsPath(automationId), this.runsPath(automationId)]) {
      if (!existsSync(path)) continue
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue
        let r: Run
        try {
          r = JSON.parse(line) as Run
        } catch {
          continue
        }
        if (!byId.has(r.id)) order.push(r.id)
        byId.set(r.id, r)
      }
    }
    const out = order.map((id) => byId.get(id) as Run).reverse()
    return limit !== undefined ? out.slice(0, limit) : out
  }

  // Rotation: if an automation's current runs.jsonl exceeds the threshold,
  // current → .1 (an atomic rename on the same filesystem, NEVER
  // copy-then-truncate) after removing any preexisting .1. Returns the
  // rotated ids.
  //
  // Safe point: called from the resident heartbeat's low-priority sweep
  // (same lane as titler/prefsSweep) — the process is single-threaded and
  // appendRun is synchronous, so an append is never cut mid-write; the
  // latestRun cache isn't even touched (rotating moves history, the latest
  // run is still the latest).
  //
  // Crash invariant (documented): the only operations are rm(.1) and
  // rename(current → .1). A crash at any point leaves one of these states,
  // ALL readable by listRuns (which treats any missing file as empty): (a)
  // both generations intact; (b) .1 removed and current intact (only old
  // history pruning got ahead); (c) current already renamed to .1 with no
  // current file (the next appendRun recreates it). There is never a
  // truncated file or one with half-written lines.
  rotateRunsIfNeeded(): string[] {
    const rotated: string[] = []
    for (const id of this.automationIdsWithRuns()) {
      const path = this.runsPath(id)
      try {
        if (!existsSync(path)) continue // only the .1 remains (a crash window) — nothing to rotate
        if (statSync(path).size < this.runsRotateBytes) continue
        rmSync(this.rotatedRunsPath(id), { force: true })
        renameSync(path, this.rotatedRunsPath(id))
        rotated.push(id)
      } catch (err) {
        // best effort per file: an FS failure on one automation must not
        // stop the others from rotating or bring down the heartbeat.
        console.warn(`automations-store: runs.jsonl rotation failed for ${id}:`, err)
      }
    }
    return rotated
  }

  // TODAY's runs that spend the maxRunsPerDay budget (countsAgainstBudget).
  runsToday(automationId: string, now: Date): Run[] {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    return this.listRuns(automationId).filter((r) => {
      if (!countsAgainstBudget(r)) return false
      const t = Date.parse(r.at)
      return Number.isFinite(t) && t >= start
    })
  }

  // Automation ids with run history on disk — scans runsDir instead of
  // this.automations so findRun/pendingApprovals (and
  // Resident.reconcileStaleRuns) keep finding runs for an automation that's
  // already been deleted (its history isn't touched — a read-only
  // invariant over what already happened). Public on purpose for that case.
  // A command run's log (command-run.ts writes it, the owner's log route
  // reads it): <dataDir>/runs/<automationId>/<runId>.log, beside the runs
  // file. The ids are minted by the resident or validated by the route.
  runLogPath(automationId: string, runId: string): string {
    return join(this.runsDir, automationId, `${runId}.log`)
  }

  automationIdsWithRuns(): string[] {
    let entries: string[]
    try {
      entries = readdirSync(this.runsDir)
    } catch {
      return []
    }
    // Also counts the rotated generation (.jsonl.1): in rotation's crash
    // window (rename done, no new append yet) an automation can exist
    // ONLY as a .1 — findRun/pendingApprovals/reconcileStaleRuns must
    // still see it.
    const ids = new Set<string>()
    for (const f of entries) {
      if (f.endsWith('.jsonl')) ids.add(f.slice(0, -'.jsonl'.length))
      else if (f.endsWith('.jsonl.1')) ids.add(f.slice(0, -'.jsonl.1'.length))
    }
    return [...ids]
  }

  // Finds a run by id across ALL automations — used by approve/skip (the
  // route only carries the runId). Personal-scale volume: no index.
  findRun(runId: string): { automationId: string; run: Run } | null {
    for (const id of this.automationIdsWithRuns()) {
      const found = this.listRuns(id).find((r) => r.id === runId)
      if (found) return { automationId: id, run: found }
    }
    return null
  }

  pendingApprovals(): Run[] {
    const out: Run[] = []
    for (const id of this.automationIdsWithRuns()) {
      for (const r of this.listRuns(id)) {
        if (r.status === 'waiting_approval') out.push(r)
      }
    }
    return out
  }
}
