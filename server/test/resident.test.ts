import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRegistry, mungePath } from '../src/agent-registry.js'
import { NativeStore } from '../src/native-store.js'
import { LineageStore } from '../src/lineage.js'
import { ChatService } from '../src/chat-service.js'
import type { SessionIndex } from '../src/session-index.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AutomationsStore } from '../src/automations-store.js'
import { SessionOriginsStore } from '../src/session-origins'
import { Resident, RUN_OUTCOME_INSTRUCTION, parseRunOutcome, withOutcomeInstruction } from '../src/resident.js'
import { nextRun } from '../src/cron.js'
import type { QueryArgs, SdkMessage, SdkQueryHandle } from '../src/harnesses/claude-code/sdk-types.js'
import type { Automation } from '../src/automations-types.js'

let base: string, root: string, dataDir: string, agentFolder: string
let registry: AgentRegistry, native: NativeStore, index: SessionIndex, store: AutomationsStore, chat: ChatService, lineage: LineageStore
let calls: QueryArgs[]
let broadcasts: unknown[]
let script: SdkMessage[]
let clock: Date

function fakeQuery(): (args: QueryArgs) => SdkQueryHandle {
  return (args) => {
    calls.push(args)
    return {
      async *[Symbol.asyncIterator]() {
        for (const m of script) yield m
      },
      async interrupt() {
        return undefined
      },
    }
  }
}

const successScript = (sessionId: string): SdkMessage[] => [
  { type: 'system', subtype: 'init', session_id: sessionId },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'done' } } },
  { type: 'result', subtype: 'success', total_cost_usd: 0.001 },
]

let activeResidents: Resident[] = []
function mkResident(overrides: Partial<ConstructorParameters<typeof Resident>[0]> = {}): Resident {
  const r = new Resident({
    store,
    registry,
    chat,
    native,
    index,
    root,
    dataDir,
    lineage,
    broadcast: (m) => broadcasts.push(m),
    now: () => clock,
    claudeSessionsDir: join(base, 'no-claude-sessions'),
    tickIntervalMs: 999_999_999,
    ...overrides,
  })
  activeResidents.push(r)
  return r
}

function mkAutomation(overrides: Partial<Automation> & Pick<Automation, 'id' | 'trigger'>): Automation {
  return {
    name: 'Auto ' + overrides.id,
    agentId: 'finance',
    prompt: 'do the task',
    thread: { mode: 'new' },
    approval: false,
    keepAlive: false,
    paused: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for the condition')
    await new Promise((r) => setTimeout(r, 30))
  }
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'deck-resident-'))
  root = join(base, 'projects')
  dataDir = join(base, 'data')
  agentFolder = join(base, 'project')
  mkdirSync(root, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(agentFolder, { recursive: true })
  registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  registry.create({ id: 'finance', name: 'FINANCE', folder: agentFolder })
  native = new NativeStore(join(dataDir, 'native.json'))
  lineage = new LineageStore(join(dataDir, 'lineage.json'))
  index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  store = new AutomationsStore(dataDir)
  store.load()
  calls = []
  broadcasts = []
  clock = new Date('2026-08-19T09:00:00.000Z')
  script = successScript('sess-1')
  chat = new ChatService({ registry, native, queryFn: fakeQuery(), dataDir })
  activeResidents = []
})

afterEach(() => {
  for (const r of activeResidents) r.stop()
})

describe('Resident.tick — cron runs via a fake queryFn', () => {
  it('the first tick only sets nextRunAt; the tick where it comes due runs it', async () => {
    store.create(mkAutomation({ id: 'r1', trigger: { kind: 'cron', expr: '0 9 * * *' } }))
    const resident = mkResident()
    await resident.tick(clock)
    expect(calls).toHaveLength(0)
    const next = store.get('r1')?.nextRunAt
    expect(next).toBeDefined()

    clock = new Date(next as string)
    await resident.tick(clock)
    await resident.drain()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.prompt).toBe(`do the task\n\n${RUN_OUTCOME_INSTRUCTION}`)
    expect(store.listRuns('r1')[0]?.status).toBe('ok')
    expect(store.get('r1')?.lastRun?.status).toBe('ok')
  })

  it('a paused automation never runs in tick()', async () => {
    store.create(mkAutomation({ id: 'r1p', trigger: { kind: 'cron', expr: '* * * * *' }, paused: true }))
    const resident = mkResident()
    await resident.tick(clock)
    await resident.tick(new Date(clock.getTime() + 3600_000))
    expect(calls).toHaveLength(0)
    expect(store.get('r1p')?.nextRunAt).toBeUndefined()
  })
})

describe('Resident — thread keep vs new', () => {
  it('new: every run is a new session (resume is never passed)', async () => {
    store.create(mkAutomation({ id: 'r2', trigger: { kind: 'cron', expr: '* * * * *' }, thread: { mode: 'new' } }))
    const resident = mkResident()
    await resident.tick(clock)
    clock = new Date(store.get('r2')!.nextRunAt as string)
    script = successScript('sess-a')
    await resident.tick(clock)
    await resident.drain()
    expect(calls[0]?.options.resume).toBeUndefined()

    clock = new Date(store.get('r2')!.nextRunAt as string)
    script = successScript('sess-b')
    await resident.tick(clock)
    await resident.drain()
    expect(calls[1]?.options.resume).toBeUndefined()
    expect(store.get('r2')?.thread).toEqual({ mode: 'new' }) // 'new' never stores a sessionId
  })

  it('keep: the first time creates a session and saves it; the second time appends onto the SAME session', async () => {
    store.create(mkAutomation({ id: 'r3', trigger: { kind: 'cron', expr: '* * * * *' }, thread: { mode: 'keep' } }))
    const resident = mkResident()
    await resident.tick(clock)
    clock = new Date(store.get('r3')!.nextRunAt as string)
    script = successScript('sess-keep')
    await resident.tick(clock)
    await resident.drain()
    expect(calls[0]?.options.resume).toBeUndefined()
    expect(store.get('r3')?.thread).toEqual({ mode: 'keep', sessionId: 'sess-keep' })

    clock = new Date(store.get('r3')!.nextRunAt as string)
    await resident.tick(clock)
    await resident.drain()
    expect(calls[1]?.options.resume).toBe('sess-keep')
    expect(calls[1]?.options.forkSession).toBeUndefined() // keep = append, NEVER fork
  })

  // A keep thread's post-turn persist writes from the snapshot the run
  // STARTED with. autonomy.reconcile() runs every tick, including while a
  // run is in flight, and every transition it makes (mission done →
  // re-decide, mission → standing, a new mission) rewrites the prompt AND
  // reopens the thread. Without an epoch check the run that is just
  // finishing writes its own (now superseded) sessionId back, and the very
  // next beat resumes a conversation reconcile deliberately closed.
  it('keep: a mid-run reconcile that reopens the thread is NOT undone by the finishing run', async () => {
    const id = 'epoch1'
    store.create(mkAutomation({ id, trigger: { kind: 'cron', expr: '* * * * *' }, thread: { mode: 'keep' } }))
    const reconciling = new ChatService({
      registry,
      native,
      dataDir,
      queryFn: (args) => {
        calls.push(args)
        return {
          async *[Symbol.asyncIterator]() {
            for (const m of script) {
              // mid-turn: reconcile decides this mission is over
              if (m.type === 'result') store.update(id, { prompt: 'the re-decide prompt', thread: { mode: 'keep' } })
              yield m
            }
          },
          async interrupt() {
            return undefined
          },
        }
      },
    })
    const resident = mkResident({ chat: reconciling })
    await resident.tick(clock)
    clock = new Date(store.get(id)!.nextRunAt as string)
    script = successScript('sess-superseded')
    await resident.tick(clock)
    await resident.drain()

    expect(store.get(id)!.thread).toEqual({ mode: 'keep' }) // still the fresh thread reconcile opened
    expect(store.get(id)!.prompt).toBe('the re-decide prompt')
    expect(store.listRuns(id)[0]?.status).toBe('ok') // the run itself still finishes normally
  })

  it('keep: with no reconcile in between (prompt unchanged), the sessionId IS persisted', async () => {
    store.create(mkAutomation({ id: 'epoch2', trigger: { kind: 'cron', expr: '* * * * *' }, thread: { mode: 'keep' } }))
    const resident = mkResident()
    await resident.tick(clock)
    clock = new Date(store.get('epoch2')!.nextRunAt as string)
    script = successScript('sess-live')
    await resident.tick(clock)
    await resident.drain()
    expect(store.get('epoch2')!.thread).toEqual({ mode: 'keep', sessionId: 'sess-live' })
  })

  it('default isolation: settingSources=[user] + disableAllHooks; inheritHooks:true turns it off', async () => {
    store.create(mkAutomation({ id: 'iso1', trigger: { kind: 'cron', expr: '* * * * *' } }))
    store.create(mkAutomation({ id: 'iso2', trigger: { kind: 'cron', expr: '* * * * *' }, inheritHooks: true }))
    const resident = mkResident()
    await resident.tick(clock)
    const t1 = new Date(store.get('iso1')!.nextRunAt as string)
    await resident.tick(t1)
    await resident.drain()
    expect(calls[0]?.options.settingSources).toEqual(['user'])
    expect(calls[0]?.options.settings).toEqual({ disableAllHooks: true })

    await resident.tick(clock)
    const t2 = new Date(store.get('iso2')!.nextRunAt as string)
    await resident.tick(t2)
    await resident.drain()
    // iso2 (inheritHooks:true) used ChatService's default (user/project/local), no isolation
    expect(calls[1]?.options.settingSources).toEqual(['user', 'project', 'local'])
    expect('settings' in calls[1]!.options).toBe(false)
  })

  // An autonomy beat runs the skills installed in the agent's own folder —
  // the SDK only discovers .claude/skills with the 'project' source. Hooks
  // stay off either way.
  it('projectSettings widens an isolated run to [user, project]; a plain automation stays [user]', async () => {
    store.create(mkAutomation({ id: 'auto-resp-finance', trigger: { kind: 'cron', expr: '* * * * *' }, thread: { mode: 'keep' }, projectSettings: true }))
    store.create(mkAutomation({ id: 'plain1', trigger: { kind: 'cron', expr: '* * * * *' } }))
    const resident = mkResident()
    await resident.tick(clock)
    await resident.tick(new Date(store.get('auto-resp-finance')!.nextRunAt as string))
    await resident.drain()
    expect(calls[0]?.options.settingSources).toEqual(['user', 'project'])
    expect(calls[0]?.options.settings).toEqual({ disableAllHooks: true })

    await resident.tick(new Date(store.get('plain1')!.nextRunAt as string))
    await resident.drain()
    expect(calls[1]?.options.settingSources).toEqual(['user'])
    expect(calls[1]?.options.settings).toEqual({ disableAllHooks: true })
  })
})

describe('Resident — pause/resume own the switch', () => {
  it('both clear the platform auto-pause marker', async () => {
    store.create(mkAutomation({ id: 'ap1', trigger: { kind: 'cron', expr: '0 9 * * *' }, paused: true, autoPaused: true }))
    const resident = mkResident()
    expect(resident.resume('ap1').autoPaused).toBeUndefined()
    expect(store.get('ap1')!.paused).toBe(false)
    expect(resident.pause('ap1').autoPaused).toBeUndefined()
    expect(store.get('ap1')!.paused).toBe(true)
  })
})

describe('Resident — collision with a terminal', () => {
  it('a session with a live pid in ~/.claude/sessions/*.json -> the run is skipped, reason "session open in terminal"', async () => {
    const sessionsDir = join(base, 'claude-sessions-alive')
    mkdirSync(sessionsDir, { recursive: true })
    writeFileSync(join(sessionsDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'sess-terminal' }))

    store.create(mkAutomation({ id: 'coll1', trigger: { kind: 'cron', expr: '* * * * *' }, thread: { mode: 'keep', sessionId: 'sess-terminal' } }))
    const resident = mkResident({ claudeSessionsDir: sessionsDir })
    await resident.tick(clock)
    clock = new Date(store.get('coll1')!.nextRunAt as string)
    await resident.tick(clock)
    await resident.drain()

    expect(calls).toHaveLength(0) // never called the SDK
    const run = store.listRuns('coll1')[0]
    expect(run?.status).toBe('skipped')
    expect(run?.reason).toBe('session open in terminal')
  })

  it('a dead pid in the registry -> does NOT block, resumes normally', async () => {
    const sessionsDir = join(base, 'claude-sessions-dead')
    mkdirSync(sessionsDir, { recursive: true })
    writeFileSync(join(sessionsDir, 'x.json'), JSON.stringify({ pid: 999999, sessionId: 'sess-terminal-2' }))

    store.create(mkAutomation({ id: 'coll2', trigger: { kind: 'cron', expr: '* * * * *' }, thread: { mode: 'keep', sessionId: 'sess-terminal-2' } }))
    const resident = mkResident({ claudeSessionsDir: sessionsDir, isPidAlive: () => false })
    await resident.tick(clock)
    clock = new Date(store.get('coll2')!.nextRunAt as string)
    await resident.tick(clock)
    await resident.drain()

    expect(calls).toHaveLength(1)
    expect(calls[0]?.options.resume).toBe('sess-terminal-2')
  })
})

