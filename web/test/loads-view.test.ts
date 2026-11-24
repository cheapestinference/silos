// loads-view.test.ts — how the inventory is cut for Tools (lib/loads-view.ts):
// the Claude account is one group per login; Agent › Tools keeps only what
// loads (a copy that stands aside, a server of an off plugin out); the foot
// counts each thing once.
import { describe, expect, it } from 'vitest'
import {
  agentRows,
  engineLimitWords,
  engineSwitchesNothing,
  footCounts,
  groupOf,
  healthOf,
  pluginHealth,
  placeProofWords,
  proofWords,
  signInDoorOf,
  topLevel,
} from '../src/lib/loads-view'
import { weightOf } from '../src/lib/loads-weight'
import type { FolderLoads, LoadsCheckTarget, LoadsHealth, LoadsRow } from '../src/lib/types'
import { sendsOffers } from '../src/lib/loads-check-view'
import { blockLines, placesPhrase } from '../src/lib/loads-places'

const row = (over: Partial<LoadsRow> & Pick<LoadsRow, 'key'>): LoadsRow => ({
  engine: 'Claude Code',
  kind: 'mcp',
  name: over.key,
  label: over.key,
  exact: true,
  origin: { owner: 'project', carrier: '.mcp.json' },
  state: 'active',
  ...over,
})
const account = (login: string | null, unmatched = false) => ({
  owner: 'account' as const,
  carrier: 'design plugin',
  login,
  ...(unmatched ? { unmatched: true as const } : {}),
})

