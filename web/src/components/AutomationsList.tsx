// AutomationsList.tsx — the Automations page: which automations exist,
// whose, on what schedule, and what each one did last time — so a long list
// full of dead probes still says what each one does. One list, no Board
// lens: an automation is a standing
// thing, not a task moving through columns — on the Board every healthy one
// sat in "Done today" next to the ones that had failed.
//
// Read top to bottom:
//   Needs a look — only when something is off: an armed automation whose
//                  last run failed (said in plain words) or a run waiting
//                  for the owner's go. Terracotta is spent here and on the
//                  same word in its row, nowhere else.
//   per agent    — each automation in
//                  two lines: name (+ its state when not simply armed) and
//                  what its last run did — or why it failed, or, before its
//                  first run, the prompt's first sentence; at the right, in
//                  mono, the cadence and next / last in words a person
//                  plans with, and what it runs on when that is not its
//                  agent's default. Finished one-shots fold under a count, with
//                  one action to clear them.
//
// The agent's heartbeat (heartbeat-<id>) is NOT enumerated here: its
// rhythm lives on the agent's Now (the control block's Heartbeat
// row), its runs on its own page — both doors in the page's beat row
// (AutomationsListPage BeatRow) and on that Now row.
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { CommandIcon } from '../lib/icons'
import { useStore } from '../store'
import { api } from '../lib/api'
import { MASTER_ID } from '../lib/constants'
import { relTime } from '../lib/rel-time'
import { automationRunsOnLabel } from '../lib/runs-on'
import { argvLine, argvShort, commandOf, doneLabel, isDone, lastRunLine, needsALook, nextRunWhen, promptGist, triggerSummary } from '../lib/automations'
import { isBeatAutomation } from '../lib/automations-signal'
import type { AgentView, Automation } from '../lib/types'
import { Tile, TileGrid, PREVIEW_MAX } from './Tile'
import { UsageSpark, monthMeta } from './automation/AutomationUsage'

function agentLabel(agents: readonly AgentView[], agentId: string): { name: string; emoji: string } {
  const a = agents.find((x) => x.id === agentId)
  if (!a) return { name: agentId, emoji: '❔' }
  return agentId === MASTER_ID ? { name: 'Anywhere', emoji: '✳' } : { name: a.name, emoji: a.emoji }
}

// the plain word after the name — only when the row is not simply armed
function stateWord(a: Automation, pending: boolean): { word: string; alert: boolean } | null {
  if (pending) return { word: 'needs your approval', alert: true }
  if (isDone(a)) return { word: 'done', alert: false }
  if (a.paused) return { word: 'paused', alert: false }
  if (a.lastRun?.status === 'failed') return { word: 'failed', alert: true }
  if (a.approval) return { word: 'asks first', alert: false }
  return null
}

// "next tomorrow 06:30 · ran 8h ago" / "never ran"
function whenLine(a: Automation, nowMs: number): string {
  const done = isDone(a)
  // a once's trigger already says when; `next` would repeat it
  const next = done || a.paused || a.trigger.kind === 'once' ? null : nextRunWhen(a, nowMs)
  const last = a.lastRun ? `ran ${relTime(Date.parse(a.lastRun.at), nowMs)}` : done ? null : 'never ran'
  return [next ? `next ${next}` : null, last].filter(Boolean).join(' · ')
}

function Row({ automation, pending, nowMs }: { automation: Automation; pending: boolean; nowMs: number }) {
  const openAutomation = useStore((s) => s.openAutomation)
  const providers = useStore((s) => s.providers)
  const catalog = useStore((s) => s.catalog)
  const done = isDone(automation)
  const state = stateWord(automation, pending)
  const did = lastRunLine(automation)
  // a command reads what it runs (paths by their last name), never a prompt
  // it may not even have; and it runs on no model — a terminal glyph stands
  // where the model would
  const command = commandOf(automation)
  const gist = did ? null : command ? argvShort(command.argv, 80) : promptGist(automation.prompt)
  // what it runs on, only when it is not its agent's default
  const on = command ? null : automationRunsOnLabel(automation.runsOn, providers, catalog)
  return (
    <li data-testid={`automation-row-${automation.id}`} className="border-b border-line/60 last:border-b-0">
      <button
        type="button"
        onClick={() => openAutomation(automation.id)}
        className="flex w-full flex-col items-start gap-1 px-1 py-2.5 text-left hover:bg-panel/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-terracotta sm:flex-row sm:gap-4"
      >
        <div className="w-full min-w-0 flex-1 sm:w-auto">
          <div className="flex items-baseline gap-2">
            <span className={`truncate text-sm ${done ? 'text-ink-2' : 'text-ink'}`}>{automation.name}</span>
            {state ? <span className={`shrink-0 text-xs ${state.alert ? 'text-terracotta' : 'text-ink-2'}`}>{state.word}</span> : null}
          </div>
          {did ? (
            <p data-testid="automation-row-did" className="mt-0.5 max-w-[62ch] truncate text-xs leading-relaxed text-ink-2" title={did.text}>
              {did.text}
            </p>
          ) : gist ? (
            <p
              data-testid="automation-row-gist"
              className={`mt-0.5 max-w-[62ch] truncate text-xs leading-relaxed text-ink-3 ${command ? 'font-mono' : ''}`}
              title={command ? argvLine(command.argv) : automation.prompt}
            >
              {gist}
            </p>
          ) : null}
        </div>
        {/* its month: whole weeks as a spark, the tokens in quiet mono */}
        <div className="shrink-0 self-start sm:self-center">
          <UsageSpark automation={automation} nowMs={nowMs} />
        </div>
        <div className="shrink-0 font-mono text-[11px] leading-5 text-ink-2 tabular-nums sm:text-right">
          <div className="flex items-center gap-1.5 sm:justify-end">
            {command ? (
              <span title="Runs a command — no Claude" className="flex shrink-0">
                <CommandIcon size={12} role="img" aria-label="Runs a command" data-testid="automation-row-command" className="text-ink-3" />
              </span>
            ) : null}
            <span>
              {done ? doneLabel(automation) : triggerSummary(automation.trigger)}
              {on ? <span data-testid="automation-row-runs-on"> · on {on}</span> : null}
            </span>
          </div>
          <div>{whenLine(automation, nowMs)}</div>
        </div>
      </button>
    </li>
  )
}

