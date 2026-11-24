// heartbeat-facts.ts — the facts a heartbeat's packet is composed from,
// read from the stores that hold them — zero
// tokens. heartbeat-packet.ts turns them into the delta; nothing here
// decides what enters.
import type { Creation } from './creations.js'
import { originIsKnown, type Origin } from './plans-origins.js'
import type { AutomationsStore } from './automations-store.js'
import { decidedWords, type ProposalsStore } from './proposals.js'
import type { MessageStore } from './messages.js'
import type { TaskSnap } from './task-mode/evaluate.js'
import type { SiloRoutedRow } from './silos/surfaces.js'
import type { Agent } from './types.js'
import type { PacketInput } from './heartbeat-packet.js'
import { admitsFailure, failureStreak, runFailure } from './inbox.js'
import { isHeartbeat } from './heartbeat.js'
import { ownCapHold, type OwnTurnsToday } from './own-turns.js'
import type { AskLine } from './task-asks.js'

export interface HeartbeatFactsDeps {
  messages?: Pick<MessageStore, 'list'>
  automations: Pick<AutomationsStore, 'list' | 'listRuns'>
  tasks?: (now: number) => readonly TaskSnap[]
  routedRows?: (now: number) => readonly SiloRoutedRow[]
  proposals?: Pick<ProposalsStore, 'list'>
  // who created a task (plans-origins.ts): `yours` says it, and a task
  // added outside Silos is never listed as startable
  originOf?: (key: string) => Origin | null
  // its own creations (creations.json): what Silos cancelled with its why,
  // what the owner undid — the `decided` source
  creations?: (agentId: string) => Creation[]
  ownToday?: (agentId: string, now: number) => OwnTurnsToday | null
  // the asks other agents left it through Silos,
  // linked and open (task-asks.ts asksTo — the text is the store's)
  asks?: (agentId: string) => readonly AskLine[]
  nameOf: (agentId: string) => string
}

export type HeartbeatFacts = Omit<PacketInput, 'agentId' | 'since' | 'now' | 'lastListed' | 'considered'>