// Transcript backups are not a Silos feature: retention is
// Claude Code's (cleanupPeriodDays); a keep thread's run copies nothing.
describe('Resident — no copies of keep sessions', () => {
  it('a run of a keep thread writes nothing under <dataDir>/backups', async () => {
    store.create(mkAutomation({ id: 'bk1', trigger: { kind: 'cron', expr: '* * * * *' }, thread: { mode: 'keep' } }))
    const resident = mkResident()
    await resident.tick(clock)
    clock = new Date(store.get('bk1')!.nextRunAt as string)
    script = successScript('sess-backup')

    const folderKey = mungePath(agentFolder)
    mkdirSync(join(root, folderKey), { recursive: true })
    writeFileSync(join(root, folderKey, 'sess-backup.jsonl'), '{"type":"user","message":{"role":"user","content":"hi"}}\n')

    await resident.tick(clock)
    await resident.drain()

    expect(existsSync(join(dataDir, 'backups'))).toBe(false)
  })
})

describe('Resident — keep-thread rotation', () => {
  it('contextTokens >=85% of the window -> a new session with a "Continuing routine" prelude, no resume', async () => {
    const folderKey = mungePath(agentFolder)
    const oldSessionId = 'sess-old'
    mkdirSync(join(root, folderKey), { recursive: true })
    const line = JSON.stringify({
      type: 'assistant',
      cwd: agentFolder,
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'last assistant message before rotating' }],
        usage: { output_tokens: 10, input_tokens: 1000, cache_read_input_tokens: 180000 },
      },
    })
    writeFileSync(join(root, folderKey, `${oldSessionId}.jsonl`), line + '\n')
    await index.refresh(folderKey, oldSessionId)

    store.create(mkAutomation({ id: 'r4', trigger: { kind: 'cron', expr: '* * * * *' }, thread: { mode: 'keep', sessionId: oldSessionId } }))
    const resident = mkResident()
    script = successScript('sess-rotated')
    await resident.tick(clock)
    clock = new Date(store.get('r4')!.nextRunAt as string)
    await resident.tick(clock)
    await resident.drain()

    expect(calls[0]?.options.resume).toBeUndefined()
    expect(calls[0]?.prompt).toContain('Continuing routine')
    expect(calls[0]?.prompt).toContain('last assistant message before rotating')
    expect(store.get('r4')?.thread).toEqual({ mode: 'keep', sessionId: 'sess-rotated' })
    // chains: the new session is born from the one that got rotated out
    expect(lineage.parentOf(`${folderKey}/sess-rotated`)).toBe(`${folderKey}/${oldSessionId}`)
  })

  it('the last run failed with "Prompt is too long" -> rotates even if contextTokens is low', async () => {
    const a = store.create(mkAutomation({ id: 'r5', trigger: { kind: 'cron', expr: '* * * * *' }, thread: { mode: 'keep', sessionId: 'sess-old' } }))
    store.update(a.id, { lastRunError: 'API Error: 400 Prompt is too long' })
    const resident = mkResident()
    script = successScript('sess-new')
    await resident.tick(clock)
    clock = new Date(store.get('r5')!.nextRunAt as string)
    await resident.tick(clock)
    await resident.drain()

    expect(calls[0]?.options.resume).toBeUndefined()
    expect(calls[0]?.prompt).toContain('Continuing routine')
  })
})

describe('Resident — approval', () => {
  it('approval:true creates a waiting_approval run and does NOT execute until approveRun()', async () => {
    store.create(mkAutomation({ id: 'r6', trigger: { kind: 'cron', expr: '* * * * *' }, approval: true }))
    const resident = mkResident()
    await resident.tick(clock)
    clock = new Date(store.get('r6')!.nextRunAt as string)
    await resident.tick(clock)
    expect(calls).toHaveLength(0)
    const run = store.listRuns('r6')[0]
    expect(run?.status).toBe('waiting_approval')

    // approveRun is fire-and-forget (202) — the in-flight work must be
    // drained before checking the run's final state.
    const res = resident.approveRun(run!.id)
    expect(res).toEqual({ ok: true })
    await resident.drain()
    expect(calls).toHaveLength(1)
    expect(store.listRuns('r6')[0]?.status).toBe('ok')
  })

  it('skipRun marks the run as skipped without ever calling the SDK', async () => {
    store.create(mkAutomation({ id: 'r7', trigger: { kind: 'cron', expr: '* * * * *' }, approval: true }))
    const resident = mkResident()
    await resident.tick(clock)
    clock = new Date(store.get('r7')!.nextRunAt as string)
    await resident.tick(clock)
    const run = store.listRuns('r7')[0]

    const res = resident.skipRun(run!.id)
    expect(res).toEqual({ ok: true })
    expect(calls).toHaveLength(0)
    expect(store.listRuns('r7')[0]?.status).toBe('skipped')
  })

  it('approveRun/skipRun on a nonexistent or already-resolved run -> error', async () => {
    expect(findMissingResident()).toEqual({ error: 'run not found' })

    function findMissingResident() {
      const resident = mkResident()
      return resident.approveRun('missing')
    }
  })
})