function Group({
  agentId,
  standing,
  done,
  pendingIds,
  nowMs,
}: {
  agentId: string
  standing: Automation[]
  done: Automation[]
  pendingIds: ReadonlySet<string>
  nowMs: number
}) {
  const agents = useStore((s) => s.agents)
  const { name, emoji } = agentLabel(agents, agentId)
  const [showDone, setShowDone] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const paused = standing.filter((a) => a.paused).length

  async function clearDone(): Promise<void> {
    setClearing(true)
    try {
      for (const a of done) await api.automations.delete(a.id)
      await useStore.getState().loadAutomations()
    } finally {
      setClearing(false)
      setConfirmClear(false)
    }
  }

  return (
    <section data-testid={`automations-group-${agentId}`} className="mb-7">
      <header className="flex items-baseline justify-between gap-3 border-b border-line pb-1.5">
        <h2 className="flex items-baseline gap-2 font-display text-base text-ink">
          <span aria-hidden="true">{emoji}</span>
          <span>{name}</span>
        </h2>
        <span className="font-mono text-[11px] text-ink-2 tabular-nums">
          {standing.length} {standing.length === 1 ? 'automation' : 'automations'}
          {paused > 0 ? ` · ${paused} paused` : ''}
          {done.length > 0 ? ` · ${done.length} done` : ''}
        </span>
      </header>
      {standing.length === 0 && done.length > 0 ? (
        <p className="px-1 py-2.5 text-xs text-ink-2">Nothing standing — every automation of {name} has finished.</p>
      ) : null}
      <ul>
        {standing.map((a) => (
          <Row key={a.id} automation={a} pending={pendingIds.has(a.id)} nowMs={nowMs} />
        ))}
      </ul>
      {done.length > 0 ? (
        <div className="mt-1 flex items-center justify-between gap-3 px-1">
          <button type="button" onClick={() => setShowDone((v) => !v)} className="text-xs text-ink-2 hover:text-ink">
            {showDone ? 'Hide' : 'Show'} {done.length} done
          </button>
          <button
            type="button"
            disabled={clearing}
            onClick={() => {
              if (!confirmClear) {
                setConfirmClear(true)
                return
              }
              void clearDone()
            }}
            onBlur={() => setConfirmClear(false)}
            className={`text-xs ${confirmClear ? 'text-terracotta' : 'text-ink-2 hover:text-terracotta'}`}
          >
            {clearing ? 'Clearing…' : confirmClear ? `Clear ${done.length} done — sure?` : 'Clear done'}
          </button>
        </div>
      ) : null}
      {showDone ? (
        <ul className="mt-1 border-t border-line/60">
          {done.map((a) => (
            <Row key={a.id} automation={a} pending={false} nowMs={nowMs} />
          ))}
        </ul>
      ) : null}
    </section>
  )
}

