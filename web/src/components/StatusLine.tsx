// StatusLine.tsx — the live activity tree for the turn in progress, in the
// Claude Code style:
//   ❯ ● main
//     ◯ general-purpose  Reading Composer and Chat.tsx tests    1m 27s · ↓ 79.2k tokens
// A header with NO counter (a counter next to a few-second "Thinking…"
// looks odd) + one row per OPEN step or the last 3 CLOSED, each with its
// own elapsed (only past HIDE_ELAPSED_MS) + a footer with the total
// elapsed (same threshold), output tokens (if any) and the Esc hint (the
// real handler lives in Chat.tsx, at the window level).
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Square } from 'lucide-react'
import { useStore } from '../store'
import type { ChatTurnState, ActiveStep, TurnReceipt } from '../store'
import { contextColorClass, contextPct } from '../lib/context'
import { verbForTurn } from '../lib/thinking-verbs'
import { useHarness } from '../lib/harnesses'
import { Asterisk } from './Glyph'

const HIDE_ELAPSED_MS = 5000

// no fixed "Reasoning…" — waiting phases use a different verb per turn
// (stable within the turn, see thinking-verbs.ts); informative phases
// ("Writing…", "Running <tool>…") are left alone: they say something real.
export function phaseLabel(a: ChatTurnState): string {
  switch (a.lastEvent) {
    case 'delta':
      return 'Writing…'
    case 'tool': {
      const lastTool = a.tools[a.tools.length - 1] ?? 'tool'
      return `Running ${lastTool}…`
    }
    case 'thinking':
    case 'init':
    default:
      return `${verbForTurn(a.turnId)}…`
  }
}

