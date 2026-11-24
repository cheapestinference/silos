// SiloTreePage.tsx — the page of an edge-only silo (Silo Standard relations):
// its `tree` view with the one editor of its relation, the places it shows
// in (the Tasks lens), and the escalation's one knob — the window between
// hops — with what is being asked about now. Nothing here knows the silo by
// name: the descriptor says the relation its tree draws.
//
// Moments (docs/product.md): «who answers for what» (moment 1, the fleet's
// shape) and the stuck task's road to the owner (moment 2); reached from
// Settings › Silos, from Map › Org («change who reports to whom») and from
// an agent's Who line.
import { useEffect, useState } from 'react'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { relTime } from '../../lib/rel-time'
import { PageHeader } from '../PageHeader'
import { siloName } from '../../lib/silo-view'
import { OrgByProject } from './OrgByProject'
import { SiloSeal, silosCrumb, SlotToggles } from './SiloPage'
import { useTasks } from '../../hooks/useTasks'
import { TaskPeek } from '../tasks/TaskBits'
import type { EscalationView, SiloDescriptor, SiloRelationEdge } from '../../lib/types'

export function SiloTreePage({ d, tree }: { d: SiloDescriptor; tree: { view: string; relation: string } }) {
  const siloTick = useStore((s) => s.siloTick)
  const changePage = useStore((s) => s.changePage)
  const [edges, setEdges] = useState<SiloRelationEdge[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    Promise.resolve(api.silos.relation(d.id, tree.relation))
      .then((r) => {
        if (!cancelled) {
          setEdges(r.edges)
          setError(null)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [d.id, tree.relation, siloTick])

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <PageHeader
        testId="silo-header"
        crumbs={[silosCrumb(changePage)]}
        seal={<SiloSeal />}
        title={siloName(d)}
        // an edge-only silo has no records to count: what it is, in one line
        facts={
          d.description ? (
            <span className="min-w-0 truncate" title={d.description}>
              {d.description}
            </span>
          ) : null
        }
      />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[56rem] px-4 pb-12 pt-3 sm:px-5">
          <SlotToggles silo={d} />
          <section className="mt-7">
            <h3 className="text-[13px] font-semibold text-ink">Org</h3>
            <p className="mt-0.5 max-w-[62ch] text-[12.5px] text-ink-2">
              Who reports to whom. A reporting line groups work and tells Silos whom to ask when a task sits untouched. It gives nobody access or authority over
              anyone.
            </p>
            <div className="mt-4">
              {error ? (
                <p role="alert" className="text-[13px] text-terracotta">
                  {error}
                </p>
              ) : edges === null ? (
                <p className="text-[13px] text-ink-3">Reading…</p>
              ) : (
                <OrgByProject silo={d.id} relation={tree.relation} edges={edges} editable onChanged={setEdges} />
              )}
            </div>
          </section>
          <EscalationPanel silo={d.id} />
        </div>
      </div>
    </div>
  )
}

const WINDOWS = [4, 8, 24, 48, 72] as const
// «untouched for 3d» — one word for the state, never «stuck»
const untouchedFor = (ago: string): string => (ago.endsWith(' ago') ? `untouched for ${ago.slice(0, -4)}` : `untouched ${ago}`)

// The escalation's one knob and what it is asking about now — each case one
// line (its ref, whose, who was asked), never the detail: the task's page has it.
function EscalationPanel({ silo }: { silo: string }) {
  const tasks = useTasks()
  const agents = useStore((s) => s.agents)
  const changePage = useStore((s) => s.changePage)
  const nowTick = useStore((s) => s.nowTick)
  const siloTick = useStore((s) => s.siloTick)
  const [view, setView] = useState<EscalationView | null>(null)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    Promise.resolve(api.silos.escalation())
      .then((v) => {
        if (!cancelled) setView(v)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [siloTick])
  const nameOf = (id: string): string => (id === 'owner' ? 'you' : (agents.find((a) => a.id === id)?.name ?? id))
  async function setWindow(h: number): Promise<void> {
    setError(null)
    try {
      setView(await api.silos.setEscalationWindow(h))
      setEditing(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  if (!view && !error) return null
  // baseline rows were already with their producer when the
  // chain started: nobody will be asked about them — not escalation cases
  const open = (view?.open ?? []).filter((c) => !c.baseline)
  const baseline = (view?.open ?? []).length - open.length
  return (
    <section className="mt-9 border-t border-line pt-5" data-testid="escalation-panel">
      <h3 className="text-[13px] font-semibold text-ink">When a task sits untouched</h3>
      <p className="mt-0.5 max-w-[62ch] text-[12.5px] text-ink-2">
        A task its owner left untouched gets one wake. If that changes nothing, Silos notes it, marks it blocked and asks one link up the chain at a time — a
        plain message, never an order — and comes to you last.
      </p>
      {view ? (
        <p className="mt-2 text-[12.5px] text-ink">
          Silos waits <span className="font-semibold">{view.windowHours} hours</span> between asks
          <span className="text-ink-3"> · </span>
          {editing ? (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              {WINDOWS.map((h) => (
                <button
                  key={h}
                  type="button"
                  onClick={() => void setWindow(h)}
                  aria-pressed={view.windowHours === h}
                  className={`rounded-full px-2 py-0.5 text-[12px] ${view.windowHours === h ? 'bg-terracotta-soft text-terracotta' : 'text-ink-2 hover:text-terracotta'}`}
                >
                  {h} h
                </button>
              ))}
              <button type="button" onClick={() => setEditing(false)} className="ml-1 text-[12px] text-ink-3 hover:text-ink">
                Cancel
              </button>
            </span>
          ) : (
            <button type="button" onClick={() => setEditing(true)} className="text-ink-2 underline-offset-2 hover:text-terracotta hover:underline">
              Change
            </button>
          )}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1 text-[12px] text-terracotta">
          {error}
        </p>
      ) : null}
      {open.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-1.5">
          {open.map((c) => {
            const asked = c.hops.map((h) => nameOf(h.to))
            const cut = c.kind === 'task' ? c.key.lastIndexOf('/tasks/') : -1
            return (
              <li key={c.id} className="text-[12.5px] text-ink-2">
                {cut > 0 ? (
                  <TaskPeek task={tasks.tasks.find((t) => t.key === c.key)}>
                    <button
                      type="button"
                      onClick={() => changePage({ kind: 'task', plan: c.key.slice(0, cut), task: c.key.slice(cut + 7), from: { kind: 'silo', id: silo } })}
                      className="text-ink hover:text-terracotta"
                    >
                      {c.ref}
                    </button>
                  </TaskPeek>
                ) : (
                  <span className="text-ink">
                    {c.siloName ?? c.silo}: {c.title}
                  </span>
                )}
                <span>
                  {' '}
                  — {nameOf(c.who)}'s, {untouchedFor(relTime(Date.parse(c.since), nowTick))}
                </span>
                {asked.length > 0 ? <span> · asked {asked.join(', then ')}</span> : <span> · waiting for its window</span>}
              </li>
            )
          })}
        </ul>
      ) : view ? (
        <p className="mt-2 text-[12px] text-ink-3">Nothing is being asked about right now.</p>
      ) : null}
      {baseline > 0 ? (
        <p className="mt-1.5 text-[12px] text-ink-3">
          {baseline === 1 ? '1 row was' : `${baseline} rows were`} already with {baseline === 1 ? 'its' : 'their'} producer when the chain started —{' '}
          {baseline === 1 ? 'it stays' : 'they stay'} there and never {baseline === 1 ? 'rises' : 'rise'}.
        </p>
      ) : null}
    </section>
  )
}
