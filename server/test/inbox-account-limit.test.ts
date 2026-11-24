// A1b — a usage limit is the ACCOUNT's (inbox.ts accountLimitRows): every
// automation whose newest failure is that account's limit folds into ONE row
// that names the account, the window and its reset. A real incident is
// the case: one weekly Fable window, a failed-run row per automation, none
// saying which account or when.
import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  accountLimitRows,
  limitedWindow,
  resetWords,
  composeInbox,
  type AccountUsage,
  type LimitedAutomation,
  type InboxInput,
  type InboxRow,
} from '../src/inbox.js'
import { kernelInboxRows, limitedProviders } from '../src/inbox-source.js'
import { AutomationsStore } from '../src/automations-store.js'
import { NeedsYouAcksStore, isAckKind } from '../src/needs-you-acks.js'
import type { Automation, Run } from '../src/automations-types.js'
import type { Agent } from '../src/types.js'

const NOW = Date.parse('2026-10-31T12:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const FABLE =
  "Claude Code returned an error result: You've reached your Fable limit. Switch to another model, or manage usage credits at https://claude.ai/settings/usage"
const names: Record<string, string> = { builder: 'Builder', finance: 'Finance', support: 'Support' }
const nameOf = (id: string) => names[id] ?? id
const labelOf = (p: string) => (p === 'default' ? 'Your Claude account' : `Claude account ${p.slice(8)}`)

function auto(id: string, over: Partial<Automation> = {}): Automation {
  return {
    id,
    name: id,
    agentId: 'builder',
    prompt: 'p',
    trigger: { kind: 'cron', expr: '0 */4 * * *' },
    thread: { mode: 'new' },
    approval: false,
    keepAlive: false,
    paused: false,
    createdAt: iso(NOW - 86_400_000),
    nextRunAt: iso(NOW + 3_600_000),
    ...over,
  }
}
let seq = 0
function fail(automationId: string, minsAgo: number, error = FABLE): Run {
  return { id: `r${++seq}`, automationId, at: iso(NOW - minsAgo * 60_000), status: 'failed', error }
}
function item(a: Automation, runs: Run[], provider = 'default'): LimitedAutomation {
  return { automation: a, runs, provider }
}
const RESET = NOW + 17 * 3_600_000
function usage(over: Partial<AccountUsage> = {}): AccountUsage {
  return {
    at: NOW - 60_000,
    windows: [
      { label: 'Week', percent: 92, resetsAt: iso(RESET), active: false },
      { label: 'Fable', percent: 100, resetsAt: iso(RESET), active: true },
    ],
    ...over,
  }
}
const deps = (u: Record<string, AccountUsage | null> = {}) => ({ usageOf: (p: string) => u[p] ?? null, labelOf, nameOf, now: NOW })

describe('limitedWindow / resetWords', () => {
  it('the active window at 100 %, never one whose reset has passed', () => {
    expect(limitedWindow(usage(), NOW)).toEqual({ label: 'Fable', percent: 100, resetsAt: iso(RESET) })
    expect(limitedWindow(usage(), RESET + 1)).toBeNull()
    expect(limitedWindow(usage({ windows: [{ label: '5h', percent: 64, resetsAt: iso(RESET), active: false }] }), NOW)).toBeNull()
  })

  it('says today, tomorrow or the weekday, in local time', () => {
    const at = (ms: number) => {
      const d = new Date(ms)
      return `at ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    }
    const local = new Date(NOW)
    const todayLate = new Date(local.getFullYear(), local.getMonth(), local.getDate(), 23, 30).getTime()
    const tomorrow = new Date(local.getFullYear(), local.getMonth(), local.getDate() + 1, 6, 0).getTime()
    const later = new Date(local.getFullYear(), local.getMonth(), local.getDate() + 3, 6, 0).getTime()
    expect(resetWords(iso(todayLate), NOW)).toBe(at(todayLate))
    expect(resetWords(iso(tomorrow), NOW)).toBe(`tomorrow ${at(tomorrow)}`)
    expect(resetWords(iso(later), NOW)).toBe(`${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(later).getDay()]} ${at(later)}`)
  })
})

describe('accountLimitRows — one row per account', () => {
  it('a reading at the limit: ONE row for every automation on that account, at the first failure', () => {
    const a = auto('Tax watch', { agentId: 'finance' }),
      b = auto('3DS watch', { agentId: 'support' }),
      c = auto('Responsibility — Support', { agentId: 'support' })
    const rows = accountLimitRows([item(a, [fail(a.id, 5)]), item(b, [fail(b.id, 30)]), item(c, [fail(c.id, 60)])], deps({ default: usage() }))
    expect(rows).toHaveLength(1)
    const r = rows[0]! as Extract<InboxRow, { kind: 'accountLimit' }>
    expect(r).toMatchObject({
      kind: 'accountLimit',
      key: 'account-limit:default',
      urgency: 'due',
      provider: 'default',
      account: 'Your Claude account',
      window: { label: 'Fable', percent: 100, resetsAt: iso(RESET) },
      agentIds: ['finance', 'support'],
      ack: { kind: 'limit', key: 'default', version: iso(RESET) },
    })
    expect(r.automations.map((x) => x.name)).toEqual(['Tax watch', '3DS watch', 'Responsibility — Support'])
    expect(r.voice).toBe(
      `Your Claude account: Fable at 100% — resets ${resetWords(iso(RESET), NOW)} · 3 automations couldn't run: Tax watch, 3DS watch and 1 more`,
    )
  })

  it('one automation reads in the singular', () => {
    const a = auto('Tax watch')
    const r = accountLimitRows([item(a, [fail(a.id, 5)])], deps({ default: usage() }))[0]!
    expect(r.voice).toMatch(/· Tax watch couldn't run$/)
  })

  it('no reading: the A1 table — a scheduled automation waits for the 2nd limit in a row', () => {
    const a = auto('a')
    expect(accountLimitRows([item(a, [fail(a.id, 5)])], deps())).toEqual([])
    const rows = accountLimitRows([item(a, [fail(a.id, 5), fail(a.id, 245)])], deps())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'accountLimit', window: null })
    expect(rows[0]!.voice).toBe("Your Claude account hit its usage limit · a couldn't run")
    // Seen without a window = the newest failed run
    expect(rows[0]!.ack?.version).toMatch(/^r\d+$/)
  })

  it('a reading NEWER than the failures that shows no limit: the account is free — no row for what runs again by itself', () => {
    const a = auto('scheduled')
    const once = auto('once', { trigger: { kind: 'once', at: iso(NOW - 3_600_000) }, nextRunAt: undefined })
    const free = usage({ at: NOW, windows: [{ label: 'Fable', percent: 3, resetsAt: iso(NOW + 7 * 86_400_000), active: false }] })
    const rows = accountLimitRows([item(a, [fail(a.id, 5), fail(a.id, 245)]), item(once, [fail(once.id, 5)])], deps({ default: free }))
    // only the one-shot stays — as its own failed run, since only the owner can run it again
    expect(rows.map((r) => [r.kind, 'automation' in r ? r.automation.id : null])).toEqual([['failedRun', 'once']])
  })

  it('a reading OLDER than the failures is no proof of anything: the A1 table decides', () => {
    const a = auto('a')
    const old = usage({ at: NOW - 3_600_000, windows: [] })
    expect(accountLimitRows([item(a, [fail(a.id, 5)])], deps({ default: old }))).toEqual([])
    expect(accountLimitRows([item(a, [fail(a.id, 5), fail(a.id, 245)])], deps({ default: old }))).toHaveLength(1)
  })

  it('two accounts, two rows; a paused automation and a healed one are left out', () => {
    const a = auto('a'),
      b = auto('b'),
      p = auto('p', { paused: true })
    const ok: Run = { id: 'ok1', automationId: 'h', at: iso(NOW - 60_000), status: 'ok' }
    const h = auto('h')
    const rows = accountLimitRows(
      [item(a, [fail(a.id, 5)]), item(b, [fail(b.id, 5)], 'account:kai'), item(p, [fail(p.id, 5)]), item(h, [ok, fail(h.id, 300)])],
      deps({ default: usage(), 'account:kai': usage() }),
    )
    expect(rows.map((r) => r.key).sort()).toEqual(['account-limit:account:kai', 'account-limit:default'])
    const kai = rows.find((r) => r.key === 'account-limit:account:kai')!
    expect(kai.ack).toEqual({ kind: 'limit', key: 'account.kai', version: iso(RESET) })
    expect(kai.voice).toMatch(/^Claude account kai: Fable at 100%/)
    const def = rows.find((r) => r.key === 'account-limit:default')! as Extract<InboxRow, { kind: 'accountLimit' }>
    expect(def.automations.map((x) => x.id)).toEqual(['a'])
  })
})

