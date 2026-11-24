// KnowsSheet.tsx — Knows below `lg` (mobile).
// The context column is `hidden lg:flex`: there the "Context" pill opens
// this bottom sheet (fixed to the bottom edge, capped height,
// `lg:hidden`) with the column's own KnowsBlock
// — the same component, not a copy of its rows. A row tap opens the Knows
// Drawer (store.openKnows), which below lg is presented as the same bottom
// sheet: AgentPage stops rendering this one in that same commit, so the
// sheet "mutates" into the drawer's content and closing the drawer returns
// straight to the conversation.
import { useRef } from 'react'
import { X } from 'lucide-react'
import { useStore } from '../../store'
import { useModalBehavior } from '../Modal'
import { KnowsBlock } from '../ContextColumn'
import type { AgentView } from '../../lib/types'

// Tailwind's `lg` (64rem). No matchMedia (jsdom, very old browsers) = the
// desktop semantics the app always had.
export function isLgViewport(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return window.matchMedia('(min-width: 64rem)').matches
}

export function KnowsSheet({ agent, onClose }: { agent: AgentView; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useModalBehavior(ref, onClose)
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-label="Knows"
      tabIndex={-1}
      className="fixed inset-x-0 bottom-0 z-20 flex max-h-[80vh] w-full flex-col border-t border-line bg-canvas shadow-xl outline-none lg:hidden"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="flex min-w-0 flex-1 items-baseline gap-1 truncate text-sm">
          <span className="font-medium text-ink">Context</span>
          <span className="text-ink-2">·</span>
          {/* the phone's door to the agent's page — below lg the subtitle is
              cramped, so the sheet carries it too */}
          <button
            type="button"
            onClick={() => {
              onClose()
              useStore.getState().selectAgent(agent.id)
            }}
            title={`Open ${agent.name}'s page`}
            className="truncate text-ink-2 hover:text-terracotta"
          >
            {agent.name} ›
          </button>
        </span>
        <button type="button" aria-label="Close knows" onClick={onClose} className="shrink-0 rounded-md p-1 text-ink-2 hover:bg-panel hover:text-ink">
          <X size={15} aria-hidden="true" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <KnowsBlock agent={agent} />
      </div>
    </div>
  )
}
