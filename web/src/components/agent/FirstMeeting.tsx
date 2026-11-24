// FirstMeeting — an agent's first minute: created with
// a mission, its page proves it is alive — «<Name> is reading its mission…»
// (one attended chat turn), then what it answered as a card, word for word
// («I'll look after: … · I won't: …», never parsed) with «Right»,
// «Change» and always «Make it a task instead»; the card closes with its
// period («Every Monday at 09:07 ›») only when the agent really is On
// its own — a birth degraded to Only when told (territory off) says that and
// its door instead. A turn that can't start says why, with its door.
// Then «What should <Name> do first?» — the Give box. Without a
// mission: «<Name> is here. It does what you give it.» and the same box.
// The moment it serves: creation, without decisions — you see it understood
// before you hand it anything.
import { GiveContext } from './GiveContext'
import { useGoHome } from '../knows/go-home'
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../store'
import { TERRITORY_DOOR_WORDS } from '../../lib/territory'
import { openAgentSettings } from './doors'
import { api } from '../../lib/api'
import { refreshTasks, useTasks } from '../../hooks/useTasks'
import { STANDING_PLAN, taskPage } from '../../lib/tasks'
import { surfaceOfAgent } from '../../lib/give'
import { endFirstMeeting, FIRST_READ_PROMPT, updateFirstMeeting, useFirstMeeting } from '../../lib/first-meeting'
import type { AgentView } from '../../lib/types'
import { capitalized, periodWords } from '../../lib/period'
import { GiveDialog } from '../tasks/GiveDialog'
import { OpeningLine, useTaskOpen } from '../tasks/TaskMode'

/** «Every Monday at 09:07 ›» — its heartbeat's period, the door to its control, with its real minute. */
export function thinksWords(a: Pick<AgentView, 'heartbeat'>): string | null {
  const p = a.heartbeat?.period
  return p ? `${capitalized(periodWords(p))} ›` : null
}

