// heartbeat-packet.ts — «since the last time», composed by the server with
// zero tokens. PURE: the facts in, the packet
// out — nothing here reads or writes.
//
// The packet is a DELTA, not a state: every item has a key (message:<id>,
// run:<automationId>/<runId>, wait:<taskKey>, task:<key>, row:<rowKey>,
// proposal:<id>, ask:<taskKey>) and only enters when its fact changed since `since`. An
// item the agent considered `dropped` — or `later` with an `until` still
// ahead — does not come back without a new change (the server crosses keys
// against considered.jsonl). A message still `new` ALWAYS re-enters (m6: its
// pending fact IS the change; a dead turn never buries it). A `yours` task
// comes back when it is still not started PACKET_RELIST_MS after it was last
// listed — «last listed» read from the packet.keys of earlier heartbeat runs
// (m5) — and that relisting is no «change» (m9): a dropped one never comes
// back by relisting. A task added outside Silos (`by: 'unknown'`) is never
// listed as startable (S8). Each source lists at most PACKET_PER_SOURCE_MAX
// items, the newest, and closes with «…and <n> more»; the keys left out are
// not in packet.keys, so they come next time (m9-r5). An ask another agent
// left it through Silos (`ask:<taskKey>`, linked
// and open, its text from Task mode's store) enters when it is first armed
// and comes back PACKET_RELIST_MS after it was last listed — past its reach
// too (a late answer still counts); `later`/`dropped` suppress it like any
// item, and a listing in a run that FAILED is no listing (lastListedOf).
import { PACKET_PER_SOURCE_MAX, PACKET_RELIST_MS } from './limits.js'

export interface PacketMessage {
  id: string
  from: string
  fromName: string
  text: string
  at: number
  readOutside?: string[]
}
export interface PacketFailedRun {
  automationId: string
  runId: string
  name: string
  error: string
  at: number
}
export interface PacketTask {
  key: string
  ref: string
  title: string
  by?: string | 'owner' | 'unknown'
  byName?: string
  at: number
}
// `carried`: Silos carries the wait to `who` — an ask
// linked and in reach (flow.asked): said ONCE, never weekly
export interface PacketWait {
  key: string
  ref: string
  title: string
  who: string
  since: number
  carried?: boolean
}
export interface PacketRouted {
  key: string
  text: string
  at: number
}
export interface PacketDecided {
  key: string
  text: string
  at: number
}
export interface PacketOwnerRow {
  key: string
  text: string
}
// (B2.4) an ask on it: the task's key and ref, who asks, what (the store's
// words), when it was armed; `silos`: the escalation's own ask (H10)
export interface PacketAsk {
  key: string
  ref: string
  title: string
  fromName: string
  action: string
  asked: string
  at: number
  silos?: boolean
  readOutside?: string[]
}
// readOutside: the run's mark, re-stamped when a turn that read outside ends —
// it comes back into future prompts with it
export interface Considered {
  at: string
  run?: string
  idea: string
  decision: 'created' | 'proposed' | 'dropped' | 'later'
  why: string
  until?: string
  readOutside?: string[]
}

// The packet keys a considered line names: the server crosses keys against
// considered.jsonl, and the line's only free text naming its item is
// its `idea` («message:m1 — the invoice reminder»), so the keys are read
// from it in the packet's own forms.
const KEY_RE = /\b(?:message|run|wait|task|row|proposal|ask):[^\s«»"',;)]+/g
export function keysOfIdea(idea: string): string[] {
  return [...new Set(idea.match(KEY_RE) ?? [])]
}

export interface PacketInput {
  agentId: string
  since: number
  now: number
  messages: PacketMessage[]
  failedRuns: PacketFailedRun[]
  yours: PacketTask[]
  waits: PacketWait[]
  routed: PacketRouted[]
  decided: PacketDecided[]
  owner: PacketOwnerRow[]
  // (B2.4) the asks other agents left it — absent: none
  asks?: PacketAsk[]
  // key → the last time an earlier heartbeat run listed it (its packet.keys)
  lastListed: ReadonlyMap<string, number>
  considered: readonly Considered[]
}

export interface PacketItem {
  key: string
  source: string
  line: string
  at: number
}
export interface Packet {
  items: PacketItem[]
  keys: string[]
  lines: string[]
  empty: boolean
}

const clip = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}
const outsideMark = (tools?: string[]): string => (tools && tools.length > 0 ? ` — sent after reading the web (${tools.join(', ')})` : '')
const askedMark = (tools?: string[]): string => (tools && tools.length > 0 ? ` — asked after reading the web (${tools.join(', ')})` : '')

