// AutomationsListPage.tsx — every automation as ONE list (/automations,
// ?agent=<id> narrowed to one agent): the rail's ⚡ door, the destination of
// each agent's ⚡ row, of its «All N ›» on Now and of Needs you's
// account-limit and failing-automations rows. One automation's own page is
// AutomationsPage (/automation/<id>) — this is the list that leads there.
// It lived as the Board's second tab until the Board retired: the Board's
// conversation views landed on Home,
// and the list kept its address. Its one facet is the agent — Tasks'
// grammar: the title stays «Automations», the narrowing is a
// removable chip, and the address says it as ?agent=.
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { tokenWords } from '../lib/usage'
import { listedMonthTokens, useFreshUsage } from './automation/AutomationUsage'
import { useStore } from '../store'
import { api, ApiError } from '../lib/api'
import { hourWords } from '../lib/proactive'
import { periodWords } from '../lib/period'
import { MASTER_ID } from '../lib/constants'
import { automationsPageView } from '../lib/automations-signal'
import { agentInPlay, openCheckIn, PAUSED_BEAT_WORDS } from '../lib/beat-home'
import { isBeatAutomation } from '../lib/automations-signal'
import { openAgentControl } from './agent/doors'
import { AutomationsList } from './AutomationsList'
import { FacetBar } from './FacetBar'
import { NO_FILTER, type ActiveFilter } from '../lib/facets'
import { HeaderButton, PageHeader } from './PageHeader'

// The agent facet: which agents have automations, the narrowed one chosen.
// One agent at a time (the address holds one): choosing another replaces it,
// the chip's × (or Clear all) widens back to every automation.
function AgentFilter({ agentId }: { agentId: string | undefined }) {
  const all = useStore((s) => s.automations)
  const agents = useStore((s) => s.agents)
  const changePage = useStore((s) => s.changePage)
  const values = useMemo(() => {
    const n = new Map<string, number>()
    for (const a of all) if (!isBeatAutomation(a)) n.set(a.agentId, (n.get(a.agentId) ?? 0) + 1)
    if (agentId && !n.has(agentId)) n.set(agentId, 0)
    const order = new Map(agents.map((a, i) => [a.id, i]))
    return [...n.entries()]
      .sort(([x], [y]) => (order.get(x) ?? 1e9) - (order.get(y) ?? 1e9))
      .map(([id, count]) => {
        const row = agents.find((a) => a.id === id)
        return { value: id, label: row ? (row.id === MASTER_ID ? 'Anywhere' : row.name) : id, count }
      })
  }, [all, agents, agentId])
  const filter = useMemo<ActiveFilter>(() => (agentId ? { agent: new Set([agentId]) } : NO_FILTER), [agentId])
  return (
    <FacetBar
      className="mb-4"
      facets={[{ id: 'agent', label: 'Agent', values }]}
      filter={filter}
      onChange={(f) => {
        const chosen = [...(f.agent ?? [])]
        const next = chosen.find((v) => v !== agentId) ?? chosen[0]
        changePage(next ? { kind: 'automations', agent: next } : { kind: 'automations' })
      }}
    />
  )
}

// an empty state keeps the chip that narrowed it — the way back is on screen
function EmptyState({ filter, children }: { filter: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col">
      <div className="mx-auto w-full max-w-3xl px-4 pt-5">{filter}</div>
      <div data-testid="automations-empty" className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        {children}
      </div>
    </div>
  )
}