describe('Resident — keepAlive', () => {
  it('a rate limit error with keepAlive:true -> waiting_reset with a resetsAt, retries on the SAME session once it comes due', async () => {
    store.create(mkAutomation({ id: 'r8', trigger: { kind: 'cron', expr: '* * * * *' }, thread: { mode: 'keep' }, keepAlive: true }))
    const resident = mkResident()
    await resident.tick(clock)
    clock = new Date(store.get('r8')!.nextRunAt as string)
    const resetsAtMs = clock.getTime() + 2 * 3600_000
    script = [
      { type: 'system', subtype: 'init', session_id: 'sess-rl' },
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: resetsAtMs, rateLimitType: 'five_hour' } } as unknown as SdkMessage,
      { type: 'result', subtype: 'error_during_execution', total_cost_usd: 0 },
    ]
    await resident.tick(clock)
    await resident.drain()

    expect(store.listRuns('r8')[0]?.status).toBe('waiting_reset')
    expect(store.get('r8')?.nextRunAt).toBe(new Date(resetsAtMs).toISOString())
    expect(store.get('r8')?.thread).toEqual({ mode: 'keep', sessionId: 'sess-rl' })

    clock = new Date(resetsAtMs)
    script = successScript('sess-rl')
    await resident.tick(clock)
    await resident.drain()
    expect(calls[1]?.options.resume).toBe('sess-rl')
    expect(store.listRuns('r8')[0]?.status).toBe('ok')
  })

  it('a rate limit error with keepAlive:false -> failed (no automatic retry)', async () => {
    store.create(mkAutomation({ id: 'r9', trigger: { kind: 'cron', expr: '* * * * *' }, keepAlive: false }))
    const resident = mkResident()
    await resident.tick(clock)
    clock = new Date(store.get('r9')!.nextRunAt as string)
    script = [
      { type: 'system', subtype: 'init', session_id: 'sess-x' },
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } } as unknown as SdkMessage,
      { type: 'result', subtype: 'error_during_execution', total_cost_usd: 0 },
    ]
    await resident.tick(clock)
    await resident.drain()
    expect(store.listRuns('r9')[0]?.status).toBe('failed')
  })

  // before this fix, runOnceScheduled paused UNCONDITIONALLY after
  // executeRun — overwriting waiting_reset (and its nextRunAt=resetsAt) a
  // microtask after runNow had just set it. Result: an owner-scheduled
  // `once` task would NEVER run.
  it('once + keepAlive: a run in waiting_reset is NOT paused — the retry once resetsAt comes due does run', async () => {
    const at = new Date(clock.getTime() + 3600_000).toISOString()
    store.create(mkAutomation({ id: 'once1', trigger: { kind: 'once', at }, thread: { mode: 'keep' }, keepAlive: true }))
    const resident = mkResident()
    await resident.tick(clock) // first tick: only sets nextRunAt = at
    expect(store.get('once1')?.nextRunAt).toBe(at)

    clock = new Date(at)
    const resetsAtMs = clock.getTime() + 2 * 3600_000
    script = [
      { type: 'system', subtype: 'init', session_id: 'sess-once' },
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: resetsAtMs, rateLimitType: 'five_hour' } } as unknown as SdkMessage,
      { type: 'result', subtype: 'error_during_execution', total_cost_usd: 0 },
    ]
    await resident.tick(clock) // fires the once, hits the rate limit -> waiting_reset
    await resident.drain()

    expect(store.listRuns('once1')[0]?.status).toBe('waiting_reset')
    // the bug: this was { paused: true, nextRunAt: undefined } here
    expect(store.get('once1')?.paused).toBe(false)
    expect(store.get('once1')?.nextRunAt).toBe(new Date(resetsAtMs).toISOString())

    clock = new Date(resetsAtMs)
    script = successScript('sess-once')
    await resident.tick(clock) // the tick's generic retry DOES see the automation, because it isn't paused
    await resident.drain()
    expect(store.listRuns('once1')[0]?.status).toBe('ok')
    expect(calls[1]?.options.resume).toBe('sess-once')
  })

  // induced by the fix above: the previous test ends right after the retry
  // tick and doesn't see what happened AFTER: the retry ran via
  // executeRun() "raw", with no post-processing — nobody paused the once
  // after an 'ok' retry, so nextRunAt kept pointing at the ALREADY-PASSED
  // resetsAt. The NEXT tick saw it due again and fired a SECOND full run of
  // the "once" task before pausing it — unattended. This test covers that
  // extra tick.
  it('once + keepAlive — the retry pauses immediately (same post-processing as a normal fire); a later tick does NOT fire a second run', async () => {
    const at = new Date(clock.getTime() + 3600_000).toISOString()
    store.create(mkAutomation({ id: 'once-n1', trigger: { kind: 'once', at }, thread: { mode: 'keep' }, keepAlive: true }))
    const resident = mkResident()
    await resident.tick(clock)

    clock = new Date(at)
    const resetsAtMs = clock.getTime() + 2 * 3600_000
    script = [
      { type: 'system', subtype: 'init', session_id: 'sess-n1' },
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: resetsAtMs, rateLimitType: 'five_hour' } } as unknown as SdkMessage,
      { type: 'result', subtype: 'error_during_execution', total_cost_usd: 0 },
    ]
    await resident.tick(clock) // fires, hits the rate limit -> waiting_reset
    await resident.drain()
    expect(store.listRuns('once-n1')[0]?.status).toBe('waiting_reset')

    clock = new Date(resetsAtMs)
    script = successScript('sess-n1')
    await resident.tick(clock) // the retry
    await resident.drain()
    expect(store.listRuns('once-n1')[0]?.status).toBe('ok')
    expect(calls).toHaveLength(2)
    // the bug: before this fix, these stayed false/undefined for one more
    // tick — the post-processing (pausing) only landed on the NEXT tick,
    // after a second run.
    expect(store.get('once-n1')?.paused).toBe(true)
    expect(store.get('once-n1')?.nextRunAt).toBeUndefined()

    // the next tick (+30s) must NOT fire anything — the "once" task already ran exactly once.
    clock = new Date(resetsAtMs + 30_000)
    await resident.tick(clock)
    await resident.drain()
    expect(calls).toHaveLength(2) // still 2 — without the fix, there would be a third call here
  })

  // before this fix, the retry of a waiting_reset run lost that run's
  // effective promptOverride (a webhook payload, a watch fingerprint) —
  // it retried with the generic a.prompt, silently running the WRONG task.
  // It's now persisted on the Run itself and the retry re-reads it from there.
  it('the retry of a waiting_reset run reuses its effective promptOverride (a webhook payload), not the base prompt', async () => {
    store.create(mkAutomation({ id: 'wh-m1', trigger: { kind: 'webhook', secret: 's3cr3t' }, keepAlive: true }))
    const resident = mkResident()

    const resetsAtMs = clock.getTime() + 3600_000
    script = [
      { type: 'system', subtype: 'init', session_id: 'sess-m1' },
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: resetsAtMs, rateLimitType: 'five_hour' } } as unknown as SdkMessage,
      { type: 'result', subtype: 'error_during_execution', total_cost_usd: 0 },
    ]
    const res = resident.fireWebhook('wh-m1', 's3cr3t', { orderId: 42 })
    expect(res).toEqual({ ok: true })
    await until(() => store.listRuns('wh-m1')[0]?.status === 'waiting_reset')
    expect(store.listRuns('wh-m1')[0]?.promptOverride).toContain('orderId')
    expect(store.listRuns('wh-m1')[0]?.promptOverride).toContain('42')

    clock = new Date(resetsAtMs)
    script = successScript('sess-m1')
    await resident.tick(clock) // the tick's retry
    await resident.drain()

    expect(store.listRuns('wh-m1')[0]?.status).toBe('ok')
    expect(calls[1]?.prompt).toContain('orderId') // the retry DID carry the original payload, not just a.prompt
    expect(calls[1]?.prompt).toContain('42')
  })

  // Object.assign used to mutate in place the same object the resident
  // holds in `a` for the ENTIRE run (up to 30 min) — a concurrent owner
  // PATCH "leaked" live into decisions the resident makes later, which
  // assume the state that existed when the run STARTED. Here: the owner
  // turns off keepAlive mid-run for a run that was decided with
  // keepAlive:true — the run must keep being treated as keepAlive:true
  // until the end (waiting_reset, not failed), and both the owner's PATCH
  // (name) and the thread the run persists must survive.
  it('a concurrent PATCH during a long run is not lost, and the run decides using the keepAlive it had AT THE START', async () => {
    let resolveInit: (() => void) | null = null
    const resetsAtMs = clock.getTime() + 2 * 3600_000
    const testChat = new ChatService({
      registry,
      native,
      dataDir,
      queryFn: (args) => {
        calls.push(args)
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'system', subtype: 'init', session_id: 'sess-m8' } as SdkMessage
            await new Promise<void>((resolve) => {
              resolveInit = resolve
            })
            yield {
              type: 'rate_limit_event',
              rate_limit_info: { status: 'rejected', resetsAt: resetsAtMs, rateLimitType: 'five_hour' },
            } as unknown as SdkMessage
            yield { type: 'result', subtype: 'error_during_execution', total_cost_usd: 0 } as SdkMessage
          },
          async interrupt() {
            return undefined
          },
        }
      },
    })
    store.create(mkAutomation({ id: 'm8', name: 'Original', trigger: { kind: 'cron', expr: '* * * * *' }, thread: { mode: 'keep' }, keepAlive: true }))
    const resident = new Resident({
      store,
      registry,
      chat: testChat,
      native,
      index,
      root,
      dataDir,
      broadcast: (m) => broadcasts.push(m),
      now: () => clock,
      tickIntervalMs: 999_999_999,
    })
    activeResidents.push(resident)

    await resident.tick(clock)
    clock = new Date(store.get('m8')!.nextRunAt as string)
    await resident.tick(clock) // fires runNow -> stays IN PROGRESS after chat-init, waiting on resolveInit

    await until(() => store.listRuns('m8')[0]?.status === 'running' && resolveInit !== null)

    // the owner edits WHILE the run is still in flight: renames it AND turns off keepAlive
    store.update('m8', { name: 'New name from the owner', keepAlive: false })

    resolveInit?.() // let the turn proceed to the rate limit
    await until(() => store.listRuns('m8')[0]?.status !== 'running')

    const finalState = store.get('m8')
    expect(finalState?.name).toBe('New name from the owner') // the owner's PATCH survives
    expect(finalState?.thread).toEqual({ mode: 'keep', sessionId: 'sess-m8' }) // the thread the run persists ALSO survives
    // the bug: with an in-place Object.assign, a.keepAlive read inside the
    // error handling would have seen the owner's 'false' (shared mutation)
    // and this run would have ended 'failed' instead of 'waiting_reset'.
    expect(store.listRuns('m8')[0]?.status).toBe('waiting_reset')
  })

  // a `once` run in flight (takes minutes, normal with an LLM) keeps a
  // stale, due nextRunAt — nobody clears it when the run STARTS. Every
  // +30s tick in the meantime re-enters fireOnceIfDue -> runOnceScheduled,
  // and executeRun no-ops (the `running` lock) without having done
  // anything. Before this fix, runOnceScheduled's post-processing ran
  // anyway on that no-op and paused the automation mid-run — if that real
  // run ended in waiting_reset, it stayed paused:true forever (tick skips
  // paused automations) and the retry NEVER arrived: the task died silently.
  it('a tick during an in-flight once run does NOT pause it; if it ends in waiting_reset, the retry DOES arrive and only then does it pause', async () => {
    let resolveGate: (() => void) | null = null
    const resetsAtMs = clock.getTime() + 2 * 3600_000
    let attempt = 0
    const testChat = new ChatService({
      registry,
      native,
      dataDir,
      queryFn: (args) => {
        calls.push(args)
        attempt += 1
        const thisAttempt = attempt
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'system', subtype: 'init', session_id: `sess-nf1-${thisAttempt}` } as SdkMessage
            if (thisAttempt === 1) {
              // the first attempt stays "in flight" until the test releases
              // it explicitly — so an extra tick can slip in while it's
              // still running, just like a real run that takes minutes.
              await new Promise<void>((resolve) => {
                resolveGate = resolve
              })
              yield {
                type: 'rate_limit_event',
                rate_limit_info: { status: 'rejected', resetsAt: resetsAtMs, rateLimitType: 'five_hour' },
              } as unknown as SdkMessage
              yield { type: 'result', subtype: 'error_during_execution', total_cost_usd: 0 } as SdkMessage
            } else {
              yield { type: 'result', subtype: 'success', total_cost_usd: 0 } as SdkMessage
            }
          },
          async interrupt() {
            return undefined
          },
        }
      },
    })

    const at = new Date(clock.getTime() + 3600_000).toISOString()
    store.create(mkAutomation({ id: 'nf1', trigger: { kind: 'once', at }, thread: { mode: 'keep' }, keepAlive: true }))
    const resident = new Resident({
      store,
      registry,
      chat: testChat,
      native,
      index,
      root,
      dataDir,
      broadcast: (m) => broadcasts.push(m),
      now: () => clock,
      tickIntervalMs: 999_999_999,
    })
    activeResidents.push(resident)

    await resident.tick(clock) // first tick: only sets nextRunAt = at
    clock = new Date(at)
    await resident.tick(clock) // fires the single real attempt -- stays IN FLIGHT, blocked on resolveGate

    await until(() => resolveGate !== null)
    expect(store.listRuns('nf1')[0]?.status).toBe('running')

    // the "extra" tick (e.g. +30s): nextRunAt is still due because nobody
    // clears it when the run STARTS — before the fix, this paused the
    // automation even though the run was still in progress. NOTE: don't
    // use drain() here — the ORIGINAL run is deliberately still blocked on
    // resolveGate, drain() would hang waiting for it; letting the extra
    // tick's no-op run (fire-and-forget, resolves almost instantly) is enough.
    await resident.tick(clock)
    await new Promise((r) => setTimeout(r, 100))
    expect(store.listRuns('nf1')[0]?.status).toBe('running') // still the SAME run
    expect(store.get('nf1')?.paused).toBe(false) // the bug: this was true here
    expect(calls).toHaveLength(1) // the extra tick did NOT fire a second real attempt

    // let the real run finish: hits the rate limit -> waiting_reset
    resolveGate?.()
    await until(() => store.listRuns('nf1')[0]?.status === 'waiting_reset')
    // the bug: it stayed paused:true from the spurious pause above -> tick
    // never looks at a paused automation again -> the retry NEVER arrives.
    expect(store.get('nf1')?.paused).toBe(false)
    expect(store.get('nf1')?.nextRunAt).toBe(new Date(resetsAtMs).toISOString())

    // the retry once resetsAt comes due DOES run -- and ONLY THEN does it pause.
    clock = new Date(resetsAtMs)
    await resident.tick(clock)
    await resident.drain()
    expect(store.listRuns('nf1')[0]?.status).toBe('ok')
    expect(calls).toHaveLength(2) // exactly ONE retry -- neither zero nor two
    expect(store.get('nf1')?.paused).toBe(true)
    expect(store.get('nf1')?.nextRunAt).toBeUndefined()
  })

  // chat.send is an async generator — its synchronous validations (a
  // racing agent, master with no cwd, or the "a turn is already in
  // progress for this session" lock) throw BEFORE chat-service enters its
  // own try/catch (the only one that emits 'chat-error') — that path never
  // emits a terminal event for the turnId, so without cleanup in a
  // finally, liveRunTurnIds would leak forever. Reproduced with the
  // "plausible" case flagged during review: a keep automation fires on a
  // session that ALREADY has a turn in progress (e.g. the owner mid-turn
  // on that same session from the UI).
  it('a SYNCHRONOUS throw from chat.send (a session-in-progress collision) does not leave liveRunTurnIds orphaned', async () => {
    const sessionId = 'sess-nf2'
    // holds the session's lock in ChatService: a "manual turn" that starts
    // but never resolves — simulates the owner mid-turn.
    const hog = chat.send({ turnId: 'hog', agentId: 'finance', text: 'x', resume: { sessionId, mode: 'append' } })
    await hog.next() // runs to the first yield (chat-init) — activeSessions already holds the lock

    store.create(mkAutomation({ id: 'nf2', trigger: { kind: 'cron', expr: '* * * * *' }, thread: { mode: 'keep', sessionId } }))
    const resident = mkResident()
    resident.start()

    await resident.tick(clock)
    clock = new Date(store.get('nf2')!.nextRunAt as string)
    await resident.tick(clock)
    await resident.drain()

    expect(store.listRuns('nf2')[0]?.status).toBe('failed')
    expect(store.listRuns('nf2')[0]?.error).toContain('already in progress')
    expect(resident.liveRunTurnIdsSize).toBe(0) // without the fix, this stayed at 1 forever
  })
})

describe('Resident — webhook', () => {
  it('a wrong secret -> 401 (error), does not run; the right secret -> 202 (ok) with the payload in the prompt', async () => {
    store.create(mkAutomation({ id: 'wh1', trigger: { kind: 'webhook', secret: 's3cr3t' } }))
    const resident = mkResident()

    const bad = resident.fireWebhook('wh1', 'wrong-secret', undefined)
    expect(bad).toEqual({ error: 'invalid secret', code: 401 })
    await new Promise((r) => setTimeout(r, 50))
    expect(calls).toHaveLength(0)

    const ok = resident.fireWebhook('wh1', 's3cr3t', { hello: 'world' })
    expect(ok).toEqual({ ok: true })
    await until(() => store.listRuns('wh1')[0]?.status === 'ok')
    // payload embedded, but FENCED as untrusted data (prompt-injection defense)
    expect(calls[0]?.prompt).toContain('<webhook-payload>')
    expect(calls[0]?.prompt).toContain('UNTRUSTED external data')
    expect(calls[0]?.prompt).toContain('hello')
  })

  it('a nonexistent automation or one that is not a webhook -> 404 error', async () => {
    store.create(mkAutomation({ id: 'notwh', trigger: { kind: 'cron', expr: '* * * * *' } }))
    const resident = mkResident()
    expect(resident.fireWebhook('nope', 'x', undefined)).toEqual({ error: 'automation not found', code: 404 })
    expect(resident.fireWebhook('notwh', 'x', undefined)).toEqual({ error: 'automation not found', code: 404 })
  })

  // spend-safety: a paused automation must NEVER run, not even with a valid secret.
  it('a paused automation -> 409 "automation paused", does NOT run or record a run', async () => {
    store.create(mkAutomation({ id: 'wh-paused', trigger: { kind: 'webhook', secret: 's3cr3t' }, paused: true }))
    const resident = mkResident()

    const res = resident.fireWebhook('wh-paused', 's3cr3t', { hello: 'world' })
    expect(res).toEqual({ error: 'automation paused', code: 409 })

    await new Promise((r) => setTimeout(r, 100))
    expect(calls).toHaveLength(0) // the SDK was never called
    expect(store.listRuns('wh-paused')).toHaveLength(0) // no run recorded, not even 'skipped'
  })
})

