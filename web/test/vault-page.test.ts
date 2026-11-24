// vault-page.test.ts — the Vault page's pure derivations: name-groups with
// the REAL reach of every entry (an override is never silent), the loss
// phrase a delete shows, the pulse line, ages, search and the rotation sort.
import { describe, expect, it } from 'vitest'
import type { VaultEntry } from '../src/lib/types'
import {
  vaultGroups,
  audienceOf,
  lossPhrase,
  countsPhrase,
  vaultAge,
  filterGroups,
  sortGroups,
  joinNames,
  installProjects,
  type VaultPageAgent,
} from '../src/lib/vault-page'

const AGENTS: VaultPageAgent[] = [
  { id: 'finance', name: 'Finance', folder: '/home/u/acme' },
  { id: 'builder', name: 'Builder', folder: '/home/u/acme' },
  { id: 'writer', name: 'Writer', folder: '/home/u/silos' },
]

let seq = 0
function e(name: string, scope: VaultEntry['scope'], createdAt = '2026-01-01T00:00:00Z'): VaultEntry {
  seq += 1
  return { id: `id-${seq}`, name, value: '…1234', scope, createdAt }
}

describe('vaultGroups — groups by name, annotated with the real reach', () => {
  it('a lone agents entry reaches exactly its list', () => {
    const [g] = vaultGroups([e('STRIPE_KEY', { type: 'agents', agentIds: ['finance'] })], AGENTS)
    expect(g!.name).toBe('STRIPE_KEY')
    expect(g!.entries).toHaveLength(1)
    expect(g!.entries[0]!.scope).toBe('agent')
    expect(g!.entries[0]!.audience).toBe('Agent · Finance')
    expect(g!.entries[0]!.reaches).toEqual(['Finance'])
    expect(g!.entries[0]!.shadowedFor).toEqual([])
  })

  it('a collision global vs agents: the agents entry wins for its agents, the global says who it loses', () => {
    const global = e('TOKEN', { type: 'global' })
    const mine = e('TOKEN', { type: 'agents', agentIds: ['finance'] })
    const [g] = vaultGroups([global, mine], AGENTS)
    expect(g!.entries).toHaveLength(2)
    // most specific first — the order the page paints the chain in.
    expect(g!.entries[0]!.entry.id).toBe(mine.id)
    expect(g!.entries[0]!.reaches).toEqual(['Finance'])
    expect(g!.entries[1]!.entry.id).toBe(global.id)
    expect(g!.entries[1]!.reaches).toEqual(['Builder', 'Writer'])
    expect(g!.entries[1]!.shadowedFor).toEqual(['Finance'])
  })

  it('within the agents tier the SHORTEST list wins (the server rule, mirrored)', () => {
    const pair = e('K', { type: 'agents', agentIds: ['finance', 'builder'] })
    const solo = e('K', { type: 'agents', agentIds: ['finance'] })
    const [g] = vaultGroups([pair, solo], AGENTS)
    expect(g!.entries[0]!.entry.id).toBe(solo.id)
    expect(g!.entries[0]!.reaches).toEqual(['Finance'])
    expect(g!.entries[1]!.entry.id).toBe(pair.id)
    expect(g!.entries[1]!.reaches).toEqual(['Builder'])
    expect(g!.entries[1]!.shadowedFor).toEqual(['Finance'])
  })

  it('a folder entry nominally covers the agents based there — path boundary respected', () => {
    const [g] = vaultGroups([e('DB_URL', { type: 'folder', folder: '/home/u/acme' })], AGENTS)
    expect(g!.entries[0]!.scope).toBe('project')
    expect(g!.entries[0]!.audience).toBe('Project · acme')
    expect(g!.entries[0]!.reaches).toEqual(['Finance', 'Builder']) // Writer lives elsewhere
    // /home/u/ac must never match /home/u/acme (a prefix, not a parent)
    const [g2] = vaultGroups([e('X', { type: 'folder', folder: '/home/u/ac' })], AGENTS)
    expect(g2!.entries[0]!.reaches).toEqual([])
  })

  it('an agents entry over a folder entry: the agent gets its own even inside the folder', () => {
    const folder = e('API_KEY', { type: 'folder', folder: '/home/u/acme' })
    const own = e('API_KEY', { type: 'agents', agentIds: ['finance'] })
    const [g] = vaultGroups([folder, own], AGENTS)
    expect(g!.entries[0]!.entry.id).toBe(own.id)
    expect(g!.entries[1]!.shadowedFor).toEqual(['Finance'])
    expect(g!.entries[1]!.reaches).toEqual(['Builder'])
  })

  it('groups come out sorted by name', () => {
    const groups = vaultGroups([e('ZEBRA', { type: 'global' }), e('ALPHA', { type: 'global' })], AGENTS)
    expect(groups.map((g) => g.name)).toEqual(['ALPHA', 'ZEBRA'])
  })
})

