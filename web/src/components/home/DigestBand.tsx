// DigestBand — the daily digest under the pulse: the
// frozen cut of what you did not watch, quiet reading until you mark it
// Seen. The pulse and the inbox below are live; this band is the morning's
// record, so it speaks in the past tense and links nothing. Several unread
// digests arrive already summed by the server («Since Friday 08:00»).
import { useState } from 'react'
import type { DigestBand as Band } from '../../lib/types'
import { digestWords } from '../../lib/digest'

export function DigestBand({
  band,
  now,
  nameOf,
  onSeen,
  busy = false,
}: {
  band: Band
  now: number
  nameOf: (agentId: string, fallback: string) => string
  onSeen: () => void
  busy?: boolean
}) {
  const w = digestWords(band, now, nameOf)
  const [open, setOpen] = useState(false)
  return (
    <section aria-label="Daily digest" data-testid="digest-band" className="mt-6 max-w-[62ch] border-l-2 border-terracotta/35 pl-4">
      <div className="flex items-baseline gap-3">
        <h2 className="font-display text-[15px] leading-tight text-ink">{w.title}</h2>
        {w.since ? <span className="font-mono text-[11px] text-ink-3">{w.since}</span> : null}
        <button
          type="button"
          onClick={onSeen}
          disabled={busy}
          className="ml-auto shrink-0 text-[11px] text-ink-2 underline-offset-2 hover:text-terracotta hover:underline disabled:opacity-50"
        >
          Seen
        </button>
      </div>
      {/* folded, the band says what happened since — what waits is the
          Needs you list right below (the head of Home was a
          wall before the first thing to do); «all» unfolds the three blocks */}
      {open ? (
        <div className="mt-1.5 flex flex-col gap-1 text-[13px] leading-relaxed text-ink-2">
          <p>{w.waits}</p>
          <p>{w.happened.join(' ')}</p>
          {w.coming ? <p>{w.coming.join(' ')}</p> : null}
        </div>
      ) : (
        <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-ink-2">{w.happened.join(' ')}</p>
      )}
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="mt-0.5 font-mono text-[11px] text-ink-3 hover:text-terracotta">
        {open ? 'less' : 'all ›'}
      </button>
    </section>
  )
}