export function heartbeatFacts(d: HeartbeatFactsDeps, agent: Agent, since: number, now: number): HeartbeatFacts {
  const out: HeartbeatFacts = { messages: [], failedRuns: [], yours: [], waits: [], routed: [], decided: [], owner: [], asks: [] }
  // messages: its inbox's `new` ones — a message still new always re-enters (m6)
  try {
    for (const m of d.messages?.list(agent.id, 'new') ?? []) {
      out.messages.push({
        id: m.id,
        from: m.from,
        fromName: d.nameOf(m.from),
        text: m.text,
        at: Date.parse(m.at) || 0,
        ...(m.readOutside?.length ? { readOutside: m.readOutside } : {}),
      })
    }
  } catch {
    /* an unreadable inbox lists nothing this time */
  }
  // failedRuns: its automations whose newest run is a failure the owner would
  // be shown (admitsFailure) — its heartbeat is not one of them
  for (const a of d.automations.list()) {
    if (a.agentId !== agent.id || isHeartbeat(a)) continue
    try {
      const runs = d.automations.listRuns(a.id, 12)
      const { newest, streak } = failureStreak(runs)
      if (!newest || newest.status !== 'failed') continue
      if (!admitsFailure(runFailure(newest.error, newest), streak, a)) continue
      out.failedRuns.push({
        automationId: a.id,
        runId: newest.id,
        name: a.name,
        error: newest.error ?? 'failed',
        at: Date.parse(newest.endedAt ?? newest.at) || 0,
      })
    } catch {
      /* its runs unreadable: nothing listed */
    }
  }
  // yours: its tasks ready with nobody on them (idle); waits: its tasks blocked on
  // someone other than the owner or itself
  try {
    for (const t of d.tasks?.(now) ?? []) {
      if (t.owner !== agent.id) continue
      // ready and nobody on it — the kernel's `idle`, carried on the task,
      // never derived again here
      if (t.idle === true) {
        const o = d.originOf ? d.originOf(t.key) : undefined
        // created by others — its own creations are its own doing
        if (o && o.by === agent.id && !o.provisional) continue
        const by = o === undefined ? undefined : originIsKnown(o) ? o!.by : 'unknown'
        out.yours.push({
          key: t.key,
          ref: t.ref,
          title: t.title,
          at: since + 1,
          ...(by !== undefined ? { by, ...(by !== 'unknown' && by !== 'owner' ? { byName: d.nameOf(by) } : {}) } : {}),
        })
      } else if (t.state === 'blocked' && t.waitingFor && t.waitingFor.owner !== 'owner' && t.waitingFor.owner !== agent.id) {
        // a wait carries no clock of its own here: its first listing starts its
        // week. One Silos carries (an ask linked and in reach) is said once
        out.waits.push({
          key: t.key,
          ref: t.ref,
          title: t.title,
          who: d.nameOf(t.waitingFor.owner),
          since: since,
          ...(t.asked === true ? { carried: true } : {}),
        })
      }
    }
  } catch {
    /* the plans unreadable: nothing listed */
  }
  // asks: what other agents asked it through Silos (B2.4) — linked, open,
  // listed past their reach too (H7)
  try {
    for (const a of d.asks?.(agent.id) ?? []) {
      out.asks!.push({
        key: a.key,
        ref: a.ref,
        title: a.title,
        fromName: a.fromName,
        action: a.action,
        asked: a.asked,
        at: Date.parse(a.at) || 0,
        ...(a.silos ? { silos: true } : {}),
        ...(a.readOutside ? { readOutside: a.readOutside } : {}),
      })
    }
  } catch {
    /* the store unreadable: nothing listed this time */
  }
  // routed: rows of silos routed to it past the window
  try {
    for (const r of d.routedRows?.(now) ?? []) {
      if (r.producer !== agent.id) continue
      out.routed.push({ key: `${r.silo}:${r.entry}:${r.key}`, text: `${r.siloName}: ${r.text}`, at: now })
    }
  } catch {
    /* nothing routed this time */
  }
  // decided: its proposals decided since the last heartbeat — accepted (or
  // saved from Review), dismissed with the owner's reason, withdrawn,
  // expired unanswered
  try {
    for (const p of d.proposals?.list() ?? []) {
      if (p.by !== agent.id || !p.decidedAt || p.state === 'pending') continue
      out.decided.push({ key: `proposal:${p.id}`, text: decidedWords(p), at: Date.parse(p.decidedAt) || 0 })
    }
  } catch {
    /* nothing decided this time */
  }
  // decided: its own creations Silos cancelled (with its why) or the owner
  // undid, since the last heartbeat
  try {
    for (const c of d.creations?.(agent.id) ?? []) {
      if (c.action) continue
      const what = c.title ? `«${c.title}»` : c.ref
      if (c.undoneAt) out.decided.push({ key: `creation:${c.id}:undone`, text: `the owner undid ${what}`, at: Date.parse(c.undoneAt) || 0 })
      else if (c.rejected && !c.adopted)
        out.decided.push({ key: `creation:${c.id}:rejected`, text: `Silos cancelled ${what}: ${c.rejected.why}`, at: Date.parse(c.rejected.at) || 0 })
    }
  } catch {
    /* nothing decided this time */
  }
  // owner: the row of its ceiling, its spend cap or its cut, if it exists today
  const today = d.ownToday?.(agent.id, now) ?? null
  const day = new Date(now).toISOString().slice(0, 10)
  const cap = today ? ownCapHold(today) : null
  if (cap === 'ceiling') out.owner.push({ key: `ceiling:${agent.id}:${day}`, text: `you started ${today!.used} times today — your max of ${today!.ceiling}` })
  if (cap === 'spend') out.owner.push({ key: `spend:${agent.id}:${day}`, text: `you spent $${today!.costUsd.toFixed(2)} today on your own — your cap` })
  if (agent.cut)
    out.owner.push({
      key: `cut:${agent.id}:${agent.cut.at}`,
      text: `creating work of your own is stopped since ${agent.cut.at.slice(0, 10)}: ${agent.cut.why} — the owner can allow it again`,
    })
  return out
}
