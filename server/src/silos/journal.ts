// silos/journal.ts — the transition journal (Silo Standard v0 «The transition
// journal»; step 1 Task 4). Files hold the CURRENT state, not its
// changes, so the kernel keeps, per CONVENTION, an append-only journal of
// every transition it OBSERVES:
//
//   <dataDir>/silos/conventions/<conv>/journal.jsonl
//
// Pinned to the convention, never to the silo id: it survives an uninstall
// and serves whichever silo reads that convention next.
//
// Honesty, line by line:
//   opened      the kernel starts watching this convention (or restarts after
//               the journal went missing — said in `reason`)
//   baseline    the first observation of a convention: the state as found,
//               never an event (installing over existing data floods nothing)
//   appeared    a record seen for the first time AFTER the baseline — an
//               arrival, not a transition; arriving already terminal («arrived
//               closed») is `appeared` with toTerminal, never «closed»
//   transition  the state changed between two observations — dated to when
//               the kernel SAW it (`at`), with the window it happened in
//               (`prevSeenAt` … `at`) and the file's write time as a hint
//   removed     the record's file (or the child in it) is gone
//
// A record that can't be read is not removed (its file is there); a reading
// that a cap truncated concludes no removals at all.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { EvalRecord } from './expressions.js'
import type { SourceConvention } from './manifest.js'
import type { SiloReading } from './reader.js'

export type JournalEvent = 'opened' | 'baseline' | 'appeared' | 'transition' | 'removed'

export interface JournalLine {
  at: string // when the kernel SAW it
  event: JournalEvent
  key?: string // '<location>/<id>' — a child: '<location>/<id>/<collection>/<childId>'
  kind?: string // 'case', 'plan/task'
  from?: string | null
  to?: string | null
  fromTerminal?: boolean
  toTerminal?: boolean
  prevSeenAt?: string // transition/removed: the change happened after this
  fileWrittenAt?: string // the file's mtime when the change was seen — a hint, not the date
  silo?: string // opened: the silo whose reading opened the journal
  reason?: string // opened: why
}

export interface SnapshotEntry {
  key: string
  kind: string
  state: string
  terminal: boolean
  fileWrittenAt?: string
}

export interface Observation {
  convention: string
  dir: string // SourceConvention.dir
  silo: string
  entries: SnapshotEntry[]
  // keys (and their descendants) that exist but could not be read: never removed
  preserve: string[]
  complete: boolean // false when a cap truncated the walk — no removals concluded
}

interface KeyState {
  state: string
  kind: string
  terminal: boolean
  seenAt: string
}
interface ConvState {
  opened: boolean
  keys: Map<string, KeyState>
  history: Map<string, JournalLine[]>
  lines: JournalLine[]
  unreadableLines: number
}

const JOURNAL = 'journal.jsonl'

export class TransitionJournal {
  private convs = new Map<string, ConvState>()

  constructor(private conventionsDir: string) {}

  fileFor(dir: string): string {
    return join(this.conventionsDir, dir, JOURNAL)
  }