describe('Resident — files trigger', () => {
  it('a file matching the glob fires a run (debounced); one that does not match does not', async () => {
    const watchDir = join(base, 'watched')
    mkdirSync(watchDir, { recursive: true })
    store.create(mkAutomation({ id: 'f1', trigger: { kind: 'files', folder: watchDir, glob: '*.md', debounceMs: 50 } }))
    const resident = mkResident()
    resident.start()
    await new Promise((r) => setTimeout(r, 300)) // give the watcher time to be ready

    writeFileSync(join(watchDir, 'note.md'), '# hi')
    await until(() => store.listRuns('f1')[0]?.status === 'ok')
    expect(calls[0]?.prompt).toContain('File changed')

    const before = calls.length
    writeFileSync(join(watchDir, 'ignored.txt'), 'x')
    await new Promise((r) => setTimeout(r, 400))
    expect(calls.length).toBe(before)
  })

  // `files` watchers get reconciled live — not only at startup.
  // reconcileFileWatchers() is what the POST/PATCH/DELETE/pause/resume
  // routes call after every mutation (server.ts).
  it('an automation created AFTER start() still fires once the watchers get reconciled', async () => {
    const watchDir = join(base, 'watched-late')
    mkdirSync(watchDir, { recursive: true })
    const resident = mkResident()
    resident.start() // starts with NO 'files' automation yet
    expect(resident.fileWatcherCount).toBe(0)

    store.create(mkAutomation({ id: 'f2', trigger: { kind: 'files', folder: watchDir, glob: '*.md', debounceMs: 50 } }))
    resident.reconcileFileWatchers() // this is what server.ts calls after the POST
    expect(resident.fileWatcherCount).toBe(1)
    await new Promise((r) => setTimeout(r, 300)) // give the watcher time to be ready

    writeFileSync(join(watchDir, 'note.md'), '# hi')
    await until(() => store.listRuns('f2')[0]?.status === 'ok')
    expect(calls[0]?.prompt).toContain('File changed')
  })

  it("a deleted automation's watcher closes: it does not fire and the watcher count drops", async () => {
    const watchDir = join(base, 'watched-deleted')
    mkdirSync(watchDir, { recursive: true })
    store.create(mkAutomation({ id: 'f3', trigger: { kind: 'files', folder: watchDir, glob: '*.md', debounceMs: 50 } }))
    const resident = mkResident()
    resident.start()
    expect(resident.fileWatcherCount).toBe(1)
    await new Promise((r) => setTimeout(r, 300))

    store.delete('f3') // this is what server.ts does on the DELETE, before reconciling
    resident.reconcileFileWatchers()
    expect(resident.fileWatcherCount).toBe(0)

    writeFileSync(join(watchDir, 'late-note.md'), '# should not trigger anything')
    await new Promise((r) => setTimeout(r, 400))
    expect(calls).toHaveLength(0)
  })

  it('pause() closes the watcher; resume() reopens it', async () => {
    const watchDir = join(base, 'watched-paused')
    mkdirSync(watchDir, { recursive: true })
    store.create(mkAutomation({ id: 'f4', trigger: { kind: 'files', folder: watchDir, glob: '*.md', debounceMs: 50 } }))
    const resident = mkResident()
    resident.start()
    expect(resident.fileWatcherCount).toBe(1)

    resident.pause('f4')
    expect(resident.fileWatcherCount).toBe(0)

    resident.resume('f4')
    expect(resident.fileWatcherCount).toBe(1)
    await new Promise((r) => setTimeout(r, 300))

    writeFileSync(join(watchDir, 'note.md'), '# hello again')
    await until(() => store.listRuns('f4')[0]?.status === 'ok')
  })
})

describe('Resident — watch trigger (check: command)', () => {
  it('runWhen changed: the first check establishes a baseline (no fire); no change -> no fire; a change -> fires', async () => {
    store.create(
      mkAutomation({
        id: 'w1',
        trigger: { kind: 'watch', every: '* * * * *', check: { type: 'command', cwd: base, command: 'true' }, runWhen: 'changed' },
      }),
    )
    let output = 'v1'
    const resident = mkResident({ execFn: async () => ({ stdout: output, code: 0 }) })

    await resident.tick(clock) // sets the heartbeat's nextRunAt
    clock = new Date(store.get('w1')!.nextRunAt as string)
    await resident.tick(clock) // the first check: baseline, no fire
    await resident.drain()
    expect(calls).toHaveLength(0)
    expect(store.get('w1')?.lastFingerprint).toBeDefined()

    clock = new Date(store.get('w1')!.nextRunAt as string)
    await resident.tick(clock) // same output -> no change -> no fire
    await resident.drain()
    expect(calls).toHaveLength(0)

    output = 'v2'
    clock = new Date(store.get('w1')!.nextRunAt as string)
    await resident.tick(clock) // changes -> fires
    await resident.drain()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.prompt).toContain('Watch Auto w1')
    expect(calls[0]?.prompt).toContain('fired: changed')
  })

  it('runWhen nonzero: fires only when the exit code is not 0', async () => {
    store.create(
      mkAutomation({
        id: 'w2',
        trigger: { kind: 'watch', every: '* * * * *', check: { type: 'command', cwd: base, command: 'x' }, runWhen: 'nonzero' },
      }),
    )
    let code = 0
    const resident = mkResident({ execFn: async () => ({ stdout: 'x', code }) })
    await resident.tick(clock)
    clock = new Date(store.get('w2')!.nextRunAt as string)
    await resident.tick(clock)
    await resident.drain()
    expect(calls).toHaveLength(0)

    code = 1
    clock = new Date(store.get('w2')!.nextRunAt as string)
    await resident.tick(clock)
    await resident.drain()
    expect(calls).toHaveLength(1)
  })
})

describe('Resident — cron trigger.tz', () => {
  it('schedules a cron in its own zone; a cron whose zone is unknown is paused, not looped', async () => {
    store.create(mkAutomation({ id: 'tz1', trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'America/New_York' } }))
    store.create(mkAutomation({ id: 'tz0', trigger: { kind: 'cron', expr: '0 9 * * *' } }))
    store.create(mkAutomation({ id: 'tzx', trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'Mars/Phobos' } }))
    const resident = mkResident()
    await resident.tick(clock) // 2026-08-19T09:00Z
    expect(store.get('tz1')?.nextRunAt).toBe('2026-08-19T13:00:00.000Z') // 09:00 EDT
    expect(store.get('tz0')?.nextRunAt).toBe(nextRun('0 9 * * *', clock).toISOString()) // server-local, as before
    expect(store.get('tzx')).toMatchObject({ paused: true, nextRunAt: undefined })
  })
})

describe('Resident — run summary', () => {
  const text = (t: string): SdkMessage => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } })
  const tool = (name: string): SdkMessage => ({
    type: 'stream_event',
    event: { type: 'content_block_start', content_block: { type: 'tool_use', name, input: {} } },
  })
  const runWith = async (id: string, s: SdkMessage[]) => {
    store.create(mkAutomation({ id, trigger: { kind: 'cron', expr: '* * * * *' } }))
    const resident = mkResident()
    await resident.tick(clock)
    clock = new Date(store.get(id)!.nextRunAt as string)
    script = s
    await resident.tick(clock)
    await resident.drain()
    return store.listRuns(id)[0]
  }
  const init: SdkMessage = { type: 'system', subtype: 'init', session_id: 'sess-sum' }
  const done: SdkMessage = { type: 'result', subtype: 'success', total_cost_usd: 0.01 }

  it('is the final assistant message, not the narration before the tool calls glued to it', async () => {
    const run = await runWith('s1', [
      init,
      text('Loading the skill'),
      text('… step by step.'),
      tool('Skill'),
      text('Read. '),
      tool('Bash'),
      tool('Read'),
      text('All'),
      text(' good: 3 cases reviewed.'),
      done,
    ])
    expect(run?.summary).toBe('All good: 3 cases reviewed.')
    expect(store.get('s1')?.lastRun?.summary).toBe('All good: 3 cases reviewed.')
  })

  it('a turn with no tool calls keeps its whole text; a turn ending on a tool keeps the last text it said', async () => {
    expect((await runWith('s2', [init, text('Nothing to do.'), text(' Logged.'), done]))?.summary).toBe('Nothing to do. Logged.')
    expect((await runWith('s3', [init, text('Starting the read.'), tool('Bash'), done]))?.summary).toBe('Starting the read.')
  })

  it('is capped at 200 characters of that final message', async () => {
    const long = 'x'.repeat(300)
    expect((await runWith('s4', [init, text('preamble'), tool('Bash'), text(long), done]))?.summary).toBe('x'.repeat(200))
  })
})

describe('Resident — run outcome (OUTCOME line)', () => {
  const text = (t: string): SdkMessage => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } })
  const tool = (name: string): SdkMessage => ({
    type: 'stream_event',
    event: { type: 'content_block_start', content_block: { type: 'tool_use', name, input: {} } },
  })
  const init: SdkMessage = { type: 'system', subtype: 'init', session_id: 'sess-out' }
  const done: SdkMessage = { type: 'result', subtype: 'success', total_cost_usd: 0.01 }
  const runWith = async (id: string, s: SdkMessage[], prompt = 'check the inbox') => {
    store.create(mkAutomation({ id, prompt, trigger: { kind: 'cron', expr: '* * * * *' } }))
    const resident = mkResident()
    await resident.tick(clock)
    clock = new Date(store.get(id)!.nextRunAt as string)
    script = s
    await resident.tick(clock)
    await resident.drain()
    return store.listRuns(id)[0]
  }

  it('every run prompt carries the instruction exactly once', async () => {
    await runWith('o1', [init, text('done'), done])
    const p = calls.at(-1)!.prompt as string
    expect(p.startsWith('check the inbox')).toBe(true)
    expect(p.split('OUTCOME:').length - 1).toBe(RUN_OUTCOME_INSTRUCTION.split('OUTCOME:').length - 1)
    expect(p.endsWith(RUN_OUTCOME_INSTRUCTION)).toBe(true)
  })

  it('an owner prompt that already speaks OUTCOME: is not given the instruction twice', async () => {
    const own = 'do X and end with OUTCOME: acted or nothing'
    await runWith('o2', [init, text('ok'), done], own)
    expect(calls.at(-1)!.prompt).toBe(own)
    expect(withOutcomeInstruction(own)).toBe(own)
  })

  it('OUTCOME: acted → outcome acted, the line stripped, the sentence after it is the summary (run and lastRun)', async () => {
    const run = await runWith('o3', [init, text('Looking.'), tool('Bash'), text('All reviewed.\nOUTCOME: acted\nAnswered 2 support cases.'), done])
    expect(run?.outcome).toBe('acted')
    expect(run?.summary).toBe('Answered 2 support cases.')
    expect(store.get('o3')?.lastRun).toMatchObject({ outcome: 'acted', summary: 'Answered 2 support cases.' })
  })

  it('outcome: NOTHING is case-insensitive; with nothing after it the rest of the message is the summary', async () => {
    const run = await runWith('o4', [init, text('Nothing new in the inbox.\noutcome: NOTHING'), done])
    expect(run?.outcome).toBe('nothing')
    expect(run?.summary).toBe('Nothing new in the inbox.')
  })

  it('no OUTCOME line → no outcome, summary as before', async () => {
    const run = await runWith('o5', [init, text('All fine.'), done])
    expect(run?.outcome).toBeUndefined()
    expect(run?.summary).toBe('All fine.')
    expect(store.get('o5')?.lastRun?.outcome).toBeUndefined()
  })

  it('parseRunOutcome: sentence on the same line, markdown emphasis, the LAST line wins', () => {
    expect(parseRunOutcome('OUTCOME: acted — sent the report.')).toEqual({ outcome: 'acted', summary: 'sent the report.' })
    expect(parseRunOutcome('**OUTCOME: nothing**\nNothing new.')).toEqual({ outcome: 'nothing', summary: 'Nothing new.' })
    expect(parseRunOutcome('OUTCOME: nothing\nOUTCOME: acted\nFixed the test.')).toEqual({ outcome: 'acted', summary: 'Fixed the test.' })
    expect(parseRunOutcome('the OUTCOME: acted inline is not a line')).toEqual({ summary: 'the OUTCOME: acted inline is not a line' })
    expect(parseRunOutcome('OUTCOME: maybe')).toEqual({ summary: 'OUTCOME: maybe' })
  })
})

