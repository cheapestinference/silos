// plan-usage.test.ts — the 5h/weekly windows of a Claude subscription:
// both response shapes, the read-only token rule (expired = no call, last
// good reading kept stale), the 90 s cache and in-flight dedupe, and the
// failures that keep the bars instead of blanking them.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PlanUsageService, parseUsage, USAGE_URL } from '../src/harnesses/claude-code/plan-usage.js'

const LIMITS = {
  five_hour: { utilization: 2, resets_at: '2026-10-30T18:50:00.36+00:00' },
  limits: [
    { kind: 'session', group: 'session', percent: 3, severity: 'normal', resets_at: '2026-10-30T18:49:59.62+00:00', scope: null, is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: 90, severity: 'critical', resets_at: '2026-11-01T04:59:59.62+00:00', scope: null, is_active: false },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 100,
      severity: 'critical',
      resets_at: '2026-11-01T04:59:59.62+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      is_active: true,
    },
  ],
}

describe('parseUsage', () => {
  it('reads the limits array, naming a scoped window by its model', () => {
    expect(parseUsage(LIMITS)).toEqual([
      { kind: 'session', label: '5h', percent: 3, resetsAt: '2026-10-30T18:49:59.620Z', windowMs: 5 * 3600_000, severity: 'normal', active: false },
      { kind: 'weekly_all', label: 'Week', percent: 90, resetsAt: '2026-11-01T04:59:59.620Z', windowMs: 7 * 86_400_000, severity: 'critical', active: false },
      {
        kind: 'weekly_scoped',
        label: 'Fable',
        percent: 100,
        resetsAt: '2026-11-01T04:59:59.620Z',
        windowMs: 7 * 86_400_000,
        severity: 'critical',
        active: true,
      },
    ])
  })

  it('falls back to the keyed objects when limits is absent', () => {
    expect(
      parseUsage({ five_hour: { utilization: 80, resets_at: null }, seven_day: { utilization: 10, resets_at: '2026-11-01T05:00:00Z' }, seven_day_opus: null }),
    ).toEqual([
      { kind: 'five_hour', label: '5h', percent: 80, resetsAt: null, windowMs: 5 * 3600_000, severity: 'warning', active: false },
      { kind: 'seven_day', label: 'Week', percent: 10, resetsAt: '2026-11-01T05:00:00.000Z', windowMs: 7 * 86_400_000, severity: 'normal', active: false },
    ])
  })

  it('an unknown shape is null, never a guess; a new kind is kept raw', () => {
    expect(parseUsage({ hello: 1 })).toBeNull()
    expect(parseUsage('x')).toBeNull()
    expect(parseUsage({ limits: [{ kind: 'monthly_thing', percent: 5 }] })).toEqual([
      { kind: 'monthly_thing', label: 'monthly thing', percent: 5, resetsAt: null, windowMs: null, severity: 'normal', active: false },
    ])
  })
})

describe('PlanUsageService', () => {
  let dir: string
  let now: number
  let calls: Array<{ url: string; auth: string | null }>
  let respond: () => Response | Promise<Response>

  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, auth: new Headers(init?.headers).get('authorization') })
    return respond()
  }) as typeof fetch

  function creds(expiresAt: number): void {
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok-1', refreshToken: 'r', expiresAt } }))
  }
  function svc(): PlanUsageService {
    return new PlanUsageService({ configDirOf: (id) => (id === 'default' ? dir : null), fetch: fakeFetch, now: () => now })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plan-usage-'))
    now = Date.parse('2026-10-30T17:00:00Z')
    calls = []
    respond = () => new Response(JSON.stringify(LIMITS), { status: 200 })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('a non-Claude provider is null, with no call', async () => {
    expect(await svc().get('acme')).toBeNull()
    expect(calls).toEqual([])
  })

  it('reads with the account token and caches for 90 s, one call for concurrent asks', async () => {
    creds(now + 3600_000)
    const s = svc()
    const [a, b] = await Promise.all([s.get('default'), s.get('default')])
    expect(calls).toEqual([{ url: USAGE_URL, auth: 'Bearer tok-1' }])
    expect(a).toEqual(b)
    expect(a).toMatchObject({ ok: true, stale: false })
    now += 60_000
    await s.get('default')
    expect(calls).toHaveLength(1)
    now += 31_000
    await s.get('default')
    expect(calls).toHaveLength(2)
  })

  it('not logged in: says so, no call', async () => {
    expect(await svc().get('default')).toMatchObject({ ok: false, reason: 'not-logged-in' })
    expect(calls).toEqual([])
  })

  it('an expired token is never used (nor refreshed): last good reading turns stale', async () => {
    creds(now + 60_000)
    const s = svc()
    await s.get('default')
    now += 120_000 // token now expired, cache too
    const r = await s.get('default')
    expect(calls).toHaveLength(1)
    expect(r).toMatchObject({ ok: true, stale: true })
  })

  it('expired with no good reading yet: token-expired', async () => {
    creds(now - 1)
    expect(await svc().get('default')).toMatchObject({ ok: false, reason: 'token-expired' })
    expect(calls).toEqual([])
  })

  it('a 429 keeps the bars (stale) and backs off for minutes', async () => {
    creds(now + 3600_000 * 5)
    const s = svc()
    await s.get('default')
    respond = () => new Response('slow down', { status: 429 })
    now += 91_000
    expect(await s.get('default')).toMatchObject({ ok: true, stale: true })
    now += 120_000
    await s.get('default')
    expect(calls).toHaveLength(2)
  })

  it('a network failure or an unknown body with nothing to show: unavailable', async () => {
    creds(now + 3600_000)
    respond = () => {
      throw new Error('ECONNRESET')
    }
    expect(await svc().get('default')).toMatchObject({ ok: false, reason: 'unavailable', detail: 'network' })
    respond = () => new Response('{"nope":1}', { status: 200 })
    expect(await svc().get('default')).toMatchObject({ ok: false, reason: 'unavailable' })
  })
})
