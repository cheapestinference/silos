// initiative.ts — what an agent creates on its own, around the ledger:
// the API path of a task's birth (append-item with
// identity), the assign gate on work that appeared outside Silos,
// the owner's blessings (Keep it — it's mine, Give, the
// baseline's Keep them all), Undo, the Keep of the
// Only-when-told sheet, the measure, the Decided list
// and the end-of-turn re-stamp + verdict. The verdict
// itself lives in plans-provenance.ts (judgeCreation): ONE source.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AutomationsStore } from './automations-store.js'
import type { Automation } from './automations-types.js'
import { counted, type Creation, type CreationsStore } from './creations.js'
import type { Cut } from './control.js'
import { heartbeatVerdict, isTainted, ownerCredentialCut, type EngineGaps, type RunAudit } from './heartbeat-audit.js'
import type { LiveTurn, SealedRegime } from './live-turns.js'
import { runOfTurn } from './live-turns.js'
import { originIsKnown, type Origin, type PlansOrigins } from './plans-origins.js'
import { cutWords, judgeCreation, judgeTurnOf, noteTainted, type PlansProvenance } from './plans-provenance.js'
import { SILOS_AUTHOR } from './system-author.js'
import { SELF_RECURRENT_MAX, SELF_RECURRENT_PER_WEEK } from './limits.js'
import { ROUND_RECURRING_PROPOSED, selfRecurrentThisWeek, type TaskNow } from './proactive.js'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const DAY_MS = 24 * 3600_000

export const UNKNOWN_ASSIGN = 'it appeared outside Silos — the owner starts it or blesses it first'
export const PROVISIONAL_OWN_ASSIGN =
  'it was created by editing the plan this turn — Silos adopts it when your turn ends; to start it now, create it with append-item'
export const NOT_OWN_DECISION = (name: string): string => `this was not ${name}'s own decision — cancel the task / delete the automation instead`
export const UNDONE_BY_OWNER = 'Undone by the owner'
export const SELF_RECURRENT_MAX_WORDS = `you already have ${SELF_RECURRENT_MAX} recurring things of your own — withdraw one first`
// the full refusal reads «signal required: "mission" (your weekly think) …»;
// the words stop there on purpose
export const SIGNAL_REQUIRED_SELF_AUTOMATION = 'signal required: "mission" (your weekly think)'
// the spec gives a proactive agent's recurring work its own
// weekly counter (SELF_RECURRENT_PER_WEEK) but no words for its 429 — these
// follow the weekly initiative's (a gap said in q3's report)
export const selfRecurrentWeekWords = (date: string): string =>
  `one recurring thing of your own a week: you created one on ${date} — do not retry in this heartbeat`

export interface InitiativeAgent {
  id: string
  name: string
  cut?: Cut | null
  archived?: boolean
}

export interface InitiativeDeps {
  creations: CreationsStore
  origins: PlansOrigins
  stamper: Pick<PlansProvenance, 'expectOrigin'>
  agent: (id: string) => InitiativeAgent | null
  agents: () => InitiativeAgent[]
  automations: Pick<AutomationsStore, 'list' | 'get' | 'delete' | 'listRuns'>
  /** <dataDir>/trash/automations */
  trashDir: string
  /** a task as the plans reading has it now (status, title, owner), or null */
  task: (key: string) => { status: string; title: string; owner: string; file?: string } | null
  /** Silos' own write on a task (SiloActions.silosWriteChild) */
  writeTask: (key: string, mutate: (child: Json | null) => { write: boolean } | string, text: string) => { ok: boolean; reason?: string }
  /** queued wakes superseded, live turns cancelled */
  stopTask: (key: string, why: string) => void
  /** an automation's live run cancelled */
  stopAutomation: (id: string) => boolean
  /** record the cut (Agent.cut) */
  cut: (agentId: string, cut: Cut) => void
  /** proposals of a run (proposals.ts), when wired */
  proposals?: {
    restampRun(agentId: string, run: string, readOutside: string[]): unknown
    dismissTainted(agentId: string, run: string): unknown
    byRun(agentId: string, run: string): unknown[]
  }
  /** the messages a run sent (messages.ts restampRun); who
   *  sent a message and its root */
  messages?: {
    restampRun(from: string, run: string, readOutside: readonly string[]): unknown
    find?(id: string): { from: string; to: string; root?: 'mission' } | null
  }
  /** the considered lines of a run, re-stamped */
  considered?: { restampRun(agentId: string, run: string, readOutside: readonly string[]): unknown }
  /** the agent's proactive mode NOW (proactiveOf — a wake or a run carries
   *  no sealed regime) */
  proactiveNow?: (agentId: string) => SealedRegime | null
  /** the task a wake serves: its key's origin → its creation's root */
  taskNow?: (key: string) => TaskNow | null
  now?: () => number
}

