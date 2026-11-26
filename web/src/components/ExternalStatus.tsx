// ExternalStatus.tsx — a live state monitor for external (terminal)
// sessions: shows
//   ✢ Running Bash… (5m 1s · ↓ 7.4k tokens)
// while the external session is working, and
//   ✻ Worked for 1h 11m 37s
// once it finishes. It isn't our turn (we didn't launch it and can't
// cancel it from here) — no stop/esc buttons, unlike StatusLine's tree.
//
// Reuses formatTokens from StatusLine (the same "7.4k" format across the
// app). The elapsed time uses a deliberately different format
// (formatLongDuration, today in StatusLine.tsx — shared with turn
// receipts, "5m 1s"/"1h 11m 37s") instead of formatElapsed's "m:ss": a
// closing phrase ("Worked for X") reads better with letter suffixes than with colons.
import { useEffect, useState } from 'react'
import type { HarnessId, Turn } from '../lib/types'
import { formatLongDuration, formatTokens } from './StatusLine'
import { contextColorClass, contextPct } from '../lib/context'
import { useHarness } from '../lib/harnesses'
import { AsteriskGlyph } from './Glyph'
import { RECEIPT_MIN_MS } from './Turn'
import { summarizeTools } from '../lib/tool-summary'

const HIDE_ELAPSED_MS = 5000

export interface ExternalState {
  tools?: string[] // tools from the exchange in progress (the live streak, absorbed here)
  phase: string
  startMs: number | null
  tokens: number | null
  done: boolean
  // not in the brief's literal list (phase/startMs/tokens/done) but needed
  // to paint without recalculating ts in the component: while live it's
  // "now - startMs" (follows the clock); once done it's fixed (the last
  // exchange's end - start, as the brief asks).
  elapsedMs: number | null
}

// the live glyph rotates ✢ → ✻ → ✽ on the same 1s tick (a "live" spinner
// in the Claude Code style); with prefers-reduced-motion it stays fixed on
// the first. matchMedia is checked ONCE on mount — not reactive to
// preference changes on the fly, same as the rest of the app (see
// main.tsx, the same pattern for dark/light).
//
// the Unicode characters ✢/✻/✽ aren't covered by the fonts embedded in
// headless Chromium (tofu □ in screenshots), and potentially not on some
// users' systems either. Replaced with an inline SVG asterisk
// (currentColor, ~1em, zero font dependency) with 4/6/8 rays — mimics the
// same ✢→✻→✽ visual progression without depending on the browser having
// the glyph. The SVG lives in Glyph.tsx, shared with the live StatusLine
// and turn receipts.
const GLYPH_RAYS = [4, 6, 8] as const

// the external queue (SessionView.queue) — messages the user queued in
// their terminal while the turn was still in progress. A sibling aesthetic
// to ColaChips (dimmed chips) but FOREIGN: we didn't launch it and can't
// touch it from here, so no remove button and no hover-to-terracotta that
// our own queue has. A longer visual cap than ColaChips (60 vs 40) because
// here it doesn't compete with the composer for horizontal space.
const QUEUE_MAX_CHARS = 60

function truncateExternalQueueItem(text: string): string {
  return text.length > QUEUE_MAX_CHARS ? `${text.slice(0, QUEUE_MAX_CHARS)}…` : text
}

function ExternalQueue({ queue }: { queue?: string[] }) {
  if (!queue || queue.length === 0) return null
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-2">
      <span>Queued: {queue.length}</span>
      {queue.map((text, i) => (
        <span key={i} data-queue-item title={text} className="max-w-[24rem] truncate rounded-full border border-line bg-panel px-2 py-0.5 text-ink-2">
          {truncateExternalQueueItem(text)}
        </span>
      ))}
    </div>
  )
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function deriveExternalState(rawTurns: Turn[], live: boolean, now: number): ExternalState | null {
  // receipt marker-turns (durationMs, the CLI's system/turn_duration
  // entries) aren't an exchange — filtered out so phase/token derivation
  // sees exactly what it always did. The receipt itself is already painted
  // inline in the transcript (Turn.tsx).
  // messages from another session (interSession) carry role:'user' but are
  // NOT the owner's ask — without filtering them, a peer landing mid-turn
  // would re-anchor startMs to its own (fabricating elapsed and "Worked
  // for", losing prior tokens), and one landing at the end would
  // stretch/void the closed duration. Kept out of the whole derivation:
  // neither the anchor (userIdx), nor phase (lastTurn), nor the end (endMs).
  const turns = rawTurns.filter((t) => t.durationMs === undefined && t.interSession === undefined)
  let userIdx = -1
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]!.role === 'user') {
      userIdx = i
      break
    }
  }
  if (userIdx === -1) return null
  const userTurn = turns[userIdx]!
  const startMs = userTurn.ts ? Date.parse(userTurn.ts) : NaN
  if (!Number.isFinite(startMs)) return null
  const lastTurn = turns[turns.length - 1]!

  if (live) {
    const afterUser = turns.slice(userIdx + 1).filter((t) => t.role === 'assistant')
    const withTokens = afterUser.filter((t) => typeof t.outputTokens === 'number')
    const tokens = withTokens.length > 0 ? withTokens.reduce((acc, t) => acc + (t.outputTokens ?? 0), 0) : null
    const phase =
      lastTurn.role !== 'assistant'
        ? 'Thinking…'
        : lastTurn.tools.length > 0
          ? `Running ${lastTurn.tools[lastTurn.tools.length - 1]}…`
          : lastTurn.text.trim() !== ''
            ? 'Writing…'
            : 'Thinking…'
    const tools = afterUser.flatMap((t) => t.tools)
    return { phase, startMs, tokens, done: false, elapsedMs: Math.max(0, now - startMs), tools }
  }

  // done: the duration is the last exchange's (a real end, not "now") — a
  // short exchange (<5s) doesn't need the notice.
  const endMs = lastTurn.ts ? Date.parse(lastTurn.ts) : NaN
  if (!Number.isFinite(endMs)) return null
  const elapsedMs = endMs - startMs
  if (elapsedMs < HIDE_ELAPSED_MS) return null
  return { phase: '', startMs, tokens: null, done: true, elapsedMs }
}

