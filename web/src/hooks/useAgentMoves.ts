// useAgentMoves — where each agent stands on the control's ladder right now:
// GET /api/agents' `positionNow`
// (the server's DERIVED position — an `own` without its territory or
// mission operates as told; a proactive agent that is cut does no rounds:
// own), read ONCE for every reader (the sidebar's rows, Map › Org's cards)
// and again when the overview moves (a control changed on an agent's page).
import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { api } from '../lib/api'
import type { Position } from '../lib/types'

type Moves = ReadonlyMap<string, Exclude<Position, 'told'>>
let cache: { key: string; moves: Moves } | null = null
let inflight: { key: string; p: Promise<Moves> } | null = null
const EMPTY: Moves = new Map()

function load(key: string): Promise<Moves> {
  if (inflight?.key === key) return inflight.p
  // tests mock the api piecemeal: a missing method reads as «nobody»
  const p = Promise.resolve()
    .then(() => api.agents?.list?.())
    .then((list) => {
      const m = new Map<string, Exclude<Position, 'told'>>()
      for (const a of Array.isArray(list) ? list : []) {
        // positionNow when the server says it; else the control alone
        const at = a.positionNow ?? (a.controlNow === 'own' ? 'own' : 'told')
        if (at !== 'told') m.set(a.id, at)
      }
      cache = { key, moves: m }
      return m as Moves
    })
    .catch(() => cache?.moves ?? EMPTY)
  inflight = { key, p }
  return p
}

/** The agents that move without you, each with its position (own or
 *  proactive); one not in the map is Only when told. */
export function useAgentPositions(): Moves {
  const tick = useStore((s) => s.siloTick)
  // the agents' own control fields, as the overview carries them
  const sig = useStore((s) => s.agents.map((a) => `${a.id}:${a.control ?? ''}:${a.proactive ? 'p' : ''}:${a.cut ? 'c' : ''}`).join(','))
  const key = `${tick}|${sig}`
  const [moves, setMoves] = useState<Moves>(cache?.moves ?? EMPTY)
  useEffect(() => {
    let cancelled = false
    if (cache?.key === key) {
      setMoves(cache.moves)
      return
    }
    void load(key).then((m) => {
      if (!cancelled) setMoves(m)
    })
    return () => {
      cancelled = true
    }
  }, [key])
  return moves
}

/** Which agents are On its own right now — Proactive included (it is On its
 *  own and more). */
export function useAgentMoves(): ReadonlySet<string> {
  const m = useAgentPositions()
  return new Set(m.keys())
}

export function resetAgentMovesCache(): void {
  cache = null
  inflight = null
}
