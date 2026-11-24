// silos/surfaces.ts — what the ACTIVE silos add to Home (Silo Standard step
// 1, Task 9): a term in the pulse, items in Needs you, lines in Done today.
// They enter by the same pipe as the other sources — GET /api/board's
// `needsYou` (one more kind, `silo`) plus a `silos` block for the pulse and
// Done today that is absent when no silo is active, so Home is unchanged
// until the first installation.
//
// Evaluated at REQUEST time with the clock: Home polls the board, so an
// invoice crosses «due this week» on the next poll with nobody writing; the
// kernel's tick refreshes what was read, and `signature()` lets the server
// tell the web when the set changed (a `silos` WS event).
//
//   needs-you   every entry's `when` over ALL live records (not terminal),
//               minus those its `clears` already clears, minus the ones the
//               owner acked (unchanged since); entries whose `fold.when`
//               holds come folded. Plus every overlay CONFLICT (blocking —
//               nobody wins in silence), every pending PROPOSAL, and every
//               pending SUBMISSION (a manifest waiting for the approval click
//               — installed or not: the one row that exists before a silo is
//               active, so zero submissions + zero active = Home unchanged).
//   pulse       the manifest's term over live records and the whole set
//   done today  transitions INTO a terminal state the journal observed since
//               local midnight — «arrived closed» and the baseline never count
import type { SiloRegistry } from './registry.js'
import type { SiloKernel } from './kernel.js'
import { isCompletion, type TransitionJournal } from './journal.js'
import { quietEndsOf } from './kernel-kinds.js'
import {
  baseRecordOf,
  holds,
  kindsOf,
  needsYouKind,
  pulseTerm,
  recordsOfKind,
  sayRow,
  terminalsOf,
  formatMoney,
  type KindInfo,
  type KindRecord,
  type Voice,
} from './voice.js'
import { isMoney } from './expressions.js'
import { standingIdsOf } from './manifest.js'
import type { TaskEnv } from './task-flow.js'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

export interface SiloNeedsYou {
  kind: 'silo'
  // submission: a manifest waiting for the owner's approval (installer.ts) —
  // the only reason that exists before the silo is active; `key` is
  // 'submission' and `recordKind` 'silo' (no record is involved)
  // escalation (phase 4, escalation/): a bound agent's task whose one wake
  // changed nothing and whose chain did not move it either — the owner's,
  // blocking, the door to the task
  reason: 'entry' | 'conflict' | 'proposal' | 'submission' | 'escalation'
  silo: string
  siloName: string
  key: string // the record's key (journal/overlay key)
  recordKind: string // 'invoice', 'plan/task'
  urgency: 'blocking' | 'due' | 'routine'
  text: string // the exact row Silos says
  at: string // the record's moment (or when the conflict was seen / the proposal made)
  agentId?: string // the agent it belongs to (its anchor, else the producer)
  folder?: string // the folder it anchors to
  file: string | null
  entry?: number // which needs-you entry of the manifest
  clears?: string // the dispatchable condition that takes it away
  actions?: string[]
  folded?: boolean // its entry's fold.when holds — counted, not listed
  // the kind's count noun in the house's words (surfaces.pulse.label) — a
  // folded summary says «13 support tickets», never «13 Support items»
  noun?: { one: string; many: string }
  // a SUB-KIND's row (a plan's task): the record it lives in — its key,
  // identity, moment and kind name. Home groups such rows by parent (G5:
  // «Yours to do» says one line per plan, the plan's name in its header)
  // instead of folding them past the silo's budget.
  parent?: { key: string; kind: string; identity: string; at: string; standingList?: true }
  identity?: string // the record's own identity (the row's words without its state)
  // how the owner settles a sub-kind's row in place, when the manifest lets them: the
  // state field set-field may write and the first terminal state («Done»);
  // `note`: the appendOnly collection the owner may add to (a Drop's note)
  resolve?: { field: string; done: string; drop?: string; note?: string }
  // a sub-kind's row (a plan's task): its state as the reader read it when the
  // row was composed — what the owner saw, sent back with Done / Drop so the
  // server can say «it changed»
  state?: string
  conflict?: { field: string; owner: unknown; base: unknown; source: unknown; seenAt: string }
  proposal?: { id: string; by: string; verb: string; field: string; from: unknown; to: unknown }
  submission?: { kind: 'install' | 'update' | 'reinstall'; from: string | null; to: string | null; submittedBy: string; source: 'body' | 'draft' }
  // a routed row (audience: producer-agent) its producer did not clear within
  // the window, nor its chain: back in the owner's inbox, with who was asked
  // — or an escalated task (reason 'escalation'), with the same words
  escalated?: { since: string; asked: string[]; with?: string }
}

