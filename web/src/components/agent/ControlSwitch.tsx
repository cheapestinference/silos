// ControlSwitch — the agent's ONE setting for what happens without you:
// a ladder of three positions,
// [Only when told] [On its own] [Proactive] — each step does what the one
// below does, and more —, the sentence of the active one, and — On its own
// or Proactive — the heartbeat's row (its period, «change» opening the
// period editor, with «Never» —, «Runs ›» to its own page and
// «Run now» (the same verb as its page and the Automations list;
// «Wake now» is only the way out of Sleeping), its last turn, its last skip,
// when it comes next), the Proactive row (its count, its tools, or «Rounds
// are off» when cut) and the day's count («Started N times today · max C ›»).
// Choosing Proactive opens «Make X proactive» (ProactiveSheet.tsx); from
// Proactive, «On its own» sends `proactive: null`, no sheet. On a task's page
// (compact) «Proactive ›» is a door to the agent's page;
// under it — whatever the control, since what it decided outlives a flip —
// Decided (Decided.tsx) and the 30-day measure.
// The moment it serves: deciding how much an agent may do by itself, said
// where you look at the agent (its Now), and compactly where work is handed
// out (a task's page, New task). It replaced «Moves on its own».
//
// Switching to Only when told happens at once (the server supersedes the
// queued wakes in the same request); when something is still running the
// sheet says it and offers the two stops — a running turn («Let it finish ·
// Stop») and its own recurring work («Keep (it runs under Only when told) ·
// Pause too»). A refused switch (no mission, no territory) is said with its
// door: the mission editor, or its Settings, where its territory is turned on.
// Its two limits (starts a day, spend a day — OwnLimits) and its automations
// are rows of this block too: everything that happens without you
// is said, bounded and listed in ONE place.
import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, Radar, RefreshCw } from 'lucide-react'
import { useStore } from '../../store'
import { api, ApiError } from '../../lib/api'
import { openCheckIn } from '../../lib/beat-home'
import { heartbeatDayLine, measuredLine } from '../../lib/initiative'
import { agentPlanLine, agentSpendLine, weeklyPercent } from '../../lib/since'
import { taskPageOfKey } from '../../lib/task-origin'
import { seeTodayDoor } from '../../lib/usage-door'
import type { AgentView, ControlPending, HeartbeatSetting, HeartbeatView, Position } from '../../lib/types'
import {
  HEARTBEAT_RULES,
  capitalized,
  draftOfPeriod,
  periodDay,
  periodOfDraft,
  periodProblem,
  periodWords,
  screenProblem,
  type Period,
  type PeriodDraft,
} from '../../lib/period'
import {
  POSITIONS,
  PROACTIVE_PER_DAY,
  ROUNDS_OFF_WORDS,
  cutWords,
  editorRoundsWords,
  hourWords,
  neverInProactiveWords,
  proactiveRowWords,
  proactiveSentence,
  proactiveToolsWords,
  roundsOfDraft,
  roundsWeeklyProblem,
  shownPosition,
  skipRow,
  switchGesture,
  type SkipRow,
} from '../../lib/proactive'
import { OWN_TURNS_PER_DAY } from '../../../../server/src/limits'
import { PeriodEditor } from '../PeriodEditor'
import { Decided } from './Decided'
import { OwnLimits } from './OwnLimits'
import { TERRITORY_DOOR_WORDS } from '../../lib/territory'
import { openAgentControl, openAgentSettings } from './doors'
import { AgentAutomations } from './Automations'
import { ProactiveSheet } from './ProactiveSheet'

const heartbeatOf = (a: Pick<AgentView, 'heartbeat'>): HeartbeatSetting => a.heartbeat ?? { period: null }
// a row's label: its own column from 640 px, above its row on a phone
// (a third of 390 px is too much for a word)
const label = 'mt-2.5 text-[12px] text-ink-3 first:mt-0 sm:mt-0'

/** The sentence under the switch (its four variants),
 *  word for word: `rest` is the door to the period editor (▾), `tail`
 *  follows it. */
export function controlSentence(
  position: Position,
  period: Period | null,
  perDay = PROACTIVE_PER_DAY,
  state: { asleep?: boolean; cut?: boolean } = {},
): { lead: string; rest: string | null; tail: string } {
  if (position === 'told')
    return { lead: 'Opens with you. Nothing starts without you — except the automations you set, accepted or kept.', rest: null, tail: '' }
  // cut, a proactive agent does no rounds: its heartbeat looks and
  // thinks as On its own's — the sentence says so, never the rounds
  if (position === 'proactive' && period !== null && state.cut) {
    return { lead: ROUNDS_OFF_WORDS + '.', rest: `Looks at what arrived ${periodWords(period)}`, tail: ' and thinks about its mission once a week.' }
  }
  if (position === 'proactive' && period !== null) return proactiveSentence(period, perDay, state.asleep)
  const lead = 'Starts what you give it, then its next step.'
  if (period === null) return { lead, rest: "Doesn't look or think on its own", tail: '' }
  return {
    lead,
    rest: `Looks at what arrived ${periodWords(period)}`,
    tail: `${state.asleep ? ' once it wakes,' : ''} and thinks about its mission once a week. It doesn't go looking for work.`,
  }
}

