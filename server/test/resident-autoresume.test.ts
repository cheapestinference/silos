// auto-resume for interactive chats: the resident's heartbeat retries
// interactive, rate-limited turns persisted by server.ts. Success -> the
// record gets deleted; a repeated limit -> re-arms (attempts++, a new
// resetsAt) up to MAX; a session that has moved on (the owner replied by
// hand) -> gets released without resending.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRegistry } from '../src/agent-registry.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AutomationsStore } from '../src/automations-store.js'
import { ProvidersStore } from '../src/providers-store.js'
import { PendingResumesStore, type PendingResume } from '../src/pending-resumes-store.js'
import { Resident, MAX_RESUME_ATTEMPTS } from '../src/resident.js'
import type { QueryArgs, SdkMessage, SdkQueryHandle } from '../src/harnesses/claude-code/sdk-types.js'
import type { SessionMeta } from '../src/types.js'

let base: string, root: string, dataDir: string
let registry: AgentRegistry, chat: ChatService, providers: ProvidersStore, pending: PendingResumesStore
let calls: QueryArgs[]
let script: SdkMessage[]
let clock: Date
let residents: Resident[]
let broadcasts: unknown[]
let metaOverride: ((folder: string, id: string) => SessionMeta | null) | null

const successScript = (sessionId: string): SdkMessage[] => [
  { type: 'system', subtype: 'init', session_id: sessionId },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'done' } } },
  { type: 'result', subtype: 'success', total_cost_usd: 0 },
]

const limitedScript = (sessionId: string, resetsAtMs: number): SdkMessage[] => [
  { type: 'system', subtype: 'init', session_id: sessionId },
  { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: resetsAtMs, rateLimitType: 'five_hour' } } as unknown as SdkMessage,
  { type: 'result', subtype: 'error_during_execution', total_cost_usd: 0 },
]

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'deck-autoresume-'))
  root = join(base, 'projects')
  dataDir = join(base, 'data')
  mkdirSync(root, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(join(base, 'project'), { recursive: true })
  registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  providers = new ProvidersStore(dataDir)
  providers.load()
  registry.create({ id: 'finance', name: 'FINANCE', folder: join(base, 'project') })
  calls = []
  clock = new Date('2026-08-21T16:00:00.000Z')
  script = successScript('sess-1')
  chat = new ChatService({
    registry,
    native: new NativeStore(join(dataDir, 'native.json')),
    queryFn: (args) => {
      calls.push(args)
      const s = script
      return {
        async *[Symbol.asyncIterator]() {
          for (const m of s) yield m
        },
        async interrupt() {
          return undefined
        },
      } as SdkQueryHandle
    },
    dataDir,
    providers,
  })
  pending = new PendingResumesStore(dataDir)
  pending.load()
  broadcasts = []
  metaOverride = null
  residents = []
})
afterEach(() => {
  for (const r of residents) r.stop()
})

function mkResident(): Resident {
  const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  if (metaOverride) index.getMeta = metaOverride as typeof index.getMeta
  const r = new Resident({
    store: new AutomationsStore(dataDir),
    registry,
    chat,
    native: new NativeStore(join(dataDir, 'native.json')),
    index,
    root,
    dataDir,
    broadcast: (m) => broadcasts.push(m),
    now: () => clock,
    claudeSessionsDir: join(base, 'no-claude-sessions'),
    tickIntervalMs: 999_999_999,
    pendingResumes: pending,
  })
  residents.push(r)
  return r
}

function rec(overrides: Partial<PendingResume> = {}): PendingResume {
  return {
    agentId: 'finance',
    folder: '-proj',
    sessionId: 'sess-1',
    text: 'carry on with the task',
    resetsAt: clock.toISOString(),
    resumeAt: clock.toISOString(),
    createdAt: new Date(clock.getTime() - 3600_000).toISOString(),
    attempts: 0,
    ...overrides,
  }
}