describe('Resident — daily budget (maxRunsPerDay)', () => {
  it('once the cap is hit, following ticks are skipped without calling the SDK', async () => {
    store.create(mkAutomation({ id: 'b1', trigger: { kind: 'cron', expr: '* * * * *' }, maxRunsPerDay: 2 }))
    const resident = mkResident()
    await resident.tick(clock)
    for (let i = 0; i < 3; i++) {
      clock = new Date(store.get('b1')!.nextRunAt as string)
      script = successScript('sess-' + i)
      await resident.tick(clock)
      await resident.drain()
    }
    expect(calls).toHaveLength(2)
    const runs = store.listRuns('b1')
    expect(runs[0]?.status).toBe('skipped')
    expect(runs[0]?.reason).toContain('daily budget')
  })

  // Once, nine SDK-400 rejections used up 12/day and the healthy runs
  // after them were skipped — a turn rejected before the model produced
  // anything spends no budget.
  it('runs rejected before the model produced anything do not spend the budget; healthy runs after them still run', async () => {
    store.create(mkAutomation({ id: 'b2', trigger: { kind: 'cron', expr: '* * * * *' }, maxRunsPerDay: 2 }))
    const resident = mkResident()
    await resident.tick(clock)
    const fire = async (s: SdkMessage[]) => {
      clock = new Date(store.get('b2')!.nextRunAt as string)
      script = s
      await resident.tick(clock)
      await resident.drain()
    }
    for (let i = 0; i < 3; i++) {
      await fire([
        { type: 'system', subtype: 'init', session_id: 'sess-400-' + i },
        { type: 'result', subtype: 'error_during_execution', total_cost_usd: 0 },
      ])
    }
    expect(
      store
        .listRuns('b2')
        .slice(0, 3)
        .map((r) => [r.status, r.produced]),
    ).toEqual([
      ['failed', false],
      ['failed', false],
      ['failed', false],
    ])
    await fire(successScript('sess-ok-1'))
    await fire(successScript('sess-ok-2'))
    await fire(successScript('sess-ok-3'))
    expect(calls).toHaveLength(5) // 3 rejected + 2 healthy; the 3rd healthy one hits the cap
    const runs = store.listRuns('b2')
    expect(runs[0]?.status).toBe('skipped')
    expect(runs[1]).toMatchObject({ status: 'ok', produced: true })
  })

  it('a run that failed after the model worked (text, tool call) spends the budget', async () => {
    store.create(mkAutomation({ id: 'b3', trigger: { kind: 'cron', expr: '* * * * *' }, maxRunsPerDay: 1 }))
    const resident = mkResident()
    await resident.tick(clock)
    clock = new Date(store.get('b3')!.nextRunAt as string)
    script = [
      { type: 'system', subtype: 'init', session_id: 'sess-w' },
      { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Bash', input: {} } } },
      { type: 'result', subtype: 'error_during_execution', total_cost_usd: 0.2 },
    ]
    await resident.tick(clock)
    await resident.drain()
    expect(store.listRuns('b3')[0]).toMatchObject({ status: 'failed', produced: true })
    clock = new Date(store.get('b3')!.nextRunAt as string)
    script = successScript('sess-w2')
    await resident.tick(clock)
    await resident.drain()
    expect(calls).toHaveLength(1)
    expect(store.listRuns('b3')[0]?.reason).toContain('daily budget')
  })
})

describe('Resident — missed-run policy', () => {
  it('missed <6h ago: a normal tick() runs it; missed >=6h ago: gets skipped and recalculated from now', async () => {
    const shortNextRunAt = new Date(clock.getTime() - 3 * 3600_000).toISOString() // 3h ago
    const longNextRunAt = new Date(clock.getTime() - 8 * 3600_000).toISOString() // 8h ago
    store.create(mkAutomation({ id: 'm1', trigger: { kind: 'cron', expr: '* * * * *' }, nextRunAt: shortNextRunAt }))
    store.create(mkAutomation({ id: 'm2', trigger: { kind: 'cron', expr: '* * * * *' }, nextRunAt: longNextRunAt }))

    const resident = mkResident()
    resident.start() // checkMissedOnStart runs synchronously inside start()

    // m1: missed <6h -> nextRunAt untouched, still due — a normal tick() picks it up
    expect(store.get('m1')?.nextRunAt).toBe(shortNextRunAt)
    // m2: missed >=6h -> skipped and recorded, nextRunAt recalculated into the future
    const runsM2 = store.listRuns('m2')
    expect(runsM2[0]?.status).toBe('skipped')
    expect(runsM2[0]?.reason).toContain('missed')
    expect(new Date(store.get('m2')!.nextRunAt as string).getTime()).toBeGreaterThan(clock.getTime())
    expect(calls).toHaveLength(0) // neither one called the SDK yet

    await resident.tick(clock)
    await resident.drain()
    expect(store.listRuns('m1')[0]?.status).toBe('ok') // m1 ran because it was still due
    expect(store.listRuns('m2')).toHaveLength(1) // m2 wasn't touched again (its next time is in the future)
  })

  it('reconcileStaleRuns: a run left "running" across a restart gets marked failed', async () => {
    const a = store.create(mkAutomation({ id: 'stale1', trigger: { kind: 'cron', expr: '0 0 1 1 *' } }))
    store.appendRun('stale1', { id: 'run-old', automationId: 'stale1', at: clock.toISOString(), status: 'running', startedAt: clock.toISOString() })
    const resident = mkResident()
    resident.start()
    expect(store.listRuns('stale1')[0]?.status).toBe('failed')
    expect(store.listRuns('stale1')[0]?.error).toContain('restart')
    void a
  })
})

describe('Resident — persistence round-trip', () => {
  it('a second AutomationsStore on the same dataDir sees the thread/nextRunAt the resident updated', async () => {
    store.create(mkAutomation({ id: 'p1', trigger: { kind: 'cron', expr: '* * * * *' }, thread: { mode: 'keep' } }))
    const resident = mkResident()
    await resident.tick(clock)
    clock = new Date(store.get('p1')!.nextRunAt as string)
    script = successScript('sess-persist')
    await resident.tick(clock)
    await resident.drain()

    const store2 = new AutomationsStore(dataDir)
    store2.load()
    const a2 = store2.get('p1')
    expect(a2?.thread).toEqual({ mode: 'keep', sessionId: 'sess-persist' })
    expect(store2.listRuns('p1')[0]?.status).toBe('ok')
  })
})

describe('Resident — a tick() rejection never goes orphaned', () => {
  it('a throw inside tick() is logged with console.error, never turns into an unhandledRejection, and the resident stays alive', async () => {
    store.create(mkAutomation({ id: 'ok1', trigger: { kind: 'cron', expr: '* * * * *' } }))
    const resident = mkResident({ tickIntervalMs: 20 })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    let unhandled: unknown = null
    const onUnhandled = (err: unknown): void => {
      unhandled = err
    }
    process.on('unhandledRejection', onUnhandled)

    // start() already makes its own normal calls to store.list() (synchronous,
    // inside reconcileStaleRuns/checkMissedOnStart/reconcileFileWatchers) —
    // the mock that breaks ONLY the next scheduled tick() is installed AFTER,
    // so it's specifically the setInterval call that fails.
    resident.start()
    const listSpy = vi.spyOn(store, 'list').mockImplementationOnce(() => {
      throw new Error('malformed automation')
    })
    await new Promise((r) => setTimeout(r, 100)) // let at least one real tick run (20ms interval)

    process.off('unhandledRejection', onUnhandled)
    expect(unhandled).toBeNull() // before the fix: Node 22 kills the process here
    expect(errSpy).toHaveBeenCalled()

    listSpy.mockRestore()
    errSpy.mockRestore()

    // the resident is still operational: with store.list() back to normal,
    // the next tick works and schedules the automation for real
    await resident.tick(clock)
    expect(store.get('ok1')?.nextRunAt).toBeDefined()
  })
})

describe('Resident — a hung run does not block scheduling other automations', () => {
  it('a queryFn that never resolves: tick() does not block and another automation still runs', async () => {
    const hangFolder = join(base, 'hang-project')
    mkdirSync(hangFolder, { recursive: true })
    registry.create({ id: 'hangy', name: 'Hangy', folder: hangFolder })

    const testChat = new ChatService({
      registry,
      native,
      dataDir,
      queryFn: (args) => {
        calls.push(args)
        const cwd = (args.options as { cwd?: string }).cwd
        if (cwd === hangFolder) {
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'system', subtype: 'init', session_id: 'sess-hang' } as SdkMessage
              await new Promise(() => {
                /* never resolves */
              })
            },
            async interrupt() {
              return undefined
            },
          }
        }
        return {
          async *[Symbol.asyncIterator]() {
            for (const m of successScript('sess-ok')) yield m
          },
          async interrupt() {
            return undefined
          },
        }
      },
    })

    store.create(mkAutomation({ id: 'hang1', agentId: 'hangy', trigger: { kind: 'cron', expr: '* * * * *' } }))
    store.create(mkAutomation({ id: 'ok1', agentId: 'finance', trigger: { kind: 'cron', expr: '* * * * *' } }))
    const resident = new Resident({
      store,
      registry,
      chat: testChat,
      native,
      index,
      root,
      dataDir,
      broadcast: (m) => broadcasts.push(m),
      now: () => clock,
      tickIntervalMs: 999_999_999,
      runTimeoutMs: 999_999_999, // deliberately disabled: this test is only about tick() not blocking, not the timeout
    })
    activeResidents.push(resident)

    await resident.tick(clock) // sets nextRunAt for both
    clock = new Date(Math.max(new Date(store.get('hang1')!.nextRunAt as string).getTime(), new Date(store.get('ok1')!.nextRunAt as string).getTime()))

    // fires both: hang1 stays hung, ok1 shouldn't wait on it. hang1's query
    // never resolves, so tick() returning at all proves it awaits no run.
    await resident.tick(clock)

    await until(() => store.listRuns('ok1')[0]?.status === 'ok', 3000)
    expect(store.listRuns('hang1')[0]?.status).toBe('running') // still in progress — never interrupted
  })

  it('timeout: a run that never finishes within runTimeoutMs gets marked failed/timeout and releases the lock', async () => {
    const testChat = new ChatService({
      registry,
      native,
      dataDir,
      queryFn: (args) => {
        calls.push(args)
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'system', subtype: 'init', session_id: 'sess-timeout' } as SdkMessage
            await new Promise(() => {
              /* never resolves */
            })
          },
          async interrupt() {
            return undefined
          },
        }
      },
    })
    store.create(mkAutomation({ id: 'to1', trigger: { kind: 'cron', expr: '* * * * *' } }))
    const resident = new Resident({
      store,
      registry,
      chat: testChat,
      native,
      index,
      root,
      dataDir,
      broadcast: (m) => broadcasts.push(m),
      now: () => clock,
      tickIntervalMs: 999_999_999,
      runTimeoutMs: 50, // real ms — deliberately short for the test
    })
    activeResidents.push(resident)

    await resident.tick(clock)
    clock = new Date(store.get('to1')!.nextRunAt as string)
    await resident.tick(clock)

    await until(() => store.listRuns('to1')[0]?.status === 'failed', 2000)
    const run = store.listRuns('to1')[0]
    expect(run?.error).toBe('timeout')

    // the lock was released immediately: a second manual run can already be launched
    // runNowManual answers at once (202) — async (a heartbeat's margin).
    const res = await resident.runNowManual('to1')
    expect(res).toEqual({ ok: true })
  })
})