// contextTokens/model arrive from meta (the server's SessionMeta) — flat
// instead of a nested `meta` object because that's the only thing from it
// needed here (the same criterion as turns/live).
export function ExternalStatus({
  turns,
  live,
  contextTokens,
  model,
  queue,
  ownReceiptTs,
  harness,
}: {
  turns: Turn[]
  live: boolean
  contextTokens?: number
  // an engine that reports no context-window size (OpenCode, per its
  // descriptor's ui.contextPercent) would have its % computed against a
  // Claude window — wrong, not approximate: no gauge at all.
  harness?: HarnessId
  model?: string
  queue?: string[]
  // the ts (ms) of the client's own last receipt for this session — if
  // it's from the current exchange, the monitor's "Worked for" would
  // duplicate the inline receipt ("Brewed for X") and is omitted, same as
  // with the CLI's turn_duration marker.
  ownReceiptTs?: number
}) {
  const [now, setNow] = useState(() => Date.now())
  const [tick, setTick] = useState(0)
  const [reducedMotion] = useState(prefersReducedMotion)
  const contextPercent = useHarness(harness).ui.contextPercent

  useEffect(() => {
    if (!live) return
    const id = setInterval(() => {
      setNow(Date.now())
      setTick((t) => t + 1)
    }, 1000)
    return () => clearInterval(id)
  }, [live])

  const state = deriveExternalState(turns, live, now)
  if (!state) return null

  // context %: independent of live/done — it's a snapshot of the session's
  // state (meta), not data from the exchange in progress.
  const pct = contextTokens !== undefined && contextPercent ? contextPct(contextTokens, model) : null

  if (state.done) {
    // if the last persisted turn is already a VISIBLE inline receipt (the
    // CLI's system/turn_duration with durationMs >= RECEIPT_MIN_MS — below
    // 5s the historical receipt paints nothing and this monitor goes back
    // to being the only "Worked for"), the phrase would duplicate what the
    // transcript just said and is omitted. The context % is NEVER
    // suppressed: it's a snapshot of the session (meta), not of the
    // exchange — a finished CLI session must always show its gauge when known.
    // the same filtered view as deriveExternalState — a peer (interSession)
    // landing behind the real marker used to leave finalMarker undefined
    // (reading the peer as the last turn) and this monitor painted a
    // "Worked for" DUPLICATING the already-visible inline receipt.
    const withoutPeers = turns.filter((t) => t.interSession === undefined)
    const finalMarker = withoutPeers[withoutPeers.length - 1]?.durationMs
    const inlineReceiptVisible =
      (finalMarker !== undefined && finalMarker >= RECEIPT_MIN_MS) ||
      // the client's own receipt for THIS exchange (a ts after the user
      // turn's anchor) — the inline "Brewed for X" already accounts for it.
      (ownReceiptTs !== undefined && state.startMs !== null && ownReceiptTs >= state.startMs)
    const gauge = pct !== null ? <span className={`font-mono text-xs ${contextColorClass(pct)}`.trim()}>{pct}% context</span> : null
    return (
      <div>
        {!inlineReceiptVisible ? (
          <div className="mt-2 flex items-center gap-2 text-sm text-ink-2">
            <AsteriskGlyph index={1} />
            <span>Worked for {formatLongDuration(state.elapsedMs ?? 0)}</span>
            {gauge}
          </div>
        ) : gauge ? (
          // the inline receipt is already visible: don't repeat the glyph or phrase — just the gauge
          <div className="mt-2 flex items-center text-sm text-ink-2">{gauge}</div>
        ) : null}
        <ExternalQueue queue={queue} />
      </div>
    )
  }

  const glyphIndex = reducedMotion ? 0 : tick % GLYPH_RAYS.length

  const footerParts: string[] = []
  if ((state.elapsedMs ?? 0) >= HIDE_ELAPSED_MS) footerParts.push(formatLongDuration(state.elapsedMs ?? 0))
  if (state.tokens !== null) footerParts.push(`↓ ${formatTokens(state.tokens)} tokens`)

  return (
    <div>
      <div className="mt-2 flex items-center gap-2 text-sm text-ink-2">
        {/* while live, the glyph and phrase share the StatusLine's
            terracotta (orange ONLY for what's live — the done "Worked for" stays in ink-2). */}
        <AsteriskGlyph index={glyphIndex} className={state.done ? '' : 'text-terracotta'} />
        {/* claude.ai's shimmer while the session is live */}
        <span className={state.done ? '' : 'live-phase'}>{state.phase}</span>
        {footerParts.length > 0 ? <span className="font-mono text-xs">({footerParts.join(' · ')})</span> : null}
        {pct !== null ? <span className={`font-mono text-xs ${contextColorClass(pct)}`.trim()}>{pct}% context</span> : null}
      </div>
      {/* the footer is a pulse, not a log: totals per tool on ONE line
          ("Bash ×44 · Edit ×22 · Read ×14 · +2 more"); the sequence lives
          in the transcript's chips */}
      {state.tools && state.tools.length > 0 ? (
        <p className="mt-1 truncate font-mono text-[11px] text-ink-2" title={summarizeTools(state.tools, Infinity)}>
          {summarizeTools(state.tools)}
        </p>
      ) : null}
      <ExternalQueue queue={queue} />
    </div>
  )
}
