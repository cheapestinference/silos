// WhoCard.tsx — who the agent is, read-first: its name and whom it reports
// to (where it works is what it runs on — RunsOnCard, the card below). Why it acts — its mission — is the head of the page
// (MissionHeader: role and charter retired into it), so
// it is said there once, never repeated here. Edit sits where every card's
// action sits (top right) and swaps the EDITOR in for the body — the form
// never appears underneath the prose it edits.
import { useEffect, useMemo, useState } from 'react'
import { MASTER_ID, ANYWHERE_LABEL } from '../../lib/constants'
import { Section, SectionAction } from './Section'
import { SaveRolePack, SettingsTab } from './SettingsTab'
import type { AgentView } from '../../lib/types'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { orgSource } from '../../lib/org'
import { activeSilos, siloName } from '../../lib/silo-view'

// «Reports to Builder ›» — one line, only while a silo draws an agent → agent
// relation and this agent has a live edge in it. No editor here:
// the relation is changed on its silo's page (each thing once); the name is
// the door to whom it reports to.
function ReportsToLine({ agentId }: { agentId: string }) {
  const silos = useStore((s) => s.silos)
  const source = useMemo(() => orgSource(silos), [silos])
  const siloTick = useStore((s) => s.siloTick)
  const agents = useStore((s) => s.agents)
  const [to, setTo] = useState<string | null>(null)
  useEffect(() => {
    if (!source) {
      setTo(null)
      return
    }
    let cancelled = false
    api.silos
      .relation(source.silo, source.relation)
      .then((r) => {
        if (!cancelled) setTo(r.edges.find((e) => e.from === agentId && !e.note)?.to ?? null)
      })
      .catch(() => {
        if (!cancelled) setTo(null)
      })
    return () => {
      cancelled = true
    }
  }, [source?.silo, source?.relation, agentId, siloTick]) // eslint-disable-line react-hooks/exhaustive-deps
  const boss = to ? agents.find((a) => a.id === to && !a.archived) : undefined
  if (!boss) return null
  return (
    <p className="mt-1 text-[12px] text-ink-3" data-testid="reports-to">
      Reports to{' '}
      <button
        type="button"
        onClick={() => useStore.getState().changePage({ kind: 'agent', id: boss.id })}
        className="text-ink-2 underline-offset-2 hover:text-terracotta hover:underline"
      >
        {boss.name} ›
      </button>
    </p>
  )
}

// «Writes Support ›» — the records silos this agent is bound to as producer
// (the owner's binding, changed on the silo's page — each thing once; the
// name is the door there). Said here because a bound agent that holds no
// record yet shows no tile: the binding is part of who it is, records or not.
// A protocol silo (Task mode) is the agent's control, said in Runs on.
function WritesLine({ agentId }: { agentId: string }) {
  const silos = useStore((s) => s.silos)
  const mine = useMemo(() => activeSilos(silos).filter((s) => !s.kernel && (s.producers ?? []).includes(agentId)), [silos, agentId])
  if (mine.length === 0) return null
  return (
    <p className="mt-1 text-[12px] text-ink-3" data-testid="writes-silos">
      Writes{' '}
      {mine.map((s, i) => (
        <span key={s.id}>
          {i > 0 ? ', ' : ''}
          <button
            type="button"
            onClick={() => useStore.getState().changePage({ kind: 'silo', id: s.id })}
            className="text-ink-2 underline-offset-2 hover:text-terracotta hover:underline"
          >
            {siloName(s)} ›
          </button>
        </span>
      ))}
    </p>
  )
}

export const ANYWHERE_ROLE = 'Start a conversation in any project'

export function WhoCard({ agent, editing, onEditingChange }: { agent: AgentView; editing: boolean; onEditingChange: (v: boolean) => void }) {
  const isMaster = agent.id === MASTER_ID
  const name = isMaster ? ANYWHERE_LABEL : agent.name
  return (
    <Section
      id="who"
      label="Who"
      action={
        editing ? null : (
          <span className="flex items-center gap-3">
            {/* the role as a file another Silos installs (New agent › From a role pack) */}
            {agent.id !== MASTER_ID ? <SaveRolePack agentId={agent.id} /> : null}
            <SectionAction onClick={() => onEditingChange(true)}>Edit</SectionAction>
          </span>
        )
      }
    >
      {editing ? (
        <SettingsTab agent={agent} inline fields="who" onDone={() => onEditingChange(false)} />
      ) : (
        <div className="max-w-[62ch]">
          <p className="font-display text-[16.5px] leading-snug text-ink">
            {isMaster ? (
              ANYWHERE_ROLE
            ) : (
              <>
                {agent.emoji ? `${agent.emoji} ` : ''}
                {name}
              </>
            )}
          </p>
          {!isMaster ? <ReportsToLine agentId={agent.id} /> : null}
          {!isMaster ? <WritesLine agentId={agent.id} /> : null}
        </div>
      )}
    </Section>
  )
}