describe('composeInbox — Seen is per episode', () => {
  const base: InboxInput = { nameOf, asks: [], needsYou: [], pending: [], automations: [], kernel: [] }
  it('Seen hides this window; the next episode (another reset) comes back', () => {
    const a = auto('a')
    const [row] = accountLimitRows([item(a, [fail(a.id, 5)])], deps({ default: usage() }))
    const acked = new Map<string, string>([['limit default', iso(RESET)]])
    const ackedVersion = (k: string, key: string) => acked.get(`${k} ${key}`) ?? null
    expect(composeInbox({ ...base, kernel: [row!], ackedVersion })).toEqual([])
    const next = usage({ windows: [{ label: 'Fable', percent: 100, resetsAt: iso(RESET + 7 * 86_400_000), active: true }] })
    const [row2] = accountLimitRows([item(a, [fail(a.id, 5)])], deps({ default: next }))
    expect(composeInbox({ ...base, kernel: [row2!], ackedVersion })).toHaveLength(1)
  })

  it('the account row never folds into an agent summary', () => {
    const autos = ['a', 'b', 'c', 'd', 'e'].map((id) => auto(id))
    const rows = accountLimitRows(
      autos.map((x) => item(x, [fail(x.id, 5)])),
      deps({ default: usage() }),
    )
    expect(composeInbox({ ...base, kernel: rows }).map((r) => r.kind)).toEqual(['accountLimit'])
  })

  it('the acks store takes the new kind', () => {
    expect(isAckKind('limit')).toBe(true)
    const store = new NeedsYouAcksStore(mkdtempSync(join(tmpdir(), 'acks-limit-')))
    store.ack('limit', 'default', iso(RESET))
    expect(store.ackedVersion('limit', 'default')).toBe(iso(RESET))
  })
})

