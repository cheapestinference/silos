// AutomationEditor.tsx — the automation editor: editing is a
// MODE of the automation's page, not a panel over it, and the same editor
// creates one (/automation/new). The header stays — the name is edited in
// place there, where it is read — and the body becomes:
//
//   left   what the agent should do — the prompt, the protagonist: a tall
//          sheet of comfortable reading text, the whole of it in view;
//   right  when it runs — the period first («Every [n] [unit]»,
//          PeriodEditor) and, under it, «or a cron
//          expression ›» opening the schedule as sentences (ScheduleBuilder);
//          how it runs — the conversation it lives in, asking first, waiting
//          out usage limits, a daily ceiling — each a sentence with its switch.
//
// A footer carries Cancel · Save. Any way out with unsaved changes (Cancel,
// Esc, the back arrow, browser back, any navigation) asks once, inline, in
// that footer — never a window.confirm (the viewer blocks it). Notify is not
// here (retired from every surface): it
// never fired anything; an edit doesn't send it, so a saved value rides
// along untouched, and a new one carries the server's required constant.
//
// What it runs:
// an agent turn, or a command run without Claude — one line of argv (quotes
// keep spaces together; nothing is expanded but $SILOS_AGENT_STATE), where it
// runs, and what happens when it fails: you are told, or the agent gets the
// prompt with the exit code and the log's tail. For a command the prompt is
// only that hand-over's, and what-it-runs-on is gone (no model runs it).
import { TemplateShelf } from './Templates'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { MASTER_ID, ANYWHERE_LABEL } from '../../lib/constants'
import { argvLine, argvShort, autoName, parseArgvLine, triggerSummary } from '../../lib/automations'
import { armLeaveGuard } from '../../lib/leave-guard'
import { navigateToRoute, replacing, routeOfState } from '../../lib/router'
import { defaultDraft, draftFromTrigger, draftProblem, triggerOfDraft, type ScheduleDraft } from '../../lib/schedule'
import { AutomationFacts, BelongingSentence } from './HeaderBits'
import { PageHeader, Seal } from '../PageHeader'
import { AutomationIcon } from '../../lib/icons'
import { ScheduleBuilder } from './ScheduleBuilder'
import { PeriodEditor } from '../PeriodEditor'
import {
  AUTOMATION_RULES,
  cadenceWords,
  capitalized,
  draftOfPeriod,
  periodOfDraft,
  periodProblem,
  screenProblem,
  slotsPerDay,
  stampedOfDraft,
  type PeriodDraft,
} from '../../lib/period'
import { isBeatAutomation } from '../../lib/automations-signal'
import { beatHomeOpen, PAUSED_BEAT_WORDS } from '../../lib/beat-home'
import { RunOnList, type RunOnPick } from '../RunOnList'
import { automationRunsOnLabel, canonicalProviderId, modelLabel, providerShortLabel } from '../../lib/runs-on'
import { useHarness } from '../../lib/harnesses'
import type { AgentView, Automation, AutomationRun, Thread, Trigger } from '../../lib/types'
import { missionLine } from '../../lib/mission'
import { openAgentControl } from '../agent/doors'

const DEFAULT_MAX_RUNS_PER_DAY = 24 // server/src/automations-types.ts
const DEFAULT_TIMEOUT_MIN = 10 // COMMAND_TIMEOUT_MS
const MAX_TIMEOUT_MIN = 60 // COMMAND_TIMEOUT_MAX_MS

interface Form {
  name: string
  nameTouched: boolean
  prompt: string
  agentId: string
  schedule: ScheduleDraft
  // the period first; 'cron' = the schedule as sentences
  when: 'period' | 'cron'
  period: PeriodDraft
  threadMode: 'new' | 'keep'
  folder: string // Anywhere's project (thread.folder)
  approval: boolean
  keepAlive: boolean
  maxRuns: string // the input's text; a positive integer to be valid
  // the max follows the period's runs a day until the owner types one —
  // born with max(24, slotsPerDay), and an edited period lifts it to
  // max(saved, slotsPerDay), never lowers it; an
  // untouched max is never sent: the server derives the same number
  maxRunsTouched: boolean
  // what its runs run on: null = the agent's default; a pick = the pair Run
  // on pins (a real provider id; '' only in a pair saved by an older version, read
  // as the agent's own account)
  runsOn: RunOnPick | null
  // "A model of its own" is chosen but no model picked yet — blocks saving
  // (saving it would quietly keep the agent's default)
  runsOnOwn: boolean
  // what it runs: an agent turn, or a command
  runKind: 'agent' | 'command'
  argvText: string // the command, as one line (parseArgvLine)
  cwd: string // '' = the agent's folder
  onFailure: 'inbox' | 'agent'
  timeoutMin: string
  okCodes: number[] | null // kept as saved; not edited here
}

function formOf(a: Automation): Form {
  const t = a.trigger
  return {
    name: a.name,
    nameTouched: true,
    prompt: a.prompt,
    agentId: a.agentId,
    schedule: t.kind === 'once' || t.kind === 'cron' ? draftFromTrigger(t) : defaultDraft(),
    when: t.kind === 'period' ? 'period' : 'cron',
    period: draftOfPeriod(t.kind === 'period' ? t.period : null, NEW_PERIOD),
    threadMode: a.thread.mode,
    folder: a.thread.mode === 'keep' ? (a.thread.folder ?? '') : '',
    approval: a.approval,
    keepAlive: a.keepAlive,
    maxRuns: String(a.maxRunsPerDay ?? DEFAULT_MAX_RUNS_PER_DAY),
    maxRunsTouched: false,
    runsOn: a.runsOn ? { provider: a.runsOn.provider ?? '', model: a.runsOn.model ?? '' } : null,
    runsOnOwn: !!a.runsOn,
    runKind: a.run?.kind === 'command' ? 'command' : 'agent',
    argvText: a.run?.kind === 'command' ? argvLine(a.run.argv) : '',
    cwd: a.run?.kind === 'command' ? (a.run.cwd ?? '') : '',
    onFailure: a.run?.kind === 'command' ? a.run.onFailure : 'inbox',
    timeoutMin: String(a.run?.kind === 'command' && a.run.timeoutMs ? Math.round(a.run.timeoutMs / 60_000) : DEFAULT_TIMEOUT_MIN),
    okCodes: a.run?.kind === 'command' && a.run.okCodes ? a.run.okCodes : null,
  }
}

function formOfSeed(s: EditorSeed): Form {
  return {
    ...blankForm(s.agentId),
    // a name typed in the sheet is the owner's; else it follows the prompt
    name: s.name.trim() || autoName(s.prompt),
    nameTouched: s.name.trim() !== '' && s.name !== autoName(s.prompt),
    prompt: s.prompt,
    when: s.when,
    period: s.period,
    schedule: s.schedule,
    threadMode: s.agentId === MASTER_ID ? 'keep' : s.threadMode,
    folder: s.folder,
    approval: s.approval,
  }
}

