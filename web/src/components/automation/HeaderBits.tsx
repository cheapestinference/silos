// HeaderBits.tsx — the two lines under an automation's name, shared by its
// page (AutomationsPage.tsx) and its editor (AutomationEditor.tsx), so the
// header reads the same whether you are looking or editing: the cadence is
// the band's facts line (PageHeader), the belonging sentence its note.
import { useStore } from '../../store'
import { MASTER_ID, ANYWHERE_LABEL } from '../../lib/constants'
import { basename } from '../../lib/routes'
import { relTime } from '../../lib/rel-time'
import { automationRunsOnLabel } from '../../lib/runs-on'
import { argvLine, argvShort, commandOf, doneLabel, isDone, nextRunWhen, runStatusLabel, triggerSummary } from '../../lib/automations'
import { ANYWHERE_ROLE } from '../agent/WhoCard'
import type { AgentView, Automation, CommandRun, Thread } from '../../lib/types'
import { missionLine } from '../../lib/mission'
import { Fact } from '../PageHeader'

// WHERE it runs: an agent's own folder; for Anywhere, the project its kept
// thread is aimed at (a real path — see automationsInScope), else nowhere
// in particular.
export function folderOf(agentId: string, thread: Thread, agent: AgentView | undefined): string | null {
  if (agentId === MASTER_ID) {
    const f = thread.mode === 'keep' ? thread.folder : undefined
    return f && f.startsWith('/') ? f : null
  }
  return agent?.folder ?? null
}

// "with 🛠 Builder, role · in folder" — the same sentence, weight and links as
// the conversation header's subtitle (AgentPage's ConversationSubtitle). A
// command automation leads with what it runs: "runs `python3 sync.py` · for
// 🧭 Finance · in acme" — paths by their last name; the literal
// argv rides the title and the page's command block.
// `oneLine`: in the common band it is one line that truncates (the role
// gives way first), never a second row that moves the tabs and actions.
export function BelongingSentence({
  agentId,
  thread,
  agent,
  command,
  oneLine = false,
}: {
  agentId: string
  thread: Thread
  agent: AgentView | undefined
  command?: CommandRun | null
  oneLine?: boolean
}) {
  const isMaster = agentId === MASTER_ID
  const name = isMaster ? ANYWHERE_LABEL : (agent?.name ?? agentId)
  const role = isMaster ? ANYWHERE_ROLE : missionLine(agent)
  const emoji = isMaster ? (agent?.emoji ?? '✳') : (agent?.emoji ?? '❔')
  const folder = command?.cwd && command.cwd.startsWith('/') ? command.cwd : folderOf(agentId, thread, agent)
  return (
    <p
      // oneLine holds on desktop; a phone's band is too narrow for one
      // line of it — there it wraps like the page's own sentence
      className={`flex min-w-0 flex-wrap items-center gap-x-1 text-ink-2 ${oneLine ? 'mt-0.5 text-[12.5px] md:flex-nowrap md:overflow-hidden md:whitespace-nowrap' : 'text-[13px]'}`}
      data-testid="automation-belongs"
    >
      {command ? (
        <>
          <span>runs</span>
          <code
            data-testid="automation-belongs-command"
            title={argvLine(command.argv)}
            className="min-w-0 max-w-full shrink truncate rounded bg-canvas px-1 font-mono text-[12px] text-ink"
          >
            {argvShort(command.argv)}
          </code>
          <span aria-hidden="true">·</span>
          <span>for</span>
        </>
      ) : (
        <span>with</span>
      )}
      <button
        type="button"
        onClick={() => useStore.getState().selectAgent(agentId)}
        title="View agent"
        className={`flex min-w-0 items-center gap-1 rounded px-0.5 text-ink hover:text-terracotta ${oneLine ? 'max-w-full md:max-w-none md:shrink md:overflow-hidden' : 'max-w-full'}`}
      >
        <span aria-hidden="true">{emoji}</span>
        <span className="shrink-0 font-medium">
          {name}
          {role ? ',' : ''}
        </span>
        {role ? (
          <span className="truncate text-ink-2" title={role}>
            {role}
          </span>
        ) : null}
      </button>
      {folder ? (
        <>
          <span aria-hidden="true">·</span>
          {/* «in» travels with its folder — a wrap never leaves it alone */}
          <span className="flex min-w-0 max-w-full items-center gap-x-1">
            <span className="shrink-0">in</span>
            <button
              type="button"
              onClick={() => useStore.getState().changePage({ kind: 'project', folder })}
              title={folder}
              aria-label={`Open project ${basename(folder)}`}
              className={`rounded px-0.5 font-mono text-[12px] text-ink hover:text-terracotta ${oneLine ? 'max-w-full truncate md:min-w-0' : 'shrink-0'}`}
            >
              {basename(folder)}
            </button>
          </span>
        </>
      ) : null}
    </p>
  )
}

// the cadence, as the band's one line of facts: its state when it has one
// (paused · asks first · done) · what triggers it · what it runs on when not
// its agent's default · when next · how the last went. Facts truncate, never
// wrap — the title, actions and tabs keep their place.
export function AutomationFacts({ automation, stateWord = null }: { automation: Automation; stateWord?: string | null }) {
  const nowTick = useStore((s) => s.nowTick)
  const providers = useStore((s) => s.providers)
  const catalog = useStore((s) => s.catalog)
  const done = isDone(automation)
  // a once's trigger already says when; `next` would repeat it — and in the
  // words the list uses ("tomorrow 06:30"), never a countdown to the minute
  const next = done || automation.paused || automation.trigger.kind === 'once' ? null : nextRunWhen(automation, nowTick)
  const last = automation.lastRun
  // a command runs on no model: the label would say something untrue
  const on = commandOf(automation) ? null : automationRunsOnLabel(automation.runsOn, providers, catalog)
  const parts = [
    done ? doneLabel(automation) : triggerSummary(automation.trigger),
    on ? `on ${on}` : null,
    next ? `next ${next}` : null,
    last && !done ? `last ${runStatusLabel(last.status)} ${relTime(Date.parse(last.at), nowTick)}` : null,
  ].filter((p): p is string => !!p)
  // done says itself in the first part (doneLabel); the word would repeat it
  const word = done ? null : stateWord
  // each part its own fact: on a phone they wrap whole, never «daily 06:30…»
  return (
    <>
      {word ? (
        <Fact testId="automation-state" className="font-medium text-terracotta">
          {word}
        </Fact>
      ) : null}
      <span data-testid="automation-cadence" className="contents tabular-nums" title={parts.join(' · ')}>
        {parts.map((p, i) => (
          <Fact key={i} truncate>
            <span className="min-w-0 truncate" title={p}>
              {p}
            </span>
          </Fact>
        ))}
      </span>
    </>
  )
}
