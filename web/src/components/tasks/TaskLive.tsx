// TaskLive — the task's live line: proof of life after a gesture, in one line, never a silent screen.
//   «Starting X…»  →  «X is on it · <tool> · <n>s ago»  ·  Stop
//   «X couldn't start: <why>» (an engine's: its door: Settings › Engines, where the engine updates)
//   «X is running <n> things already — it starts when one ends»
//   «the fleet is running <n> things — X starts when one ends»
//   «Your console is on it · Open ›» (yours: no Stop)
// The server says the facts (GET /api/tasks/mode `live`); the WS stream says
// the rest (store turnPulse). give.ts says every word. While something is on
// its way the line re-reads the facts on its own (a wake goes at the
// resident's next pass), and stops reading once nothing is.
import { useEffect, useState } from 'react'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { liveLine, liveStateOf, type LiveState } from '../../lib/give'
import type { TaskLiveFact } from '../../lib/types'

const REREAD_MS = 2_500

export function TaskLive({
  name,
  agentId,
  fact,
  reload,
  onOpen,
  testId = 'task-live',
}: {
  name: string
  agentId: string
  fact: TaskLiveFact | null | undefined
  // re-read the facts (the page's useTaskMode reload)
  reload: () => void
  // «Open ›» on a console that holds the task
  onOpen?: (sessionId: string) => void
  testId?: string
}) {
  const pulse = useStore((s) => s.turnPulse)
  const changePage = useStore((s) => s.changePage)
  const [now, setNow] = useState(() => Date.now())
  const [stopping, setStopping] = useState<'idle' | 'busy' | 'said'>('idle')
  const state: LiveState | null = liveStateOf(fact, pulse)
  const moving = state !== null && state.kind !== 'console'
  // the facts move without a WS event of their own (a wake handed over at
  // the next pass, a queue that frees): re-read while something is on its way
  useEffect(() => {
    if (!moving) return
    const t = setInterval(reload, REREAD_MS)
    return () => clearInterval(t)
  }, [moving, reload])
  // «<n>s ago» counts on its own
  useEffect(() => {
    if (state?.kind !== 'on-it' || state.lastAt === null) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [state?.kind, state?.kind === 'on-it' ? state.lastAt : null]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (state === null) setStopping('idle')
  }, [state])
  if (!state || !fact) return null
  const line = liveLine(name, state, now)
  const turns = fact.kind === 'running' ? fact.turns.map((t) => t.turnId) : []
  const stop = async (): Promise<void> => {
    setStopping('busy')
    try {
      await api.agents.stop(agentId, { turns })
    } catch {
      /* said below: the line stays */
    }
    setStopping('said')
    reload()
  }
  // one dot carries the state: a breathing one while it works, a hollow one
  // while it waits its turn, a still amber one when it could not start
  const dot =
    state.kind === 'failed'
      ? 'bg-[var(--health-amber)]'
      : state.kind === 'queued-agent' || state.kind === 'queued-fleet' || state.kind === 'held'
        ? 'border border-ink-3 bg-transparent'
        : state.kind === 'starting'
          ? 'bg-terracotta animate-pulse motion-reduce:animate-none'
          : 'dot-blink bg-terracotta'
  return (
    <p
      role="status"
      aria-live="polite"
      data-testid={testId}
      data-state={state.kind}
      className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-[12.5px] leading-snug"
    >
      {/* the dot rides the sentence's first line — never alone on a line of its own when the words wrap */}
      <span className={`min-w-0 ${state.kind === 'failed' ? 'text-ink' : state.kind === 'on-it' || state.kind === 'starting' ? 'text-ink' : 'text-ink-2'}`}>
        <span aria-hidden="true" className={`relative top-[-2px] mr-2 inline-block h-1.5 w-1.5 rounded-full align-middle ${dot}`} />
        {line.text.charAt(0).toUpperCase()}
        {line.text.slice(1)}
      </span>
      {line.stop && turns.length > 0 ? (
        <button
          type="button"
          data-testid={`${testId}-stop`}
          disabled={stopping === 'busy'}
          onClick={() => void stop()}
          className="rounded text-[12px] font-medium text-ink-2 underline decoration-line underline-offset-2 enabled:hover:text-terracotta enabled:hover:decoration-terracotta/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/30 disabled:opacity-50"
        >
          {stopping === 'busy' ? 'Stopping…' : 'Stop'}
        </button>
      ) : null}
      {state.kind === 'console' && fact.kind === 'console' && onOpen ? (
        <button
          type="button"
          data-testid={`${testId}-open`}
          onClick={() => onOpen(fact.sessionId)}
          className="rounded text-[12px] font-medium text-terracotta underline decoration-terracotta/40 underline-offset-2 hover:decoration-terracotta"
        >
          Open ›
        </button>
      ) : null}
      {state.kind === 'failed' && state.engine ? (
        <button
          type="button"
          data-testid={`${testId}-engine`}
          onClick={() => changePage({ kind: 'settings', tab: 'engines' })}
          className="rounded text-[12px] text-ink-2 underline decoration-line underline-offset-2 hover:text-terracotta"
        >
          Update it in Settings ›
        </button>
      ) : null}
    </p>
  )
}
