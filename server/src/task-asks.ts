// task-asks.ts — agent ↔ agent, ONE fact per task. Two fixed decisions of the owner: the
// REQUEST never wakes the other agent, the ANSWER wakes the one who waits.
//
// For WORK nothing is built here (B2.0): «I need Y to do X» is a task of Y
// and a dependsOn, inside one plan file — creating it wakes nobody, its
// `done` wakes the one waiting (`unblocked`). This is for QUESTIONS and
// REVIEWS — what is not a task of Y:
//
//   ask      POST /api/tasks/ask (the bearer of the task's owner): stores in
//            Task mode's store `armed[key] = {to, action, asked, at}` and
//            writes the plain wait of today, no id in the file — waitingOn
//            {owner: to, action, asked} + blocked (in_review for a review) —
//            as a write of Silos the stamper expects (H4 ownWrite). Every
//            judgement is made INSIDE the write's mutator, on the file read
//            now (no await between judging and writing).
//   answer   POST /api/tasks/ask/answer (the bearer of `to`): judged inside
//            the mutator on the file read now — the task open, its wait
//            LINKED to the fact (task-flow.ts askLinked) — then ONE write:
//            the note `by: to`, the wait out, the state (in_review → pending;
//            blocked → pending when nothing else holds it). Only when it
//            landed does ONE store update consume the fact and queue the
//            `answered` wake for a bound owner, the answer's text in
//            wake.notes (H1). A write that fails keeps the fact; `to` tries
//            again. Answering twice: no fact — 409.
//   hop      the escalation's agent hop arms the same fact (H10): asked '',
//            Silos' own `unstick <ref>` action; its answer is `answer` and
//            closes the case.
//
// «Linked» is never stored: every reader derives it (B2.3). A fact goes
// only when answered, replaced by the task's next ask, or by age — never
// because the file's wait stopped matching (H2: a wait that does not match is
// simply read as the owner's relay).
import type { TaskModeStore, Wake } from './task-mode/store.js'
import type { TaskSnap } from './task-mode/evaluate.js'
import { askLinked, askReaches, blockedHolds, isSilosWait, SILOS_WAIT_PREFIX } from './silos/task-flow.js'
import { localDay } from './task-mode/engine.js'
import { runOfTurn, type LiveTurn } from './live-turns.js'
import { ANSWERS_PER_TASK_DAY, ANSWERS_WINDOW_MS, ASK_ACTION_MAX, ASK_ANSWER_MAX, ASK_ASKED_MAX, ASKS_PER_DAY } from './limits.js'
import { nextSlot, type Period } from './period.js'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const CLOSED = new Set(['done', 'cancelled'])
const clip = (s: string, n: number): string => (Array.from(s).length > n ? Array.from(s).slice(0, n).join('').trimEnd() : s)

// (B2.5, H8) when the asked agent sees an ask armed at `atMs` by itself: its
// next heartbeat counted FROM the ask (nextSlot — never from now, so it does
// not flicker) — null when Task mode does not wake it on its tasks, it is
// archived or Only when told, it has no period, or it sleeps past that beat
export function askSeenByOf(
  a: { archived: boolean; bound: boolean; own: boolean; period: Period | null; sleepUntil?: string | null } | null,
  atMs: number,
): number | null {
  if (!a || Number.isNaN(atMs) || a.archived || !a.bound || !a.own || !a.period) return null
  const next = nextSlot(a.period, atMs)
  if (next === null) return null
  if (a.sleepUntil && Date.parse(a.sleepUntil) > next) return null
  return next
}

export type AskResult<T> = { ok: true; value: T } | { ok: false; code: number; error: string }

