// useOrgEdges — the live edges of the installed agent → agent relation (the
// first active silo that declares one — lib/org.ts orgSource), re-read on the
// `silos` WS tick. null while there is no such silo or before the first answer.
import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { orgSource, type OrgSource } from '../lib/org'
import type { SiloRelationEdge } from '../lib/types'

export function useOrgEdges(): { source: OrgSource | null; edges: SiloRelationEdge[] | null } {
  const silos = useStore((s) => s.silos)
  const siloTick = useStore((s) => s.siloTick)
  const source = useMemo(() => orgSource(silos), [silos])
  const [edges, setEdges] = useState<SiloRelationEdge[] | null>(null)
  const silo = source?.silo
  const relation = source?.relation
  useEffect(() => {
    if (!silo || !relation) {
      setEdges(null)
      return
    }
    let cancelled = false
    Promise.resolve(api.silos.relation(silo, relation))
      .then((r) => {
        if (!cancelled) setEdges(r.edges)
      })
      .catch(() => {
        if (!cancelled) setEdges([])
      })
    return () => {
      cancelled = true
    }
  }, [silo, relation, siloTick])
  return { source, edges }
}
