// OwnLimits.tsx — the two limits on what an agent does without you:
// how many times a day it may start without you
// (wakes, heartbeats, its own recurring work) and how much it may spend
// doing so. Named after the ladder they bound («What happens without you»):
// «On its own» is one of its positions, and these caps bind every
// position that starts anything. They are the control's own row, on Now, beside the ladder they
// bound and the day's count they are measured against (they lived in
// Settings › Runs on, a page away from «Started N times today · max C»).
// Absent = the server's default, which GET /api/agents says — never
// hard-coded here. Edited in place; empty = the default.
import { useEffect, useState } from 'react'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import type { AgentView } from '../../lib/types'

function useDefaults(): { turns: number | null; spend: number | null } {
  const [d, setD] = useState<{ turns: number | null; spend: number | null }>({ turns: null, spend: null })
  useEffect(() => {
    let cancelled = false
    Promise.resolve(api.agentDefaults?.())
      .then((v) => {
        if (!cancelled && v) setD(v)
      })
      .catch(() => {
        /* unread: «the default», without its figure */
      })
    return () => {
      cancelled = true
    }
  }, [])
  return d
}

type Field = 'ownTurnsPerDay' | 'unattendedSpendPerDay'

function Limit({
  agent,
  field,
  dflt,
  lead,
  label,
  unit,
  testId,
}: {
  agent: AgentView
  field: Field
  dflt: number | null
  lead: string
  label: string
  unit: (n: number) => string
  testId: string
}) {
  const loadOverview = useStore((s) => s.loadOverview)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const own = agent[field]
  const current = own ?? dflt
  async function save(): Promise<void> {
    const clear = draft.trim() === ''
    try {
      // the server checks the range and says it in its words
      await api.agents.update(agent.id, { [field]: clear ? null : Number(draft) })
      setEditing(false)
      setErr(null)
      void loadOverview()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }
  if (!editing) {
    return (
      <p className="text-[12.5px] text-ink" data-testid={testId}>
        {lead} {current !== null ? unit(current) : 'the default'}
        {own === undefined && current !== null ? <span className="text-ink-3"> (the default)</span> : null}
        {' · '}
        <button
          type="button"
          data-limit={field}
          onClick={() => {
            setDraft(own !== undefined ? String(own) : '')
            setEditing(true)
          }}
          className="text-ink-2 hover:text-terracotta"
        >
          change
        </button>
      </p>
    )
  }
  return (
    <form
      className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <span>{lead}</span>
      <input
        autoFocus
        type="number"
        min={1}
        step={field === 'unattendedSpendPerDay' ? 'any' : 1}
        placeholder={dflt !== null ? String(dflt) : 'default'}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-label={label}
        className="w-16 rounded border border-line bg-canvas px-1.5 py-0.5 text-[12px] tabular-nums outline-none focus:border-terracotta"
      />
      <span className="text-ink-2">a day</span>
      <button type="submit" className="rounded-full bg-terracotta px-3 py-0.5 text-[12px] font-medium text-canvas hover:opacity-90">
        Save
      </button>
      <button
        type="button"
        onClick={() => {
          setEditing(false)
          setErr(null)
        }}
        className="text-[12px] text-ink-2 hover:text-terracotta"
      >
        Cancel
      </button>
      {dflt !== null ? <span className="text-[11.5px] text-ink-3">empty = the default, {unit(dflt)}</span> : null}
      {err ? (
        <span role="alert" className="text-[12px] text-terracotta">
          {err}
        </span>
      ) : null}
    </form>
  )
}

export function OwnLimits({ agent, testId }: { agent: AgentView; testId: string }) {
  const defaults = useDefaults()
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-testid={testId}>
      <Limit
        agent={agent}
        field="ownTurnsPerDay"
        dflt={defaults.turns}
        lead="Starts without you:"
        label="Starts without you — up to how many a day"
        unit={(n) => `up to ${n} a day`}
        testId={`${testId}-turns`}
      />
      <Limit
        agent={agent}
        field="unattendedSpendPerDay"
        dflt={defaults.spend}
        lead="Spends without you:"
        label="Spends without you — up to how many dollars a day"
        unit={(n) => `up to $${n} a day`}
        testId={`${testId}-spend`}
      />
    </div>
  )
}