export type Refusal = { code: 400 | 403 | 404 | 409 | 429; error: string }

export class Initiative {
  constructor(private d: InitiativeDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now()
  }
  private iso(): string {
    return new Date(this.now()).toISOString()
  }

  /** its own recurring work alive, without acceptedFrom */
  selfRecurrentLive(agentId: string): number {
    return this.d.automations.list().filter((a) => a.agentId === agentId && a.origin === 'self' && !a.acceptedFrom).length
  }

  // ---- the API path of a task's birth -------------------------------

  /** append-item of a plan task: who creates it (the request's credential),
   *  judged by the same rules as the reader, stamped and registered BEFORE
   *  the file write (the reader then finds it known). Returns the values to
   *  write, or the refusal; `undo` drops the registration when the write
   *  itself fails. */
  prepareTask(
    actor: { owner: true } | { agentId: string; turn: LiveTurn },
    key: string,
    values: unknown,
  ): { ok: true; values: Json; undo: () => void } | ({ ok: false } & Refusal) {
    if (!isObj(values)) return { ok: false, code: 400, error: "send the task's fields as an object" }
    // what only the server stamps never comes from the body
    const { createdBy: _c, origin: _o, run: _r, ...rest } = values
    const at = this.iso()
    if ('owner' in actor) {
      const { signal: _s, ...clean } = rest
      this.d.stamper.expectOrigin(key, { by: 'owner', how: 'owner', at, ...titled(clean) })
      return { ok: true, values: { ...clean, createdBy: 'owner' }, undo: () => this.d.origins.patch(key, { by: 'unknown', how: 'unclaimed' }) }
    }
    const agent = this.d.agent(actor.agentId)
    if (!agent) return { ok: false, code: 403, error: 'agent not found' }
    const t = actor.turn
    if (!t.unattended) {
      // attended: stamped, not judged
      this.d.stamper.expectOrigin(key, { by: agent.id, how: 'attended', at, ...titled(rest) })
      return { ok: true, values: { ...rest, createdBy: agent.id }, undo: () => this.d.origins.patch(key, { by: 'unknown', how: 'unclaimed' }) }
    }
    const signal = typeof rest.signal === 'string' ? rest.signal.trim() : undefined
    const ledger = this.d.creations.list(agent.id)
    const v = judgeCreation({
      agent: { id: agent.id, name: agent.name, cut: agent.cut ?? null },
      turn: { ...judgeTurnOf(t), unattended: true },
      signal,
      ledger,
      now: this.now(),
      openTask: (ref) => {
        const x = this.d.task(ref)
        return x !== null && x.status !== 'done' && x.status !== 'cancelled'
      },
      selfRecurrentLive: this.selfRecurrentLive(agent.id),
      ...this.proactiveInputs(agent.id),
      task: { title: rest.title, owner: rest.owner, waitingOn: rest.waitingOn },
    })
    const run = runOfTurn(t)
    if (!v.ok) {
      // a refusal is no infraction: it only adds to Measures.rejected
      this.d.creations.add(agent.id, {
        kind: 'task',
        ref: key,
        title: titleOf(rest),
        createdAt: at,
        run,
        by: agent.id,
        ...(signal ? { signal } : {}),
        rejected: { at, why: v.error },
      })
      return { ok: false, code: v.code, error: v.error }
    }
    const entry = this.d.creations.add(agent.id, {
      kind: 'task',
      ref: key,
      title: titleOf(rest),
      createdAt: at,
      run,
      by: agent.id,
      ...(signal ? { signal } : {}),
      ...(v.root ? { root: v.root } : {}),
    })
    this.d.stamper.expectOrigin(key, { by: agent.id, how: 'creation', at, ...titled(rest), creation: { agent: agent.id, id: entry.id } })
    return {
      ok: true,
      values: { ...rest, createdBy: agent.id, origin: 'self', run, ...(signal ? { signal } : {}) },
      undo: () => {
        this.d.creations.update(agent.id, entry.id, { rejected: { at: this.iso(), why: 'the write failed' } })
        this.d.origins.patch(key, { by: 'unknown', how: 'unclaimed', clear: ['creation'] })
      },
    }
  }