export interface TaskAsksDeps {
  store: TaskModeStore
  // the tasks as Task mode reads them now (taskMode.tasks)
  tasks(): readonly TaskSnap[]
  // Silos' own write of one task as the file holds it (SiloActions
  // silosWriteChild on the Plans silo): `mutate` gets the raw task (null:
  // gone) and its list, returns {write} or a refusal in words
  write(
    key: string,
    mutate: (child: Json | null, list: unknown[]) => { write: boolean } | string,
    text: string,
  ): { ok: true } | { ok: false; code: number; reason: string }
  // an agent (archived included) · an agent in play
  isAgent(id: string): boolean
  inPlay(id: string): boolean
  nameOf(id: string): string
  // the project boundary (project-scope.ts): an ask is about a task, so its
  // `to` is an agent of the task's project — and the asks shown to an agent
  // are those of its projects. Absent: no bound (a test's choice)
  ofProject?(id: string, folder: string | null): boolean
  // may `reader` see `id` named (project-scope.ts mayName)? No: the id
  // stays as written, never a name. Absent: everyone is named
  mayName?(reader: string, id: string): boolean
  // Task mode wakes this agent on its tasks (the answered wake's owner)
  bound(id: string): boolean
  // (H8) when `to`'s next heartbeat falls counted from `atMs`, or null
  seenBy(to: string, atMs: number): number | null
  // (H4) the stamper's ownWrite — registered inside the mutator; the undo it
  // returns is called when the write did not land
  ownWrite?(key: string, shape: Json): () => void
  // (H6) an ask armed from an unattended turn carries the existing `ask`
  // mark (plans-origins.ts) — `at` is the fact's own
  markAsk?(key: string, agentId: string, turn: LiveTurn, at: string): void
  // (B2.2, H4) an answer from an unattended turn marks its note (initiative.ts markNote)
  markNote?(key: string, agentId: string, turn: LiveTurn, noteAt: string): void
  // the readOutside of the `ask` mark the fact's arming left, or null
  askReadOutside?(key: string, agentId: string, at: string): string[] | null
  // Task mode looks (and delivers) after a write
  look?(): void
  now?(): number
}

// what an ask's answer says to the one who asked (the 200)
export interface Armed {
  key: string
  ref: string
  to: string
  toName: string
  action: string
  asked: string
  at: string
  state: string
  // `beat`: `to` sees it at its next heartbeat (seenBy) — `relay`: the owner relays it (why)
  sees: 'beat' | 'relay'
  seenBy: string | null
  says: string
  already: boolean
}
export interface Answered {
  key: string
  ref: string
  state: string
  woke: boolean
  says: string
}
// one ask as `to` is shown it (its start briefing, its heartbeat packet,
// GET /api/agents/<self>/asks): linked and open, the text from the store
export interface AskLine {
  key: string
  ref: string
  title: string
  from: string
  fromName: string
  action: string
  asked: string
  at: string
  silos: boolean
  readOutside?: string[]
}

// the words the routes and the briefings share (B2.11)
export const ASK_ANSWER_RECIPE = 'POST /api/tasks/ask/answer {"key":"<key>","text":"<your answer>","turn":"$SILOS_TURN"}'
export const OWNER_ASKS_WORDS =
  'asking another agent is an agent\'s gesture — you answer a task\'s wait with Answer on its page (POST /api/tasks/act {verb: "answer"})'
export const OWNER_ANSWERS_WORDS =
  'an ask is answered by the agent it asks — you answer a task\'s wait with Answer on its page (POST /api/tasks/act {verb: "answer"})'

export class TaskAsks {
  private now: () => number
  constructor(private d: TaskAsksDeps) {
    this.now = d.now ?? Date.now
  }

  private task(key: string): TaskSnap | undefined {
    return this.d.tasks().find((t) => t.key === key)
  }
  private mayName(reader: string, id: string): boolean {
    return this.d.mayName ? this.d.mayName(reader, id) : true
  }
  private nameFor(reader: string, id: string): string {
    return this.mayName(reader, id) ? this.d.nameOf(id) : id
  }
  private ofProject(id: string, folder: string | null): boolean {
    return this.d.ofProject ? this.d.ofProject(id, folder) : true
  }
  // «message its owner (POST …)» only when the reader may reach that owner
  private messageOwner(reader: string, owner: string): string {
    return owner !== '' && owner !== 'owner' && this.mayName(reader, owner)
      ? `message its owner instead: POST /api/agents/${owner}/messages`
      : 'ask the owner instead (waitingOn {owner: "owner", action, asked})'
  }

  // the (H9) round trips: `answered` wakes of `to` on this task DELIVERED in
  // the last ANSWERS_WINDOW_MS
  answersToday(key: string, to: string, now = this.now()): number {
    return this.d.store
      .wakesOf(key)
      .filter(
        (w) =>
          w.reason === 'answered' &&
          w.answeredBy === to &&
          w.state === 'delivered' &&
          w.deliveredAt !== undefined &&
          now - Date.parse(w.deliveredAt) < ANSWERS_WINDOW_MS,
      ).length
  }

