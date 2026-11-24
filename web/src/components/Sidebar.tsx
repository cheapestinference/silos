// Sidebar.tsx — a single column (absorbs what used to be Threads.tsx):
// the wordmark, the master agent first (an entry point for new chats in
// any project), the list of active agents grouped by folder (with a pulse
// for live sessions), and a footer with "new agent" + the theme toggle.
// The SELECTED agent expands inline showing its recent sessions
// (open/rename/trash/filter — everything Threads.tsx used to do is still
// alive here, just nested under the agent's row instead of in a separate column).
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent, KeyboardEvent, ReactNode } from 'react'
import {
  AutomationIcon,
  BagIcon,
  CloseIcon,
  CollapseIcon,
  ExpandIcon,
  FilterIcon,
  MessageIcon,
  NewIcon,
  PinIcon,
  PlatformSettingsIcon,
  RowMenuIcon,
  SearchIcon,
  SiloSystemIcon,
  TasksIcon,
} from '../lib/icons'
import { useStore } from '../store'
import { NEW_ENTRIES } from '../lib/new-entries'
import { api } from '../lib/api'
import { getGoogleIdentity } from '../lib/auth'
import { basename } from '../lib/routes'
import { closeAndDeleteLabel, trashRefusalOf } from '../lib/trash-refusal'
import { relTime } from '../lib/rel-time'
import { onlyShellRunning, sessionSignal } from '../lib/live'
import { SessionDot } from './SessionDot'
import { AutomationsGlyph } from './AutomationsGlyph'
import { SYSTEM_SILO, inSystemHouse, systemLanding } from '../lib/system-house'
import { listedConversations } from '../lib/sidebar-show'
import { SidebarListSwitch, SidebarTasks } from './tasks/SidebarTasks'
import { useOpenTasksBySession } from '../hooks/useTasks'
import { automationsSignal, type AutomationsState } from '../lib/automations-signal'
import { MASTER_ID } from '../lib/constants'
import { instanceEmpty } from '../lib/first-run'
import { applyAgentOrder, groupChains, groupKey, orderWithSlots, sortGroups, splitArchived, splitRecent } from '../lib/grouping'
import type { AgentView, ConversationProcess, SessionView } from '../lib/types'
import { processLabel } from '../lib/processes'
import { pinSources, type PinItem } from '../lib/pin-sources'
import { railSilos, siloIconOf, siloName } from '../lib/silo-view'
import { Logo } from './Logo'
import { writeDarkPref } from '../lib/dark-mode'
import { useAgentPositions } from '../hooks/useAgentMoves'
import { MovesGlyphs } from './MovesGlyphs'
const CONFIRM_ARCHIVE_AGENT_MS = 3000

const CONFIRM_DELETE_MS = 3000

// the initial truth was already computed by main.tsx before mounting React
// (localStorage if there's a saved choice, otherwise the system
// preference). We read the class already applied to <html> instead of
// re-deriving it from localStorage alone, so as not to override the system
// preference of someone who hasn't explicitly chosen a theme.
function readInitialDark(): boolean {
  if (typeof document === 'undefined') return false
  return document.documentElement.classList.contains('dark')
}

// exported — the theme toggle moves to SettingsPage › Appearance (it
// leaves the Sidebar's footer), but the hook (with its readInitialDark
// read) keeps living here to avoid duplicating the logic.
export function useDarkMode(): [boolean, () => void] {
  const [dark, setDark] = useState(readInitialDark)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])

  function toggle(): void {
    setDark((current) => {
      const next = !current
      writeDarkPref(next)
      return next
    })
  }

  return [dark, toggle]
}

function matchesSession(session: SessionView, filter: string): boolean {
  const q = filter.trim().toLowerCase()
  if (!q) return true
  if (session.title.toLowerCase().includes(q)) return true
  return session.skills.some((sk) => sk.toLowerCase().includes(q))
}