function blankForm(agentId: string): Form {
  return {
    name: '',
    nameTouched: false,
    prompt: '',
    agentId,
    schedule: defaultDraft(),
    when: 'period',
    period: draftOfPeriod(NEW_PERIOD),
    threadMode: agentId === MASTER_ID ? 'keep' : 'new',
    folder: '',
    approval: false,
    keepAlive: true, // on by default: a usage limit retries at its reset
    maxRuns: String(DEFAULT_MAX_RUNS_PER_DAY),
    maxRunsTouched: false,
    runsOn: null,
    runsOnOwn: false,
    runKind: 'agent',
    argvText: '',
    cwd: '',
    onFailure: 'inbox',
    timeoutMin: String(DEFAULT_TIMEOUT_MIN),
    okCodes: null,
  }
}

// a new automation's period: every day at 09:00
export const NEW_PERIOD = { every: 1, unit: 'days' as const, at: '09:00' }

// What the composer's quick sheet (AutomationSheet.tsx) hands over on «More
// options ›»: the sentence, its schedule and how it runs, so the editor opens
// on them — the conversation it was typed in kept when it keeps one. A
// gesture, not an address: held until the next editor creating for that
// agent takes it (a refresh starts blank, like any unsaved form).
export interface EditorSeed {
  agentId: string
  name: string
  prompt: string
  when: 'period' | 'cron'
  period: PeriodDraft
  schedule: ScheduleDraft
  threadMode: 'new' | 'keep'
  folder: string
  approval: boolean
  // the kept conversation (thread.keep's folder/session) it was typed in
  keep: { folder?: string; sessionId?: string } | null
}
let pendingSeed: EditorSeed | null = null
export function seedNextEditor(seed: EditorSeed): void {
  pendingSeed = seed
}
function takeSeed(agentId: string | undefined): EditorSeed | null {
  const s = pendingSeed
  pendingSeed = null
  return s && s.agentId === agentId ? s : null
}

// the trigger the form saves: the period, or the schedule's cron/once
function triggerOfForm(f: Form): Trigger {
  if (f.when === 'period') {
    const p = periodOfDraft(f.period)
    if (p) return { kind: 'period', period: p }
  }
  return triggerOfDraft(f.schedule) as Trigger
}

// the runs a day a period asks: the budget a new one is born with —
// over the period the server stamps, as the server derives it
function periodBudget(d: PeriodDraft, floor: number, stagger: number | undefined): number | null {
  try {
    const p = stampedOfDraft(d, AUTOMATION_RULES, stagger)
    return p ? Math.max(floor, slotsPerDay(p)) : null
  } catch {
    return null
  }
}

// An agent's staggered minute (server control.ts), as its heartbeat view
// serves it — undefined until read (or with no agent picked)
export function useStaggerMinute(agentId: string): number | undefined {
  const [minute, setMinute] = useState<{ id: string; m: number } | null>(null)
  useEffect(() => {
    if (!agentId) return
    let cancelled = false
    Promise.resolve(api.agents.heartbeat?.(agentId))
      .then((v) => {
        if (!cancelled && typeof v?.staggerMinute === 'number') setMinute({ id: agentId, m: v.staggerMinute })
      })
      .catch(() => {
        /* unknown: the band's own start */
      })
    return () => {
      cancelled = true
    }
  }, [agentId])
  return minute && minute.id === agentId ? minute.m : undefined
}

// what the run field says, as the API takes it — null while the command
// line can't be read (the problem shows under it)
function runOf(f: Form): AutomationRun | null {
  if (f.runKind === 'agent') return { kind: 'agent' }
  const parsed = parseArgvLine(f.argvText)
  if ('error' in parsed) return null
  const min = Number(f.timeoutMin.trim())
  return {
    kind: 'command',
    argv: parsed.argv,
    onFailure: f.onFailure,
    ...(f.cwd.trim() ? { cwd: f.cwd.trim() } : {}),
    ...(Number.isInteger(min) && min !== DEFAULT_TIMEOUT_MIN ? { timeoutMs: min * 60_000 } : {}),
    ...(f.okCodes ? { okCodes: f.okCodes } : {}),
  }
}

// a command that only tells you asks no one anything
function needsPrompt(f: Form): boolean {
  return f.runKind === 'agent' || f.onFailure === 'agent'
}

// what the form would save, as one comparable value — "changed" means this
// differs from the opening form's, so switching a sentence and back is not
// a change, and neither is typing a letter and deleting it.
function saveable(f: Form, locked: boolean): string {
  return JSON.stringify({
    name: f.name.trim(),
    prompt: f.prompt,
    agentId: f.agentId,
    trigger: locked ? null : triggerOfForm(f),
    threadMode: f.threadMode,
    folder: f.threadMode === 'keep' && f.agentId === MASTER_ID ? f.folder.trim() : '',
    approval: f.approval,
    keepAlive: f.keepAlive,
    maxRuns: f.maxRuns.trim(),
    runsOn: f.runKind === 'agent' ? runsOnBody(f.runsOn) : null,
    run: f.runKind === 'agent' ? 'agent' : { argv: f.argvText.trim(), cwd: f.cwd.trim(), onFailure: f.onFailure, timeout: f.timeoutMin.trim() },
  })
}

// the pair as the API takes it — null when it is the agent's default
function runsOnBody(pick: RunOnPick | null): { provider?: string; model?: string } | null {
  if (!pick) return null
  const out: { provider?: string; model?: string } = {}
  if (pick.provider) out.provider = pick.provider
  if (pick.model) out.model = pick.model
  return Object.keys(out).length > 0 ? out : null
}

function threadOf(f: Form, existing: Thread | null, sameAgent: boolean): Thread {
  if (f.threadMode === 'new') return { mode: 'new' }
  const prev = existing?.mode === 'keep' && sameAgent ? existing : null
  const out: Thread = { mode: 'keep' }
  if (f.agentId === MASTER_ID) out.folder = f.folder.trim()
  else if (prev?.folder) out.folder = prev.folder
  if (prev?.sessionId) out.sessionId = prev.sessionId
  return out
}

// which field a server 400 is about — its message lands under that field
type Field = 'name' | 'prompt' | 'agent' | 'schedule' | 'thread' | 'limits' | 'runsOn' | 'command' | 'cwd' | 'timeout' | 'general'
function fieldOfServerError(msg: string): Field {
  const m = msg.toLowerCase()
  if (/run\.cwd/.test(m)) return 'cwd'
  if (/run\.timeout/.test(m)) return 'timeout'
  if (/^run\.|runs a command|only the owner/.test(m)) return 'command'
  if (/cron|trigger|time zone|tz\b/.test(m)) return 'schedule'
  if (/^name/.test(m)) return 'name'
  if (/^prompt/.test(m)) return 'prompt'
  if (/agentid/.test(m)) return 'agent'
  if (/anywhere|thread|folder/.test(m)) return 'thread'
  if (/maxrunsperday/.test(m)) return 'limits'
  if (/runson|provider|account/.test(m)) return 'runsOn'
  return 'general'
}