// exported — ContextColumn.tsx reuses the same mm:ss format for a plan task's duration.
export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// below 1000 the integer shows as-is — "1.0k"/"0.1k" for small values
// looked odd and lost precision.
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(1)}k`
}

// a duration with letter suffixes ("1m 26s" / "1h 11m 37s") — the format
// for closing phrases: turn receipts (here), the external monitor
// (ExternalStatus) and the CLI's historical receipts (Turn.tsx).
export function formatLongDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

// ReceiptLine — the turn's receipt: when the turn finishes, the status
// line doesn't disappear — it stays as "✻ Brewed for 1m 26s · ↓ 79.2k
// tokens" at the end of the turn, dimmed (ink-2, ✻ included: orange is
// ONLY for what's live). `stillRunning` is the HONEST count of background
// work still alive (context subagents with no endedAt + this session's
// keep automations with a running run) — Transcript computes it from real
// data, never invented here.
export function ReceiptLine({ receipt, stillRunning = 0 }: { receipt: TurnReceipt; stillRunning?: number }) {
  // a failed turn: "Failed after X · <error>" in alert tone — the turn's
  // durable trace in the conversation (the ErrorStrip toast is gone in 8s).
  // Never the success verb: a failed turn didn't "brew".
  if (receipt.error !== undefined) {
    return (
      <div className="flex min-w-0 items-center gap-2 text-sm text-terracotta">
        <Asterisk />
        <span className="shrink-0">Failed after {formatLongDuration(receipt.elapsedMs)}</span>
        <span aria-hidden="true">·</span>
        <span className="min-w-0 truncate text-ink-2" title={receipt.error}>
          {receipt.error}
        </span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 text-sm text-ink-2">
      <Asterisk />
      <span>
        {receipt.verb} for {formatLongDuration(receipt.elapsedMs)}
      </span>
      {receipt.outputTokens !== undefined ? (
        <>
          <span aria-hidden="true">·</span>
          <span className="font-mono text-xs">↓ {formatTokens(receipt.outputTokens)} tokens</span>
        </>
      ) : null}
      {stillRunning > 0 ? (
        <>
          <span aria-hidden="true">·</span>
          <span>{stillRunning} still running</span>
        </>
      ) : null}
    </div>
  )
}

// steps to paint: consecutive calls of the same tool fold into ONE row
// ("Bash ×4", with the latest call's description and elapsed), then the
// last 4 rows — the open one, if any, is always the last.
export interface StepGroup {
  step: ActiveStep // the latest call of the run: its desc, start, end
  count: number
}

export function groupSteps(steps: ActiveStep[] | undefined, max = 4): StepGroup[] {
  if (!steps || steps.length === 0) return []
  const groups: StepGroup[] = []
  for (const p of steps) {
    const last = groups[groups.length - 1]
    if (last && last.step.name === p.name) groups[groups.length - 1] = { step: { ...p, desc: p.desc ?? last.step.desc }, count: last.count + 1 }
    else groups.push({ step: p, count: 1 })
  }
  return groups.slice(-max)
}

function StepRow({ group, now }: { group: StepGroup; now: number }) {
  const { step, count } = group
  const open = step.end === null
  const elapsedMs = (step.end ?? now) - step.start
  const showElapsed = elapsedMs >= HIDE_ELAPSED_MS
  return (
    <div className={`flex items-center gap-2 pl-5 text-sm text-ink-2 ${open ? '' : 'opacity-50'}`}>
      <span aria-hidden="true">◯</span>
      <span className="shrink-0">
        {step.name}
        {count > 1 ? <span className="ml-1 font-mono text-[11px] opacity-70">×{count}</span> : null}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs opacity-80">{step.desc ?? ''}</span>
      {showElapsed ? <span className="shrink-0 font-mono text-xs text-ink-2">{formatElapsed(elapsedMs)}</span> : null}
    </div>
  )
}

// a compact ASCII bar for the mini plan line under the live status —
// "▬▬▬░░" with 5 positions, rounded to the nearest slot.
function asciiBar(pct: number, len = 5): string {
  const filled = Math.max(0, Math.min(len, Math.round((pct / 100) * len)))
  return '▬'.repeat(filled) + '░'.repeat(len - filled)
}

// a mini line under the live status — "Checklist d/t ▬▬░ <in-progress task> · N
// subagents". From lg up it is a button that opens the context column; below
// lg the column does not exist (ContextColumn.tsx renders from lg), so the
// same content is plain text — what leads nowhere is not a button. Only
// painted if there's a plan in the open session's `context`.
function MiniPlanLine() {
  const context = useStore((s) => s.detail?.context)
  const contextOpen = useStore((s) => s.contextOpen)
  const plan = context?.plan
  if (!plan) return null
  const pct = plan.total > 0 ? Math.round((plan.done / plan.total) * 100) : 0
  const inProgress = plan.tasks.find((t) => t.status === 'in_progress')
  const agentCount = context?.agents.length ?? 0

  function openContext(): void {
    if (!useStore.getState().contextOpen) useStore.getState().toggleContext()
  }

  const body = (
    <>
      {/* Claude Code's own checklist (TaskCreate, Ctrl+T) — never «Plan», never
          «Tasks»: those are Silos' */}
      <span title="Claude Code's checklist">
        Checklist {plan.done}/{plan.total}
      </span>
      <span className="font-mono" aria-hidden="true">
        {asciiBar(pct)}
      </span>
      {inProgress ? <span className="min-w-0 truncate">{inProgress.subject}</span> : null}
      {agentCount > 0 ? <span>· {agentCount} subagents</span> : null}
    </>
  )
  return (
    <>
      <button
        type="button"
        onClick={openContext}
        aria-expanded={contextOpen}
        className="hidden items-center gap-1.5 pl-5 text-left text-[11px] text-ink-2 hover:text-terracotta lg:flex"
      >
        {body}
      </button>
      <div className="flex items-center gap-1.5 pl-5 text-[11px] text-ink-2 lg:hidden">{body}</div>
    </>
  )
}

export function StatusLine() {
  const active = useStore((s) => s.active)
  const cancel = useStore((s) => s.cancel)
  // the open conversation's harness — an engine that reports no window size
  // (OpenCode) would have its % measured against a Claude window: no gauge
  // unless its descriptor says the window is known.
  const harness = useStore((s) => s.detail?.meta.harness)
  const contextPercent = useHarness(harness).ui.contextPercent
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  if (!active) return null

  // the glyph is Claude Code's ✻, in terracotta — the house's action/live
  // color. This is NOT the agent-emoji-color experiment (agent-color.ts
  // isn't used here; the agent's identity comes from the seal and the
  // band). The widget also doesn't repeat the agent's name — we're
  // already inside its conversation, we know.
  const totalElapsedMs = now - (active.startedAt ?? now)
  const showTotalElapsed = totalElapsedMs >= HIDE_ELAPSED_MS
  const steps = groupSteps(active.steps)

  const footerParts: ReactNode[] = []
  if (showTotalElapsed)
    footerParts.push(
      <span key="elapsed" className="font-mono">
        {formatElapsed(totalElapsedMs)}
      </span>,
    )
  if (active.outputTokens !== undefined)
    footerParts.push(
      <span key="tokens" className="font-mono">
        ↓ {formatTokens(active.outputTokens)} tokens
      </span>,
    )
  // a context % gauge next to the tokens — pass the turn's effective model
  // (active.requested.model, resolved from the agent + overrides) so the
  // window is right: Claude-5 models are 1M, not the 200k default. Without it
  // the live gauge over-read up to 5× ("100% context" at ~20%) on fable/opus/
  // sonnet-5, even though the persisted ExternalStatus view was already correct.
  if (active.contextTokens !== undefined && contextPercent) {
    const pct = contextPct(active.contextTokens, active.requested?.model)
    footerParts.push(
      <span key="context" className={`font-mono ${contextColorClass(pct)}`.trim()}>
        {pct}% context
      </span>,
    )
  }
  footerParts.push(<span key="hint">esc to interrupt</span>)

  return (
    <div className="mt-2 flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Asterisk className="glyph-live text-terracotta" />
        <span className="live-phase text-sm">{phaseLabel(active)}</span>
        <button
          type="button"
          aria-label="stop"
          onClick={() => void cancel()}
          className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-terracotta text-on-terracotta hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40"
        >
          <Square size={12} fill="currentColor" />
        </button>
      </div>

      {steps.map((g, i) => (
        <StepRow key={`${g.step.name}-${g.step.start}-${i}`} group={g} now={now} />
      ))}

      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 pl-5 text-[11px] text-ink-2">
        {footerParts.map((part, i) => (
          <span key={i} className="flex items-center gap-1.5">
            {i > 0 ? (
              <span aria-hidden="true" className="text-ink-2">
                ·
              </span>
            ) : null}
            {part}
          </span>
        ))}
      </div>

      <MiniPlanLine />
    </div>
  )
}
