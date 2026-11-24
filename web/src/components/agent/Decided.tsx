// Decided — what the agent decided on its own, on its page:
// «X decided: <title> · Undo», its lone acts on its recurring work
// («X withdrew: <name> · Restore ›», «X paused: <name> · Unpause»),
// initiatives and recurring work leading, the reactive tail folded in one
// line («…and <n> tasks from its inbox ›»). Empty: nothing, no box.
// The moment it serves: coming back to an agent that moved without you and
// taking back, in one touch, what you don't want — Undo says on pressing what
// it doesn't undo.
import { useState } from 'react'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { UNDO_SAYS, decidedRow, doorWords, reactiveFold, undoTarget } from '../../lib/initiative'
import { taskPageOfKey } from '../../lib/task-origin'
import type { AgentView, Creation } from '../../lib/types'

export function Decided({
  agent,
  items,
  reactive,
  onChanged,
  testId = 'decided',
}: {
  agent: Pick<AgentView, 'id' | 'name'>
  items: readonly Creation[]
  reactive: number
  onChanged: () => void
  testId?: string
}) {
  const changePage = useStore((s) => s.changePage)
  // the row whose Undo was pressed: the sentence and the confirm under it
  const [undoing, setUndoing] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<{ id: string; text: string } | null>(null)
  const fold = reactiveFold(reactive)
  if (items.length === 0 && !fold) return null

  async function act(c: Creation, run: () => Promise<unknown>): Promise<void> {
    setBusy(c.id)
    setError(null)
    try {
      await run()
      setUndoing(null)
      onChanged()
    } catch (e) {
      setError({ id: c.id, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }

  const open = (c: Creation): (() => void) | null => {
    if (c.action === 'withdrew') return null // in the trash: Restore is its door
    if (c.kind === 'task') {
      const p = taskPageOfKey(c.ref)
      return p ? () => changePage(p) : null
    }
    return () => changePage({ kind: 'automation', id: c.ref })
  }

  return (
    <>
      <span className="mt-2.5 text-[12px] text-ink-3 sm:mt-0">Decided</span>
      {/* focusable: the heartbeat row's «decided N things ›» brings it into view */}
      <ul
        tabIndex={-1}
        className="-mx-1.5 -my-1 flex min-w-0 flex-col gap-1 rounded-md px-1.5 py-1 outline-none transition-shadow duration-300 focus:ring-2 focus:ring-terracotta/30"
        data-testid={testId}
      >
        {items.map((c) => {
          const r = decidedRow(c, agent.name)
          const go = open(c)
          const door = (): void => {
            if (r.door === 'undo') {
              setUndoing(undoing === c.id ? null : c.id)
              return
            }
            if (r.door === 'restore') void act(c, () => api.initiative.restore(c.ref))
            else void act(c, () => api.automations.resume(c.ref))
          }
          return (
            <li key={c.id} data-testid={`${testId}-row`} className="text-[12.5px] leading-snug">
              <p className="text-ink">
                {go ? (
                  <button type="button" onClick={go} className="text-left hover:text-terracotta">
                    {r.text}
                  </button>
                ) : (
                  r.text
                )}
                {r.outside ? (
                  <span data-testid={`${testId}-outside`} className="text-terracotta/90">
                    {r.outside}
                  </span>
                ) : null}
                {' · '}
                <button
                  type="button"
                  disabled={busy === c.id}
                  onClick={door}
                  aria-expanded={r.door === 'undo' ? undoing === c.id : undefined}
                  className="text-ink-2 underline-offset-2 hover:text-terracotta hover:underline disabled:opacity-50"
                >
                  {doorWords(r.door)}
                </button>
              </p>
              {undoing === c.id ? (
                <p
                  role="status"
                  data-testid={`${testId}-undo-says`}
                  className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md border border-line bg-canvas/60 px-2.5 py-1.5 text-[12px] text-ink-2"
                >
                  <span>{UNDO_SAYS}</span>
                  <button
                    type="button"
                    disabled={busy === c.id}
                    onClick={() => void act(c, () => api.initiative.undo(undoTarget(c)))}
                    data-testid={`${testId}-undo-confirm`}
                    className="rounded-full border border-terracotta/40 bg-terracotta-soft px-2.5 py-0.5 text-[11px] font-medium text-terracotta hover:border-terracotta disabled:opacity-50"
                  >
                    Undo
                  </button>
                  <button type="button" onClick={() => setUndoing(null)} className="text-[11px] text-ink-3 hover:text-ink">
                    Cancel
                  </button>
                </p>
              ) : null}
              {error?.id === c.id ? (
                <p role="alert" className="mt-0.5 text-[12px] text-terracotta">
                  {error.text}
                </p>
              ) : null}
            </li>
          )
        })}
        {fold ? (
          <li className="text-[12px] text-ink-2">
            <button
              type="button"
              data-testid={`${testId}-reactive`}
              onClick={() => changePage({ kind: 'tasks', agent: [agent.id] })}
              className="hover:text-terracotta"
            >
              {fold}
            </button>
          </li>
        ) : null}
      </ul>
    </>
  )
}
