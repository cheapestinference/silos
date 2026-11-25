// Welcome.tsx — the first run (moment 3): a fresh install has no agent of
// its own and no sessions, and instead of an empty pane it walks the
// newcomer through short steps — its project (a new one by name, the
// folder it gets said under it), who (its first agent: a loose
// conversation is not offered, the «+» menu keeps it), the engine (only
// when this machine can run more than one), what it runs on, what a new
// project starts with («At start», only for an engine that declares
// classes), which silos — each saying in a line what the thing is. The
// project's name follows the agent's until typed. Every step starts on its recommended value and
// Create is live from the first one, so «a name + Create» is still the
// whole first run when nothing else matters (defaults are sent as absence).
// The rail on top names each step with what is picked in it: what Create
// will do is always in sight.
//
// Create applies, in order: the silo changes (a failure is said, never a
// stop), the starting set when it differs from Recommended (the same), then the agent — landing on its first minute (FirstMeeting).
// «Skip for now» makes nothing. It disappears on its own once an agent or
// a conversation exists (App.tsx's MainPane).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { Logo } from './Logo'
import { useStore } from '../store'
import { api } from '../lib/api'
import { startFirstMeeting } from '../lib/first-meeting'
import { defaultHarnessId, descriptorOf, useHarnessDescriptors } from '../lib/harnesses'
import { agentPayloadExtras, engineOf, engineRows, siloOps, siloRows, tourSteps, withEngine, type SiloRow, type TourChoice } from '../lib/first-run'
import { keepsOut, PROJECT_NEW, TOUR_STEPS, type TourStep } from '../lib/new-agent'
import { classOn, startingSetPatch, type ChosenClass } from '../lib/starting-set'
import { providerLabel } from '../lib/providers'
import type { EngineCompat, ProviderView, StartingFacts } from '../lib/types'
import { birthPayload, birthProblems, birthReady, emptyBirth, knownProjects, projectName, type Birth } from '../lib/birth'
import { useProjectsFolder } from '../lib/projects-folder'
import { fieldForError } from './AgentModal'
import { ProjectStep } from './welcome/ProjectStep'
import { WhoStep } from './welcome/WhoStep'
import { EngineStep } from './welcome/EngineStep'
import { RunsOnStep } from './welcome/RunsOnStep'
import { SilosStep } from './welcome/SilosStep'
import { AtStartStep } from './welcome/AtStartStep'

const errorAtProject = (error: string | null): boolean => error !== null && fieldForError(error) === 'project'
const engineRefusedId = (rows: readonly { id: string; usable: boolean }[], id: string): boolean => rows.some((r) => r.id === id && !r.usable)

// a call that may be unmocked or fail: its answer, or null
const soft = <T,>(f: () => Promise<T> | undefined): Promise<T | null> =>
  Promise.resolve()
    .then(f)
    .then((v) => v ?? null)
    .catch(() => null)