  private reach(to: string, at: string): { sees: 'beat' | 'relay'; seenBy: number | null } {
    const ms = Date.parse(at)
    let seenBy: number | null = null
    try {
      seenBy = Number.isNaN(ms) ? null : this.d.seenBy(to, ms)
    } catch {
      seenBy = null
    }
    return { sees: askReaches({ at, seenBy }, this.now()) ? 'beat' : 'relay', seenBy }
  }

  // ── POST /api/tasks/ask ──
  ask(i: { agentId: string; turn: LiveTurn | null; key: string; to: unknown; action: unknown; asked?: unknown; review?: unknown }): AskResult<Armed> {
    const now = this.now()
    const t = this.task(i.key)
    if (!t) return { ok: false, code: 404, error: 'no such task in the plans Silos reads' }
    if (t.owner !== i.agentId)
      return {
        ok: false,
        code: 403,
        error: `${t.ref} is ${this.nameFor(i.agentId, t.owner) || 'nobody'}'s task, not yours — only a task's owner asks on it (${this.messageOwner(i.agentId, t.owner)})`,
      }
    if (!isStr(i.to) || i.to.trim() === '') return { ok: false, code: 400, error: 'send {to}: the id of the agent you ask' }
    if (!isStr(i.action) || i.action.trim() === '')
      return { ok: false, code: 400, error: 'send {action}: what you wait on it for, in a few words («review the draft», «answer the pricing question»)' }
    if (i.asked !== undefined && i.asked !== null && !isStr(i.asked))
      return { ok: false, code: 400, error: 'asked must be your question, as text — or omit it' }
    if (i.review !== undefined && typeof i.review !== 'boolean') return { ok: false, code: 400, error: 'review must be true or false' }
    const to = i.to.trim()
    // the bounded strings: exactly what the fact keeps is what the file gets (H5)
    const action = clip(i.action.trim(), ASK_ACTION_MAX)
    const asked = clip(isStr(i.asked) ? i.asked.trim() : '', ASK_ASKED_MAX)
    const review = i.review === true
    const toName = this.nameFor(i.agentId, to)
    if (to === i.agentId)
      return { ok: false, code: 409, error: 'you can\'t ask yourself — write a note, or ask the owner (waitingOn {owner: "owner", action, asked})' }
    if (to === 'owner')
      return {
        ok: false,
        code: 409,
        error: 'the owner is asked in the file: write waitingOn {owner: "owner", action, asked} on your task — POST /api/tasks/ask is for another agent',
      }
    // an ask is about a task: `to` is an agent of the task's project — any
    // other id (another project's agent, a typo, an archived one) gets the
    // one answer, the same words (project-scope.ts: existence is not confirmed)
    if (!this.d.inPlay(to) || !this.ofProject(to, t.folder))
      return { ok: false, code: 409, error: `${to} is not an agent in play — ask the owner instead (waitingOn {owner: "owner", action, asked})` }
    if (action.startsWith(SILOS_WAIT_PREFIX))
      return { ok: false, code: 409, error: `an action starting «${SILOS_WAIT_PREFIX.trim()}» is Silos' own wait — say what you wait on in other words` }
    const n = this.answersToday(t.key, to, now)
    if (n >= ANSWERS_PER_TASK_DAY)
      return {
        ok: false,
        code: 409,
        error: `asked ${n} times today on this task — ${toName} answered ${n} times in 24 h; ask the owner instead (waitingOn {owner: "owner", action, asked})`,
      }
    const fact = this.d.store.armedOf(t.key)
    const iso = new Date(now).toISOString()
    const day = localDay(now)
    // what the mutator decided (an object: a callback's writes are not narrowed)
    const out: { code: number; repeat: boolean; keepAt: string | null; state: string; undo: (() => void) | null } = {
      code: 409,
      repeat: false,
      keepAt: null,
      state: '',
      undo: null,
    }
    const w = this.d.write(
      t.key,
      (child, list) => {
        if (!child) return 'the task is no longer in the file'
        const state = isStr(child.status) ? child.status : ''
        if (CLOSED.has(state)) return `${t.ref} is ${state === 'cancelled' ? 'dropped' : state} — more work on it is a new task`
        if ((isStr(child.owner) ? child.owner.trim() : '') !== i.agentId) {
          out.code = 403
          return `${t.ref} is no longer yours — only a task's owner asks on it`
        }
        const wait = child.waitingOn
        const linkedNow = fact !== null && askLinked(fact, wait)
        const same = askLinked({ to, action, asked }, wait)
        // it waits on someone already — anything but this very ask, or its own
        // ask still linked (re-arming over it replaces it, H5)
        if (isObj(wait) && isStr(wait.owner) && wait.owner.trim() !== '' && !same && !linkedNow) {
          const who = wait.owner.trim() === 'owner' ? 'the owner' : this.nameFor(i.agentId, wait.owner.trim())
          const what = isStr(wait.action) && wait.action.trim() !== '' ? ` (${wait.action.trim()})` : ''
          return `${t.ref} waits on ${who} already${what} — one wait at a time: clear that one first (remove waitingOn from your task), then ask`
        }
        const deps = Array.isArray(child.dependsOn) ? child.dependsOn.filter(isStr) : []
        const stateOf = (d: string): string | undefined => {
          const x = list.filter(isObj).find((y) => y.id === d)
          return x && isStr(x.status) ? x.status : undefined
        }
        const openDeps = deps.filter((d) => stateOf(d) !== 'done')
        if (review && openDeps.length > 0)
          return `a review waits on nothing else — ${openDeps.join(', ')} ${openDeps.length === 1 ? 'is' : 'are'} still open: finish ${openDeps.length === 1 ? 'it' : 'them'} first, then ask for the review`
        const next = review ? 'in_review' : 'blocked'
        out.state = next
        // the same ask again, linked and in that state: nothing to write, nothing
        // re-armed — `at` is NOT renewed (N9: a repeat never hides the relay)
        if (same && linkedNow && state === next) {
          out.repeat = true
          out.keepAt = fact!.at
          return { write: false }
        }
        // re-arming over its own linked wait keeps the moment it first asked (H5)
        if (linkedNow) out.keepAt = fact!.at
        if (this.d.store.armsToday(i.agentId, day) >= ASKS_PER_DAY)
          return `you armed ${ASKS_PER_DAY} asks today — your max; ask the owner instead (waitingOn {owner: "owner", action, asked}), or wait for tomorrow`
        child.waitingOn = { owner: to, action, ...(asked !== '' ? { asked } : {}) }
        child.status = next
        out.undo = this.d.ownWrite?.(t.key, child) ?? null
        return { write: true }
      },
      `${this.d.nameOf(i.agentId)} asked ${toName} through Silos: ${action}`,
    )
    if (!w.ok) {
      out.undo?.()
      return { ok: false, code: w.code === 409 ? out.code : w.code, error: w.reason }
    }
    const at = out.keepAt ?? iso
    if (!out.repeat) {
      this.d.store.update((s) => {
        s.armed[t.key] = { to, action, asked, at, by: i.agentId }
        const b = s.armsToday[i.agentId]
        s.armsToday[i.agentId] = b && b.day === day ? { day, used: b.used + 1 } : { day, used: 1 }
      }, now)
      if (i.turn?.unattended) {
        try {
          this.d.markAsk?.(t.key, i.agentId, i.turn, at)
        } catch {
          /* the ask stands; its mark is lost */
        }
      }
      try {
        this.d.look?.()
      } catch {
        /* the tick looks again */
      }
    }
    const r = this.reach(to, at)
    const wakes = this.d.bound(i.agentId)
    const seenBy = r.seenBy !== null ? new Date(r.seenBy).toISOString() : null
    const says =
      r.sees === 'beat'
        ? `${toName} sees it at its next heartbeat (${seenBy}) — the request wakes nobody; its answer lands on ${t.ref}${wakes ? ' and wakes you' : ''}`
        : `${toName} has no heartbeat within a day of it — the owner relays it (Needs you says so); its answer lands on ${t.ref}${wakes ? ' and wakes you' : ''}`
    return { ok: true, value: { key: t.key, ref: t.ref, to, toName, action, asked, at, state: out.state, sees: r.sees, seenBy, says, already: out.repeat } }
  }

