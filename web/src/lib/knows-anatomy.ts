// knows-anatomy.ts — the small pure helpers every Knows surface shares
// (the column, the agent page's tabs, the project's, the library): the one
// ≈ tokens approximation, the memory index and notes of a folder, a note's
// title and date, and the stretch of time it falls in. What a conversation
// starts with, by owner, is lib/starts-with.ts.
import type { MemoryFileInfo, MemoryLayers } from './types'

/** ≈ tokens for a character count — the one approximation, said as one. */
export function approxTokens(chars: number): string {
  const t = chars / 4
  if (t < 1000) return `${Math.max(1, Math.round(t / 10) * 10)}`
  return `${(t / 1000).toFixed(t < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`
}

/** The memory index entry (auto layer, type 'index'), if the folder has one. */
export function memoryIndex(layers: MemoryLayers | null): MemoryFileInfo | null {
  return layers?.autoMemory.find((f) => f.type === 'index') ?? null
}

/** When a note was written: what it says (metadata.modified), else its mtime. */
export const writtenAt = (f: MemoryFileInfo): number => f.writtenAt ?? f.mtime

/** The auto layer's notes — everything but the index. */
export function memoryNotes(layers: MemoryLayers | null): MemoryFileInfo[] {
  return layers ? layers.autoMemory.filter((f) => f.type !== 'index') : []
}

// A note's file name is a slug ("project_core_xiaomi_fleet_exhausted_2026_10_07"):
// said as words — the type prefix and a trailing date dropped (both are
// shown on their own), separators as spaces, first letter up.
export function noteTitle(name: string): string {
  const t = name
    .replace(/\.md$/, '')
    .replace(/^(project|feedback|reference|user)[_-]/i, '')
    .replace(/[_-]?(19|20)\d{2}[_-]\d{2}([_-]\d{2})?$/, '')
    .replace(/[_-]+/g, ' ')
    .trim()
  return t ? t[0]!.toUpperCase() + t.slice(1) : name
}

export type Era = 'today' | 'week' | 'month' | 'earlier'
export const ERA_LABEL: Record<Era, string> = { today: 'Today', week: 'This week', month: 'This month', earlier: 'Earlier' }

/** Which stretch of time an mtime falls in, from `now` back. */
export function eraOf(mtime: number, now: number): Era {
  const d = new Date(now)
  const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  if (mtime >= startOfDay) return 'today'
  if (mtime >= startOfDay - 6 * 86_400_000) return 'week'
  if (mtime >= startOfDay - 29 * 86_400_000) return 'month'
  return 'earlier'
}