// Automations: ONE list (AutomationsList.tsx — the Board lens
// and its state facet repeated each other, and on the Board every healthy
// automation sat in "Done today" beside the failed ones). ?agent= shows that
// agent's alone, under the chip that says so.
function AutomationsBody({ agentId }: { agentId: string | undefined }) {
  const all = useStore((s) => s.automations)
  const agents = useStore((s) => s.agents)
  const changePage = useStore((s) => s.changePage)
  // beats (heartbeat-*) never enumerate here (one shared
  // predicate) but the page NAMES them, each with its doors — its runs (its
  // own page) and its rhythm (its agent's control block): that agent's when
  // filtered, every agent's on the whole list — Needs
  // you lands on the whole list for a limit that stopped several agents'
  // beats, and each must stay reachable (automationsPageView).
  // …while their agent is in play: an archived (or unknown) agent's beat is
  // kept paused by design and has no page — named in plain words, no door
  // (beat-home.ts; third review round: the door once opened a real console)
  const view = useMemo(() => automationsPageView(all, agentId, (id) => agentInPlay(agents, id)), [all, agentId, agents])
  const automations = view.listed
  const nameOf = (id: string): string => {
    const row = agents.find((a) => a.id === id)
    return row ? (row.id === MASTER_ID ? 'Anywhere' : row.name) : id
  }
  const name = agentId ? nameOf(agentId) : undefined
  const realAgents = agents.filter((a) => a.id !== MASTER_ID && !a.archived).length
  const paused = view.pausedBeatAgentIds
  // the agent facet: the narrowing said, and the way to narrow from here
  const filter = <AgentFilter agentId={agentId} />
  // the one door an archived agent has: restoring it (Settings › Archived agents)
  const restoreDoor = (
    <button type="button" onClick={() => changePage({ kind: 'settings', tab: 'archived' })} className="font-medium text-terracotta hover:underline">
      Restore in Settings › Archived agents ›
    </button>
  )
  const pausedLine =
    paused.length > 0 ? (
      <p data-testid="automations-beat-paused" className="shrink-0 border-b border-line px-4 py-1.5 text-xs text-ink-2">
        {paused.length === 1
          ? `«${nameOf(paused[0]!)}» — ${PAUSED_BEAT_WORDS}`
          : `${paused.map((id) => `«${nameOf(id)}»`).join(', ')} — archived, their heartbeats stopped`}{' '}
        · {restoreDoor}
      </p>
    ) : null

  if (view.empty === 'paused') {
    return (
      <EmptyState filter={filter}>
        <p className="text-sm text-ink">
          {paused.length === 1
            ? `The only automation here is «${nameOf(paused[0]!)}»’s heartbeat`
            : 'The only automations here are heartbeats of archived agents'}
        </p>
        <p className="max-w-sm text-xs leading-relaxed text-ink-2">
          {paused.length === 1
            ? `«${nameOf(paused[0]!)}» is ${PAUSED_BEAT_WORDS} until the agent is restored.`
            : 'Their agents are archived — each heartbeat comes back when its agent is restored.'}{' '}
          {restoreDoor}
        </p>
      </EmptyState>
    )
  }

  // Nothing here yet: an explicit empty state, measured on what THIS page
  // shows (the agent's, when filtered) — never a blank list.
  if (view.empty === 'beats') {
    const only = view.beatAgentIds
    return (
      <EmptyState filter={filter}>
        <p className="text-sm text-ink">
          {only.length === 1 ? `${nameOf(only[0]!)}’s only automation is its heartbeat` : 'The only automations are heartbeats'}
        </p>
        <ul className="text-xs leading-relaxed text-ink-2">
          {only.map((id) => (
            <BeatRow key={id} agentId={id} name={nameOf(id)} />
          ))}
        </ul>
        {pausedLine}
      </EmptyState>
    )
  }
  if (view.empty === 'none') {
    return (
      <EmptyState filter={filter}>
        <p className="text-sm text-ink">{agentId ? `No automations for ${name} yet.` : 'No automations yet.'}</p>
        {/* the empty state: the owner's own
            door first; the agent's way is a proposal, accepted in one touch —
            never a promise that it «will decide» (told and own·never don't) */}
        <p className="max-w-sm text-xs leading-relaxed text-ink-2">
          <button
            type="button"
            data-testid="automations-empty-new"
            onClick={() => changePage({ kind: 'automation', id: 'new', ...(agentId ? { agent: agentId } : {}) })}
            className="font-medium text-terracotta hover:underline"
          >
            New automation ›
          </button>
          {realAgents === 0
            ? ' — create an agent first and it can propose its own.'
            : ` — or tell ${name ?? 'an agent'} in its console: it proposes, you accept in one touch. An agent On its own may also decide one in its weekly think.`}
        </p>
      </EmptyState>
    )
  }

  const beats = view.beatAgentIds
  if (beats.length === 0 && !pausedLine) return <AutomationsList automations={automations} filter={filter} />
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {beats.length > 0 ? (
        <ul data-testid="automations-beat-door" className="shrink-0 border-b border-line px-4 py-1.5 text-xs text-ink-2">
          {beats.map((id) => (
            <BeatRow key={id} agentId={id} name={nameOf(id)} />
          ))}
        </ul>
      ) : null}
      {pausedLine}
      <AutomationsList automations={automations} filter={filter} />
    </div>
  )
}

