// ProactiveSheet — «Make X proactive»: what choosing
// Proactive on the control opens, and what «change» on the Proactive row
// opens again. Before the click it says what the mode is (On its own reacts;
// Proactive also goes looking), how often it does a round — the period
// editor, with «≈ n rounds a day, from 08:22 — each one is a turn» from
// slotsPerDay over the period the server will stamp —, how many tasks a day
// it may create from its mission, what a round uses (its tools, with the
// connectors it will really have and that they act with their own
// permissions; or its files only), and what holds it. A missing mission or
// territory answers own's 409s with their doors.
// The moment it serves: «Direct» without the sentence (product.md, moment
// 3) — reached from the agent's page › Control › Proactive.
import { useId, useState, type ReactNode } from 'react'
import { api } from '../../lib/api'
import { useStore } from '../../store'
import { TERRITORY_DOOR_WORDS } from '../../lib/territory'
import { HEARTBEAT_RULES, draftOfPeriod, periodProblem, screenProblem, type Period, type PeriodDraft } from '../../lib/period'
import {
  FILES_ONLY_WORDS,
  PER_DAY_RANGE_WORDS,
  PROACTIVE_PER_DAY,
  PROACTIVE_PER_DAY_MAX,
  PROACTIVE_PER_DAY_MIN,
  connectorsWords,
  holdsWords,
  looseWords,
  perDayOk,
  roundsOfDraft,
  roundsWeeklyProblem,
  sheetBody,
  sheetIntro,
  sheetPeriod,
  sheetRoundsWords,
  sheetTitle,
} from '../../lib/proactive'
import type { AgentView, HeartbeatView, Position } from '../../lib/types'
import { PeriodEditor } from '../PeriodEditor'
import { Sheet } from '../Sheet'