  // ── POST /api/tasks/ask/answer ──
  answer(i: { agentId: string; turn: LiveTurn | null; key: string; text: unknown }): AskResult<Answered> {
    const now = this.now()
    const t = this.task(i.key)
    if (!t) return { ok: false, code: 404, error: 'no such task in the plans Silos reads' }
    const fact = this.d.store.armedOf(t.key)
    if (!fact)
      return { ok: false, code: 409, error: `nothing asks you on ${t.ref} now — it was answered already, or its owner asked again or cleared the wait` }
    if (fact.to !== i.agentId)
      return {
        ok: false,
        code: 403,
        error: `${t.ref} asks ${this.nameFor(i.agentId, fact.to)}, not you — leave a note on it, or ${this.messageOwner(i.agentId, t.owner)}`,
      }
    if (!isStr(i.text) || i.text.trim() === '') return { ok: false, code: 400, error: 'send {text}: your answer — «not mine, ask the owner» is an answer too' }
    const text = clip(i.text.trim(), ASK_ANSWER_MAX)
    const iso = new Date(now).toISOString()
    const out: { state: string; undo: (() => void) | null } = { state: '', undo: null }
    const w = this.d.write(
      t.key,
      (child, list) => {
        if (!child) return 'the task is no longer in the file'
        const state = isStr(child.status) ? child.status : ''
        if (CLOSED.has(state))
          return `${t.ref} is ${state === 'cancelled' ? 'dropped' : state} already — your answer was not written; a note is still yours to leave`
        // linked NOW, on the file read now (H1): otherwise the wait is someone
        // else's to clear — its owner changed it, or the owner answered first
        if (!askLinked(fact, child.waitingOn))
          return `${t.ref} no longer waits on you through Silos — its wait changed (its owner, or the owner, answered or cleared it); leave a note if it still matters`
        const notes = Array.isArray(child.notes) ? child.notes : []
        child.notes = [...notes, { at: iso, by: i.agentId, text }]
        delete child.waitingOn
        const deps = Array.isArray(child.dependsOn) ? child.dependsOn.filter(isStr) : []
        const stateOf = (d: string): string | undefined => {
          const x = list.filter(isObj).find((y) => y.id === d)
          return x && isStr(x.status) ? x.status : undefined
        }
        const check = isStr(child.nextCheckAt) && child.nextCheckAt !== '' ? child.nextCheckAt : null
        if (state === 'in_review') child.status = 'pending'
        else if (state === 'blocked' && blockedHolds({ deps, stateOf, wait: null, nextCheckAt: check, now }).length === 0) child.status = 'pending'
        out.state = isStr(child.status) ? child.status : state
        out.undo = this.d.ownWrite?.(t.key, child) ?? null
        return { write: true }
      },
      `${this.d.nameOf(i.agentId)} answered through Silos`,
    )
    // the write did not land: the fact stays, the answer is the caller's to send again (H1)
    if (!w.ok) {
      out.undo?.()
      return { ok: false, code: w.code, error: w.reason }
    }
    const owner = t.owner
    // (R3) an owner that does not work in the task's project is never woken on it
    const woke = owner !== '' && this.d.isAgent(owner) && this.d.bound(owner) && this.ofProject(owner, t.folder)
    this.d.store.update((s) => {
      // consumed — only the fact this answer answered (a new ask landed meanwhile keeps its own)
      const cur = s.armed[t.key]
      if (cur && cur.at === fact.at && cur.to === fact.to) delete s.armed[t.key]
      if (!woke) return
      const wake: Wake = {
        id: this.d.store.nextId(owner, t.ref, 'answered'),
        agent: owner,
        task: t.key,
        ref: t.ref,
        title: t.title,
        reason: 'answered',
        // (K13) a task handed on since: the answer names who asked
        says:
          fact.by && fact.by !== owner
            ? `${this.d.nameOf(i.agentId)} answered what ${this.d.nameOf(fact.by)} asked on this task`
            : `${this.d.nameOf(i.agentId)} answered what you asked through Silos`,
        at: iso,
        state: 'queued',
        notes: [{ at: iso, by: i.agentId, text }],
        bypassThrottle: false,
        key: `answered:${t.key}:${iso}`,
        answeredBy: i.agentId,
        // (H3) an unattended turn's answer waits for that turn's audit
        ...(i.turn?.unattended ? { answeredIn: { agent: i.agentId, run: runOfTurn(i.turn) } } : {}),
      }
      s.wakes.push(wake)
    }, now)
    if (i.turn?.unattended) {
      try {
        this.d.markNote?.(t.key, i.agentId, i.turn, iso)
      } catch {
        /* the note stands; its mark is lost */
      }
    }
    try {
      this.d.look?.()
    } catch {
      /* the tick looks again */
    }
    const says = woke
      ? `answered — ${this.nameFor(i.agentId, owner)} wakes on ${t.ref} with your answer`
      : `answered — your note is on ${t.ref}; ${this.nameFor(i.agentId, owner) || 'its owner'} reads it there`
    return { ok: true, value: { key: t.key, ref: t.ref, state: out.state, woke, says } }
  }

