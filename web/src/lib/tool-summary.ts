// tool-summary.ts — the one-line breakdown of a streak of tool calls:
// "Read ×3 · Edit · Bash" instead of "4 steps" (a count
// says nothing about WHAT happened). Names keep the chip's own label
// (skills by name, SendMessage by destination), most frequent first, ties
// in order of first appearance; beyond MAX_NAMES the rest folds into
// "+N more".
import type { ToolUseDetail } from './types'
import { toolLabel } from '../components/ToolChip'

export const MAX_NAMES = 4

export function summarizeTools(chips: readonly (ToolUseDetail | string)[], maxNames: number = MAX_NAMES): string {
  const counts = new Map<string, number>()
  for (const c of chips) {
    const label = toolLabel(c)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const shown = ordered.slice(0, maxNames).map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
  const rest = ordered.slice(maxNames).reduce((acc, [, n]) => acc + n, 0)
  if (rest > 0) shown.push(`+${rest} more`)
  return shown.join(' · ')
}

// The readable line of a tool call's input, for the live activity tree:
// what the agent said it does (description), else what it runs or touches.
// An empty or missing input is NO description (null) — the engine opens a
// tool with `{}` before its input streams in, and "Bash {}" says nothing.
const DESC_KEYS = ['description', 'command', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt', 'skill'] as const

export function stepDesc(input: string | null | undefined): string | null {
  const raw = input?.trim() ?? ''
  if (raw === '' || raw === '{}' || raw === 'null') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw // not JSON (truncated, or plain text): show it as it came
  }
  if (typeof parsed !== 'object' || parsed === null) return raw
  const obj = parsed as Record<string, unknown>
  if (Object.keys(obj).length === 0) return null
  for (const k of DESC_KEYS) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim() !== '') return v.trim().split('\n')[0]!
  }
  return null
}
