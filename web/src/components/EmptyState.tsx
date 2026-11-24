// EmptyState.tsx — the app's contentless gaps: no agents yet (a welcome
// hero), no agent CHOSEN yet, an agent with no sessions at all, and an
// agent with sessions but none open. Lives in the Transcript's gap — the
// Composer stays below, ready to write.
// Subtle lucide icons (no new illustrations) + reviewed hero spacing — this
// pass's visual boldness is spent on the composer (a design constraint),
// here only hierarchy and breathing room are clarified.
import { MessageSquare, MousePointerClick, Users } from 'lucide-react'

export type EmptyStateVariant = 'no-agent' | 'choose-agent' | 'no-sessions' | 'choose-session'

export function EmptyState({ variant, name }: { variant: EmptyStateVariant; name?: string }) {
  if (variant === 'no-agent') {
    return (
      <div data-testid="empty-state" className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <Users size={40} strokeWidth={1.5} className="text-ink-2 opacity-40" aria-hidden="true" />
        <h1 className="font-display text-3xl tracking-tight text-ink">Your team awaits</h1>
        <p className="max-w-xs text-sm text-ink-2">Create your first agent — name, role, folder, and skills — and start talking to them.</p>
      </div>
    )
  }

  // 'choose-agent' lived in Threads.tsx ("Choose an agent") for the gap
  // where there's already a team but no agent chosen yet (selectedAgentId
  // null). It got lost migrating Threads into the unified sidebar — it's
  // not a pre-existing gap.
  const message =
    variant === 'no-sessions'
      ? `No conversations yet. Type below to start one with ${name ?? 'your agent'}.`
      : variant === 'choose-agent'
        ? 'Choose an agent'
        : 'Choose a conversation or type below to start a new one.'
  const Icon = variant === 'no-sessions' ? MessageSquare : variant === 'choose-agent' ? Users : MousePointerClick

  return (
    <div data-testid="empty-state" className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <Icon size={28} strokeWidth={1.5} className="text-ink-2 opacity-40" aria-hidden="true" />
      <p className="max-w-xs text-sm text-ink-2">{message}</p>
    </div>
  )
}
