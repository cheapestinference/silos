// ErrorStrip.tsx — the store's global error's only visible surface: a
// floating strip centered over the composer, dismissible by hand or on its
// own after 8s. App only mounts it when there's an error; the component
// itself rearms the timer whenever the message changes and clears it on unmount.
// A refusal the owner can answer (a claude outside Silos holding the
// conversation they want gone → "Close it and delete") carries an action
// (store.errorAction, tied to its message): the strip shows the button and
// does NOT auto-dismiss — a decision waits for the person.
import { useEffect } from 'react'
import { X } from 'lucide-react'
import { useStore } from '../store'

const AUTO_DISMISS_MS = 8000

export function ErrorStrip() {
  const error = useStore((s) => s.error)
  const rawAction = useStore((s) => s.errorAction)
  const clearError = useStore((s) => s.clearError)
  const action = rawAction !== null && rawAction.forMessage === error ? rawAction : null
  // a report (store.reportOnly, tied to its message): the same strip, quiet
  const report = useStore((s) => s.reportOnly !== null && s.reportOnly === s.error)

  useEffect(() => {
    if (error === null || action !== null) return
    const timer = setTimeout(() => clearError(), AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [error, action, clearError])

  if (error === null) return null

  return (
    <div
      role={report ? 'status' : 'alert'}
      className={`strip-slide-up fixed bottom-24 left-1/2 z-20 flex w-[calc(100%-2rem)] max-w-[48rem] -translate-x-1/2 items-start gap-2 rounded-lg border px-3 py-2 text-sm text-ink shadow-lg ${report ? 'border-line bg-panel' : 'border-terracotta bg-terracotta-soft'}`}
    >
      {/* a long error (e.g. the SDK binary's, 5 lines) used to grow the
          strip without limit and cover the composer/conversation. The
          height is capped and the text scrolls INSIDE — the strip never
          grows past ~8rem. */}
      <span className="min-h-0 max-h-32 min-w-0 flex-1 overflow-y-auto break-words">{error}</span>
      {action !== null ? (
        <button
          type="button"
          onClick={() => {
            clearError()
            action.run()
          }}
          className="shrink-0 rounded-md border border-terracotta px-2 py-0.5 font-display text-xs text-terracotta hover:bg-terracotta hover:text-on-terracotta"
        >
          {action.label}
        </button>
      ) : null}
      <button
        type="button"
        aria-label={report ? 'dismiss' : 'dismiss error'}
        onClick={() => clearError()}
        className="shrink-0 rounded-full p-0.5 text-ink-2 hover:text-ink"
      >
        <X size={14} />
      </button>
    </div>
  )
}