/** (B2.4, H7) The line an ask is shown with in the packet: who waits on
 *  you, for which task, what it asks (the question, else the action), and
 *  its run's mark. The escalation's own ask says the task is stuck. */
export function askLine(a: Pick<PacketAsk, 'key' | 'ref' | 'title' | 'fromName' | 'action' | 'asked' | 'silos' | 'readOutside'>): string {
  if (a.silos) return `ask:${a.key} — ${a.ref} «${clip(a.title, 120)}» is stuck and Silos asks you to help unstick it (${a.fromName} stays its owner)`
  const what = a.asked.trim() !== '' ? a.asked : a.action
  return `ask:${a.key} — ${a.fromName} waits on you for ${a.ref}: «${clip(what, 140)}»${askedMark(a.readOutside)}`
}

/** The keys a `considered` line suppresses at `now`: dropped for good,
 *  `later` until its `until` passes. Only for keys a considered line names. */
export function suppressedKeys(considered: readonly Considered[], now: number): Map<string, number> {
  // key → the moment of the decision (an item with a change AFTER it comes back)
  const out = new Map<string, number>()
  for (const c of considered) {
    const at = Date.parse(c.at) || 0
    for (const key of keysOfIdea(c.idea)) {
      if (c.decision === 'dropped') out.set(key, Math.max(out.get(key) ?? 0, at))
      else if (c.decision === 'later') {
        const until = c.until ? Date.parse(c.until) : NaN
        if (!Number.isNaN(until) && until > now) out.set(key, Math.max(out.get(key) ?? 0, at))
      }
    }
  }
  return out
}