describe('Resident — auto-resume for interactive chats', () => {
  it('resends once resumeAt has passed and, on a successful outcome, deletes the record (and emits removed over WS)', async () => {
    pending.upsert(rec())
    const resident = mkResident()
    script = successScript('sess-1')
    await resident.tick(clock)
    await resident.drain()

    expect(calls.length).toBe(1) // the turn was resent
    expect(calls[0]?.options.resume).toBe('sess-1') // an append to the SAME session
    expect(pending.get('-proj', 'sess-1')).toBeNull() // record fulfilled
    expect(broadcasts).toContainEqual({ ev: 'pending-resume-removed', folder: '-proj', id: 'sess-1' })
  })

  it('does NOT resend if resumeAt has not passed yet', async () => {
    pending.upsert(rec({ resumeAt: new Date(clock.getTime() + 3600_000).toISOString() }))
    const resident = mkResident()
    await resident.tick(clock)
    await resident.drain()
    expect(calls.length).toBe(0)
    expect(pending.get('-proj', 'sess-1')).not.toBeNull() // still waiting, honestly
  })

  it('if the resend hits the limit again, re-arms with the new resetsAt and attempts++', async () => {
    pending.upsert(rec())
    const resident = mkResident()
    const newReset = clock.getTime() + 2 * 3600_000
    script = limitedScript('sess-1', newReset)
    await resident.tick(clock)
    await resident.drain()

    const r = pending.get('-proj', 'sess-1')
    expect(r).not.toBeNull()
    expect(r?.attempts).toBe(1)
    expect(r?.resetsAt).toBe(new Date(newReset).toISOString())
    // no fallback armed: resumeAt = the new reset (wait), not "now"
    expect(r?.resumeAt).toBe(new Date(newReset).toISOString())
    expect(broadcasts.some((b) => (b as { ev?: string }).ev === 'pending-resume')).toBe(true)
  })

  it('reaching MAX_RESUME_ATTEMPTS does NOT silently delete the record — it leaves an honest TERMINAL state (gaveUp) for the banner to show', async () => {
    // a record already at attempts = MAX-1: the next rate limit pushes it over the cap
    pending.upsert(rec({ attempts: MAX_RESUME_ATTEMPTS - 1 }))
    const resident = mkResident()
    script = limitedScript('sess-1', clock.getTime() + 3600_000)
    await resident.tick(clock)
    await resident.drain()
    const r = pending.get('-proj', 'sess-1')
    expect(r).not.toBeNull() // does NOT disappear: the promise is never broken silently
    expect(r?.gaveUp).toEqual({ reason: 'max-attempts', tries: MAX_RESUME_ATTEMPTS })
    // and a given-up record is NOT retried on later ticks (terminal)
    const callsBefore = calls.length
    await resident.tick(clock)
    await resident.drain()
    expect(calls.length).toBe(callsBefore)
  })

  it('a session that has moved on (the owner replied by hand): releases the record without resending the same turn', async () => {
    pending.upsert(rec({ turnCount: 4, mtime: 1000 }))
    // the index sees the session with MORE turns than the record's snapshot
    metaOverride = () => ({ id: 'sess-1', folder: '-proj', title: 't', skills: [], cwd: null, mtime: 2000, size: 1, turnCount: 9 })
    const resident = mkResident()
    await resident.tick(clock)
    await resident.drain()
    expect(calls.length).toBe(0) // NOT resent: the conversation already moved on
    expect(pending.get('-proj', 'sess-1')).toBeNull()
  })

  it('a NON-rate-limit error gives up with an honest terminal state (gaveUp), not a silent delete', async () => {
    pending.upsert(rec())
    const resident = mkResident()
    // a result with neither success nor a rate limit -> chat-done subtype != success (not ok, not rejected)
    script = [
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      { type: 'result', subtype: 'error_during_execution', total_cost_usd: 0 },
    ]
    await resident.tick(clock)
    await resident.drain()
    const r = pending.get('-proj', 'sess-1')
    expect(r?.gaveUp?.reason).toBe('error')
  })

  it('an unrecoverable destination (an archived agent) -> gaveUp, not a silent disappearance', async () => {
    pending.upsert(rec({ agentId: 'finance', attempts: 2 }))
    registry.archive('finance')
    const resident = mkResident()
    await resident.tick(clock)
    await resident.drain()
    const r = pending.get('-proj', 'sess-1')
    expect(r?.gaveUp).toEqual({ reason: 'unrecoverable', tries: 2 })
    expect(calls.length).toBe(0) // never even called the SDK
  })
})

// the resume sweep must not stampede or escape the daily budget that
// automations respect.
describe('Resident — auto-resume throttle + budget', () => {
  function mkResidentCaps(caps: { resumeBatchPerTick?: number; resumeDailyBudget?: number }): Resident {
    const r = new Resident({
      store: new AutomationsStore(dataDir),
      registry,
      chat,
      native: new NativeStore(join(dataDir, 'native.json')),
      index: claudeSessionIndex(root, join(dataDir, 'cache.json')),
      root,
      dataDir,
      broadcast: (m) => broadcasts.push(m),
      now: () => clock,
      claudeSessionsDir: join(base, 'no-claude-sessions'),
      tickIntervalMs: 999_999_999,
      pendingResumes: pending,
      ...caps,
    })
    residents.push(r)
    return r
  }

  function seedNDue(n: number): void {
    for (let i = 0; i < n; i++) pending.upsert(rec({ sessionId: `s${i}` }))
  }

  it('throttle: N due at once -> at most resumeBatchPerTick get resent per tick', async () => {
    seedNDue(5)
    const resident = mkResidentCaps({ resumeBatchPerTick: 2, resumeDailyBudget: 999 })
    script = successScript('x') // the ones that fire come back OK and get cleared
    await resident.tick(clock)
    await resident.drain()
    expect(calls.length).toBe(2) // only 2 of the 5 fired this tick
    expect(pending.list().length).toBe(3) // the other 3 are still waiting
  })

  it('daily budget: once exhausted, nothing more fires that day even with due records left', async () => {
    seedNDue(5)
    const resident = mkResidentCaps({ resumeBatchPerTick: 10, resumeDailyBudget: 3 })
    script = successScript('x')
    await resident.tick(clock)
    await resident.drain()
    expect(calls.length).toBe(3) // the daily budget caps at 3, not 5

    // a second tick on the SAME day fires nothing more (budget exhausted)
    await resident.tick(clock)
    await resident.drain()
    expect(calls.length).toBe(3)

    // the next day the budget resets and the remaining 2 can resume
    clock = new Date(clock.getTime() + 24 * 3600_000)
    await resident.tick(clock)
    await resident.drain()
    expect(calls.length).toBe(5)
  })
})