// the shared primitive for a row's ⋯ menu — a trigger revealed on
// hover/focus (opacity-0 + group-hover/group-focus-within, the usual
// pattern) + a popup that closes on an outside click or Escape. Used by
// AgentMenu (the agent row) and SessionRow's actions (Rename/Delete for a
// topic, formerly loose ghost icons — hover-only is invisible, a ⋯ per row
// is discoverable). `children` is a function so each consumer can close
// the menu after its action; `onClose` lets confirmation states reset on
// close by any path (outside click, Escape, or an action).
// `wide`: the menu holds a choice, not just items (a delete that names the
// processes its conversation left running) — it widens to hold the words
function RowMenu({
  ariaLabel,
  title,
  onClose,
  wide = false,
  children,
}: {
  ariaLabel: string
  title: string
  onClose?: () => void
  wide?: boolean
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  function close(): void {
    setOpen(false)
    onClose?.()
  }

  useEffect(() => {
    if (!open) return
    function onDocClick(e: globalThis.MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    function onKeyDown(e: globalThis.KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.stopPropagation() // must not read as "cancel turn" (AgentPage.tsx's global Esc)
        close()
      }
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKeyDown)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return (
    // the whole menu (trigger + dropdown) is sealed off from the row's own
    // click: a topic row opens its conversation on ANY click of its surface
    // (see SessionRow), and the menu is the one place that must not.
    // Stopped here, once, rather than on every menu item.
    <div ref={ref} className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-label={ariaLabel}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        // open = visible even if the pointer leaves the row — an expanded
        // menu should never end up with its trigger invisible.
        className={`rounded-md p-1 text-ink-2 transition-opacity hover:bg-canvas hover:text-ink group-hover:opacity-100 group-focus-within:opacity-100 ${open ? 'opacity-100' : 'opacity-0'}`}
      >
        <RowMenuIcon size={12} />
      </button>
      {open ? (
        <div
          role="menu"
          className={`absolute right-0 top-full z-30 mt-1 overflow-hidden rounded-lg border border-line bg-panel py-1 shadow-lg ${wide ? 'w-60' : 'w-40'}`}
        >
          {children(close)}
        </div>
      ) : null}
    </div>
  )
}

// the pencil turns into a ⋯ menu (New conversation · View agent · Edit ·
// Archive). Master keeps
// the menu (useful for "New conversation"/"View agent") but without
// Edit/Archive — it isn't editable from the UI.
function AgentMenu({ agent, isMaster }: { agent: AgentView; isMaster: boolean }) {
  const [confirmArchive, setConfirmArchive] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  function newConversation(close: () => void): void {
    useStore.getState().selectAgent(agent.id)
    useStore.getState().startNewConversation()
    close()
  }

  function viewAgent(close: () => void): void {
    useStore.getState().selectAgent(agent.id)
    close()
  }

  function edit(close: () => void): void {
    useStore.getState().selectAgent(agent.id)
    useStore.getState().changeTab('identity')
    close()
  }

  function onClickArchive(close: () => void): void {
    if (confirmArchive) {
      if (timer.current) clearTimeout(timer.current)
      void api.agents.archive(agent.id).then(() => {
        // the same cleanup as SettingsTab.onClickArchive (AgentPage.tsx):
        // if the archived agent is the open one, the selection can't keep
        // pointing at an agent that's already inactive.
        if (agent.id === useStore.getState().selectedAgentId) {
          useStore.getState().closeSession()
          useStore.setState({ selectedAgentId: null, mobileView: 'list', page: null })
        }
        void useStore.getState().loadOverview()
      })
      close()
      return
    }
    setConfirmArchive(true)
    timer.current = setTimeout(() => setConfirmArchive(false), CONFIRM_ARCHIVE_AGENT_MS)
  }

  return (
    <RowMenu ariaLabel="agent options" title="Agent options" onClose={() => setConfirmArchive(false)}>
      {(close) => (
        <>
          <button
            role="menuitem"
            type="button"
            onClick={() => newConversation(close)}
            className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-canvas"
          >
            New conversation
          </button>
          <button
            role="menuitem"
            type="button"
            onClick={() => viewAgent(close)}
            className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-canvas"
          >
            View agent
          </button>
          {!isMaster ? (
            <>
              <button role="menuitem" type="button" onClick={() => edit(close)} className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-canvas">
                Edit
              </button>
              <button
                role="menuitem"
                type="button"
                onClick={() => onClickArchive(close)}
                className={`block w-full px-3 py-1.5 text-left text-xs hover:bg-canvas ${confirmArchive ? 'text-terracotta' : 'text-ink'}`}
              >
                {confirmArchive ? 'sure? archive' : 'Archive'}
              </button>
            </>
          ) : null}
        </>
      )}
    </RowMenu>
  )
}

// how the agent moves, at a glance:
// ⟳ On its own, the radar Proactive («Proactive — a round <period words>»),
// nothing when it waits for you — muted marks, their sentence on hover
function MovesMark({ agentId }: { agentId: string }) {
  const position = useAgentPositions().get(agentId)
  const period = useStore((s) => s.agents.find((a) => a.id === agentId)?.heartbeat?.period ?? null)
  return <MovesGlyphs position={position} period={period} />
}

function AgentRow({
  agent,
  expanded,
  current,
  showFolder,
  unread,
  collapsed,
  onSelect,
  onToggleCollapse,
  drag,
}: {
  agent: AgentView
  // the agent row no longer carries "you're here" state from being
  // selected — selection lives in the # topic (SessionRow.active).
  // `expanded` keeps its old meaning (this agent has its topic block in
  // full mode, aria-expanded); `current` is the ONLY highlight condition:
  // its DOSSIER is the open page (page={agent,id} with no conversation) — see Sidebar().
  expanded: boolean
  current: boolean
  showFolder?: boolean
  nowTick: number
  unread: boolean
  collapsed: boolean
  onSelect: () => void
  onToggleCollapse: () => void
  // drag-only reorder (only the owner orders agents, and only by
  // dragging): native HTML5, its own MIME type so a dragged agent never
  // gets mistaken for a dragged project header (which reads text/plain).
  drag?: {
    isDragged: boolean
    isDropTarget: boolean
    onDragStart: (e: DragEvent<HTMLDivElement>) => void
    onDragOver: (e: DragEvent<HTMLDivElement>) => void
    onDragLeave: () => void
    onDrop: (e: DragEvent<HTMLDivElement>) => void
    onDragEnd: () => void
  }
}) {
  // The per-agent live aggregate (a pulse + count) was removed: liveness now
  // reads only on the CONVERSATION rows, where a live pulse points at the
  // actual session — the agent-level roll-up was redundant noise.
  const visibleName = agent.id === MASTER_ID ? 'Anywhere' : agent.name

  // Slack-style: the agent is a discreet channel-like line — a small emoji,
  // a small muted name, no avatar-pill or extra height. Prominence goes to
  // the TOPICS (SessionRow), always visible below (see AgentItem, unless
  // collapsed). Highlight (only with an open dossier): a thin left border
  // + a soft background — the same language as an active topic. `group`
  // lives in the outer container so hovering any part of the row reveals
  // the ⋯ menu (the same pattern as SessionRow's actions).
  return (
    <div
      draggable={drag !== undefined}
      onDragStart={drag?.onDragStart}
      onDragOver={drag?.onDragOver}
      onDragLeave={drag?.onDragLeave}
      onDrop={drag?.onDrop}
      onDragEnd={drag?.onDragEnd}
      data-testid="agent-row"
      className={`group relative flex w-full items-center gap-0.5 border-l-2 pl-1 pr-1 transition-colors duration-[120ms] ${
        current ? 'border-terracotta' : 'border-transparent'
      } ${drag?.isDragged ? 'opacity-40' : ''} ${drag?.isDropTarget ? 'before:absolute before:inset-x-2 before:top-0 before:h-px before:bg-ink' : ''}`}
    >
      {/* a Slack-style collapse caret: revealed on hover (or focus), out of
          flow so it doesn't push content; stays visible when the agent is
          collapsed, so it can be expanded. State persisted in collapsedAgents. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onToggleCollapse()
        }}
        aria-expanded={!collapsed}
        aria-label={collapsed ? `expand ${visibleName}` : `collapse ${visibleName}`}
        title={collapsed ? `Show ${visibleName}'s conversations` : `Hide ${visibleName}'s conversations`}
        className={`absolute left-0 top-1/2 z-10 -translate-y-1/2 rounded p-0.5 text-ink-2 transition-opacity hover:text-ink focus-visible:opacity-100 ${
          collapsed ? '' : 'opacity-0 group-hover:opacity-100'
        }`}
      >
        {collapsed ? <ExpandIcon size={10} /> : <CollapseIcon size={10} />}
      </button>
      <button
        type="button"
        onClick={onSelect}
        aria-current={current ? 'true' : undefined}
        aria-expanded={expanded}
        title={agent.folder ?? undefined}
        className="flex min-w-0 flex-1 items-center gap-1.5 pl-2 pr-1 pt-1 pb-0.5 text-left hover:text-ink"
      >
        {/* the agent's emoji, no background: anchors the row's identity
            without turning it into a card. */}
        <span className="relative flex h-4 w-4 shrink-0 items-center justify-center text-[13px] leading-none">
          {agent.emoji}
          {unread ? <span data-testid="unread-dot" aria-label="unread" className="absolute -right-1 -top-0.5 h-1.5 w-1.5 rounded-full bg-ink" /> : null}
        </span>
        <span className="min-w-0 flex-1 md:max-lg:hidden">
          {/* the agent is the block's heading — always semibold, always
              ink; its conversations read as a thread below (see
              ExpandedSessions' rail). Selection is the left accent, not weight. */}
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate text-[13px] font-semibold tracking-tight text-ink">{visibleName}</span>
            {agent.id === MASTER_ID ? null : <MovesMark agentId={agent.id} />}
          </span>
          {showFolder && agent.folder ? <span className="block truncate text-[10px] text-ink-2">{basename(agent.folder)}</span> : null}
        </span>
      </button>
      {/* the agent's automations, as one ⚡ (only when it has some): muted,
          terracotta when one needs the owner, blinking while one runs —
          opens the Automations page filtered to this agent. Always visible,
          unlike the hover-only + and ⋯ beside it: it carries state. */}
      <AutomationsGlyph agent={agent} visibleName={visibleName} />
      {/* an inline conversation start in the agent's row: selects the
          agent and opens a new chat with one click; also in the ⋯ menu. */}
      <button
        type="button"
        aria-label={`new conversation with ${visibleName}`}
        title="New conversation"
        onClick={(e) => {
          e.stopPropagation()
          useStore.getState().selectAgent(agent.id)
          useStore.getState().startNewConversation()
        }}
        className="shrink-0 rounded p-0.5 text-ink-2 opacity-0 transition-opacity hover:bg-canvas hover:text-terracotta group-hover:opacity-100 group-focus-within:opacity-100"
      >
        <NewIcon size={12} />
      </button>
      <AgentMenu agent={agent} isMaster={agent.id === MASTER_ID} />
    </div>
  )
}

// The delete confirmation when the conversation left processes running
// (moment 3, «Also stop»): it names them («Still
// running: vite :5173, http.server :8000»), offers «Also stop them»
// UNCHECKED — explicit, never by default — and Delete. Ones Silos may not
// stop (Silos itself, another user's) are named but never offered.
function DeleteWithProcesses({
  live,
  alsoStop,
  onAlsoStop,
  onDelete,
  pending,
}: {
  live: readonly ConversationProcess[]
  alsoStop: boolean
  onAlsoStop: (v: boolean) => void
  onDelete: () => void
  // confirmed, the server not answered yet: the choice holds still and the
  // button says what is happening («Deleting and stopping…»)
  pending: string | null
}) {
  const stoppable = live.filter((p) => p.stoppable)
  const shown = live.slice(0, 4)
  return (
    <div className="border-t border-line px-3 pb-2 pt-2" data-testid="delete-processes" onClick={(e) => e.stopPropagation()}>
      <p className="text-[11.5px] leading-snug text-ink-2">
        Still running:{' '}
        {shown.map((p, i) => (
          <span key={p.id}>
            {i > 0 ? ', ' : ''}
            <span className="font-mono text-[11px] text-ink" title={p.command}>
              {processLabel(p)}
            </span>
          </span>
        ))}
        {live.length > shown.length ? ` and ${live.length - shown.length} more` : ''}
      </p>
      {stoppable.length > 0 ? (
        <label className="mt-1.5 flex cursor-pointer items-center gap-1.5 text-xs text-ink">
          <input
            type="checkbox"
            checked={alsoStop}
            disabled={pending !== null}
            onChange={(e) => onAlsoStop(e.target.checked)}
            className="size-3 accent-terracotta"
          />
          {stoppable.length === 1 ? 'Also stop it' : 'Also stop them'}
          {stoppable.length < live.length ? (
            <span className="text-[10.5px] text-ink-3">
              ({stoppable.length} of {live.length})
            </span>
          ) : null}
        </label>
      ) : (
        <p className="mt-1 text-[11px] text-ink-3">
          Silos can’t stop {live.length === 1 ? 'it' : 'them'} — {live.length === 1 ? 'it keeps' : 'they keep'} running.
        </p>
      )}
      <button
        role="menuitem"
        type="button"
        aria-label="sure? confirm delete"
        aria-busy={pending !== null || undefined}
        disabled={pending !== null}
        onClick={onDelete}
        className="mt-2 rounded-md border border-terracotta/50 px-2 py-0.5 text-xs text-terracotta hover:border-terracotta hover:bg-terracotta-soft disabled:cursor-default disabled:border-terracotta/30 disabled:bg-terracotta-soft disabled:hover:border-terracotta/30"
      >
        {pending !== null ? <span className="motion-safe:animate-pulse">{pending}</span> : alsoStop && stoppable.length > 0 ? 'Delete and stop' : 'Delete'}
      </button>
    </div>
  )
}

export function SessionRow({
  session,
  active,
  nowTick,
  onOpen,
  indent = false,
  hidePin = false,
  drag,
  onRelease,
  keptBy,
}: {
  session: SessionView
  active: boolean
  nowTick: number
  onOpen: () => void
  // one extra indent level, same actions (rename/trash intact).
  indent?: boolean
  // the name of the automation that keeps this conversation (thread.mode
  // 'keep'): it's one of the agent's conversations like any other, with a
  // small muted ⚡ after the title saying who else writes in it.
  keptBy?: string
  // drag a conversation onto another to fix it at that position; a
  // detached one dropped back onto its parent's row nests again (see
  // ExpandedSessions). Only the rows that can take part get this.
  drag?: {
    draggable: boolean
    isDragged: boolean
    isDropTarget: boolean
    onDragStart: (e: DragEvent<HTMLLIElement>) => void
    onDragOver: (e: DragEvent<HTMLLIElement>) => void
    onDragLeave: () => void
    onDrop: (e: DragEvent<HTMLLIElement>) => void
    onDragEnd: () => void
  }
  // in the "Pinned" section, the 📌 per row is redundant (the section
  // already says so); on other surfaces (search) it does get painted.
  hidePin?: boolean
  // only on a conversation the owner dragged to a fixed position: let it
  // flow by activity again (the one way to undo a drag).
  onRelease?: () => void
}) {
  // the OPEN conversation (store.selected, NOT the page-gated `active`)
  // never paints the "unanswered" dot — the owner is looking at it. The
  // raw `selected` is read so it doesn't diverge from the agent counter
  // and the summary, which use the same truth (sessionSignal in lib/live.ts).
  // Without this, an in-flight turn with an early tool-call
  // (lastRole→'assistant') would make every `session` over WS
  // reintroduce the dot on the row being viewed.
  const rawSelected = useStore((s) => s.selected)
  const isOpenRow = rawSelected?.folder === session.folder && rawSelected?.id === session.id
  const signal = sessionSignal(session, nowTick, isOpenRow)
  // a conversation's pin key: `folder/id`.
  const convKey = `${session.folder}/${session.id}`
  const pins = useStore((s) => s.projectsPrefs.pins)
  const pinned = (pins ?? []).some((p) => p.source === 'claude' && p.ref === convKey)
  const pinItem = useStore((s) => s.pinItem)
  // the open tasks it works — one shared index over the reading (no fetch per row)
  const working = useOpenTasksBySession().get(session.id) ?? []
  const workingTitle = working.length === 0 ? '' : `Working on «${working[0]!.title}»${working.length > 1 ? ` and ${working.length - 1} more` : ''}`
  const [renaming, setRenaming] = useState(false)
  const [value, setValue] = useState(session.title)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  // the title no longer carries a local optimistic layer: the store's
  // renameSession() is the single source of truth (optimistic + revert on
  // failure), so it's enough to read session.title directly.
  const title = session.title

  function startRenaming(): void {
    setValue(title)
    setRenaming(true)
  }

  function confirmRename(): void {
    const trimmed = value.trim()
    setRenaming(false)
    if (!trimmed || trimmed === title) return
    void useStore.getState().renameSession(session.folder, session.id, trimmed)
  }

  function cancelRenaming(): void {
    setRenaming(false)
  }

  function onRenameKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') confirmRename()
    else if (e.key === 'Escape') cancelRenaming()
  }

  // trashing legitimately takes seconds server-side (it waits for the
  // console's claude to really die before moving the file) — the row shows
  // that wait instead of sitting there looking like the delete failed.
  const [deleting, setDeleting] = useState(false)
  // the confirmed delete's words while the server works — the menu stays
  // open on them until it answers (a delete with a live console, or with
  // processes to stop, takes seconds; a menu that vanished said nothing)
  const [pendingWords, setPendingWords] = useState<string | null>(null)

  // A claude outside Silos (launched by hand, by claude-auto-retry…) may
  // still hold the conversation: the server refuses, naming where it lives,
  // and the strip offers to close it first — a second trash with
  // `closeHolders` (lib/trash-refusal.ts). Nothing is killed without the
  // owner's click.
  async function deleteSession(opts: { closeHolders?: boolean; stopProcesses?: boolean } = {}, answered: () => void = () => {}): Promise<void> {
    setDeleting(true)
    try {
      const r = await api.trash(session.folder, session.id, { thread: true, ...opts })
      answered()
      // on success the row leaves via the WS 'removed' event — the
      // deleting state rides along until the unmount. «Also stop them»
      // was asked: say what the server stopped — quiet when all of it
      // stopped, the alarm when something kept running
      if (r?.processes) {
        const message = `Deleted «${title}» — ${r.processes.says}.`
        useStore.setState({ error: message, errorAction: null, reportOnly: r.processes.notStopped.length > 0 ? null : message })
      }
    } catch (e) {
      answered()
      setDeleting(false)
      const refusal = trashRefusalOf(e)
      if (refusal?.canClose) {
        useStore.setState({
          error: refusal.message,
          errorAction: { forMessage: refusal.message, label: closeAndDeleteLabel(refusal), run: () => void deleteSession({ closeHolders: true }) },
        })
        return
      }
      useStore.setState({ error: e instanceof Error ? e.message : String(e) })
    }
  }

  // Delete now lives in the ⋯ menu — the same two-step confirmation as
  // always (a first click arms "sure? delete" in terracotta, a second
  // executes it), just inside the open menu, like AgentMenu's "sure?
  // archive". Trash is still moving to ~/.silos/trash — the whole thread
  // (`thread: true`): the row is a chain, and burying only its tip left
  // every rotation and every pre-/clear transcript to surface as a "new"
  // conversation.
  //
  // «Also stop»: arming asks what the conversation
  // left running (the System silo's records of its thread). None → the
  // confirmation is exactly the one above. Some → the armed item becomes a
  // small choice that names them, with «Also stop them» UNCHECKED and no
  // auto-disarm (a choice waits for the person); only a tick sends
  // stopProcesses — never by default, never automatic.
  const [live, setLive] = useState<ConversationProcess[]>([])
  const [alsoStop, setAlsoStop] = useState(false)
  function resetConfirm(): void {
    setConfirmDelete(false)
    setLive([])
    setAlsoStop(false)
  }
  function onClickDelete(close: () => void): void {
    if (deleting) return
    if (confirmDelete) {
      if (timer.current) clearTimeout(timer.current)
      const stop = alsoStop && live.some((p) => p.stoppable)
      setPendingWords(stop ? 'Deleting and stopping…' : 'Deleting…')
      // the menu holds on «Deleting…» until the server answers; then it
      // closes (on success the row leaves with the WS 'removed' event)
      void deleteSession(stop ? { stopProcesses: true } : {}, () => {
        setPendingWords(null)
        resetConfirm()
        close()
      })
      return
    }
    setConfirmDelete(true)
    timer.current = setTimeout(() => setConfirmDelete(false), CONFIRM_DELETE_MS)
    Promise.resolve(api.processes(session.folder, session.id))
      .then((ps) => {
        if (!Array.isArray(ps) || ps.length === 0) return
        if (timer.current) clearTimeout(timer.current)
        setLive(ps)
      })
      .catch(() => {
        /* unread: the confirmation stays today's */
      })
  }

  // hierarchy by indent/typography, not by nested boxes — sessions in a
  // smaller body and ink-2 (versus the agent row's font-display
  // text-sm), no background of their own except hover/active.
  return (
    <li
      draggable={drag?.draggable === true}
      onDragStart={drag?.onDragStart}
      onDragOver={drag?.onDragOver}
      onDragLeave={drag?.onDragLeave}
      onDrop={drag?.onDrop}
      onDragEnd={drag?.onDragEnd}
      data-testid="session-row"
      data-session-key={`${session.folder}/${session.id}`}
      className={`relative ${drag?.isDragged ? 'opacity-40' : ''} ${drag?.isDropTarget ? 'before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-ink' : ''}`}
    >
      <div
        // a conversation hangs off its agent's thread rail (the <ul>'s
        // border-l, ExpandedSessions): the row's own border-l-2 sits ON the
        // rail (-ml-px) so the open conversation lights the thread
        // terracotta at exactly its row — one accent, no second mark.
        //
        // the WHOLE row surface opens the conversation — its padding, the
        // time, the dot, the empty right edge — not just the title's
        // letters. The title <button> stays the accessible
        // target (aria-current, keyboard): its activation dispatches a
        // click that bubbles here, so there's exactly one handler. The
        // parts that must NOT open it stop the event themselves: the ⋯
        // menu (RowMenu), the chain affix, and the rename input (guarded).
        onClick={() => {
          if (!renaming) onOpen()
        }}
        className={`group -ml-px flex cursor-pointer items-center gap-1 border-l-2 py-[3px] ${indent ? 'pl-5' : 'pl-3'} pr-2 transition-colors duration-[120ms] ${
          active ? 'border-terracotta' : 'border-transparent hover:bg-canvas/40'
        }`}
      >
        {renaming ? (
          <input
            autoFocus
            type="text"
            aria-label="new session title"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onRenameKeyDown}
            onBlur={cancelRenaming}
            onClick={(e) => e.stopPropagation()}
            className="min-w-0 flex-1 rounded-md border border-terracotta bg-canvas px-1.5 py-0.5 text-xs outline-none"
          />
        ) : (
          // a density adjustment: the title+time on their own line,
          // badges on a second line only if needed — with everything on
          // one row, the title ate up the sidebar's 260px width (a live +
          // terminal session left it truncated to "Fla…"). Two lines is
          // the same typographic hierarchy Threads.tsx already used, just
          // at a smaller body size.
          <button
            type="button"
            aria-current={active ? 'true' : undefined}
            // a delete in flight dims the row's words — never the ⋯ menu,
            // which holds «Deleting…» open over the rows below until the answer
            className={`flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left transition-opacity ${deleting ? 'opacity-50' : ''}`}
          >
            <div className="flex w-full min-w-0 items-center justify-between gap-2">
              {/* the durable "awaiting your reply" signal (aggregated per
                  agent, in terracotta) was removed: it was unreliable — a
                  closed conversation isn't waiting for a reply. */}
              {/* the affix is `#` — the same glyph that heads the open
                  conversation's title (ConversationHeader, AgentPage.tsx),
                  so the sidebar and the page read as the same system. It's
                  row decoration, NOT part of the title: rename, optimistic
                  reconciliation and the rest of this function still
                  operate on `title` raw (see above). It sits in its own
                  <span> so text queries (tests, the browser's finder)
                  still find the exact title without the prefix. */}
              {/* the open topic IS the document you're reading: a bold
                  (semibold) title over the row's soft background, like
                  Slack's active channel. The # always stays in ink-2:
                  it's decoration, weight and background say the selection. */}
              {/* cross-session address: resting the mouse on
                  a topic shows ONLY its short name ("silos-ab") — the name
                  another Claude Code session uses to message it. A native
                  tooltip (appears after ~1 s), nothing painted in the row. */}
              <span
                className={`min-w-0 flex-1 truncate text-[12.5px] ${active ? 'font-medium text-ink' : 'text-ink-2 group-hover:text-ink'}`}
                title={session.peer?.name ?? title}
              >
                {/* no `#` prefix (minimalism — it repeated
                    what the indent already says). */}
                <span>{title}</span>
              </span>
              {keptBy ? (
                <span
                  data-testid="kept-mark"
                  title={`kept by automation ${keptBy}`}
                  aria-label={`kept by automation ${keptBy}`}
                  className="shrink-0 text-ink-3"
                >
                  <AutomationIcon size={10} strokeWidth={2} aria-hidden="true" />
                </span>
              ) : null}
              {/* Silos once opened it to work one message (origin
                  'message', history): a conversation like any other,
                  marked ✉ the way a kept thread is marked ⚡ */}
              {session.origin?.kind === 'message' ? (
                <span
                  data-testid="message-mark"
                  title={`opened for a message — “${session.origin.gist}”`}
                  aria-label="opened for a message"
                  className="shrink-0 text-ink-3"
                >
                  <MessageIcon size={10} strokeWidth={2} aria-hidden="true" />
                </span>
              ) : null}
              {/* it works an open task: the same ☑
                  as the conversation's header «Working on …», the task's
                  title in the tooltip — a marker on the right, like ⚡ and ✉ */}
              {working.length > 0 ? (
                <span data-testid="task-mark" title={workingTitle} aria-label={workingTitle} className="shrink-0 text-ink-3">
                  <TasksIcon size={10} strokeWidth={2} aria-hidden="true" />
                </span>
              ) : null}
              {/* the pin is a row marker on the RIGHT, with the dot and the
                  time — never before the title: anything ahead of the text
                  shifts its left edge off the thread rail and the row reads
                  as a child of the one below. */}
              {pinned && !hidePin ? <PinIcon size={10} strokeWidth={1.75} aria-label="pinned" className="shrink-0 text-ink-2/70" /> : null}
              <SessionDot signal={signal} slow={onlyShellRunning(session, nowTick)} />
              {deleting ? (
                <span className="shrink-0 text-[10px] italic text-ink-2">deleting…</span>
              ) : (
                <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-3">{relTime(session.mtime, nowTick)}</span>
              )}
            </div>
            {/* a topic's meta as muted text on a single line, no bordered
                pills. The "live" pulse and the "terminal" chip are gone
                (noise — "live" meant nothing to the reader);
                only the worktree mark stays. */}
            {session.worktree ? (
              <div className="flex items-center gap-2 text-[10px] text-ink-2">
                <span>worktree</span>
              </div>
            ) : null}
          </button>
        )}

        {/* row actions (rename/delete) are consolidated into ONE ⋯ menu
            per topic — the same pattern the agent row already has
            (RowMenu), instead of two ghost icons that only existed on
            hover. The items' aria-labels keep their usual names ("rename
            session"/"delete session") — the accessible contract doesn't
            change, only where they live. */}
        <RowMenu ariaLabel="topic options" title="Conversation options" onClose={resetConfirm} wide={confirmDelete && live.length > 0}>
          {(close) => (
            <>
              <button
                role="menuitem"
                type="button"
                aria-label={pinned ? 'unpin session' : 'pin session'}
                onClick={(e) => {
                  e.stopPropagation()
                  close()
                  pinItem('claude', convKey)
                }}
                className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-canvas"
              >
                {pinned ? 'Unpin' : 'Pin'}
              </button>
              {onRelease ? (
                <button
                  role="menuitem"
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    close()
                    onRelease()
                  }}
                  className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-canvas"
                >
                  Unfix position
                </button>
              ) : null}
              <button
                role="menuitem"
                type="button"
                aria-label="rename session"
                onClick={(e) => {
                  e.stopPropagation()
                  close()
                  startRenaming()
                }}
                className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-canvas"
              >
                Rename
              </button>
              {confirmDelete && live.length > 0 ? (
                <DeleteWithProcesses live={live} alsoStop={alsoStop} onAlsoStop={setAlsoStop} onDelete={() => onClickDelete(close)} pending={pendingWords} />
              ) : (
                <button
                  role="menuitem"
                  type="button"
                  aria-label={confirmDelete ? 'sure? confirm delete' : 'delete session'}
                  aria-busy={pendingWords !== null || undefined}
                  disabled={pendingWords !== null}
                  onClick={(e) => {
                    e.stopPropagation()
                    onClickDelete(close)
                  }}
                  className={`block w-full px-3 py-1.5 text-left text-xs hover:bg-canvas disabled:cursor-default disabled:hover:bg-transparent ${confirmDelete ? 'text-terracotta' : 'text-ink'}`}
                >
                  {pendingWords !== null ? <span className="motion-safe:animate-pulse">{pendingWords}</span> : confirmDelete ? 'sure? delete' : 'Delete'}
                </button>
              )}
            </>
          )}
        </RowMenu>
      </div>
    </li>
  )
}