describe('loads-view', () => {
  it('groups the account per login, an unmatched batch apart, the unplaced as seen', () => {
    expect(groupOf(row({ key: 'a', origin: account('sam@example.com') }))).toBe('account:sam@example.com')
    expect(groupOf(row({ key: 'b', origin: account(null, true) }))).toBe('account:?')
    expect(groupOf(row({ key: 'c', origin: { owner: null, carrier: 'seen' } }))).toBe('seen')
    expect(groupOf(row({ key: 'd' }))).toBe('project')
  })

  // an engine with the inventory alone: its line, by its own label, and its
  // rows known as switchless; an engine with switches and health says nothing
  it('an engine that switches nothing and reads no health gets one line; a full one none', () => {
    const all: FolderLoads = {
      folder: '/home/user/proj',
      rows: [row({ key: 'a' }), row({ key: 'b', engine: 'Bare' })],
      logins: [],
      notes: [],
      engines: [
        { id: 'full', label: 'Claude Code', readsStatus: true, switches: true, checks: true },
        { id: 'bare', label: 'Bare' },
      ],
    }
    const lines = engineLimitWords(all)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('Bare')
    expect(engineSwitchesNothing(all.rows[0]!, all)).toBe(false)
    expect(engineSwitchesNothing(all.rows[1]!, all)).toBe(true)
    expect(healthOf(all.rows[1]!, all, 0)).toBeNull()
    expect(engineLimitWords({ ...all, engines: [all.engines[0]!] })).toEqual([])
  })

  // the way out of a switch that didn't take: an account item off by its
  // own name → its origin's head (depends on no name); else a fresh reading
  it('a proven row offers its way out; a row that loads or has no proof offers none', () => {
    const read = { at: 0, from: 'turn' as const, login: 'sam@example.com' }
    const proof = (by: 'item' | 'origin') => ({ name: 'claude.ai Mail', status: 'connected' as const, by, read })
    expect(proofWords(row({ key: 'c', kind: 'connector', origin: account('sam@example.com'), state: 'available', proof: proof('item') }), 0)?.wayOut).toBe(
      'origin',
    )
    expect(proofWords(row({ key: 'c', kind: 'connector', origin: account('sam@example.com'), state: 'available', proof: proof('origin') }), 0)?.wayOut).toBe(
      'check',
    )
    expect(proofWords(row({ key: 'g', state: 'held', proof: proof('item') }), 0)?.wayOut).toBe('check')
    expect(proofWords(row({ key: 'g', state: 'active', proof: proof('item') }), 0)).toBeNull()
    expect(proofWords(row({ key: 'g', state: 'held' }), 0)).toBeNull()
  })

  // spec scopes §7 (T12): each place's proof is said for the page it belongs to
  it('a place’s proof: an agent’s page says its own agent’s and the machine’s, never another agent’s; a column only its own thread’s', () => {
    const read = { at: 0, from: 'turn' as const, login: null }
    const r = row({
      key: 'g',
      at: [
        { place: 'machine', entry: 'off', result: 'off', proof: { to: 'off', name: 'g', status: 'connected', read } },
        { place: 'project', result: 'off' },
        { place: 'agent', agent: 'builder', agentName: 'Builder', entry: 'on', result: 'on', proof: { to: 'on', read } },
        { place: 'agent', agent: 'writer', agentName: 'Writer', entry: 'off', result: 'off', proof: { to: 'off', name: 'g', read } },
        { place: 'conversation', conversation: 't1', entry: 'off', result: 'off', proof: { to: 'off', name: 'g', read } },
      ],
    })
    expect(placeProofWords(r, 0).map((w) => w.key)).toEqual(['machine:', 'agent:builder', 'agent:writer', 'conversation:t1'])
    expect(placeProofWords(r, 0, { agent: 'builder' }).map((w) => w.key)).toEqual(['machine:', 'agent:builder', 'conversation:t1'])
    expect(placeProofWords(r, 0, { here: 't2' }).map((w) => w.key)).not.toContain('conversation:t1')
    expect(placeProofWords(row({ key: 'h' }), 0)).toEqual([])
  })

  it('Agent › Tools: only what loads, servers under a plugin that loads', () => {
    const rows = [
      row({ key: 'p1', kind: 'plugin' }),
      row({ key: 's1', parent: 'p1' }),
      row({ key: 's2', parent: 'p1', state: 'held' }),
      row({ key: 'p2', kind: 'plugin', state: 'available', origin: account('sam@example.com') }),
      row({ key: 's3', parent: 'p2', state: 'available', origin: account('sam@example.com') }),
      row({ key: 'p3', kind: 'plugin', replacedBy: 'p1' }),
      row({ key: 's4', parent: 'p3', replacedBy: 'p1' }),
    ]
    expect(agentRows(rows).map((r) => r.key)).toEqual(['p1', 's1'])
    expect(topLevel(agentRows(rows)).map((r) => r.key)).toEqual(['p1'])
  })

  // Agent › Tools is the agent's place (spec scopes §5): a row it alone holds
  // stays in place and is counted «off only for <agent>»; a row it turns on
  // over the project loads for it and is never «turned off»
  it("Agent › Tools by the agent's own line: what it holds kept and counted apart, what it turns on listed", () => {
    const line = (result: 'on' | 'off', entry?: 'on' | 'off') => [
      { place: 'project' as const, result: 'on' as const },
      { place: 'agent' as const, agent: 'builder', ...(entry ? { entry } : {}), result },
    ]
    const rows = [
      row({ key: 'p1', kind: 'plugin', at: line('off', 'off') }),
      row({ key: 's1', parent: 'p1', at: line('off') }),
      row({ key: 'm1', at: line('on') }),
      row({
        key: 'm2',
        state: 'held',
        at: [
          { place: 'project', entry: 'off', result: 'off' },
          { place: 'agent', agent: 'builder', entry: 'on', result: 'on' },
        ],
      }),
      row({
        key: 'm3',
        state: 'held',
        at: [
          { place: 'project', entry: 'off', result: 'off' },
          { place: 'agent', agent: 'builder', result: 'off' },
        ],
      }),
      row({ key: 'm4', at: line('off', 'off') }),
    ]
    expect(agentRows(rows, 'builder').map((r) => r.key)).toEqual(['p1', 's1', 'm1', 'm2', 'm4'])
    expect(footCounts(rows, 'builder')).toEqual({ off: 1, couldAdd: 0, agentOff: 2 })
    // no agent named: the project's reading, as before
    expect(footCounts(rows)).toEqual({ off: 2, couldAdd: 0, agentOff: 0 })
  })

  it('the foot counts each thing once: a server off under an on plugin counts, under an off plugin it does not', () => {
    const rows = [
      row({ key: 'p1', kind: 'plugin' }),
      row({ key: 's1', parent: 'p1', state: 'held' }),
      row({ key: 'p2', kind: 'plugin', state: 'held' }),
      row({ key: 's2', parent: 'p2', state: 'held' }),
      row({ key: 'p3', kind: 'plugin', state: 'available', origin: account('sam@example.com') }),
      row({ key: 's3', parent: 'p3', state: 'available', origin: account('sam@example.com') }),
      row({ key: 'c1', kind: 'connector', state: 'available', origin: account('sam@example.com') }),
    ]
    expect(footCounts(rows)).toEqual({ off: 2, couldAdd: 2, agentOff: 0 })
  })

  it('health: only what a conversation dials has one; unread is said only where the engine reads status; a plugin takes its worst server', () => {
    const read = (status: LoadsHealth['status']): LoadsHealth => ({ status, read: { at: 1, from: 'turn', via: 'chat', agentName: 'Builder', login: null } })
    const rows = [
      row({ key: 'p', kind: 'plugin' }),
      row({ key: 'a', parent: 'p', health: read('connected') }),
      row({ key: 'b', parent: 'p', health: read('failed') }),
      row({ key: 'ph', parent: 'p', placeholder: {} }),
      row({ key: 'same', sameAs: 'a' }),
      row({ key: 'held', state: 'held', health: read('connected') }),
      row({ key: 'aside', replacedBy: 'x' }),
      row({ key: 'unread' }),
    ]
    const all = (readsStatus: boolean): FolderLoads => ({
      folder: '/home/user/proj',
      engines: [{ id: 'claude-code', label: 'Claude Code', ...(readsStatus ? { readsStatus: true as const } : {}) }],
      rows,
      logins: [],
      notes: [],
    })
    const by = (k: string) => rows.find((r) => r.key === k)!
    expect(healthOf(by('a'), all(true), 2)?.tone).toBe('ok')
    expect(healthOf(by('b'), all(true), 2)?.tone).toBe('bad')
    for (const k of ['ph', 'same', 'held', 'aside', 'p']) expect(healthOf(by(k), all(true), 2)).toBeNull()
    expect(healthOf(by('unread'), all(true), 2)?.tone).toBe('quiet')
    expect(healthOf(by('unread'), all(false), 2)).toBeNull()
    expect(pluginHealth(by('p'), all(true), 2)?.tone).toBe('bad')
  })

  it('a row’s measured weight: its own parts, a plugin’s plus its servers’; nothing measured, none', () => {
    const rows = [row({ key: 'p1', kind: 'plugin' }), row({ key: 's1', parent: 'p1' }), row({ key: 's2', parent: 'p1' }), row({ key: 'x' })]
    const w = {
      folder: '/home/user/proj',
      at: null,
      conversation: { folder: 'f', id: 'c' },
      mode: 'console' as const,
      total: 5000,
      items: {
        p1: { tokens: 300, parts: [{ kind: 'skills', label: 'Skill listing · p1 plugin', tokens: 300 }] },
        s1: { tokens: 1200, parts: [{ kind: 'mcp', label: 's1', tokens: 1200 }] },
      },
    }
    expect(weightOf(rows[0]!, rows, w)).toEqual({
      tokens: 1500,
      parts: [
        { label: 's1', tokens: 1200 },
        { label: 'skill listing', tokens: 300 },
      ],
    })
    expect(weightOf(rows[1]!, rows, w)?.tokens).toBe(1200)
    expect(weightOf(rows[2]!, rows, w)).toBeNull()
    expect(weightOf(rows[3]!, rows, null)).toBeNull()
  })

  it('«See what it sends» is offered only on a login with an account that is off here and has no row', () => {
    const t = (over: Partial<LoadsCheckTarget>): LoadsCheckTarget => ({
      provider: 'default',
      label: 'Claude',
      login: 'sam@example.com',
      engine: 'Claude Code',
      agents: [],
      cost: '',
      account: true,
      sendsHere: false,
      ...over,
    })
    const loads = (rows: LoadsRow[]): FolderLoads => ({ folder: '/home/user/proj', engines: [], rows, logins: [], notes: [] })
    expect(sendsOffers([t({})], loads([]))).toHaveLength(1)
    expect(sendsOffers([t({ sendsHere: true })], loads([]))).toHaveLength(0)
    expect(sendsOffers([t({ account: false })], loads([]))).toHaveLength(0)
    expect(sendsOffers([t({})], loads([row({ key: 'p', kind: 'plugin', origin: account('sam@example.com') })]))).toHaveLength(0)
    expect(sendsOffers([t({})], loads([row({ key: 'p', kind: 'plugin', origin: account('other@example.com') })]))).toHaveLength(1)
  })
})