export interface SiloPulseTerm {
  silo: string
  siloName: string
  term: string
}

export interface SiloDoneItem {
  silo: string
  siloName: string
  key: string
  recordKind: string
  identity: string
  to: string
  toLabel: string // the terminal state's plain word
  // closed WITHOUT being done: a terminal state other than the kind's first
  // (plans: cancelled — a Drop). Done today paints it ✕, never ✓ done, and
  // never counts it as done
  drop?: true
  at: string // when the kernel saw it close
  agentId?: string
  folder?: string
}

// withProducer: a needs-you entry the OPERATOR routed to the producer
// (audience: producer-agent) — the owner's inbox does not list
// its rows; Home says the one line («674 overdue invoices are with the Finance»)
// and the producer works them through the merged view. Counted, never listed.
export interface SiloWithProducer {
  silo: string
  siloName: string
  agentId: string // the bound producer the rows went to
  recordKind: string
  entry: number // which needs-you entry of the manifest
  count: number
  oldest: string // the oldest row's moment — '' when none carries one
  escalated?: number // rows of this entry that rose to the owner (listed in needsYou, not counted above)
}

// a routed row as the escalation reads it (escalation/engine.ts RoutedRow)
export interface SiloRoutedRow {
  silo: string
  siloName: string
  entry: number
  key: string
  text: string
  producer: string
  recordKind: string
  folder?: string
  file: string | null
}

// growth: an UNINSTALLED silo whose files keep being written — a Home term
// («12 records written to Invoices' files since it was uninstalled»)
export interface SiloBoard {
  pulse: SiloPulseTerm[]
  needsYou: SiloNeedsYou[]
  done: SiloDoneItem[]
  growth: SiloGrowthTerm[]
  withProducer: SiloWithProducer[]
}

export interface SiloAcksView {
  isAcked(silo: string, key: string, state: unknown, at: unknown): boolean
}

export interface SiloSurfacesOptions {
  registry: Pick<SiloRegistry, 'list'>
  kernel: Pick<SiloKernel, 'reading' | 'overlayState' | 'sinceFor'>
  journal?: TransitionJournal
  acks?: SiloAcksView
  isAgent?: (v: string) => boolean
  // an agent IN PLAY: listed and not archived. Who works a silo's rows (the
  // bound producer, the role fallback) and who a row is said to be with
  // counts only agents in play — an archived producer works nothing, so its
  // rows stay in the owner's inbox. Absent: isAgent, else everyone.
  inPlay?: (v: string) => boolean
  proposals?: (siloId: string) => SiloNeedsYou[] // pending proposals (Task 10)
  producersOf?: (siloId: string) => string[] | null // the binding fixed at approval
  // entry indexes whose granted `audience: producer-agent` the operator turned
  // OFF (operator.json audienceOff — the grant is approving a manifest that
  // declares it; this is the per-entry veto, slotsOff's shape)
  audienceOff?: (siloId: string) => number[]
  // records still being written to an uninstalled silo's files (Task 11)
  uninstalledGrowth?: () => SiloGrowthTerm[]
  // pending submissions waiting for the owner (installer.ts needsYou) — they
  // ride Needs you even with zero active silos: approving is the only door
  submissions?: () => SiloNeedsYou[]
  // the live facts a task's flow reads (task-flow.ts, G4): is a conversation
  // live, does an agent wake — evaluated at request time, never cached
  taskEnv?: TaskEnv
  // an agent's name as the house says it — a gate row names whose work it
  // unblocks («unblocks 1 task of Writer»); absent, the id
  nameOf?: (agentId: string) => string
  // the escalation (escalation/engine.ts): a routed row that rose to the
  // owner (listed again, with who was asked), and the escalated tasks' rows
  escalatedRow?: (silo: string, entry: number, key: string) => { since: string; asked: string[] } | null
  escalations?: () => SiloNeedsYou[]
}