export function ProactiveSheet({
  agent,
  from,
  period,
  view,
  ceiling,
  onClose,
  onDone,
  onDoor,
}: {
  agent: Pick<AgentView, 'id' | 'name' | 'proactive'>
  // the position the switch showed when Proactive was chosen
  from: Position
  // the agent's heartbeat period now (null: never)
  period: Period | null
  view: HeartbeatView | null
  // its starts a day (the max — «within its <C> starts a day»)
  ceiling: number
  onClose: () => void
  onDone: () => void
  // a 409's door: the mission editor, or its Settings (territory)
  onDoor: (door: 'mission' | 'territory') => void
}) {
  const loadOverview = useStore((s) => s.loadOverview)
  const [draft, setDraft] = useState<PeriodDraft>(() => draftOfPeriod(sheetPeriod(period)))
  const [perDay, setPerDay] = useState<string>(String(agent.proactive?.perDay ?? PROACTIVE_PER_DAY))
  const [tools, setTools] = useState<boolean>(agent.proactive?.tools ?? true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ text: string; door: 'mission' | 'territory' | null } | null>(null)
  const toolsGroup = useId()
  const perDayHint = useId()

  const stagger = view?.staggerMinute ?? 0
  const roundsNow = roundsOfDraft(draft, stagger)
  // what the server would refuse, said before the click: the period's 400,
  // or a week or more between rounds (its 409)
  const problem = periodProblem(draft, HEARTBEAT_RULES, stagger) ?? roundsWeeklyProblem(draft)
  const count = perDayOk(perDay)
  const pro = view?.proactive ?? null
  const connectors = pro?.connectors ?? []
  const [intro, more] = sheetIntro(agent.name, ceiling)
  // «change» on the Proactive row: the same sheet, its own title and Save
  const { title, button } = sheetTitle(agent.name, from === 'proactive')

  async function make(): Promise<void> {
    if (count === null || problem !== null) return
    setBusy(true)
    setError(null)
    try {
      await api.agents.update(agent.id, sheetBody(from, draft, count, tools))
      await loadOverview()
      onDone()
    } catch (e) {
      // a period's 400 in screen words (no field names); the rest as sent
      const text = screenProblem(e instanceof Error ? e.message : String(e), HEARTBEAT_RULES, draft, stagger)
      setError({ text, door: /mission/.test(text) ? 'mission' : /territory/.test(text) ? 'territory' : null })
    } finally {
      setBusy(false)
    }
  }

  const label = 'pt-[3px] text-[12.5px] leading-snug text-ink-3'
  const option = (on: boolean): string =>
    `mt-[3px] grid size-3.5 shrink-0 place-items-center rounded-full border transition-colors duration-150 ${on ? 'border-terracotta' : 'border-ink-3/60'}`

  return (
    <Sheet title={title} testId="proactive-sheet" onClose={onClose}>
      <div className="max-w-[36rem] pb-4 pt-3">
        <p className="text-[14px] leading-relaxed text-ink-2">{intro}</p>
        <p className="mt-1.5 text-[14px] leading-relaxed text-ink">{more}</p>

        <div className="mt-6 grid grid-cols-1 gap-x-5 gap-y-5 sm:grid-cols-[8.5rem_1fr]">
          <span className={label}>Does a round</span>
          <div data-testid="proactive-sheet-period">
            <PeriodEditor
              draft={draft}
              onChange={(d) => {
                setDraft(d)
                setError(null)
              }}
              problem={problem}
              staggerMinute={stagger}
              consequence={roundsNow ? <span data-testid="proactive-sheet-rounds">{sheetRoundsWords(roundsNow)}</span> : null}
              testId="proactive-sheet-period-form"
            />
          </div>

          <span className={label}>Creates up to</span>
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-1.5 text-[14px] text-ink">
              <input
                type="number"
                min={PROACTIVE_PER_DAY_MIN}
                max={PROACTIVE_PER_DAY_MAX}
                inputMode="numeric"
                aria-label="tasks a day from its mission"
                data-testid="proactive-sheet-perday"
                aria-invalid={count === null}
                aria-describedby={count === null ? perDayHint : undefined}
                value={perDay}
                onChange={(e) => {
                  setPerDay(e.target.value)
                  setError(null)
                }}
                className={`w-14 rounded-md border bg-canvas px-1.5 py-0.5 text-center text-[14px] tabular-nums outline-none focus:border-terracotta ${count === null ? 'border-terracotta' : 'border-line'}`}
              />
              <span className="text-ink-2">tasks a day from its mission</span>
            </div>
            {count === null ? (
              <p id={perDayHint} role="alert" data-testid="proactive-sheet-perday-problem" className="text-[12.5px] text-terracotta">
                {PER_DAY_RANGE_WORDS}
              </p>
            ) : null}
          </div>

          <span className={label}>On a round it uses</span>
          <div role="radiogroup" aria-label="On a round it uses" className="flex flex-col gap-3 text-[13.5px] leading-snug">
            <label className="flex cursor-pointer gap-2.5">
              <input
                type="radio"
                name={toolsGroup}
                checked={tools}
                onChange={() => setTools(true)}
                data-testid="proactive-sheet-tools"
                className="peer sr-only"
              />
              <span aria-hidden="true" className={`${option(tools)} peer-focus-visible:ring-2 peer-focus-visible:ring-terracotta/30`}>
                {tools ? <span className="size-1.5 rounded-full bg-terracotta" /> : null}
              </span>
              <span className="min-w-0">
                <span className="text-ink">its tools — skills, MCP servers, connectors and the web.</span>{' '}
                <span className="text-ink-2">What it reads outside can steer what it creates; each thing it decides after reading outside says so.</span>
                <span
                  data-testid="proactive-sheet-connectors"
                  className={`mt-1.5 block border-l-2 pl-2.5 text-[12.5px] ${tools ? 'border-terracotta/50 text-ink-2' : 'border-line text-ink-3'}`}
                >
                  {connectorsWords(
                    connectors.map((c) => c.name),
                    !!pro?.connectorsNote,
                  )}
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer gap-2.5">
              <input
                type="radio"
                name={toolsGroup}
                checked={!tools}
                onChange={() => setTools(false)}
                data-testid="proactive-sheet-files"
                className="peer sr-only"
              />
              <span aria-hidden="true" className={`${option(!tools)} peer-focus-visible:ring-2 peer-focus-visible:ring-terracotta/30`}>
                {!tools ? <span className="size-1.5 rounded-full bg-terracotta" /> : null}
              </span>
              <span className="min-w-0">
                <span className="text-ink">its files only.</span> <span className="text-ink-2">{FILES_ONLY_WORDS}</span>
              </span>
            </label>
          </div>
        </div>

        {/* what holds it, and what doesn't — both before the click */}
        <div className="mt-7 flex flex-col gap-2 border-t border-line pt-4 text-[13px] leading-relaxed text-ink-2">
          <p data-testid="proactive-sheet-holds">{lead(holdsWords(pro?.holds, pro?.today.openMax))}</p>
          <p data-testid="proactive-sheet-loose">{lead(looseWords(tools))}</p>
        </div>

        {error ? (
          <p role="alert" data-testid="proactive-sheet-error" className="mt-3 text-[12.5px] text-terracotta">
            {error.text.replace(/ ›$/, '')}
            {error.door === 'mission' ? (
              <>
                {' '}
                ·{' '}
                <button type="button" onClick={() => onDoor('mission')} className="underline-offset-2 hover:underline">
                  Write its mission ›
                </button>
              </>
            ) : null}
            {error.door === 'territory' ? (
              <>
                {' '}
                ·{' '}
                <button type="button" onClick={() => onDoor('territory')} className="underline-offset-2 hover:underline">
                  {TERRITORY_DOOR_WORDS}
                </button>
              </>
            ) : null}
          </p>
        ) : null}

        <div className="mt-5 flex items-center gap-4">
          <button
            type="button"
            data-testid="proactive-sheet-make"
            disabled={busy || problem !== null || count === null}
            onClick={() => void make()}
            className="rounded-full bg-terracotta px-4 py-1.5 text-[13.5px] font-medium text-canvas transition-opacity enabled:hover:opacity-90 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
          >
            {button}
          </button>
          <button type="button" onClick={onClose} className="text-[13.5px] text-ink-2 hover:text-terracotta">
            Cancel
          </button>
        </div>
      </div>
    </Sheet>
  )
}

// «What holds it:» / «What doesn't hold it:» lead their paragraph in ink —
// the reader finds the two at a glance; the rest stays secondary
function lead(s: string): ReactNode {
  const i = s.indexOf(':')
  return i < 0 ? (
    s
  ) : (
    <>
      <span className="font-medium text-ink">{s.slice(0, i + 1)}</span>
      {s.slice(i + 1)}
    </>
  )
}