// the conversation being assembled — newChatOpen, nothing persisted yet, so
// no SessionView to hang a SessionRow on. Still a row: the sidebar IS the
// conversation list, and the one you're about to write into belongs in it
// from the moment it's on screen — named by the draft title
// as you type it in the header (ConversationHeader → setNewChatTitle),
// selected because it's the open page. No time, dot or ⋯ menu: nothing has
// happened yet. Both engines pass through newChatOpen (the SDK chat and the
// real console's pendingConsoleId), so both get this row. When the first
// message persists, newChatOpen goes inert and the real row enters on top
// with the same title (applyConversationOrder: a newborn enters on top) —
// no jump.
function DraftRow({ onOpen }: { onOpen: () => void }) {
  const draftTitle = useStore((s) => s.newChatTitle)
  const named = draftTitle !== null && draftTitle.trim() !== ''
  const title = named ? draftTitle : 'New conversation'
  return (
    <li data-testid="draft-row">
      <div onClick={onOpen} className="group -ml-px flex cursor-pointer items-center gap-1 border-l-2 border-terracotta py-[3px] pl-3 pr-2">
        <button type="button" aria-current="true" className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left">
          <div className="flex w-full min-w-0 items-center justify-between gap-2">
            {/* unnamed = the placeholder reads muted; a typed title reads
                like any open topic (font-medium, ink). */}
            <span className={`min-w-0 flex-1 truncate text-[12.5px] font-medium ${named ? 'text-ink' : 'text-ink-2'}`} title={title}>
              <span>{title}</span>
            </span>
          </div>
        </button>
      </div>
    </li>
  )
}