  // ── what `to` is shown (B2.4, H7): its asks LINKED and OPEN, oldest first ──
  asksTo(agentId: string): AskLine[] {
    const armed = Object.entries(this.d.store.armed()).filter(([, f]) => f.to === agentId)
    if (armed.length === 0) return []
    const byKey = new Map(this.d.tasks().map((t) => [t.key, t]))
    const out: AskLine[] = []
    for (const [key, f] of armed) {
      const t = byKey.get(key)
      if (!t || CLOSED.has(t.state) || !askLinked(f, t.waitingFor)) continue
      // only the asks of its projects reach it (an ask armed before the
      // folders changed stays until it is of its project again)
      if (!this.ofProject(agentId, t.folder)) continue
      let outside: string[] | null = null
      try {
        outside = this.d.askReadOutside?.(key, t.owner, f.at) ?? null
      } catch {
        outside = null
      }
      out.push({
        key,
        ref: t.ref,
        title: t.title,
        from: t.owner,
        fromName: this.nameFor(agentId, t.owner),
        action: f.action,
        asked: f.asked,
        at: f.at,
        silos: isSilosWait({ action: f.action }),
        ...(outside && outside.length > 0 ? { readOutside: outside } : {}),
      })
    }
    return out.sort((a, b) => a.at.localeCompare(b.at))
  }

