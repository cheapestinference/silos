// AgentMeasures — Usage › 30 days › By agent: what each agent created on its
// own over the last 30 days, one row per agent. The
// moment it serves: judging, across the fleet, whose initiative pays off —
// the numbers that revise the limits (limits are revised by measurement,
// never by eye), beside what the same agents spent. Each agent's page says its own
// line (Now › Measured); here they sit side by side. It is not in Settings:
// a report is not a setting.
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useStore } from '../store'
import { api } from '../lib/api'
import type { AgentView, Measures } from '../lib/types'

type Row = { agent: AgentView; m: Measures | null }

export function AgentMeasures({ agents }: { agents: readonly AgentView[] }) {
  const changePage = useStore((s) => s.changePage)
  const [rows, setRows] = useState<Row[] | null>(null)
  const ids = agents.map((a) => a.id).join(',')

  useEffect(() => {
    let cancelled = false
    Promise.all(
      agents.map(async (agent) => {
        try {
          return { agent, m: await api.initiative.measures(agent.id) }
        } catch {
          return { agent, m: null }
        }
      }),
    ).then((r) => {
      if (!cancelled) setRows(r)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids])

  if (rows === null) return <p>Loading…</p>
  if (rows.length === 0) return <p>No agents yet.</p>

  const num = (n: number | undefined, accent = false): ReactNode => (
    <td
      className={`px-2 py-2 text-right font-mono text-[12px] tabular-nums ${n === undefined ? 'text-ink-3' : n === 0 ? 'text-ink-3' : accent ? 'text-terracotta' : 'text-ink'}`}
    >
      {n === undefined ? '—' : n}
    </td>
  )
  const th = 'px-2 pb-1.5 text-right text-[11px] font-normal text-ink-3'

  return (
    <div className="-mx-2 overflow-x-auto">
      <table className="w-full min-w-[34rem] border-collapse text-[13px]" data-testid="agent-measures">
        <thead>
          <tr>
            <th scope="col" rowSpan={2} className="px-2 pb-1.5 text-left align-bottom text-[11px] font-normal text-ink-3">
              Agent
            </th>
            <th scope="colgroup" colSpan={3} className="border-b border-line px-2 pb-1 text-center text-[11.5px] font-medium text-ink-2">
              Initiatives
            </th>
            <th scope="colgroup" colSpan={3} className="border-b border-line px-2 pb-1 text-center text-[11.5px] font-medium text-ink-2">
              From its inbox
            </th>
            <th scope="col" rowSpan={2} className={`${th} align-bottom`}>
              Refused by Silos
            </th>
            <th scope="col" rowSpan={2} className={`${th} align-bottom`}>
              After reading the web
            </th>
          </tr>
          <tr>
            <th scope="col" className={`${th} pt-1`}>
              created
            </th>
            <th scope="col" className={`${th} pt-1`}>
              kept
            </th>
            <th scope="col" className={`${th} pt-1`}>
              undone
            </th>
            <th scope="col" className={`${th} pt-1`}>
              created
            </th>
            <th scope="col" className={`${th} pt-1`}>
              kept
            </th>
            <th scope="col" className={`${th} pt-1`}>
              undone
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ agent, m }) => (
            <tr key={agent.id} className="border-t border-line" data-testid="agent-measures-row">
              <th scope="row" className="max-w-[12rem] px-2 py-2 text-left font-normal">
                <button type="button" onClick={() => changePage({ kind: 'agent', id: agent.id })} className="truncate text-ink hover:text-terracotta">
                  {agent.emoji} {agent.name}
                </button>
              </th>
              {num(m?.initiatives.created)}
              {num(m?.initiatives.kept)}
              {num(m?.initiatives.undone, true)}
              {num(m?.reactive.created)}
              {num(m?.reactive.kept)}
              {num(m?.reactive.undone, true)}
              {num(m?.rejected, true)}
              {num(m?.tainted, true)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
