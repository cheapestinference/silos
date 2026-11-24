// GiveTo — «Give to… ›» on a task's page. The
// moment it serves: moment 2 — a task nobody moves (nobody's, an archived
// agent's, the wrong agent's) gets an owner who will. Reached from the task
// page only, beside Done and Drop; Needs you's «N tasks sit untouched» leads
// to the lens and from there here — no row gives a task in one tap.
//
// The choices are the server's (GET /api/tasks/mode `handTo`: you, and the
// agents in play whose fence holds the project), each saying how it moves;
// none is picked for you. A task added outside Silos says so here too:
// giving it counts as keeping it. ONE gesture: POST /api/tasks/act hand with
// what the page painted (owner, state, outside) — what happened next is the
// page's to say (TaskPage).
import { useState } from 'react'
import type { TaskModeView } from '../../lib/types'

const control = 'rounded-md border border-line bg-canvas px-2 py-1 text-[12.5px] outline-none focus:border-terracotta'

export function moveWords(wakes: 'task' | 'never' | null): string {
  return wakes === 'task' ? 'starts on its own' : wakes === 'never' ? 'opens with you' : 'on your list'
}

export function GiveTo({
  handTo,
  outside,
  busy,
  onGive,
  onCancel,
  error,
  initial = '',
}: {
  handTo: NonNullable<TaskModeView['handTo']>
  // a name the page's prompt picked (the agents of its project); the
  // gesture is still Give
  initial?: string
  // the page showed «added outside Silos ›» (OriginMark)
  outside: boolean
  busy: boolean
  onGive: (to: { id: string; name: string; wakes: 'task' | 'never' | null }) => void
  onCancel: () => void
  error: React.ReactNode
}) {
  const [to, setTo] = useState(initial)
  const chosen = handTo.find((x) => x.id === to) ?? null
  const agents = handTo.filter((x) => x.id !== 'owner')
  return (
    <form
      data-testid="task-give-to-form"
      className="flex w-full flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (chosen) onGive(chosen)
      }}
    >
      <span className="flex flex-wrap items-center gap-2">
        <label className="text-[12px] text-ink-2" htmlFor="task-give-to">
          Give to
        </label>
        <select
          id="task-give-to"
          data-testid="task-give-to"
          autoFocus
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className={`${control} min-w-0 flex-1`}
        >
          <option value="" disabled>
            Choose who
          </option>
          {handTo.map((x) => (
            <option key={x.id} value={x.id}>
              {x.id === 'owner' ? 'You' : x.name}
            </option>
          ))}
        </select>
      </span>
      {chosen ? (
        <p data-testid="task-give-to-moves" className="text-[11.5px] text-ink-3">
          {chosen.id === 'owner' ? 'It goes on your list.' : `${chosen.name} ${moveWords(chosen.wakes)}.`}
        </p>
      ) : null}
      {agents.length === 0 ? <p className="text-[11.5px] text-ink-3">No agent can open this project — only you can take it.</p> : null}
      {outside ? (
        <p data-testid="task-give-to-outside" className="text-[11.5px] text-[var(--health-amber)]">
          Silos didn&apos;t see who added it — giving it counts as keeping it.
        </p>
      ) : null}
      <span className="flex items-center gap-2">
        <button
          type="submit"
          data-testid="task-give-to-confirm"
          disabled={busy || !chosen}
          className="rounded-full border border-terracotta/40 bg-terracotta-soft px-3 py-1 text-[12px] font-medium text-terracotta enabled:hover:border-terracotta disabled:opacity-50"
        >
          {busy ? 'Giving…' : chosen ? `Give to ${chosen.id === 'owner' ? 'you' : chosen.name}` : 'Give'}
        </button>
        <button type="button" onClick={onCancel} className="text-[12px] text-ink-3 hover:text-ink">
          Cancel
        </button>
      </span>
      {error}
    </form>
  )
}

// what the page says once it was given (the server's answer, in words)
export function handedWords(name: string, to: string, assign: { queued: boolean; why?: string; held?: string; wakes?: string } | undefined): string {
  if (to === 'owner') return 'Given to you — it is on your list.'
  if (!assign) return `Given to ${name}.`
  if (assign.wakes === 'never') return `Given to ${name} — it opens with you.`
  if (assign.queued) return assign.held ? `Given to ${name} — ${assign.held}.` : `Given to ${name} — starting now.`
  return `Given to ${name} — it did not start: ${assign.why ?? 'nothing was queued'}.`
}