function Problem({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p role="alert" data-testid={testId} className="mt-1.5 text-[13px] text-terracotta">
      {children}
    </p>
  )
}

// an on/off sentence: the words carry the meaning, the switch the state
export function SwitchRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start gap-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-[14px] leading-6 text-ink">{label}</p>
        {hint ? <p className="text-[12.5px] leading-5 text-ink-2">{hint}</p> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative mt-1 h-[18px] w-8 shrink-0 rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40 ${
          checked ? 'bg-terracotta' : 'bg-ink-3/35'
        }`}
      >
        <span
          aria-hidden="true"
          className={`absolute top-[2px] size-[14px] rounded-full bg-canvas shadow-sm transition-[left] duration-150 ${checked ? 'left-[16px]' : 'left-[2px]'}`}
        />
      </button>
    </div>
  )
}

function Dot({ active }: { active: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`mt-[3px] size-4 shrink-0 rounded-full border bg-canvas peer-focus-visible:ring-2 peer-focus-visible:ring-terracotta/40 ${
        active ? 'border-[5px] border-terracotta' : 'border-ink-3/60'
      }`}
    />
  )
}

// What its runs run on: the agent's default, or a pair of its
// own picked from THE Run on list (RunOnList — the same one a conversation's
// panel shows). The pair rides every run as the turn level.
function RunsOnSection({
  agent,
  value,
  own,
  onChange,
  problem,
}: {
  agent: AgentView
  value: RunOnPick | null
  own: boolean
  onChange: (v: RunOnPick | null, own: boolean) => void
  problem: string | null
}) {
  const providers = useStore((s) => s.providers)
  const catalog = useStore((s) => s.catalog)
  const harness = useHarness(agent.framework).id
  // the picked pair's provider group open — else the one the agent runs on
  const [openGroup, setOpenGroup] = useState<string>(canonicalProviderId(value?.provider || agent.provider))
  useEffect(() => {
    void useStore.getState().loadProviders()
    if (useStore.getState().catalog.length === 0) void useStore.getState().loadCatalog()
  }, [])
  // "Opus 5, on sam" / "its account's default model, on my-gateway"
  const agentDefault = `${agent.model ? modelLabel(catalog, agent.model) : 'its account’s default model'}, on ${providerShortLabel(providers, agent.provider)}`
  const picked = value
    ? automationRunsOnLabel({ ...(value.provider ? { provider: value.provider } : {}), ...(value.model ? { model: value.model } : {}) }, providers, catalog)
    : null
  const name = agent.id === MASTER_ID ? ANYWHERE_LABEL : agent.name
  return (
    <div className="mt-10" data-testid="automation-runs-on">
      <SectionTitle>What it runs on</SectionTitle>
      <div role="radiogroup" aria-label="What it runs on" className="-mx-2.5 mt-3 flex flex-col gap-0.5">
        <label className={`flex items-start gap-3 rounded-lg px-2.5 py-2 ${own ? 'cursor-pointer hover:bg-panel' : 'cursor-pointer'}`}>
          <input type="radio" name="runs-on" className="peer sr-only" checked={!own} onChange={() => onChange(null, false)} />
          <Dot active={!own} />
          <span className={`min-w-0 flex-1 text-[14px] leading-6 ${!own ? 'text-ink' : 'text-ink-2'}`}>
            {name}&rsquo;s default
            <span className="block text-[12.5px] leading-5 text-ink-2">
              Whatever {name} runs on when the run starts — today {agentDefault}.
            </span>
          </span>
        </label>
        <label className={`flex items-start gap-3 rounded-lg px-2.5 py-2 ${own ? 'cursor-pointer' : 'cursor-pointer hover:bg-panel'}`}>
          <input type="radio" name="runs-on" className="peer sr-only" checked={own} onChange={() => onChange(value, true)} />
          <Dot active={own} />
          <span className={`min-w-0 flex-1 text-[14px] leading-6 ${own ? 'text-ink' : 'text-ink-2'}`}>
            A model of its own{picked ? ' — ' : null}
            {picked ? <span className="text-ink-2">{picked}</span> : null}
            <span className="block text-[12.5px] leading-5 text-ink-2">Every run uses it, whatever {name} or its conversation is set to.</span>
          </span>
        </label>
      </div>
      {own ? (
        <div className="mt-2 overflow-hidden rounded-lg border border-line">
          <RunOnList
            agent={agent}
            harness={harness}
            providers={providers}
            picked={value}
            openGroup={openGroup}
            onToggleGroup={(id) => setOpenGroup((v) => (v === id ? '\u0000' : id))}
            onChoose={(pick) => onChange(pick, true)}
            onAccountChanged={() => void useStore.getState().loadProviders()}
          />
        </div>
      ) : null}
      {problem ? <Problem testId="runs-on-problem">{problem}</Problem> : null}
    </div>
  )
}

// a heartbeat's rhythm and hour are set on its agent's Now — the door there
function BeatRhythmDoor({ agentId, agentName }: { agentId: string; agentName: string }) {
  return (
    <button
      type="button"
      data-testid="beat-rhythm-door"
      onClick={() => openAgentControl(agentId)}
      className="text-ink-2 underline decoration-line underline-offset-2 hover:text-terracotta"
    >
      Set its rhythm on {agentName}&rsquo;s page ›
    </button>
  )
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="font-display text-[17px] text-ink">{children}</h2>
}

// the prompt grows with what it holds — never a scroll box inside the page
function useAutoGrow(ref: React.RefObject<HTMLTextAreaElement | null>, value: string): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 2}px`
  }, [ref, value])
}