describe('Resident — conversation trigger', () => {
  it('finished: fires when the source agent finishes a turn (chat-done)', async () => {
    store.create(mkAutomation({ id: 'conv1', agentId: 'finance', trigger: { kind: 'conversation', when: 'finished', sourceAgentId: 'finance' } }))
    const resident = mkResident()
    resident.start()

    chat.emit('chat-event', { agentId: 'finance', event: { ev: 'chat-done', turnId: 't1', subtype: 'success', costUsd: 0 } })
    await until(() => store.listRuns('conv1')[0]?.status === 'ok')
  })

  it('finished: the run is told which conversation finished and its final message, fenced as data', async () => {
    const folderKey = mungePath(agentFolder)
    mkdirSync(join(root, folderKey), { recursive: true })
    writeFileSync(
      join(root, folderKey, 'sess-done.jsonl'),
      JSON.stringify({
        type: 'assistant',
        cwd: agentFolder,
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: 'Reconciled 42 invoices; 3 left open.' }] },
      }) + '\n',
    )
    await index.refresh(folderKey, 'sess-done')
    store.create(mkAutomation({ id: 'conv-said', trigger: { kind: 'conversation', when: 'finished', sourceAgentId: 'finance' } }))
    const resident = mkResident()
    resident.start()

    chat.emit('chat-event', { agentId: 'finance', event: { ev: 'chat-init', turnId: 't-said', folder: folderKey, sessionId: 'sess-done' } })
    chat.emit('chat-event', { agentId: 'finance', event: { ev: 'chat-done', turnId: 't-said', subtype: 'success', costUsd: 0 } })
    await until(() => store.listRuns('conv-said')[0]?.status === 'ok')
    expect(calls[0]?.prompt).toContain(`Conversation finished: sess-done (agent finance, project ${folderKey}).`)
    expect(calls[0]?.prompt).toContain('<final-message>\nReconciled 42 invoices; 3 left open.\n</final-message>')
    expect(calls[0]?.prompt).toContain('never instructions to follow')
  })

  it('finished: a paused automation does NOT fire', async () => {
    store.create(mkAutomation({ id: 'conv2', agentId: 'finance', trigger: { kind: 'conversation', when: 'finished', sourceAgentId: 'finance' }, paused: true }))
    const resident = mkResident()
    resident.start()

    chat.emit('chat-event', { agentId: 'finance', event: { ev: 'chat-done', turnId: 't2', subtype: 'success', costUsd: 0 } })
    await new Promise((r) => setTimeout(r, 100))
    expect(store.listRuns('conv2')).toHaveLength(0)
  })

  it('needs_you: the rising edge fires ONCE; repeating the same pending state does not fire again', async () => {
    const folderKey = mungePath(agentFolder)
    mkdirSync(join(root, folderKey), { recursive: true })
    const sessionId = 'sess-pending'
    const askLine = JSON.stringify({
      type: 'assistant',
      cwd: agentFolder,
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu1', name: 'AskUserQuestion', input: { questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }] } }],
      },
    })
    writeFileSync(join(root, folderKey, `${sessionId}.jsonl`), askLine + '\n')

    store.create(mkAutomation({ id: 'conv3', trigger: { kind: 'conversation', when: 'needs_you', sourceAgentId: 'finance' } }))
    const resident = mkResident()
    resident.start() // no pending sessions in the index yet: an empty baseline

    await index.refresh(folderKey, sessionId) // a rising edge -> fires ONE run
    await until(() => store.listRuns('conv3')[0]?.status === 'ok')
    expect(calls).toHaveLength(1)

    // more content that does NOT resolve the pending state (still pending) -> must not fire again
    writeFileSync(
      join(root, folderKey, `${sessionId}.jsonl`),
      askLine + '\n' + JSON.stringify({ type: 'system', subtype: 'informational', content: 'noise', timestamp: new Date().toISOString() }) + '\n',
    )
    await index.refresh(folderKey, sessionId)
    await new Promise((r) => setTimeout(r, 100))
    expect(calls).toHaveLength(1) // still 1
  })

  // narrows an earlier guard's scope: that guard lived at the SESSION
  // level (hasRunWithSessionKey) and vetoed FOREVER any session that ever
  // was the sessionKey of a run — from ANY automation, including this
  // very one. That silenced a MANUAL turn from the owner on a session a
  // run had touched at some point. The new guard lives per LIVE turnId
  // (liveRunTurnIds) — it only blocks the chat-done of the turn THIS
  // process started via a run, never a foreign turn (manual or from
  // another automation) on the same session.
  it('a MANUAL turn from the owner on a session a run once touched DOES fire conversation/finished', async () => {
    store.create(mkAutomation({ id: 'conv-manual', agentId: 'finance', trigger: { kind: 'conversation', when: 'finished', sourceAgentId: 'finance' } }))
    const resident = mkResident()
    resident.start()

    // simulates this session having been the RESULT of an automation run in
    // the past (its own or another's) — the old guard vetoed it forever because of that.
    store.appendRun('conv-manual', {
      id: 'seed-run',
      automationId: 'conv-manual',
      at: clock.toISOString(),
      status: 'ok',
      sessionKey: 'project-key/sess-touched',
    })

    // the owner opens that SAME session in the normal chat and finishes a
    // turn — this chat-init/chat-done never went through executeChatTurn
    // (never got registered in liveRunTurnIds), exactly like a real manual turn.
    chat.emit('chat-event', { agentId: 'finance', event: { ev: 'chat-init', turnId: 't-manual', folder: 'project-key', sessionId: 'sess-touched' } })
    chat.emit('chat-event', { agentId: 'finance', event: { ev: 'chat-done', turnId: 't-manual', subtype: 'success', costUsd: 0 } })
    await resident.drain()

    await until(() => store.listRuns('conv-manual')[0]?.status === 'ok')
    expect(store.listRuns('conv-manual')).toHaveLength(2)
  })

  // the guard still closes the case it was designed to close — an
  // automation's own run never self-triggers. Unlike the test above, this
  // one DOES go through executeChatTurn for real (via runNowManual), so
  // liveRunTurnIds does register its turnId.
  it("the chat-done of an automation's OWN run does NOT self-trigger (the guard still closes the direct loop)", async () => {
    store.create(mkAutomation({ id: 'conv-self', agentId: 'finance', trigger: { kind: 'conversation', when: 'finished', sourceAgentId: 'finance' } }))
    const resident = mkResident()
    resident.start()

    const res = await resident.runNowManual('conv-self') // starts its OWN first run (fire-and-forget)
    expect(res).toEqual({ ok: true })
    await resident.drain()
    await until(() => store.listRuns('conv-self')[0]?.status === 'ok')
    await new Promise((r) => setTimeout(r, 100)) // give a possible spurious self-trigger time to happen

    expect(store.listRuns('conv-self')).toHaveLength(1) // only the manual run — no self-trigger
  })

  // same guard, now in onSessionForNeedsYou — it used to veto needs_you
  // FOREVER on any session that had ever been the sessionKey of a run
  // (e.g. run #1 of a keep thread), silencing exactly the case the bar
  // requires alerting on: a stuck keep routine asking from its run #2
  // onward. needs_you no longer consults any such guard — only
  // pendingSeen's rising edge.
  it('needs_you fires even when the session is ALREADY the sessionKey of a previous run (a keep thread on its run #2+)', async () => {
    const folderKey = mungePath(agentFolder)
    mkdirSync(join(root, folderKey), { recursive: true })
    const sessionId = 'sess-keep-run2'
    const askLine = JSON.stringify({
      type: 'assistant',
      cwd: agentFolder,
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu1', name: 'AskUserQuestion', input: { questions: [{ question: 'Should I continue?', options: [{ label: 'Yes' }] }] } },
        ],
      },
    })
    writeFileSync(join(root, folderKey, `${sessionId}.jsonl`), askLine + '\n')

    store.create(mkAutomation({ id: 'conv-keep2', trigger: { kind: 'conversation', when: 'needs_you', sourceAgentId: 'finance' } }))
    // simulates this SAME session already being the result of a PREVIOUS
    // run (e.g. run #1 of this same keep thread) — the old bug vetoed
    // needs_you forever on any later run over that session.
    store.appendRun('conv-keep2', {
      id: 'seed-run',
      automationId: 'conv-keep2',
      at: clock.toISOString(),
      status: 'ok',
      sessionKey: `${folderKey}/${sessionId}`,
    })

    const resident = mkResident()
    resident.start()

    await index.refresh(folderKey, sessionId) // a rising edge
    await until(() => calls.length === 1) // the trigger DID fire a new run
    await until(() => store.listRuns('conv-keep2')[0]?.status === 'ok')
  })

  // a turn that dies in 'chat-error' (with no later 'chat-done' —
  // chat-service.ts's for-await catch) must not leave its turnId orphaned
  // in liveRunTurnIds forever.
  it('an automation turn that dies in chat-error does not leave liveRunTurnIds orphaned', async () => {
    const testChat = new ChatService({
      registry,
      native,
      dataDir,
      queryFn: (args) => {
        calls.push(args)
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'system', subtype: 'init', session_id: 'sess-n3' } as SdkMessage
            throw new Error('boom')
          },
          async interrupt() {
            return undefined
          },
        }
      },
    })
    store.create(mkAutomation({ id: 'n3', trigger: { kind: 'cron', expr: '* * * * *' } }))
    const resident = new Resident({
      store,
      registry,
      chat: testChat,
      native,
      index,
      root,
      dataDir,
      broadcast: (m) => broadcasts.push(m),
      now: () => clock,
      tickIntervalMs: 999_999_999,
    })
    activeResidents.push(resident)
    resident.start() // needed: the chat-error cleanup runs inside onChatEvent, subscribed by start()

    await resident.tick(clock)
    clock = new Date(store.get('n3')!.nextRunAt as string)
    await resident.tick(clock)
    await resident.drain()

    expect(store.listRuns('n3')[0]?.status).toBe('failed')
    expect(resident.liveRunTurnIdsSize).toBe(0) // without the fix, this stayed at 1 forever
  })

  it('conversation/finished: a session with NO relation to any automation run DOES fire normally (the guard does not over-block)', async () => {
    store.create(mkAutomation({ id: 'conv-normal', agentId: 'finance', trigger: { kind: 'conversation', when: 'finished', sourceAgentId: 'finance' } }))
    const resident = mkResident()
    resident.start()

    chat.emit('chat-event', { agentId: 'finance', event: { ev: 'chat-init', turnId: 't-normal', folder: 'other-folder', sessionId: 'sess-normal' } })
    chat.emit('chat-event', { agentId: 'finance', event: { ev: 'chat-done', turnId: 't-normal', subtype: 'success', costUsd: 0 } })
    await until(() => store.listRuns('conv-normal')[0]?.status === 'ok')
  })

  it('boot: a session already pending at startup does NOT count as a rising edge (no spurious run)', async () => {
    const folderKey = mungePath(agentFolder)
    mkdirSync(join(root, folderKey), { recursive: true })
    const sessionId = 'sess-already-pending'
    const askLine = JSON.stringify({
      type: 'assistant',
      cwd: agentFolder,
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu1', name: 'AskUserQuestion', input: { questions: [{ question: 'Should I continue?', options: [{ label: 'Yes' }] }] } },
        ],
      },
    })
    writeFileSync(join(root, folderKey, `${sessionId}.jsonl`), askLine + '\n')
    await index.refresh(folderKey, sessionId) // the session is ALREADY pending before the resident exists

    store.create(mkAutomation({ id: 'conv4', trigger: { kind: 'conversation', when: 'needs_you', sourceAgentId: 'finance' } }))
    const resident = mkResident()
    resident.start()
    // seedPendingBaseline() no longer runs inside start() (index.allSessions()
    // would be empty at that instant in production, see index.ts) — the
    // caller must invoke it explicitly once the index already has real
    // sessions, here simulating that startup order.
    resident.seedPendingBaseline() // must initialize pendingSeen from the current state — no spurious fire

    await new Promise((r) => setTimeout(r, 150))
    expect(calls).toHaveLength(0)
    expect(store.listRuns('conv4')).toHaveLength(0)
  })

  // if the baseline is seeded BEFORE the index has real sessions (the
  // original bug — resident.start() ran before index.init() in index.ts),
  // pendingSeen stays empty forever and ANY later fs event on an
  // already-pending session fires a spurious run. This test demonstrates
  // the contrast explicitly.
  it('seedPendingBaseline() BEFORE the index has sessions (the original bug) DOES let a spurious run through', async () => {
    const folderKey = mungePath(agentFolder)
    mkdirSync(join(root, folderKey), { recursive: true })
    const sessionId = 'sess-already-pending-2'
    const askLine = JSON.stringify({
      type: 'assistant',
      cwd: agentFolder,
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu1', name: 'AskUserQuestion', input: { questions: [{ question: 'Should I continue?', options: [{ label: 'Yes' }] }] } },
        ],
      },
    })
    writeFileSync(join(root, folderKey, `${sessionId}.jsonl`), askLine + '\n')
    // NOTE: deliberately NOT calling index.refresh() yet — the index (in
    // production, index.init()) doesn't know this session yet when the
    // baseline is seeded, same as the original startup-order bug.

    store.create(mkAutomation({ id: 'conv4b', trigger: { kind: 'conversation', when: 'needs_you', sourceAgentId: 'finance' } }))
    const resident = mkResident()
    resident.start()
    resident.seedPendingBaseline() // the index is still empty -> an empty baseline (reproduces the bug)

    await index.refresh(folderKey, sessionId) // NOW the event arrives -- isPending && !wasPending
    await until(() => store.listRuns('conv4b')[0]?.status === 'ok')
    expect(calls).toHaveLength(1) // a spurious run -- confirms that the ORDER of seedPendingBaseline() matters
  })
})