  // ---- roots ---------------------------------------

  /** The root of a task by its key: its origin's creation (whoever owns it
   *  now — plans-origins), and that creation's root. */
  rootOfTask(key: string): 'mission' | null {
    const o = this.d.origins.get(key)
    if (!o?.creation) return null
    return this.d.creations.byRef(o.creation.agent, key)?.root === 'mission' ? 'mission' : null
  }

  /** The root of a signal: `mission`; `task:<key>` → its task's; `message:<id>`
   *  → the message's (a message sent from a mission-rooted turn carries it). */
  rootOf(signal: string): 'mission' | null {
    if (signal === 'mission') return 'mission'
    if (signal.startsWith('task:')) return this.rootOfTask(signal.slice('task:'.length))
    if (signal.startsWith('message:')) return this.d.messages?.find?.(signal.slice('message:'.length))?.root === 'mission' ? 'mission' : null
    return null
  }

  /** The root of a TURN — what a message sent from it inherits: a
   *  round or a think ⇒ mission; a look ⇒ none; a wake ⇒ its task's; a run
   *  ⇒ its automation's creation's, or none. */
  rootOfTurn(t: Pick<LiveTurn, 'agentId' | 'class' | 'kind' | 'taskKey' | 'automationId'>): 'mission' | null {
    if (t.class === 'heartbeat') return t.kind === 'round' || t.kind === 'think' ? 'mission' : null
    if (t.class === 'wake') return t.taskKey ? this.rootOfTask(t.taskKey) : null
    if (t.class === 'run' && t.automationId) {
      const c = this.d.creations.byRef(this.d.automations.get(t.automationId)?.agentId ?? t.agentId, t.automationId)
      return c?.root === 'mission' || c?.signal === 'mission' ? 'mission' : null
    }
    return null
  }

  /** What the judge reads of the proactive mode for this agent. */
  private proactiveInputs(agentId: string): {
    rootOf: (s: string) => 'mission' | null
    messageFrom: (id: string) => string | null
    proactiveNow: SealedRegime | null
    taskNow?: (key: string) => TaskNow | null
  } {
    return {
      rootOf: (sig) => this.rootOf(sig),
      messageFrom: (id) => this.d.messages?.find?.(id)?.from ?? null,
      proactiveNow: this.d.proactiveNow?.(agentId) ?? null,
      ...(this.d.taskNow ? { taskNow: this.d.taskNow } : {}),
    }
  }

  /** A note by an unattended run on another owner's task, via the API. */
  markNote(key: string, agentId: string, turn: LiveTurn, noteAt: string): void {
    this.d.origins.addMark(key, { kind: 'note', at: this.iso(), run: runOfTurn(turn), agent: agentId, noteAts: [noteAt] })
  }

  // ---- its own recurring work ------------------------------------------