/** The heartbeat row's schedule: its period's words — «Every 3 hours
 *  from 08:22 · 08:00–20:00» — or null (never: no row). */
export function scheduleWords(h: HeartbeatSetting): string | null {
  return h.period ? capitalized(periodWords(h.period)) : null
}

const when = hourWords

/** The heartbeat row's lines under its period: the last fire that took a turn — «Made its round 14:22 — decided
 *  2 things ›» · «Made its round 11:22 — nothing needed doing» (a look and a
 *  think say «Looked», «Thought») —; a later skip, in the words of the
 *  agent's own page, with its one door (skipRow) and the day's other skips
 *  folded behind it; when it comes next. Asleep: its sleep. `made.door`:
 *  what it decided is on this page (›). */
export function heartbeatLines(
  v: HeartbeatView,
  name: string,
  now = Date.now(),
): {
  made: { text: string; door: boolean } | null
  asleep: string | null
  skip: SkipRow | null
  more: SkipRow[]
  quiet: string | null
  next: string | null
} {
  const next = v.next ? `Next: ${when(v.next, now)}` : null
  if (v.sleeping) {
    const until = new Date(v.sleeping.until).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    return { made: null, asleep: `Sleeping until ${until}${v.sleeping.why ? ` — “${v.sleeping.why}”` : ''}`, skip: null, more: [], quiet: null, next: null }
  }
  const l = v.last
  const t = v.lastTurn ?? (l && !l.skipped ? l : null)
  let made: { text: string; door: boolean } | null = null
  if (t && t.kind) {
    const n = t.created.length + t.proposed.length
    const decided = `decided ${n === 1 ? 'one thing' : `${n} things`}`
    const verb = t.kind === 'round' ? 'Made its round' : t.kind === 'think' ? 'Thought' : 'Looked'
    made = { text: `${verb} ${when(t.at, now)} — ${n === 0 ? (t.kind === 'round' ? 'nothing needed doing' : 'decided nothing new') : decided}`, door: n > 0 }
  }
  // a skip after its last turn says its own words, then when it comes
  if (l && l.skipped && (!t || Date.parse(l.at) >= Date.parse(t.at))) {
    // an empty look is no skip at rest: it looked, and nothing had happened
    if (l.cause === 'empty' || /^nothing happened since/.test(l.skipped))
      return { made, asleep: null, skip: null, more: [], quiet: `Looked ${when(l.at, now)} — nothing happened`, next }
    const served = (v.skips ?? []).find((s) => s.at === l.at)
    const skip = skipRow(
      { at: l.at, cause: l.cause ?? served?.cause ?? null, kind: l.kind ?? served?.kind ?? null, reason: l.skipped, until: served?.until ?? null },
      name,
      now,
    )
    // the day's other skips (empty looks are no news), folded behind it
    const more = (v.skips ?? []).filter((s) => s.at !== l.at && s.cause !== 'empty').map((s) => skipRow(s, name, now))
    return { made, asleep: null, skip, more, quiet: null, next }
  }
  return { made, asleep: null, skip: null, more: [], quiet: null, next }
}

// The plan this agent's account is on, by ACCOUNT: the account is
// shared — «shared by N agents» says it, never attributes the use to X.
// null: not a Claude account (an API key says its $ instead), or no reading.
function usePlanShare(agent: AgentView, on: boolean): { percent: number; account: string; agents: number } | null {
  const agents = useStore((s) => s.agents)
  const provider = agent.provider ?? 'default'
  const [percent, setPercent] = useState<number | null>(null)
  useEffect(() => {
    if (!on) return
    let cancelled = false
    Promise.resolve(api.planUsage?.(provider))
      .then((u) => {
        if (!cancelled) setPercent(u && u.ok ? weeklyPercent(u.windows) : null)
      })
      .catch(() => {
        if (!cancelled) setPercent(null)
      })
    return () => {
      cancelled = true
    }
  }, [provider, on])
  if (percent === null) return null
  const sharing = agents.filter((a) => !a.archived && (a.provider ?? 'default') === provider).length
  return { percent, account: provider === 'default' ? 'your Claude account' : provider.slice(provider.indexOf(':') + 1), agents: sharing }
}

