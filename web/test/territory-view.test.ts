// territory-view.test.ts — the pure reading behind Settings › Territory:
// the proxy's host rule mirrored, the secrets split by mode, and the
// «works with a service it cannot call» set.
import { describe, expect, it } from 'vitest'
import { hostMatches, refusedToday, secretsOf, servedNotCallable } from '../src/lib/territory-view'
import type { AgentEgress, VaultEntry } from '../src/lib/types'

const entry = (id: string, name: string, extra: Partial<VaultEntry> = {}): VaultEntry => ({
  id,
  name,
  value: '••••',
  scope: { type: 'agents', agentIds: ['a'] },
  createdAt: '2026-11-01T00:00:00Z',
  ...extra,
})
const signed = (id: string, name: string, baseUrl: string): VaultEntry =>
  entry(id, name, { binding: { baseUrl, inject: { header: 'Authorization', format: 'Bearer %s' } } })

describe('hostMatches — the proxy rule (server egress-proxy.ts)', () => {
  it.each([
    ['api.x.com', 'api.x.com', true],
    ['API.X.com.', 'api.x.com', true],
    ['a.x.com', '*.x.com', true],
    ['a.b.x.com', '*.x.com', true],
    ['x.com', '*.x.com', false],
    ['team-review.googlesource.com', '*-review.googlesource.com', true],
    ['a.team-review.googlesource.com', '*-review.googlesource.com', false],
    ['-review.googlesource.com', '*-review.googlesource.com', false],
    ['evilx.com', 'x.com', false],
  ])('%s under %s → %s', (host, pattern, want) => {
    expect(hostMatches(host, pattern)).toBe(want)
  })
})

describe('secretsOf', () => {
  it('splits by mode, leaves public entries out, and says the hold', () => {
    const r = secretsOf([signed('1', 'STRIPE', 'https://api.stripe.com/v1'), entry('2', 'GH'), entry('3', 'REGION', { public: true })], 'a', null)
    expect(r).toEqual({ signed: [{ name: 'STRIPE', host: 'api.stripe.com' }], delivered: ['GH'], hold: 'partial' })
    expect(secretsOf([signed('1', 'S', 'https://s.example')], 'a', null).hold).toBe('held')
    expect(secretsOf([entry('2', 'GH')], 'a', null).hold).toBe('open')
    expect(secretsOf([], 'a', null).hold).toBe('none')
  })
})

describe('servedNotCallable', () => {
  const secrets = secretsOf([signed('1', 'STRIPE', 'https://api.stripe.com'), signed('2', 'GH', 'https://api.github.com')], 'a', null)
  const egress = (mode: AgentEgress['mode'], hosts: string[]): AgentEgress => ({
    id: 'a',
    name: 'A',
    mode,
    hosts,
    engine: {
      source: 'x',
      hosts: [
        { host: 'api.github.com', reason: 'r' },
        { host: 'api.stripe.com', optional: true, reason: 'r' },
      ],
    },
  })
  it('open: none — it can call anything', () => {
    expect(servedNotCallable(secrets, egress('open', []))).toEqual([])
  })
  it("allowlist: the signed hosts neither its list nor its engine's pinned ones cover (an optional one does not count)", () => {
    expect(servedNotCallable(secrets, egress('allowlist', []))).toEqual([{ name: 'STRIPE', host: 'api.stripe.com' }])
    expect(servedNotCallable(secrets, egress('allowlist', ['*.stripe.com']))).toEqual([])
  })
})

describe('refusedToday', () => {
  it('counts the last 24 h per agent', () => {
    const now = Date.parse('2026-11-17T12:00:00Z')
    const rows = [
      { at: '2026-11-17T11:00:00Z', agentId: 'a', host: 'h', port: 443, reason: 'r' },
      { at: '2026-11-17T01:00:00Z', agentId: 'a', host: 'h', port: 443, reason: 'r' },
      { at: '2026-11-15T11:00:00Z', agentId: 'a', host: 'h', port: 443, reason: 'r' },
      { at: '2026-11-17T11:30:00Z', agentId: 'b', host: 'h', port: 443, reason: 'r' },
    ]
    expect([...refusedToday(rows, now)]).toEqual([
      ['a', 2],
      ['b', 1],
    ])
  })
})