  /** A bearer's create of recurring work in its weekly think: the cut, the
   *  signal, SELF_RECURRENT_MAX, then the initiative quotas through
   *  judgeCreation (an automation and a task share the ONE weekly initiative
   *  and INITIATIVES_OPEN_MAX). A refusal enters the ledger with `rejected`
   *  (Measures.rejected) — never a cut. `ref`: the id the automation
   *  would get. null: it may be created. */
  judgeAutomation(agentId: string, turn: LiveTurn, o: { signal?: string | undefined; title: string; ref: string }): Refusal | null {
    const agent = this.d.agent(agentId)
    if (!agent) return { code: 403, error: 'agent not found' }
    const signal = typeof o.signal === 'string' && o.signal.trim() !== '' ? o.signal.trim() : undefined
    // a proactive heartbeat (its SEALED regime): with
    // its tools, recurring work of its own is proposed, never created; without
    // them, its own weekly counter — never the day's count nor the open cap
    if (turn.class === 'heartbeat' && turn.regime) {
      let refusal: Refusal | null = null
      const week = selfRecurrentThisWeek(this.d.creations.list(agent.id), this.now())
      if (agent.cut) refusal = { code: 403, error: cutWords(agent.cut.at.slice(0, 10), agent.cut.why) }
      else if (turn.regime.tools) refusal = { code: 403, error: ROUND_RECURRING_PROPOSED }
      else if (signal !== 'mission') refusal = { code: 403, error: SIGNAL_REQUIRED_SELF_AUTOMATION }
      else if (this.selfRecurrentLive(agent.id) >= SELF_RECURRENT_MAX) refusal = { code: 429, error: SELF_RECURRENT_MAX_WORDS }
      else if (week.length >= SELF_RECURRENT_PER_WEEK) refusal = { code: 429, error: selfRecurrentWeekWords(week[0]!.createdAt.slice(0, 10)) }
      if (!refusal) return null
      const at = this.iso()
      this.d.creations.add(agent.id, {
        kind: 'automation',
        ref: o.ref,
        title: o.title,
        createdAt: at,
        run: runOfTurn(turn),
        by: agent.id,
        ...(signal ? { signal } : {}),
        rejected: { at, why: refusal.error },
      })
      return refusal
    }
    const v = judgeCreation({
      agent: { id: agent.id, name: agent.name, cut: agent.cut ?? null },
      turn: {
        class: turn.class,
        unattended: turn.unattended,
        ...(turn.kind ? { kind: turn.kind } : {}),
        ...(turn.packetKeys ? { packetKeys: turn.packetKeys } : {}),
      },
      signal,
      ledger: this.d.creations.list(agent.id),
      now: this.now(),
      openTask: (ref) => {
        const x = this.d.task(ref)
        return x !== null && x.status !== 'done' && x.status !== 'cancelled'
      },
      selfRecurrentLive: this.selfRecurrentLive(agent.id),
    })
    let refusal: Refusal | null = null
    if (!v.ok && (v.reason === 'cut' || v.reason === 'signal' || v.reason === 'mission-here')) {
      refusal = { code: v.code, error: v.reason === 'signal' && signal === undefined ? SIGNAL_REQUIRED_SELF_AUTOMATION : v.error }
    } else if (this.selfRecurrentLive(agent.id) >= SELF_RECURRENT_MAX) {
      refusal = { code: 429, error: SELF_RECURRENT_MAX_WORDS }
    } else if (!v.ok) {
      refusal = { code: v.code, error: v.error }
    }
    if (!refusal) return null
    const at = this.iso()
    this.d.creations.add(agent.id, {
      kind: 'automation',
      ref: o.ref,
      title: o.title,
      createdAt: at,
      run: runOfTurn(turn),
      by: agent.id,
      ...(signal ? { signal } : {}),
      rejected: { at, why: refusal.error },
    })
    return refusal
  }

  /** The ledger entry of recurring work it created. */
  recordAutomation(agentId: string, a: Pick<Automation, 'id' | 'name' | 'createdAt' | 'signal'>, turn: LiveTurn): Creation {
    return this.d.creations.add(agentId, {
      kind: 'automation',
      ref: a.id,
      title: a.name,
      createdAt: a.createdAt,
      run: runOfTurn(turn),
      by: agentId,
      ...(a.signal ? { signal: a.signal } : {}),
      ...(a.signal === 'mission' ? { root: 'mission' as const } : {}),
    })
  }