// an agent's automations as a tile: how many, what is off, and the first
// few with when they run next — the door to that agent's list
function AgentTile({
  agentId,
  standing,
  done,
  pendingIds,
  nowMs,
}: {
  agentId: string
  standing: Automation[]
  done: Automation[]
  pendingIds: ReadonlySet<string>
  nowMs: number
}) {
  const agents = useStore((s) => s.agents)
  const changePage = useStore((s) => s.changePage)
  const { name, emoji } = agentLabel(agents, agentId)
  const paused = standing.filter((a) => a.paused).length
  const off = standing.filter((a) => stateWord(a, pendingIds.has(a.id))?.alert).length
  const counts = [
    `${standing.length} ${standing.length === 1 ? 'automation' : 'automations'}`,
    off > 0 ? `${off} need${off === 1 ? 's' : ''} a look` : null,
    paused > 0 ? `${paused} paused` : null,
    done.length > 0 ? `${done.length} done` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <Tile
      testId={`automations-group-${agentId}`}
      name={counts}
      accent={off > 0}
      door="All"
      onOpen={() => changePage({ kind: 'automations', agent: agentId })}
      lead={
        <span className="flex items-center gap-2">
          <span aria-hidden="true">{emoji}</span>
          {name}
        </span>
      }
      lines={standing.map((a) => {
        const st = stateWord(a, pendingIds.has(a.id))
        // its month beside when it runs next, only when it spent
        const when = a.paused ? 'paused' : (nextRunWhen(a, nowMs) ?? '')
        const month = monthMeta(a)
        return {
          key: a.id,
          text: (
            <>
              {a.name}
              {st ? <span className={st.alert ? 'text-terracotta' : 'text-ink-2'}> · {st.word}</span> : null}
            </>
          ),
          meta: month ? (
            <>
              {when ? `${when} · ` : ''}
              <span title="tokens this month" className="text-ink-2">
                {month}
              </span>
            </>
          ) : (
            when
          ),
        }
      })}
      more={standing.length > PREVIEW_MAX ? `${standing.length - PREVIEW_MAX} more` : null}
    />
  )
}

// what the page leads with — only when something is off
function NeedsALook({ automations, pendingIds, nowMs }: { automations: readonly Automation[]; pendingIds: ReadonlySet<string>; nowMs: number }) {
  const agents = useStore((s) => s.agents)
  const openAutomation = useStore((s) => s.openAutomation)
  const items = needsALook(automations, pendingIds)
  if (items.length === 0) return null
  return (
    <section
      aria-label="Needs a look"
      data-testid="automations-needs-a-look"
      className="mb-7 rounded-lg border border-terracotta/30 bg-terracotta-soft/40 px-3 pb-1 pt-2"
    >
      <h2 className="text-xs font-medium text-terracotta">Needs a look</h2>
      <ul>
        {items.map(({ automation: a, text, at }) => (
          <li key={a.id}>
            <button
              type="button"
              onClick={() => openAutomation(a.id)}
              className="flex w-full flex-col items-start gap-0.5 py-1.5 text-left text-sm hover:text-terracotta focus-visible:outline focus-visible:outline-2 focus-visible:outline-terracotta sm:flex-row sm:items-baseline sm:gap-3"
            >
              <span className="min-w-0 flex-1 truncate">
                <span className="text-ink">{a.name}</span>
                <span className="text-ink-2"> · {agentLabel(agents, a.agentId).name}</span>
                <span className="text-ink-2"> — {text}</span>
              </span>
              {at ? <span className="shrink-0 font-mono text-[11px] text-ink-2 tabular-nums">failed {relTime(Date.parse(at), nowMs)}</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function AutomationsList({ automations, filter = null }: { automations: readonly Automation[]; filter?: ReactNode }) {
  const agents = useStore((s) => s.agents)
  const pending = useStore((s) => s.automationsPending)
  const nowTick = useStore((s) => s.nowTick)
  const pendingIds = useMemo(() => new Set(pending.map((r) => r.automationId)), [pending])

  // beats out, HERE in the lens (one shared predicate, automations-signal.ts):
  // the server's GET /api/automations stays complete and honest.
  const visible = useMemo(() => automations.filter((a) => !isBeatAutomation(a)), [automations])

  // groups in the sidebar's agent order; an automation of an agent not in
  // the registry (archived) still shows, last, under its id.
  const groups = useMemo(() => {
    const order = new Map(agents.map((a, i) => [a.id, i]))
    const byAgent = new Map<string, { standing: Automation[]; done: Automation[] }>()
    for (const a of visible) {
      const g = byAgent.get(a.agentId) ?? { standing: [], done: [] }
      ;(isDone(a) ? g.done : g.standing).push(a)
      byAgent.set(a.agentId, g)
    }
    return [...byAgent.entries()].sort(([x], [y]) => (order.get(x) ?? 1e9) - (order.get(y) ?? 1e9))
  }, [agents, visible])

  return (
    <div data-testid="automations-list" className="flex-1 overflow-y-auto">
      <div className={`mx-auto w-full px-4 py-5 ${groups.length === 1 ? 'max-w-3xl' : 'max-w-5xl'}`}>
        {filter}
        <NeedsALook automations={visible} pendingIds={pendingIds} nowMs={nowTick} />
        {/* one agent: its list. Several: a tile each (never
            lists stacked one under another) — the tile opens that agent's
            list, narrowed by its ?agent= chip */}
        {groups.length === 1 ? (
          groups.map(([agentId, g]) => <Group key={agentId} agentId={agentId} standing={g.standing} done={g.done} pendingIds={pendingIds} nowMs={nowTick} />)
        ) : (
          <TileGrid cols={2}>
            {groups.map(([agentId, g]) => (
              <AgentTile key={agentId} agentId={agentId} standing={g.standing} done={g.done} pendingIds={pendingIds} nowMs={nowTick} />
            ))}
          </TileGrid>
        )}
      </div>
    </div>
  )
}