export function composePacket(i: PacketInput): Packet {
  const sup = suppressedKeys(i.considered, i.now)
  // an item whose fact changed at `at`: in, unless a considered decision
  // newer than that change suppresses it
  const fresh = (key: string, at: number): boolean => {
    const d = sup.get(key)
    return d === undefined || at > d
  }
  const sources: Array<{ source: string; items: PacketItem[] }> = []
  const push = (source: string, items: PacketItem[]): void => {
    sources.push({ source, items: items.sort((a, b) => b.at - a.at) })
  }

  push(
    'messages',
    i.messages.map((m) => ({
      key: `message:${m.id}`,
      source: 'messages',
      at: m.at,
      line: `message:${m.id} from ${m.fromName}: «${clip(m.text, 140)}»${outsideMark(m.readOutside)}`,
    })),
  )
  push(
    'failedRuns',
    i.failedRuns
      .filter((r) => r.at > i.since)
      .map((r) => ({
        key: `run:${r.automationId}/${r.runId}`,
        source: 'failedRuns',
        at: r.at,
        line: `run:${r.automationId}/${r.runId} — your automation «${r.name}» failed: ${clip(r.error, 140)}`,
      }))
      .filter((x) => fresh(x.key, x.at)),
  )
  push(
    'yours',
    i.yours.flatMap((t): PacketItem[] => {
      const key = `task:${t.key}`
      const last = i.lastListed.get(key)
      // new to the packet, or still not started a week after it was listed —
      // a relisting is no change: a dropped one stays dropped (m9)
      const relist = last !== undefined && i.now - last >= PACKET_RELIST_MS
      if (last !== undefined && !relist) return []
      if (last === undefined ? !fresh(key, t.at) : sup.has(key)) return []
      const who = t.by === 'unknown' ? null : (t.byName ?? t.by ?? null)
      const line =
        t.by === 'unknown'
          ? `task:${t.key} (${t.ref}) «${clip(t.title, 120)}» — added outside Silos — the owner hasn't touched it`
          : `task:${t.key} (${t.ref}) «${clip(t.title, 120)}» — pending, not started${who ? `, left by ${who}` : ''}`
      return [{ key, source: 'yours', at: t.at, line }]
    }),
  )
  push(
    'waits',
    i.waits.flatMap((w): PacketItem[] => {
      const key = `wait:${w.key}`
      // a wait Silos carries: said once, the first time it is seen, never
      // relisted — the asked agent sees it by itself; when it flips to the
      // relay, the weekly line below returns
      if (w.carried) {
        if (i.lastListed.has(key) || sup.has(key)) return []
        return [{ key, source: 'waits', at: w.since, line: `wait:${w.ref} «${clip(w.title, 120)}» — ${w.who} sees it at its next beat — nothing to do` }]
      }
      if (i.now - w.since < PACKET_RELIST_MS) return []
      const last = i.lastListed.get(key)
      if (last !== undefined && i.now - last < PACKET_RELIST_MS) return []
      if (sup.has(key)) return []
      return [
        {
          key,
          source: 'waits',
          at: w.since,
          line: `wait:${w.ref} «${clip(w.title, 120)}» has waited on ${w.who} since ${new Date(w.since).toISOString().slice(0, 10)}`,
        },
      ]
    }),
  )
  // a routed row is new when no earlier heartbeat listed it (a row carries
  // no clock of its own: its first listing is its «since»)
  push(
    'routed',
    i.routed
      .filter((r) => !i.lastListed.has(`row:${r.key}`))
      .map((r) => ({ key: `row:${r.key}`, source: 'routed', at: r.at, line: `row:${r.key} — ${clip(r.text, 160)}` }))
      .filter((x) => fresh(x.key, x.at)),
  )
  // (B2.4, H7) new to the packet, or listed a while ago and still asking —
  // a relisting is no change: a dropped one stays dropped
  push(
    'asks',
    (i.asks ?? []).flatMap((a): PacketItem[] => {
      const key = `ask:${a.key}`
      const last = i.lastListed.get(key)
      if (last !== undefined && i.now - last < PACKET_RELIST_MS) return []
      if (last === undefined ? !fresh(key, a.at) : sup.has(key)) return []
      return [{ key, source: 'asks', at: a.at, line: askLine(a) }]
    }),
  )
  push(
    'decided',
    i.decided.filter((d) => d.at > i.since).map((d) => ({ key: d.key, source: 'decided', at: d.at, line: `${d.key} — ${clip(d.text, 200)}` })),
  )
  push(
    'owner',
    i.owner
      .filter((r) => !i.lastListed.has(`row:${r.key}`))
      .map((r) => ({ key: `row:${r.key}`, source: 'owner', at: i.now, line: `row:${r.key} — ${r.text}` })),
  )

  const items: PacketItem[] = []
  const lines: string[] = []
  for (const s of sources) {
    const shown = s.items.slice(0, PACKET_PER_SOURCE_MAX)
    items.push(...shown)
    lines.push(...shown.map((x) => x.line))
    const more = s.items.length - shown.length
    if (more > 0) lines.push(`…and ${more} more`)
  }
  return { items, keys: items.map((x) => x.key), lines, empty: items.length === 0 }
}

/** «When was it last listed» (m5): key → the newest heartbeat run that
 *  listed it, from those runs' packet.keys. An ask listed in a run that
 *  FAILED was not seen (H7): that listing does not count. */
export function lastListedOf(runs: ReadonlyArray<{ at: string; status?: string; heartbeat?: { packet?: { keys?: string[] } } }>): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of runs) {
    const at = Date.parse(r.at) || 0
    for (const k of r.heartbeat?.packet?.keys ?? []) {
      if (r.status === 'failed' && k.startsWith('ask:')) continue
      if ((out.get(k) ?? -1) < at) out.set(k, at)
    }
  }
  return out
}