  /** A lone act of the bearer on its own recurring work — «X paused: <name>»,
   *  «X withdrew: <name>»: Decided says it. */
  recordAct(agentId: string, a: Pick<Automation, 'id' | 'name'>, action: 'paused' | 'withdrew', turn: LiveTurn): Creation {
    return this.d.creations.add(agentId, { kind: 'automation', ref: a.id, title: a.name, createdAt: this.iso(), run: runOfTurn(turn), by: agentId, action })
  }

  /** DELETE by its creator: to the trash, registered as withdrawn. */
  withdraw(a: Automation, turn: LiveTurn): void {
    this.trash(a)
    this.recordAct(a.agentId, a, 'withdrew', turn)
  }

  // ---- assign gate ------------------------------------------------------

  /** A bearer's assign on its own task: what appeared outside Silos is no
   *  order. A provisional attribution to the caller's OWN turn says
   *  that truth. null: no refusal. */
  assignRefusal(key: string, turn: LiveTurn | null): Refusal | null {
    const o = this.d.origins.get(key)
    if (originIsKnown(o)) return null
    if (o?.provisional && turn && o.provisional.candidates.some((c) => c.agentId === turn.agentId && c.turnId === turn.turnId))
      return { code: 409, error: PROVISIONAL_OWN_ASSIGN }
    return { code: 409, error: UNKNOWN_ASSIGN }
  }

  // ---- the owner's blessings ---------------------------

  /** «Keep it — it's mine», or the owner's Give/assign: an unknown ref
   *  becomes the owner's. Opening never calls this. */
  bless(key: string, how: 'keep' | 'give'): boolean {
    const o = this.d.origins.get(key)
    if (originIsKnown(o)) return false
    const t = this.d.task(key)
    this.d.origins.set(key, {
      by: 'owner',
      how,
      at: this.iso(),
      ...(t?.file ? { file: t.file } : {}),
      ...(t ? { title: t.title } : o?.title ? { title: o.title } : {}),
    })
    return true
  }

  /** what `hand` reads of a task's origin: known,
   *  unknown (added outside Silos), or provisional (a turn that may have
   *  added it still runs — its adoption would overwrite a blessing). */
  originState(key: string): 'known' | 'unknown' | 'provisional' {
    const o = this.d.origins.get(key)
    if (o?.provisional) return 'provisional'
    return originIsKnown(o) ? 'known' : 'unknown'
  }

  /** (K13) the owner handed the task to another: the creation it came from
   *  stops counting in its creator's open tasks. */
  handed(key: string): void {
    const o = this.d.origins.get(key)
    if (!o?.creation) return
    const c = this.d.creations.byRef(o.creation.agent, key)
    if (c && !c.handedAt) this.d.creations.update(o.creation.agent, c.id, { handedAt: this.iso() })
  }

  /** The baseline's block door: one row per folder. */
  baseline(): Array<{ folder: string; tasks: Array<{ key: string; title: string }> }> {
    const by = new Map<string, Array<{ key: string; title: string }>>()
    for (const [key, o] of Object.entries(this.d.origins.all())) {
      if (o.by !== 'unknown' || o.how !== 'baseline') continue
      const t = this.d.task(key)
      if (!t || t.status === 'done' || t.status === 'cancelled') continue
      const folder = folderOfPlan(o.file ?? t.file ?? '')
      by.set(folder, [...(by.get(folder) ?? []), { key, title: t.title }])
    }
    return [...by].map(([folder, tasks]) => ({ folder, tasks }))
  }

  /** The agent's open tasks nobody can be shown to have created:
   *  its page says them in one line, each a door to the task — where
   *  «Keep it — it's mine» is (opening never blesses). Baseline or not. */
  outsideOf(agentId: string): Array<{ key: string; title: string }> {
    const out: Array<{ key: string; title: string }> = []
    for (const [key, o] of Object.entries(this.d.origins.all())) {
      if (o.by !== 'unknown') continue
      const t = this.d.task(key)
      if (!t || t.owner !== agentId || t.status === 'done' || t.status === 'cancelled') continue
      out.push({ key, title: t.title })
    }
    return out
  }