  // ── the escalation's hop to an agent (H10) ──
  // A hop arms the same fact an ask arms, so it obeys the ask's bound on
  // `to` (R3): only an agent of the task's project. The escalation never
  // picks another (escalation/evaluate.ts ofLocation); this is the floor
  // under it — a hop to an agent outside writes and arms nothing.
  private hopOutside(key: string, to: string): boolean {
    const t = this.task(key)
    return t !== undefined && this.d.isAgent(to) && !this.ofProject(to, t.folder)
  }
  /** The fact for an agent hop is armed (asked '', Silos' own action) — the
   *  same fact kept (its `at`) when it is there already. Never counted in
   *  any agent's day. */
  armHop(key: string, to: string, action: string, now = this.now()): void {
    if (this.hopOutside(key, to)) return
    const cur = this.d.store.armedOf(key)
    if (cur && cur.to === to && cur.action === action && cur.asked === '') return
    this.d.store.update((s) => {
      s.armed[key] = { to, action, asked: '', at: new Date(now).toISOString() }
    }, now)
  }
  hopArmed(key: string, to: string, action: string): boolean {
    const cur = this.d.store.armedOf(key)
    return cur !== null && cur.to === to && cur.action === action && cur.asked === ''
  }
  /** The hop's write — the wait on `to` and blocked, ONE write the stamper
   *  expects (H4). true: it landed (or was so already). */
  writeHop(key: string, to: string, action: string): boolean {
    if (this.hopOutside(key, to)) return false
    const out: { undo: (() => void) | null } = { undo: null }
    const w = this.d.write(
      key,
      (child) => {
        if (!child) return 'the task is no longer in the file'
        const wait = child.waitingOn
        const waitOk = isObj(wait) && wait.owner === to && wait.action === action && !isStr(wait.asked)
        if (waitOk && child.status === 'blocked') return { write: false }
        child.waitingOn = { owner: to, action }
        child.status = 'blocked'
        out.undo = this.d.ownWrite?.(key, child) ?? null
        return { write: true }
      },
      `Silos asked ${this.d.nameOf(to)} to help unstick it`,
    )
    if (!w.ok) {
      out.undo?.()
      return false
    }
    return true
  }
}
