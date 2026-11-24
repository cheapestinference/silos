// loads-weight.ts — the measured weight of a Tools row (GET
// /api/folders/:folder/loads/weight): the tokens its parts took at the
// newest measured start in the folder. A plugin weighs its own parts (its
// skill and subagent listing lines, what its start hook added) plus its
// servers'. Nothing measured = no weight, never an estimate. Pure.
import type { FolderLoadsWeight, LoadsRow } from './types'

export interface RowWeight {
  tokens: number
  /** what it is made of, largest first: «Skill listing 820», «files 1.2k» */
  parts: { label: string; tokens: number }[]
}

export function weightOf(row: LoadsRow, rows: LoadsRow[], w: FolderLoadsWeight | null | undefined): RowWeight | null {
  if (!w) return null
  const keys = [row.key, ...(row.kind === 'plugin' ? rows.filter((r) => r.parent === row.key).map((r) => r.key) : [])]
  const parts: RowWeight['parts'] = []
  let tokens = 0
  for (const k of keys) {
    const it = Object.hasOwn(w.items, k) ? w.items[k] : undefined
    if (!it) continue
    tokens += it.tokens
    for (const p of it.parts) parts.push({ label: k === row.key ? (PART_WORD[p.kind] ?? p.label) : p.label, tokens: p.tokens })
  }
  if (tokens <= 0) return null
  return { tokens, parts: parts.filter((p) => p.tokens > 0).sort((a, b) => b.tokens - a.tokens) }
}

const PART_WORD: Record<string, string> = {
  skills: 'skill listing',
  agents: 'subagent listing',
  hook: 'start hook',
  mcp: 'tools and instructions',
}

/** «1.2k» — the size a column shows */
export const shortTokens = (n: number): string => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`)
