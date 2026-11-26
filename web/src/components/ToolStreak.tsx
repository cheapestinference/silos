// ToolStreak.tsx — paints a streak of "tools-only" assistant turns
// (grouped by groupTurns) compactly. The threshold lives here: ≤3 chips
// (consecutive repeats fold into one "Bash ×3") → one chip row that wraps; >3 → collapsed behind a <details> with
// a "⚙ N steps · Xm" summary and the first 3 names as a hint, expandable
// to each turn's full chips (ToolChip keeps its own expandables).
// Turns in the streak do NOT lose detail — they're only compacted
// visually, so any grouped turn's thinking still shows.
import type { Turn as TurnType, ToolUseDetail } from '../lib/types'
import { ToolChipRow, STEPS_THRESHOLD, groupToolRuns } from './ToolChip'
import { summarizeTools } from '../lib/tool-summary'
// the same 5s threshold as HIDE_ELAPSED_MS in StatusLine/ExternalStatus —
// a 0-4s streak adds nothing to the collapsed summary ("· 0s" was pure noise).
const HIDE_DURATION_MS = 5000

function chipsFor(t: TurnType): (ToolUseDetail | string)[] {
  return t.toolUses ?? t.tools
}

// a short duration for the collapsed summary — "45s" under a minute, "3m"
// from there (rounded, no precision lost: it's just a hint of how long it took).
function formatShortDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000))
  if (totalSec < 60) return `${totalSec}s`
  return `${Math.round(totalSec / 60)}m`
}

function TurnRow({ t }: { t: TurnType }) {
  const chips = chipsFor(t)
  return (
    <>
      {t.thinking ? (
        <details className="mb-1">
          <summary className="cursor-pointer text-sm text-ink-2 italic">Reasoning…</summary>
          <div className="mt-1 text-sm text-ink-2 whitespace-pre-wrap break-words">{t.thinking}</div>
        </details>
      ) : null}
      {chips.length > 0 ? <ToolChipRow chips={chips} /> : null}
    </>
  )
}

export function ToolStreak({ turns, isNew }: { turns: TurnType[]; isNew?: boolean }) {
  const totalTools = turns.reduce((acc, t) => acc + chipsFor(t).length, 0)

  // the threshold counts what is painted: consecutive repeats are one chip
  if (groupToolRuns(turns.flatMap(chipsFor)).length <= STEPS_THRESHOLD) {
    // few steps: ALL of the streak's chips in ONE row (not one per turn) —
    // several consecutive tool-only turns read as a single compact group,
    // not a vertical list. Thinking (rare in tool-only) is kept above.
    const chips = turns.flatMap(chipsFor)
    const withThinking = turns.filter((t) => t.thinking)
    return (
      <div className={isNew ? 'turn-appear' : ''}>
        {withThinking.map((t) => (
          <details key={t.index} className="mb-1">
            <summary className="cursor-pointer text-sm text-ink-2 italic">Reasoning…</summary>
            <div className="mt-1 whitespace-pre-wrap break-words text-sm text-ink-2">{t.thinking}</div>
          </details>
        ))}
        <ToolChipRow chips={chips} />
      </div>
    )
  }

  const firstTs = turns[0]?.ts ?? null
  const lastTs = turns[turns.length - 1]?.ts ?? null
  let durationSuffix = ''
  if (firstTs && lastTs) {
    const ms = Date.parse(lastTs) - Date.parse(firstTs)
    if (Number.isFinite(ms) && ms >= HIDE_DURATION_MS) durationSuffix = ` — ${formatShortDuration(ms)}`
  }
  // one readable line — WHAT happened, not how many times: "Read ×3 · Edit
  // · Bash — 20s" (lib/tool-summary.ts). Click-through keeps every chip.
  return (
    <details className={`w-full ${isNew ? 'turn-appear' : ''}`}>
      <summary aria-label={`${totalTools} steps`} className="inline-flex max-w-full cursor-pointer items-center gap-1.5 text-ink-2 hover:text-terracotta">
        <span className="truncate font-mono text-xs">
          {summarizeTools(turns.flatMap(chipsFor))}
          {durationSuffix}
        </span>
      </summary>
      <div className="mt-2 flex flex-col gap-2 pl-4">
        {turns.map((t) => (
          <TurnRow key={t.index} t={t} />
        ))}
      </div>
    </details>
  )
}
