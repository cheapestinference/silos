// UnlinkSheet — «Unlink…» on a task's CURRENT conversation.
// The moment it serves: letting go of work without leaving it in limbo —
// the conversation stays in the task's history and stops being its holder.
// Reached from the task page's Conversations rows (the current ones only)
// and, in its short form, from ⌘K.
//
// The choice of what the task becomes exists only when it is in progress
// and this is its LAST current thread (lib/task-link releaseOffersChoice):
// «Unlink — leave it to pick up · done · blocked · in review», «to pick up»
// by default. «blocked» asks, in the same sheet, on whom — a person or an
// agent and what for (waitingOn), or «blocked — on you» — so it never lands
// as a blocker nobody owns — and that wait rides the release's own write
// (one request, nothing to take back). Elsewhere it is a
// plain «Unlink». The server's words come back said (kept / already), and a
// refusal (400, 409) as is.
import { useState } from 'react'
import type { ReleaseState } from '../../lib/api'
import { RELEASE_CHOICES, releaseOffersChoice, unlinkConversation } from '../../lib/task-link'
import type { TaskView } from '../../lib/tasks'
import type { AgentView } from '../../lib/types'

const control = 'rounded-md border border-line bg-canvas px-2 py-1 text-[12.5px] outline-none focus:border-terracotta'

export function UnlinkSheet({
  task,
  sessionId,
  title,
  agents,
  onCancel,
  onDone,
}: {
  task: TaskView
  sessionId: string
  title: string
  agents: readonly AgentView[]
  onCancel: () => void
  onDone: (said: string) => void
}) {
  const choose = releaseOffersChoice(task)
  const [state, setState] = useState<ReleaseState>('pending')
  // blocked: on you, or on someone (an agent or a person by name) for something
  const [on, setOn] = useState<'you' | 'someone'>('you')
  const [who, setWho] = useState('')
  const [what, setWhat] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const others = agents.filter((a) => !a.archived && a.id !== task.owner)

  async function go(): Promise<void> {
    setBusy(true)
    setErr(null)
    try {
      // blocked: the wait rides the release — written only if it does land blocked
      const wait =
        choose && state === 'blocked'
          ? on === 'you'
            ? { owner: 'owner', action: what.trim() || 'unblock it' }
            : { owner: who.trim(), action: what.trim() }
          : null
      if (wait && on === 'someone' && wait.owner === '') {
        setErr('say who it waits on — or choose «on you»')
        setBusy(false)
        return
      }
      const r = await unlinkConversation(task.key, sessionId, choose ? state : undefined, wait)
      onDone(r.warn ? `${r.said} ${r.warn}` : r.said)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      data-testid="unlink-sheet"
      data-choice={choose ? 'true' : 'false'}
      onSubmit={(e) => {
        e.preventDefault()
        void go()
      }}
      className="mt-2 flex flex-col gap-2 rounded-lg border border-line bg-panel/60 px-3.5 py-3 text-[12.5px]"
    >
      <p className="text-ink-2">
        Unlink <span className="text-ink">«{title || 'this conversation'}»</span> — it stays in the task&apos;s history and stops working it.
      </p>
      {choose ? (
        <div role="radiogroup" aria-label="Leave the task" className="flex flex-wrap items-center gap-x-1 gap-y-1.5">
          <span className="mr-1 text-ink-2">Leave it</span>
          {RELEASE_CHOICES.map((c) => (
            <button
              key={c.state}
              type="button"
              role="radio"
              aria-checked={state === c.state}
              data-testid={`unlink-as-${c.state}`}
              onClick={() => setState(c.state)}
              className={`rounded-full px-2.5 py-0.5 text-[12px] transition-colors duration-150 ${state === c.state ? 'bg-terracotta-soft font-medium text-terracotta' : 'border border-line text-ink-2 hover:border-ink-3 hover:text-ink'}`}
            >
              {c.words}
            </button>
          ))}
        </div>
      ) : null}
      {choose && state === 'blocked' ? (
        <div data-testid="unlink-blocked" className="flex flex-col gap-1.5 border-l-2 border-line pl-3">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <label className="flex items-center gap-1.5 text-ink">
              <input type="radio" name="unlink-on" checked={on === 'you'} onChange={() => setOn('you')} className="accent-terracotta" />
              blocked — on you
            </label>
            <label className="flex items-center gap-1.5 text-ink">
              <input type="radio" name="unlink-on" checked={on === 'someone'} onChange={() => setOn('someone')} className="accent-terracotta" />
              on someone else
            </label>
          </span>
          {on === 'someone' ? (
            <span className="flex flex-wrap items-center gap-2">
              <input
                list="unlink-who"
                value={who}
                onChange={(e) => setWho(e.target.value)}
                placeholder="who — an agent or a person"
                aria-label="Who it waits on"
                className={`${control} w-[14rem]`}
              />
              <datalist id="unlink-who">
                {others.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </datalist>
            </span>
          ) : null}
          <input
            value={what}
            onChange={(e) => setWhat(e.target.value)}
            placeholder={on === 'you' ? 'what you need to do (optional)' : 'what for'}
            aria-label="What it waits for"
            maxLength={300}
            className={`${control} w-full`}
          />
        </div>
      ) : null}
      {err ? (
        <p role="alert" className="text-[12px] text-terracotta">
          {err}
        </p>
      ) : null}
      <span className="flex items-center gap-2">
        <button
          type="submit"
          disabled={busy}
          data-testid="unlink-confirm"
          className="rounded-full border border-line px-3 py-1 text-[12px] text-ink enabled:hover:border-terracotta enabled:hover:text-terracotta disabled:opacity-50"
        >
          {busy ? 'Unlinking…' : choose ? `Unlink — leave it ${RELEASE_CHOICES.find((c) => c.state === state)!.words}` : 'Unlink'}
        </button>
        <button type="button" onClick={onCancel} className="text-[12px] text-ink-3 hover:text-ink">
          Cancel
        </button>
      </span>
    </form>
  )
}
