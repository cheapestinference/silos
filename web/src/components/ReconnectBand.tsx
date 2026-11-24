// ReconnectBand.tsx — the WS connection state as a first-class signal
// (proof-of-life principle: "visible and honest connection state"). A thin
// amber band from the system-notice family: mono, a subtle pulse while
// it's down, and on return a "Reconnected" that fades over ~2s. No drama —
// reassures, doesn't alarm.
// Honest states: 'down' only once the drop has LASTED (GRACE_MS), and
// 'back' ONLY after the user actually saw 'down'. A blip that recovers
// within the grace paints nothing at all: WsClient deliberately recycles a
// healthy socket after a long tab hide (ws.ts STALE_HIDDEN_MS) and that
// round trip takes ~0.5s — narrating it as "Reconnecting… Reconnected" on
// every alt-tab back read as a flaky connection that wasn't.
import { useEffect, useState } from 'react'
import { useStore } from '../store'

const GRACE_MS = 1500

export function ReconnectBand() {
  const connection = useStore((s) => s.connection)
  const [phase, setPhase] = useState<'hidden' | 'down' | 'back'>('hidden')

  useEffect(() => {
    if (connection === 'reconnecting') {
      const id = setTimeout(() => setPhase('down'), GRACE_MS)
      return () => clearTimeout(id)
    }
    // connected: only if the drop was long enough to have been shown do we
    // announce the return (then unmount after 2s); otherwise stay hidden.
    setPhase((f) => (f === 'down' ? 'back' : f))
  }, [connection])

  useEffect(() => {
    if (phase !== 'back') return
    const id = setTimeout(() => setPhase('hidden'), 2000)
    return () => clearTimeout(id)
  }, [phase])

  if (phase === 'hidden') return null

  return (
    <div
      role="status"
      className={`fixed inset-x-0 top-0 z-30 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1 text-center font-mono text-[11px] tracking-wide text-amber-800 dark:text-amber-300 ${
        phase === 'down' ? 'band-pulse' : 'band-fade'
      }`}
    >
      {phase === 'down' ? 'Reconnecting…' : 'Reconnected'}
    </div>
  )
}