  keepAll(folder: string, exclude: readonly string[] = []): number {
    const skip = new Set(exclude)
    const entries: Array<[string, Origin]> = []
    for (const row of this.baseline()) {
      if (row.folder !== folder) continue
      for (const t of row.tasks)
        if (!skip.has(t.key))
          entries.push([t.key, { ...(this.d.origins.get(t.key) ?? { at: this.iso() }), by: 'owner', how: 'keep-all', at: this.iso() } as Origin])
    }
    this.d.origins.setMany(entries)
    return entries.length
  }

  // ---- Undo --------------------------------------------------------------

  undo(q: { task?: string; automation?: string }, by = 'owner'): { ok: true; undone: 'task' | 'automation'; stopped: boolean } | ({ ok: false } & Refusal) {
    const at = this.iso()
    if (q.task) {
      const o = this.d.origins.get(q.task)
      const t = this.d.task(q.task)
      if (!t && !o) return { ok: false, code: 404, error: 'no such creation' }
      if (!o?.creation) return { ok: false, code: 409, error: NOT_OWN_DECISION(this.nameOf(o?.by ?? '')) }
      const c = this.d.creations.byRef(o.creation.agent, q.task)
      if (!c) return { ok: false, code: 404, error: 'no such creation' }
      const w = this.d.writeTask(
        q.task,
        (child) => {
          if (!child) return { write: false }
          child.status = 'cancelled'
          child.notes = [...(Array.isArray(child.notes) ? child.notes : []), { at, by: SILOS_AUTHOR, text: UNDONE_BY_OWNER }]
          return { write: true }
        },
        UNDONE_BY_OWNER,
      )
      if (!w.ok) return { ok: false, code: 409, error: w.reason ?? 'the task could not be written' }
      this.d.creations.update(c.by, c.id, { undoneAt: at, undoneBy: by })
      this.d.stopTask(q.task, UNDONE_BY_OWNER)
      return { ok: true, undone: 'task', stopped: true }
    }
    if (q.automation) {
      const a = this.d.automations.get(q.automation)
      if (!a) return { ok: false, code: 404, error: 'no such creation' }
      if (a.origin !== 'self') return { ok: false, code: 409, error: NOT_OWN_DECISION(this.nameOf(a.agentId)) }
      const stopped = this.d.stopAutomation(a.id)
      this.trash(a)
      const c = this.d.creations.byRef(a.agentId, a.id)
      if (c) this.d.creations.update(a.agentId, c.id, { undoneAt: at, undoneBy: by })
      return { ok: true, undone: 'automation', stopped }
    }
    return { ok: false, code: 400, error: 'send {task} or {automation}' }
  }

  /** An automation to ~/.silos/trash/automations/<id>.json. */
  trash(a: Automation): void {
    mkdirSync(this.d.trashDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(this.d.trashDir, `${a.id}.json`), `${JSON.stringify(a, null, 2)}\n`, { mode: 0o600 })
    try {
      this.d.automations.delete(a.id)
    } catch {
      /* already gone */
    }
  }

  /** «Restore ›» of a withdrawal: the trashed automation, or null. */
  trashed(id: string): Automation | null {
    const f = join(this.d.trashDir, `${id}.json`)
    if (!/^[A-Za-z0-9_-]+$/.test(id) || !existsSync(f)) return null
    try {
      return JSON.parse(readFileSync(f, 'utf8')) as Automation
    } catch {
      return null
    }
  }

  // ---- Keep ---------------------------------------------------------------

  /** «Keep (it runs under Only when told)»: a gesture of the owner stamped
   *  on the ledger entry — never an acceptedFrom (it does not approve a
   *  rhythm, nor take it out of the ceiling). */
  keep(automationId: string): boolean {
    const a = this.d.automations.get(automationId)
    if (!a || a.origin !== 'self') return false
    const c = this.d.creations.byRef(a.agentId, a.id)
    if (!c) return false
    this.d.creations.update(a.agentId, c.id, { keptAt: this.iso() })
    return true
  }

