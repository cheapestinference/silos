// ToolChip.tsx — a chip for one tool call inside an assistant turn. If it
// carries detail (ToolUseDetail) it's clickable and unfolds input/result;
// if we only have the name (streaming, or turns with no detail) it's a mute chip.
import { useState } from 'react'
import { Image as ImageIcon } from 'lucide-react'
import type { ToolUseDetail } from '../lib/types'
import { ToolThumbnail } from './MediaImage'

function isSkill(tool: ToolUseDetail | string): boolean {
  if (typeof tool === 'string') return tool.startsWith('skill:')
  return tool.skill !== null
}

// SendMessage (an outgoing message to another session/subagent) shows its
// DESTINATION right on the chip — "→ to <to>" — the same way skills show
// their name instead of the generic "Skill". Only with detail (the input
// arrives as a JSON string, capped at 2000 — `to` sits at the start, so it
// never falls outside the cap); while streaming (name only) it stays
// "SendMessage" like any other tool. Exported: ToolStreak reuses the same label
// in its collapsed preview.
// An MCP tool's wire name is mcp__<server>__<tool> (same split as the server's
// tools aggregate) — render it readably as "<server> · <tool>" instead of the
// raw underscored string. The server's plugin prefix (claude_ai_, plugin_…) is
// noise, so show its last segment (Gmail, slack, etherscan).
export function prettyToolName(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  if (!m) return name
  const server = m[1]!.split('_').pop() ?? m[1]!
  return `${server} · ${m[2]}`
}

export function toolLabel(tool: ToolUseDetail | string): string {
  if (typeof tool === 'string') return tool.startsWith('skill:') ? tool.slice('skill:'.length) : prettyToolName(tool)
  if (tool.skill) return tool.skill
  if (tool.name === 'SendMessage') {
    try {
      const input = JSON.parse(tool.input) as { to?: unknown }
      if (typeof input.to === 'string' && input.to.trim() !== '') return `→ to ${input.to}`
    } catch {
      /* truncated/non-JSON input: falls back to the bare name */
    }
  }
  return prettyToolName(tool.name)
}

// Consecutive calls that read the same (same chip label) fold into ONE run:
// "Bash ×3" instead of "Bash Bash Bash". Only CONSECUTIVE ones — the order of
// what the agent did stays readable (Read, Bash ×2, Read keeps both Reads).
export interface ToolRun<T> {
  label: string
  items: T[]
}

export function groupToolRuns<T extends ToolUseDetail | string>(chips: readonly T[]): ToolRun<T>[] {
  const runs: ToolRun<T>[] = []
  for (const c of chips) {
    const label = toolLabel(c)
    const last = runs[runs.length - 1]
    if (last && last.label === label) last.items.push(c)
    else runs.push({ label, items: [c] })
  }
  return runs
}

