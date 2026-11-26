// Chat.tsx — the body of AgentPage.tsx's CONVERSATION VIEW — the external
// terminal session banner, the Transcript and the Composer. The topic
// title (`#` + editable), the agent band with its facets and the global
// Esc shortcut live in AgentPage.tsx (ConversationHeader/AgentBand/
// AgentPage) — this component no longer knows anything about "which agent
// this is" or the session's title, only about the conversation's content
// (or its absence). It's still the fallback AgentPage mounts when there's
// no agent page at all (a cold start): in that case `selectedAgentId` is
// also null and EmptyChatHeader (with its back button) is all that's
// needed — EmptyState (inside Transcript) decides which variant to show.
import { useRef, useState, useEffect } from 'react'
import { Lock, RotateCcw, TriangleAlert } from 'lucide-react'
import { ChatIcon, ConsoleIcon, ListIcon } from '../lib/icons'
import { useStore } from '../store'
import { rereadSentence } from '../lib/context'
import { chainTip, isSuperseded } from '../lib/grouping'
import type { SessionView } from '../lib/types'
import { Pulse } from './Pulse'
import { isLive } from '../lib/live'
import { api, ApiError } from '../lib/api'
import { Transcript } from './Transcript'
import { Composer, type ComposerHandle } from './Composer'
import { ConsoleCue } from './ConsoleCue'
import { TerminalPanel, TerminalView, consoleTheme, consoleLightTheme } from './TerminalPanel'
import { useDarkMode } from './Sidebar'

// a shared back button — an agent with no sessions (selectAgent jumps
// straight to 'chat' so the composer is reachable) arrives at the chat
// view with selected/detail null. AgentPage.tsx reuses it in its compact
// (mobile) header plate — exported to avoid duplicating the same button twice.
// It opens the same list ListButton does, so it wears the same glyph (the
// list, icons.ts) — a ‹ chevron is «back to where you came from», which
// this is not: it always lands on the list, whatever came before.
export function BackButton() {
  return (
    <button
      type="button"
      aria-label="back"
      title="Agents and conversations"
      onClick={() => useStore.getState().backToMobileList()}
      className="md:hidden shrink-0 rounded-md p-1 text-ink-2 hover:bg-panel hover:text-ink"
    >
      <ListIcon size={17} />
    </button>
  )
}

// Home's door to the list on a phone. Home is the first screen there, so
// its way to the agents and conversations
// isn't "back" — nothing came before it — but the list beside it: the same
// gesture as BackButton (backToMobileList), named and drawn for what it
// opens. md:hidden like every mobile column control.
export function ListButton() {
  return (
    <button
      type="button"
      aria-label="agents and conversations"
      title="Agents and conversations"
      onClick={() => useStore.getState().backToMobileList()}
      className="md:hidden -ml-1 shrink-0 rounded-md p-1 text-ink-2 hover:bg-panel hover:text-ink"
    >
      <ListIcon size={17} />
    </button>
  )
}

// a minimal header for when there's NEITHER an agent chosen NOR a session
// open (a cold start, before any selection) — just the back button,
// md:hidden entirely: desktop needs no header to go back to anywhere.
function EmptyChatHeader() {
  return (
    <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3 md:hidden">
      <BackButton />
    </header>
  )
}

// a banner to continue an external terminal session — everything left of
// FilaSesion after moving title/status/badges to ConversationHeader
// (AgentPage.tsx). A neutral bordered panel: terracotta stays reserved for
// send/live pulses/skill chips/the composer's focus.
//
// "following live" is a claim about NOW (a 49-day-old thread once
// read "Idle for 49d" and, right under it, "following live"): the banner
// shows only while the session is live by the same clock as the sidebar
// dot (isLive over mtime + nowTick), and only beside a reason that leaves
// THIS conversation as the place to continue — chat by choice or a console
// that couldn't open. An older rotation continues in its tip, a run is
// never continued, and an idle thread is by definition not live: those
// already say what they are in their own line, and two lines never
// contradict each other.
export function terminalBannerShows(native: boolean | undefined, mtime: number, now: number, reason: ViewReason | null): boolean {
  if (native !== false || !isLive(mtime, now)) return false
  return reason === null || reason.kind === 'chat' || reason.kind === 'fallback'
}