// A heartbeat's row: «X's heartbeat · <period words>
// · Runs › · Rhythm › · Run now» — Runs its own page, Rhythm the agent's
// control block where the period is set (a sentence must never name a
// place without a door), Run now the heartbeat's own (held by the spend cap
// and the account, never by the max — its 409 said here in the server's words).
function BeatRow({ agentId, name }: { agentId: string; name: string }) {
  const period = useStore((s) => s.agents.find((a) => a.id === agentId)?.heartbeat?.period ?? null)
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const run = (): void => {
    setBusy(true)
    setSaid(null)
    api.agents
      .heartbeatRunNow(agentId)
      .then(() => {
        void useStore.getState().loadAutomations?.()
      })
      .catch((e: unknown) => {
        const text = e instanceof Error ? e.message : String(e)
        // the instant the refusal names, sent apart (its words end before
        // the time): said in local time, as the heartbeat rows say hours
        const until = e instanceof ApiError && typeof (e.body as { until?: unknown } | null)?.until === 'string' ? (e.body as { until: string }).until : null
        setSaid(until && !Number.isNaN(Date.parse(until)) ? `${text.replace(/\s+$/, '')} ${hourWords(until)}` : text)
      })
      .finally(() => setBusy(false))
  }
  return (
    <li data-testid={`beat-row-${agentId}`} className="py-0.5">
      <span className="text-ink">{name}’s heartbeat</span>
      {period ? (
        <>
          {' '}
          · <span>{periodWords(period)}</span>
        </>
      ) : null}
      {' · '}
      <button type="button" data-testid={`beat-row-${agentId}-runs`} onClick={() => openCheckIn(agentId)} className="hover:text-terracotta">
        Runs ›
      </button>
      {' · '}
      <button
        type="button"
        data-testid={`beat-row-${agentId}-rhythm`}
        onClick={() => openAgentControl(agentId)}
        title={`Its rhythm and hour — on ${name}’s page`}
        className="hover:text-terracotta"
      >
        Rhythm ›
      </button>
      {' · '}
      <button
        type="button"
        data-testid={`beat-row-${agentId}-run`}
        disabled={busy}
        onClick={run}
        className="font-medium text-terracotta hover:underline disabled:opacity-50"
      >
        Run now
      </button>
      {said ? (
        <span role="alert" className="text-terracotta">
          {' '}
          — {said}
        </span>
      ) : null}
    </li>
  )
}

// the Automations band's one line: what the list below holds, counted the
// way the list counts it (beats are not enumerated, so not counted either)
function AutomationsFacts({ agentId }: { agentId: string | undefined }) {
  const all = useStore((s) => s.automations)
  const agents = useStore((s) => s.agents)
  const view = useMemo(() => automationsPageView(all, agentId, (id) => agentInPlay(agents, id)), [all, agentId, agents])
  const listed = view.listed
  const paused = listed.filter((a) => a.paused).length
  const month = listedMonthTokens(listed)
  if (listed.length === 0) return <span>{view.beatAgentIds.length > 0 || view.pausedBeatAgentIds.length > 0 ? 'Only heartbeats' : 'No automations yet'}</span>
  return (
    <>
      <span className="shrink-0">
        {listed.length} {listed.length === 1 ? 'automation' : 'automations'}
      </span>
      <span aria-hidden="true" className="text-ink-3">
        ·
      </span>
      <span className="shrink-0">{listed.length - paused} armed</span>
      {paused > 0 ? (
        <>
          <span aria-hidden="true" className="text-ink-3">
            ·
          </span>
          <span className="shrink-0">{paused} paused</span>
        </>
      ) : null}
      {/* what the rows below spent this month, summed (the owner's read) */}
      {month !== null ? (
        <>
          <span aria-hidden="true" className="text-ink-3">
            ·
          </span>
          <span data-testid="automations-month" className="shrink-0">
            {tokenWords(month)} tokens this month
          </span>
        </>
      ) : null}
    </>
  )
}

export function AutomationsListPage() {
  const page = useStore((s) => s.page)
  const agentId = page?.kind === 'automations' ? page.agent : undefined
  // the month's spend, read fresh on arrival
  useFreshUsage('list')
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* the common band: a root page — no crumbs, its own
          name whatever the narrowing; the agent it is narrowed to is the
          chip above the list (Tasks' grammar) */}
      <PageHeader
        testId="automations-header"
        title="Automations"
        facts={<AutomationsFacts agentId={agentId} />}
        actions={
          <>
            {/* what the automations spent */}
            <HeaderButton
              testId="automations-usage"
              label="Usage"
              onClick={() => useStore.getState().changePage({ kind: 'usage', by: 'automation', ...(agentId ? { agent: agentId } : {}) })}
            >
              Usage ›
            </HeaderButton>
            {/* the automation editor, creating — with the agent the page is
              narrowed to already chosen */}
            <HeaderButton
              primary
              testId="new-automation"
              label="New automation"
              onClick={() => useStore.getState().changePage({ kind: 'automation', id: 'new', ...(agentId ? { agent: agentId } : {}) })}
            >
              New automation
            </HeaderButton>
          </>
        }
      />
      <AutomationsBody agentId={agentId} />
    </div>
  )
}
