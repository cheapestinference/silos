// gateway-models.test.ts — a gateway's models are live data: the refresher
// re-reads every key's listing, rewrites models/limits/modelsAt, renames a
// row that still wears Silos's own name, keeps a typed name, and leaves a
// row alone when the gateway does not answer.
import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProvidersStore } from '../src/providers-store.js'
import { GatewayModelsRefresher } from '../src/gateway-models.js'

let providers: ProvidersStore
let answers: Record<string, () => Response>
let calls: string[]
const fetchFake = (async (url: RequestInfo | URL) => {
  const u = String(url)
  calls.push(u)
  const a = answers[u]
  return a ? a() : new Response('nope', { status: 404 })
}) as typeof fetch
const listing = (rows: Array<Record<string, unknown>>) => () => new Response(JSON.stringify({ object: 'list', data: rows }), { status: 200 })

beforeEach(() => {
  providers = new ProvidersStore(mkdtempSync(join(tmpdir(), 'gwm-')))
  answers = {}
  calls = []
})

describe('GatewayModelsRefresher.refreshAll', () => {
  it("rewrites models, limits and modelsAt; renames a row that still wears Silos's own name; logs the change", async () => {
    const p = providers.create({
      label: 'cheapestinference · mimo-v2.6-flash',
      baseUrl: 'https://api.cheapestinference.com/anthropic',
      apiKey: 'sk-1',
      models: ['mimo-v2.6-flash'],
    })
    answers['https://api.cheapestinference.com/v1/models'] = listing([
      { id: 'mimo-v2.6-flash', context_length: 1048576 },
      { id: 'deepseek-v4.1-flash', context_length: 1048576 },
    ])
    const log: string[] = []
    const r = new GatewayModelsRefresher({ providers, fetch: fetchFake, log: (l) => log.push(l), now: () => new Date('2026-10-27T12:00:00Z') })
    const out = await r.refreshAll()
    expect(out).toEqual([
      { id: p.id, label: 'cheapestinference · mimo-v2.6-flash, deepseek-v4.1-flash', changed: true, models: ['mimo-v2.6-flash', 'deepseek-v4.1-flash'] },
    ])
    const stored = providers.get(p.id)
    expect(stored?.kind === 'anthropic-compatible' ? stored : null).toMatchObject({
      label: 'cheapestinference · mimo-v2.6-flash, deepseek-v4.1-flash',
      models: ['mimo-v2.6-flash', 'deepseek-v4.1-flash'],
      modelLimits: { 'mimo-v2.6-flash': { context: 1048576 }, 'deepseek-v4.1-flash': { context: 1048576 } },
      modelsAt: '2026-10-27T12:00:00.000Z',
    })
    expect(log[0]).toContain('now lists mimo-v2.6-flash, deepseek-v4.1-flash')
    // a second identical read changes nothing and logs nothing
    const again = await r.refreshAll()
    expect(again[0]?.changed).toBe(false)
    expect(log).toHaveLength(1)
  })

  it('a name the operator typed stays; a gateway that does not answer leaves the row as it was; keyless rows are skipped', async () => {
    const typed = providers.create({ label: 'my proxy', baseUrl: 'https://byok.test', apiKey: 'sk-2', models: ['old'] })
    const silent = providers.create({ label: 'cheapestinference', baseUrl: 'https://down.test', apiKey: 'sk-3', models: ['kept'] })
    providers.create({ label: 'cleared', baseUrl: 'https://x.test', apiKey: 'sk-4' })
    providers.update(providers.list()[2]!.id, { baseUrl: 'https://moved.test' }) // key cleared → skipped
    answers['https://byok.test/v1/models'] = listing([{ id: 'new-a' }, { id: 'new-b' }])
    const r = new GatewayModelsRefresher({ providers, fetch: fetchFake })
    const out = await r.refreshAll()
    expect(out.map((o) => [o.label, o.changed, o.models])).toEqual([
      ['my proxy', true, ['new-a', 'new-b']],
      ['cheapestinference', false, null],
    ])
    const t = providers.get(typed.id)
    expect(t?.kind === 'anthropic-compatible' ? [t.label, t.models] : null).toEqual(['my proxy', ['new-a', 'new-b']])
    const d = providers.get(silent.id)
    expect(d?.kind === 'anthropic-compatible' ? d.models : null).toEqual(['kept'])
    expect(calls.filter((u) => u.startsWith('https://moved.test'))).toHaveLength(0)
  })

  it('is coalesced: two overlapping refreshAll calls share one run', async () => {
    providers.create({ label: 'ci', baseUrl: 'https://api.ci.test/anthropic', apiKey: 'sk-5' })
    answers['https://api.ci.test/v1/models'] = listing([{ id: 'a' }])
    const r = new GatewayModelsRefresher({ providers, fetch: fetchFake })
    await Promise.all([r.refreshAll(), r.refreshAll()])
    expect(calls).toHaveLength(1)
  })
})