export function AutomationEditor(
  props:
    | { mode: 'edit'; automation: Automation; onDone: () => void }
    // `review`: a proposal's «Review ›» — the
    // editor starts from what the agent proposed, says whose it is, and its
    // create resolves the proposal; Cancel leaves it pending
    | { mode: 'create'; agentId?: string; review?: { proposalId: string; agentName: string; reason: string; seed: Automation } },
) {
  const editing = props.mode === 'edit'
  const automation = editing ? props.automation : null
  const agents = useStore((s) => s.agents)
  const nowTick = useStore((s) => s.nowTick)
  const pickable = useMemo(() => agents.filter((a) => !a.archived), [agents])

  const review = props.mode === 'create' ? (props.review ?? null) : null
  // the composer sheet's hand-over («More options ›»), taken once
  const [seed] = useState<EditorSeed | null>(() => (props.mode === 'create' && !props.review ? takeSeed(props.agentId) : null))
  const initial = useMemo<Form>(
    () =>
      automation
        ? formOf(automation)
        : review
          ? formOf(review.seed)
          : seed
            ? formOfSeed(seed)
            : blankForm(props.mode === 'create' && props.agentId && agents.some((a) => a.id === props.agentId) ? props.agentId : ''),
    // the opening form — fixed for this editor's life
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  // what «changed» is measured against: a proposal under review — or a
  // sentence handed over from the composer — is something to create as it
  // stands: saving it unedited is a decision too
  const baseline = useMemo<Form>(() => (review || seed ? blankForm('') : initial), [review, seed, initial])
  const [form, setForm] = useState<Form>(initial)
  const [touched, setTouched] = useState<{ name?: boolean; prompt?: boolean; folder?: boolean; command?: boolean; save?: boolean }>({})
  const [serverError, setServerError] = useState<{ field: Field; message: string } | null>(null)
  const [saving, setSaving] = useState(false)
  // the inline "Discard changes?" — what to do if the owner says yes
  const [ask, setAsk] = useState<{ proceed: () => void } | null>(null)

  // An agent's heartbeat (heartbeat-*): its schedule, prompt and thread are
  // derived from the agent's control and the period set on its Now (the
  // control block's Heartbeat row) — the server refuses edits of them (409)
  // and the resident would revert them anyway, so here they are read-only
  // with the door to where they ARE set. Never a control that changes nothing.
  const beat = !!automation && isBeatAutomation(automation)
  // its home exists only while its agent is in play (beat-home.ts)
  const beatHome = beat && !!automation && beatHomeOpen(automation.agentId, agents)
  const locked = beat || (!!automation && automation.trigger.kind !== 'once' && automation.trigger.kind !== 'cron' && automation.trigger.kind !== 'period')
  const changed = saveable(form, locked) !== saveable(baseline, locked)
  const scheduleChanged = !locked && JSON.stringify(triggerOfForm(form)) !== JSON.stringify(triggerOfForm(initial))
  const isMaster = form.agentId === MASTER_ID
  const agent: AgentView | undefined = agents.find((a) => a.id === form.agentId)
  // the agent's staggered minute: the server anchors a minutes/hours period
  // there — the ruler, «≈ n runs a day» and the band's check are
  // over THAT period, never the un-stamped draft
  const stagger = useStaggerMinute(form.agentId)

  function update(patch: Partial<Form>): void {
    setForm((f) => {
      const next = { ...f, ...patch }
      // a new automation names itself from its prompt until the name is touched
      if (!next.nameTouched && patch.prompt !== undefined && next.runKind === 'agent') next.name = autoName(next.prompt)
      // …and a command from what it runs ("stripe_sales_sync.py")
      if (!next.nameTouched && next.runKind === 'command' && (patch.argvText !== undefined || patch.runKind !== undefined)) {
        const parsed = parseArgvLine(next.argvText)
        next.name =
          'argv' in parsed
            ? argvShort(
                parsed.argv.slice(parsed.argv.length > 1 && /(^|\/)(python3?|node|bash|sh|ruby|perl|deno|bun|npx|tsx)$/.test(parsed.argv[0]!) ? 1 : 0, 2),
                40,
              )
            : ''
      }
      // a typed max is the owner's; untouched, a new period's max follows it
      if (patch.maxRuns !== undefined) next.maxRunsTouched = true
      if ((patch.period !== undefined || patch.when !== undefined) && !next.maxRunsTouched && next.when === 'period') {
        const saved = Number(initial.maxRuns)
        const b = periodBudget(next.period, editing && Number.isInteger(saved) && saved > 0 ? saved : DEFAULT_MAX_RUNS_PER_DAY, stagger)
        if (b !== null) next.maxRuns = String(b)
      }
      // Anywhere has no folder of its own: it always keeps one conversation
      if (patch.agentId === MASTER_ID) next.threadMode = 'keep'
      // another agent may run another engine on other accounts: its own default
      if (patch.agentId !== undefined && patch.agentId !== f.agentId) {
        next.runsOn = null
        next.runsOnOwn = false
      }
      return next
    })
    setServerError(null)
    setAsk(null)
  }

  // ---- validity, in words, under each field ----
  const maxRunsN = Number(form.maxRuns.trim())
  const problems: Partial<Record<Field, string>> = {}
  if (!form.name.trim()) problems.name = 'Give it a name.'
  if (needsPrompt(form) && !form.prompt.trim()) {
    problems.prompt = form.runKind === 'command' ? 'Say what the agent should do when the command fails.' : 'Say what the agent should do on each run.'
  }
  if (form.runKind === 'command') {
    const parsed = parseArgvLine(form.argvText)
    if ('error' in parsed) problems.command = parsed.error.charAt(0).toUpperCase() + parsed.error.slice(1) + '.'
    const cwd = form.cwd.trim()
    if (cwd && !cwd.startsWith('/') && !/^\$\{?SILOS_AGENT_STATE\b/.test(cwd)) problems.cwd = 'A full path, starting with / (or $SILOS_AGENT_STATE).'
    if (!cwd && isMaster) problems.cwd = 'Anywhere has no folder of its own: say where it runs.'
    const min = Number(form.timeoutMin.trim())
    if (!Number.isInteger(min) || min < 1 || min > MAX_TIMEOUT_MIN) problems.timeout = `Between 1 and ${MAX_TIMEOUT_MIN} minutes.`
  }
  if (!editing && !form.agentId) problems.agent = 'Pick who runs it.'
  // an untouched schedule isn't sent, so a once that already ran isn't an error
  const scheduleProblem =
    locked || (editing && !scheduleChanged)
      ? null
      : form.when === 'period'
        ? periodProblem(form.period, AUTOMATION_RULES, stagger)
        : draftProblem(form.schedule, nowTick || Date.now())
  if (scheduleProblem) problems.schedule = scheduleProblem
  if (form.runsOnOwn && form.runsOn === null) problems.runsOn = `Pick the model above — or keep ${agent?.name ?? 'the agent'}’s default.`
  if (needsPrompt(form) && isMaster && form.threadMode === 'keep' && !form.folder.trim())
    problems.thread = 'Anywhere needs a project to keep its conversation in.'
  if (!Number.isInteger(maxRunsN) || maxRunsN < 1) problems.limits = 'At least 1 run a day.'
  const valid = Object.keys(problems).length === 0
  const canSave = changed && valid && !saving
  // a field's problem shows once it was touched, or after a Save attempt —
  // the schedule's, the zone's and the numbers' always (they are typed into)
  const show = (f: Field): string | null => {
    if (serverError?.field === f) return serverError.message
    const p = problems[f]
    if (!p) return null
    if (f === 'name' && !(touched.name || touched.save || (editing && changed))) return null
    if (f === 'prompt' && !(touched.prompt || touched.save || (editing && changed))) return null
    if (f === 'command' && !(touched.command || touched.save)) return null
    if (f === 'agent' && !(touched.save || (changed && form.prompt.trim()))) return null
    if (f === 'thread' && !(touched.folder || touched.save)) return null
    return p
  }

  // ---- leaving: Cancel, Esc, back, any navigation ----
  const disarmRef = useRef<(() => void) | null>(null)
  function exit(): void {
    if (props.mode === 'edit') {
      props.onDone()
      return
    }
    // creating: back where it was opened from; a deep link has nowhere to
    // go back to inside Silos, so it lands on the automations
    if (window.history.length > 1) window.history.back()
    else useStore.getState().changePage({ kind: 'automations' })
  }
  function requestLeave(proceed: () => void): void {
    if (!changed) {
      proceed()
      return
    }
    setAsk({ proceed })
  }
  function discard(): void {
    const a = ask
    disarmRef.current?.()
    disarmRef.current = null
    setAsk(null)
    a?.proceed()
  }

  // while there are unsaved changes, every page change is held and asked
  useEffect(() => {
    if (!changed) return
    const disarm = armLeaveGuard({
      onBlocked(patches) {
        const target = Object.assign({}, useStore.getState(), ...patches)
        const route = routeOfState(target)
        setAsk({ proceed: () => navigateToRoute(route) })
      },
    })
    disarmRef.current = disarm
    function onBeforeUnload(e: BeforeUnloadEvent): void {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      disarm()
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [changed])

  // Esc: leave (asking if needed); Esc again while asking keeps editing
  const escRef = useRef<() => void>(() => {})
  escRef.current = () => {
    if (ask) setAsk(null)
    else requestLeave(exit)
  }
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      escRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // ---- save ----
  async function save(): Promise<void> {
    setTouched((t) => ({ ...t, save: true }))
    if (!canSave) return
    setSaving(true)
    setServerError(null)
    const maxRunsPerDay = maxRunsN
    try {
      if (automation) {
        const sameAgent = form.agentId === automation.agentId
        await api.automations.update(automation.id, {
          name: form.name.trim(),
          // a heartbeat's prompt and thread are derived — never sent
          ...(beat ? {} : { prompt: form.prompt }),
          // a schedule left as it was isn't sent: its zone (or lack of one)
          // and a webhook/files/watch trigger stay exactly as saved
          ...(scheduleChanged ? { trigger: triggerOfForm(form) } : {}),
          ...(beat ? {} : { thread: threadOf(form, automation.thread, sameAgent) }),
          approval: form.approval,
          keepAlive: form.keepAlive,
          // a max left untouched is the server's to keep or lift
          ...(form.maxRunsTouched ? { maxRunsPerDay } : {}),
          // a command runs on no model; its saved pair (if any) stays as is
          ...(form.runKind === 'agent' ? { runsOn: runsOnBody(form.runsOn) } : {}),
          // what it runs, when it is or was a command (an agent turn left
          // as one sends nothing new)
          ...(form.runKind === 'command' || automation.run?.kind === 'command' ? { run: runOf(form)! } : {}),
        })
        disarmRef.current?.()
        disarmRef.current = null
        void useStore.getState().loadAutomations()
        props.mode === 'edit' && props.onDone()
      } else {
        const created = await api.automations.create({
          name: form.name.trim(),
          agentId: form.agentId,
          prompt: form.prompt,
          trigger: triggerOfForm(form),
          // the sheet's kept conversation rides on when it still keeps one
          thread: threadOf(form, seed?.keep ? { mode: 'keep', ...seed.keep } : null, form.agentId === seed?.agentId),
          approval: form.approval,
          keepAlive: form.keepAlive,
          // a period's max left untouched is the server's to derive
          ...(form.when === 'period' && !form.maxRunsTouched ? {} : { maxRunsPerDay }),
          ...(form.runKind === 'agent' && runsOnBody(form.runsOn) ? { runsOn: runsOnBody(form.runsOn)! } : {}),
          ...(form.runKind === 'command' ? { run: runOf(form)! } : {}),
          ...(review ? { proposal: review.proposalId } : {}),
        })
        disarmRef.current?.()
        disarmRef.current = null
        await useStore.getState().loadAutomations()
        // the new automation's own page — loadAutomations already holds it
        if (!useStore.getState().automations.some((a) => a.id === created.id)) {
          useStore.setState((s) => ({ automations: [...s.automations, created] }))
        }
        // the spent editor is REPLACED by its result: Back returns to where
        // the editor was opened, never to a blank /automation/new
        replacing(() => useStore.getState().openAutomation(created.id))
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // a period's 400 in screen words (no «trigger.period.» field names)
      setServerError({
        field: fieldOfServerError(message),
        message: form.when === 'period' ? screenProblem(message, AUTOMATION_RULES, form.period, stagger) : message.charAt(0).toUpperCase() + message.slice(1),
      })
    } finally {
      setSaving(false)
    }
  }

  const promptRef = useRef<HTMLTextAreaElement>(null)
  useAutoGrow(promptRef, form.prompt)
  // creating with the agent already chosen: straight into the prompt
  useEffect(() => {
    if (!editing && initial.agentId) promptRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const folders = useMemo(() => [...new Set(agents.map((a) => a.folder).filter((f): f is string => !!f && f.startsWith('/')))].sort(), [agents])
  const keptConversation =
    automation &&
    automation.thread.mode === 'keep' &&
    automation.thread.sessionId &&
    automation.thread.folder &&
    form.threadMode === 'keep' &&
    form.agentId === automation.agentId
      ? { folder: automation.thread.folder, sessionId: automation.thread.sessionId }
      : null
  const parsedRun = runOf(form)
  const headerCommand = parsedRun?.kind === 'command' ? parsedRun : null
  const agentName = agent ? (isMaster ? ANYWHERE_LABEL : agent.name) : 'the agent'
  const threadForHeader: Thread = form.threadMode === 'keep' ? { mode: 'keep', ...(isMaster ? { folder: form.folder.trim() } : {}) } : { mode: 'new' }

  return (
    <div className="flex flex-1 flex-col overflow-hidden" data-testid="automation-editor">
      <PageHeader
        testId="automation-editor-header"
        // where it lives: the Automations, and — editing — the automation
        // itself, whose page is the way out of the mode. Both go through the
        // leave guard (unsaved changes are asked, never lost)
        crumbs={[
          { label: 'Automations', onClick: () => useStore.getState().changePage({ kind: 'automations' }) },
          ...(automation ? [{ label: automation.name, title: 'Back to its page', onClick: () => requestLeave(exit) }] : []),
        ]}
        seal={
          <Seal>
            <AutomationIcon size={17} strokeWidth={2} aria-hidden="true" className="text-terracotta" />
          </Seal>
        }
        // the name is edited in place, in the title's own type (the input
        // inherits it); sized to its words (field-sizing), so "Editing"
        // sits right after it
        title={
          <span className="flex min-w-0 items-baseline gap-2.5">
            <input
              type="text"
              aria-label="Automation name"
              value={form.name}
              placeholder={editing ? 'Name' : 'New automation'}
              onChange={(e) => update({ name: e.target.value, nameTouched: true })}
              onBlur={() => setTouched((t) => ({ ...t, name: true }))}
              className="min-w-[10ch] max-w-full truncate border-b border-dashed border-ink-3/50 bg-transparent text-ink outline-none [field-sizing:content] placeholder:text-ink-3 hover:border-ink-3 focus:border-terracotta"
            />
            <span className="shrink-0 font-sans text-xs text-terracotta">{editing ? 'Editing' : 'New'}</span>
          </span>
        }
        facts={
          automation ? (
            <AutomationFacts automation={automation} />
          ) : review ? (
            <span className="truncate" data-testid="editor-review">
              {review.agentName} suggested it — “{review.reason}”. Creating it accepts the suggestion; Cancel leaves it waiting.
            </span>
          ) : null
        }
        notes={
          <>
            {show('name') ? <Problem testId="name-problem">{show('name')}</Problem> : null}
            {form.agentId ? (
              <BelongingSentence agentId={form.agentId} thread={threadForHeader} agent={agent} command={headerCommand} oneLine />
            ) : (
              <p className="mt-0.5 truncate text-[12.5px] text-ink-2">No agent yet — pick who runs it below.</p>
            )}
          </>
        }
      />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[78rem] px-4 pb-10 pt-6 sm:px-8 lg:grid lg:grid-cols-[minmax(0,1fr)_25rem] lg:gap-14 lg:pt-8">
          {/* the prompt — the protagonist */}
          <section className="min-w-0">
            {/* creating: the templates first — most automations are one of a few shapes */}
            {!editing ? <TemplateShelf agentId={props.mode === 'create' ? props.agentId : undefined} /> : null}
            {!editing ? (
              <div className="mb-7">
                <p id="who-runs-it" className="text-[13px] font-medium text-ink">
                  Who runs it
                </p>
                <div role="radiogroup" aria-labelledby="who-runs-it" className="mt-2 flex flex-wrap gap-1.5">
                  {pickable.map((a) => {
                    const on = a.id === form.agentId
                    const master = a.id === MASTER_ID
                    return (
                      <button
                        key={a.id}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => update({ agentId: a.id })}
                        title={master ? 'Anywhere — keeps one conversation in a project you name' : missionLine(a) || a.name}
                        className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] ${
                          on ? 'border-terracotta bg-terracotta-soft text-ink' : 'border-line text-ink-2 hover:border-ink-3 hover:text-ink'
                        }`}
                      >
                        <span aria-hidden="true">{a.emoji || (master ? '✳' : '❔')}</span>
                        {master ? ANYWHERE_LABEL : a.name}
                      </button>
                    )
                  })}
                </div>
                {show('agent') ? <Problem testId="agent-problem">{show('agent')}</Problem> : null}
              </div>
            ) : null}
            {beat ? null : (
              <div className="mb-7" data-testid="automation-run-kind">
                <p id="what-it-runs" className="text-[13px] font-medium text-ink">
                  What it runs
                </p>
                <div role="radiogroup" aria-labelledby="what-it-runs" className="mt-2 inline-flex rounded-full border border-line p-0.5">
                  {(['agent', 'command'] as const).map((k) => {
                    const on = form.runKind === k
                    return (
                      <button
                        key={k}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => update({ runKind: k })}
                        className={`rounded-full px-3 py-1 text-[13px] ${on ? 'bg-terracotta-soft text-ink' : 'text-ink-2 hover:text-ink'}`}
                      >
                        {k === 'agent' ? 'An agent turn' : 'A command'}
                      </button>
                    )
                  })}
                </div>
                {form.runKind === 'command' ? (
                  <div className="mt-5 max-w-[72ch]">
                    <label htmlFor="automation-command" className="block text-[13px] font-medium text-ink">
                      The command
                    </label>
                    <p className="mt-0.5 text-[13px] text-ink-2">
                      Run exactly as written, without a shell and without Claude — no tokens, no usage limits. Quotes keep spaces together;{' '}
                      <code className="font-mono text-[12px]">$SILOS_AGENT_STATE</code> is the only variable filled in.
                    </p>
                    <input
                      id="automation-command"
                      type="text"
                      value={form.argvText}
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(e) => update({ argvText: e.target.value })}
                      onBlur={() => setTouched((t) => ({ ...t, command: true }))}
                      placeholder="/usr/bin/python3 /home/you/scripts/sync.py --since yesterday"
                      className="mt-2.5 block w-full rounded-lg border border-line bg-panel/50 px-3 py-2 font-mono text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-terracotta/70 focus:bg-canvas"
                    />
                    {show('command') ? <Problem testId="command-problem">{show('command')}</Problem> : null}
                    <label htmlFor="automation-cwd" className="mt-4 block text-[13px] text-ink-2">
                      In folder
                    </label>
                    <input
                      id="automation-cwd"
                      type="text"
                      value={form.cwd}
                      spellCheck={false}
                      onChange={(e) => update({ cwd: e.target.value })}
                      placeholder={agent?.folder ?? '/path/to/folder'}
                      className="mt-1 block w-full rounded-md border border-line bg-canvas px-2 py-1 font-mono text-[12.5px] text-ink outline-none placeholder:text-ink-3 focus:border-terracotta"
                    />
                    <p className="mt-1 text-[12.5px] text-ink-2">{agent?.folder && !isMaster ? `Empty runs it in ${agentName}’s folder.` : 'Where it runs.'}</p>
                    {show('cwd') ? <Problem testId="cwd-problem">{show('cwd')}</Problem> : null}

                    <p id="if-it-fails" className="mt-6 text-[13px] font-medium text-ink">
                      If it fails
                    </p>
                    <div role="radiogroup" aria-labelledby="if-it-fails" className="-mx-2.5 mt-1.5 flex flex-col gap-0.5">
                      {(['inbox', 'agent'] as const).map((k) => {
                        const on = form.onFailure === k
                        return (
                          <label key={k} className={`flex items-start gap-3 rounded-lg px-2.5 py-2 ${on ? 'cursor-pointer' : 'cursor-pointer hover:bg-panel'}`}>
                            <input type="radio" name="on-failure" className="peer sr-only" checked={on} onChange={() => update({ onFailure: k })} />
                            <Dot active={on} />
                            <span className={`min-w-0 flex-1 text-[14px] leading-6 ${on ? 'text-ink' : 'text-ink-2'}`}>
                              {k === 'inbox' ? 'Tell me' : `Hand it to ${agentName}`}
                              <span className="block text-[12.5px] leading-5 text-ink-2">
                                {k === 'inbox'
                                  ? 'A non-zero exit or a timeout shows up in Needs you, with its last line.'
                                  : `${agentName} gets what you write below, the exit code and the last 40 lines of the log — the only time this automation spends a turn.`}
                              </span>
                            </span>
                          </label>
                        )
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
            {beat && automation ? (
              <div data-testid="beat-prompt">
                <p className="text-[13px] font-medium text-ink">What the agent should do</p>
                {beatHome ? (
                  <p className="mt-0.5 text-[13px] text-ink-2">
                    {agentName}&rsquo;s heartbeat — what it does is Silos&rsquo; own · <BeatRhythmDoor agentId={automation.agentId} agentName={agentName} />
                  </p>
                ) : (
                  <p data-testid="beat-paused" className="mt-0.5 text-[13px] text-ink-2">
                    The agent&rsquo;s heartbeat — {PAUSED_BEAT_WORDS}
                  </p>
                )}
                <p className="mt-3 max-w-[72ch] whitespace-pre-wrap rounded-xl border border-line px-4 py-3.5 text-[15px] leading-[1.6] text-ink-2">
                  {automation.prompt}
                </p>
              </div>
            ) : needsPrompt(form) ? (
              <>
                <label htmlFor="automation-prompt" className="block text-[13px] font-medium text-ink">
                  {form.runKind === 'command' ? `What ${agentName} should do when it fails` : 'What the agent should do'}
                </label>
                <p className="mt-0.5 text-[13px] text-ink-2">
                  {form.runKind === 'command'
                    ? `Sent to ${agentName} word for word, followed by how the command failed.`
                    : `Sent to ${agentName} word for word at the start of every run.`}
                </p>
                <textarea
                  id="automation-prompt"
                  ref={promptRef}
                  value={form.prompt}
                  onChange={(e) => update({ prompt: e.target.value })}
                  onBlur={() => setTouched((t) => ({ ...t, prompt: true }))}
                  placeholder="Every morning, read yesterday’s merged pull requests and write a short digest: what changed, what might break, who should look."
                  spellCheck
                  className={`mt-3 block ${form.runKind === 'command' ? 'min-h-[12rem]' : 'min-h-[50vh]'} w-full max-w-[72ch] resize-none overflow-hidden whitespace-pre-wrap rounded-xl border border-line bg-panel/50 px-4 py-3.5 text-[15px] sm:px-5 sm:py-4 leading-[1.6] text-ink outline-none placeholder:text-ink-3 focus:border-terracotta/70 focus:bg-canvas`}
                />
                {show('prompt') ? <Problem testId="prompt-problem">{show('prompt')}</Problem> : null}
              </>
            ) : null}
          </section>

          {/* when and how — a quiet column */}
          <aside className="mt-10 min-w-0 lg:mt-0">
            <SectionTitle>When it runs</SectionTitle>
            <div className="mt-3">
              {beat && automation ? (
                <div className="rounded-lg border border-line px-3 py-2.5" data-testid="beat-schedule">
                  <p className="font-mono text-[13px] text-ink">{triggerSummary(automation.trigger)}</p>
                  {beatHome ? (
                    <p className="mt-1 text-[12.5px] text-ink-2">
                      It’s {agentName}’s heartbeat · <BeatRhythmDoor agentId={automation.agentId} agentName={agentName} />
                    </p>
                  ) : (
                    <p className="mt-1 text-[12.5px] text-ink-2">A heartbeat — {PAUSED_BEAT_WORDS}</p>
                  )}
                </div>
              ) : locked && automation ? (
                <div className="rounded-lg border border-line px-3 py-2.5">
                  <p className="font-mono text-[13px] text-ink">{triggerSummary(automation.trigger)}</p>
                  <p className="mt-1 text-[12.5px] text-ink-2">Set up elsewhere; the schedule can’t be changed here.</p>
                </div>
              ) : form.when === 'period' ? (
                <>
                  <PeriodEditor
                    draft={form.period}
                    onChange={(period) => update({ period })}
                    problem={show('schedule')}
                    staggerMinute={stagger}
                    consequence={(() => {
                      // over the stamped period: «every 4 hours between
                      // 08:00 and 20:00» from 08:49 is 3 runs, not 4; days
                      // and weeks say their real cadence
                      try {
                        const p = stampedOfDraft(form.period, AUTOMATION_RULES, stagger)
                        if (!p) return null
                        const short = p.unit === 'minutes' || p.unit === 'hours'
                        return `${capitalized(cadenceWords(p, 'run'))}${short && p.at ? `, from ${p.at}` : ''}.`
                      } catch {
                        return null
                      }
                    })()}
                    testId="schedule-period"
                  />
                  <button
                    type="button"
                    data-testid="schedule-to-cron"
                    onClick={() => update({ when: 'cron' })}
                    className="mt-3 rounded text-[13px] text-ink-2 underline decoration-line underline-offset-2 hover:text-terracotta"
                  >
                    or a cron expression ›
                  </button>
                </>
              ) : (
                <>
                  <ScheduleBuilder
                    draft={form.schedule}
                    onChange={(schedule) => update({ schedule })}
                    problem={show('schedule')}
                    nowMs={nowTick || Date.now()}
                    serverNextAt={!scheduleChanged ? automation?.nextRunAt : null}
                  />
                  <button
                    type="button"
                    data-testid="schedule-to-period"
                    onClick={() => update({ when: 'period' })}
                    className="mt-3 rounded text-[13px] text-ink-2 underline decoration-line underline-offset-2 hover:text-terracotta"
                  >
                    or every so many minutes, hours, days or weeks ›
                  </button>
                </>
              )}
            </div>

            {agent && form.runKind === 'agent' ? (
              <RunsOnSection
                agent={agent}
                value={form.runsOn}
                own={form.runsOnOwn}
                onChange={(runsOn, runsOnOwn) => update({ runsOn, runsOnOwn })}
                problem={show('runsOn')}
              />
            ) : null}

            <div className="mt-10">
              <SectionTitle>How it runs</SectionTitle>
              {beat ? (
                <p className="mt-3 text-[13px] text-ink-2" data-testid="beat-thread">
                  A new conversation at each heartbeat — Silos sets this.
                </p>
              ) : needsPrompt(form) ? (
                <>
                  <div role="radiogroup" aria-label="Conversation" className="-mx-2.5 mt-3 flex flex-col gap-0.5">
                    {(['new', 'keep'] as const).map((mode) => {
                      const on = form.threadMode === mode
                      // a standing duty's beat (auto-resp-*) is fresh every time —
                      // the server reconciles it back to `new`, so «keep» would be
                      // undone in silence (message delivery): said, not offered
                      const beat = automation !== null && isBeatAutomation(automation)
                      const disabled = (mode === 'new' && isMaster) || (mode === 'keep' && beat)
                      return (
                        <label
                          key={mode}
                          className={`flex items-start gap-3 rounded-lg px-2.5 py-2 ${disabled ? 'cursor-not-allowed opacity-50' : on ? 'cursor-pointer' : 'cursor-pointer hover:bg-panel'}`}
                        >
                          <input
                            type="radio"
                            name="thread-mode"
                            className="peer sr-only"
                            checked={on}
                            disabled={disabled}
                            onChange={() => update({ threadMode: mode })}
                          />
                          <Dot active={on} />
                          <span className={`min-w-0 flex-1 text-[14px] leading-6 ${on ? 'text-ink' : 'text-ink-2'}`}>
                            {mode === 'new' ? 'Start a new conversation each run' : 'Keep one conversation across runs'}
                            <span className="block text-[12.5px] leading-5 text-ink-2">
                              {mode === 'new'
                                ? disabled
                                  ? 'Anywhere has no folder of its own, so it can’t.'
                                  : 'Each run starts fresh; its conversation sits under the automation.'
                                : beat
                                  ? 'A heartbeat runs in a fresh conversation every time.'
                                  : 'Every run continues where the last left off, with what it learned.'}
                            </span>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                  {isMaster && form.threadMode === 'keep' ? (
                    <div className="mt-2">
                      <label htmlFor="automation-folder" className="text-[13px] text-ink-2">
                        In project
                      </label>
                      <input
                        id="automation-folder"
                        type="text"
                        list="automation-folders"
                        value={form.folder}
                        spellCheck={false}
                        onChange={(e) => update({ folder: e.target.value })}
                        onBlur={() => setTouched((t) => ({ ...t, folder: true }))}
                        placeholder="/path/to/project"
                        className="mt-1 block w-full rounded-md border border-line bg-canvas px-2 py-1 font-mono text-[12.5px] text-ink outline-none focus:border-terracotta"
                      />
                      <datalist id="automation-folders">
                        {folders.map((f) => (
                          <option key={f} value={f} />
                        ))}
                      </datalist>
                    </div>
                  ) : null}
                  {show('thread') ? <Problem testId="thread-problem">{show('thread')}</Problem> : null}
                  {keptConversation ? (
                    <button
                      type="button"
                      onClick={() => void useStore.getState().openSession(keptConversation.folder, keptConversation.sessionId)}
                      className="mt-1.5 rounded text-[13px] font-medium text-terracotta hover:underline"
                    >
                      Open its conversation →
                    </button>
                  ) : null}
                </>
              ) : null}

              <div className="mt-4 divide-y divide-line border-t border-line">
                <SwitchRow
                  label="Ask me before each run"
                  hint="Each run waits on Home until you approve or skip it."
                  checked={form.approval}
                  onChange={(approval) => update({ approval })}
                />
                {form.runKind === 'agent' ? (
                  <SwitchRow
                    label="If a usage limit hits, wait and retry when it resets"
                    hint="Otherwise the run ends there, marked failed."
                    checked={form.keepAlive}
                    onChange={(keepAlive) => update({ keepAlive })}
                  />
                ) : (
                  <div className="py-3">
                    <p className="flex flex-wrap items-center gap-x-1.5 text-[14px] leading-7 text-ink">
                      Stop it after
                      <input
                        type="number"
                        min={1}
                        max={MAX_TIMEOUT_MIN}
                        aria-label="minutes before it is stopped"
                        value={form.timeoutMin}
                        onChange={(e) => update({ timeoutMin: e.target.value })}
                        className="w-16 rounded-md border border-line bg-canvas px-1.5 py-0.5 text-[14px] tabular-nums outline-none focus:border-terracotta"
                      />
                      min
                    </p>
                    <p className="text-[12.5px] leading-5 text-ink-2">A command still running then is stopped and counts as failed.</p>
                    {show('timeout') ? <Problem testId="timeout-problem">{show('timeout')}</Problem> : null}
                  </div>
                )}
                <div className="py-3">
                  <p className="flex flex-wrap items-center gap-x-1.5 text-[14px] leading-7 text-ink">
                    At most
                    <input
                      type="number"
                      min={1}
                      aria-label="most runs a day"
                      value={form.maxRuns}
                      onChange={(e) => update({ maxRuns: e.target.value })}
                      className="w-16 rounded-md border border-line bg-canvas px-1.5 py-0.5 text-[14px] tabular-nums outline-none focus:border-terracotta"
                    />
                    runs a day
                  </p>
                  <p className="text-[12.5px] leading-5 text-ink-2">A ceiling, so a loop can’t run away. Skipped runs don’t count.</p>
                  {show('limits') ? <Problem>{show('limits')}</Problem> : null}
                </div>
              </div>
            </div>
          </aside>
        </div>
      </div>

      <footer
        className="shrink-0 border-t border-line bg-panel px-4 pt-3 sm:px-8"
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
        data-testid="automation-editor-footer"
      >
        <div className="mx-auto flex w-full max-w-[78rem] flex-wrap items-center justify-end gap-x-3 gap-y-2">
          {ask ? (
            <>
              <p className="mr-auto text-[14px] text-ink" role="alert">
                Discard changes?
              </p>
              <button type="button" onClick={() => setAsk(null)} className="rounded-lg px-3 py-1.5 text-sm text-ink-2 hover:text-ink">
                Keep editing
              </button>
              <button
                type="button"
                onClick={discard}
                className="rounded-lg border border-terracotta px-4 py-1.5 text-sm font-medium text-terracotta hover:bg-terracotta-soft"
              >
                Discard
              </button>
            </>
          ) : (
            <>
              <p className="mr-auto min-w-0 text-[13px] text-ink-2" data-testid="editor-status">
                {serverError?.field === 'general' ? (
                  <span className="text-terracotta">{serverError.message}</span>
                ) : changed && !valid && touched.save ? (
                  'Fix what’s marked above to save.'
                ) : changed ? (
                  'Unsaved changes'
                ) : editing ? (
                  'No changes yet'
                ) : null}
              </p>
              <button type="button" onClick={() => requestLeave(exit)} className="rounded-lg px-3 py-1.5 text-sm text-ink-2 hover:text-ink">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={!canSave}
                className="rounded-lg bg-terracotta px-4 py-1.5 text-sm font-medium text-on-terracotta hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {saving ? 'Saving…' : editing ? 'Save' : 'Create automation'}
              </button>
            </>
          )}
        </div>
      </footer>
    </div>
  )
}
