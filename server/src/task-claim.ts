// task-claim.ts — the claim verb's judgement.
// An agent that takes a task on its own asks Silos «may I?» and gets a yes
// with the briefing, or a SHORT EXPLAINED no — never a lock:
//   - the other conversations of the task's thread (task-threads.ts, the one
//     membership rule) outside the claimant's own thread (its /clear tips and
//     ancestors are itself, not another);
//   - one of them is LIVE when a turn runs there now (Silos' SDK turns) or its
//     transcript moved in the last CLAIM_LIVE_MS (a console or a TUI working
//     — the only trace Silos has of them, on both engines);
//   - live → 409 saying who and how long ago; `takeover` passes and Silos
//     writes the hand-over note; stale → the claim goes in and says «also
//     worked by».
// Pure over the index's metas: the route reads, judges and writes without
// an await between, so two claims arriving together are judged in turn.
import type { SessionMeta } from './types.js'
import type { LineageStore } from './lineage.js'
import { threadMembership } from './task-threads.js'
import { formatAgo } from './silos/freshness.js'
import { backgroundAtWork } from './work-live.js'

export const CLAIM_LIVE_MS = 10 * 60_000

export interface ClaimOther {
  sessionId: string
  folder: string | null // null: listed, not indexed yet
  agent: string
  title: string
  at: number | null // last movement (transcript or its subagents), ms
  running: boolean
  live: boolean
  says: string // «Builder's conversation «…» (2 min ago)»
}

export function othersOnTask(o: {
  metas: readonly SessionMeta[]
  lineage: LineageStore | null
  listed: readonly string[]
  claimant: string | null
  ownerOf: (m: SessionMeta) => string
  nameOf: (agentId: string) => string
  isRunning: (sessionId: string) => boolean
  now: number
  // a console key → its sealed native id (one thread — task-threads.ts)
  nativeIdOf?: (id: string) => string | null
}): ClaimOther[] {
  const member = threadMembership(o.metas, o.lineage, o.nativeIdOf ? { nativeIdOf: o.nativeIdOf } : {})
  const mine = (m: SessionMeta): boolean => o.claimant !== null && (m.id === o.claimant || member.belongs(m, [o.claimant]))
  const indexed = new Set(o.metas.map((m) => m.id))
  const out: ClaimOther[] = []
  for (const m of member.sessionsOf(o.listed)) {
    if (mine(m)) continue
    const at = Math.max(m.mtime, m.subMtime ?? 0)
    const running = o.isRunning(m.id)
    const agent = o.ownerOf(m)
    const title = m.title.trim() !== '' ? m.title.trim() : 'untitled'
    out.push({
      sessionId: m.id,
      folder: m.folder,
      agent,
      title,
      at,
      running,
      live: running || o.now - at < CLAIM_LIVE_MS || backgroundAtWork(m, o.now, CLAIM_LIVE_MS),
      says: `${o.nameOf(agent)}'s conversation «${title}» (${running ? 'a turn is running now' : formatAgo(o.now - at)})`,
    })
  }
  // a listed id the index does not hold yet: alive only when a turn runs there
  for (const id of o.listed) {
    if (indexed.has(id) || id === o.claimant || !o.isRunning(id)) continue
    out.push({
      sessionId: id,
      folder: null,
      agent: '',
      title: 'untitled',
      at: null,
      running: true,
      live: true,
      says: `conversation ${id} (a turn is running now)`,
    })
  }
  const newest = (x: ClaimOther): number => x.at ?? Number.MAX_SAFE_INTEGER
  return out.sort((a, b) => newest(b) - newest(a))
}
