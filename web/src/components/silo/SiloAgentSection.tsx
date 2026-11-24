// SiloAgentSection.tsx — the `agent-section` slot (Silo Standard): on an
// agent's page, the records of every ACTIVE silo whose manifest asked for the
// slot (and the grant stands) that are anchored to THIS agent — a few open
// ones, those waiting on you first, the full list one click away on the
// silo's own page. Rendered only when the agent actually holds records of
// that silo. Support's compact section (agent/SupportSection.tsx, since
// deleted) is this slot parameterized by support's manifest; nothing here
// knows a silo by name.
//
// Moment (docs/product.md): the agent page answers «what is this agent
// handling» — a support agent's open cases belong there, next to its Now.
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { useStore } from '../../store'
import { activeSilos, siloName } from '../../lib/silo-view'
import type { AgentView, SiloDescriptor, SiloRecordsPage } from '../../lib/types'
import { Tile, PREVIEW_MAX } from '../Tile'

const IN_VIEW = 5

// the kind's noun from its qualified name ('support/case' → 'case')
const nounOf = (kindName: string): string => kindName.split('/').pop() ?? kindName
const plural = (n: number, noun: string): string => `${noun}${n === 1 ? '' : 's'}`

function OneSilo({ agent, silo }: { agent: AgentView; silo: SiloDescriptor }) {
  const changePage = useStore((s) => s.changePage)
  const siloTick = useStore((s) => s.siloTick)
  const [open, setOpen] = useState<SiloRecordsPage | null>(null)
  const [held, setHeld] = useState(0) // every record of the agent, folded or not
  useEffect(() => {
    let cancelled = false
    const facets = { agent: agent.id }
    Promise.all([
      api.silos.records(silo.id, { facets, folded: 'exclude', rank: 'needs-you', limit: IN_VIEW }),
      api.silos.records(silo.id, { facets, folded: 'include', limit: 1 }),
    ])
      .then(([o, all]) => {
        if (!cancelled) {
          setOpen(o)
          setHeld(all.matching)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setOpen(null)
          setHeld(0)
        }
      })
    return () => {
      cancelled = true
    }
  }, [agent.id, silo.id, siloTick])
  if (!open || held === 0) return null
  const noun = nounOf(open.kind.name)
  const more = Math.max(0, open.matching - open.records.length)
  const toList = (): void => changePage({ kind: 'silo', id: silo.id })
  // a tile on the agent's cover (never lists stacked one under
  // another): how many are open, the first few — those waiting on you first —
  // and the full list, with its state editing, one click away on the silo's page
  const waiting = open.records.filter((r) => r.needsYou).length
  return (
    <Tile
      testId={`silo-${silo.id}`}
      name={siloName(silo)}
      accent={waiting > 0}
      door={`All ${plural(2, noun)}`}
      onOpen={toList}
      lead={
        open.matching === 0
          ? `No open ${plural(2, noun)}.`
          : `${open.matching} open ${plural(open.matching, noun)}${waiting > 0 ? `, ${waiting} waiting on you` : ''}.`
      }
      lines={open.records.map((r) => ({ key: r.key, text: r.identity, meta: <span className={r.needsYou ? 'text-terracotta' : ''}>{r.stateLabel}</span> }))}
      more={more + open.records.length > PREVIEW_MAX ? `${more + open.records.length - PREVIEW_MAX} more` : null}
    />
  )
}

export function SiloAgentSections({ agent }: { agent: AgentView }) {
  const silos = useStore((s) => s.silos)
  const loadSilos = useStore((s) => s.loadSilos)
  useEffect(() => {
    void loadSilos()
  }, [loadSilos])
  const placed = activeSilos(silos).filter((s) => s.slots.granted.includes('agent-section'))
  if (placed.length === 0) return null
  return (
    <>
      {placed.map((s) => (
        <OneSilo key={s.id} agent={agent} silo={s} />
      ))}
    </>
  )
}