// the CURRENTLY selected agent's session block — only mounts while that
// agent is selected (see the caller's `selected ? <...> : null`), so its
// local state (showAll) starts fresh every time it's re-selected: no
// effect is needed to "re-collapse" on an agent change, the unmount
// itself already does it.

function ExpandedSessions({
  agent,
  nowTick,
  compact = false,
  openInRailAtStart = true,
}: {
  agent: AgentView
  nowTick: number
  compact?: boolean
  openInRailAtStart?: boolean
}) {
  const filter = useStore((s) => s.filter)
  // the topic's selection only counts while the open page IS an agent
  // page (a conversation) — with Settings/Board/Project in front,
  // `selected` can stay set in the store but the topic is no longer
  // "where you are": nothing in the sidebar should read as selected then.
  const onAgentPage = useStore((s) => s.page?.kind === 'agent')
  const rawSelected = useStore((s) => s.selected)
  const selected = onAgentPage ? rawSelected : null
  // while a new chat is being assembled (no persisted session yet), its
  // draft row (DraftRow) is the open page — it carries the selection.
  const newChatOpen = useStore((s) => s.newChatOpen) && onAgentPage
  const draftOpen = newChatOpen && !compact
  const openSession = useStore((s) => s.openSession)
  // ONLY governs visibility in the md range — see the comment block on
  // the `className` below. Starts open: on mount (an agent just
  // selected, or reopened via AgentItem's `key`), the overlay must show.
  // on the narrow icon column the panel floats OVER the page: it opens when
  // the owner clicks the agent, never on its own at load
  const [openInRail, setOpenInRail] = useState(openInRailAtStart)

  // chains: a sidebar topic is no longer necessarily ONE session — it can
  // be a chain (fork/rotation) collapsed into its head + ancestors.
  // "Show all (N)" counts CHAINS, not loose sessions.
  // the order: newest activity first; a conversation the
  // owner DRAGGED stays fixed at the position it was dropped at
  // (prefs.conversationSlots) and the rest flow around it. See orderWithSlots.
  const detachedChains = useStore((s) => s.detachedChains)
  const setChainDetached = useStore((s) => s.setChainDetached)
  const detachedSet = useMemo(() => new Set(detachedChains), [detachedChains])
  const slots = useStore((s) => s.conversationSlots[agent.id])
  // the thread list is the conversations the OWNER opened: a session an
  // automation run opened (origin) never appears here (runs live on the
  // Automations page). A KEPT thread (thread.mode 'keep', ⚡ mark) and a
  // conversation Silos once opened for a message (origin 'message', ✉
  // mark, history) are rows only while open or matched by a search — their
  // home is their cause (lib/sidebar-show.ts, the one rule).
  const automations = useStore((s) => s.automations)
  const keptBy = useMemo(() => {
    const m = new Map<string, string>()
    for (const a of automations) {
      if (a.agentId !== agent.id || a.thread.mode !== 'keep' || !a.thread.sessionId) continue
      m.set(a.thread.sessionId, a.name)
    }
    return m
  }, [automations, agent.id])
  // which of them become rows: the owner's own always; kept (⚡) and
  // message (✉) conversations only while open or matched by a search —
  // their home is their cause (lib/sidebar-show.ts).
  const searching = filter.trim() !== ''
  const human = useMemo(
    () =>
      listedConversations(agent.sessions, keptBy, {
        searching,
        isOpen: (s) => rawSelected !== null && s.folder === rawSelected.folder && s.id === rawSelected.id,
      }),
    [agent.sessions, keptBy, searching, rawSelected],
  )
  // a conversation a /clear left behind is archived (splitArchived,
  // lib/grouping): no row in the list, no fold — only search finds it
  // (the text filter below, the command palette).
  const {
    ordered: allChains,
    fixed,
    archived,
  } = useMemo(() => {
    const split = splitArchived(groupChains(human, detachedSet), human)
    return { ...orderWithSlots(split.live, slots ?? [], human), archived: split.archived }
  }, [human, detachedSet, slots])
  const fixConversationAt = useStore((s) => s.fixConversationAt)
  const releaseConversation = useStore((s) => s.releaseConversation)
  // row drag, one MIME type, two gestures: a conversation dropped onto
  // another → fixed at the target's position; a detached one (pulled out
  // of its thread back when earlier sessions were listed) dropped onto the
  // row its parent belongs to → attached again (it wins for that target).
  const CHAIN_MIME = 'application/x-silos-chain'
  const [draggingChain, setDraggingChain] = useState<string | null>(null)
  const [chainDropTarget, setChainDropTarget] = useState<string | null>(null)
  const headOfParent = (s: SessionView): string | null => {
    if (!s.parentKey) return null
    const owner = allChains.find((c) => `${c.head.folder}/${c.head.id}` === s.parentKey || c.earlier.some((e) => `${e.folder}/${e.id}` === s.parentKey))
    return owner ? `${owner.head.folder}/${owner.head.id}` : null
  }
  function chainDragFor(s: SessionView): NonNullable<Parameters<typeof SessionRow>[0]['drag']> {
    const key = `${s.folder}/${s.id}`
    return {
      draggable: true,
      isDragged: draggingChain === key,
      isDropTarget: chainDropTarget === key && draggingChain !== null && draggingChain !== key,
      onDragStart: (e) => {
        e.dataTransfer.setData(CHAIN_MIME, key)
        e.dataTransfer.effectAllowed = 'move'
        setDraggingChain(key)
      },
      onDragOver: (e) => {
        if (draggingChain === null && !(e.dataTransfer.types ?? []).includes(CHAIN_MIME)) return
        e.preventDefault()
        e.stopPropagation()
        setChainDropTarget(key)
      },
      onDragLeave: () => setChainDropTarget((d) => (d === key ? null : d)),
      onDrop: (e) => {
        const dragged = e.dataTransfer.getData(CHAIN_MIME) || draggingChain
        if (!dragged) return
        e.preventDefault()
        e.stopPropagation()
        setDraggingChain(null)
        setChainDropTarget(null)
        if (dragged === key) return
        const src = human.find((x) => `${x.folder}/${x.id}` === dragged)
        if (!src) return
        // a detached conversation dropped back onto its thread's row → nest again
        if (detachedSet.has(dragged) && headOfParent(src) === key) {
          setChainDetached(dragged, false)
          return
        }
        // a conversation dropped onto another → fixed at the target's position
        const from = allChains.find((c) => `${c.head.folder}/${c.head.id}` === dragged)
        const at = allChains.findIndex((c) => `${c.head.folder}/${c.head.id}` === key)
        if (from && at !== -1) fixConversationAt(agent.id, from, at)
      },
      onDragEnd: () => {
        setDraggingChain(null)
        setChainDropTarget(null)
      },
    }
  }
  const total = allChains.length
  // the header's global search (the same `filter`) also filters outside
  // "Show all" — with something typed, it searches ALL of the agent's
  // chains (not just the ones visible by default), same as "Show all"
  // already did. A chain shows up if ANY member (head or ancestor)
  // matches — not just the head.
  const filterActive = filter.trim() !== ''
  // 3 to 5 topics by recent activity (splitRecent, lib/grouping.ts) — never
  // fewer than reach the last fixed one — and the rest fold into "▸ N
  // older", expandable inline, selected agent or not (otherwise the
  // older ones were unreachable unless the agent was clicked first).
  // whether the fold is open lives in the store, per agent: this component
  // remounts when the agent becomes the selected one (compact → full block,
  // see AgentItem) and on every click on the agent's row (`reopens`) — a
  // useState here folded the older rows away right after opening one of
  // them.
  const oldOpen = useStore((s) => s.olderOpenAgents.includes(agent.id))
  const toggleOlderOpen = useStore((s) => s.toggleOlderOpen)
  const { recent, old } = useMemo(() => {
    const lastFixed = allChains.reduce((m, c, i) => (fixed.has(c) ? i : m), -1)
    const cut = Math.max(splitRecent(allChains, nowTick).recent.length, lastFixed + 1)
    return { recent: allChains.slice(0, cut), old: allChains.slice(cut) }
  }, [allChains, fixed, nowTick])
  // a pinned conversation appears in the "Pinned" section above AND stays
  // in its agent's list (it shouldn't disappear from its project just
  // because it's pinned) — the pin is a cross-cutting shortcut, not a move.
  // the usual text filter — a chain shows up if ANY member matches (head or
  // ancestor); the archived ones too: the filter is a search.
  const textChains = useMemo(
    () => [...allChains, ...archived].filter((c) => matchesSession(c.head, filter) || c.earlier.some((s) => matchesSession(s, filter))),
    [allChains, archived, filter],
  )
  const chains = filterActive ? textChains : oldOpen ? allChains : recent
  const hiddenOld = !filterActive && !oldOpen ? old : []

  // opening a session from the md rail's overlay must close it — without
  // this, the opaque panel (position: fixed, bg-panel) would stay
  // floating over the transcript FOREVER, because selectedAgentId almost
  // never goes back to null in normal use. In <md/lg the flag is inert
  // (always visible while the agent is selected, see the className
  // below), so closing here hides nothing there.
  // a row follows its thread to wherever the conversation is now
  // (store.openSession).
  function openThread(folder: string, id: string): void {
    setOpenInRail(false)
    void openSession(folder, id)
  }

  // a base class (always) + the md:hidden/lg:block pair ONLY when closed
  // — the md:fixed/lg:static classes from the expanded version are never
  // touched (existing tests checking their presence stay intact).
  // md:hidden hides the fixed overlay; lg:block restores it at lg (the
  // same "reset per breakpoint" pattern already used by
  // position:fixed→static below) — without it, md:hidden would keep
  // applying at lg too (its min-width also satisfies md's condition). In
  // <md (mobile, always inline) there's no unprefixed `hidden` class, so
  // the flag doesn't affect it.
  const mdCloseClass = openInRail ? '' : ' md:max-lg:hidden'

  return (
    // the icon rail (w-16, Sidebar) has no room for a session list with
    // text — instead of permanently widening the rail (it would lose its
    // purpose of saving width for the chat), the block floats as an
    // overlay only in the md range. In <md (one column at a time) and at
    // lg (the sidebar is already wide) it flows inline, in the document,
    // like any nested list.
    //
    // position:fixed, NOT absolute+left-full: the first version tried
    // absolute anchored to the row (AgentItem's `relative` container), but
    // <nav> has overflow-y-auto — and per the CSS rule that pairs overflow
    // axes (if one axis isn't 'visible', the other computes as 'auto'
    // even if overflow-x-visible is declared by hand), ANY absolute
    // descendant that spills horizontally out of <nav> gets clipped,
    // invisible, even though its computed geometry says otherwise
    // (verified with a real screenshot in the md range — the block wasn't
    // visible). fixed escapes clipping from any overflow ancestor (there's
    // no transform/filter in the tree that would capture it), so there's
    // no need for a `relative` wrapper or to worry about <nav>'s scroll:
    // it anchors to the viewport, right next to the rail (left-16 = its
    // width) and below the header (top-16). It's no longer stuck to ITS
    // row (two different agents open the same floating slot), so it
    // carries its own name in the panel's header to not lose context.
    <div
      // the entire header ("Sessions"/the agent's name + actions)
      // disappears — hierarchy is now carried by the rows'
      // indent/typography. `relative` anchors the md rail's close button,
      // which lost its header and now floats in the overlay's own corner
      // (md:pt-8 gives it room above so it doesn't sit on top of the
      // first row, "New conversation").
      className={`relative mt-0.5 space-y-0.5 pb-1 md:max-lg:fixed md:max-lg:left-16 md:max-lg:top-16 md:max-lg:z-20 md:max-lg:w-72 md:max-lg:max-h-[70vh] md:max-lg:overflow-y-auto md:max-lg:rounded-lg md:max-lg:border md:max-lg:border-line md:max-lg:bg-panel md:max-lg:p-2 md:max-lg:pt-8${mdCloseClass}`}
      data-testid="expanded-sessions"
    >
      {/* an explicit close affordance for the md rail's overlay — ONLY
          visible there (hidden md:inline-flex lg:hidden, as before).
          Having lost the header that hosted it, it now floats in the
          panel's own corner. In <md/lg the panel is inline and always
          visible while the agent is selected: a close button there would
          have nothing to hide, so it isn't shown. A native button — Enter/
          Space activate it with nothing extra. */}
      <button
        type="button"
        aria-label="Close sessions panel"
        title="Close"
        onClick={() => setOpenInRail(false)}
        className="absolute right-1 top-1 hidden rounded-md p-1 text-ink-2 hover:bg-canvas hover:text-ink md:inline-flex lg:hidden"
      >
        <CloseIcon size={12} />
      </button>

      {/* the thread rail: a hairline dropping from the agent's emoji, every
          conversation hanging from it. This is what tells an agent (a
          heading: semibold, ink) from its conversations (a thread: smaller,
          muted) at a glance — hierarchy by structure, not by chips. */}
      <ul role="list" className="ml-[21px] space-y-0.5 border-l border-line">
        {/* no "+ New conversation" row: starting a chat is an inline
            button in the agent's row (AgentItem) and an action in the ⋯ menu. */}
        {/* the conversation being assembled, on top — only in the selected
            agent's (non-compact) block, which is the one that mounts for
            the agent whose page is open. On <md the list is the whole view,
            so its click goes back to the chat (mobileView), and in the md
            rail it closes the overlay like any other row. */}
        {draftOpen ? (
          <DraftRow
            onOpen={() => {
              setOpenInRail(false)
              useStore.setState({ mobileView: 'chat' })
            }}
          />
        ) : null}
        {total === 0 ? (
          compact || draftOpen ? null : (
            <li className="py-1 pl-3 text-xs text-ink-2">No conversations yet</li>
          )
        ) : (
          // one row per conversation: the sessions a thread
          // continued through (a --resume, a "Continue in Silos") are not
          // rows of their own — the conversation's header says where it
          // continues from. A console /clear is a NEW conversation and gets
          // its own row (groupChains never joins it); the one it left
          // behind is archived — no row, search only (splitArchived). The
          // row is active while any session of its thread is open.
          chains.map((c) => (
            <SessionRow
              key={`${c.head.folder}/${c.head.id}`}
              session={c.head}
              active={selected !== null && [c.head, ...c.earlier].some((s) => s.folder === selected.folder && s.id === selected.id)}
              nowTick={nowTick}
              onOpen={() => openThread(c.head.folder, c.head.id)}
              drag={chainDragFor(c.head)}
              onRelease={fixed.has(c) ? () => releaseConversation(agent.id, c) : undefined}
              keptBy={keptBy.get(c.head.id)}
            />
          ))
        )}
        {/* "▸ N older" — collapses the rest of the selected agent's
            topics (the ones splitRecent leaves out of the 3-5 recent
            ones); expands INLINE, without going through filter/"Show all". */}
        {hiddenOld.length > 0 ? (
          <li>
            <button
              type="button"
              onClick={() => toggleOlderOpen(agent.id)}
              className="flex w-full items-center gap-1 py-1 pl-3 pr-2 text-left text-[11px] text-ink-2 hover:text-ink"
            >
              <ExpandIcon size={10} aria-hidden="true" />
              {hiddenOld.length} older
            </button>
          </li>
        ) : null}
        {oldOpen && !filterActive ? (
          <li>
            <button
              type="button"
              onClick={() => toggleOlderOpen(agent.id)}
              className="flex w-full items-center gap-1 py-1 pl-3 pr-2 text-left text-[11px] text-ink-2 hover:text-ink"
            >
              <CollapseIcon size={10} aria-hidden="true" />
              Hide older
            </button>
          </li>
        ) : null}
      </ul>
    </div>
  )
}

