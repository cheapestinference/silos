// inbox.test.ts — the server-composed inbox: the
// composition Home used to do in the browser, ported, plus the four provable
// rows (failed run by class, stalled mission, urgent message with no reader,
// missed retry), the per-agent budget, and Seen = "this version".
import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import {
  composeInbox,
  failedRunRow,
  missedRetryRow,
  territoryOffRow,
  cutRow,
  ownTurnsCeilingRow,
  ownCapWhy,
  unreadMessagesRow,
  unreadWhyOf,
  MESSAGE_UNREAD_ROW,
  runFailure,
  waitedWords,
  inboxCeiling,
  inboxSignature,
  localDay,
  AGENT_INBOX_BUDGET,
  SILO_INBOX_BUDGET,
  RESIDENT_TICK_MS,
  type InboxInput,
  type InboxRow,
} from '../src/inbox.js'
import { kernelInboxRows, agentNameOf } from '../src/inbox-source.js'
import { NeedsYouAcksStore } from '../src/needs-you-acks.js'
import { AutomationsStore } from '../src/automations-store.js'
import { AgentStateStore } from '../src/agent-state.js'
import { MessageStore } from '../src/messages.js'
import type { Automation, Run } from '../src/automations-types.js'
import type { NeedsYouItem, SiloNeedsYou } from '../src/needs-you.js'
import type { Agent } from '../src/types.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { buildServer } from '../src/server.js'
import { installSilosHooks } from '../src/harnesses/claude-code/settings.js'
import { PLUGIN_HOOKS_DIR } from '../src/repo-paths.js'

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p))
const NOW = Date.parse('2026-10-31T12:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const names: Record<string, string> = { builder: 'Builder', finance: 'Finance', writer: 'Writer' }
const nameOf = (id: string) => names[id] ?? id

function auto(over: Partial<Automation> = {}): Automation {
  return {
    id: 'sweep',
    name: 'Nightly sweep',
    agentId: 'builder',
    prompt: 'p',
    trigger: { kind: 'cron', expr: '0 3 * * *' },
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
function run(status: Run['status'], over: Partial<Run> = {}): Run {
  seq++
  return { id: `r${seq}`, automationId: 'sweep', at: iso(NOW - seq * 60_000), status, ...over }
}
const empty: InboxInput = { nameOf, asks: [], needsYou: [], pending: [], automations: [], kernel: [] }

describe('runFailure — the raw error, classed and said plainly', () => {
  it('classes each failure the resident records', () => {
    expect(runFailure('API Error: 400 {"type":"error"}')).toEqual({ class: 'rejected', text: 'the API rejected the request (400)' })
    expect(runFailure("You've reached your usage limit").class).toBe('limit')
    expect(runFailure('timeout').class).toBe('timeout')
    expect(runFailure('interrupted by a server restart').class).toBe('restart')
    expect(runFailure('agent not found or archived').class).toBe('config')
    expect(runFailure('Anywhere needs a folder on the thread (thread.folder)').class).toBe('config')
    expect(runFailure('Prompt is too long').class).toBe('too_long')
    expect(runFailure('the turn did not finish').class).toBe('rejected')
    expect(runFailure('zai: Insufficient balance (429)')).toEqual({ class: 'other', text: 'zai: Insufficient balance (429)' })
  })
})

describe('A1 — failed run, admitted by class', () => {
  it('a 400 enters at once, keyed and Seen by the failed run', () => {
    const r = run('failed', { error: 'API Error: 400 bad' })
    const row = failedRunRow(auto(), [r], 'Builder')!
    expect(row).toMatchObject({ kind: 'failedRun', urgency: 'due', streak: 1, runId: r.id, ack: { kind: 'run', key: 'sweep', version: r.id } })
    expect(row.voice).toBe('Nightly sweep failed — the API rejected the request (400) · Builder')
  })

  it('a timeout waits for the 2nd in a row; a usage limit on a schedule too', () => {
    expect(failedRunRow(auto(), [run('failed', { error: 'timeout' })], 'Builder')).toBeNull()
    expect(failedRunRow(auto(), [run('failed', { error: 'timeout' }), run('failed', { error: 'timeout' })], 'Builder')?.voice).toBe(
      'Nightly sweep failed twice — it timed out after 30 min · Builder',
    )
    expect(failedRunRow(auto(), [run('failed', { error: 'usage limit reached' })], 'Builder')).toBeNull()
    expect(failedRunRow(auto(), [run('failed', { error: 'usage limit reached' }), run('failed', { error: 'usage limit reached' })], 'Builder')).not.toBeNull()
  })

  it('a usage limit with nothing scheduled after it enters at once', () => {
    const once = auto({ trigger: { kind: 'once', at: iso(NOW - 3_600_000) }, nextRunAt: undefined })
    expect(failedRunRow(once, [run('failed', { error: 'usage limit reached' })], 'Builder')).not.toBeNull()
    const hook = auto({ trigger: { kind: 'webhook', secret: 's' }, nextRunAt: undefined })
    expect(failedRunRow(hook, [run('failed', { error: 'usage limit reached' })], 'Builder')).not.toBeNull()
  })

  it('a Silos restart never enters on its own, but counts toward two in a row', () => {
    expect(failedRunRow(auto(), [run('failed', { error: 'interrupted by a server restart' })], 'Builder')).toBeNull()
    expect(failedRunRow(auto(), [run('failed', { error: 'timeout' }), run('failed', { error: 'interrupted by a server restart' })], 'Builder')?.streak).toBe(2)
  })

  it('heals: a newer ok run, a run on its way, waiting_reset, or a paused automation leave no row', () => {
    const bad = run('failed', { error: 'API Error: 400' })
    expect(failedRunRow(auto(), [run('ok'), bad], 'Builder')).toBeNull()
    expect(failedRunRow(auto(), [run('running'), bad], 'Builder')).toBeNull()
    expect(failedRunRow(auto(), [run('waiting_reset'), bad], 'Builder')).toBeNull()
    expect(failedRunRow(auto({ paused: true }), [bad], 'Builder')).toBeNull()
  })

  it('a fired `once` that failed is done (the resident parks it paused): no row — only armed automations ask', () => {
    const bad = run('failed', { error: 'API Error: 400' })
    expect(failedRunRow(auto({ trigger: { kind: 'once', at: iso(NOW - 3_600_000) }, paused: true }), [bad], 'Builder')).toBeNull()
    expect(failedRunRow(auto({ trigger: { kind: 'once', at: iso(NOW + 3_600_000) } }), [bad], 'Builder')).not.toBeNull()
  })

  it('Seen is this failure: a NEW failed run (a later one) carries a new version, so it shows again', () => {
    const first = run('failed', { error: 'API Error: 400' })
    const later = run('failed', { error: 'API Error: 400', at: iso(NOW) })
    const a = failedRunRow(auto(), [first], 'Builder')!
    const b = failedRunRow(auto(), [later, first], 'Builder')!
    expect(a.ack).toEqual({ kind: 'run', key: 'sweep', version: first.id })
    expect(b.ack).toEqual({ kind: 'run', key: 'sweep', version: later.id })
    const acked = (kind: string, key: string) => (kind === 'run' && key === 'sweep' ? first.id : null)
    expect(composeInbox({ ...empty, kernel: [a], ackedVersion: acked }).filter((r) => r.kind === 'failedRun')).toHaveLength(0)
    expect(composeInbox({ ...empty, kernel: [b], ackedVersion: acked }).filter((r) => r.kind === 'failedRun')).toHaveLength(1)
  })

  it('a budget skip neither heals nor breaks the streak', () => {
    const row = failedRunRow(auto(), [run('skipped'), run('failed', { error: 'timeout' }), run('skipped'), run('failed', { error: 'timeout' })], 'Builder')
    expect(row?.streak).toBe(2)
  })
})

describe('A3c — a retry that never happened', () => {
  const waiting = (resetsAt: number) => run('waiting_reset', { resetsAt: iso(resetsAt) })
  it('enters once the reset is more than two ticks behind and the wait is still the newest run', () => {
    const r = waiting(NOW - 2 * RESIDENT_TICK_MS - 1)
    const row = missedRetryRow(auto({ nextRunAt: r.resetsAt }), r, NOW, 'Builder')!
    expect(row).toMatchObject({ kind: 'missedRetry', urgency: 'due', runId: r.id, ack: { kind: 'run', key: 'sweep', version: r.id } })
    expect(row.voice).toMatch(/^Nightly sweep was due to retry at \d\d:\d\d and didn't · Builder$/)
  })
  it('not while the retry is still within two ticks, not when paused, not once a newer run exists', () => {
    const r = waiting(NOW - RESIDENT_TICK_MS)
    expect(missedRetryRow(auto({ nextRunAt: r.resetsAt }), r, NOW, 'Builder')).toBeNull()
    const old = waiting(NOW - 3_600_000)
    expect(missedRetryRow(auto({ paused: true }), old, NOW, 'Builder')).toBeNull()
    expect(missedRetryRow(auto(), run('ok'), NOW, 'Builder')).toBeNull()
  })
  it('a later nextRunAt (the resident re-booked it) moves the due time', () => {
    const r = waiting(NOW - 3_600_000)
    expect(missedRetryRow(auto({ nextRunAt: iso(NOW + 60_000) }), r, NOW, 'Builder')).toBeNull()
  })
})

// the control's rows, in their exact words
describe("the control's rows", () => {
  it('territory off: Only when told until it is on again (due)', () => {
    const row = territoryOffRow({ agentId: 'builder', agentName: 'Builder', now: NOW })
    expect(row).toMatchObject({ kind: 'territoryOff', urgency: 'due', agentId: 'builder' })
    expect(row.voice).toBe("Builder's territory turned off — it is Only when told until it is on again ›")
  })
  it('the cut: Silos stopped it from creating work on its own — its why (due, Seen by the cut)', () => {
    const row = cutRow({
      agentId: 'builder',
      agentName: 'Builder',
      cut: { at: '2026-11-10T09:00:00Z', why: "used the owner's credential in an unattended turn (x-token header)" },
      now: NOW,
    })
    expect(row.voice).toBe("Silos stopped Builder from creating work on its own — used the owner's credential in an unattended turn (x-token header)")
    expect(row.ack).toEqual({ kind: 'cut', key: 'builder', version: '2026-11-10T09:00:00Z' })
  })
  it('the ceiling and the spend cap: one row per agent and day, the max said as «started», and WHY under it', () => {
    const ceil = ownTurnsCeilingRow({
      agentId: 'builder',
      agentName: 'Builder',
      used: 10,
      perDay: 10,
      waiting: 3,
      until: 'x',
      day: localDay(NOW),
      now: NOW,
      cap: 'ceiling',
      starts: { wakes: 7, self: 3 },
    })
    expect(ceil.voice).toMatch(/^Builder started 10 times without you today — its max · 3 wait for tomorrow$/)
    expect(ceil).toMatchObject({ starts: { wakes: 7, self: 3 } })
    expect((ceil as { why: string }).why).toMatch(/^7 task starts · 3 runs of its own automations\. /)
    const spend = ownTurnsCeilingRow({
      agentId: 'builder',
      agentName: 'Builder',
      used: 3,
      perDay: 10,
      waiting: 0,
      until: 'x',
      day: localDay(NOW),
      now: NOW,
      cap: 'spend',
      spentUsd: 5.4,
      spent: { wakes: 3.1, heartbeat: 1.9, self: 0.4 },
    })
    expect(spend.voice).toBe('Builder spent $5.40 without you today — its cap')
    expect((spend as { why: string }).why).toBe('$3.10 task starts · $1.90 heartbeat · $0.40 its automations')
  })
  it('the why leaves a part that is zero out — the heartbeat is never a part of the max', () => {
    expect(ownCapWhy('ceiling', { wakes: 10, self: 0 })).toMatch(/^10 task starts\. /)
    expect(ownCapWhy('ceiling', { wakes: 0, self: 1 })).toMatch(/^1 run of its own automations\. /)
    expect(ownCapWhy('spend', undefined, { wakes: 0, heartbeat: 5, self: 0 })).toBe('$5.00 heartbeat')
    expect(ownCapWhy('ceiling')).toBe('')
  })
})

describe("messages unread past their recipient's next chance", () => {
  it('one row per recipient·sender: how many, from whom, for how long; Seen by its newest message', () => {
    const row = unreadMessagesRow({
      recipientId: 'builder',
      recipientName: 'Builder',
      from: 'finance',
      fromName: 'Finance',
      messages: [
        { id: 'm9', at: NOW - 30 * 3_600_000 },
        { id: 'm8', at: NOW - 26 * 3_600_000 },
      ],
      now: NOW,
    })!
    expect(row).toMatchObject({
      kind: 'unreadMessages',
      urgency: 'due',
      agentId: 'builder',
      from: 'finance',
      count: 2,
      messageIds: ['m9', 'm8'],
      ack: { kind: 'message', key: 'builder/finance', version: 'm8' },
    })
    expect(row.voice).toBe("Builder hasn't read 2 messages from Finance · 1 d")
    expect(row.clears).toBe('the messages are read or answered')
    const mine = unreadMessagesRow({
      recipientId: 'builder',
      recipientName: 'Builder',
      from: 'owner',
      fromName: 'owner',
      messages: [{ id: 'm1', at: NOW - 3 * 3_600_000 }],
      now: NOW,
    })!
    expect(mine.urgency).toBe('due')
    expect(mine.voice).toBe("Builder hasn't read 1 message from you · 3 h")
  })
  it('its provenance and the why of a missed heartbeat ride the row', () => {
    const row = unreadMessagesRow({
      recipientId: 'builder',
      recipientName: 'Builder',
      from: 'finance',
      fromName: 'Finance',
      messages: [{ id: 'm1', at: NOW - 3_600_000, readOutside: ['WebFetch'] }],
      why: 'sleeping',
      now: NOW,
    })!
    expect(row.voice).toBe("Builder hasn't read 1 message from Finance — sent after reading the web (WebFetch) · 1 h — it hasn't looked yet: it was sleeping")
    expect(unreadWhyOf({ status: 'skipped', heartbeat: { skipped: 'spend' } })).toBe('spend')
    expect(unreadWhyOf({ status: 'skipped', heartbeat: { skipped: 'account' } })).toBe('account')
    expect(unreadWhyOf({ status: 'failed' })).toBe('failed')
    expect(unreadWhyOf({ status: 'ok' })).toBe('failed')
  })
  it('waitedWords: minutes, hours, days', () => {
    expect(waitedWords(40 * 60_000)).toBe('40 min')
    expect(waitedWords(2 * 3_600_000 + 59 * 60_000)).toBe('2 h')
    expect(waitedWords(50 * 3_600_000)).toBe('2 d')
  })
})

describe('composeInbox — the composition Home used to do', () => {
  it('one row per conversation: a permission ask wins, then pendingAsk ∪ needs_you', () => {
    const permission: NeedsYouItem = {
      kind: 'ask',
      agentId: 'builder',
      sessionId: 's1',
      folder: 'f',
      id: 'p1',
      title: 'bash ls',
      pattern: 'ls',
      type: 'bash',
      at: iso(NOW),
    }
    const rows = composeInbox({
      ...empty,
      needsYou: [permission],
      asks: [
        { agentId: 'builder', folder: 'f', id: 's1', title: 'T', at: NOW, cwd: '/x' },
        { agentId: 'builder', folder: 'f', id: 's2', title: 'U', at: NOW, cwd: '/x' },
        { agentId: 'builder', folder: 'f', id: 's2', title: 'U', at: NOW, cwd: '/x' },
      ],
    })
    expect(rows.map((r) => r.key)).toEqual(['ask:f\0s1', 'ask:f\0s2'])
    expect(rows[0]).toMatchObject({ permission: { id: 'p1' }, cwd: '/x' })
  })

  it('orders blocking (asks, escalations, messages first) → due → routine, newest first within', () => {
    const rows = composeInbox({
      ...empty,
      asks: [{ agentId: 'builder', folder: 'f', id: 's1', title: 'T', at: NOW - 5000, cwd: null }],
      needsYou: [
        {
          kind: 'silo',
          reason: 'entry',
          silo: 'plans',
          siloName: 'Plans',
          key: 'folder:/x/p/tasks/t1',
          recordKind: 'plan/task',
          urgency: 'routine',
          text: 'approve — pending',
          at: '',
          file: '/x/plans/p.plan.json',
          parent: { key: 'folder:/x/p', kind: 'plan', identity: 'P', at: '' },
        },
        { kind: 'escalated', agentId: 'builder', summary: 'help', at: iso(NOW - 1000) },
        {
          kind: 'silo',
          reason: 'entry',
          silo: 'support',
          siloName: 'Support',
          key: 'agent:builder/c1',
          recordKind: 'case',
          urgency: 'due',
          text: '— — needs you',
          at: iso(NOW),
          agentId: 'builder',
          file: null,
          folded: true,
          noun: { one: 'support ticket', many: 'support tickets' },
        },
      ],
      pending: [run('waiting_approval', { at: iso(NOW - 100) })],
      automations: [auto()],
      kernel: [failedRunRow(auto({ id: 'b' }), [run('failed', { error: 'API Error: 400', automationId: 'b' })], 'Builder')!],
    })
    expect(rows.map((r) => r.kind)).toEqual(['escalated', 'ask', 'siloSummary', 'approval', 'failedRun', 'silo'])
    expect(rows.find((r) => r.kind === 'approval')).toMatchObject({
      agentId: 'builder',
      automation: { name: 'Nightly sweep' },
      voice: 'Builder wants your go to run Nightly sweep',
    })
  })

  // support is a silo: its due rows come folded with the kind's noun —
  // ONE row, counted per agent, in today's words
  it("the Support silo's folded rows are ONE summary that counts per agent, said with the kind's noun", () => {
    const sc = (agentId: string, caseId: string): NeedsYouItem => ({
      kind: 'silo',
      reason: 'entry',
      silo: 'support',
      siloName: 'Support',
      key: `agent:${agentId}/${caseId}`,
      recordKind: 'case',
      urgency: 'due',
      text: 'x',
      at: iso(NOW),
      agentId,
      file: null,
      folded: true,
      noun: { one: 'support ticket', many: 'support tickets' },
    })
    const rows = composeInbox({ ...empty, needsYou: [sc('builder', 'c1'), sc('builder', 'c2'), sc('finance', 'c3')] })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'siloSummary',
      urgency: 'due',
      count: 3,
      byAgent: { builder: 2, finance: 1 },
      voice: '3 support tickets wait on you',
    })
    expect(composeInbox({ ...empty, needsYou: [sc('builder', 'c1')] })[0]).toMatchObject({ voice: '1 support ticket waits on you' })
  })

  it('a silo lists due rows up to its budget, else one summary; blocking and submissions always listed', () => {
    const item = (over: Partial<SiloNeedsYou>): SiloNeedsYou => ({
      kind: 'silo',
      reason: 'entry',
      silo: 'invoices',
      siloName: 'Invoices',
      key: 'k',
      recordKind: 'invoice',
      urgency: 'due',
      text: 'overdue',
      at: iso(NOW),
      file: null,
      ...over,
    })
    const few = composeInbox({ ...empty, needsYou: [item({ key: 'a' }), item({ key: 'b' })] })
    expect(few.map((r) => r.kind)).toEqual(['silo', 'silo'])
    const many = Array.from({ length: SILO_INBOX_BUDGET + 1 }, (_, i) => item({ key: `k${i}`, agentId: 'finance' }))
    const rows = composeInbox({ ...empty, needsYou: [...many, item({ key: 'c', reason: 'conflict', urgency: 'blocking' })] })
    expect(rows.map((r) => r.kind)).toEqual(['silo', 'siloSummary'])
    expect(rows[1]).toMatchObject({ count: SILO_INBOX_BUDGET + 1, agentIds: ['finance'] })
    expect(rows[0]!.key).toBe('silo:conflict:invoices:c')
  })

  // G5 (plans phase 1): a sub-kind's rows — a plan's tasks — are never folded
  // by the budget nor by their fold: Home groups them by parent
  it('a sub-kind row (parent set) is listed one by one past the budget, folded or not, routine or due', () => {
    const task = (i: number, over: Partial<SiloNeedsYou> = {}): SiloNeedsYou => ({
      kind: 'silo',
      reason: 'entry',
      silo: 'plans',
      siloName: 'Plans',
      key: `folder:/p/q/tasks/t${i}`,
      recordKind: 'plan/task',
      urgency: 'routine',
      text: `t${i} — pending`,
      at: iso(NOW),
      file: '/p/plans/q.plan.json',
      parent: { key: 'folder:/p/q', kind: 'plan', identity: 'Q', at: iso(NOW) },
      ...over,
    })
    const many = Array.from({ length: SILO_INBOX_BUDGET + 3 }, (_, i) => task(i, i === 0 ? { folded: true } : i === 1 ? { urgency: 'due' } : {}))
    const rows = composeInbox({ ...empty, needsYou: many })
    expect(rows.every((r) => r.kind === 'silo')).toBe(true)
    expect(rows).toHaveLength(SILO_INBOX_BUDGET + 3)
    expect(rows[0]).toMatchObject({ urgency: 'due', key: 'silo:entry:plans:folder:/p/q/tasks/t1' })
    expect(rows.find((r) => r.kind === 'silo' && r.item.folded)).toBeDefined()
  })

  it('a folded row is counted in the summary, never listed; a submission is never folded', () => {
    const item = (over: Partial<SiloNeedsYou>): SiloNeedsYou => ({
      kind: 'silo',
      reason: 'entry',
      silo: 'invoices',
      siloName: 'Invoices',
      key: 'k',
      recordKind: 'invoice',
      urgency: 'due',
      text: 'overdue',
      at: iso(NOW),
      file: null,
      ...over,
    })
    expect(composeInbox({ ...empty, needsYou: [item({ folded: true })] })).toEqual([expect.objectContaining({ kind: 'siloSummary', count: 1 })])
    const sub = item({ reason: 'submission', silo: 'support', siloName: 'Support', key: 'submission' })
    const many = Array.from({ length: SILO_INBOX_BUDGET + 1 }, (_, i) => item({ silo: 'support', siloName: 'Support', key: `k${i}` }))
    const rows = composeInbox({ ...empty, needsYou: [sub, ...many] })
    expect(rows.filter((r) => r.kind === 'silo').map((r) => r.key)).toEqual(['silo:submission:support:submission'])
    expect(rows.find((r) => r.kind === 'silo')!.urgency).toBe('due')
  })
})

describe('the per-agent budget', () => {
  const failing = (i: number, agentId = 'builder') =>
    failedRunRow(
      auto({ id: `a${i}`, name: `Auto ${i}`, agentId }),
      [run('failed', { error: 'API Error: 400', automationId: `a${i}`, at: iso(NOW - i * 1000) })],
      nameOf(agentId),
    )!
  it(`${AGENT_INBOX_BUDGET} rows are listed; one more folds them into one line for the agent`, () => {
    const listed = composeInbox({ ...empty, kernel: [1, 2, 3].map((i) => failing(i)) })
    expect(listed.map((r) => r.kind)).toEqual(['failedRun', 'failedRun', 'failedRun'])
    const folded = composeInbox({ ...empty, kernel: [1, 2, 3, 4, 5].map((i) => failing(i)) })
    expect(folded).toHaveLength(1)
    expect(folded[0]).toMatchObject({ kind: 'agentSummary', agentId: 'builder', count: 5, runsOnly: true })
    expect(folded[0]!.voice).toBe('Builder: 5 automations failing — newest: Auto 1 (the API rejected the request (400))')
  })
  it("proposals are foldable with the agent's rows: ONE stays loose; several past the budget fold into «X suggests <n> things»", () => {
    const prop = (i: number) => ({
      id: `p${i}`,
      by: 'builder',
      at: iso(NOW - i * 1000),
      kind: 'automation' as const,
      reason: `why ${i}`,
      review: false,
      inputHash: 'h',
      words: { title: `thing ${i}` } as never,
    })
    const fails = [1, 2, 3].map((i) => failing(i))
    const one = composeInbox({ ...empty, kernel: fails, proposals: [prop(1)] })
    expect(one.filter((r) => r.kind === 'proposal')).toHaveLength(1)
    expect(one.find((r) => r.kind === 'proposalSummary')).toBeUndefined()
    const two = composeInbox({ ...empty, kernel: fails.slice(0, 2), proposals: [prop(1), prop(2)] })
    expect(two.filter((r) => r.kind === 'proposal')).toHaveLength(0)
    expect(two.find((r) => r.kind === 'proposalSummary')).toMatchObject({ agentId: 'builder', count: 2 })
    // within the budget everything stays loose
    const within = composeInbox({ ...empty, kernel: [failing(1)], proposals: [prop(1), prop(2)] })
    expect(within.filter((r) => r.kind === 'proposal')).toHaveLength(2)
  })
  it("the budget is per agent; unread messages fold with the agent's other due rows", () => {
    const unread = (i: number) =>
      unreadMessagesRow({
        recipientId: 'builder',
        recipientName: 'Builder',
        from: `a${i}`,
        fromName: `A${i}`,
        messages: [{ id: `m${i}`, at: NOW - 30 * 3_600_000 }],
        now: NOW,
      })!
    const rows = composeInbox({ ...empty, kernel: [...[1, 2, 3, 4].map(unread), failing(1, 'finance'), failing(2, 'finance')] })
    expect(rows.filter((r) => r.kind === 'unreadMessages')).toHaveLength(0)
    expect(rows.find((r) => r.kind === 'agentSummary')).toMatchObject({ agentId: 'builder', count: 4 })
    expect(rows.filter((r) => r.kind === 'failedRun')).toHaveLength(2)
  })
})

describe('Seen = this version', () => {
  it('a Seen row leaves; a new version of it comes back', () => {
    const first = failedRunRow(auto(), [run('failed', { error: 'API Error: 400' })], 'Builder')!
    const acks = new NeedsYouAcksStore(tmp('acks-'))
    acks.ack(first.ack!.kind, first.ack!.key, first.ack!.version)
    const ackedVersion = acks.ackedVersion.bind(acks)
    expect(composeInbox({ ...empty, kernel: [first], ackedVersion })).toEqual([])
    const second = failedRunRow(auto(), [run('failed', { error: 'API Error: 400' }), run('failed', { error: 'API Error: 400' })], 'Builder')!
    expect(composeInbox({ ...empty, kernel: [second], ackedVersion }).map((r) => r.kind)).toEqual(['failedRun'])
  })
  it('Seen rows never count toward the agent budget', () => {
    const rows = [1, 2, 3, 4].map((i) => failedRunRow(auto({ id: `a${i}` }), [run('failed', { error: 'API Error: 400', automationId: `a${i}` })], 'Builder')!)
    const acked = rows[0]!.ack!
    const out = composeInbox({ ...empty, kernel: rows, ackedVersion: (k, key) => (k === acked.kind && key === acked.key ? acked.version : null) })
    expect(out.map((r) => r.kind)).toEqual(['failedRun', 'failedRun', 'failedRun'])
  })
  it('an escalation carries its status `at` as the version', () => {
    const rows = composeInbox({ ...empty, needsYou: [{ kind: 'escalated', agentId: 'builder', summary: 's', at: iso(NOW) }] })
    expect(rows[0]!.ack).toEqual({ kind: 'escalated', key: 'builder', version: iso(NOW) })
  })
})

describe('ceiling and signature', () => {
  it('past 12 loud rows the ceiling names the count and the oldest wait; routine never counts', () => {
    const rows = Array.from({ length: 13 }, (_, i) => ({ urgency: 'due' as const, at: NOW - i * 1000 }))
    expect(inboxCeiling(rows)).toEqual({ count: 13, oldestAt: NOW - 12_000 })
    expect(inboxCeiling([...rows.slice(0, 12), { urgency: 'routine', at: 1 }])).toBeNull()
  })
  it("the signature moves with a row's version, not with time", () => {
    const a = failedRunRow(auto(), [run('failed', { error: 'API Error: 400' })], 'Builder')!
    const b: InboxRow = { ...a, at: a.at + 5 }
    expect(inboxSignature([a])).toBe(inboxSignature([b]))
    expect(inboxSignature([a])).not.toBe(inboxSignature([{ ...a, ack: { ...a.ack!, version: 'other' } }]))
  })
})

describe('NeedsYouAcksStore — the generalized Seen', () => {
  it('reads the old { escalated } file as before and keeps the other kinds beside it', () => {
    const dir = tmp('acks-')
    writeFileSync(join(dir, 'needs-you-acks.json'), JSON.stringify({ escalated: { builder: 'T1' } }))
    const s = new NeedsYouAcksStore(dir)
    s.load()
    expect(s.escalatedAckedAt('builder')).toBe('T1')
    s.ack('run', 'sweep', 'r9')
    s.ack('message', 'builder/m1', 'm1')
    expect(JSON.parse(readFileSync(join(dir, 'needs-you-acks.json'), 'utf8'))).toEqual({
      escalated: { builder: 'T1' },
      run: { sweep: 'r9' },
      message: { 'builder/m1': 'm1' },
    })
    const again = new NeedsYouAcksStore(dir)
    again.load()
    expect(again.ackedVersion('run', 'sweep')).toBe('r9')
    expect(again.ackedVersion('cut', 'builder')).toBeNull()
    expect(again.ackedVersion('run', 'toString')).toBeNull()
  })
})

describe('kernelInboxRows — the facts read from the real stores', () => {
  const builder: Agent = { id: 'builder', name: 'Builder', emoji: '🛠', role: '', folder: '/x', skills: [] }
  const finance: Agent = { id: 'finance', name: 'Finance', emoji: '💶', role: '', folder: '/y', skills: [] }
  let automations: AutomationsStore, agentState: AgentStateStore, messages: MessageStore
  beforeEach(() => {
    const dir = tmp('inbox-src-')
    automations = new AutomationsStore(dir)
    automations.load()
    agentState = new AgentStateStore(join(dir, 'agent-state'))
    messages = new MessageStore(dir)
  })

  it('a failing automation, a missed retry and messages to an agent without a heartbeat still unread after 24 h', () => {
    automations.create(auto({ id: 'a1', agentId: 'builder' }))
    automations.appendRun('a1', { id: 'x1', automationId: 'a1', at: iso(NOW - 60_000), status: 'failed', error: 'API Error: 400' })
    automations.create(auto({ id: 'a2', agentId: 'builder', nextRunAt: iso(NOW - 3_600_000) }))
    automations.appendRun('a2', { id: 'x2', automationId: 'a2', at: iso(NOW - 7_200_000), status: 'waiting_reset', resetsAt: iso(NOW - 3_600_000) })
    const m = messages.send({ from: 'builder', to: 'finance', text: 'look' })
    messages.send({ from: 'builder', to: 'finance', text: 'fyi' })
    const at = Date.parse(m.at)
    const now = Math.max(NOW, at + MESSAGE_UNREAD_ROW + 60_000)
    const rows = kernelInboxRows({ agents: [builder, finance], automations, agentState, messages, nameOf: agentNameOf([builder, finance]), now })
    expect(rows.map((r) => r.kind).sort()).toEqual(['failedRun', 'missedRetry', 'unreadMessages'])
    const unread = rows.find((r) => r.kind === 'unreadMessages')!
    expect(unread).toMatchObject({ agentId: 'finance', from: 'builder', count: 2 })
    expect(unread.voice).toBe(`Finance hasn't read 2 messages from Builder · ${waitedWords(now - at)}`)
  })

  it('told / own·never: no row before 24 h, a row at 24 h that counts, gone once read', () => {
    const m = messages.send({ from: 'builder', to: 'finance', text: 'look' })
    const at = Date.parse(m.at)
    const unreadAt = (now: number) =>
      kernelInboxRows({ agents: [builder, finance], messages, agentState, nameOf: agentNameOf([builder, finance]), now }).filter(
        (r) => r.kind === 'unreadMessages',
      )
    expect(unreadAt(at + 60_000)).toEqual([])
    expect(unreadAt(at + MESSAGE_UNREAD_ROW - 1)).toEqual([])
    expect(unreadAt(at + MESSAGE_UNREAD_ROW)).toHaveLength(1)
    messages.setState('finance', m.id, 'read')
    expect(unreadAt(at + MESSAGE_UNREAD_ROW + 60_000)).toEqual([])
  })

  it.each([
    ['busy', /it was busy/],
    ['engine', /its engine couldn't run/],
    ['spend', /its spend cap was reached/],
  ] as const)("the unread row's why for a heartbeat skipped %s", (skipped, words) => {
    const why = unreadWhyOf({ status: 'skipped', heartbeat: { skipped } })
    expect(why).toBe(skipped)
    const row = unreadMessagesRow({
      recipientId: 'finance',
      recipientName: 'FINANCE',
      from: 'builder',
      fromName: 'BUILDER',
      messages: [{ id: 'm1', at: NOW - 3600_000 }],
      why,
      now: NOW,
    })!
    expect(row.voice).toMatch(words)
    expect(row.voice).not.toMatch(/ceiling/)
  })

  it('own·day/week: no row while its next heartbeat has not come — whatever the age; after one that passed without marking it, a row that says why', () => {
    const m = messages.send({ from: 'builder', to: 'finance', text: 'look' })
    const at = Date.parse(m.at)
    automations.create(auto({ id: 'heartbeat-finance', name: 'Heartbeat', agentId: 'finance', origin: 'heartbeat' }))
    const deps = (now: number) => ({
      agents: [builder, finance],
      messages,
      automations,
      nameOf: agentNameOf([builder, finance]),
      now,
      heartbeatLooks: (a: Agent) => a.id === 'finance',
      heartbeatRuns: (id: string) => automations.listRuns(`heartbeat-${id}`, 20),
    })
    const unreadAt = (now: number) => kernelInboxRows(deps(now)).filter((r) => r.kind === 'unreadMessages')
    // a heartbeat BEFORE the message is no chance to read it; 3 days without one: still nothing
    automations.appendRun('heartbeat-finance', { id: 'h0', automationId: 'heartbeat-finance', at: iso(at - 60_000), startedAt: iso(at - 60_000), status: 'ok' })
    expect(unreadAt(at + 3 * 24 * 3_600_000)).toEqual([])
    // its next heartbeat was skipped asleep: the row says so
    automations.appendRun('heartbeat-finance', {
      id: 'h1',
      automationId: 'heartbeat-finance',
      at: iso(at + 3_600_000),
      startedAt: iso(at + 3_600_000),
      status: 'skipped',
      heartbeat: { kind: 'look', packet: { keys: [] }, created: [], proposed: [], considered: 0, skipped: 'sleeping' },
    } as never)
    const rows = unreadAt(at + 2 * 3_600_000)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ why: 'sleeping' })
    expect(rows[0]!.voice).toMatch(/it hasn't looked yet: it was sleeping$/)
  })

  it('an own agent whose territory is off: one due row (the degradation, G5-r7)', () => {
    const rows = kernelInboxRows({
      agents: [builder, finance],
      nameOf: (id) => (id === 'builder' ? 'Builder' : 'Finance'),
      now: NOW,
      degradedWhy: (a) => (a.id === 'builder' ? 'territory' : null),
    })
    expect(rows.filter((r) => r.kind === 'territoryOff').map((r) => r.agentId)).toEqual(['builder'])
  })

  it('a run whose transcript could not be audited: a visible due row, Seen by that run (fail closed, never silent)', () => {
    automations.create(auto({ id: 'heartbeat-builder', name: 'Heartbeat', agentId: 'builder', origin: 'heartbeat' }))
    automations.appendRun('heartbeat-builder', {
      id: 'h1',
      automationId: 'heartbeat-builder',
      at: iso(NOW - 60_000),
      status: 'ok',
      audit: { readOutside: ['transcript unreadable'] },
    })
    automations.create(auto({ id: 'a2', agentId: 'finance' }))
    automations.appendRun('a2', { id: 'x2', automationId: 'a2', at: iso(NOW - 60_000), status: 'ok', audit: { readOutside: ['WebFetch'] } })
    const rows = kernelInboxRows({ agents: [builder, finance], automations, nameOf: agentNameOf([builder, finance]), now: NOW })
    expect(rows.map((r) => r.kind)).toEqual(['auditUnreadable'])
    expect(rows[0]).toMatchObject({
      agentId: 'builder',
      runId: 'h1',
      heartbeat: true,
      urgency: 'due',
      ack: { kind: 'audit', key: 'heartbeat-builder', version: 'h1' },
    })
    expect(rows[0]!.voice).toBe(
      "Silos couldn't read the transcript of Builder's heartbeat — transcript unreadable, so it counts as having read outside — what it created is undone",
    )
  })

  it("an archived agent's automation is never a row (only live agents are passed)", () => {
    automations.create(auto({ id: 'a1', agentId: 'gone' }))
    automations.appendRun('a1', { id: 'x1', automationId: 'a1', at: iso(NOW), status: 'failed', error: 'API Error: 400' })
    expect(kernelInboxRows({ agents: [builder], automations, nameOf, now: NOW })).toEqual([])
  })
})

describe('GET /api/board inbox + POST /api/needs-you/ack', () => {
  const TOKEN = 'testtoken'
  const H = { 'x-token': TOKEN }
  let app: FastifyInstance, automations: AutomationsStore, dataDir: string

  beforeEach(async () => {
    const base = tmp('inbox-api-')
    const root = join(base, 'projects')
    dataDir = join(base, 'data')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(dataDir, 'trash'), { recursive: true })
    const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(dataDir, 'agents.json'))
    registry.load()
    registry.create({ id: 'builder', name: 'Builder', folder: '/tmp/project-x', skills: [] })
    const store = new SessionStore(root, dataDir)
    const native = new NativeStore(join(dataDir, 'native.json'))
    const chat = new ChatService({
      registry,
      native,
      queryFn: () => ({
        async *[Symbol.asyncIterator]() {},
        async interrupt() {
          return undefined
        },
      }),
    })
    const agentState = new AgentStateStore(join(dataDir, 'agent-state'))
    const needsYouAcks = new NeedsYouAcksStore(dataDir)
    needsYouAcks.load()
    automations = new AutomationsStore(dataDir)
    automations.load()
    // the fixture's engine is WIRED (the real installer): without it every
    // claude-code agent here would earn the engineUnwired row (inbox.ts)
    const settingsPath = join(dataDir, 'claude-settings.json')
    installSilosHooks(settingsPath, join(dataDir, 'backups'), PLUGIN_HOOKS_DIR)
    app = buildServer({
      claudeSettingsPath: settingsPath,
      index,
      registry,
      store,
      native,
      chat,
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(dataDir),
      memory: new MemoryService(root, dataDir, registry),
      token: TOKEN,
      liveMs: 120_000,
      agentState,
      needsYouAcks,
      automations,
    })
  })

  const inbox = async () => (await app.inject({ url: '/api/board', headers: H })).json().inbox as InboxRow[]
  const ack = (payload: unknown) => app.inject({ method: 'POST', url: '/api/needs-you/ack', headers: H, payload })

  it('a failed run rides the board as an inbox row; Seen hides THAT run, a new failure returns', async () => {
    automations.create(auto({ id: 'a1', agentId: 'builder' }))
    automations.appendRun('a1', { id: 'x1', automationId: 'a1', at: new Date().toISOString(), status: 'failed', error: 'API Error: 400' })
    const rows = await inbox()
    expect(rows.map((r) => r.kind)).toEqual(['failedRun'])
    expect(app.composeInbox().map((r) => r.key)).toEqual(rows.map((r) => r.key))
    expect((await ack(rows[0]!.ack)).statusCode).toBe(204)
    expect(await inbox()).toEqual([])
    automations.appendRun('a1', { id: 'x2', automationId: 'a1', at: new Date().toISOString(), status: 'failed', error: 'API Error: 400' })
    expect((await inbox()).map((r) => r.kind)).toEqual(['failedRun'])
  })

  it('the old escalation body still works; bad kinds, keys and versions are 400', async () => {
    expect((await ack({ kind: 'escalated', agentId: 'builder', at: 'T1' })).statusCode).toBe(204)
    expect((await ack({ kind: 'cut', key: 'builder', version: '2026-10-31' })).statusCode).toBe(204)
    expect((await ack({ kind: 'message', key: 'builder/m-1', version: 'm-1' })).statusCode).toBe(204)
    expect((await ack({ kind: 'plan', key: 'x', version: 'y' })).statusCode).toBe(400)
    expect((await ack({ kind: 'run', key: '../x', version: 'y' })).statusCode).toBe(400)
    expect((await ack({ kind: 'run', key: 'a/b', version: 'y' })).statusCode).toBe(400)
    expect((await ack({ kind: 'run', key: 'a1', version: '' })).statusCode).toBe(400)
    expect((await ack({ kind: 'message', key: 'builder/m/1', version: 'v' })).statusCode).toBe(400)
  })
})

// A plan task of yours: `due` when an agent's task waits on it
// directly or its own date is a week away or past, said in the voice; `at` =
// the due date's local midnight. Everything else stays routine.