export function FirstMeeting({ agent }: { agent: AgentView }) {
  const m = useFirstMeeting(agent.id)
  const pulse = useStore((s) => (m?.turnId ? s.turnPulse[m.turnId] : undefined))
  const changeTab = useStore((s) => s.changeTab)
  const loadOverview = useStore((s) => s.loadOverview)
  const tasks = useTasks(m !== null)
  const [cardClosed, setCardClosed] = useState(false)
  const [instead, setInstead] = useState<{ busy: boolean; error: string | null; done: boolean }>({ busy: false, error: null, done: false })
  const opener = useTaskOpen({ taskKey: '', name: agent.name, onDone: () => refreshTasks() })
  const sent = useRef(false)
  const goHome = useGoHome()
  const hasMission = !!agent.mission

  // the one attended turn that reads the mission (lane normal) — sent once
  useEffect(() => {
    if (!m || !hasMission || m.turnId || m.failed || sent.current) return
    sent.current = true
    Promise.resolve(api.chat(agent.id, FIRST_READ_PROMPT, undefined, undefined, undefined, 'Reading its mission'))
      .then((r) => updateFirstMeeting({ turnId: r.turnId }))
      .catch((e: unknown) => updateFirstMeeting({ failed: e instanceof Error ? e.message : String(e) }))
  }, [m, hasMission, agent.id])

  if (!m) return null
  const name = agent.name
  const failed = m.failed ?? (pulse?.ended === 'error' ? (pulse.error ?? 'its turn ended with an error') : null)
  const reading = hasMission && !failed && (!m.turnId || !pulse?.ended)
  const said = pulse?.said?.trim() ?? ''
  const own = agent.control === 'own'

  // «Make it a task instead»: the mission becomes ONE task, given —
  // and the mission goes: «instead» is a replacement, never a duplicate that
  // would keep thinking weekly on a text already turned into a task. The
  // task first, in ONE request: a refusal
  // leaves the mission where it was
  async function makeTask(): Promise<void> {
    const text = (agent.mission?.text ?? '').trim()
    if (!text || !agent.folder) return
    setInstead({ busy: true, error: null, done: false })
    try {
      const r = await api.tasksNew({ folder: agent.folder, plan: STANDING_PLAN, title: text.split('\n')[0]!.slice(0, 300), owner: agent.id })
      await api.agents.update(agent.id, { control: 'told', mission: null })
      refreshTasks()
      await loadOverview()
      setInstead({ busy: false, error: null, done: true })
      // Only when told now: you go in with it on the task
      await opener.go(surfaceOfAgent(agent), r.key)
    } catch (e) {
      setInstead({ busy: false, error: e instanceof Error ? e.message : String(e), done: false })
    }
  }

  const door = (label: string, onClick: () => void, testId: string, primary = false): React.ReactNode => (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={
        primary
          ? 'rounded-full bg-terracotta px-3 py-0.5 text-[12px] font-medium text-on-terracotta hover:brightness-105'
          : 'rounded-full border border-line px-3 py-0.5 text-[12px] text-ink hover:border-terracotta hover:text-terracotta'
      }
    >
      {label}
    </button>
  )

  return (
    <section data-testid="first-meeting" aria-label={`${name}'s first minute`} className="flex max-w-[62ch] flex-col gap-3">
      {!hasMission || instead.done ? (
        <p data-testid="first-here" className="font-display text-[19px] leading-snug text-ink">
          {instead.done ? (
            <>
              {name} keeps no mission — it does what you give it ·{' '}
              <button type="button" onClick={() => changeTab('mission')} className="text-ink-2 hover:text-terracotta">
                Write a mission ›
              </button>
            </>
          ) : (
            `${name} is here. It does what you give it.`
          )}
        </p>
      ) : reading ? (
        <p data-testid="first-reading" role="status" className="flex items-center gap-2 font-display text-[19px] leading-snug text-ink">
          <span aria-hidden="true" className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-terracotta motion-reduce:animate-none" />
          {name} is reading its mission…
        </p>
      ) : failed ? (
        <p data-testid="first-failed" role="alert" className="text-[14px] leading-snug text-ink">
          {name} couldn&rsquo;t start: <span className="text-terracotta">{failed}</span>{' '}
          <button
            type="button"
            onClick={() => {
              sent.current = false
              updateFirstMeeting({ failed: undefined, turnId: undefined })
            }}
            className="text-ink-2 underline decoration-line underline-offset-2 hover:text-terracotta"
          >
            Try again ›
          </button>
          {' · '}
          <button
            type="button"
            onClick={() => useStore.getState().changePage({ kind: 'settings', tab: 'engines' })}
            className="text-ink-2 underline decoration-line underline-offset-2 hover:text-terracotta"
          >
            Settings › Engines ›
          </button>
        </p>
      ) : !cardClosed ? (
        // what it answered, as it said it — the owner reads, then decides
        <div data-testid="first-card" className="rounded-xl border border-line bg-panel/60 px-4 py-3">
          <p className="whitespace-pre-wrap font-display text-[16px] leading-relaxed text-ink">
            {said || `${name} answered nothing — open its chat to see why.`}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {door('Right', () => setCardClosed(true), 'first-right', true)}
            {door('Change', () => changeTab('mission'), 'first-change')}
            <button
              type="button"
              data-testid="first-instead"
              disabled={instead.busy}
              onClick={() => void makeTask()}
              className="text-[12px] text-ink-2 underline decoration-line underline-offset-2 hover:text-terracotta disabled:opacity-50"
            >
              Make it a task instead
            </button>
          </div>
          {instead.error ? (
            <p role="alert" className="mt-1.5 text-[12px] text-terracotta">
              {instead.error}
            </p>
          ) : null}
          <OpeningLine opener={opener} />
          <p className="mt-2 text-[12px] text-ink-2" data-testid="first-control">
            {own && thinksWords(agent) ? (
              <button type="button" onClick={() => changeTab('control')} className="hover:text-terracotta">
                {thinksWords(agent)}
              </button>
            ) : m.warn ? (
              <>
                {m.warn.replace(/ ›$/, '')} ·{' '}
                <button type="button" onClick={() => openAgentSettings(agent.id)} className="hover:text-terracotta">
                  {TERRITORY_DOOR_WORDS}
                </button>
              </>
            ) : null}
          </p>
        </div>
      ) : null}
      {/* what its project starts with could not be set: said once, with
          the door to where it is switched */}
      {m.startWarn ? (
        <p data-testid="first-start-warn" role="status" className="text-[12px] leading-snug text-ink-2">
          <span className="mr-1.5 inline-block h-1.5 w-1.5 -translate-y-px rounded-full bg-[var(--health-amber)] align-middle" aria-hidden="true" />
          {m.startWarn}
          {agent.folder ? (
            <>
              {' '}
              <button
                type="button"
                onClick={() => goHome({ kind: 'project', folder: agent.folder!, tab: 'tools' })}
                className="text-ink-2 underline decoration-line underline-offset-2 hover:text-terracotta"
              >
                Tools ›
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      {/* optional context — files it reads, skills it can use */}
      {!reading && !failed ? <GiveContext agent={agent} /> : null}
      {/* what first — the Give box, this agent as the owner */}
      {!reading && !failed ? (
        tasks.state === 'ready' ? (
          <GiveDialog
            all={tasks.tasks}
            agents={useStore.getState().agents}
            initialOwner={agent.id}
            placeholder={`What should ${name} do first?`}
            onClose={() => endFirstMeeting()}
            onCreated={(nt) => {
              endFirstMeeting()
              if (!nt.started) useStore.getState().changePage(taskPage(nt))
            }}
          />
        ) : (
          <p className="text-[12px] text-ink-3" aria-live="polite">
            Reading tasks…
          </p>
        )
      ) : null}
    </section>
  )
}