function AgentItem({
  agent,
  selected,
  current,
  showFolder,
  nowTick,
  unread,
  onSelect,
  drag,
}: {
  agent: AgentView
  drag?: Parameters<typeof AgentRow>[0]['drag']
  // `selected` still governs EXPANSION (a full topic block vs compact),
  // as always; `current` (an open dossier) is the only thing that
  // highlights the row — see AgentRow.
  selected: boolean
  current: boolean
  showFolder?: boolean
  nowTick: number
  unread: boolean
  onSelect: () => void
}) {
  // a simple wrapper to group the row with its expanded block under a
  // single key in the caller's map — the md rail's overlay uses
  // position:fixed (see ExpandedSessions), so this div doesn't need to be
  // `relative` or any other anchoring trick.
  //
  // a documented decision: any click on the agent's row (the rail icon
  // included) reopens the md rail's overlay, whether it was already
  // selected or not. `reopens` increments on EVERY click and is passed as
  // `key` to ExpandedSessions: if the agent wasn't selected, the click
  // already mounts it fresh (openInRail starts true); if it WAS ALREADY
  // selected (a plain `selected` change from true to true doesn't remount
  // anything by itself), forcing a new `key` remounts the component
  // anyway, so its state (openInRail, and along with it showAll) starts
  // fresh again — without this, re-clicking an already-selected agent's
  // row after closing the panel with the X had no effect.
  // collapsed = only the agent's row, no topic list — neither compact nor
  // expanded, whatever the selection/breakpoint state.
  const collapsedAgents = useStore((s) => s.collapsedAgents)
  const toggleAgentCollapse = useStore((s) => s.toggleAgentCollapse)
  const collapsed = collapsedAgents.includes(agent.id)

  const [reopens, setReopens] = useState(0)
  function handleSelect(): void {
    onSelect()
    setReopens((n) => n + 1)
  }
  return (
    <div className="[&+&]:mt-2">
      <AgentRow
        agent={agent}
        expanded={selected}
        current={current}
        showFolder={showFolder}
        nowTick={nowTick}
        unread={unread}
        collapsed={collapsed}
        onSelect={handleSelect}
        onToggleCollapse={() => toggleAgentCollapse(agent.id)}
        drag={drag}
      />
      {collapsed ? null : selected ? (
        <ExpandedSessions key={reopens} agent={agent} nowTick={nowTick} openInRailAtStart={reopens > 0} />
      ) : (
        // Slack-style: topics visible without clicking — a compact
        // version, only at lg (there's no room in the md rail; in <md the
        // list is already the whole view).
        <div className="hidden max-md:block lg:block">
          <ExpandedSessions key={`c${reopens}`} agent={agent} nowTick={nowTick} compact />
        </div>
      )}
    </div>
  )
}

// a group of active agents sharing a folder (project). folder === null
// groups agents with no assigned folder (they carry no header or row
// basename: there's no path to show).
//
// no longer sorts by session volume (the bug that motivated the redesign:
// "dead projects with history outweigh the live ones") — it only groups,
// in the registry's (stable) order. The only reordering is the manual one
// decided by sortGroups (lib/grouping.ts): pinned-by-drag first, tray by hand.
interface FolderGroup {
  folder: string | null
  agents: AgentView[]
}

function groupByFolder(agents: AgentView[]): FolderGroup[] {
  const groups = new Map<string, FolderGroup>()
  for (const a of agents) {
    const key = a.folder ?? ''
    let g = groups.get(key)
    if (!g) {
      g = { folder: a.folder, agents: [] }
      groups.set(key, g)
    }
    g.agents.push(a)
  }
  return [...groups.values()]
}

// a group header with drag-to-pin (native HTML5, no deps) and persisted
// collapse. The up/down hover arrows are gone (whoever wants to reorder,
// drags) — drag is the only way to order projects.
// Only exists for groups WITH a header (withHeaders && g.folder) — with
// no header there's nothing to grab to drag.
function GroupHeader({
  folder,
  active = false,
  collapsed,
  isDragged,
  isDropTarget,
  onToggleCollapse,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  onOpenProject,
}: {
  folder: string
  active?: boolean
  collapsed: boolean
  isDragged: boolean
  isDropTarget: boolean
  onToggleCollapse: () => void
  onDragStart: (e: DragEvent<HTMLDivElement>) => void
  onDragOver: (e: DragEvent<HTMLDivElement>) => void
  onDragLeave: () => void
  onDrop: (e: DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
  // 🧠 no longer opens the MemoryDrawer — it navigates to the project's
  // page on its Memory tab (see Sidebar() further below).
  onMemory: () => void
  // a clickable project name → ProjectPage.
  onOpenProject: () => void
  // hovering "+ agent" → opens the creation modal with the folder pre-filled.
}) {
  const name = basename(folder)
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      data-testid="group-header"
      // the group name IS a project — the tooltip says its type: never a
      // bare name
      title={`Project · ${name} — ${folder}`}
      // the large gap that separates projects from each other lives in
      // the group's wrapper ([&+&]:mt-5, see Sidebar()), not here; almost
      // nothing below — the header belongs to its block.
      className={`group/header relative flex items-center gap-1 px-2 pt-1 pb-1 cursor-grab active:cursor-grabbing md:max-lg:hidden ${
        isDragged ? 'opacity-40' : ''
      } ${isDropTarget ? 'before:absolute before:inset-x-2 before:top-0 before:h-px before:bg-ink' : ''}`}
    >
      {/* a collapse caret revealed on hover (Slack): out of flow so the
          project's name sticks to the left; visible when collapsed. */}
      <button
        type="button"
        onClick={onToggleCollapse}
        aria-expanded={!collapsed}
        aria-label={collapsed ? `expand ${name}` : `collapse ${name}`}
        title={collapsed ? `Show ${name}'s agents` : `Hide ${name}'s agents`}
        className={`absolute left-0 top-1/2 z-10 -translate-y-1/2 rounded p-0.5 text-ink-2 transition-opacity hover:text-ink focus-visible:opacity-100 ${
          collapsed ? '' : 'opacity-0 group-hover/header:opacity-100'
        }`}
      >
        {collapsed ? <ExpandIcon size={10} /> : <CollapseIcon size={10} />}
      </button>
      {/* a clickable name — navigates to ProjectPage (doesn't collapse/expand). */}
      <button
        type="button"
        onClick={onOpenProject}
        aria-current={active ? 'true' : undefined}
        aria-label={`open project ${name}`}
        className={`min-w-0 truncate pl-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] hover:text-ink ${active ? 'text-ink' : 'text-ink-2'}`}
      >
        {name}
      </button>
      {/* the header carries no "add agent", "memory" or order arrows: the
          project's name navigates to its page (which offers the actions)
          and ordering is drag only. */}
    </div>
  )
}