// the Horizon: a kind's live records due soon (roles.due)
export interface SiloHorizonItem {
  silo: string
  siloName: string
  kind: string
  count: number
  firstDue: string
}

export interface SiloGrowthTerm {
  silo: string
  siloName: string
  records: number
  since: string
  term: string
}

// The words of a field's value: a state field reads by its label.
function valueWords(v: unknown, field: string, info: KindInfo): string {
  const env = isObj(info.spec.envelope) ? info.spec.envelope : {}
  const stField = isObj(env.state) && isStr(env.state.field) ? env.state.field : null
  if (isStr(v) && (field === stField || field === 'state')) {
    const st = (Array.isArray(info.spec.states) ? info.spec.states : []).filter(isObj).find((s) => s.value === v)
    if (st && isObj(st.label) && isStr(st.label.one)) return st.label.one
  }
  if (isMoney(v)) return formatMoney(v)
  if (v === undefined || v === null || v === '') return 'nothing'
  return isStr(v) || typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v)
}

// How the owner settles a row of `info` in place (SiloNeedsYou.resolve): the
// envelope's state field when a set-field action on this kind lets the owner
// write it, the kind's first terminal state (Done), its second (Drop), and the appendOnly sub-kind the
// owner may append to. null when the manifest lets the owner write no state.
function resolveOf(manifest: Json, kinds: Map<string, KindInfo>, info: KindInfo): SiloNeedsYou['resolve'] | null {
  const env = isObj(info.spec.envelope) ? info.spec.envelope : {}
  const field = isObj(env.state) && isStr(env.state.field) ? env.state.field : null
  const done = [...terminalsOf(info)][0]
  // Drop: the kind's other terminal state when it declares one (plans:
  // cancelled — finished, but it resolves no dependency; plans 0.5.3)
  const drop = [...terminalsOf(info)][1]
  if (!field || done === undefined) return null
  const actions = (Array.isArray((manifest.spec as Json).actions) ? ((manifest.spec as Json).actions as unknown[]) : []).filter(isObj)
  const target = (a: Json): unknown => (isStr(a.subKind) ? a.subKind : a.kind)
  const writable = actions.some(
    (a) => a.verb === 'set-field' && target(a) === info.name && isObj(a.fields) && isObj(a.fields[field]) && (a.fields[field] as Json).writableBy === 'owner',
  )
  if (!writable) return null
  const append = actions.find((a) => {
    if (a.verb !== 'append-item' || !isStr(a.subKind)) return false
    const k = kinds.get(a.subKind)
    const by = Array.isArray(a.by) ? a.by : [a.by]
    return k?.parent === info && k.spec.appendOnly === true && by.includes('owner')
  })
  const note = append && isStr(append.subKind) ? kinds.get(append.subKind)?.coll : undefined
  return { field, done, ...(drop !== undefined ? { drop } : {}), ...(note ? { note } : {}) }
}

