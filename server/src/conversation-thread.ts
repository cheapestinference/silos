// conversation-thread.ts — ONE conversation as the processes of the System
// silo see it (silos/processes.ts): a `/clear` rotates the session id, so a
// conversation is its THREAD — the tip it continues at now (the most
// recently active descendant, lineage.recentTipOf) and every id the tip
// descends from. The process records attribute by any of those ids (the
// session a process inherited at its birth). Read by the engine's
// conversation lookup (index.ts), a conversation's processes route and the
// trash's «also stop» (server.ts) — one rule for all three.
import type { Ancestry } from './ancestry.js'
import type { LineageStore } from './lineage.js'
import type { SessionMeta } from './types.js'

export interface ThreadDeps {
  metas: readonly SessionMeta[]
  lineage: Pick<LineageStore, 'recentTipOf'> | null | undefined
  ancestry: Pick<Ancestry, 'ancestorIdsOf'>
}

export function conversationThread(meta: SessionMeta, d: ThreadDeps): { tip: SessionMeta; ids: string[] } {
  const byKey = new Map(d.metas.map((m) => [`${m.folder}/${m.id}`, m]))
  const mtimeOf = (k: string): number | null => byKey.get(k)?.mtime ?? null
  const tip = d.lineage ? (byKey.get(d.lineage.recentTipOf(`${meta.folder}/${meta.id}`, mtimeOf)) ?? meta) : meta
  return { tip, ids: [...new Set([meta.id, tip.id, ...d.ancestry.ancestorIdsOf(tip, true)])] }
}
