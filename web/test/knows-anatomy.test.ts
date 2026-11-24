// knows-anatomy.test.ts — the pure Knows helpers (lib/knows-anatomy.ts) and
// what every conversation starts with by OWNER (lib/starts-with.ts; scope
// is the first fact): you · Silos · the project · the agent,
// measured in characters and said as ≈ tokens.
import { describe, expect, it } from 'vitest'
import { approxTokens, eraOf, memoryIndex, memoryNotes, noteTitle, writtenAt } from '../src/lib/knows-anatomy'
import type { MemoryFileInfo, MemoryLayers } from '../src/lib/types'

const f = (over: Partial<MemoryFileInfo> & { path: string }): MemoryFileInfo => ({
  name: over.path.slice(over.path.lastIndexOf('/') + 1),
  scope: 'auto',
  mtime: 0,
  exists: true,
  ...over,
})

function layers(over: Partial<MemoryLayers> = {}): MemoryLayers {
  return {
    global: f({ path: '/home/.claude/CLAUDE.md', scope: 'global', exists: false }),
    project: null,
    autoMemory: [],
    agent: null,
    ...over,
  }
}

describe('memory helpers', () => {
  it('memoryIndex finds the index entry; memoryNotes is everything else in the auto layer', () => {
    const idx = f({ path: '/m/MEMORY.md', type: 'index' })
    const mem = layers({ autoMemory: [idx, f({ path: '/m/a.md' }), f({ path: '/m/b.md' })] })
    expect(memoryIndex(mem)).toBe(idx)
    expect(memoryNotes(mem).map((n) => n.path)).toEqual(['/m/a.md', '/m/b.md'])
    expect(memoryIndex(null)).toBeNull()
    expect(memoryNotes(null)).toEqual([])
  })
})

describe('helpers', () => {
  it('approxTokens: chars ÷ 4, tens under 1k, one decimal under 10k, whole k above', () => {
    expect(approxTokens(0)).toBe('1') // never "0 tokens" for something present
    expect(approxTokens(40)).toBe('10')
    expect(approxTokens(1000)).toBe('250')
    expect(approxTokens(4000)).toBe('1k')
    expect(approxTokens(5000)).toBe('1.3k')
    expect(approxTokens(8000)).toBe('2k')
    expect(approxTokens(60_000)).toBe('15k')
  })

  it('noteTitle: the slug said as words — type prefix and trailing date dropped', () => {
    expect(noteTitle('project_core_xiaomi_fleet_exhausted_2026_10_07.md')).toBe('Core xiaomi fleet exhausted')
    expect(noteTitle('feedback-own-silos-operations.md')).toBe('Own silos operations')
    expect(noteTitle('deploy-notes.md')).toBe('Deploy notes')
    // nothing left once prefix and date go → the name as is, never an empty title
    expect(noteTitle('reference_2026-10-27.md')).toBe('reference_2026-10-27.md')
    expect(noteTitle('.md')).toBe('.md')
  })

  it('eraOf: today · this week · this month · earlier, counted from the start of today', () => {
    const now = new Date(2026, 10, 2, 15, 0).getTime()
    const day = 86_400_000
    const startOfDay = new Date(2026, 10, 2).getTime()
    expect(eraOf(startOfDay, now)).toBe('today')
    expect(eraOf(startOfDay - 1, now)).toBe('week')
    expect(eraOf(startOfDay - 6 * day, now)).toBe('week')
    expect(eraOf(startOfDay - 6 * day - 1, now)).toBe('month')
    expect(eraOf(startOfDay - 29 * day, now)).toBe('month')
    expect(eraOf(startOfDay - 29 * day - 1, now)).toBe('earlier')
  })

  it('writtenAt: the note’s own date first, else its mtime', () => {
    expect(writtenAt(f({ path: '/a', mtime: 9, writtenAt: 3 }))).toBe(3)
    expect(writtenAt(f({ path: '/a', mtime: 9 }))).toBe(9)
  })
})
