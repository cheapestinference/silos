// Automations.tsx — this agent's automations, as a POINTER:
// one short row per automation (name · state word · next or last run) that
// opens the automation's own page — never its runs, never its actions, never
// an inline detail. An automation has one home (/automation/:id); the agent
// page says what the agent has and points. «New automation ›» opens the
// editor (/automation/new) with this agent already chosen.
import { useStore } from '../../store'
import { relTime } from '../../lib/rel-time'
import type { AgentView, Automation } from '../../lib/types'
import { isDone, doneLabel, nextRunIn, runStatusLabel, triggerSummary } from '../../lib/automations'
import { isBeatAutomation } from '../../lib/automations-signal'

// the plain word after the name — only when the row is not simply armed
// (the same vocabulary as AutomationsList). The agent's own heartbeat
// (heartbeat-*) never lists here: its home is the Heartbeat
// row above it in the same control block.
function stateWord(a: Automation, pending: boolean): string | null {
  if (pending) return 'needs your approval'
  if (isDone(a)) return 'done'
  if (a.paused) return 'paused'
  if (a.lastRun?.status === 'failed') return 'last run failed'
  if (a.approval) return 'asks first'
  return null
}

function Row({ automation, pending, nowMs, history = false }: { automation: Automation; pending: boolean; nowMs: number; history?: boolean }) {
  const openAutomation = useStore((s) => s.openAutomation)
  const done = isDone(automation)
  const word = stateWord(automation, pending)
  const alert = pending || automation.lastRun?.status === 'failed'
  const next = done || automation.paused || automation.trigger.kind === 'once' ? null : nextRunIn(automation, nowMs)
  const last = automation.lastRun
  return (
    <li data-testid="automation-item">
      <button
        type="button"
        onClick={() => openAutomation(automation.id)}
        className="flex w-full items-baseline gap-2 rounded px-1 py-1 text-left hover:bg-canvas/60"
      >
        <span className={`min-w-0 flex-1 truncate text-[13px] ${done ? 'text-ink-2' : 'text-ink'}`}>{automation.name}</span>
        {word ? <span className={`shrink-0 text-xs ${alert ? 'text-terracotta' : 'text-ink-2'}`}>{word}</span> : null}
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-2">
          {done
            ? doneLabel(automation)
            : // Now says how it went: its last run first, then the next
              history && last
              ? `last ${runStatusLabel(last.status)} ${relTime(Date.parse(last.at), nowMs)}${next ? ` · next ${next}` : ''}`
              : next
                ? `next ${next}`
                : last
                  ? `last ${runStatusLabel(last.status)} ${relTime(Date.parse(last.at), nowMs)}`
                  : triggerSummary(automation.trigger)}
        </span>
      </button>
    </li>
  )
}

// The same pointers as a row of the control block (Now): what you set this
// agent to run, beside the ladder that says what else starts without you
// (the list lived under Settings, a page away from the sentence
// that names it: «except the automations you set»). No count line, no box:
// the row's label already says what these are.
const ROWS_ON_NOW = 3

/** the Automations tab's figure: its automations (the heartbeat aside),
 *  accented when one failed or waits for approval */
export function useAgentAutomationsFigure(agentId: string): { n: number; alert: boolean } {
  const all = useStore((s) => s.automations)
  const pending = useStore((s) => s.automationsPending)
  const mine = all.filter((a) => a.agentId === agentId && !isBeatAutomation(a))
  const waiting = new Set(pending.map((r) => r.automationId))
  return { n: mine.length, alert: mine.some((a) => waiting.has(a.id) || a.lastRun?.status === 'failed') }
}

/** `history`: Now's rows — how its automations went, three at most, the
 *  whole list one door away on its Automations tab. `all`: that tab — every
 *  one, and «New automation ›». */
export function AgentAutomations({ agent, history = false, all = false }: { agent: AgentView; history?: boolean; all?: boolean }) {
  const allAutomations = useStore((s) => s.automations)
  const automations = allAutomations.filter((a) => a.agentId === agent.id && !isBeatAutomation(a))
  const pending = useStore((s) => s.automationsPending)
  const pendingIds = new Set(pending.map((r) => r.automationId))
  const nowMs = useStore((s) => s.nowTick)
  const add = (): void => useStore.getState().changePage({ kind: 'automation', id: 'new', agent: agent.id })
  // Now is the cover: the ones that need a look first, then the armed, three
  // rows at most — the whole list is one door away
  const rank = (a: Automation): number => (pendingIds.has(a.id) || a.lastRun?.status === 'failed' ? 0 : isDone(a) ? 3 : a.paused ? 2 : 1)
  const sorted = [...automations].sort((a, b) => rank(a) - rank(b))
  const shown = all ? sorted : sorted.slice(0, ROWS_ON_NOW)
  const openTab = (): void => {
    useStore.getState().changePage({ kind: 'agent', id: agent.id })
    useStore.getState().changeTab('control')
  }
  if (history && automations.length === 0) {
    return (
      <p className="text-[12.5px] text-ink-2" data-testid="agent-automations">
        None yet ·{' '}
        <button type="button" onClick={openTab} className="hover:text-terracotta">
          Automations ›
        </button>
      </p>
    )
  }
  return (
    <div id="automations" className="flex min-w-0 scroll-mt-4 flex-col gap-0.5" data-testid="agent-automations">
      {automations.length === 0 ? (
        <p className="text-[12.5px] text-ink-2">
          None yet ·{' '}
          <button type="button" onClick={add} className="hover:text-terracotta">
            New automation ›
          </button>
          <span className="text-ink-3"> — or tell {agent.name} in its console: it proposes, you accept in one touch</span>
        </p>
      ) : (
        <>
          <ul className="-mx-1 divide-y divide-line/60">
            {shown.map((a) => (
              <Row key={a.id} automation={a} pending={pendingIds.has(a.id)} nowMs={nowMs} history={history} />
            ))}
          </ul>
          <p className="flex flex-wrap gap-x-3 text-[12px] text-ink-2">
            {/* the rest live in their house — this agent's Automations page */}
            {history ? (
              <button type="button" data-testid="agent-automations-all" onClick={openTab} className="hover:text-terracotta">
                {automations.length > shown.length ? `All ${automations.length} ›` : 'Automations ›'}
              </button>
            ) : automations.length > shown.length ? (
              <button
                type="button"
                data-testid="agent-automations-all"
                onClick={() => useStore.getState().changePage({ kind: 'automations', agent: agent.id })}
                className="hover:text-terracotta"
              >
                All {automations.length} ›
              </button>
            ) : null}
            {history ? null : (
              <button type="button" onClick={add} className="hover:text-terracotta">
                New automation ›
              </button>
            )}
          </p>
        </>
      )}
    </div>
  )
}