  // Replay the journal into memory once per convention.
  private load(dir: string): ConvState {
    const hit = this.convs.get(dir)
    if (hit) return hit
    const st: ConvState = { opened: false, keys: new Map(), history: new Map(), lines: [], unreadableLines: 0 }
    const file = this.fileFor(dir)
    if (existsSync(file)) {
      let text = ''
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        /* unreadable: replays as empty */
      }
      for (const raw of text.split('\n')) {
        if (raw.trim() === '') continue
        let line: JournalLine
        try {
          line = JSON.parse(raw) as JournalLine
          if (typeof line.at !== 'string' || typeof line.event !== 'string') throw new Error('shape')
        } catch {
          st.unreadableLines++
          continue
        }
        this.apply(st, line)
      }
    }
    this.convs.set(dir, st)
    return st
  }

  private apply(st: ConvState, line: JournalLine): void {
    st.lines.push(line)
    if (line.event === 'opened') {
      st.opened = true
      return
    }
    if (!line.key) return
    const h = st.history.get(line.key)
    if (h) h.push(line)
    else st.history.set(line.key, [line])
    if (line.event === 'removed') st.keys.delete(line.key)
    else if (typeof line.to === 'string') st.keys.set(line.key, { state: line.to, kind: line.kind ?? '', terminal: line.toTerminal === true, seenAt: line.at })
  }

  // Compare one observation with what the journal knows; append what changed.
  // Returns the lines written.
  observe(obs: Observation, now: Date): JournalLine[] {
    const st = this.load(obs.dir)
    const at = now.toISOString()
    const out: JournalLine[] = []
    const first = !st.opened
    if (first) {
      const folder = join(this.conventionsDir, obs.dir)
      const hadData = existsSync(folder) && readdirSync(folder).some((n) => n !== JOURNAL)
      out.push({ at, event: 'opened', silo: obs.silo, reason: hadData ? 'the journal was missing — history restarts here' : 'first observation' })
    }
    const seen = new Set<string>()
    for (const e of obs.entries) {
      seen.add(e.key)
      const known = st.keys.get(e.key)
      if (!known) {
        out.push({ at, event: first ? 'baseline' : 'appeared', key: e.key, kind: e.kind, to: e.state, toTerminal: e.terminal })
      } else if (known.state !== e.state) {
        out.push({
          at,
          event: 'transition',
          key: e.key,
          kind: e.kind,
          from: known.state,
          to: e.state,
          fromTerminal: known.terminal,
          toTerminal: e.terminal,
          prevSeenAt: known.seenAt,
          ...(e.fileWrittenAt ? { fileWrittenAt: e.fileWrittenAt } : {}),
        })
      }
    }
    if (obs.complete) {
      const kept = (k: string): boolean => obs.preserve.some((p) => k === p || k.startsWith(p + '/'))
      for (const [k, known] of st.keys) {
        if (seen.has(k) || kept(k)) continue
        out.push({ at, event: 'removed', key: k, kind: known.kind, from: known.state, to: null, fromTerminal: known.terminal, prevSeenAt: known.seenAt })
      }
    }
    if (out.length > 0) {
      mkdirSync(join(this.conventionsDir, obs.dir), { recursive: true, mode: 0o700 })
      appendFileSync(this.fileFor(obs.dir), out.map((l) => JSON.stringify(l)).join('\n') + '\n', { mode: 0o600 })
      for (const l of out) this.apply(st, l)
    }
    // what is seen unchanged is still seen now: the next change's window starts here
    for (const e of obs.entries) {
      const k = st.keys.get(e.key)
      if (k) k.seenAt = at
    }
    return out
  }

  // When the record last ENTERED <state>, from the journal: a transition or an
  // arrival into it. A baseline says the state, not when it began — null, the
  // language never invents (expressions.md `since`).
  since(dir: string, key: string, state: string): number | null {
    let entered: number | null = null
    for (const l of this.load(dir).history.get(key) ?? []) {
      if (l.to !== state) continue
      entered = l.event === 'baseline' ? null : Date.parse(l.at)
    }
    return entered
  }

  // A record's story (the record page, Task 8).
  history(dir: string, key: string): JournalLine[] {
    return [...(this.load(dir).history.get(key) ?? [])]
  }

  // Lines seen within [from, to) — Done today and catch-up («since Friday: 3
  // invoices paid») read this, Task 9.
  events(dir: string, from: number, to = Infinity): JournalLine[] {
    return this.load(dir).lines.filter((l) => {
      const t = Date.parse(l.at)
      return t >= from && t < to
    })
  }

  // Lines from position `n` on (a reader's cursor — plans-provenance.ts keeps
  // its own in ~/.silos/plans-provenance.json) and the
  // position after them.
  linesFrom(dir: string, n: number): { lines: JournalLine[]; next: number } {
    const all = this.load(dir).lines
    const from = Math.max(0, Math.min(n, all.length))
    return { lines: all.slice(from), next: all.length }
  }

  // Lines the journal file holds that could not be read (said, not hidden).
  health(dir: string): { lines: number; unreadableLines: number; opened: boolean } {
    const st = this.load(dir)
    return { lines: st.lines.length, unreadableLines: st.unreadableLines, opened: st.opened }
  }
}

// «Closed» — a transition INTO a terminal state from a live one. Arriving
// closed (appeared + toTerminal) and the baseline never count.
export function isCompletion(l: JournalLine): boolean {
  return l.event === 'transition' && l.toTerminal === true && l.fromTerminal !== true
}

// «Arrived closed» — first seen already terminal, after the baseline.
export function arrivedTerminal(l: JournalLine): boolean {
  return l.event === 'appeared' && l.toTerminal === true
}

