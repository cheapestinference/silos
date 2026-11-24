import type { SessionMeta } from './types.js'
import type { LineageStore } from './lineage.js'

// ancestry.ts — the walk from a session to its ancestors, shared by the
// server (console key, thread root, parent for the sidebar) and by
// session-owner.ts (who a thread belongs to). ONE walk, so every surface
// agrees on what "this session's past" is.
//
// Every ancestor of a session, nearest first — THROUGH the ones whose
// transcript is gone. Burying history (an ancestor row trashed from
// Maintenance) never breaks the chain: lineage.json keeps the link, so
// the console, the owner and the sidebar row are still found past the
// buried session (otherwise one console shows as two rows, and a trash
// could kill the live claude). Bounded, cycle-safe.
// `continuation`: restrict to parents in the same project (a /clear
// rotation, a `--resume` twin) — a fork from another project is a
// different conversation (see LineageStore.continuationParentIdOf).
export interface Ancestry {
  parentIdOf(id: string, m: SessionMeta | null, continuation: boolean): string | null
  // `limit`: how far up (8 for classification/console keys; a sidebar
  // row's burial and a thread's root walk its whole history — Infinity).
  // `lookup`: the caller's own id → meta map for this walk (a reader that
  // walks many sessions builds it once instead of searching the index per
  // step); absent, the ancestry's own.
  ancestorIdsOf(m: SessionMeta, continuation: boolean, limit?: number, lookup?: (id: string) => SessionMeta | null): string[]
  // the nearest ancestor that is indexed NOW — the one a caller can read.
  nearestIndexedAncestor(m: SessionMeta, continuation: boolean): SessionMeta | null
}

export function makeAncestry(deps: { lineage: LineageStore | null; metaById: (id: string) => SessionMeta | null }): Ancestry {
  const { lineage, metaById } = deps
  const parentIdOf = (id: string, m: SessionMeta | null, continuation: boolean): string | null =>
    (continuation ? lineage?.continuationParentIdOf(id) : lineage?.parentIdOf(id)) ?? m?.resumedFrom ?? null
  const ancestorIdsOf = (m: SessionMeta, continuation: boolean, limit = 8, lookup: (id: string) => SessionMeta | null = metaById): string[] => {
    const out: string[] = []
    const seen = new Set<string>([m.id])
    let id = m.id
    let cur: SessionMeta | null = m
    for (;;) {
      const next = parentIdOf(id, cur, continuation)
      if (!next || seen.has(next) || out.length >= limit) return out
      seen.add(next)
      out.push(next)
      id = next
      cur = lookup(next)
    }
  }
  const nearestIndexedAncestor = (m: SessionMeta, continuation: boolean): SessionMeta | null => {
    for (const id of ancestorIdsOf(m, continuation)) {
      const meta = metaById(id)
      if (meta) return meta
    }
    return null
  }
  return { parentIdOf, ancestorIdsOf, nearestIndexedAncestor }
}