function useHeartbeat(agentId: string, on: boolean): { view: HeartbeatView | null; reload: () => void } {
  const [view, setView] = useState<HeartbeatView | null>(null)
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!on) {
      setView(null)
      return
    }
    let cancelled = false
    Promise.resolve(api.agents.heartbeat?.(agentId))
      .then((v) => {
        if (!cancelled) setView(v ?? null)
      })
      .catch(() => {
        if (!cancelled) setView(null) /* no row rather than a stale one */
      })
    return () => {
      cancelled = true
    }
  }, [agentId, on, n])
  return { view, reload: useCallback(() => setN((x) => x + 1), []) }
}

export function ControlSwitch({
  agent,
  compact = false,
  testId = 'control',
  part = 'all',
  onChanged,
}: {
  agent: AgentView
  // owner 24-11, split by tense: 'settings' = what it is set to do (the
  // ladder, its heartbeat's rhythm, Proactive, its limits — the agent's
  // Automations tab); 'activity' = what it did and what waits on you (its
  // rounds, Decided, Measured, Outside Silos — Now, which edits nothing)
  part?: 'all' | 'settings' | 'activity'
  // inside a sentence (New task) or a properties column (a task's page)
  compact?: boolean
  testId?: string
  onChanged?: () => void
}) {
  const loadOverview = useStore((s) => s.loadOverview)
  const changePage = useStore((s) => s.changePage)
  // the ladder's position as the owner set it (stored: «On its own» with a
  // proactive setting is Proactive); `control` is its first two steps
  const position = shownPosition(agent)
  const control = position === 'told' ? 'told' : 'own'
  const hb = heartbeatOf(agent)
  // read also under Only when told: Decided and the measure outlive the flip
  // (compact: only in Proactive, for its rounds a day)
  const { view, reload } = useHeartbeat(agent.id, !compact || position === 'proactive')
  const plan = usePlanShare(agent, !compact)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ text: string; door: 'mission' | 'territory' | null } | null>(null)
  const [pending, setPending] = useState<ControlPending | null>(null)
  const [stopped, setStopped] = useState<Set<string>>(new Set())
  const [kept, setKept] = useState<Set<string>>(new Set())
  // the period editor, open: its draft and the server's 400
  const [editing, setEditing] = useState<PeriodDraft | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const openEditor = (): void => {
    setEditing((d) => (d ? null : draftOfPeriod(hb.period)))
    setEditError(null)
  }
  // «Make X proactive», open: from the switch or the row's «change»
  const [making, setMaking] = useState(false)
  // «Run now» on the heartbeat row: busy, and the server's refusal in its words
  const [beatRun, setBeatRun] = useState<{ busy: boolean; said: string | null }>({ busy: false, said: null })
  const runBeatNow = (): void => {
    setBeatRun({ busy: true, said: null })
    Promise.resolve(api.agents.heartbeatRunNow(agent.id))
      .then(() => {
        setBeatRun({ busy: false, said: null })
        reload()
      })
      .catch((e: unknown) => {
        const text = e instanceof Error ? e.message : String(e)
        // the instant a refusal names rides apart: said in local time
        const until = e instanceof ApiError && typeof (e.body as { until?: unknown } | null)?.until === 'string' ? (e.body as { until: string }).until : null
        setBeatRun({ busy: false, said: until && !Number.isNaN(Date.parse(until)) ? `${text.replace(/\s+$/, '')} ${hourWords(until)}` : text })
      })
  }

  // a refusal's door: the mission (the head of Now), or its Settings, where
  // its territory is turned on
  const openTab = (tab: 'territory' | 'mission'): void => {
    if (tab === 'territory') {
      openAgentSettings(agent.id)
      return
    }
    changePage({ kind: 'agent', id: agent.id })
    useStore.getState().changeTab('mission')
  }
  // «Raise ›»: the limit's row, its editor open — in place when this block
  // shows it, else on the Automations tab once it has mounted
  const raise = (): void => {
    const find = (): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid="${testId}-limits"] [data-limit="ownTurnsPerDay"]`)
    const open = (el: HTMLElement): void => {
      el.scrollIntoView?.({ block: 'center' })
      el.click()
    }
    const here = find()
    if (here) {
      open(here)
      return
    }
    openAgentControl(agent.id)
    let tries = 0
    const look = (): void => {
      const el = find()
      if (el) open(el)
      else if (++tries < 20) setTimeout(look, 50)
    }
    setTimeout(look, 0)
  }

  async function patch(body: Parameters<typeof api.agents.update>[1]): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const r = await api.agents.update(agent.id, body)
      if (r?.pending) {
        setPending(r.pending)
        setStopped(new Set())
      }
      await loadOverview()
      reload()
      onChanged?.()
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e)
      setError({ text, door: /mission/.test(text) ? 'mission' : /territory/.test(text) ? 'territory' : null })
    } finally {
      setBusy(false)
    }
  }

  async function stop(body: { turns?: string[]; pause?: string[]; keep?: string[] }, key: string): Promise<void> {
    try {
      await api.agents.stop(agent.id, body)
      if (body.keep) setKept((s) => new Set([...s, key]))
      else setStopped((s) => new Set([...s, key]))
    } catch (e) {
      setError({ text: e instanceof Error ? e.message : String(e), door: null })
    }
  }

  // a touch on the ladder: Proactive opens the sheet — on a task's
  // page it is a door to the agent's page —; the rest PATCH at once
  const choose = (to: Position): void => {
    const g = switchGesture(position, to)
    if (!g) return
    if ('sheet' in g) {
      if (compact) {
        changePage({ kind: 'agent', id: agent.id })
        return
      }
      setError(null)
      setMaking(true)
      return
    }
    void patch(g.body)
  }
  const seg = (value: Position, words: string): React.ReactNode => {
    const on = position === value
    // only the chosen one is filled — never a tint on the steps below it,
    // which would read as a second selection (the sentence under the ladder
    // says what each position does)
    const door = compact && value === 'proactive' && !on
    return (
      <button
        key={value}
        type="button"
        role="radio"
        aria-checked={on}
        disabled={busy}
        onClick={() => choose(value)}
        data-testid={`${testId}-${value}`}
        title={door ? `${words} — on ${agent.name}'s page` : undefined}
        className={`inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[12px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/30 disabled:cursor-default min-[400px]:px-2.5 ${
          on ? 'bg-terracotta font-medium text-canvas' : 'text-ink-2 enabled:hover:bg-terracotta-soft enabled:hover:text-ink'
        }`}
      >
        {value === 'own' ? (
          <RefreshCw size={10} strokeWidth={2.2} aria-hidden="true" />
        ) : value === 'proactive' ? (
          <Radar size={10.5} strokeWidth={2.2} aria-hidden="true" />
        ) : null}
        {door ? `${words} ›` : words}
      </button>
    )
  }

  const perDay = agent.proactive?.perDay ?? PROACTIVE_PER_DAY
  // the rounds are off while it is cut, and wait while it sleeps: the
  // sentence never promises what won't come
  const pro = view?.proactive ?? null
  const cut = position === 'proactive' && (pro?.off === 'cut' || (!pro && !!agent.cut))
  const asleep = !!view?.sleeping || (!!hb.sleepUntil && Date.parse(hb.sleepUntil) > Date.now())
  const said = controlSentence(position, hb.period, perDay, { cut, asleep })
  // the period's door flows inside its sentence: an inline span with a
  // button's role, so a narrow column wraps it as words — a <button> is
  // always an inline BLOCK, and wrapped it became a centred slab
  const periodDoor =
    control === 'own' && said.rest ? (
      <span
        role="button"
        tabIndex={0}
        data-testid={`${testId}-period`}
        onClick={openEditor}
        aria-expanded={editing !== null}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            openEditor()
          }
        }}
        className="cursor-pointer rounded-sm text-ink-2 underline decoration-dotted underline-offset-2 hover:text-terracotta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/30"
      >
        {said.rest}
        <ChevronDown size={11} strokeWidth={2.2} aria-hidden="true" className="ml-0.5 inline-block align-[-1px]" />
      </span>
    ) : null

  const sentence = (
    <p data-testid={`${testId}-sentence`} className="text-[12.5px] leading-snug text-ink-2">
      {said.lead}
      {periodDoor ? (
        <>
          {' '}
          {periodDoor}
          {said.tail}
        </>
      ) : null}
    </p>
  )

  async function savePeriod(d: PeriodDraft): Promise<void> {
    setBusy(true)
    setEditError(null)
    try {
      // never, in Proactive: no rounds — back to On its own in the same
      // write (the editor said so before the click)
      await api.agents.update(agent.id, { heartbeat: { period: periodOfDraft(d) }, ...(d.never && position === 'proactive' ? { proactive: null } : {}) })
      setEditing(null)
      await loadOverview()
      reload()
      onChanged?.()
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  // what is wrong, before the click and in screen words: the server's own
  // parse and stamp (with this agent's staggered minute) and, in Proactive,
  // a week or more between rounds (the sheet's pre-check); a refusal that
  // still comes back is said in the same words
  const draftProblem = editing
    ? editError
      ? screenProblem(editError, HEARTBEAT_RULES, editing, view?.staggerMinute)
      : (periodProblem(editing, HEARTBEAT_RULES, view?.staggerMinute) ?? (position === 'proactive' ? roundsWeeklyProblem(editing) : null))
    : null
  // in Proactive the period's consequence is its rounds — over the
  // period the server will stamp; never there means back to On its own
  const editingRounds = editing && position === 'proactive' ? roundsOfDraft(editing, view?.staggerMinute ?? 0) : null
  const editorConsequence =
    editing?.never && position === 'proactive' ? neverInProactiveWords(agent.name) : editingRounds ? editorRoundsWords(editingRounds) : null
  const editor =
    editing && control === 'own' ? (
      <div data-testid={`${testId}-period-editor`} className="mt-1.5 w-full max-w-[34rem] rounded-lg border border-line bg-canvas/70 px-3 py-2.5">
        <PeriodEditor
          draft={editing}
          onChange={(d) => {
            setEditing(d)
            setEditError(null)
          }}
          allowNever
          staggerMinute={view?.staggerMinute}
          problem={draftProblem}
          consequence={position === 'proactive' ? editorConsequence : editing.never ? null : 'It only takes a turn when something arrived.'}
          testId={`${testId}-period-editor-form`}
        />
        <div className="mt-2.5 flex items-center gap-3 text-[12.5px]">
          <button
            type="button"
            disabled={busy || draftProblem !== null}
            data-testid={`${testId}-period-save`}
            onClick={() => void savePeriod(editing)}
            className="rounded-full bg-terracotta px-3 py-0.5 font-medium text-canvas transition-opacity enabled:hover:opacity-90 disabled:opacity-40"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(null)
              setEditError(null)
            }}
            className="text-ink-2 hover:text-terracotta"
          >
            Cancel
          </button>
        </div>
      </div>
    ) : null

  const schedule = control === 'own' ? scheduleWords(hb) : null
  const lines = view ? heartbeatLines(view, agent.name) : null
  // «decided N things ›» opens what it decided, where its Undo is: the
  // Decided rows of this page, brought into view and focused
  const showDecided = (): void => {
    const el = document.querySelector<HTMLElement>(`[data-testid="${testId}-decided"]`)
    if (!el) return
    const still = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView?.({ behavior: still ? 'auto' : 'smooth', block: 'center' })
    el.focus({ preventScroll: true })
  }
  // the day's skips beyond the last, folded behind it
  const [moreOpen, setMoreOpen] = useState(false)
  // a skip's one door: the caps' «Let it continue today» lifts
  // today's max and spend cap (Home's own gesture), Raise opens the limit's editor, in its row
  const continueToday = (): void => {
    void patch({ ownExemptDay: periodDay(Date.now()) })
  }
  const skipDoor = (s: SkipRow): React.ReactNode => {
    const quiet = 'text-ink-2 underline-offset-2 hover:text-terracotta hover:underline'
    if (s.door === 'continue') {
      return (
        <>
          {' '}
          ·{' '}
          <button
            type="button"
            disabled={busy}
            onClick={continueToday}
            data-testid={`${testId}-skip-continue`}
            className="font-medium text-terracotta underline-offset-2 hover:underline"
          >
            Let it continue today
          </button>{' '}
          ·{' '}
          <button type="button" onClick={raise} className={quiet}>
            Raise ›
          </button>
        </>
      )
    }
    if (s.door === 'usage')
      return (
        <>
          {' '}
          ·{' '}
          <button type="button" onClick={() => changePage(seeTodayDoor(agent.id))} className={quiet}>
            See usage ›
          </button>
        </>
      )
    if (s.door === 'engine')
      return (
        <>
          {' '}
          ·{' '}
          <button type="button" onClick={() => changePage({ kind: 'settings', tab: 'engines' })} className={quiet}>
            Update ›
          </button>
        </>
      )
    return null
  }
  // the day's count is On its own's; a told agent starts nothing by itself
  const today = control === 'own' ? (view?.today ?? null) : null
  const measured = measuredLine(view?.measures)
  // its heartbeat's day, apart from the max
  const beats = control === 'own' ? heartbeatDayLine(view?.beats) : null
  // its unattended turns on an API key that prices them: the $ of today
  // («+ n unpriced» beside it) — else the plan's share
  const spend = view?.today && view.today.priced === true && (view.today.costUsd > 0 || view.today.unpriced > 0) ? agentSpendLine(view.today) : null
  const planShare = !spend && plan ? agentPlanLine(plan.percent, plan.account, plan.agents) : null
  const outside = view?.outside ?? []

  const sheet = pending ? (
    <div role="status" data-testid={`${testId}-sheet`} className="mt-2 rounded-md border border-line bg-canvas/60 px-3 py-2 text-[12.5px] leading-snug">
      {pending.running.map((t) => (
        <p key={t.turnId} className="text-ink">
          Running now: {t.what} —{' '}
          {stopped.has(t.turnId) ? (
            <span className="text-ink-3">stopped</span>
          ) : (
            <>
              Let it finish ·{' '}
              <button type="button" onClick={() => void stop({ turns: [t.turnId] }, t.turnId)} className="text-terracotta hover:underline">
                Stop
              </button>
            </>
          )}
        </p>
      ))}
      {pending.stillRuns.map((a) => (
        <p key={a.id} className="text-ink">
          Still runs: {a.name} —{' '}
          {stopped.has(a.id) ? (
            <span className="text-ink-3">paused</span>
          ) : kept.has(a.id) ? (
            <span className="text-ink-3">kept — it runs under Only when told</span>
          ) : (
            <>
              <button type="button" onClick={() => void stop({ keep: [a.id] }, a.id)} className="text-terracotta hover:underline">
                Keep (it runs under Only when told)
              </button>{' '}
              ·{' '}
              <button type="button" onClick={() => void stop({ pause: [a.id] }, a.id)} className="text-terracotta hover:underline">
                Pause too
              </button>
            </>
          )}
        </p>
      ))}
      {pending.queued > 0 ? <p className="text-ink-2">Queued: {pending.queued} waiting wakes — they are dropped</p> : null}
      <p className="text-ink-2">Its heartbeat stops.</p>
      <button type="button" onClick={() => setPending(null)} className="mt-1 text-[12px] text-ink-3 hover:text-terracotta">
        Done
      </button>
    </div>
  ) : null

  const errorLine = error ? (
    <p role="alert" data-testid={`${testId}-error`} className="text-[12px] text-terracotta">
      {error.text.replace(/ ›$/, '')}
      {error.door === 'mission' ? (
        <>
          {' '}
          ·{' '}
          <button type="button" onClick={() => openTab('mission')} className="underline-offset-2 hover:underline">
            Write its mission ›
          </button>
        </>
      ) : null}
      {error.door === 'territory' ? (
        <>
          {' '}
          ·{' '}
          <button type="button" onClick={() => openTab('territory')} className="underline-offset-2 hover:underline">
            {TERRITORY_DOOR_WORDS}
          </button>
        </>
      ) : null}
    </p>
  ) : null

  // the ladder: three steps in a row; the filled one is the position, the
  // sentence under it says what that position does (the drawn stair
  // under the steps was removed — the owner read it as stray lines)
  const pills = (
    <span className={`inline-flex max-w-full flex-col ${busy ? 'opacity-70' : ''}`}>
      <span
        role="radiogroup"
        aria-label="What happens without you"
        className="inline-grid grid-cols-3 items-center gap-0.5 rounded-full border border-line bg-canvas/60 p-0.5"
      >
        {POSITIONS.map((p) => seg(p.value, p.words))}
      </span>
    </span>
  )
  const sheetOpen =
    making && !compact ? (
      <ProactiveSheet
        agent={agent}
        from={position}
        period={hb.period}
        view={view}
        ceiling={view?.today?.ceiling ?? agent.ownTurnsPerDay ?? OWN_TURNS_PER_DAY}
        onClose={() => setMaking(false)}
        onDone={() => {
          setMaking(false)
          reload()
          onChanged?.()
        }}
        onDoor={(door) => {
          setMaking(false)
          openTab(door === 'mission' ? 'mission' : 'territory')
        }}
      />
    ) : null

  if (compact) {
    return (
      <span data-testid={testId} className="flex min-w-0 flex-col items-start gap-1">
        {pills}
        {sentence}
        {editor}
        {errorLine}
        {sheet}
      </span>
    )
  }
  const sets = part !== 'activity'
  const acts = part !== 'settings'
  // Now's head: the position in words, one door to where it is set
  const positionWords = POSITIONS.find((p) => p.value === position)?.words ?? ''
  return (
    <div className="rounded-lg border border-line bg-panel/50 px-4 py-3" data-testid={testId}>
      <div className="grid grid-cols-1 items-baseline gap-x-3 gap-y-0.5 sm:grid-cols-[6.5rem_1fr] sm:gap-y-2">
        {sets ? (
          <>
            <span className={label}>Control</span>
            <div className="flex min-w-0 flex-col items-start gap-1">
              {pills}
              {sentence}
              {schedule ? null : editor}
              {errorLine}
              {sheet}
              {sheetOpen}
            </div>
          </>
        ) : (
          <>
            <span className={label}>Control</span>
            <div className="flex min-w-0 flex-col items-start gap-1">
              <p className="text-[12.5px] text-ink">
                <button
                  type="button"
                  data-testid={`${testId}-position-door`}
                  onClick={() => openAgentControl(agent.id)}
                  title={`Where ${agent.name}’s control is set — its Automations`}
                  className="hover:text-terracotta"
                >
                  {positionWords}
                  {schedule ? <span className="text-ink-2"> · {schedule}</span> : null} ›
                </button>
              </p>
              {errorLine}
            </div>
          </>
        )}
        {schedule ? (
          <>
            <span className={label}>Heartbeat</span>
            <div className="flex min-w-0 flex-col gap-0.5" data-testid={`${testId}-heartbeat`}>
              <p className="text-[12.5px] text-ink">
                {sets ? (
                  <>
                    {schedule} ·{' '}
                    <button
                      type="button"
                      data-testid={`${testId}-period-change`}
                      onClick={openEditor}
                      aria-expanded={editing !== null}
                      className="text-ink-2 hover:text-terracotta"
                    >
                      change
                    </button>
                  </>
                ) : null}
                {acts ? (
                  <>
                    {sets ? ' · ' : ''}
                    <button
                      type="button"
                      data-testid={`${testId}-heartbeat-runs`}
                      onClick={() => openCheckIn(agent.id)}
                      title={`${agent.name}’s heartbeat — every run, on its own page`}
                      className="text-ink-2 hover:text-terracotta"
                    >
                      Runs ›
                    </button>
                    {asleep ? null : (
                      <>
                        {' · '}
                        <button
                          type="button"
                          data-testid={`${testId}-heartbeat-run`}
                          disabled={beatRun.busy}
                          onClick={runBeatNow}
                          className="text-ink-2 hover:text-terracotta disabled:opacity-50"
                        >
                          Run now
                        </button>
                      </>
                    )}
                  </>
                ) : null}
              </p>
              {beatRun.said ? (
                <p role="alert" className="text-[12px] text-terracotta">
                  {beatRun.said}
                </p>
              ) : null}
              {sets ? editor : null}
              {acts && lines?.made ? (
                <p data-testid={`${testId}-made`} className="text-[12px] text-ink-2">
                  {lines.made.door && (view?.decided.length ?? 0) > 0 ? (
                    <button type="button" data-testid={`${testId}-made-door`} onClick={showDecided} className="text-left hover:text-terracotta">
                      {lines.made.text} ›
                    </button>
                  ) : (
                    lines.made.text
                  )}
                </p>
              ) : null}
              {acts && lines?.asleep ? (
                <p data-testid={`${testId}-last`} className="text-[12px] text-ink-2">
                  {lines.asleep} ·{' '}
                  <button type="button" onClick={() => void api.agents.heartbeatWake(agent.id).then(reload)} className="hover:text-terracotta">
                    Wake now
                  </button>
                </p>
              ) : null}
              {acts && lines?.quiet ? (
                <p data-testid={`${testId}-last`} className="text-[12px] text-ink-2">
                  {lines.quiet}
                </p>
              ) : null}
              {acts && lines?.skip ? (
                // a skipped fire is not one more grey line: in Proactive a
                // round that didn't happen is marked (its rounds are why
                // the mode exists); its one door beside it
                <div
                  data-testid={`${testId}-skip`}
                  data-round={lines.skip.round || position === 'proactive' ? 'true' : undefined}
                  className={`-ml-2 border-l-2 pl-1.5 text-[12px] ${position === 'proactive' ? 'border-terracotta' : 'border-line'}`}
                >
                  <p data-testid={`${testId}-last`} className="text-ink">
                    <span className={position === 'proactive' ? 'font-medium text-terracotta' : 'text-ink-2'}>Skipped {when(lines.skip.at)}</span>
                    <span className="text-ink-2"> — {lines.skip.text}</span>
                    {skipDoor(lines.skip)}
                  </p>
                  {lines.more.length > 0 ? (
                    <>
                      <button
                        type="button"
                        data-testid={`${testId}-skips-more`}
                        aria-expanded={moreOpen}
                        onClick={() => setMoreOpen((o) => !o)}
                        className="text-ink-3 hover:text-terracotta"
                      >
                        {lines.more.length} more skipped today {moreOpen ? '‹' : '›'}
                      </button>
                      {moreOpen ? (
                        <ul data-testid={`${testId}-skips-list`} className="mt-0.5 flex flex-col gap-0.5 text-ink-2">
                          {lines.more.map((s) => (
                            <li key={s.at}>
                              <span className="tabular-nums">{when(s.at)}</span> — {s.text}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </>
                  ) : null}
                </div>
              ) : null}
              {acts && lines?.next ? (
                <p data-testid={`${testId}-next`} className="text-[12px] text-ink-2">
                  {lines.next}
                </p>
              ) : null}
            </div>
          </>
        ) : null}
        {sets && position === 'proactive' ? (
          <>
            <span className={label}>Proactive</span>
            <div className="flex min-w-0 flex-col gap-0.5" data-testid={`${testId}-proactive-row`}>
              {cut ? (
                <p data-testid={`${testId}-proactive-off`} className="text-[12.5px] text-ink">
                  {cutWords(agent.cut?.why)} ·{' '}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void patch({ cut: null })}
                    className="font-medium text-terracotta underline-offset-2 hover:underline"
                  >
                    Allow again
                  </button>
                </p>
              ) : (
                (() => {
                  const row = proactiveRowWords(
                    pro?.today.perDay ?? perDay,
                    pro?.today.made ?? 0,
                    pro ? { n: pro.today.open, max: pro.today.openMax } : undefined,
                  )
                  return (
                    <>
                      <p className="text-[12.5px] text-ink">
                        {row.head} ·{' '}
                        {pro ? (
                          <>
                            <span data-testid={`${testId}-proactive-today`} className={row.atMax ? 'text-terracotta' : ''}>
                              {row.today}
                            </span>{' '}
                            ·{' '}
                          </>
                        ) : null}
                        <button
                          type="button"
                          data-testid={`${testId}-proactive-change`}
                          onClick={() => {
                            setError(null)
                            setMaking(true)
                          }}
                          className="text-ink-2 hover:text-terracotta"
                        >
                          change
                        </button>
                      </p>
                      {row.open ? <p className="text-[12px] text-terracotta">{row.open}</p> : null}
                      <p className="text-[12px] text-ink-2">{proactiveToolsWords(agent.proactive?.tools ?? true)}</p>
                    </>
                  )
                })()
              )}
            </div>
          </>
        ) : null}
        {/* what bounds it and what you set to run — whatever the position:
            an automation runs under Only when told too */}
        {sets ? (
          <>
            <span className={label}>Limits</span>
            <OwnLimits agent={agent} testId={`${testId}-limits`} />
          </>
        ) : null}
        {part === 'all' ? (
          <>
            <span className={label}>Automations</span>
            <AgentAutomations agent={agent} />
          </>
        ) : null}
        {part === 'activity' ? (
          <>
            {/* what it was set to run, as it went: last outcome, next run —
                their list and «New» are the Automations tab's */}
            <span className={label}>Automations</span>
            <AgentAutomations agent={agent} history />
          </>
        ) : null}
        {acts && view ? (
          <Decided
            agent={agent}
            items={view.decided}
            reactive={view.decidedReactive ?? 0}
            onChanged={() => {
              reload()
              void loadOverview()
            }}
            testId={`${testId}-decided`}
          />
        ) : null}
        {acts && (today || beats || measured || spend || planShare) ? (
          <>
            <span className={label}>Measured</span>
            <div data-testid={`${testId}-measured`} className="flex min-w-0 flex-col gap-0.5 text-[12px] text-ink-2">
              {today ? (
                <p>
                  <button type="button" onClick={raise} className={today.used >= today.ceiling ? 'text-terracotta hover:underline' : 'hover:text-terracotta'}>
                    Started {today.used} {today.used === 1 ? 'time' : 'times'} today · max {today.ceiling} ›
                  </button>
                </p>
              ) : null}
              {beats ? <p data-testid={`${testId}-measured-beats`}>{beats}</p> : null}
              {measured ? <p data-testid={`${testId}-measured-30d`}>{measured}</p> : null}
              {spend ? <p data-testid={`${testId}-measured-spend`}>{spend}</p> : null}
              {planShare ? <p data-testid={`${testId}-measured-plan`}>{planShare}</p> : null}
              {/* the agent's day in Usage — the same door as the caps' rows */}
              <p>
                <button
                  type="button"
                  data-testid={`${testId}-measured-usage`}
                  onClick={() => changePage(seeTodayDoor(agent.id))}
                  className="hover:text-terracotta"
                >
                  See today ›
                </button>
              </p>
            </div>
          </>
        ) : null}
        {/* its tasks nobody can be shown to have created:
            they don't start on their own — each opens its task, where «Keep
            it — it's mine» is (opening never blesses) */}
        {acts && outside.length > 0 ? (
          <>
            <span className={label}>Outside Silos</span>
            <div data-testid={`${testId}-outside`} className="flex min-w-0 flex-col gap-0.5 text-[12px] text-ink-2">
              <p>
                Added outside Silos: {outside.length} {outside.length === 1 ? 'task' : 'tasks'} — {agent.name} won't start{' '}
                {outside.length === 1 ? 'it' : 'them'} until you start or keep {outside.length === 1 ? 'it' : 'them'}
              </p>
              <ul className="flex flex-col gap-0.5">
                {outside.slice(0, 3).map((t) => {
                  const page = taskPageOfKey(t.key)
                  return (
                    <li key={t.key}>
                      {page ? (
                        <button type="button" onClick={() => changePage(page)} className="text-left text-ink hover:text-terracotta">
                          {t.title} ›
                        </button>
                      ) : (
                        <span className="text-ink">{t.title}</span>
                      )}
                    </li>
                  )
                })}
                {outside.length > 3 ? <li>…and {outside.length - 3} more</li> : null}
              </ul>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
