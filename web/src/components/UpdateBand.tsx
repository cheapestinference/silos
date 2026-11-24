// UpdateBand.tsx — "your tab is running an older build" as a first-class
// signal, from the same system-notice family as ReconnectBand (mono, a
// thin top band). Neutral ink on panel — an invitation, not an alarm
// (amber stays reserved for connection trouble). It never auto-reloads:
// the reload is the owner's gesture, so a draft in the composer or a
// half-answered question is never lost. Hidden while the WS is down —
// ReconnectBand (z-30) owns that moment.
import { useStore } from '../store'
import { ownBuild, updateAvailable } from '../lib/build'

export function UpdateBand() {
  const serverBuild = useStore((s) => s.serverBuild)
  const connection = useStore((s) => s.connection)
  if (connection !== 'connected' || !updateAvailable(ownBuild, serverBuild)) return null

  return (
    <div
      role="status"
      className="fixed inset-x-0 top-0 z-20 border-b border-line bg-panel/95 px-3 py-1 text-center font-mono text-[11px] tracking-wide text-ink-2"
    >
      A new version of Silos is ready{' '}
      <button type="button" onClick={() => window.location.reload()} className="text-ink underline decoration-dotted underline-offset-2 hover:text-terracotta">
        Reload
      </button>
    </div>
  )
}