function TerminalBanner({ onContinue, reason, mtime }: { onContinue: () => void; reason: ViewReason | null; mtime: number | null }) {
  const detail = useStore((s) => s.detail)
  const nowTick = useStore((s) => s.nowTick)
  if (!detail || !terminalBannerShows(detail.meta.native, mtime ?? detail.meta.mtime, nowTick, reason)) return null
  // a status line, not a call to action: it was the only
  // solid-black button on the page for something that merely orients. The
  // fork is an implementation detail — with the chain lineage the
  // continuation is grouped as THE SAME # topic, so the copy talks about
  // continuing the conversation, not about branches.
  return (
    <div className="mx-4 mb-2 flex items-center gap-2 border-b border-line/70 px-1 pb-2 text-[12px] text-ink-2">
      <Pulse />
      <span className="min-w-0 flex-1 truncate">Terminal session — following live.</span>
      <button type="button" onClick={onContinue} className="shrink-0 text-terracotta hover:underline">
        Continue in Silos ›
      </button>
    </div>
  )
}

// a conversation is either LIVE — the real console, or a chat you can
// type into — or a TRANSCRIPT. The window itself says which (five
// explanatory sentences above the messages were too complex, and
// stacked with the other banners they made a tall block): a transcript has
// no composer. Where the composer would be sits a read-only footer, one
// quiet strip with at most ONE way out, and the exact reason lives in its
// tooltip, never as prose. Three read-only reasons: an older rotation (the
// live console is the tip's → open it), a run born from an automation
// (runs never open a console → no way out), a nested run. Two LIVE
// reasons keep the composer: chat by choice (the band's Real console|Chat
// selector is the way to the console) and a console that couldn't open
// (ConsoleFallbackStrip above the composer → retry).
// Nothing is hidden without naming what it is (docs/product.md): the
// footer's tooltip names the reason.
// An idle conversation is NOT a reason (this replaced an earlier
// read-only gate): its claude slept after a day without work (terminal-service
// CONSOLE_SLEEP_MS) and opening the conversation wakes it with --resume —
// one process, the one on screen, zero tokens until a prompt. The sidebar
// orders by content activity, so a wake never bumps a dead thread. The
// console SAYS it was asleep (ConsoleView's woke line) instead of hiding
// the mechanism behind a lock.
export const CONSOLE_SLEEP_MS = 24 * 3_600_000

export type ViewReason =
  | { kind: 'superseded'; tip: SessionView | null; cleared: boolean }
  | { kind: 'run'; automationId: string }
  // a nested run (births): an agent's own `claude -p`, never a console —
  // its way out is the conversation whose claude ran it, when indexed.
  | { kind: 'nested'; agentId: string; parent: SessionView | null }
  | { kind: 'fallback'; error: string }
  | { kind: 'chat' }

// the session a superseded thread continues in — the chain's tip (the most
// recently active descendant), not merely its first child.
function supersededTip(allSessions: readonly SessionView[], key: { folder: string; id: string }): SessionView | null {
  const tip = chainTip(allSessions, key.folder, key.id)
  return allSessions.find((s) => s.folder === tip.folder && s.id === tip.id) ?? null
}

// did the console leave THIS conversation by a /clear? True when the way
// from the tip back up to it crosses a /clear link — then the tip is a
// new conversation, not where this one continues.
function clearedInto(allSessions: readonly SessionView[], key: { folder: string; id: string }, tip: SessionView | null): boolean {
  const byKey = new Map(allSessions.map((s) => [`${s.folder}/${s.id}`, s]))
  const target = `${key.folder}/${key.id}`
  let cur = tip
  let crossed = false
  for (let i = 0; cur && i < 64; i++) {
    if (`${cur.folder}/${cur.id}` === target) return crossed
    if (cur.parentKind === 'clear') crossed = true
    cur = cur.parentKey ? (byKey.get(cur.parentKey) ?? null) : null
  }
  return false
}

// the read-only reasons — the ones that take the composer away
export function isReadOnly(reason: ViewReason | null): boolean {
  return reason !== null && (reason.kind === 'run' || reason.kind === 'nested' || reason.kind === 'superseded')
}