  // ---- the measure and Decided -----------------------------------

  measures(agentId: string): Measures {
    const now = this.now()
    const since = now - 30 * DAY_MS
    const all = this.d.creations.list(agentId).filter((c) => !c.action && (Date.parse(c.createdAt) || 0) >= since)
    const m: Measures = { initiatives: { created: 0, kept: 0, undone: 0 }, reactive: { created: 0, kept: 0, undone: 0 }, rejected: 0, tainted: 0 }
    for (const c of all) {
      if (c.rejected && !c.adopted) {
        m.rejected++
        if (c.readOutside && c.readOutside.length > 0) m.tainted++
        continue
      }
      if (!counted(c)) continue
      const bucket = c.signal === 'mission' ? m.initiatives : m.reactive
      bucket.created++
      if (c.undoneAt) {
        bucket.undone++
        continue
      }
      if (this.kept(c, now)) bucket.kept++
    }
    return m
  }

  /** Kept (the honest word): a task done and not undone in 14 d; a recurring
   *  one with ≥ 1 ok run that produced, alive and not undone 14 d. */
  private kept(c: Creation, now: number): boolean {
    if (now - (Date.parse(c.createdAt) || 0) < 14 * DAY_MS) return false
    if (c.kind === 'task') return this.d.task(c.ref)?.status === 'done'
    const a = this.d.automations.get(c.ref)
    return !!a && this.d.automations.listRuns(a.id).some((r) => r.status === 'ok' && r.produced === true)
  }

  /** What a run created, by its ledger (the run's own record carries no
   *  list): the titles of its creations that came to exist — what the
   *  heartbeat row counts («Made its round 14:22 — decided 2 things ›»). */
  createdOfRun(agentId: string, run: string): string[] {
    return this.d.creations
      .byRun(agentId, run)
      .filter((c) => !c.rejected && !c.action)
      .map((c) => c.title)
  }

  /** What it decided on its own, newest first (≤ limit): initiatives and
   *  recurring work lead; the reactive tail is counted apart. */
  decided(agentId: string, limit = 10): { items: Creation[]; reactive: number } {
    const all = this.d.creations
      .list(agentId)
      .filter((c) => this.shown(c))
      .reverse()
    const lead = all.filter((c) => c.action || c.kind === 'automation' || c.signal === 'mission')
    const reactive = all.length - lead.length
    return { items: lead.slice(0, limit), reactive }
  }

  /** Home's «Since …»: what every agent decided alone since the
   *  owner's last visit — creations and lone acts alike (R10), newest first,
   *  the same rows the agent page shows with their Undo / Restore / Unpause. */
  decidedSince(from: number): Creation[] {
    return this.d
      .agents()
      .filter((a) => !a.archived)
      .flatMap((a) => this.d.creations.list(a.id).filter((c) => this.shown(c) && (Date.parse(c.createdAt) || 0) >= from))
      .sort((x, y) => (Date.parse(y.createdAt) || 0) - (Date.parse(x.createdAt) || 0))
  }

  /** A ledger entry still worth its row: a creation not undone; a lone act
   *  only while it still holds — a withdrawal while the
   *  automation is gone (Restore brings it back), a pause while it is paused
   *  (Unpause is the owner's) — so a row never offers a door already used. */
  private shown(c: Creation): boolean {
    if (c.undoneAt) return false
    if (c.action === 'withdrew') return !this.d.automations.get(c.ref)
    if (c.action === 'paused') return this.d.automations.get(c.ref)?.paused === true
    return counted(c)
  }

  // ---- the end of a turn -------------------------------------------------