describe('Resident — deleting an automation with an in-flight run', () => {
  it('finishRun records the terminal state in runs.jsonl even if the automation no longer exists (no phantom "running")', async () => {
    let resolveResult: (() => void) | null = null
    const testChat = new ChatService({
      registry,
      native,
      dataDir,
      queryFn: (args) => {
        calls.push(args)
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'system', subtype: 'init', session_id: 'sess-deleted' } as SdkMessage
            await new Promise<void>((resolve) => {
              resolveResult = resolve
            })
            yield { type: 'result', subtype: 'success', total_cost_usd: 0 } as SdkMessage
          },
          async interrupt() {
            return undefined
          },
        }
      },
    })
    store.create(mkAutomation({ id: 'del1', trigger: { kind: 'cron', expr: '* * * * *' } }))
    const resident = new Resident({
      store,
      registry,
      chat: testChat,
      native,
      index,
      root,
      dataDir,
      broadcast: (m) => broadcasts.push(m),
      now: () => clock,
      tickIntervalMs: 999_999_999,
    })
    activeResidents.push(resident)

    await resident.tick(clock)
    clock = new Date(store.get('del1')!.nextRunAt as string)
    await resident.tick(clock) // fires runNow -> executeChatTurn stays IN PROGRESS, waiting on resolveResult

    await until(() => store.listRuns('del1')[0]?.status === 'running')
    store.delete('del1') // deleted while the run is still in flight — the bug: the next store.update(a.id,…) would throw

    // the real turn progresses on its own (ChatService's real
    // microtasks/IO) — we wait until it reaches the point where the fake
    // generator is waiting, before releasing it.
    await until(() => resolveResult !== null)
    resolveResult?.() // let the SDK turn finish

    await until(() => store.listRuns('del1')[0]?.status === 'ok')
    expect(store.get('del1')).toBeNull() // still deleted — finishRun did not resurrect it
  })

  it('cancelPendingApprovals marks any waiting_approval run of the deleted automation as skipped', async () => {
    store.create(mkAutomation({ id: 'del2', trigger: { kind: 'cron', expr: '* * * * *' }, approval: true }))
    const resident = mkResident()
    await resident.tick(clock)
    clock = new Date(store.get('del2')!.nextRunAt as string)
    await resident.tick(clock)
    expect(store.listRuns('del2')[0]?.status).toBe('waiting_approval')

    // this is what server.ts calls on the DELETE, before automations.delete()
    resident.cancelPendingApprovals('del2')
    store.delete('del2')

    expect(store.listRuns('del2')[0]?.status).toBe('skipped')
    expect(store.listRuns('del2')[0]?.reason).toBe('automation deleted')
  })
})

describe('Resident — parseResetFromText (keepAlive, minor)', () => {
  function chatWithError(message: string): ChatService {
    return new ChatService({
      registry,
      native,
      dataDir,
      queryFn: (args) => {
        calls.push(args)
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'system', subtype: 'init', session_id: 'sess-parse' } as SdkMessage
            throw new Error(message)
          },
          async interrupt() {
            return undefined
          },
        }
      },
    })
  }

  it('"resets 11:20pm" -> nextRunAt = today 23:20 local (a future time, no rollover)', async () => {
    const testChat = chatWithError("You've hit your session limit · resets 11:20pm (Europe/Berlin)")
    store.create(mkAutomation({ id: 'pr1', trigger: { kind: 'cron', expr: '* * * * *' }, keepAlive: true }))
    const resident = new Resident({
      store,
      registry,
      chat: testChat,
      native,
      index,
      root,
      dataDir,
      broadcast: (m) => broadcasts.push(m),
      now: () => clock,
      tickIntervalMs: 999_999_999,
    })
    activeResidents.push(resident)

    await resident.tick(clock)
    clock = new Date(store.get('pr1')!.nextRunAt as string)
    await resident.tick(clock)
    await resident.drain()

    const expected = new Date(clock.getFullYear(), clock.getMonth(), clock.getDate(), 23, 20, 0, 0)
    expect(store.get('pr1')?.nextRunAt).toBe(expected.toISOString())
  })

  it('"resets at 3:05 am" -> if it already passed today, rolls to tomorrow 03:05 local', async () => {
    const testChat = chatWithError('Usage limit reached, resets at 3:05 am')
    store.create(mkAutomation({ id: 'pr2', trigger: { kind: 'cron', expr: '* * * * *' }, keepAlive: true }))
    const resident = new Resident({
      store,
      registry,
      chat: testChat,
      native,
      index,
      root,
      dataDir,
      broadcast: (m) => broadcasts.push(m),
      now: () => clock,
      tickIntervalMs: 999_999_999,
    })
    activeResidents.push(resident)

    // the clock is at 09:00 local: today's 03:05 already passed -> must roll to tomorrow
    await resident.tick(clock)
    clock = new Date(store.get('pr2')!.nextRunAt as string)
    await resident.tick(clock)
    await resident.drain()

    const due = clock
    const expected = new Date(due.getFullYear(), due.getMonth(), due.getDate(), 3, 5, 0, 0)
    if (expected.getTime() <= due.getTime()) expected.setDate(expected.getDate() + 1)
    expect(store.get('pr2')?.nextRunAt).toBe(expected.toISOString())
  })

  it('no recognizable time in the text -> falls back to +60min', async () => {
    const testChat = chatWithError("You've hit your usage limit for this session, try again soon")
    store.create(mkAutomation({ id: 'pr3', trigger: { kind: 'cron', expr: '* * * * *' }, keepAlive: true }))
    const resident = new Resident({
      store,
      registry,
      chat: testChat,
      native,
      index,
      root,
      dataDir,
      broadcast: (m) => broadcasts.push(m),
      now: () => clock,
      tickIntervalMs: 999_999_999,
    })
    activeResidents.push(resident)

    await resident.tick(clock)
    clock = new Date(store.get('pr3')!.nextRunAt as string)
    const before = clock.getTime()
    await resident.tick(clock)
    await resident.drain()

    expect(store.get('pr3')?.nextRunAt).toBe(new Date(before + 3600_000).toISOString())
  })
})

describe('the titler in the heartbeat', () => {
  it("tick() fires the titler's sweep (fire-and-forget, after the automations)", async () => {
    const sweeps: Array<Date | undefined> = []
    const resident = mkResident({
      titler: {
        sweep: async (now?: Date) => {
          sweeps.push(now)
          return 0
        },
      },
    })
    await resident.tick(clock)
    await resident.drain()
    expect(sweeps).toHaveLength(1)
    expect(sweeps[0]).toEqual(clock)
  })

  it('with no titler injected, the tick still works the same', async () => {
    const resident = mkResident()
    await expect(resident.tick(clock)).resolves.toBeUndefined()
  })
})

// resident runs must ALWAYS ignore the conversation level of the cascade —
// even with inheritHooks:true, where `isolation` travels undefined and an
// earlier proxy check (`!input.isolation`) let a thread's prefs slip through
// (a plan mode set in the UI silently degraded unattended runs). The
// resident now passes `unattended: true` on EVERY send, and ChatService
// gates SOLELY on that flag.
describe('convPrefs never touch an unattended run, not even with inheritHooks:true', () => {
  it('an inheritHooks:true automation resuming a thread WITH prefs (plan/model) -> prefs ignored', async () => {
    const { ConversationPrefsStore } = await import('../src/conversation-prefs.js')
    const convPrefs = new ConversationPrefsStore(dataDir)
    convPrefs.load()
    const folderKey = mungePath(agentFolder)
    convPrefs.patch(folderKey, 'thread-keep', { permissionMode: 'plan', model: 'haiku' })
    const testChat = new ChatService({ registry, native, queryFn: fakeQuery(), dataDir, convPrefs })
    store.create(
      mkAutomation({
        id: 'rx-f2',
        trigger: { kind: 'cron', expr: '* * * * *' },
        inheritHooks: true, // isolation travels undefined — the case that reopened this bug
        thread: { mode: 'keep', sessionId: 'thread-keep' },
      }),
    )
    const resident = mkResident({ chat: testChat })
    await resident.tick(clock)
    clock = new Date(store.get('rx-f2')!.nextRunAt as string)
    await resident.tick(clock)
    await resident.drain()

    const o = calls[0]!.options
    expect(o.resume).toBe('thread-keep')
    expect(o.settingSources).toEqual(['user', 'project', 'local']) // inheritHooks: no isolation, as usual
    expect(o.permissionMode).toBe('bypassPermissions') // the thread's plan mode does NOT leak through
    expect(o.allowDangerouslySkipPermissions).toBe(true)
    expect(o.model).toBeUndefined() // nor the thread's model (the finance agent sets no model)
  })
})

// An automation's runsOn is its runs' turn level — it reaches the
// run even though the thread's own prefs never do (unattended)
describe('runsOn rides every run as the turn level', () => {
  it("the automation's model wins over the kept thread's pin and the agent default", async () => {
    const { ConversationPrefsStore } = await import('../src/conversation-prefs.js')
    const convPrefs = new ConversationPrefsStore(dataDir)
    convPrefs.load()
    convPrefs.patch(mungePath(agentFolder), 'thread-keep', { model: 'opus' })
    const testChat = new ChatService({ registry, native, queryFn: fakeQuery(), dataDir, convPrefs })
    store.create(
      mkAutomation({
        id: 'rx-runs-on',
        trigger: { kind: 'cron', expr: '* * * * *' },
        thread: { mode: 'keep', sessionId: 'thread-keep' },
        runsOn: { model: 'haiku' },
      }),
    )
    const resident = mkResident({ chat: testChat })
    await resident.tick(clock)
    clock = new Date(store.get('rx-runs-on')!.nextRunAt as string)
    await resident.tick(clock)
    await resident.drain()
    expect(calls[0]!.options.model).toBe('haiku')
  })
})

// conversation-prefs pruning lives in the heartbeat's slow sweep, never in the PATCH.
describe('prefsSweep in the heartbeat', () => {
  it('tick() fires the injected sweep; without one, the tick still works the same', async () => {
    let sweeps = 0
    const resident = mkResident({
      prefsSweep: () => {
        sweeps += 1
      },
    })
    await resident.tick(clock)
    expect(sweeps).toBe(1)

    const withoutSweep = mkResident()
    await expect(withoutSweep.tick(clock)).resolves.toBeUndefined()
  })
})

// runs.jsonl rotation: lives on the same low-priority heartbeat lane as
// titler/prefsSweep — a SAFE point (never mid-appendRun: the process is
// single-threaded and appendRun is synchronous; the tick only rotates between evaluations).
describe('runs.jsonl rotation in the heartbeat', () => {
  it('tick() rotates a runs.jsonl that exceeds the threshold; below it, nothing happens', async () => {
    store = new AutomationsStore(dataDir, { runsRotateBytes: 300 })
    store.load()
    const mkRun = (id: string) => ({ id, automationId: 'fat', at: clock.toISOString(), status: 'ok' as const })
    for (let i = 0; i < 6; i++) store.appendRun('fat', mkRun(`run-${i}`))
    store.appendRun('thin', { ...mkRun('run-single'), automationId: 'thin' })
    const resident = mkResident()
    await resident.tick(clock)
    expect(existsSync(store.runsPath('fat') + '.1')).toBe(true)
    expect(existsSync(store.runsPath('thin') + '.1')).toBe(false)
    // consumers stay intact after the rotation from the tick.
    expect(store.listRuns('fat')).toHaveLength(6)
    expect(store.latestRun('fat')?.id).toBe('run-5')
  })
})

// WHO gave birth to a session: a chat-init with no `resume` is a session
// this run opened — recorded once in session-origins; a keep thread's later
// runs resume it and record nothing (first record wins).
describe('session origins — the resident records the birth of run-born sessions', () => {
  it('a `thread: new` run records its session; a keep thread records only its FIRST run', async () => {
    const origins = new SessionOriginsStore(dataDir)
    const resident = mkResident({ origins })
    store.create(mkAutomation({ id: 'born-new', trigger: { kind: 'cron', expr: '* * * * *' }, thread: { mode: 'new' } }))
    await resident.tick(clock)
    clock = new Date(store.get('born-new')!.nextRunAt as string)
    script = successScript('sess-new-1')
    await resident.tick(clock)
    await resident.drain()
    const newRun = store.listRuns('born-new')[0]!
    expect(newRun.status).toBe('ok')
    expect(newRun.sessionKey).toMatch(/\/sess-new-1$/)
    expect(origins.get(newRun.sessionKey!)).toMatchObject({ kind: 'automation', automationId: 'born-new', runId: newRun.id })

    // a keep thread: its first run opens the session (recorded)…
    store.update('born-new', { paused: true })
    store.create(mkAutomation({ id: 'born-keep', trigger: { kind: 'cron', expr: '* * * * *' }, thread: { mode: 'keep' } }))
    await resident.tick(clock)
    clock = new Date(store.get('born-keep')!.nextRunAt as string)
    script = successScript('sess-keep-1')
    await resident.tick(clock)
    await resident.drain()
    const keepRun1 = store.listRuns('born-keep')[0]!
    expect(keepRun1.sessionKey).toMatch(/\/sess-keep-1$/)
    expect(origins.get(keepRun1.sessionKey!)).toMatchObject({ automationId: 'born-keep', runId: keepRun1.id })

    // …and run #2 resumes the same session: no new record, the birth stays run #1
    clock = new Date(store.get('born-keep')!.nextRunAt as string)
    script = successScript('sess-keep-1')
    await resident.tick(clock)
    await resident.drain()
    const keepRun2 = store.listRuns('born-keep')[0]!
    expect(keepRun2.id).not.toBe(keepRun1.id)
    expect(keepRun2.sessionKey).toBe(keepRun1.sessionKey)
    expect(origins.get(keepRun1.sessionKey!)!.runId).toBe(keepRun1.id)
  })
})

