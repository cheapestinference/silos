// The daily digest band on Home: the server's counts
// in plain words — three blocks, a summed band titled by where it starts,
// a Seen that posts the newest date. Never a block with nothing to say.
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DigestBand } from '../src/components/home/DigestBand'
import { dayWord, digestWords } from '../src/lib/digest'
import type { DigestBand as Band } from '../src/lib/types'

const at = (d: number, h: number, m = 0): number => new Date(2026, 9, d, h, m).getTime() // local, Oct 2026
const iso = (ms: number): string => new Date(ms).toISOString()
const NOW = at(31, 9, 15) // Saturday 31 Oct, 09:15
const name = (_id: string, fallback: string): string => fallback

function band(over: Partial<Band> = {}): Band {
  return {
    dates: ['2026-10-31'],
    through: '2026-10-31',
    hour: '08:00',
    from: iso(at(30, 8)),
    to: iso(at(31, 8)),
    waits: { blocking: 1, due: 2, routine: 4, oldest: { at: iso(at(30, 18, 40)), kind: 'ask', voice: 'Builder has a question for you' } },
    happened: {
      conversations: [
        { agentId: 'builder', name: 'Builder', count: 9 },
        { agentId: 'writer', name: 'Writer', count: 5 },
      ],
      runs: [{ agentId: 'support', name: 'Support', runs: 24, acted: 2, noNews: 21, ok: 0, failed: 0, recovered: 1 }],
      planTasksDone: 3,
      silos: [{ silo: 'invoices', siloName: 'Invoices', to: 'paid', label: 'paid', count: 3 }],
    },
    coming: [{ silo: 'invoices', siloName: 'Invoices', kind: 'invoice', count: 4, firstDue: '2026-11-03' }],
    ...over,
  }
}

describe('digestWords', () => {
  it('a summed band is titled by where it starts («Since Thursday 08:00»)', () => {
    const w = digestWords(band({ dates: ['2026-10-29', '2026-10-30', '2026-10-31'], from: iso(at(29, 8)) }), NOW, name)
    expect(w.title).toBe('Since Thursday 08:00')
    expect(w.since).toBeNull()
  })

  it('quiet mornings say so; no silo with a due date means no coming block at all', () => {
    const w = digestWords(
      band({
        waits: { blocking: 0, due: 0, routine: 2, oldest: null },
        happened: { conversations: [], runs: [], planTasksDone: null, silos: [] },
        coming: null,
      }),
      NOW,
      name,
    )
    expect(w.happened).toHaveLength(1)
    expect(w.coming).toBeNull()
    expect(digestWords(band({ coming: [] }), NOW, name).coming).toHaveLength(1)
  })

  it('names follow the agent as it is called now', () => {
    const w = digestWords(band(), NOW, (id, fb) => (id === 'builder' ? 'Chief' : fb))
    expect(w.happened[0]).toContain('Chief')
    expect(w.happened[0]).not.toContain('Builder')
  })

  // HISTORY (a saved digest): messages worked in conversations of their own
  // are their own line, never «conversations finished» — and never «urgent»
  it('messages worked (a saved digest): one agent, or several with their counts', () => {
    const one = digestWords(
      band({ happened: { conversations: [], messages: [{ agentId: 'builder', name: 'Builder', count: 2 }], runs: [], planTasksDone: null, silos: [] } }),
      NOW,
      name,
    )
    expect(one.happened).toHaveLength(1)
    expect(one.happened[0]).toContain('Builder')
    expect(one.happened[0]).toContain('2')
    expect(one.happened[0]).not.toMatch(/finished|urgent/)
    const many = digestWords(
      band({
        happened: {
          conversations: [],
          messages: [
            { agentId: 'builder', name: 'Builder', count: 2 },
            { agentId: 'finance', name: 'Finance', count: 1 },
          ],
          runs: [],
          planTasksDone: null,
          silos: [],
        },
      }),
      NOW,
      name,
    )
    expect(many.happened).toHaveLength(1)
    for (const part of ['3', 'Builder 2', 'Finance 1']) expect(many.happened[0]).toContain(part)
  })

  it('dayWord: today · yesterday · weekday · date', () => {
    expect(dayWord(at(31, 1), NOW)).toBe('today')
    expect(dayWord(at(30, 23), NOW)).toBe('yesterday')
    expect(dayWord(at(27, 8), NOW)).toBe('Tuesday')
    expect(dayWord(at(12, 8), NOW)).toBe('Oct 12')
  })
})

describe('<DigestBand>', () => {
  it('renders the blocks and Seen calls back', () => {
    const onSeen = vi.fn()
    render(<DigestBand band={band()} now={NOW} nameOf={name} onSeen={onSeen} />)
    const region = screen.getByRole('region', { name: 'Daily digest' })
    expect(region).toHaveTextContent('This morning')
    expect(region).toHaveTextContent('since yesterday 08:00')
    // folded: what happened since; «all» unfolds what waits and what is coming
    expect(region).not.toHaveTextContent('Invoices: 4 invoices due in the next 7 days')
    fireEvent.click(screen.getByRole('button', { name: 'all ›' }))
    expect(region).toHaveTextContent('Invoices: 4 invoices due in the next 7 days')
    expect(region.querySelectorAll('a')).toHaveLength(0) // links nothing
    fireEvent.click(screen.getByRole('button', { name: 'Seen' }))
    expect(onSeen).toHaveBeenCalledOnce()
  })
})

describe('the service worker', () => {
  const sw = readFileSync(join(import.meta.dirname, '..', 'public', 'sw.js'), 'utf8')
  it('handles push and notificationclick only — never fetch, never a cache', () => {
    expect(sw).toMatch(/addEventListener\('push'/)
    expect(sw).toMatch(/addEventListener\('notificationclick'/)
    expect(sw).not.toMatch(/addEventListener\('fetch'/)
    expect(sw).not.toMatch(/caches\./)
    expect(sw).toMatch(/openWindow\('\/'\)/)
  })
})
