// uses.ts — the words and the one scale behind Map › Uses (UsesView.tsx).
// Pure, so the matrix's voice is tested on its own: what each axis is
// called, what a measure reads as, how strong a cell's tint is.
import type { UsesAxis, UsesColKind, UsesRowKind, UsesView } from './types'

export const ROW_KINDS: readonly { id: UsesRowKind; label: string; noun: [string, string] }[] = [
  { id: 'agent', label: 'Agents', noun: ['agent', 'agents'] },
  { id: 'project', label: 'Projects', noun: ['project', 'projects'] },
  { id: 'conversation', label: 'Conversations', noun: ['conversation', 'conversations'] },
  { id: 'automation', label: 'Automations', noun: ['automation', 'automations'] },
]
export const COL_KINDS: readonly { id: UsesColKind; label: string; noun: [string, string] }[] = [
  { id: 'model', label: 'Models', noun: ['model', 'models'] },
  { id: 'file', label: 'Files', noun: ['file', 'files'] },
  { id: 'tool', label: 'Tools', noun: ['tool', 'tools'] },
  { id: 'mcp', label: 'MCP', noun: ['MCP server', 'MCP servers'] },
  { id: 'skill', label: 'Skills', noun: ['skill', 'skills'] },
  { id: 'provider', label: 'Accounts', noun: ['account', 'accounts'] },
  { id: 'secret', label: 'Secrets', noun: ['secret', 'secrets'] },
]
export const WINDOWS: readonly { id: string; label: string; words: string }[] = [
  { id: '7', label: '7d', words: 'in the last 7 days' },
  { id: '30', label: '30d', words: 'in the last 30 days' },
  { id: 'all', label: 'all', words: 'all time' },
]

export const DEFAULT_ROWS: UsesRowKind = 'agent'
export const DEFAULT_COLS: UsesColKind = 'model'
export const DEFAULT_SINCE = '30'

export function plural(n: number, noun: [string, string]): string {
  return `${n.toLocaleString()} ${n === 1 ? noun[0] : noun[1]}`
}

// 1234 → "1.2k", 4_100_000 → "4.1M" — a count that fits a 2.5rem cell
export function compact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`
}

// what one conversation's share of a cell reads as — the column kind's own
// measure in plain words; null when the kind has none (skills, accounts)
export function measureWords(measure: UsesView['measure'], m: number | undefined, r?: number): string | null {
  if (measure === 'tokens') return m !== undefined ? `${compact(m)} tokens` : null
  if (measure === 'calls') return m !== undefined ? `${m.toLocaleString()} ${m === 1 ? 'call' : 'calls'}` : null
  if (measure === 'changes') {
    const parts: string[] = []
    if (m) parts.push(`${m} ${m === 1 ? 'change' : 'changes'}`)
    if (r) parts.push(`${r} ${r === 1 ? 'read' : 'reads'}`)
    return parts.length > 0 ? parts.join(' · ') : null
  }
  return null
}

// a cell's tint: the share of the busiest cell, on a square-root scale so
// one huge cell doesn't leave every other one blank — 0 for an empty cell,
// then from a just-visible 0.07 up to 0.42 (one accent, never a rainbow)
export function intensity(n: number, max: number): number {
  if (n <= 0 || max <= 0) return 0
  return 0.07 + 0.35 * Math.sqrt(Math.min(1, n / max))
}

// a column's heading: its label, except a file whose name another shown
// column shares — then its folder's name goes in front (README.md twice
// becomes builder/README.md and silos/README.md), never the whole path
export function columnHeadings(cols: readonly UsesAxis[], kind: UsesColKind): Map<string, string> {
  const out = new Map<string, string>()
  const seen = new Map<string, number>()
  for (const c of cols) seen.set(c.label, (seen.get(c.label) ?? 0) + 1)
  for (const c of cols) {
    const parent = kind === 'file' && c.sub && (seen.get(c.label) ?? 0) > 1 ? c.sub.slice(c.sub.lastIndexOf('/') + 1) : ''
    out.set(c.id, parent ? `${parent}/${c.label}` : c.label)
  }
  return out
}

// the full name a column header shows on hover
export function columnTitle(c: UsesAxis, kind: UsesColKind): string {
  if (!c.sub) return c.label
  return kind === 'file' ? `${c.sub}/${c.label}` : `${c.label} · ${c.sub}`
}