// A run cut mid-turn by a server restart already opened a session: the
// re-dispatch continues THAT session — one intended run, one conversation
// (a restart once produced two sidebar rows for one run).
describe('Resident — a run interrupted by a server restart is continued, not duplicated', () => {
  function seedInterrupted(id: string, sessionKey?: string): string {
    const folderKey = mungePath(agentFolder)
    mkdirSync(join(root, folderKey), { recursive: true })
    store.create(mkAutomation({ id, trigger: { kind: 'cron', expr: '* * * * *' }, thread: { mode: 'new' }, nextRunAt: clock.toISOString() }))
    store.appendRun(id, { id: `${id}-cut`, automationId: id, at: clock.toISOString(), status: 'running', ...(sessionKey ? { sessionKey } : {}) })
    return folderKey
  }

  it('with a session on disk: the next dispatch resumes it (append) with a "continue, do not redo" prelude — one conversation', async () => {
    const folderKey = seedInterrupted('cut1', `${mungePath(agentFolder)}/sess-cut`)
    writeFileSync(join(root, folderKey, 'sess-cut.jsonl'), '{"type":"user","message":{"role":"user","content":"do the task"}}\n')
    const resident = mkResident()
    resident.start()
    expect(store.listRuns('cut1')[0]).toMatchObject({
      id: 'cut1-cut',
      status: 'failed',
      error: 'interrupted by a server restart',
      sessionKey: `${folderKey}/sess-cut`,
    })

    script = successScript('sess-cut')
    await resident.tick(clock)
    await resident.drain()

    expect(calls).toHaveLength(1)
    expect(calls[0]?.options.resume).toBe('sess-cut')
    expect(calls[0]?.prompt).toContain('interrupted the previous run')
    expect(calls[0]?.prompt).toContain('do the task')
    const runs = store.listRuns('cut1')
    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({ status: 'ok', sessionKey: `${folderKey}/sess-cut` })
    // the hint is consumed: the run after that is a normal fresh one
    clock = new Date(store.get('cut1')!.nextRunAt as string)
    script = successScript('sess-next')
    await resident.tick(clock)
    await resident.drain()
    expect(calls[1]?.options.resume).toBeUndefined()
    expect(calls[1]?.prompt).not.toContain('interrupted')
  })

  it('interrupted BEFORE chat-init (no session): a normal fresh run', async () => {
    seedInterrupted('cut2')
    const resident = mkResident()
    resident.start()
    script = successScript('sess-fresh')
    await resident.tick(clock)
    await resident.drain()
    expect(calls[0]?.options.resume).toBeUndefined()
    expect(calls[0]?.prompt).not.toContain('interrupted')
    expect(store.listRuns('cut2')[0]).toMatchObject({ status: 'ok' })
  })

  it('the session file is gone (trashed between the crash and the restart): a normal fresh run', async () => {
    seedInterrupted('cut3', `${mungePath(agentFolder)}/sess-gone`)
    const resident = mkResident()
    resident.start()
    script = successScript('sess-fresh3')
    await resident.tick(clock)
    await resident.drain()
    expect(calls[0]?.options.resume).toBeUndefined()
  })

  it('the hint expires with the missed-run window: a dispatch more than 6h later is a fresh run', async () => {
    const folderKey = seedInterrupted('cut4', `${mungePath(agentFolder)}/sess-late`)
    writeFileSync(join(root, folderKey, 'sess-late.jsonl'), '{"type":"user","message":{"role":"user","content":"x"}}\n')
    const resident = mkResident()
    resident.start()
    clock = new Date(clock.getTime() + 7 * 3600_000)
    store.update('cut4', { nextRunAt: clock.toISOString() })
    script = successScript('sess-late2')
    await resident.tick(clock)
    await resident.drain()
    expect(calls[0]?.options.resume).toBeUndefined()
  })
})

// The resident's conversation triggers answer "whose conversation is this?"
// with the SAME rule as the overview (session-owner.ts): a /clear child
// belongs to whoever its root belongs to — through a root the owner has
// already buried (read from the trash) — never to the folder's default
// agent just because the child's own file carries no marker.
describe('Resident — conversation trigger resolves the owner through lineage', () => {
  it("needs_you on a /clear child of a BURIED finance root fires finance's automation, not the folder default's", async () => {
    registry.update('finance', { skills: ['finance-skill'] })
    registry.create({ id: 'deflt', name: 'Default', folder: agentFolder, default: true })
    const folderKey = mungePath(agentFolder)
    mkdirSync(join(root, folderKey), { recursive: true })
    mkdirSync(join(dataDir, 'trash', folderKey), { recursive: true })
    const ts = new Date().toISOString()
    writeFileSync(
      join(dataDir, 'trash', folderKey, 'root.jsonl'),
      JSON.stringify({
        type: 'assistant',
        cwd: agentFolder,
        timestamp: ts,
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'Skill', input: { skill: 'finance-skill' } }] },
      }) + '\n',
    )
    lineage.record(`${folderKey}/child`, `${folderKey}/root`)
    writeFileSync(
      join(root, folderKey, 'child.jsonl'),
      JSON.stringify({
        type: 'assistant',
        cwd: agentFolder,
        timestamp: ts,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu1', name: 'AskUserQuestion', input: { questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }] } }],
        },
      }) + '\n',
    )
    store.create(mkAutomation({ id: 'conv-lineage', agentId: 'finance', trigger: { kind: 'conversation', when: 'needs_you', sourceAgentId: 'finance' } }))
    const resident = mkResident()
    resident.start()

    await index.refresh(folderKey, 'child')
    await until(() => store.listRuns('conv-lineage')[0]?.status === 'ok')
    expect(calls).toHaveLength(1)
  })
})

// The run watchdog: a timed-out turn is aborted, not left
// running; a SIGTERM closes in-flight runs; the sessionKey reaches the disk
// mid-run so a HARD crash can continue the session; and a run that keeps
// getting cut by restarts stops being relaunched at every boot.
describe('Resident — run watchdog', () => {
  function hangingChat(onInterrupt: () => void, sessionId = 'sess-hang'): ChatService {
    return new ChatService({
      registry,
      native,
      dataDir,
      queryFn: (args) => {
        calls.push(args)
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'system', subtype: 'init', session_id: sessionId } as SdkMessage
            await new Promise(() => {
              /* never resolves */
            })
          },
          async interrupt() {
            onInterrupt()
          },
        }
      },
    })
  }

  function mkWatchdogResident(testChat: ChatService, runTimeoutMs: number): Resident {
    const r = new Resident({
      store,
      registry,
      chat: testChat,
      native,
      index,
      root,
      dataDir,
      broadcast: (m) => broadcasts.push(m),
      now: () => clock,
      tickIntervalMs: 999_999_999,
      runTimeoutMs,
    })
    activeResidents.push(r)
    return r
  }

  it('timeout: the zombie turn is ABORTED (engine interrupt), not just untracked', async () => {
    let interrupted = false
    const testChat = hangingChat(() => {
      interrupted = true
    })
    store.create(mkAutomation({ id: 'wd1', trigger: { kind: 'cron', expr: '* * * * *' } }))
    const resident = mkWatchdogResident(testChat, 50)

    await resident.tick(clock)
    clock = new Date(store.get('wd1')!.nextRunAt as string)
    await resident.tick(clock)

    await until(() => store.listRuns('wd1')[0]?.status === 'failed', 2000)
    expect(store.listRuns('wd1')[0]?.error).toBe('timeout')
    await until(() => interrupted, 2000)
  })

  it('chat-init persists the sessionKey on the running row — a hard crash can still continue the session', async () => {
    const testChat = hangingChat(() => {})
    store.create(mkAutomation({ id: 'wd2', trigger: { kind: 'cron', expr: '* * * * *' } }))
    const resident = mkWatchdogResident(testChat, 999_999_999)

    await resident.tick(clock)
    clock = new Date(store.get('wd2')!.nextRunAt as string)
    await resident.tick(clock)

    await until(() => store.listRuns('wd2')[0]?.sessionKey !== undefined, 2000)
    expect(store.listRuns('wd2')[0]).toMatchObject({ status: 'running', sessionKey: `${mungePath(agentFolder)}/sess-hang` })
  })

  it('shutdown(): an in-flight run is closed as failed/interrupted with its sessionKey — history never says running forever', async () => {
    const testChat = hangingChat(() => {})
    store.create(mkAutomation({ id: 'wd3', trigger: { kind: 'cron', expr: '* * * * *' } }))
    const resident = mkWatchdogResident(testChat, 999_999_999)

    await resident.tick(clock)
    clock = new Date(store.get('wd3')!.nextRunAt as string)
    await resident.tick(clock)
    await until(() => store.listRuns('wd3')[0]?.sessionKey !== undefined, 2000)

    resident.shutdown()
    const run = store.listRuns('wd3')[0]
    expect(run).toMatchObject({ status: 'failed', error: 'interrupted by a server restart', sessionKey: `${mungePath(agentFolder)}/sess-hang` })
    expect(run?.endedAt).toBeDefined()
  })

  it('a run closed by shutdown() is continued by the next dispatch, like a crash orphan', async () => {
    const folderKey = mungePath(agentFolder)
    mkdirSync(join(root, folderKey), { recursive: true })
    writeFileSync(join(root, folderKey, 'sess-shut.jsonl'), '{"type":"user","message":{"role":"user","content":"do the task"}}\n')
    store.create(mkAutomation({ id: 'wd4', trigger: { kind: 'cron', expr: '* * * * *' }, nextRunAt: clock.toISOString() }))
    store.appendRun('wd4', { id: 'wd4-cut', automationId: 'wd4', at: clock.toISOString(), status: 'running' })
    store.appendRun('wd4', {
      id: 'wd4-cut',
      automationId: 'wd4',
      at: clock.toISOString(),
      status: 'failed',
      error: 'interrupted by a server restart',
      sessionKey: `${folderKey}/sess-shut`,
      endedAt: clock.toISOString(),
    })

    const resident = mkResident()
    resident.start()
    script = successScript('sess-shut')
    await resident.tick(clock)
    await resident.drain()

    expect(calls).toHaveLength(1)
    expect(calls[0]?.options.resume).toBe('sess-shut')
    expect(calls[0]?.prompt).toContain('interrupted the previous run')
  })

  it('crash-loop cap: 3 interrupted runs in a row skip the boot catch-up; the next scheduled time runs normally', async () => {
    const folderKey = mungePath(agentFolder)
    mkdirSync(join(root, folderKey), { recursive: true })
    writeFileSync(join(root, folderKey, 'sess-loop.jsonl'), '{"type":"user","message":{"role":"user","content":"x"}}\n')
    store.create(mkAutomation({ id: 'wd5', trigger: { kind: 'cron', expr: '0 * * * *' }, nextRunAt: clock.toISOString() }))
    const earlier = new Date(clock.getTime() - 3600_000).toISOString()
    store.appendRun('wd5', { id: 'wd5-r1', automationId: 'wd5', at: earlier, status: 'failed', error: 'interrupted by a server restart', endedAt: earlier })
    store.appendRun('wd5', { id: 'wd5-r2', automationId: 'wd5', at: earlier, status: 'failed', error: 'interrupted by a server restart', endedAt: earlier })
    store.appendRun('wd5', { id: 'wd5-r3', automationId: 'wd5', at: clock.toISOString(), status: 'running', sessionKey: `${folderKey}/sess-loop` })

    const resident = mkResident()
    resident.start()

    // the boot closed r3 (3 in a row now), recorded an honest skip and moved the schedule on
    const runs = store.listRuns('wd5')
    expect(runs[0]?.status).toBe('skipped')
    expect(runs[0]?.reason).toContain('interrupted')
    expect(new Date(store.get('wd5')!.nextRunAt as string).getTime()).toBeGreaterThan(clock.getTime())

    await resident.tick(clock)
    await resident.drain()
    expect(calls).toHaveLength(0)

    // the NEXT scheduled occurrence is a normal fresh run — the cap is not a kill switch
    clock = new Date(store.get('wd5')!.nextRunAt as string)
    script = successScript('sess-after-loop')
    await resident.tick(clock)
    await resident.drain()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.options.resume).toBeUndefined()
  })
})
