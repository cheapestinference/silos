// tool-summary.ts — the one-line breakdown of a streak of tool calls:
// "Read 3 · Edit 1 · Bash 1" instead of "4 steps" (a count
// says nothing about WHAT happened). Names keep the chip's own label
// (skills by name, SendMessage by destination), most frequent first, ties
// in order of first appearance; beyond MAX_NAMES the rest folds into
// "+N more".
import type { ToolUseDetail } from './types'
import { toolLabel } from '../components/ToolChip'

export const MAX_NAMES = 4

export function summarizeTools(chips: readonly (ToolUseDetail | string)[]): string {
  const counts = new Map<string, number>()
  for (const c of chips) {
    const label = toolLabel(c)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const shown = ordered.slice(0, MAX_NAMES).map(([name, n]) => (n > 1 ? `${name} ${n}` : name))
  const rest = ordered.slice(MAX_NAMES).reduce((acc, [, n]) => acc + n, 0)
  if (rest > 0) shown.push(`+${rest} more`)
  return shown.join(' · ')
}