// the strip shared by the footer and the fallback: TerminalBanner's visual
// family (a status line, not a call to action), on the panel tone so it
// reads as a different surface from the messages.
const stripClass = 'mx-4 mb-3 flex shrink-0 items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-[12px] text-ink-2'
const stripAction = 'shrink-0 text-terracotta hover:underline'

function TranscriptFooter({ reason }: { reason: ViewReason }) {
  const automations = useStore((s) => s.automations)
  const agents = useStore((s) => s.agents)
  let why: string
  let button: { label: string; onClick: () => void } | null = null
  switch (reason.kind) {
    case 'superseded': {
      const tip = reason.tip
      why = reason.cleared
        ? tip
          ? `Cleared with /clear; the console went on in “${tip.title}”`
          : 'Cleared with /clear; the console went on in a new conversation'
        : tip
          ? `This thread continues in “${tip.title}”`
          : 'This thread continues in a newer conversation'
      button = tip ? { label: 'Open the current conversation ›', onClick: () => void useStore.getState().openSession(tip.folder, tip.id) } : null
      break
    }
    case 'run': {
      const name = automations.find((a) => a.id === reason.automationId)?.name ?? 'an automation'
      why = `Run of “${name}”; runs never open a console`
      break
    }
    case 'nested': {
      const parent = reason.parent
      const who = agents.find((a) => a.id === reason.agentId)?.name ?? reason.agentId
      why = parent ? `Nested run launched from “${parent.title}”; runs never open a console` : `Nested run of ${who}; runs never open a console`
      button = parent ? { label: 'Open the conversation that ran it ›', onClick: () => void useStore.getState().openSession(parent.folder, parent.id) } : null
      break
    }
    default:
      return null
  }
  return (
    <div data-testid="transcript-footer" title={why} className={stripClass}>
      <Lock size={13} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">Read-only</span>
      {button ? (
        <button type="button" onClick={button.onClick} className={stripAction}>
          {button.label}
        </button>
      ) : null}
    </div>
  )
}

// the console couldn't open and the owner chose to go on in chat: the chat
// is live (composer below), this strip names the error and offers a retry.
function ConsoleFallbackStrip({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div data-testid="console-fallback" className={stripClass}>
      <TriangleAlert size={13} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">Console unavailable: {error}</span>
      <button type="button" onClick={onRetry} className={stripAction}>
        Retry ›
      </button>
    </div>
  )
}