// A run of several calls: one chip "Bash ×3" that unfolds into each call's
// own chip (each still opens its input/result). A failure anywhere in the
// run keeps the red mark on the folded chip — it must not hide behind ×3.
function ToolRunChip({ run }: { run: ToolRun<ToolUseDetail | string> }) {
  const [open, setOpen] = useState(false)
  const first = run.items[0]!
  const skill = isSkill(first)
  const failed = run.items.some((c) => typeof c !== 'string' && c.isError === true)
  const hasImage = run.items.some((c) => typeof c !== 'string' && (c.images?.length ?? 0) > 0)
  return (
    <div className="inline-flex flex-col">
      <button
        type="button"
        data-skill={skill ? 'true' : undefined}
        data-error={failed ? 'true' : undefined}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors duration-150 ${
          failed ? 'border-[color:var(--health-red)] text-[color:var(--health-red)]' : skill ? 'border-terracotta text-terracotta' : 'border-line text-ink-2'
        }`}
      >
        {failed ? <span aria-label="failed">⚠</span> : null}
        {run.label}
        <span className="font-mono text-[10px] opacity-70">×{run.items.length}</span>
        {hasImage ? <ImageIcon size={11} aria-label="has image" /> : null}
      </button>
      {open ? (
        <div className="mt-1 flex flex-wrap items-start gap-1.5 pl-2">
          {run.items.map((c, i) => (
            <ToolChip key={i} tool={c} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

// A row of chips with consecutive repeats folded ("Bash ×3"). Every place
// that paints a list of tool calls goes through here.
export function ToolChipRow({ chips, className }: { chips: readonly (ToolUseDetail | string)[]; className?: string }) {
  return (
    <div className={`flex flex-wrap items-start gap-1.5 ${className ?? ''}`}>
      {groupToolRuns(chips).map((run, i) =>
        run.items.length === 1 ? <ToolChip key={`${run.label}-${i}`} tool={run.items[0]!} /> : <ToolRunChip key={`${run.label}-${i}`} run={run} />,
      )}
    </div>
  )
}

export function ToolChip({ tool }: { tool: ToolUseDetail | string }) {
  const [open, setOpen] = useState(false)
  const skill = isSkill(tool)
  const detail = typeof tool === 'string' ? null : tool
  const clickable = detail !== null
  const isError = detail?.isError === true // the tool call FAILED — scannable at a glance

  return (
    <div className="inline-flex flex-col">
      <button
        type="button"
        data-skill={skill ? 'true' : undefined}
        data-error={isError ? 'true' : undefined}
        aria-expanded={clickable ? open : undefined}
        onClick={clickable ? () => setOpen((v) => !v) : undefined}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors duration-150 ${
          isError ? 'border-[color:var(--health-red)] text-[color:var(--health-red)]' : skill ? 'border-terracotta text-terracotta' : 'border-line text-ink-2'
        } ${clickable ? 'cursor-pointer' : 'cursor-default'}`}
      >
        {isError ? <span aria-label="failed">⚠</span> : null}
        {toolLabel(tool)}
        {/* multimedia: the chip flags that its result carries an image —
            without the glyph, a valuable screenshot would be buried behind
            a click with no hint at all */}
        {detail?.images && detail.images.length > 0 ? <ImageIcon size={11} aria-label="has image" /> : null}
      </button>
      {clickable && open ? (
        <div className="mt-1 flex flex-col gap-1">
          <pre className="max-h-56 overflow-auto rounded bg-panel p-2 font-mono text-xs whitespace-pre-wrap">{detail.input}</pre>
          {/* multimedia: thumbnails from the tool_result (a Read of a PNG,
              a screenshot…) — lazy, click opens MediaScope's lightbox */}
          {detail.images && detail.images.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {detail.images.map((im) => (
                <ToolThumbnail key={im.ref} img={im} />
              ))}
            </div>
          ) : null}
          {/* with an image and no text, "(no result)" would lie: the
              result IS the image above */}
          {detail.result || !detail.images?.length ? (
            <pre
              className={`max-h-56 overflow-auto rounded p-2 font-mono text-xs whitespace-pre-wrap ${isError ? 'bg-[color:var(--health-red)]/10 text-[color:var(--health-red)]' : 'bg-panel'}`}
            >
              {detail.result ?? '(no result)'}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// tool steps used to show up inconsistently — sometimes a chip row that
// wrapped to several lines, sometimes collapsed behind ToolStreak's counter
// (>3). Unified into ONE look: up to STEPS_THRESHOLD the chips go inline;
// above it, a DISCREET single-line COUNTER ("⚙ N steps") that unfolds the
// full chips on click. The same threshold and the same summary in ToolStreak
// (a multi-turn streak) and in ToolGroup (one turn with text + tools).
export const STEPS_THRESHOLD = 3

// A discreet one-line summary (nowrap: never breaks across two lines).
export function StepsSummary({ n, suffix }: { n: number; suffix?: string }) {
  return (
    <span className="font-mono text-xs whitespace-nowrap">
      ⚙ {n} steps{suffix ?? ''}
    </span>
  )
}

// ONE turn's tool group: inline if there are few, a collapsible counter if
// there are many. The summary shows the first name as a hint, truncated to one line.
export function ToolGroup({ chips }: { chips: (ToolUseDetail | string)[] }) {
  if (chips.length === 0) return null
  // the threshold counts what is painted (runs), not calls: four Bash in a
  // row is ONE chip "Bash ×4", no reason to fold it behind a counter.
  if (groupToolRuns(chips).length <= STEPS_THRESHOLD) return <ToolChipRow chips={chips} className="mt-2" />
  return (
    <details className="mt-2">
      <summary className="inline-flex max-w-full cursor-pointer items-center gap-1.5 text-ink-2 hover:text-terracotta">
        {/* just the counter — no hint of the first name, whoever wants the
            detail can unfold it (the same criterion as ToolStreak). */}
        <StepsSummary n={chips.length} />
      </summary>
      <ToolChipRow chips={chips} className="mt-2 pl-4" />
    </details>
  )
}