describe('audience and name joining', () => {
  it('a label, type word first: global → Every agent; unknown agent id falls back to the id', () => {
    expect(audienceOf(e('A', { type: 'global' }), AGENTS)).toBe('Every agent')
    expect(audienceOf(e('B', { type: 'agents', agentIds: ['ghost'] }), AGENTS)).toBe('Agent · ghost')
    expect(audienceOf(e('C', { type: 'agents', agentIds: ['finance', 'ghost'] }), AGENTS)).toMatch(/^Agents · /)
  })
  it('joinNames caps long lists', () => {
    expect(joinNames(['A', 'B'])).toBe('A + B')
    expect(joinNames(['A', 'B', 'C'])).toBe('A + B + C')
    expect(joinNames(['A', 'B', 'C', 'D', 'E'])).toBe('A + B + 3 more')
  })
})

describe('lossPhrase — a delete always names who loses it', () => {
  it('one agent / several agents', () => {
    const [g] = vaultGroups([e('K', { type: 'agents', agentIds: ['finance'] })], AGENTS)
    expect(lossPhrase(g!.entries[0]!)).toContain('Finance')
    const [g2] = vaultGroups([e('K2', { type: 'agents', agentIds: ['finance', 'builder'] })], AGENTS)
    expect(lossPhrase(g2!.entries[0]!)).toContain('Finance')
    expect(lossPhrase(g2!.entries[0]!)).toContain('Builder')
  })
  it('global — honest about agents that keep a more specific copy', () => {
    const [g] = vaultGroups([e('K', { type: 'global' })], AGENTS)
    expect(lossPhrase(g!.entries[0]!)).not.toContain('Finance')
    const [g2] = vaultGroups([e('K2', { type: 'global' }), e('K2', { type: 'agents', agentIds: ['finance'] })], AGENTS)
    const global = g2!.entries.find((v) => v.entry.scope.type === 'global')!
    expect(lossPhrase(global)).toContain('Finance')
  })
  it('folder', () => {
    const [g] = vaultGroups([e('K', { type: 'folder', folder: '/home/u/silos' })], AGENTS)
    expect(lossPhrase(g!.entries[0]!)).toContain('silos')
  })
})

describe('countsPhrase — composed only of real counts', () => {
  it('empty → null; one entry → its count', () => {
    expect(countsPhrase([])).toBeNull()
    expect(countsPhrase([e('A', { type: 'global' })])).toContain('1')
  })
})

describe('vaultAge — coarse, for rotation', () => {
  const now = Date.parse('2026-10-30T12:00:00Z')
  it.each([
    ['2026-10-30T08:00:00Z', 'added today'],
    ['2026-10-25T08:00:00Z', 'added 5d ago'],
    ['2026-10-05T08:00:00Z', 'added 3w ago'],
    ['2026-07-30T08:00:00Z', 'added 3mo ago'],
    ['2024-10-30T08:00:00Z', 'added 2y ago'],
  ])('%s → %s', (createdAt, expected) => {
    expect(vaultAge(createdAt, now)).toBe(expected)
  })
  it('an unknown createdAt → null (nothing invented)', () => {
    expect(vaultAge('', now)).toBeNull()
  })
})

describe('search and sort', () => {
  const groups = vaultGroups(
    [
      e('STRIPE_KEY', { type: 'agents', agentIds: ['finance'] }, '2026-06-01T00:00:00Z'),
      e('RAILWAY_TOKEN', { type: 'global' }, '2026-01-01T00:00:00Z'),
      e('DB_URL', { type: 'folder', folder: '/home/u/silos' }, '2026-09-01T00:00:00Z'),
    ],
    AGENTS,
  )

  it('filters by name, by agent name and by audience text', () => {
    expect(filterGroups(groups, 'stripe').map((g) => g.name)).toEqual(['STRIPE_KEY'])
    expect(filterGroups(groups, 'finance').map((g) => g.name)).toEqual(['STRIPE_KEY'])
    expect(filterGroups(groups, 'silos').map((g) => g.name)).toEqual(['DB_URL'])
    expect(filterGroups(groups, '')).toBe(groups)
  })
  it('oldest-first floats what most needs rotating', () => {
    expect(sortGroups(groups, 'oldest').map((g) => g.name)).toEqual(['RAILWAY_TOKEN', 'STRIPE_KEY', 'DB_URL'])
    expect(sortGroups(groups, 'name')).toBe(groups)
  })
})

describe('installProjects — «everyone» spelled as the projects it reaches (D7)', () => {
  it('names each project once: nested folders are one, a sibling prefix is another, the archived and the desk are none', () => {
    expect(
      installProjects([
        { id: 'builder', folder: '/home/user/acme' },
        { id: 'web', folder: '/home/user/acme/web' },
        { id: 'scribe', folder: '/home/user/acme', folders: ['/home/user/beta'] },
        { id: 'sib', folder: '/home/user/acme-web' },
        { id: 'old', folder: '/home/user/gone', archived: true },
        { id: 'master', folder: '/home/user/desk' },
      ]),
    ).toEqual(['acme', 'acme-web', 'beta'])
  })
  it('a global entry and its delete name them when there are several; one project says every agent', () => {
    const [g] = vaultGroups([e('SENTRY_DSN', { type: 'global' })], AGENTS, ['acme', 'beta'])
    expect(g!.entries[0]!.audience).toBe('Every agent · acme + beta')
    expect(lossPhrase(g!.entries[0]!)).toBe('every agent of acme and beta loses it')
    const [one] = vaultGroups([e('SENTRY_DSN', { type: 'global' })], AGENTS, ['acme'])
    expect(one!.entries[0]!.audience).toBe('Every agent')
  })
})