export function Chat({ modeSelector = true }: { modeSelector?: boolean } = {}) {
  const selected = useStore((s) => s.selected)
  const selectedAgentId = useStore((s) => s.selectedAgentId)
  const composerRef = useRef<ComposerHandle>(null)
  // the real console: a Chat ⇄ Console selector. Lives in the store (sticky,
  // default console) — so it persists across sessions and tests can pin it.
  const mode = useStore((s) => s.chatMode)
  const setMode = useStore((s) => s.setChatMode)
  const sessionKey = selected ? `${selected.folder}/${selected.id}` : null

  function continueChat(): void {
    composerRef.current?.focus()
  }

  // the console serves both an open session (--resume) and starting a new
  // conversation (a fresh claude in the agent's folder).
  const canConsole = Boolean(selected || selectedAgentId)
  // an old rotation of a thread (a newer session continues it) reads as its
  // transcript even in console mode — the live console is the tip's.
  const agents = useStore((s) => s.agents)
  const allSessions = agents.flatMap((a) => a.sessions)
  const superseded = selected !== null && isSuperseded(allSessions, selected)
  // a run born from an automation is a transcript, never a console (the
  // server refuses too — 409): a --resume on it would make the run one of
  // the owner's threads and spawn a claude nobody is driving.
  const selectedView = selected ? (allSessions.find((s) => s.folder === selected.folder && s.id === selected.id) ?? null) : null
  // the birth comes from the overview row, or — for a session outside the
  // capped overview (⌘K, a link) — from the open detail's own meta.
  // …or from the console route's own refusal (409 naming the run), which can
  // arrive before the detail does — read-only at once, never a live
  // composer in between.
  const openDetail = useStore((s) => s.detail)
  const [refusedBirth, setRefusedBirth] = useState<{ key: string | null; origin: NonNullable<SessionView['origin']> } | null>(null)
  const birth =
    selectedView?.origin ??
    (selected && openDetail?.meta.folder === selected.folder && openDetail.meta.id === selected.id ? openDetail.meta.origin : undefined) ??
    (refusedBirth && refusedBirth.key === (selected ? `${selected.folder}/${selected.id}` : null) ? refusedBirth.origin : undefined)
  const runOf = birth?.kind === 'automation' ? birth.automationId : null
  // a nested run (births — an agent's own `claude -p`) likewise: the server
  // refuses its console too (409), it is read as a transcript.
  const nestedOf = birth?.kind === 'nested' ? birth : null
  const consoleKey = selected ? sessionKey : selectedAgentId ? `agent-${selectedAgentId}` : null
  // a console that couldn't open falls back to chat for THIS destination
  // only — never by flipping the sticky chatMode (that flip was global and,
  // with the Console|Chat selector hidden once a conversation has started,
  // there was no way back to the real console). A new destination — or
  // coming back to this one after a reload — retries the console. The
  // error travels with the fallback so the transcript can SAY why.
  const [chatFallback, setChatFallback] = useState<string | null>(null)
  useEffect(() => {
    setChatFallback(null)
  }, [consoleKey])
  const inConsole = mode === 'console' && canConsole && !superseded && runOf === null && nestedOf === null && chatFallback === null
  // tells the context column this conversation is on screen as its console
  const shownKey = inConsole && selected ? `${selected.folder}/${selected.id}` : null
  useEffect(() => {
    useStore.getState().setConsoleShown(shownKey)
    return () => useStore.getState().setConsoleShown(null)
  }, [shownKey])
  // why this is not the console — decides the kind of window: read-only
  // (footer, no composer) or live (composer; a strip only for a fallback).
  const reason: ViewReason | null = !selected
    ? null
    : runOf !== null
      ? { kind: 'run', automationId: runOf }
      : nestedOf !== null
        ? { kind: 'nested', agentId: nestedOf.agentId, parent: nestedOf.parent !== null ? (allSessions.find((s) => s.id === nestedOf.parent) ?? null) : null }
        : superseded
          ? (() => {
              const tip = supersededTip(allSessions, selected)
              return { kind: 'superseded' as const, tip, cleared: clearedInto(allSessions, selected, tip) }
            })()
          : chatFallback !== null
            ? { kind: 'fallback', error: chatFallback }
            : mode === 'chat'
              ? { kind: 'chat' }
              : null
  const readOnly = isReadOnly(reason)

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {!selected && !selectedAgentId ? <EmptyChatHeader /> : null}
      {/* the Console|Chat selector normally lives in the agent band (AgentPage)
          — here only when nobody above renders it (no agent found). */}
      {canConsole && modeSelector ? <ModeSelector mode={mode} onChange={setMode} /> : null}
      {inConsole ? (
        <ConsoleView
          key={consoleKey ?? '__console__'}
          sessionId={selected?.id}
          agentId={!selected ? (selectedAgentId ?? undefined) : undefined}
          lastActivity={selectedView?.mtime ?? null}
          onFallback={(err) => setChatFallback(err)}
          onRefused={(origin) => setRefusedBirth({ key: selected ? `${selected.folder}/${selected.id}` : null, origin })}
        />
      ) : (
        <>
          <TerminalBanner onContinue={continueChat} reason={reason} mtime={selectedView?.mtime ?? null} />
          {/* a read-only window is a different surface from afar: the page
              tone leans towards the panel (the composer's absence alone is
              easy to miss). `--canvas` is overridden on this wrapper so every
              bg-canvas/from-canvas inside — the scroll fade included — follows;
              the user bubbles (bg-panel) stay one step apart. */}
          <div
            className={`flex min-h-0 flex-1 flex-col${readOnly ? ' bg-canvas' : ''}`}
            style={readOnly ? { ['--canvas' as string]: 'color-mix(in srgb, var(--panel) 55%, var(--canvas))' } : undefined}
          >
            <Transcript key={sessionKey ?? '__no-session__'} />
          </div>
          {readOnly && reason ? <TranscriptFooter reason={reason} /> : null}
          {reason?.kind === 'fallback' ? <ConsoleFallbackStrip error={reason.error} onRetry={() => setChatFallback(null)} /> : null}
          {/* key by the destination so the composer's unsent draft is scoped
              to the conversation: switching between two ALREADY-OPEN sessions
              remounts it and clears the text, so a draft typed for A can never
              be sent into B (send() reads the current selection). Same reason
              Transcript is keyed above — but with a `composer-` prefix: two
              SIBLINGS sharing one key (this and Transcript both carried the
              bare `folder/id`) break React's keyed reconciliation, which left
              the old Transcript's DOM mounted on every switch (conversations
              visibly stacked in one view until a reload). */}
          {readOnly ? null : <Composer key={consoleKey ? `composer-${consoleKey}` : '__composer__'} ref={composerRef} />}
        </>
      )}
      {/* the shell terminal bar lives below BOTH modes — you can open a real
          terminal whether you're in chat or in the real console. */}
      <TerminalPanel />
    </div>
  )
}