function startOfDay(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// One rule, two readers (the board here, the record's actions in actions.ts):
// the producer of a record is its writer when that agent is bound and in
// play, else the first bound agent in play.
export function recordProducer(bound: readonly string[], anchors: { agent?: unknown }, inPlay: (agentId: string) => boolean): string | undefined {
  const live = bound.filter((a) => inPlay(a))
  const writer = anchors.agent
  return typeof writer === 'string' && live.includes(writer) ? writer : live[0]
}

export class SiloSurfaces {
  constructor(private opts: SiloSurfacesOptions) {}

  private active(): Array<{ id: string; name: string; manifest: Json; granted: string[]; conventions: Array<{ dir: string }> }> {
    return this.opts.registry
      .list()
      .filter((e) => e.status.state === 'active' && e.manifest !== null)
      .map((e) => ({
        id: e.id,
        name: e.status.manifest.name ?? e.id,
        manifest: e.manifest!,
        granted: e.status.slots.granted,
        conventions: e.status.conventions,
      }))
  }

  private inPlay(v: string): boolean {
    return (this.opts.inPlay ?? this.opts.isAgent ?? (() => true))(v)
  }

  // an agent the owner archived (known, out of play) — an anchor naming an id
  // that is no agent at all keeps its word as before
  private archived(v: string): boolean {
    return !!this.opts.inPlay && (this.opts.isAgent?.(v) ?? true) && !this.opts.inPlay(v)
  }

  // the first agent IN PLAY bound to the producer role (operator.json). A
  // silo never bound has no producer yet (a role is a word of the manifest,
  // never an agent id), and a binding whose agents are all archived has none
  // either: nobody can work the rows, so the owner keeps them (and Home
  // never says «with X» for an archived X).
  private producerAgent(id: string): string | undefined {
    return this.opts.producersOf?.(id)?.find((a) => this.inPlay(a))
  }

  // The producer of ONE record: the agent that wrote it, while it is still
  // bound to the role and in play — a silo bound to several agents (one per
  // project, say) routes each record's work to its own writer. A record with
  // no writer among the bound (a project record, a writer since unbound)
  // falls to the first in play.
  private producerOf(id: string, r: { anchors: Json }): string | undefined {
    return recordProducer(this.opts.producersOf?.(id) ?? [], r.anchors, (a) => this.inPlay(a))
  }

  private base(id: string): KindRecord[] {
    // a kernel record has no file ('') — null, so no surface offers to open one
    return (this.opts.kernel.reading(id)?.records ?? []).map((r) => baseRecordOf(r))
  }

  // The voice a silo's records are said in at `now`: who is an agent, when a
  // record entered a state, the live facts a task's flow reads, agents' names.
  // ONE place — Home's rows and the records routes say the same words.
  voice(siloId: string, now: number): Voice {
    return {
      now,
      ...(this.opts.isAgent ? { isAgent: this.opts.isAgent } : {}),
      since: this.opts.kernel.sinceFor(siloId),
      ...(this.opts.taskEnv ? { taskEnv: this.opts.taskEnv } : {}),
      ...(this.opts.nameOf ? { nameOf: this.opts.nameOf } : {}),
    }
  }

  board(now: number): SiloBoard {
    return this.compose(now).board
  }

  // The routed rows uncleared now (escalated or not) — what the escalation
  // keeps its row cases open on.
  routedRows(now: number): SiloRoutedRow[] {
    return this.compose(now).routed
  }

  private compose(now: number): { board: SiloBoard; routed: SiloRoutedRow[] } {
    const out: SiloBoard = { pulse: [], needsYou: [], done: [], growth: this.opts.uninstalledGrowth?.() ?? [], withProducer: [] }
    const routedOut: SiloRoutedRow[] = []
    // a record that rose to the owner is ONE row — its escalation (blocking,
    // with the chain's words); an entry that would also admit it stands down
    // (otherwise the waitsOnHuman entry lists the escalated task beside its
    // own escalation row)
    const escalations = this.opts.escalations?.() ?? []
    const escalatedKeys = new Set(escalations.map((e) => `${e.silo}\0${e.key}`))
    for (const s of this.active()) {
      const kinds = kindsOf(s.manifest)
      const base = this.base(s.id)
      const v: Voice = this.voice(s.id, now)
      const producer = this.producerAgent(s.id)
      const owner = (r: { anchors: Json }): { agentId?: string; folder?: string } => {
        // a row anchored to an archived agent is not said to be with it
        const agentId = isStr(r.anchors.agent) && !this.archived(r.anchors.agent) ? r.anchors.agent : producer
        return { ...(agentId ? { agentId } : {}), ...(isStr(r.anchors.folder) ? { folder: r.anchors.folder } : {}) }
      }
      const surfaces = isObj((s.manifest.spec as Json).surfaces) ? ((s.manifest.spec as Json).surfaces as Json) : {}

      // pulse
      if (s.granted.includes('pulse')) {
        const term = pulseTerm(s.manifest, kinds, base, v)
        if (term) out.pulse.push({ silo: s.id, siloName: s.name, term })
      }

      // needs-you entries
      const nyKind = needsYouKind(s.manifest)
      const info = nyKind ? kinds.get(nyKind) : undefined
      const pl = isObj(surfaces.pulse) && surfaces.pulse.kind === nyKind && isObj(surfaces.pulse.label) ? surfaces.pulse.label : null
      const noun = pl && isStr(pl.one) && isStr(pl.many) ? { one: pl.one, many: pl.many } : null
      if (s.granted.includes('needs-you') && info) {
        const term = terminalsOf(info)
        const resolve = info.parent ? resolveOf(s.manifest, kinds, info) : null
        // a standing parent (manifest.ts standingIdsOf — R1): said with no title
        const standing = info.parent ? standingIdsOf(s.manifest, info.parent.name) : new Set<string>()
        const parentOf = (r: KindRecord): SiloNeedsYou['parent'] | undefined => {
          if (!info.parent || !r.parent) return undefined
          const tail = `/${info.coll}/${String(r.rec.id)}`
          return {
            key: r.key.endsWith(tail) ? r.key.slice(0, -tail.length) : r.key,
            kind: info.parent.name,
            identity: isStr(r.parent.identity) ? r.parent.identity : '',
            at: isStr(r.parent.at) ? r.parent.at : '',
            ...(standing.has(String(r.parent.id)) ? { standingList: true as const } : {}),
          }
        }
        const all = recordsOfKind(kinds, base, info.name).filter((x) => !term.has(String(x.rec.state)))
        const entries = (Array.isArray(surfaces['needs-you']) ? surfaces['needs-you'] : []).filter(isObj)
        const audienceOff = this.opts.audienceOff?.(s.id) ?? []
        const listed = new Set<string>()
        for (const [i, n] of entries.entries()) {
          // audience producer-agent (operator-granted, never blocking): the
          // rows go to the bound producer, counted here, never listed to the
          // owner. No producer bound → nobody can work them → owner keeps them.
          const routed = n.audience === 'producer-agent' && n.urgency !== 'blocking' && producer !== undefined && !audienceOff.includes(i)
          // what is with each producer, by agent: {count, oldest, escalated}
          const withAgent = new Map<string, { count: number; oldest: string; escalated: number }>()
          const tally = (agentId: string): { count: number; oldest: string; escalated: number } => {
            let t = withAgent.get(agentId)
            if (!t) {
              t = { count: 0, oldest: '', escalated: 0 }
              withAgent.set(agentId, t)
            }
            return t
          }
          for (const r of all) {
            if (listed.has(r.key)) continue // one row per record: the first entry that holds speaks
            if (escalatedKeys.has(`${s.id}\0${r.key}`)) {
              listed.add(r.key)
              continue
            }
            if (!holds(n.when, info, r, v) || (isStr(n.clears) && holds(n.clears, info, r, v))) continue
            if (routed)
              routedOut.push({
                silo: s.id,
                siloName: s.name,
                entry: i,
                key: r.key,
                text: sayRow(info, r, v),
                producer: this.producerOf(s.id, r)!,
                recordKind: info.name,
                ...(isStr(r.anchors.folder) ? { folder: r.anchors.folder } : {}),
                file: r.file,
              })
            // a routed row its producer and its chain did not clear in their
            // windows comes back to the owner — listed, with who was asked
            const rose = routed ? (this.opts.escalatedRow?.(s.id, i, r.key) ?? null) : null
            const its = routed ? this.producerOf(s.id, r)! : undefined
            if (rose) tally(its!).escalated += 1
            if (routed && !rose) {
              // the owner's acks are gestures on THEIR inbox — a routed row is
              // not in it, so they neither hide nor count here
              listed.add(r.key)
              const t = tally(its!)
              t.count += 1
              const at = isStr(r.rec.at) ? r.rec.at : ''
              if (at !== '' && (t.oldest === '' || at < t.oldest)) t.oldest = at
              continue
            }
            if (this.opts.acks?.isAcked(s.id, r.key, r.rec.state, r.rec.at)) continue
            listed.add(r.key)
            out.needsYou.push({
              kind: 'silo',
              reason: 'entry',
              silo: s.id,
              siloName: s.name,
              key: r.key,
              recordKind: info.name,
              ...(rose ? { escalated: { ...rose, with: its! } } : {}),
              urgency: (['blocking', 'due', 'routine'].includes(String(n.urgency)) ? n.urgency : 'routine') as SiloNeedsYou['urgency'],
              text: sayRow(info, r, v),
              at: isStr(r.rec.at) ? r.rec.at : '',
              ...owner(r),
              file: r.file,
              ...(isStr(r.rec.identity) && r.rec.identity !== '' ? { identity: r.rec.identity } : {}),
              // resolve (the in-place Done) rides only when THIS entry offers
              // set-field: a row admitted for a wait on you is answered with a
              // note or on its page, never by closing someone else's task
              ...(info.parent
                ? {
                    parent: parentOf(r),
                    ...(isStr(r.rec.state) && r.rec.state !== '' ? { state: r.rec.state } : {}),
                    ...(resolve && (!Array.isArray(n.actions) || n.actions.includes('set-field')) ? { resolve } : {}),
                  }
                : {}),
              entry: i,
              ...(isStr(n.clears) ? { clears: n.clears } : {}),
              actions: Array.isArray(n.actions) ? (n.actions as unknown[]).filter(isStr) : [],
              ...(isObj(n.fold) && holds(n.fold.when, info, r, v) ? { folded: true } : {}),
              ...(noun ? { noun } : {}),
            })
          }
          for (const [agentId, t] of withAgent)
            out.withProducer.push({
              silo: s.id,
              siloName: s.name,
              agentId,
              recordKind: info.name,
              entry: i,
              count: t.count,
              oldest: t.oldest,
              ...(t.escalated > 0 ? { escalated: t.escalated } : {}),
            })
        }
      }

      // overlay conflicts — always, slots or not: nobody wins in silence
      const top = [...kinds.values()].find((k) => !k.parent)
      if (top) {
        const syncService =
          isObj((s.manifest.spec as Json).producer) && isObj(((s.manifest.spec as Json).producer as Json).sync)
            ? String((((s.manifest.spec as Json).producer as Json).sync as Json).service)
            : null
        for (const c of this.opts.kernel.overlayState(s.id).conflicts) {
          const r = base.find((b) => b.key === c.key)
          const identity = r && isStr(r.rec.identity) && r.rec.identity !== '' ? r.rec.identity : c.key.split('/').pop()!
          out.needsYou.push({
            kind: 'silo',
            reason: 'conflict',
            silo: s.id,
            siloName: s.name,
            key: c.key,
            recordKind: top.name,
            urgency: 'blocking',
            text: `${identity} — you set ${c.field} to ${valueWords(c.owner, c.field, top)}; ${syncService ? `the ${syncService} sync` : 'the sync'} now says ${valueWords(c.source, c.field, top)}`,
            at: c.seenAt,
            ...(r ? owner(r) : producer ? { agentId: producer } : {}),
            file: c.file,
            conflict: { field: c.field, owner: c.owner, base: c.base, source: c.source, seenAt: c.seenAt },
          })
        }
      }
      out.needsYou.push(...(this.opts.proposals?.(s.id) ?? []))

      // done today: observed transitions into a terminal state
      out.done.push(...this.doneIn(s, kinds, base, owner, producer, startOfDay(now), now + 1))
    }
    out.needsYou.push(...(this.opts.submissions?.() ?? []))
    out.needsYou.push(...escalations)
    out.needsYou.sort((a, b) => b.at.localeCompare(a.at))
    out.done.sort((a, b) => b.at.localeCompare(a.at))
    return { board: out, routed: routedOut }
  }

  // Records that reached a terminal state within [from, to): the journal's
  // «closed» (isCompletion), the newest per record. Done today reads it
  // from midnight; the daily digest from the previous digest.
  private doneIn(
    s: { id: string; name: string; manifest: Json; conventions: Array<{ dir: string }> },
    kinds: Map<string, KindInfo>,
    base: KindRecord[],
    owner: (r: { anchors: Json }) => { agentId?: string; folder?: string },
    producer: string | undefined,
    from: number,
    to: number,
  ): SiloDoneItem[] {
    if (!this.opts.journal) return []
    const latest = new Map<string, SiloDoneItem>()
    // a kernel kind's quiet ends (a process exiting) are no work done
    const quiet = quietEndsOf(s.manifest)
    for (const dir of new Set(s.conventions.map((c) => c.dir))) {
      for (const l of this.opts.journal.events(dir, from, to)) {
        if (!isCompletion(l) || !l.key || !isStr(l.to) || quiet.has(`${l.kind ?? ''}\0${l.to}`)) continue
        const k = kinds.get(l.kind ?? '')
        const rec = recordsOfKind(kinds, base, l.kind ?? '').find((x) => x.key === l.key)
        const st = k ? (Array.isArray(k.spec.states) ? k.spec.states : []).filter(isObj).find((x) => x.value === l.to) : undefined
        // the kind's first terminal state is its «done» (resolveOf's rule)
        const first = k ? [...terminalsOf(k)][0] : undefined
        latest.set(l.key, {
          silo: s.id,
          siloName: s.name,
          key: l.key,
          recordKind: l.kind ?? '',
          identity: rec && isStr(rec.rec.identity) && rec.rec.identity !== '' ? rec.rec.identity : l.key.split('/').pop()!,
          to: l.to,
          toLabel: st && isObj(st.label) && isStr(st.label.one) ? st.label.one : l.to,
          ...(first !== undefined && l.to !== first ? { drop: true as const } : {}),
          at: l.at,
          ...(rec ? owner(rec) : producer ? { agentId: producer } : {}),
        })
      }
    }
    return [...latest.values()]
  }

  // Every active silo's completions within [from, to) — the digest's «since
  // Friday: 3 invoices paid». Agents are not needed here (the digest counts).
  completions(from: number, to: number): SiloDoneItem[] {
    return this.active().flatMap((s) => {
      const producer = this.producerAgent(s.id)
      return this.doneIn(s, kindsOf(s.manifest), this.base(s.id), () => (producer ? { agentId: producer } : {}), producer, from, to)
    })
  }

  // The Horizon (silo standard, roles.due): per active silo and kind that
  // declares the `due` role, the live records whose due falls from today to
  // `days` ahead. null when no active silo declares `due` — the block is
  // absent, never an empty promise.
  horizon(now: number, days = 7): SiloHorizonItem[] | null {
    let declared = false
    const out: SiloHorizonItem[] = []
    const from = startOfDay(now)
    const until = now + days * 24 * 3600_000
    for (const s of this.active()) {
      const kinds = kindsOf(s.manifest)
      const base = this.base(s.id)
      for (const info of kinds.values()) {
        const roles = isObj(info.spec.roles) ? info.spec.roles : null
        const field = roles && isObj(roles.due) && isStr(roles.due.field) ? roles.due.field : null
        if (!field) continue
        declared = true
        const term = terminalsOf(info)
        let count = 0
        let first = ''
        for (const r of recordsOfKind(kinds, base, info.name)) {
          if (term.has(String(r.rec.state))) continue
          const due = r.rec[field]
          if (!isStr(due)) continue
          const t = Date.parse(due)
          if (!Number.isFinite(t) || t < from || t >= until) continue
          count++
          if (first === '' || due < first) first = due
        }
        if (count > 0) out.push({ silo: s.id, siloName: s.name, kind: info.name, count, firstDue: first })
      }
    }
    return declared ? out : null
  }

  // The routing of an ACTIVE silo's needs-you entries (audience:
  // producer-agent) as the silo page says it — the SAME three conditions the
  // board applies above (declared, never blocking, producer bound, not
  // vetoed), kept beside them so the two can't diverge. null = no routing.
  routing(siloId: string): { to: string[]; entries: number[]; of: number } | null {
    const s = this.active().find((x) => x.id === siloId)
    if (!s) return null
    const producer = this.producerAgent(s.id)
    if (!producer) return null
    const surfaces = isObj((s.manifest.spec as Json)?.surfaces) ? ((s.manifest.spec as Json).surfaces as Json) : {}
    const entries = (Array.isArray(surfaces['needs-you']) ? surfaces['needs-you'] : []).filter(isObj)
    const off = this.opts.audienceOff?.(s.id) ?? []
    const routed = entries.flatMap((n, i) => (n.audience === 'producer-agent' && n.urgency !== 'blocking' && !off.includes(i) ? [i] : []))
    // each row goes to the agent that wrote its record — with several bound, any of them
    return routed.length > 0 ? { to: (this.opts.producersOf?.(s.id) ?? []).filter((a) => this.inPlay(a)), entries: routed, of: entries.length } : null
  }

  // A stable fingerprint of what Home would show — the server broadcasts a
  // `silos` event when it changes (a predicate crossed by the clock alone).
  signature(now: number): string {
    const b = this.board(now)
    return JSON.stringify([
      b.growth.map((g) => g.term),
      b.pulse.map((p) => p.term),
      b.needsYou.map((n) => `${n.reason}:${n.silo}:${n.key}:${n.urgency}:${n.folded ? 1 : 0}${n.submission ? `:${n.at}` : ''}`),
      b.done.map((d) => d.key),
      b.withProducer.map((w) => `${w.silo}:${w.entry}:${w.agentId}:${w.count}:${w.escalated ?? 0}`),
    ])
  }
}