describe('signInDoorOf — the door of every row that waits for your sign-in', () => {
  const read: LoadsHealth['read'] = { at: 1, from: 'turn', login: null }
  const waits = { health: { status: 'needs-auth' as const, read } }
  const LINK = { via: 'link' as const, url: 'https://connectors.example.com', where: 'example.com' }
  const chat = (n: string) => ({ via: 'console' as const, draft: `sign in ${n}` })
  const plugin = row({ key: 'p', kind: 'plugin' })
  const server = (k: string, signIn: LoadsRow['signIn'], over: Partial<LoadsRow> = {}): LoadsRow =>
    row({ key: k, kind: 'mcp', parent: 'p', signIn, ...waits, ...over })

  it("a server its own; a plugin with one waiting server, that server's; several, unfold, or their one outside page", () => {
    const a = server('a', chat('a'))
    expect(signInDoorOf(a, [plugin, a])).toEqual(chat('a'))
    expect(signInDoorOf(plugin, [plugin, a, server('ok', chat('ok'), { health: { status: 'connected', read } })])).toEqual(chat('a'))
    expect(signInDoorOf(plugin, [plugin, a, server('b', chat('b'))])).toEqual({ via: 'unfold', servers: ['a', 'b'] })
    expect(signInDoorOf(plugin, [plugin, server('c', LINK), server('d', LINK)])).toEqual(LINK)
    // nothing waits, or it does not load: no door
    expect(signInDoorOf(plugin, [plugin])).toBeNull()
    expect(signInDoorOf(server('e', chat('e'), { state: 'held' }), [])).toBeNull()
  })
})