// the Chat ⇄ Console selector — a discreet pill, the same visual language
// as the rest (a terracotta accent on the active one, no box). Exported:
// AgentPage's band renders it at its right edge (a mode is a property of
// how you talk to THIS agent, so it sits with the agent —
// and stops being a second header bar under the band). `own` lets a
// caller pass the store's mode/setter itself; without it the selector
// reads the store directly.
export function ModeSelector({ mode, onChange, inBand = false }: { mode?: 'chat' | 'console'; onChange?: (m: 'chat' | 'console') => void; inBand?: boolean }) {
  const storeMode = useStore((s) => s.chatMode)
  const storeSet = useStore((s) => s.setChatMode)
  const current = mode ?? storeMode
  const set = onChange ?? storeSet
  const btn = (m: 'chat' | 'console', Icon: typeof ChatIcon, label: string, experimental = false) => (
    <button
      type="button"
      onClick={() => set(m)}
      aria-pressed={current === m}
      // the chat is still rough; the real console is the trustworthy
      // default. "Experimental" became a tooltip + a small dot instead of
      // an uppercase tag louder than the title above it.
      title={experimental ? `${label} — experimental` : undefined}
      className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
        current === m ? 'bg-terracotta-soft text-terracotta' : 'text-ink-2 hover:text-ink'
      }`}
    >
      <Icon size={13} aria-hidden="true" />
      {label}
      {experimental ? <span aria-label="experimental" className="h-1.5 w-1.5 rounded-full bg-terracotta/60" /> : null}
    </button>
  )
  // The real console goes FIRST — it's the default and the reliable path;
  // chat follows, flagged experimental.
  return (
    <div className={inBand ? 'flex shrink-0 items-center gap-0.5' : 'flex shrink-0 items-center gap-1 border-b border-line px-3 py-1.5'}>
      {btn('console', ConsoleIcon, 'Real console')}
      {btn('chat', ChatIcon, 'Chat', true)}
    </div>
  )
}

// opens the real console (--resume of a session, or a fresh claude in the
// agent's folder for a new conversation) and mounts an xterm on it. The
// server keeps the claude in a durable tmux session; this view's socket
// gets its OWN tmux client (/ws/console/:key), born at this tab's size and
// gone when the socket closes — so navigating away costs nothing and
// coming back always gets the full screen (see TerminalView).
// the console route's 409 for a session someone else gave birth to (server
// transcriptOnly): its body names the run — an origin the window can read.
export function refusedOrigin(e: unknown): NonNullable<SessionView['origin']> | null {
  const err = e as { status?: unknown; body?: unknown } | null
  if (!err || err.status !== 409 || typeof err.body !== 'object' || err.body === null) return null
  const b = err.body as Record<string, unknown>
  if (b.nested === true && typeof b.agentId === 'string') return { kind: 'nested', agentId: b.agentId, parent: typeof b.parent === 'string' ? b.parent : null }
  if (typeof b.automationId === 'string') return { kind: 'automation', automationId: b.automationId, runId: typeof b.runId === 'string' ? b.runId : '' }
  return null
}

// "Fri 24 Oct, 00:08" — the moment the conversation last moved, in the
// owner's locale; a weekday because sleeps are measured in days.
function asleepLabel(ts: number): string {
  return new Date(ts).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
}

function ConsoleView({
  sessionId,
  agentId,
  lastActivity = null,
  onFallback,
  onRefused,
}: {
  sessionId?: string
  agentId?: string
  lastActivity?: number | null
  onFallback?: (error: string) => void
  onRefused?: (origin: NonNullable<SessionView['origin']>) => void
}) {
  const [state, setState] = useState<'opening' | 'ready' | 'error'>('opening')
  // Was this conversation's claude asleep when we opened it? Decided ONCE
  // per mount (the view is keyed by conversation) from the last message's
  // age against the server's own sleep rule — a real signal, not a guess.
  // The line stays while the conversation has no newer activity than the
  // one we woke it on; a fresh turn lifts it.
  const [asleepSince] = useState<number | null>(() => (lastActivity !== null && Date.now() - lastActivity > CONSOLE_SLEEP_MS ? lastActivity : null))
  const woke = asleepSince !== null && lastActivity === asleepSince
  const [termId, setTermId] = useState<string | null>(null)
  // the console's BIRTH theme, as reported by the server: a reused console
  // keeps the palette its claude was born with, so the pane renders with
  // THAT theme even if the UI has switched since — a light-born console on
  // a dark page painted near-black text on charcoal.
  const [paneTheme, setPaneTheme] = useState<'light' | 'dark'>('dark')
  const [error, setError] = useState<string | null>(null)
  // the refusal said another claude holds the conversation and Silos can
  // close it (POST /api/console 409 canClose) — the error view offers it
  const [canClose, setCanClose] = useState(false)
  // Restart console: a claude keeps its BIRTH theme for
  // life, so adopting the current one means kill + relaunch. `epoch` both
  // re-runs the negotiation effect and remounts TerminalView (key), so the
  // fresh spawn gets a fresh WS client. Two-step confirm: the kill takes a
  // running turn with it — never one accidental click.
  const [epoch, setEpoch] = useState(0)
  const [confirmRestart, setConfirmRestart] = useState(false)
  // what the relaunch costs, said on the confirm: the resumed claude
  // re-reads the whole conversation — measured size, else nothing said
  const reread = useStore((s) => (sessionId && s.detail?.meta.id === sessionId ? rereadSentence(s.detail.meta.contextTokens) : null))
  // the "Run on…" panel's "Use & restart the console": the same kill +
  // relaunch as the ↻, requested through the store (counter; the initial
  // value is ignored, same pattern as composerFocusRequest)
  const restartRequest = useStore((s) => s.consoleRestartRequest)
  const firstRestartRef = useRef(true)
  useEffect(() => {
    if (firstRestartRef.current) {
      firstRestartRef.current = false
      return
    }
    void restartConsole()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restartRequest])
  // The console follows Silos' theme (before, it was a fixed
  // dark slab on the cream page). Dark keeps the warm charcoal consoleTheme;
  // light sits on --canvas (almost white, NOT the menu's --panel cream) with
  // the 256-color cube remapped for contrast (consoleLightTheme). The theme
  // at OPEN time also travels to the server so claude itself matches —
  // switching later re-paints xterm, but claude keeps its colors until the
  // console is reopened.
  const [dark] = useDarkMode()
  // the sentence this console was opened to send (consoleCue): shown beside
  // THIS console only — the new one of its agent, then the conversation it
  // became (the key it was born with)
  const cue = useStore((s) => s.consoleCue)
  const cueHere = cue !== null && (sessionId ? cue.console === sessionId : agentId === cue.agentId && (cue.console === null || cue.console === termId))
  useEffect(() => {
    if (!sessionId && termId && cue && cue.agentId === agentId && cue.console === null) useStore.getState().pinConsoleCue(termId)
  }, [sessionId, agentId, termId, cue])

  useEffect(() => {
    let alive = true
    setState('opening')
    setTermId(null)
    setError(null)
    // a new conversation carries the account picked in the chips before
    // the first prompt (pendingConvPrefs); an open session's pin lives in
    // its prefs and the server reads it there.
    const pendingProvider = !sessionId ? useStore.getState().pendingConvPrefs.provider : undefined
    const pendingModel = !sessionId ? useStore.getState().pendingConvPrefs.model : undefined
    const pendingStyle = !sessionId ? useStore.getState().pendingConvPrefs.outputStyle : undefined
    api
      .console({
        sessionId,
        agentId,
        theme: dark ? 'dark' : 'light',
        ...(pendingProvider ? { provider: pendingProvider } : {}),
        ...(pendingModel ? { model: pendingModel } : {}),
        ...(pendingStyle ? { outputStyle: pendingStyle } : {}),
      })
      .then((h) => {
        if (!alive) return
        setTermId(h.key)
        setPaneTheme(h.theme ?? (dark ? 'dark' : 'light'))
        setState('ready')
        // a new conversation: the key IS the session id claude was born
        // with — the store opens it once its JSONL appears (applyWs 'session').
        if (!sessionId && agentId) useStore.getState().setPendingConsole(h.key)
      })
      .catch((e: unknown) => {
        if (!alive) return
        const refused = refusedOrigin(e)
        if (refused) {
          onRefused?.(refused)
          return
        } // a run: read-only, not a broken console
        // an older piece of the thread (the server knows where it continues:
        // 409 + tip «folder/id») — the console IS the tip's: open it there,
        // never an error the owner can only read (the server's lineage can
        // see a continuation the web's list has not painted yet)
        const tip = e instanceof ApiError && e.status === 409 && typeof e.body === 'object' && e.body !== null ? (e.body as { tip?: unknown }).tip : undefined
        if (typeof tip === 'string' && tip.includes('/')) {
          const cut = tip.indexOf('/')
          const before = useStore.getState().selected
          void Promise.resolve(useStore.getState().openSession(tip.slice(0, cut), tip.slice(cut + 1))).then(() => {
            if (!alive) return
            // the jump must MOVE the view: when the web's own idea of the
            // thread's tip lands back on this same conversation, a silent
            // return left «Opening the real console…» forever — say why instead
            const now = useStore.getState().selected
            if (now && before && now.folder === before.folder && now.id === before.id) {
              setError(e instanceof Error ? e.message : String(e))
              setState('error')
            }
          })
          return
        }
        setCanClose(e instanceof ApiError && typeof e.body === 'object' && e.body !== null && (e.body as { canClose?: unknown }).canClose === true)
        setError(e instanceof Error ? e.message : String(e))
        setState('error')
      })
    return () => {
      alive = false
    }
    // `dark` is a dep on purpose (otherwise the switcher wouldn't
    // change it): toggling the UI theme renegotiates with the server,
    // which answers with the console's BIRTH theme (the stamp) — so the
    // pane repaints right (TerminalView live-swaps xterm's theme) instead
    // of keeping the canvas it mounted with. `epoch` re-runs it after a
    // restart, when there IS no console and the ensure spawns a fresh one.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onRefused is a callback, not a reason to renegotiate
  }, [sessionId, agentId, dark, epoch])

  // auto-disarm the restart confirmation if it isn't taken up
  useEffect(() => {
    if (!confirmRestart) return
    const t = setTimeout(() => setConfirmRestart(false), 4000)
    return () => clearTimeout(t)
  }, [confirmRestart])

  async function restartConsole(): Promise<void> {
    if (!termId) return
    setConfirmRestart(false)
    setState('opening')
    setTermId(null)
    setError(null)
    try {
      await api.consoleClose(termId) // waits for the dying claude (server)
    } catch {
      /* already gone → the ensure below just spawns */
    }
    setEpoch((e) => e + 1) // the effect re-ensures with the CURRENT theme
  }

  // close the claude that holds the conversation (outside Silos — a hand
  // launch, auto-retry) and open in one gesture: the server's close-and-wait
  async function closeHolderAndOpen(): Promise<void> {
    setState('opening')
    setError(null)
    setCanClose(false)
    try {
      const h = await api.console({ sessionId, agentId, theme: dark ? 'dark' : 'light', closeHolders: true })
      setTermId(h.key)
      setPaneTheme(h.theme ?? (dark ? 'dark' : 'light'))
      setState('ready')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setState('error')
    }
  }

  if (state === 'error') {
    // the console needs a live project folder (it spawns `claude` there); if the
    // folder is gone or the session's cwd is otherwise unavailable, fall back to
    // chat, which reads the transcript straight from the JSONL and needs no cwd.
    // The fallback is Chat's LOCAL one (onFallback), scoped to this
    // destination — never setChatMode('chat'), which is the sticky global
    // preference and would trap every future conversation in chat.
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="max-w-sm text-sm text-ink-2">Couldn't open the real console: {error}</p>
        <div className="flex items-center gap-2">
          {canClose ? (
            <button
              type="button"
              onClick={() => void closeHolderAndOpen()}
              className="rounded-lg bg-terracotta px-3 py-1.5 text-sm font-medium text-on-terracotta hover:opacity-90"
            >
              Close it and open ›
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => onFallback?.(error ?? 'unknown error')}
            className={
              canClose
                ? 'rounded-lg border border-line px-3 py-1.5 text-sm text-ink-2 hover:text-ink'
                : 'rounded-lg bg-terracotta px-3 py-1.5 text-sm font-medium text-on-terracotta hover:opacity-90'
            }
          >
            View in chat instead
          </button>
        </div>
      </div>
    )
  }
  if (state !== 'ready' || !termId) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-ink-2">
        {asleepSince !== null ? `Waking the console — asleep since ${asleepLabel(asleepSince)}` : 'Opening the real console…'}
      </div>
    )
  }
  // `relative` is KEY: TerminalView's xterm is `absolute inset-0`, so it anchors
  // to this container and stays bounded BETWEEN the selector and whatever is
  // below (without `relative` it anchored to an ancestor and covered them). The
  // container paints the same background as the xterm theme → no other-colored edges.
  // The console's lifecycle is the CONVERSATION's: while the conversation
  // exists in the UI its terminal exists (always warm — reattaching is
  // instant, never a cold boot). It dies exactly when the conversation is
  // trashed or its agent archived — no manual process management here.
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {woke ? (
        // proof of life for the wake: the process on screen was just
        // relaunched over a conversation that slept — one slim strip ABOVE
        // the pane, in the page's own chrome, never over the TUI's text
        // (an overlay top-left was unreadable); gone with the
        // next turn.
        <div data-testid="console-woke" className="flex shrink-0 items-center gap-2 border-b border-line bg-panel px-4 py-1.5 font-mono text-[11px] text-ink-2">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ink-3" aria-hidden="true" />
          Woke it up · asleep since {asleepLabel(asleepSince)}
        </div>
      ) : null}
      {cueHere && cue ? <ConsoleCue text={cue.text} onDrop={() => useStore.getState().dropConsoleCue()} /> : null}
      {/* full-bleed under the header — the header's own chrome (bg-panel +
        hairline, AgentPage.ConversationHeader) is what separates the two;
        a framed canvas was tried and rejected. */}
      <div className="relative min-h-0 flex-1" style={{ background: paneTheme === 'dark' ? 'var(--console-dark-bg)' : 'var(--canvas)' }}>
        {/* Restart console — kill + relaunch so the claude inside adopts the
          CURRENT theme (its palette is fixed at birth). The conversation
          resumes from its JSONL; only the process is recycled. */}
        <button
          type="button"
          onClick={() => (confirmRestart ? void restartConsole() : setConfirmRestart(true))}
          title="Restart console — relaunches claude with the current theme; the conversation resumes"
          aria-label="Restart console"
          className={`absolute right-2 top-2 z-10 flex items-center gap-1.5 rounded-md px-1.5 py-1 font-mono text-[10px] transition-colors ${
            paneTheme === 'dark'
              ? 'bg-veil-light/[0.06] text-console-dark-ink-2 hover:bg-veil-light/10 hover:text-console-dark-ink'
              : 'bg-veil-dark/[0.05] text-ink-2 hover:bg-veil-dark/10 hover:text-ink'
          }`}
        >
          <RotateCcw size={12} aria-hidden="true" className="shrink-0 self-start" />
          {confirmRestart ? (
            <span className="max-w-[17rem] text-left">
              Kill the running claude and relaunch?
              {reread ? <span className="block opacity-80">{reread}</span> : null}
            </span>
          ) : null}
        </button>
        <TerminalView
          key={`${termId}:${epoch}`}
          id={termId}
          endpoint="console"
          isActive
          paneDark={paneTheme === 'dark'}
          theme={paneTheme === 'dark' ? consoleTheme() : consoleLightTheme()}
          onClosed={() => void restartConsole()}
        />
      </div>
    </div>
  )
}