  /** Re-stamp the run's creations and proposals with the final readOutside;
   *  a TAINTED heartbeat undoes what it created, dismisses what it
   *  proposed, and is cut only when it created or proposed — never for an
   *  engine gap alone. The owner's credential used cuts in any
   *  unattended turn. Returns the cut written, or null. */
  afterAudit(agentId: string, run: string, audit: RunAudit, o: { heartbeat: boolean; gaps: EngineGaps; tools?: boolean }): Cut | null {
    const readOutside = audit.readOutside
    if (readOutside.length > 0) {
      this.d.creations.restampRun(agentId, run, readOutside)
      // a heartbeat's considered lines too: they come
      // back into future prompts with their mark
      if (o.heartbeat) {
        try {
          this.d.considered?.restampRun(agentId, run, readOutside)
        } catch (err) {
          console.warn(`initiative: re-stamping the considered lines of ${run} failed —`, err instanceof Error ? err.message : err)
        }
      }
      // the notes it left on others' tasks and the questions it asked
      this.d.origins.restampMarks(agentId, run, readOutside)
      try {
        this.d.proposals?.restampRun(agentId, run, readOutside)
      } catch {
        /* proposals unreadable: their row says it later */
      }
      // the messages it sent to colleagues: the same relay — their
      // line in the recipient's briefing, packet and 24 h row says it
      try {
        this.d.messages?.restampRun(agentId, run, readOutside)
      } catch (err) {
        console.warn(`initiative: re-stamping the messages of ${run} failed —`, err instanceof Error ? err.message : err)
      }
    }
    const created = this.d.creations.byRun(agentId, run).filter((c) => !c.rejected)
    const proposed = (() => {
      try {
        return this.d.proposals?.byRun(agentId, run) ?? []
      } catch {
        return []
      }
    })()
    const at = this.iso()
    let why = ownerCredentialCut(audit)
    // a heartbeat SEALED with its tools is audited like a wake or a run:
    // marked, never undone nor cut for reading
    // outside — the owner's credential still cuts in both regimes
    if (o.heartbeat && o.tools !== true && isTainted(audit)) {
      const v = heartbeatVerdict(audit, { createdOrProposed: created.length > 0 || proposed.length > 0, gaps: o.gaps })
      if (v.undo) {
        for (const c of created) this.undoTainted(c, readOutside, at)
        try {
          this.d.proposals?.dismissTainted(agentId, run)
        } catch {
          /* said on its row */
        }
      }
      if (!why && v.cut) why = v.why
    }
    if (!why) return null
    const cut: Cut = { at, why, run }
    this.d.cut(agentId, cut)
    return cut
  }

  private undoTainted(c: Creation, readOutside: string[], at: string): void {
    const note = noteTainted(readOutside)
    if (c.kind === 'task') {
      this.d.writeTask(
        c.ref,
        (child) => {
          if (!child) return { write: false }
          child.status = 'cancelled'
          child.notes = [...(Array.isArray(child.notes) ? child.notes : []), { at, by: SILOS_AUTHOR, text: note }]
          return { write: true }
        },
        note,
      )
      this.d.stopTask(c.ref, note)
    } else {
      const a = this.d.automations.get(c.ref)
      if (a) {
        this.d.stopAutomation(a.id)
        this.trash(a)
      }
    }
    this.d.creations.update(c.by, c.id, { rejected: { at, why: note } })
  }

  private nameOf(id: string): string {
    if (id === 'owner') return 'the owner'
    return this.d.agent(id)?.name ?? id
  }
}

export interface Measures {
  initiatives: { created: number; kept: number; undone: number }
  reactive: { created: number; kept: number; undone: number }
  rejected: number
  tainted: number
}

function titleOf(v: Json): string {
  return typeof v.title === 'string' ? v.title : ''
}
function titled(v: Json): { title?: string } {
  return typeof v.title === 'string' ? { title: v.title } : {}
}
/** The project folder of a plan file (<folder>/plans/x.plan.json). */
export function folderOfPlan(file: string): string {
  const i = file.lastIndexOf('/plans/')
  return i > 0 ? file.slice(0, i) : file
}

// The one Initiative of the server, set once by index.ts at boot — the
// routes that judge a birth or an assign (silos record/append, tasks/assign)
// read it here, like the other boxes the server wires after construction.
let current: Initiative | null = null
export function setInitiative(i: Initiative | null): void {
  current = i
}
export function initiativeNow(): Initiative | null {
  return current
}
