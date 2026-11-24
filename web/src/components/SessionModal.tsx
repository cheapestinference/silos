// SessionModal — a conversation read as a WINDOW over everything, without
// leaving the one you are in. The subagent-transcript pattern (a portal to
// document.body, a scrim, Esc / click-outside close, the body's scroll
// locked): a run's conversation is, to the conversation you are reading,
// exactly what a subagent's is — a separate thing you want to look at with
// room to breathe, then come back. Reached from a run's row (RunRow).
// "Open conversation" makes it the real open conversation when you mean
// to work in it. Never draggable, never a tab: Silos is a single-focus
// console (docs/product.md, "the window itself").
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { Turn as TurnRow } from './Turn'
import { MediaScope } from './MediaImage'
import type { SessionDetail } from '../lib/types'

export function SessionModal() {
  const reading = useStore((s) => s.readingSession)
  const closeReading = useStore((s) => s.closeReading)
  const openSession = useStore((s) => s.openSession)
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const folder = reading?.folder ?? null
  const id = reading?.id ?? null

  useEffect(() => {
    if (!folder || !id) return
    let cancelled = false
    setDetail(null)
    setError(null)
    Promise.resolve(api.sessionDetail(folder, id))
      .then((d) => {
        if (!cancelled && d) setDetail(d)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [folder, id])

  // Esc closes it (preventDefault: it must not read as "cancel the turn")
  // + the body's scroll is locked behind the scrim, like FileViewer.
  useEffect(() => {
    if (!reading) return
    function onKeyDown(e: globalThis.KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeReading()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = prev
    }
  }, [reading, closeReading])

  if (!reading || !folder || !id) return null
  const title = detail?.meta.title ?? 'Loading…'

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-ink/60 p-4 sm:p-8"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeReading()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Conversation · ${title}`}
        tabIndex={-1}
        className="modal-pop flex max-h-[85vh] w-[min(900px,92vw)] flex-col overflow-hidden rounded-xl border border-line bg-canvas shadow-2xl outline-none"
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
          <span className="shrink-0 rounded-full border border-line px-1.5 py-px font-mono text-[9px] uppercase tracking-wider text-ink-2">conversation</span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{title}</span>
          <button
            type="button"
            onClick={() => {
              closeReading()
              void openSession(folder, id, { exact: true })
            }}
            className="shrink-0 rounded-md border border-line px-2 py-0.5 text-xs text-ink-2 hover:border-terracotta hover:text-terracotta"
          >
            Open conversation →
          </button>
          <button
            type="button"
            aria-label="Close conversation window"
            onClick={closeReading}
            className="shrink-0 rounded-full p-1 text-ink-2 hover:bg-panel hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40"
          >
            <X size={16} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {error ? <p className="text-xs text-ink-2">{error}</p> : null}
          {!error && detail === null ? <p className="text-xs text-ink-2">Loading…</p> : null}
          {detail ? (
            <MediaScope base={`/api/sessions/${folder}/${id}`}>
              <div className="flex flex-col gap-3">
                {detail.turns.map((t) => (
                  <TurnRow key={t.index} turn={t} isNew={false} />
                ))}
              </div>
            </MediaScope>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  )
}