// ── from a reading to observations ──────────────────────────────────────────

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

function terminalsOf(spec: unknown): Set<string> {
  const states = isObj(spec) && Array.isArray(spec.states) ? spec.states : []
  return new Set(states.filter((s): s is Json => isObj(s) && s.terminal === true).map((s) => String(s.value)))
}

export interface ObservationSet {
  observations: Observation[]
  // the journal key of every normalized record object (records and children)
  // — what env.since needs to find a record's history
  keys: WeakMap<object, { dir: string; key: string }>
}

// A record's key — the journal's and the overlay's: its location + its id.
export function recordKey(r: { location: string; record: { id: string } }): string {
  return `${r.location}/${r.record.id}`
}

// Every record with a state (and every child with a state) of a reading,
// grouped by the convention of its source.
export function observationsOf(siloId: string, manifest: Json, reading: SiloReading, conventions: readonly SourceConvention[]): ObservationSet {
  const byConv = new Map<string, Observation>()
  const keys = new WeakMap<object, { dir: string; key: string }>()
  const convOf = new Map(conventions.map((c) => [c.source, c]))
  const complete = reading.truncated.length === 0 && reading.problems.length === 0
  for (const c of conventions) {
    if (!byConv.has(c.dir)) byConv.set(c.dir, { convention: c.convention, dir: c.dir, silo: siloId, entries: [], preserve: [], complete })
  }
  const kinds = isObj(manifest.spec) && isObj(manifest.spec.kinds) ? manifest.spec.kinds : {}
  for (const r of reading.records) {
    const c = convOf.get(r.source)
    if (!c) continue
    const obs = byConv.get(c.dir)!
    const key = recordKey(r)
    keys.set(r.record, { dir: c.dir, key })
    const spec = kinds[r.kind]
    const fileWrittenAt = new Date(r.mtimeMs).toISOString()
    if (typeof r.record.state === 'string')
      obs.entries.push({ key, kind: r.kind, state: r.record.state, terminal: terminalsOf(spec).has(r.record.state), fileWrittenAt })
    // children, and theirs (depth ≤ 2 — a task's notes): every one keyed
    // under its parent, observed when it has a state
    const walk = (parentSpec: unknown, parentKey: string, parentKind: string, rec: Json, partial: readonly string[], depth: number): void => {
      const subs = isObj(parentSpec) && isObj(parentSpec.subKinds) ? parentSpec.subKinds : {}
      for (const [subName, sub] of Object.entries(subs)) {
        if (!isObj(sub) || depth > 2) continue
        const coll = (typeof sub.path === 'string' ? sub.path : subName).replace(/\[\]$/, '')
        if (partial.includes(coll)) obs.preserve.push(`${parentKey}/${coll}`)
        const terminals = terminalsOf(sub)
        const kids = Array.isArray(rec[coll]) ? (rec[coll] as unknown[]) : []
        for (const kid of kids) {
          if (!isObj(kid) || typeof kid.id !== 'string') continue
          const kidKey = `${parentKey}/${coll}/${kid.id}`
          keys.set(kid, { dir: c.dir, key: kidKey })
          if (typeof kid.state === 'string')
            obs.entries.push({ key: kidKey, kind: `${parentKind}/${subName}`, state: kid.state, terminal: terminals.has(kid.state), fileWrittenAt })
          walk(sub, kidKey, `${parentKind}/${subName}`, kid, [], depth + 1)
        }
      }
    }
    walk(spec, key, r.kind, r.record, r.partial, 1)
  }
  // a file that is there but can't be read keeps its last known state
  for (const u of reading.unreadable) {
    const c = convOf.get(u.source)
    if (!c) continue
    const obs = byConv.get(c.dir)!
    obs.preserve.push(u.id !== null ? `${u.location}/${u.id}` : u.location)
  }
  return { observations: [...byConv.values()], keys }
}

// env.since for evaluate(): the record's entry into <state>, from the journal
// of its convention; a record the journal doesn't know → null.
export function sinceResolver(journal: TransitionJournal, keys: ObservationSet['keys']): (record: EvalRecord, state: string) => number | null {
  return (record, state) => {
    const k = keys.get(record)
    return k ? journal.since(k.dir, k.key, state) : null
  }
}
