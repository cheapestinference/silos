// TaskExecutions.tsx — an SDD execution drawn where its task is: the task page's «Execution» section, the Tasks tree's leaf under
// its task, the Tasks footer's «N executions without a task». The moment
// (docs/product.md): «what's happening?» inside one piece of work — how far
// its execution got and whether something runs it now — without opening the
// conversation that ran it; one click opens that conversation, whose column
// carries the live Executing block.
//
// The one mark that is new here, the METER: one tick per task the execution
// counts (the document's tasks, else the ledger's) — filled green when
// complete, terracotta for the task in a fix round, hollow for the rest. It
// says the same as the line beside it («3 of 7 done · Task 4 fixing — round
// 1»), at a glance and in the PlanView's colours (✓ green, the terracotta of
// what is moving). Past 24 tasks it becomes a plain bar (ticks stop reading).
import { useStore } from '../../store'
import { docName, executionConversation, executionLine, type ExecutionView } from '../../lib/executions'
import type { AgentView } from '../../lib/types'
import { LiveMark } from './TaskBits'

const MAX_TICKS = 24

// «▸ SDD»: the mark an execution leaf carries — the triangle drawn, not a
// character (a geometric glyph is tofu in some fallback fonts, as PlanView found)
export function SddMark() {
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5 font-mono text-[10.5px] text-ink-3" title="an SDD execution">
      <svg viewBox="0 0 16 16" width="9" height="9" aria-hidden="true" className="block">
        <path d="M5.5 3.8 11.5 8l-6 4.2z" fill="currentColor" />
      </svg>
      SDD
    </span>
  )
}

export function ExecutionMeter({ e, className = '' }: { e: Pick<ExecutionView, 'done' | 'total' | 'fixingTask' | 'state'>; className?: string }) {
  const label = `${e.done} of ${e.total} done${e.fixingTask !== null && e.state !== 'done' ? `, task ${e.fixingTask} in a fix round` : ''}`
  if (e.total <= 0) return null
  if (e.total > MAX_TICKS) {
    const pct = Math.min(100, Math.round((e.done / e.total) * 100))
    return (
      <span role="img" aria-label={label} className={`inline-flex h-[5px] w-24 overflow-hidden rounded-full bg-panel ${className}`}>
        <span className={`h-full rounded-full ${e.state === 'done' ? 'bg-emerald-600 dark:bg-emerald-400' : 'bg-terracotta'}`} style={{ width: `${pct}%` }} />
      </span>
    )
  }
  // which ticks are complete is not in the record (only how many): they fill
  // from the left, the fixing task sits right after them
  return (
    <span role="img" aria-label={label} data-testid="execution-meter" className={`inline-flex items-center gap-[2px] ${className}`}>
      {Array.from({ length: e.total }, (_, i) => {
        const done = i < e.done
        const fixing = !done && e.state === 'fixing' && i === e.done
        return (
          <span
            key={i}
            className={`h-[9px] w-[4px] rounded-[1.5px] ${
              done ? 'bg-emerald-600/85 dark:bg-emerald-400/85' : fixing ? 'bg-terracotta' : 'border border-ink-3/50'
            }`}
          />
        )
      })}
    </span>
  )
}

// what the mark at the row's head says: working now (the census), fixing,
// done, or quiet — the conversation rows' own column
function StateMark({ e, working }: { e: ExecutionView; working: boolean }) {
  if (working) return <LiveMark label="executing" />
  if (e.state === 'done')
    return (
      <span className="inline-flex items-center gap-1 text-[11.5px] text-emerald-700 dark:text-emerald-400">
        <span aria-hidden="true">✓</span>all done
      </span>
    )
  if (e.state === 'fixing') return <span className="text-[11.5px] text-terracotta">fixing</span>
  if (e.state === 'stopped') return <span className="text-[11.5px] text-ink-3">stopped</span>
  return <span className="text-[11.5px] text-ink-3">running</span>
}

// The task page's row: «<doc> · <agent>», the meter and the line; the whole
// row opens the conversation that wrote it (or, with none known, the record).
export function ExecutionRow({ e, agents, now }: { e: ExecutionView; agents: readonly AgentView[]; now: number }) {
  const openSession = useStore((s) => s.openSession)
  const changePage = useStore((s) => s.changePage)
  const conv = executionConversation(e, agents, now)
  const agent = agents.find((a) => a.id === (e.agent ?? conv.agentId))
  const open = (): void => {
    if (conv.session) void openSession(conv.session.folder, conv.session.id)
    else changePage({ kind: 'silo', id: 'executions', recordKey: e.key })
  }
  return (
    <li data-testid="task-execution" data-state={conv.working ? 'working' : e.state}>
      <button type="button" onClick={open} className="group flex w-full items-start gap-3 rounded-lg py-2 text-left hover:bg-panel/60 sm:-mx-2 sm:px-2">
        <span className="w-[7.5rem] shrink-0 pt-px">
          <StateMark e={e} working={conv.working} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate text-[13.5px] text-ink">{e.title}</span>
            <span className="shrink-0 font-mono text-[11px] text-ink-3 max-sm:hidden" title={e.doc ?? e.ledger}>
              {docName(e)}
            </span>
          </span>
          <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <ExecutionMeter e={e} />
            <span className="text-[11.5px] text-ink-2" data-testid="task-execution-line" title={e.otherLedgersSay ?? undefined}>
              {executionLine(e, now)}
            </span>
          </span>
          <span className="mt-0.5 block text-[11.5px] text-ink-3">
            {agent
              ? `${agent.emoji ? `${agent.emoji} ` : ''}${agent.name}`
              : e.session
                ? 'a conversation Silos no longer lists'
                : 'no conversation is known to have run it'}
            {e.edge === 'document' ? ' · it executes the document this task names' : ''}
          </span>
        </span>
        <span className="shrink-0 pt-px text-[12px] text-ink-2 group-hover:text-terracotta">{conv.session ? 'Open ›' : 'Record ›'}</span>
      </button>
    </li>
  )
}

// The Tasks tree's leaf under its task: ▸ SDD, the meter and the line
export function ExecutionLeaf({ e, agents, now, depth }: { e: ExecutionView; agents: readonly AgentView[]; now: number; depth: number }) {
  const openSession = useStore((s) => s.openSession)
  const changePage = useStore((s) => s.changePage)
  const conv = executionConversation(e, agents, now)
  const open = (): void => {
    if (conv.session) void openSession(conv.session.folder, conv.session.id)
    else changePage({ kind: 'silo', id: 'executions', recordKey: e.key })
  }
  return (
    <li data-testid="tree-execution">
      <button
        type="button"
        onClick={open}
        className="group flex w-full items-center gap-2 rounded-lg px-2.5 py-1 text-left hover:bg-panel/70 focus-visible:bg-panel/70 focus-visible:outline-none"
        style={{ paddingLeft: `${0.625 + depth * 1.25 + 1.6}rem` }}
        title={`${e.title} — ${docName(e)}`}
      >
        <SddMark />
        <ExecutionMeter e={e} />
        <span className="min-w-0 truncate text-[11.5px] text-ink-2" title={e.otherLedgersSay ?? undefined}>
          {executionLine(e, now)}
        </span>
        {conv.working ? <LiveMark label="executing" /> : null}
      </button>
    </li>
  )
}
