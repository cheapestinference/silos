// OriginMark — «added outside Silos ›» on a task nobody can be shown to have
// added: no agent starts it on
// its own until the owner keeps it. Its one blessing here is the button,
// «Keep it — it's mine»; opening the task — or this mark — never blesses:
// looking at what a marked thing is, is what the mark asks for.
//
// The page reads the origin ONCE (useOriginOutside) and hands it here and to
// «Give to… ›», which sends what was painted: a read
// that failed paints no mark — and «Give» then says nothing of it, so the
// server's «look at it first» is the honest answer.
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'

export function useOriginOutside(taskKey: string): { outside: boolean; kept: () => void; reload: () => void } {
  const [outside, setOutside] = useState(false)
  const [n, setN] = useState(0)
  useEffect(() => {
    let cancelled = false
    setOutside(false)
    Promise.resolve(api.initiative?.origin(taskKey))
      .then((o) => {
        if (!cancelled) setOutside(o?.outside === true)
      })
      .catch(() => {
        /* no mark rather than a wrong one */
      })
    return () => {
      cancelled = true
    }
  }, [taskKey, n])
  return { outside, kept: () => setOutside(false), reload: () => setN((x) => x + 1) }
}

export function OriginMark({ taskKey, outside, onKept }: { taskKey: string; outside: boolean; onKept: () => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setOpen(false)
    setError(null)
  }, [taskKey])

  if (!outside) return null

  async function keep(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await api.initiative.keep(taskKey)
      onKept()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="task-origin-outside" className="mt-3 text-[12.5px]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="rounded-full border border-[color-mix(in_srgb,var(--health-amber)_45%,transparent)] px-2.5 py-0.5 text-[12px] text-[var(--health-amber)] hover:border-[var(--health-amber)]"
      >
        added outside Silos ›
      </button>
      {open ? (
        <div className="mt-2 flex max-w-[62ch] flex-wrap items-baseline gap-x-3 gap-y-1.5 rounded-lg border border-line bg-panel/60 px-3.5 py-2.5 text-ink-2">
          <span>{"Silos didn't see who added it, so no agent starts it on its own."}</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void keep()}
            data-testid="task-origin-keep"
            className="rounded-full border border-terracotta/40 bg-terracotta-soft px-2.5 py-0.5 text-[12px] font-medium text-terracotta hover:border-terracotta disabled:opacity-50"
          >
            {"Keep it — it's mine"}
          </button>
          {error ? (
            <span role="alert" className="basis-full text-[12px] text-terracotta">
              {error}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