describe('kernelInboxRows — limit failures are read from the real store and grouped', () => {
  const builder: Agent = { id: 'builder', name: 'Builder', emoji: '🛠', role: '', folder: '/x', skills: [] }
  const finance: Agent = { id: 'finance', name: 'Finance', emoji: '💶', role: '', folder: '/y', skills: [] }
  let automations: AutomationsStore
  beforeEach(() => {
    automations = new AutomationsStore(mkdtempSync(join(tmpdir(), 'inbox-limit-')))
    automations.load()
    automations.create(auto('l1', { name: 'Tax watch', agentId: 'finance' }))
    automations.appendRun('l1', fail('l1', 5))
    automations.create(auto('l2', { name: 'Console reading', agentId: 'builder' }))
    automations.appendRun('l2', fail('l2', 10))
    automations.create(auto('x', { name: 'Broken', agentId: 'builder' }))
    automations.appendRun('x', fail('x', 5, 'API Error: 400 bad'))
  })

  it('with providerOf: one account row for the limits, the 400 stays its own failed run', () => {
    const rows = kernelInboxRows({
      agents: [builder, finance],
      automations,
      nameOf,
      now: NOW,
      providerOf: () => 'default',
      usageOf: (p) => (p === 'default' ? usage() : null),
      labelOf,
    })
    expect(rows.map((r) => r.kind).sort()).toEqual(['accountLimit', 'failedRun'])
    expect(limitedProviders(automations, new Set(['builder', 'finance']), () => 'default')).toEqual(['default'])
  })

  it('without providerOf: the old per-automation rows (A1 table)', () => {
    const rows = kernelInboxRows({ agents: [builder, finance], automations, nameOf, now: NOW })
    expect(rows.map((r) => r.kind)).toEqual(['failedRun'])
  })
})
