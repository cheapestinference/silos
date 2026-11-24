// KnowsDrawer.tsx — "the 10-second gesture never leaves the conversation".
// A panel anchored to the context
// column's edge (absolute, right-0 of ConversationView's transcript
// container): it covers only the transcript's EDGE — the conversation stays
// visible and alive to its left, the column to its right. NEVER inset-0.
// Below `lg` (no column, no room beside the transcript) the same element is
// a bottom sheet — NodePanel's pattern, one element repositioned by CSS.
//
// Two panels: the Mission (the agent page's mission head, compact) and the
// library (KnowsLibrary, narrow: kinds as tabs, the open item replacing the
// list with a way back). Every open lands in the library — a column row,
// and the live toast's item too, which the library opens by its name and
// layer once the rows are read. Its switches live on their owner's page;
// the drawer points there.
//
// Esc / ✕ / a click outside close it (store.closeKnows); useModalBehavior
// returns focus to whatever opened it. An unsaved draft (a note being
// written, a file being edited) is never dropped silently: leaving asks
// first, inline.
import { useCallback, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useStore } from '../../store'
import { useModalBehavior, useDismissOnOutside } from '../Modal'
import { MissionHeader } from '../agent/MissionHeader'
import type { AgentView } from '../../lib/types'
import { KnowsLibrary } from './KnowsLibrary'
import { FileViewer } from '../FileViewer'
import { useKnowsSources } from './KnowsAnatomy'

// one geometry for every panel the drawer shows:
// bottom sheet below lg, the anchored ~480px panel from lg up — capped so
// some transcript always remains (the spec's first anti-goal).
const PANEL_CLASS =
  'fixed inset-x-0 bottom-0 z-20 flex max-h-[80vh] w-full flex-col border-t border-line bg-canvas shadow-xl outline-none lg:absolute lg:inset-x-auto lg:right-0 lg:top-0 lg:max-h-none lg:w-[min(480px,calc(100%-16rem))] lg:max-w-full lg:border-l lg:border-t-0'

export function KnowsDrawer({ agent }: { agent: AgentView }) {
  const drawer = useStore((s) => s.knowsDrawer)
  if (!drawer) return null
  // Mission: the compact mission panel — no list, no filters
  if (drawer.kind === 'mission') return <MissionPanel key="mission" agent={agent} />
  // the library — every other open, the toast's item included
  return <LibraryPanel agent={agent} />
}

// The Mission panel: the same mission head the agent page mounts, inside
// the drawer's geometry — reading or editing the mission never leaves the
// conversation (a save reaches its NEXT conversation, the editor says so).
function MissionPanel({ agent }: { agent: AgentView }) {
  const closeKnows = useStore((s) => s.closeKnows)
  const panelRef = useRef<HTMLDivElement>(null)
  useModalBehavior(panelRef, closeKnows)
  useDismissOnOutside(panelRef, closeKnows)
  const title = `Mission · ${agent.name}`
  return (
    <div ref={panelRef} role="dialog" aria-modal="false" aria-label={title} tabIndex={-1} className={PANEL_CLASS}>
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="min-w-0 flex-1 truncate text-sm">
          <span className="font-medium text-ink">Mission</span>
          <span className="text-ink-2"> · {agent.name}</span>
        </span>
        <kbd className="shrink-0 rounded border border-line px-1 font-mono text-[10px] text-ink-2">Esc</kbd>
        <button type="button" aria-label="Close mission" onClick={closeKnows} className="shrink-0 rounded-md p-1 text-ink-2 hover:bg-panel hover:text-ink">
          <X size={15} aria-hidden="true" />
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        <MissionHeader agent={agent} bare />
      </div>
    </div>
  )
}

// The library in the drawer's place: narrow (kinds as tabs, the open item
// replacing the list), a little wider than the old list — the library needs
// room for a title and its date — and still capped so transcript remains.
function LibraryPanel({ agent }: { agent: AgentView }) {
  const drawer = useStore((s) => s.knowsDrawer)!
  const closeKnows = useStore((s) => s.closeKnows)
  const knowsVersion = useStore((s) => s.knowsVersion)
  const panelRef = useRef<HTMLDivElement>(null)
  // the unsaved-draft guard (no silent loss): an editor in the
  // library reports through onDirty; leaving with a draft parks the leave
  // in `pendingLeave` and asks, inline
  const dirtyRef = useRef(false)
  const onDirty = useCallback((d: boolean) => {
    dirtyRef.current = d
  }, [])
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null)
  const pendingRef = useRef(false)
  pendingRef.current = pendingLeave !== null
  const guard = useCallback((leave: () => void) => {
    if (dirtyRef.current) setPendingLeave(() => leave)
    else leave()
  }, [])
  // Esc while asking = "keep editing", never a second-press discard
  const guardedClose = useCallback(() => {
    if (pendingRef.current) setPendingLeave(null)
    else guard(closeKnows)
  }, [guard, closeKnows])
  const discard = (): void => {
    const leave = pendingLeave
    dirtyRef.current = false
    setPendingLeave(null)
    leave?.()
  }
  useModalBehavior(panelRef, guardedClose)
  useDismissOnOutside(panelRef, () => {
    if (!pendingRef.current) guard(closeKnows)
  })
  const src = useKnowsSources(agent, knowsVersion.memory + knowsVersion.skills + knowsVersion.context)
  const hereId = useStore((s) => s.selected?.id)
  // opened from a conversation: Upload offers «This conversation» — its id
  // once it has one (an SDK chat gets it with its first message)
  const hereHarness = useStore((s) => s.detail?.meta.harness)
  const newChatOpen = useStore((s) => s.newChatOpen)
  const fromConversation = hereId
    ? { id: hereId, ...(hereHarness ? { harness: hereHarness } : {}) }
    : newChatOpen
      ? { id: null, ...(agent.framework ? { harness: agent.framework } : {}) }
      : undefined
  const [viewerPath, setViewerPath] = useState<string | null>(null)
  const kind = drawer.kind === 'mission' ? 'memory' : drawer.kind
  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-label={`What ${agent.name} knows`}
      tabIndex={-1}
      className={PANEL_CLASS.replace('lg:w-[min(480px,calc(100%-16rem))]', 'lg:w-[min(620px,calc(100%-12rem))]')}
    >
      {pendingLeave ? (
        <div role="alertdialog" aria-label="Unsaved changes" className="flex shrink-0 items-center gap-3 border-b border-line bg-panel px-4 py-2 text-sm">
          <span className="min-w-0 flex-1 text-ink">Discard unsaved changes?</span>
          <button type="button" autoFocus onClick={() => setPendingLeave(null)} className="shrink-0 text-ink-2 hover:text-ink">
            Keep editing
          </button>
          <button type="button" onClick={discard} className="shrink-0 rounded-md px-2 py-0.5 font-medium text-terracotta hover:bg-canvas">
            Discard
          </button>
        </div>
      ) : null}
      <KnowsLibrary
        agent={agent}
        src={src}
        wide={false}
        hereId={hereId}
        {...(fromConversation ? { fromConversation } : {})}
        onClose={() => guard(closeKnows)}
        onDirty={onDirty}
        guard={guard}
        focus={{
          kind,
          ...(drawer.filter ? { filter: drawer.filter } : {}),
          ...(drawer.openItem ? { item: drawer.openItem } : {}),
          ...(drawer.openScope ? { scope: drawer.openScope } : {}),
        }}
      />
      {viewerPath ? <FileViewer path={viewerPath} onClose={() => setViewerPath(null)} /> : null}
    </div>
  )
}
