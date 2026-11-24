// SessionDot.tsx — the conversation dot (lib/live.ts sessionSignal):
// blinking while the agent works, solid when it needs you — never on the
// open row. ONE two-state dot is the whole vocabulary a conversation row
// gets: no live/terminal/worktree chips anywhere. Shared by
// the Sidebar's tree and Pinned rows and by the agent page's Conversations,
// so the three read as one system. Terracotta is reserved for send/live/
// approval; this is exactly that family.
import type { SessionSignal } from '../lib/live'

// `slow`: working only on a background command (live.ts onlyShellRunning) —
// the same blink, a calmer beat
export function SessionDot({ signal, slow = false }: { signal: SessionSignal | undefined; slow?: boolean }) {
  if (!signal) return null
  return (
    <span
      data-testid="session-dot"
      data-signal={signal}
      data-slow={signal === 'working' && slow ? 'true' : undefined}
      aria-label={signal === 'working' ? 'agent working' : 'needs your attention'}
      className={`h-1.5 w-1.5 shrink-0 rounded-full bg-terracotta ${signal === 'working' ? (slow ? 'dot-blink dot-blink-slow' : 'dot-blink') : ''}`}
    />
  )
}