// «Where it loads» (spec scopes §4): the row speaks only when its places
// disagree; an agent's page shows that agent's line among the agents.
describe('where it loads — phrase and lines', () => {
  const row = (at: NonNullable<LoadsRow['at']>): LoadsRow => ({
    key: 'plugin:a@m',
    engine: 'E',
    kind: 'plugin',
    name: 'a@m',
    label: 'a',
    exact: true,
    origin: { owner: 'you', carrier: 'a plugin' },
    state: 'active',
    family: 'override',
    at,
  })
  const agents = [
    { place: 'agent' as const, agent: 'builder', agentName: 'Builder', result: 'on' as const },
    { place: 'agent' as const, agent: 'writer', agentName: 'Writer', result: 'on' as const },
  ]
  const project = { scope: 'project' as const }

  it('places that agree say nothing; a machine «off» the project overrides, or follows, is said', () => {
    expect(placesPhrase(row([{ place: 'machine', result: 'on' }, { place: 'project', result: 'on' }, ...agents]), project)).toBeNull()
    expect(
      placesPhrase(
        row([
          { place: 'machine', entry: 'off', result: 'off' },
          { place: 'project', entry: 'on', result: 'on' },
        ]),
        project,
      ),
    ).not.toBeNull()
    expect(
      placesPhrase(
        row([
          { place: 'machine', entry: 'off', result: 'off' },
          { place: 'project', result: 'off' },
        ]),
        project,
      ),
    ).not.toBeNull()
    // the project holds it: today's words already say it
    expect(
      placesPhrase(
        row([
          { place: 'machine', result: 'on' },
          { place: 'project', entry: 'off', result: 'off' },
        ]),
        project,
      ),
    ).toBeNull()
    // the organization decides: today's words too
    expect(
      placesPhrase(
        row([
          { place: 'fact', fact: { who: 'organization', file: 'f', key: 'k' }, entry: 'off', result: 'off' },
          { place: 'machine', result: 'off', locked: { why: 'organization' } },
          { place: 'project', result: 'off', locked: { why: 'organization' } },
        ]),
        project,
      ),
    ).toBeNull()
  })

  it('an agent holding it, or the only one loading it, is named', () => {
    const held = row([{ place: 'project', result: 'on' }, { ...agents[0]!, entry: 'off', result: 'off' }, agents[1]!])
    expect(placesPhrase(held, project)).toContain('Builder')
    const only = row([
      { place: 'project', entry: 'off', result: 'off' },
      { ...agents[0]!, entry: 'on', result: 'on' },
      { ...agents[1]!, result: 'off' },
    ])
    expect(placesPhrase(only, project)).toContain('Builder')
    expect(placesPhrase(only, project)).not.toContain('Writer')
  })

  it("an agent's page draws only its own agent line; a project with more than five agents only those with an entry", () => {
    const r = row([{ place: 'machine', result: 'on' }, { place: 'project', result: 'on' }, ...agents])
    expect(
      blockLines(r, { scope: 'agent', agentId: 'writer', agentName: 'Writer' })
        .lines.filter((l) => l.place === 'agent')
        .map((l) => l.agent),
    ).toEqual(['writer'])
    const many = row([
      { place: 'project', result: 'on' },
      ...['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({
        place: 'agent' as const,
        agent: id,
        result: 'on' as const,
        ...(id === 'c' ? { entry: 'off' as const } : {}),
      })),
    ])
    const b = blockLines(many, project)
    expect(b.lines.filter((l) => l.place === 'agent').map((l) => l.agent)).toEqual(['c'])
    expect(b.more).toBe(5)
  })
})
