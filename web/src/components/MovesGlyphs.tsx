// MovesGlyphs — the one mark of an agent that moves without you (a single
// glyph ⟳ = On its own; Proactive has its own, distinct one — a radar: it
// goes looking —,
// titled «Proactive — a round <period words>»), drawn as line icons so every
// font shows them. Muted; the sentence on hover. Nothing when it is Only
// when told.
import { Radar, RefreshCw } from 'lucide-react'
import { proactiveMarkerWords, PROACTIVE_WORDS } from '../lib/proactive'
import type { Period } from '../lib/period'
import type { Position } from '../lib/types'

export const ON_ITS_OWN_WORDS = 'On its own'
export { PROACTIVE_WORDS }

export function MovesGlyphs({
  position,
  period = null,
  size = 10,
  testId = 'agent-moves',
}: {
  position: Position | undefined
  // its heartbeat's period — the proactive marker's title says it
  period?: Period | null
  size?: number
  testId?: string
}) {
  if (position === 'proactive') {
    const words = proactiveMarkerWords(period)
    return (
      <span
        data-testid={testId}
        data-position="proactive"
        title={words}
        aria-label={words}
        className="inline-flex shrink-0 items-center self-center text-terracotta/80"
      >
        <Radar size={size + 1} strokeWidth={2} aria-hidden="true" />
      </span>
    )
  }
  if (position !== 'own') return null
  return (
    <span
      data-testid={testId}
      data-position="own"
      data-glyphs="⟳"
      title={ON_ITS_OWN_WORDS}
      aria-label={ON_ITS_OWN_WORDS}
      className="inline-flex shrink-0 items-center self-center text-ink-3"
    >
      <RefreshCw size={size} strokeWidth={2} aria-hidden="true" />
    </span>
  )
}