export function Welcome() {
  const loadOverview = useStore((s) => s.loadOverview)
  const descriptors = useHarnessDescriptors()
  const agents = useStore((s) => s.agents)
  const projectsFolder = useProjectsFolder()
  const [step, setStep] = useState<TourStep>('project')
  const [birth, setBirth] = useState<Birth>(emptyBirth)
  const [choice, setChoice] = useState<TourChoice>(() => ({ engine: defaultHarnessId(), provider: '', silos: {} }))
  const [compat, setCompat] = useState<EngineCompat[]>([])
  const [providers, setProviders] = useState<ProviderView[] | null>(null)
  const [silos, setSilos] = useState<SiloRow[] | null>(null)
  // per engine, the classes a new project starts with (GET /api/settings):
  // none for an engine that declares nothing — no «At start» step
  const [startClasses, setStartClasses] = useState<Record<string, ChosenClass[]>>({})
  const [facts, setFacts] = useState<StartingFacts | null>(null)
  const [busy, setBusy] = useState(false)
  // silo changes already made by an earlier Create that failed after them
  const applied = useRef(new Set<string>())
  const [error, setError] = useState<string | null>(null)

  const loadProviders = useCallback(async (): Promise<ProviderView[]> => {
    const list = (await soft(() => api.providers.list())) ?? []
    setProviders(list)
    return list
  }, [])

  useEffect(() => {
    void soft(() => api.harness()).then((s) => setCompat(s?.compat ?? []))
    void loadProviders()
    void soft(() => api.silos.list()).then((l) => setSilos(l ? siloRows(l.silos ?? [], l.available ?? []) : []))
    void soft(() => api.platformSettings.get()).then((v) => setStartClasses(v?.startingSet ?? {}))
  }, [loadProviders])

  const engines = useMemo(() => engineRows(descriptors, compat), [descriptors, compat])
  // no Engine step (one engine runs here): the tour runs that one
  useEffect(() => {
    const only = engineOf(choice.engine, engines)
    if (only !== choice.engine) setChoice((c) => withEngine(c, only))
  }, [engines, choice.engine])
  const classes = useMemo(() => startClasses[choice.engine] ?? [], [startClasses, choice.engine])
  const steps = useMemo(() => tourSteps(classes, engines), [classes, engines])
  // what you set up here and what the account sends, read for the folder
  // the agent would get: an existing project's, or none yet (a new one)
  const folderAsked = birth.project.kind === 'new' ? '' : birth.project.folder
  useEffect(() => {
    if (classes.length === 0) {
      setFacts(null)
      return
    }
    let live = true
    const t = setTimeout(() => {
      void soft(() => api.startingSet({ framework: choice.engine, folder: folderAsked, facts: true })).then((p) => {
        if (live) setFacts(p?.facts ?? null)
      })
    }, 300)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [classes.length, choice.engine, folderAsked])

  const engine = descriptorOf(choice.engine)

  const clean = birth.name.trim()
  const known = useMemo(() => knownProjects(agents), [agents])
  const problems = birthProblems(birth, known, projectsFolder.path)
  const engineRefused = engines.find((r) => r.id === choice.engine && !r.usable) ?? null
  const ready = engineRefused === null && birthReady(problems)

  // a provider connected or signed in here is picked: the new id
  async function providersChanged(): Promise<void> {
    const before = new Set((providers ?? []).map((p) => p.id))
    const after = await loadProviders()
    const fresh = after.find((p) => !before.has(p.id))
    if (fresh) setChoice((c) => ({ ...c, provider: fresh.id === 'default' ? '' : fresh.id }))
  }

  // the silo changes, each on its own: what failed is said, nothing stops
  async function applySilos(): Promise<string[]> {
    const ops = siloOps(silos ?? [], choice.silos)
    const fresh = (sid: string): boolean => !applied.current.has(sid)
    const failed: string[] = []
    for (const sid of ops.uninstall.filter(fresh)) {
      try {
        await api.silos.uninstall(sid)
        applied.current.add(sid)
      } catch {
        failed.push(sid)
      }
    }
    for (const sid of ops.install.filter(fresh)) {
      try {
        const { submission } = await api.silos.installAvailable(sid)
        applied.current.add(sid) // submitted: a retry must not submit it twice
        await api.silos.approve(submission.id, { producers: [], automation: false })
      } catch {
        failed.push(sid)
      }
    }
    return failed
  }

  async function create(): Promise<void> {
    if (busy || !ready) return
    setBusy(true)
    setError(null)
    try {
      const failed = await applySilos()
      // what a new project starts with: saved only when it differs from
      // Recommended (or a stored choice goes back to it) — before the
      // agent, whose folder is born with it
      let startWarn: string | null = null
      const startPatch = startingSetPatch(choice.engine, classes, choice.start ?? {})
      if (startPatch) {
        try {
          const v = await api.platformSettings.setStartingSet(startPatch)
          setStartClasses(v?.startingSet ?? {})
          setChoice((c) => ({ ...c, start: {} }))
        } catch {
          startWarn = 'Couldn’t save what new projects start with — its project starts with the recommended set; change it in Settings › Accounts & providers.'
        }
      }
      // an engine Silos uses is a WIRED engine (owner 23-11): connecting it
      // on the first run installs the two hooks — what they are is said in
      // Settings › Engines, which removes them (the tour says only that
      // Silos connects to it). Never re-added behind the owner's
      // back: if they go missing later, a Needs-you row says so instead.
      let hooksWarn: string | null = null
      try {
        if (choice.engine === defaultHarnessId()) await api.installClaudeHooks()
      } catch {
        hooksWarn = 'Couldn’t wire Claude Code (its hooks) — finish it in Settings › Engines.'
      }
      const silosWarn =
        [failed.length ? `Couldn’t change ${failed.join(', ')} — finish it in Settings › Silos.` : null, hooksWarn, startWarn].filter(Boolean).join(' ') || null
      const made = await api.agents.create({ ...birthPayload(birth), ...agentPayloadExtras(choice, defaultHarnessId()) })
      const warn = [made.warn, silosWarn].filter(Boolean).join(' ')
      startFirstMeeting({ agentId: made.agent.id, ...(warn ? { warn } : {}), ...(made.startWarn ? { startWarn: made.startWarn } : {}) })
      await loadOverview()
      useStore.getState().changePage({ kind: 'agent', id: made.agent.id })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  // what each step has picked, under its name on the rail
  const siloCount = (silos ?? []).filter((r) => choice.silos[r.id] ?? r.on).length
  const picked: Record<TourStep, string> = {
    project: projectName(birth) || PROJECT_NEW,
    who: clean || 'An agent',
    engine: engine.label,
    'runs-on': choice.provider === '' ? (engine.ui.ownLogin ? 'Its own sign-in' : 'Your subscription') : providerLabel(providers ?? [], choice.provider),
    'at-start': classes.every((c) => classOn(c, choice.start ?? {}) === c.recommended) ? 'Recommended' : 'Your choice',
    silos: silos === null ? '…' : `${siloCount} on`,
  }
  // a step whose pick can't run yet says so on the rail (the machine's
  // Claude login, signed out) — signing in is that step's, never the first's
  const machineOut =
    choice.provider === '' &&
    !engine.ui.ownLogin &&
    engine.providerKinds.includes('claude-account') &&
    (providers ?? []).some((p) => p.kind === 'claude-account' && p.id === 'default' && !p.account.loggedIn)
  if (machineOut) picked['runs-on'] = 'Not signed in yet'
  const attention: Partial<Record<TourStep, boolean>> = {
    project: problems.project !== null || errorAtProject(error),
    'runs-on': machineOut,
    engine: engineRefusedId(engines, choice.engine),
  }
  // a step the tour no longer has (At start after switching engines, Engine
  // once a second one proves unusable) gives way to the nearest one before it
  const order = TOUR_STEPS.map((s) => s.id)
  const shown: TourStep =
    order
      .slice(0, order.indexOf(step) + 1)
      .reverse()
      .find((id) => steps.some((s) => s.id === id)) ?? 'project'
  // a refusal that names a field is said under it while its step is shown
  const errorAt = error ? fieldForError(error) : null
  const errorField = (errorAt === 'project' && shown === 'project') || (errorAt === 'name' && shown === 'who') ? errorAt : null
  const at = steps.findIndex((s) => s.id === shown)
  const next = steps[at + 1]
  const back = steps[at - 1]

  return (
    <div className="flex flex-1 items-start justify-center overflow-y-auto px-4 py-8 sm:px-6 sm:pt-[12vh]">
      {/* not a <form>: steps carry their own (Claude's sign-in, the connect
          cards), and a form inside a form makes the browser submit the page
          itself — Create and Enter are explicit instead */}
      <div data-testid="welcome" className="w-full max-w-lg">
        <Logo size={28} />

        <ol aria-label="Setup" className="mt-5 grid gap-2" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
          {steps.map((s, i) => {
            const current = s.id === shown
            const seen = i < at
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => setStep(s.id)}
                  aria-current={current ? 'step' : undefined}
                  className={`group flex w-full flex-col items-start border-t-2 pt-2 text-left focus-visible:outline-none ${current ? 'border-terracotta' : seen ? 'border-ink-2' : 'border-line hover:border-ink-3'}`}
                >
                  <span className={`flex items-center gap-1 text-[12px] ${current ? 'text-ink' : 'text-ink-2 group-hover:text-ink'}`}>
                    {seen ? (
                      <Check size={11} aria-hidden="true" className="text-ink-2" />
                    ) : (
                      <span aria-hidden="true" className="tabular-nums text-ink-3">
                        {i + 1}
                      </span>
                    )}
                    {s.name}
                  </span>
                  <span className={`mt-0.5 w-full truncate text-[11.5px] ${attention[s.id] ? 'text-terracotta' : 'text-ink-3 group-focus-visible:text-ink'}`}>
                    {picked[s.id]}
                  </span>
                </button>
              </li>
            )
          })}
        </ol>

        <div className="mt-6">
          {shown === 'project' ? (
            <ProjectStep
              birth={birth}
              known={known}
              agents={agents}
              problems={problems}
              onEnter={() => {
                if (ready) void create()
                else if (next) setStep(next.id)
              }}
              errors={{ project: errorField === 'project' ? error : null }}
              onBirth={(d) => {
                setBirth((cur) => ({ ...cur, ...d }))
                setError(null)
              }}
            />
          ) : shown === 'who' ? (
            <WhoStep
              birth={birth}
              problems={problems}
              onEnter={() => void create()}
              errors={{ name: errorField === 'name' ? error : null }}
              onBirth={(d) => {
                setBirth((cur) => ({ ...cur, ...d }))
                setError(null)
              }}
            />
          ) : shown === 'engine' ? (
            <EngineStep rows={engines} engine={choice.engine} onPick={(eid) => setChoice((c) => withEngine(c, eid))} />
          ) : shown === 'runs-on' ? (
            <RunsOnStep
              engine={engine}
              providers={providers}
              provider={choice.provider}
              onPick={(p) => setChoice((c) => ({ ...c, provider: p }))}
              onChanged={() => void providersChanged()}
            />
          ) : shown === 'at-start' ? (
            <AtStartStep
              name={clean}
              classes={classes}
              facts={facts}
              ticks={choice.start ?? {}}
              onToggle={(cid, on) => setChoice((c) => ({ ...c, start: { ...(c.start ?? {}), [cid]: on } }))}
            />
          ) : (
            <SilosStep rows={silos} choice={choice.silos} onToggle={(sid, on) => setChoice((c) => ({ ...c, silos: { ...c.silos, [sid]: on } }))} />
          )}
        </div>

        {engineRefused ? (
          <p role="alert" className="mt-4 text-sm text-terracotta">
            {engineRefused.why ?? `${engineRefused.label} can’t run on this machine.`}
            {steps.some((s) => s.id === 'engine') ? ' Pick another engine, or install it and come back.' : ' Install it and come back.'}
          </p>
        ) : null}
        {error && errorField !== 'project' && errorField !== 'name' ? (
          <p role="alert" className="mt-4 text-sm text-terracotta">
            {error}
          </p>
        ) : null}

        <div className="mt-6 flex items-center gap-3">
          {back ? (
            <button type="button" onClick={() => setStep(back.id)} className="text-sm text-ink-2 hover:text-ink">
              Back
            </button>
          ) : (
            // nothing is made: Home takes the pane, the sidebar's «+» guides
            <button type="button" onClick={() => useStore.getState().skipWelcome()} className="text-sm text-ink-3 hover:text-ink">
              Skip for now
            </button>
          )}
          <span className="flex-1" />
          {next ? (
            <button
              type="button"
              onClick={() => setStep(next.id)}
              className="rounded-lg border border-line px-4 py-2.5 text-sm font-medium text-ink hover:border-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40"
            >
              {next.name}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void create()}
            disabled={busy || !ready}
            className="rounded-lg bg-terracotta px-5 py-2.5 text-sm font-medium text-on-terracotta hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40"
          >
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
        <p className="mt-2 text-right text-[11.5px] text-ink-3">{keepsOut(clean)}</p>
      </div>
    </div>
  )
}
