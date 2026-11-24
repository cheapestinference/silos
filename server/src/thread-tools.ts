// thread-tools.ts — the thread machinery the routes AND the task machinery
// read, moved out of buildServer so index.ts builds it
// once — after `terminals` and `origins` — and hands the same functions to
// both (buildServer falls back to making its own: most tests build it bare).
//
//   absorbRotations()   a console's `/clear` files its rotation for the
//                       server to pick up (LineageStore.absorbRotations) —
//                       cheap when the dir is empty. Lineage is written
//                       synchronously; the re-announce of each absorbed
//                       session goes through `announce`, a box buildServer
//                       fills inside its WS scope and that DEFERS the send
//                       (setImmediate): wherever the cache that triggered it
//                       expired, the read in course finishes first.
//   threadRootKey(m)    the key of a thread's ROOT — its topmost known
//                       ancestor (indexed or not), the session itself when it
//                       has none. "Is this session the thread's tip?" is
//                       measured from here (lineage.recentTipOf).
//   recentTipOf(…)      that question, answered (the console route's guard).
//   continuableOf(…)    the R5 rule: a conversation can be continued when it
//                       is not a run's transcript AND it is the recent tip of
//                       its lineage thread.
// Types only.
import type { SessionMeta } from './types.js'
import type { LineageStore } from './lineage.js'
import type { SessionIndex } from './session-index.js'
import type { TerminalService } from './terminal-service.js'
import type { Ancestry } from './ancestry.js'
import type { TranscriptOnly } from './transcript-only.js'

export interface AnnounceBox {
  send: (keys: string[]) => void
}

export function makeAbsorbRotations(o: {
  lineage: LineageStore | null | undefined
  terminals: Pick<TerminalService, 'rotationsDir'>
  index: Pick<SessionIndex, 'allSessions' | 'isReady'>
  announce: AnnounceBox
}): () => void {
  return () => {
    const { lineage, terminals, index } = o
    if (!lineage || !terminals.rotationsDir) return
    const keys = lineage.absorbRotations(
      terminals.rotationsDir,
      (id) => index.allSessions().find((m) => m.id === id)?.folder ?? null,
      (key) => index.allSessions().find((m) => `${m.folder}/${m.id}` === key)?.mtime ?? null,
      index.isReady(),
    )
    if (keys.length > 0) o.announce.send(keys)
  }
}

// The root walks the WHOLE chain (cycle-guarded by the walk): a console
// /clear'd nine times is still one thread — a bounded walk split it at the
// 9th rotation. `lookup`: a caller's id → meta map built once for its read.
export function makeThreadRootKey(o: {
  ancestry: Pick<Ancestry, 'ancestorIdsOf'>
  lineage: LineageStore | null | undefined
  metaById: (id: string) => SessionMeta | null
}): (m: SessionMeta, lookup?: (id: string) => SessionMeta | null) => string {
  return (m, lookup) => {
    const byId = lookup ?? o.metaById
    const ids = o.ancestry.ancestorIdsOf(m, true, Infinity, lookup)
    for (let i = ids.length - 1; i >= 0; i--) {
      const meta = byId(ids[i]!)
      if (meta) return `${meta.folder}/${meta.id}`
      const folder = o.lineage?.folderOfKnown(ids[i]!)
      if (folder) return `${folder}/${ids[i]}`
    }
    return `${m.folder}/${m.id}`
  }
}

// The recent tip of `m`'s lineage thread, as a `<folder>/<id>` key — `m`'s
// own key when there is no lineage. The tip is the most recently ACTIVE of
// the thread, measured from its ROOT (a stale fork has no newer descendant
// of its own, yet it is not where the thread continues).
export function recentTipOf(
  o: { lineage: LineageStore | null | undefined; threadRootKey: (m: SessionMeta) => string },
  metas: readonly SessionMeta[],
  m: SessionMeta,
): string {
  if (!o.lineage) return `${m.folder}/${m.id}`
  const mtimes = new Map(metas.map((x) => [`${x.folder}/${x.id}`, x.mtime]))
  return o.lineage.recentTipOf(o.threadRootKey(m), (k) => mtimes.get(k) ?? null)
}

export function continuableOf(
  o: { transcriptOnly: TranscriptOnly; lineage: LineageStore | null | undefined; threadRootKey: (m: SessionMeta) => string },
  metas: readonly SessionMeta[],
): (m: SessionMeta) => boolean {
  const mtimes = new Map(metas.map((x) => [`${x.folder}/${x.id}`, x.mtime]))
  return (m) => {
    if (o.transcriptOnly(m) !== null) return false
    if (!o.lineage) return true
    return o.lineage.recentTipOf(o.threadRootKey(m), (k) => mtimes.get(k) ?? null) === `${m.folder}/${m.id}`
  }
}