// the projects bag: ONE row at the bottom acting as a drawer. A MANUAL
// bag: only what's dragged there by hand (inPool) falls in; there's no
// automatic archiving by inactivity. What's inside isn't listed, just the
// count. Opens with a click and chips are brought back with another click
// (onRemove); dragging still works to put in (list→bag) and as an
// alternative to take out.
function ProjectsBag({
  groups,
  dragging,
  onDropInBag,
  onDragStartFromBag,
  onDragEnd,
  onRemove,
}: {
  groups: FolderGroup[]
  dragging: string | null
  onDropInBag: (e: DragEvent<HTMLDivElement>) => void
  onDragStartFromBag: (key: string) => (e: DragEvent<HTMLButtonElement>) => void
  onDragEnd: () => void
  onRemove: (key: string) => void
}) {
  const [hovering, setHovering] = useState(false)
  const [bagOpen, setBagOpen] = useState(false)
  if (groups.length === 0 && !dragging) return null

  // the bag "opens" (shows chips) only while the owner wants to take
  // something out: a click on it or a drag in progress out of it — never as a list
  const showChips = bagOpen && groups.length > 0

  return (
    <div
      className={`group/bag relative mt-6 border-t border-line pt-2 md:max-lg:hidden ${hovering ? 'bg-canvas' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setHovering(true)
      }}
      onDragLeave={() => setHovering(false)}
      onDrop={(e) => {
        setHovering(false)
        onDropInBag(e)
      }}
    >
      <button
        type="button"
        onClick={() => setBagOpen((v) => !v)}
        aria-expanded={showChips}
        aria-label={`projects bag, ${groups.length} inside`}
        title="The bag — projects put away (drag one here to put it away)"
        className={`flex w-full items-center gap-1.5 rounded-md px-3 py-1.5 text-left text-[11px] uppercase tracking-wider text-ink-2 hover:text-ink ${hovering ? 'outline outline-1 outline-dashed outline-ink-2' : ''}`}
      >
        <BagIcon size={11} />
        <span className="flex-1">Projects</span>
        <span className="font-mono text-[10px] tabular-nums">{groups.length}</span>
      </button>
      {showChips ? (
        <div className="flex flex-wrap gap-1 px-3 pb-2 pt-1">
          {groups.map((g) => {
            const key = groupKey(g.folder)
            const name = g.folder ? basename(g.folder) : 'No folder'
            return (
              <button
                key={key || '__no-folder__'}
                type="button"
                draggable
                title={`${g.folder ?? ''} — click to bring back`}
                onClick={() => onRemove(key)}
                onDragStart={onDragStartFromBag(key)}
                onDragEnd={onDragEnd}
                className={`cursor-pointer rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-2 hover:border-terracotta hover:text-terracotta ${dragging === key ? 'opacity-40' : ''}`}
              >
                {name}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

// "+ New" — the one visible door to everything that can be started (so how
// projects and agents are created is never unclear): a project
// (a folder, with its own agent proposed — NewProjectModal), an agent, a
// conversation (Anywhere, in a folder you pick), an automation. ⌘K lists the
// same four. Closes on an outside click or Esc.
// the empty list's door: where the conversations will be, the way to the
// first one — the same «+» menu, opened from here
function EmptyDoor() {
  return (
    <button
      type="button"
      onClick={() => useStore.getState().setNewMenuOpen(true)}
      className="group mt-1 flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left hover:bg-canvas md:max-lg:hidden"
    >
      <NewIcon size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-terracotta" />
      <span className="min-w-0">
        <span className="block text-[13px] text-ink">Start a conversation or a project</span>
        <span className="block text-[11.5px] leading-4 text-ink-2">Your conversations will be listed here.</span>
      </span>
    </button>
  )
}

function NewMenu() {
  // in the store: the empty list's door opens it too
  const open = useStore((s) => s.newMenuOpen)
  const setOpen = (v: boolean | ((o: boolean) => boolean)): void => {
    const s = useStore.getState()
    s.setNewMenuOpen(typeof v === 'function' ? v(s.newMenuOpen) : v)
  }
  // an empty install: a quiet mark on «+» until anything exists
  const empty = useStore((s) => instanceEmpty(s.agents))
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: globalThis.MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  const pick = (run: () => void) => () => {
    setOpen(false)
    run()
  }
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="new"
        title="New — project, agent, conversation or automation"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="relative rounded p-1 text-ink-2 hover:bg-panel hover:text-ink"
      >
        <NewIcon size={15} />
        {empty && !open ? (
          <span data-testid="new-mark" aria-hidden="true" className="absolute right-0 top-0 flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-terracotta opacity-60 motion-reduce:hidden" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-terracotta" />
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="New"
          className="absolute left-0 top-full z-40 mt-1 w-60 overflow-hidden rounded-lg border border-line bg-panel py-1 shadow-lg"
        >
          {NEW_ENTRIES.map((e) => (
            <button key={e.label} type="button" role="menuitem" onClick={pick(e.run)} className="block w-full px-3 py-1.5 text-left hover:bg-canvas">
              <span className="block text-sm text-ink">{e.label}</span>
              <span className="block text-[11.5px] leading-4 text-ink-2">{e.hint}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// the ⌘K palette's visible door — the search over everything. The same
// glyph and the same words as the shortcut it stands for, so hovering it
// teaches ⌘K (a hover and little more — no new visible label).
function SearchDoor() {
  return (
    <button
      type="button"
      aria-label="search everything"
      title="Search everything — ⌘K"
      aria-haspopup="dialog"
      onClick={() => {
        if (useStore.getState().modal === null) useStore.getState().setModal('palette')
      }}
      className="rounded p-1 text-ink-2 hover:bg-panel hover:text-ink"
    >
      <SearchIcon size={14} />
    </button>
  )
}

// the footer's "Archived" accordion is removed from here — now it's its
// own dedicated tab in SettingsPage.tsx (Agents), not collapsible.

// the Sidebar's footer — an initial avatar + email + plan (GET
// /api/account; "Not signed in" if null) + ⚙ → settings. Replaces
// "+ New agent"/"Create skill"/the theme toggle/Archived (those three now
// live behind the group header's hover, the rail, and SettingsPage respectively).
function AccountFooter({ onSettings }: { onSettings: () => void }) {
  const [account, setAccount] = useState<Awaited<ReturnType<typeof api.account>> | null | undefined>(undefined)
  // Google login (opt-in): the saved identity only exists after a login
  // verified by the server (see consumeSilosIdLanding in lib/auth.ts) — if it's
  // there, the footer shows WHO is inside Silos; the machine's claude
  // account stays visible in Settings › Account. A synchronous
  // localStorage read: doesn't change between renders without a reload.
  const google = getGoogleIdentity()

  useEffect(() => {
    let cancelled = false
    // Promise.resolve(...) — defensive: in tests that automock the whole
    // api module without explicitly stubbing account() (Sidebar mounts in
    // almost every App test), the mock returns undefined instead of a
    // promise; without this wrapper, chaining .then() on that would blow
    // up Sidebar's entire mount.
    Promise.resolve(api.account())
      .then((a) => {
        if (!cancelled) setAccount(a ?? null)
      })
      .catch(() => {
        if (!cancelled) setAccount(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const initial = google ? (google.name ?? google.email).slice(0, 1).toUpperCase() : account?.email ? account.email.slice(0, 1).toUpperCase() : null

  return (
    <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2 md:max-lg:hidden">
        {google?.photo ? (
          <img src={google.photo} alt="" referrerPolicy="no-referrer" className="h-6 w-6 shrink-0 rounded-full" />
        ) : initial ? (
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-terracotta-soft font-display text-[11px] text-terracotta">
            {initial}
          </span>
        ) : null}
        <span className="min-w-0 truncate text-xs text-ink-2" title={google ? 'Signed in with Google' : undefined}>
          {google ? (
            google.email
          ) : account === undefined ? (
            '…'
          ) : account === null ? (
            'Not signed in'
          ) : (
            <>
              {account.email ?? 'Signed in'}
              {account.plan ? <span className="text-ink-2/70"> · {account.plan}</span> : null}
            </>
          )}
        </span>
      </div>
      <button
        type="button"
        aria-label="Settings"
        title="Settings"
        onClick={onSettings}
        className="shrink-0 rounded-full p-1.5 text-ink-2 transition-colors duration-150 hover:bg-canvas hover:text-ink"
      >
        <PlatformSettingsIcon size={16} />
      </button>
    </div>
  )
}

// the GLOBAL navigation menu — a FIXED section at the top of the sidebar
// a pin's row (multi-source): resolved by its Source. Shows the silo's
// glyph (to tell which source it's from), the title, a pulse if it's
// live, and a remove button on hover. The same selection language as the
// tree: a terracotta accent on the left when it's the open item.
function PinnedRow({ glyph, item, onUnpin }: { glyph: string; item: PinItem; onUnpin: () => void }) {
  return (
    <li
      className={`group/pin flex items-center gap-1.5 border-l-2 py-[3px] pl-4 pr-2 transition-colors duration-[120ms] ${
        item.active ? 'border-terracotta' : 'border-transparent hover:bg-canvas/40'
      }`}
    >
      <button type="button" onClick={item.onOpen} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
        {/* a `#` source is a channel: flush against the title, same as the
            tree's rows (no gap). Other sources keep their mark with a gap. */}
        {glyph !== '#' ? (
          <span aria-hidden="true" className="shrink-0 text-xs leading-none text-ink-2">
            {glyph}
          </span>
        ) : null}
        <span className={`min-w-0 flex-1 truncate text-[13px] text-ink ${item.active ? 'font-semibold' : ''}`} title={item.title}>
          <span>{item.title}</span>
        </span>
        <SessionDot signal={item.signal} />
      </button>
      <button
        type="button"
        aria-label="unpin"
        title="Unpin"
        onClick={onUnpin}
        className="shrink-0 rounded p-0.5 text-ink-3 opacity-0 hover:text-terracotta group-hover/pin:opacity-100"
      >
        <PinIcon size={12} />
      </button>
    </li>
  )
}

// a persistent, cross-cutting section: pins from ANY source, always at
// hand even if the tree is collapsed or you're in another silo. Each pin
// is resolved by its Source (see pin-sources.ts); ones that no longer exist are dropped.
function PinnedSection() {
  const pins = useStore((s) => s.projectsPrefs.pins)
  const pinItem = useStore((s) => s.pinItem)
  // subscriptions that trigger a re-resolve of the Claude Code pins (its
  // Source reads agents/selected/nowTick from getState).
  const agents = useStore((s) => s.agents)
  const selected = useStore((s) => s.selected)
  const nowTick = useStore((s) => s.nowTick)
  const resolved = useMemo(() => {
    return (pins ?? [])
      .map((p) => ({ pin: p, glyph: pinSources[p.source]?.glyph ?? '•', item: pinSources[p.source]?.resolve(p.ref) ?? null }))
      .filter((x): x is { pin: typeof x.pin; glyph: string; item: PinItem } => x.item !== null)
    // agents/selected/nowTick go into deps to re-resolve even though they're not used directly
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins, agents, selected, nowTick])
  if (resolved.length === 0) return null
  return (
    <div className="mb-4" data-testid="pinned-section">
      <div className="px-3 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-2">Pinned</div>
      <ul role="list" className="space-y-0.5">
        {resolved.map(({ pin, glyph, item }) => (
          <PinnedRow key={`${pin.source}/${pin.ref}`} glyph={glyph} item={item} onUnpin={() => pinItem(pin.source, pin.ref)} />
        ))}
      </ul>
    </div>
  )
}

function MenuGlobal() {
  const page = useStore((s) => s.page)
  const automations = useStore((s) => s.automations)
  const automationsPending = useStore((s) => s.automationsPending)
  const changePage = useStore((s) => s.changePage)
  const silos = useStore((s) => s.silos)

  // Icon-only entries, side by side. Automations HAS its entry:
  // automations left the sidebar's tree (a ⚡ on each agent's row
  // points to the same page, filtered), so the page they all live on needs
  // a door of its own. That door carries the GLOBAL signal:
  // the tree says where things are, the rail says what needs you across
  // every agent, Home dispatches.
  // Map is NOT a door here: it is a
  // lens, opened from Home's date line and ⌘K (and from a project's
  // machinery line). The Board that shared that rule retired — its views
  // live on Home. Tasks has NO icon
  // here: two things called «Tasks» that did different things
  // was one too many — the list's «Conversations | Tasks» switch is its door.
  const autoSignal = automationsSignal(automations, automationsPending).state
  const items = [
    {
      // Tasks, ONLY on the narrow icon column (md): the «Conversations |
      // Tasks» switch has no room for its words there, so its door takes
      // this shape — an icon that opens the page. At full width it is not
      // drawn: the switch is the one Tasks.
      id: 'tasks' as const,
      Icon: TasksIcon,
      active: page?.kind === 'tasks' || page?.kind === 'task',
      badge: 0,
      signal: null as AutomationsState,
      ariaLabel: 'Tasks',
      narrowOnly: true,
      onClick: () => changePage({ kind: 'tasks' }),
    },
    {
      id: 'automations' as const,
      Icon: AutomationIcon,
      active: page?.kind === 'automations',
      badge: 0,
      signal: autoSignal as AutomationsState,
      ariaLabel: 'Automations',
      onClick: () => changePage({ kind: 'automations' }),
    },
    {
      // System — ONE door to the machine: what runs on it
      // (the System silo's lists), Files and Vault are its tabs
      // (lib/system-house.ts). Native and always here: the keyring must not
      // lose its door when the silo is turned off.
      id: 'system' as const,
      Icon: SiloSystemIcon,
      active: inSystemHouse(page),
      badge: 0,
      signal: null as AutomationsState,
      ariaLabel: 'System',
      onClick: () => changePage(systemLanding(silos)),
    },
    // an installed silo earns a door here ONLY when its manifest asked for
    // the `rail` slot and the grant stands (the operator can turn it off) —
    // the descriptor's granted slots are the signal, never mere existence.
    // With zero rail-granted silos this adds nothing.
    ...railSilos(silos)
      .filter((s) => s.id !== SYSTEM_SILO)
      .map((s) => ({
        id: `silo-${s.id}`,
        Icon: siloIconOf(s),
        active: page?.kind === 'silo' && page.id === s.id,
        badge: 0,
        signal: null as AutomationsState,
        ariaLabel: siloName(s),
        onClick: () => changePage({ kind: 'silo', id: s.id }),
      })),
  ]

  return (
    // the narrow column (md) is one icon wide: the doors stack, never a row
    // that spills out of it
    <div className="flex items-center gap-1 md:max-lg:flex-col">
      {items.map(({ id, Icon, active, badge, ariaLabel, onClick, signal, ...rest }) => (
        <button
          key={id}
          type="button"
          aria-label={ariaLabel}
          title={signal === 'needs-you' ? `${ariaLabel} · one needs you` : signal === 'working' ? `${ariaLabel} · one is running` : ariaLabel}
          aria-current={active ? 'true' : undefined}
          onClick={onClick}
          data-testid={`rail-${id}`}
          className={`relative ${'narrowOnly' in rest ? 'hidden md:max-lg:flex' : 'flex'} h-8 w-8 items-center justify-center rounded-md transition-colors ${
            active ? 'bg-terracotta-soft text-terracotta' : 'text-ink-2 hover:bg-canvas/60 hover:text-ink'
          }`}
        >
          <Icon size={15} />
          {/* the two-state dot (SessionDot's vocabulary) on a global door:
              solid when one needs the owner, blinking while one runs. */}
          {signal ? (
            <span
              data-testid={`rail-${id}-dot`}
              data-signal={signal}
              aria-hidden="true"
              className={`absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-terracotta ${signal === 'working' ? 'dot-blink' : ''}`}
            />
          ) : null}
          {badge > 0 ? (
            <span
              aria-hidden="true"
              className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-[0.875rem] items-center justify-center rounded-full bg-terracotta px-1 text-[9px] font-medium leading-none text-on-terracotta"
            >
              {badge > 9 ? '9+' : badge}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  )
}

export function Sidebar() {
  const agents = useStore((s) => s.agents)
  // nothing in the install yet: the list's door (the same rule as Welcome)
  const emptyInstall = instanceEmpty(agents)
  const sidebarList = useStore((s) => s.sidebarList)
  const warming = useStore((s) => s.warming)
  const selectedAgentId = useStore((s) => s.selectedAgentId)
  // "what's selected right now?" has ONE answer per state, derived from
  // the store with no new state — an open conversation → the # topic
  // (SessionRow.active); a new chat being assembled → the "+ New
  // conversation" row; an open dossier → the agent's row (current);
  // Settings/Board/Project → nothing in this list.
  const sessionOpen = useStore((s) => s.selected !== null)
  const newChatOpen = useStore((s) => s.newChatOpen)
  const isHome = useStore((s) => s.page === null)
  const agentPageId = useStore((s) => (s.page?.kind === 'agent' ? s.page.id : null))
  const conversationOpen = sessionOpen || newChatOpen
  const dossierOpenFor = (id: string): boolean => agentPageId === id && !conversationOpen
  const selectAgent = useStore((s) => s.selectAgent)
  const nowTick = useStore((s) => s.nowTick)
  const unreadAgentIds = useStore((s) => s.unreadAgentIds)
  const mobileView = useStore((s) => s.mobileView)
  const projectsPrefs = useStore((s) => s.projectsPrefs)
  const currentPage = useStore((s) => s.page)
  // the rail's signals (the Automations dot) live in MenuGlobal (above),
  // which reads automations/automationsPending on its own.
  const toggleProjectCollapse = useStore((s) => s.toggleProjectCollapse)
  const pinProject = useStore((s) => s.pinProject)
  const moveToStash = useStore((s) => s.moveToStash)
  const removeFromStash = useStore((s) => s.removeFromStash)
  const changePage = useStore((s) => s.changePage)
  const changeProjectTab = useStore((s) => s.changeProjectTab)
  const filter = useStore((s) => s.filter)
  const setFilter = useStore((s) => s.setFilter)
  // native drag (HTML5, no deps): the key of the group being dragged and
  // the key of the group it's passing over (for the drop line).
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const filterActive = filter.trim() !== ''

  // ONE search door: the header's magnifier opens the ⌘K
  // palette — the search over everything (pages, tasks, agents,
  // conversations, their text, silos). It used to reveal a SECOND search
  // that only filtered this list, with the palette behind it as small print,
  // so the search people meant was the one they couldn't see. Filtering
  // this list is now the palette's second gesture: type, then «Filter the
  // list to …» (its last row). A filter in force always shows itself below
  // the header with its way out — the tree never hides rows silently.

  // the owner's drag order (prefs.agentOrder) applied BEFORE grouping —
  // inside each project the rows follow it; unknown agents keep the
  // registry's order after the known ones. Nothing else reorders agents.
  const agentOrder = useStore((s) => s.agentOrder)
  const reorderAgents = useStore((s) => s.reorderAgents)
  const activeAgents = applyAgentOrder(
    agents.filter((a) => a.id !== MASTER_ID),
    agentOrder,
  )
  const master = agents.find((a) => a.id === MASTER_ID)
  const masterHasAutomations = useStore((s) => s.automations.some((a) => a.agentId === MASTER_ID))
  const rawGroups = groupByFolder(activeAgents)
  // agent drag (rows): its own state, separate from the project-header drag.
  const [draggingAgent, setDraggingAgent] = useState<string | null>(null)
  const [agentDropTarget, setAgentDropTarget] = useState<string | null>(null)
  const AGENT_MIME = 'application/x-silos-agent'
  const visibleAgentIds = activeAgents.map((a) => a.id)
  function agentDragFor(id: string): NonNullable<Parameters<typeof AgentItem>[0]['drag']> {
    return {
      isDragged: draggingAgent === id,
      isDropTarget: agentDropTarget === id && draggingAgent !== null && draggingAgent !== id,
      onDragStart: (e) => {
        e.dataTransfer.setData(AGENT_MIME, id)
        e.dataTransfer.effectAllowed = 'move'
        setDraggingAgent(id)
      },
      onDragOver: (e) => {
        if (draggingAgent === null && !(e.dataTransfer.types ?? []).includes(AGENT_MIME)) return
        e.preventDefault()
        e.stopPropagation()
        setAgentDropTarget(id)
      },
      onDragLeave: () => setAgentDropTarget((d) => (d === id ? null : d)),
      onDrop: (e) => {
        const dragged = e.dataTransfer.getData(AGENT_MIME) || draggingAgent
        if (!dragged) return // a project header being dragged over a row: not ours
        e.preventDefault()
        e.stopPropagation()
        setDraggingAgent(null)
        setAgentDropTarget(null)
        if (dragged !== id) reorderAgents(visibleAgentIds, dragged, id)
      },
      onDragEnd: () => {
        setDraggingAgent(null)
        setAgentDropTarget(null)
      },
    }
  }
  const withHeaders = rawGroups.length > 1

  // projects never reorder on their own: sortGroups only
  // applies the manual drag order (pinned first, in `order`) and the
  // manual tray (inPool) — no activity/live metadata is needed anymore.
  const { active: groups, inactive: inactiveGroups } = sortGroups(rawGroups, projectsPrefs)

  // the 'automations'/'chats'/'memory'/'skills'/'tools' branches
  // (AutomationsSidebar/ConversationsSidebar/MemoriesSidebar/
  // SkillsSidebar/ToolsSidebar) were deleted — nav.preset can only be
  // 'default' now that the rail is gone (the Board, the last preset,
  // retired). With the global navigation menu (MenuGlobal, above the
  // nav) the sidebar is ALWAYS present — Map/Automations included — for
  // the menu to truly be "always visible" and for there to be a way back.

  // only groups WITH a header (withHeaders && folder) are
  // draggable/reorderable — with no header there's nothing to grab (an
  // existing case: a single project, or agents with no folder).
  const headerKeys = groups.filter((g) => withHeaders && g.folder).map((g) => groupKey(g.folder))

  function onDropOnHeader(targetKey: string): (e: DragEvent<HTMLDivElement>) => void {
    return (e) => {
      e.preventDefault()
      const draggedKey = e.dataTransfer.getData('text/plain') || dragging
      setDragging(null)
      setDropTarget(null)
      if (!draggedKey || draggedKey === targetKey) return
      const withoutDragged = headerKeys.filter((c) => c !== draggedKey)
      const idx = withoutDragged.indexOf(targetKey)
      const newOrder = idx === -1 ? [...withoutDragged, draggedKey] : [...withoutDragged.slice(0, idx), draggedKey, ...withoutDragged.slice(idx)]
      pinProject(draggedKey, newOrder)
    }
  }

  // in <md only one column shows at a time (governed by mobileView, now
  // 'list' | 'chat' — the sidebar absorbed what used to be the threads
  // column); md: collapses into an icon rail (w-16, names hidden,
  // sessions in an overlay — see ExpandedSessions); lg: the sidebar at
  // full width (w-[260px]) with the chosen agent's sessions inline.
  // md:/lg: force flex regardless of state — the flag is inert from md up.
  // max-md:pb-14 is removed — it was the gap for the rail's fixed bottom
  // bar (Rail.tsx, retired), there's nothing left to clear.
  const columnClass = `${mobileView === 'list' ? 'flex' : 'hidden'} md:flex w-full shrink-0 flex-col border-r border-line bg-panel md:w-16 lg:w-[260px]`

  return (
    <aside className={columnClass}>
      {/* the same padding token as Chat's headers (px-4 py-3 + border-b)
          instead of an arbitrary h-14 — this way the two column headers
          truly share the same vertical rhythm (by padding token, not a
          fixed height fighting organic content). */}
      <header className="flex shrink-0 flex-col justify-center gap-0.5 px-4 py-2">
        <div className="flex items-center justify-between gap-2 md:max-lg:hidden">
          {/* the mark is the door Home (the usual place for it); on a
              phone Home is the page itself — the same changePage(null). */}
          <button
            type="button"
            aria-label="Home"
            title="Home"
            data-testid="rail-home"
            aria-current={isHome ? 'true' : undefined}
            onClick={() => changePage(null)}
            className="-mx-1 flex items-center gap-2 rounded-md px-1 transition-opacity hover:opacity-80"
          >
            <Logo size={17} />
            <span className="font-display text-lg font-semibold tracking-tight">Silos</span>
          </button>
          <span className="flex items-center gap-0.5">
            <NewMenu />
            <SearchDoor />
          </span>
        </div>
        {/* the md range (a narrow rail, no text): the mark, and under it the
            same search door — the palette is the rail's way to everything
            the narrow column can't show (Tasks, the New menu's four, the
            Map), so it can't be the one thing that disappears here. */}
        <div className="hidden md:max-lg:flex flex-col items-center gap-1.5">
          <button
            type="button"
            aria-label="Home"
            title="Home"
            aria-current={isHome ? 'true' : undefined}
            onClick={() => changePage(null)}
            className="rounded-md p-1 transition-opacity hover:opacity-80"
          >
            <Logo size={20} />
          </button>
          <SearchDoor />
        </div>
        {warming ? <span className="text-xs text-ink-2 md:max-lg:hidden">indexing sessions…</span> : null}
        {/* the list filter in force (set from the palette's «Filter the
            list to …»): filters topics by title/skill — the same `filter`
            "Show all" already consumed. Editable in place, with its ✕. In the
            md rail there's no room for the field: the filter glyph alone says
            the tree is filtered, and clears it. */}
        {filterActive ? (
          <>
            <div className="mt-1.5 flex items-center gap-1 md:max-lg:hidden">
              <div className="relative flex-1">
                <FilterIcon size={12} aria-hidden="true" className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-terracotta" />
                <input
                  type="text"
                  aria-label="search conversations"
                  title="This list is filtered — only matching conversations show"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter this list"
                  className="w-full rounded-lg border border-line bg-canvas py-1 pl-7 pr-2 text-xs outline-none focus:border-terracotta"
                />
              </div>
              <button
                type="button"
                aria-label="clear the filter"
                title="Clear the filter — show the whole list"
                onClick={() => setFilter('')}
                className="shrink-0 rounded p-1 text-ink-2 hover:bg-canvas hover:text-ink"
              >
                <CloseIcon size={12} />
              </button>
            </div>
            <div className="hidden md:max-lg:flex justify-center">
              <button
                type="button"
                aria-label="clear the filter"
                title={`Filtered to “${filter.trim()}” — click to show the whole list`}
                onClick={() => setFilter('')}
                className="rounded-md p-1 text-terracotta hover:bg-canvas"
              >
                <FilterIcon size={14} />
              </button>
            </div>
          </>
        ) : null}
      </header>

      {/* a PERSISTENT section (cross-cutting across silos): fixed at the
          top, doesn't scroll with the tree. An extensible container —
          today only Pinned; more blocks fit here (a global inbox, quick
          access, …). Independent of the active silo: what you pin shows
          wherever you are. */}
      <div className="shrink-0 px-2 pb-1 pt-0.5">
        <div className="mb-1">
          <MenuGlobal />
        </div>
        <PinnedSection />
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <>
          {/* the list body's switch (task-view phase 2): the conversations
            tree or the plan tasks — remembered per viewer. In the md icon
            rail there is no room for either word: the tree stays. */}
          <SidebarListSwitch />
          {sidebarList === 'tasks' ? (
            <div className="md:max-lg:hidden">
              <SidebarTasks />
            </div>
          ) : null}
          <div className={sidebarList === 'tasks' ? 'hidden md:max-lg:block' : ''} data-testid="sidebar-conversations">
            {emptyInstall ? <EmptyDoor /> : null}
            {groups.map((g) => {
              const key = groupKey(g.folder)
              const hasHeader = withHeaders && Boolean(g.folder)
              // the project whose page is open is ALWAYS shown expanded and
              // with its header highlighted — it used to be able to stay collapsed.
              const pageOpen = currentPage?.kind === 'project' && currentPage.folder === g.folder
              const collapsed = hasHeader && (projectsPrefs.collapsed ?? []).includes(key)
              return (
                // the air between projects lives in the group's WRAPPER
                // ([&+&]:mt-5 between siblings), not in the header — the
                // `first:pt-2` GroupHeader used to carry was a first-child of
                // this very wrapper (i.e., ALWAYS), so the "between projects"
                // pt-6 never applied and vertical hierarchy was left at the
                // mercy of loose paddings. With the margin on the wrapper, the
                // rhythm is the same whether or not the group has a header,
                // and the Anywhere block (mb-5, above) breathes the same way.
                <div key={key || '__no-folder__'} className="[&+&]:mt-5">
                  {hasHeader && g.folder ? (
                    <GroupHeader
                      folder={g.folder}
                      active={pageOpen}
                      collapsed={collapsed}
                      isDragged={dragging === key}
                      isDropTarget={dropTarget === key && dragging !== key}
                      onToggleCollapse={() => toggleProjectCollapse(key)}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', key)
                        e.dataTransfer.effectAllowed = 'move'
                        setDragging(key)
                      }}
                      onDragOver={(e) => {
                        e.preventDefault()
                        setDropTarget(key)
                      }}
                      onDragLeave={() => setDropTarget((d) => (d === key ? null : d))}
                      onDrop={onDropOnHeader(key)}
                      onDragEnd={() => {
                        setDragging(null)
                        setDropTarget(null)
                      }}
                      // 🧠 no longer opens the MemoryDrawer — it navigates
                      // straight to the project's page on its Memory tab.
                      onMemory={() => {
                        changePage({ kind: 'project', folder: g.folder as string })
                        if (collapsed) toggleProjectCollapse(key) // opening its page expands it (an action, not forced)
                        changeProjectTab('memory')
                      }}
                      onOpenProject={() => {
                        changePage({ kind: 'project', folder: g.folder as string })
                        if (collapsed) toggleProjectCollapse(key)
                      }}
                    />
                  ) : null}
                  {collapsed ? null : (
                    // a project's agents are indented one step under its
                    // header; kept small so conversations (what's navigated
                    // most) don't end up pushed too deep in. Agents with no
                    // folder (Anywhere) sit flush.
                    <div>
                      {g.agents.map((a) => (
                        <AgentItem
                          key={a.id}
                          agent={a}
                          selected={a.id === selectedAgentId}
                          current={dossierOpenFor(a.id)}
                          showFolder={!withHeaders}
                          nowTick={nowTick}
                          unread={unreadAgentIds.has(a.id)}
                          onSelect={() => selectAgent(a.id)}
                          drag={agentDragFor(a.id)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
            {/* Unassigned is the system's INBOX: loose sessions that don't map
            to any configured agent (a terminal session, a folder with no
            agent). It's a CATEGORY, not an agent — so it has no name row and
            no ⋯ menu; the sessions hang straight off the section label, which
            is styled apart from a project header (sentence case, muted, no
            uppercase tracking) precisely because it's a different kind of
            thing. Hidden entirely when empty — an empty inbox is just noise.
            "Empty" counts BOTH kinds of thing that live here: loose sessions
            AND Anywhere's own automations (an automation belongs to an
            agent, Anywhere included — it must have a home from the moment it
            exists, not only once a run has produced a conversation). */}
            {master && (master.sessions.length > 0 || masterHasAutomations) ? (
              <div className="mt-5 border-t border-line/60 pt-2">
                {/* the inbox has no agent row, so its label line carries the
                same ⚡ an agent's row would (Anywhere's automations). */}
                <div className="flex items-center justify-between pl-2 pr-1 pb-0.5 text-[11px] text-ink-3">
                  <span>Unassigned</span>
                  <AutomationsGlyph agent={master} visibleName="Anywhere" />
                </div>
                {/* same breakpoint gate as an agent's compact topic list: shown
                at lg and below md, hidden in the md icon-rail range (there's
                no name row to click open there). */}
                <div className="hidden max-md:block lg:block">
                  <ExpandedSessions agent={master} nowTick={nowTick} compact />
                </div>
              </div>
            ) : null}
            <ProjectsBag
              groups={inactiveGroups}
              dragging={dragging}
              onDropInBag={(e) => {
                e.preventDefault()
                const key = e.dataTransfer.getData('text/plain') || dragging
                setDragging(null)
                setDropTarget(null)
                if (key) moveToStash(key)
              }}
              onDragStartFromBag={(key) => (e) => {
                e.dataTransfer.setData('text/plain', key)
                e.dataTransfer.effectAllowed = 'move'
                setDragging(key)
              }}
              onDragEnd={() => {
                setDragging(null)
                setDropTarget(null)
              }}
              onRemove={(key) => removeFromStash(key)}
            />
          </div>
        </>
      </nav>

      <footer className="shrink-0">
        <AccountFooter onSettings={() => changePage({ kind: 'settings' })} />
      </footer>
    </aside>
  )
}
