// resident-unattended-turns.test.ts — the resident's unattended lanes.
// Message delivery was retired (no message wakes anyone); what stands:
//   - a turn that produced nothing (a synthetic API error with a
//     «success» result) never started
//   - a task wake's new conversation is born with origin `task`
//   - a refused engine is no failed run per automation: the beat waits and runs once
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRegistry } from '../src/agent-registry.js'
import { NativeStore } from '../src/native-store.js'
import { LineageStore } from '../src/lineage.js'
import { ChatService } from '../src/chat-service.js'
import type { SessionIndex } from '../src/session-index.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AutomationsStore } from '../src/automations-store.js'
import type { Automation } from '../src/automations-types.js'
import { Resident } from '../src/resident.js'
import { NO_OUTPUT } from '../src/resident/constants.js'
import { AgentStateStore } from '../src/agent-state.js'
import { SessionOriginsStore } from '../src/session-origins.js'
import type { QueryArgs, SdkMessage, SdkQueryHandle } from '../src/harnesses/claude-code/sdk-types.js'

const REFUSED = 'Claude Code 2.0.1 is older than Silos needs (2.1.300) — update it: claude update'

let base: string, dataDir: string, agentFolder: string
let registry: AgentRegistry, native: NativeStore, index: SessionIndex, store: AutomationsStore, chat: ChatService, lineage: LineageStore
let state: AgentStateStore, origins: SessionOriginsStore
let calls: QueryArgs[]
let clock: Date
let scripts: SdkMessage[][]
// what the compat gate says at send time, and what the up-front reading says
let gateSays: string | null
let peekSays: string | null

const worked = (sid: string): SdkMessage[] => [
  { type: 'system', subtype: 'init', session_id: sid },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'on it' } } },
  { type: 'result', subtype: 'success', total_cost_usd: 0.001 },
]
// an API error as the engine says it: a synthetic message, no output, a «success» result
const synthetic = (sid: string): SdkMessage[] => [
  { type: 'system', subtype: 'init', session_id: sid },
  {
    type: 'assistant',
    message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 401 invalid credentials' }], usage: { output_tokens: 0, input_tokens: 0 } },
  } as unknown as SdkMessage,
  { type: 'result', subtype: 'success', is_error: true, total_cost_usd: 0 } as unknown as SdkMessage,
]

function fakeQuery(): (args: QueryArgs) => SdkQueryHandle {
  return (args) => {
    calls.push(args)
    const sid = typeof args.options.resume === 'string' ? args.options.resume : `sess-${calls.length}`
    const script = scripts.shift() ?? worked(sid)
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

let residents: Resident[] = []
function mkResident(o: { up?: boolean } = {}): Resident {
  const r = new Resident({
    store,
    registry,
    chat,
    native,
    index,
    root: join(base, 'projects'),
    dataDir,
    lineage,
    agentState: state,
    origins,
    broadcast: () => {},
    now: () => clock,
    claudeSessionsDir: join(base, 'no-claude-sessions'),
    tickIntervalMs: 999_999_999,
    ...(o.up !== false ? { engineRefusal: () => peekSays } : {}),
  })
  residents.push(r)
  return r
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'deck-rev0911b-'))
  dataDir = join(base, 'data')
  agentFolder = join(base, 'project')
  mkdirSync(join(base, 'projects'), { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(agentFolder, { recursive: true })
  registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  registry.create({ id: 'finance', name: 'FINANCE', folder: agentFolder })
  registry.create({ id: 'builder', name: 'Builder', folder: join(base, 'builder') })
  native = new NativeStore(join(dataDir, 'native.json'))
  lineage = new LineageStore(join(dataDir, 'lineage.json'))
  index = claudeSessionIndex(join(base, 'projects'), join(dataDir, 'cache.json'))
  store = new AutomationsStore(dataDir)
  store.load()
  state = new AgentStateStore(join(dataDir, 'agent-state'))
  origins = new SessionOriginsStore(dataDir)
  calls = []
  scripts = []
  gateSays = null
  peekSays = null
  clock = new Date(2026, 10, 2, 12, 0, 0)
  chat = new ChatService({ registry, native, queryFn: fakeQuery(), dataDir, compatGate: async () => gateSays })
  residents = []
})

afterEach(async () => {
  for (const r of residents) {
    r.stop()
    await r.drain()
  }
})

describe('a turn that produced nothing never started', () => {
  it('a task turn: started false with NO_OUTPUT; a refused one says `refused`; a new conversation is born with origin task', async () => {
    const r = mkResident()
    scripts.push(synthetic('sess-t1'))
    const a = r.openTaskTurn({
      agentId: 'finance',
      text: 'brief',
      resume: null,
      onSession: () => {},
      origin: { task: 'folder:/p/x/tasks/t1', ref: 'x#t1' },
      turn: { class: 'wake', taskKey: 'folder:/p/x/tasks/t1' },
    })
    expect(await a.done).toMatchObject({ started: false, error: NO_OUTPUT })
    expect(origins.get(`${agentFolder.replace(/[/.]/g, '-')}/sess-t1`)).toMatchObject({
      kind: 'task',
      agentId: 'finance',
      task: 'folder:/p/x/tasks/t1',
      ref: 'x#t1',
    })
    gateSays = REFUSED
    const b = r.openTaskTurn({ agentId: 'finance', text: 'brief', resume: null, onSession: () => {}, turn: { class: 'wake' } })
    expect(await b.done).toMatchObject({ started: false, refused: REFUSED })
    gateSays = null
    const c = r.openTaskTurn({ agentId: 'finance', text: 'brief', resume: null, onSession: () => {}, turn: { class: 'wake' } })
    expect(await c.done).toMatchObject({ started: true })
  })
})

describe('a refused engine is no failed run per automation: the beat waits and runs once', () => {
  const cron = (id: string): Automation => ({
    id,
    name: id,
    agentId: 'finance',
    prompt: 'do it',
    trigger: { kind: 'cron', expr: '0 * * * *' },
    thread: { mode: 'new' },
    approval: false,
    keepAlive: false,
    paused: false,
    createdAt: '2026-11-01T00:00:00.000Z',
    nextRunAt: new Date(clock.getTime() - 60_000).toISOString(),
  })

  it('refused up front: no run row, the beat stays due; Run now says why (409); once ok it runs ONCE and reschedules', async () => {
    peekSays = REFUSED
    store.create(cron('a1'))
    const due = store.get('a1')!.nextRunAt
    const r = mkResident()
    for (let i = 0; i < 3; i++) {
      await r.tick(new Date(clock.getTime() + i * 3600_000))
      await r.drain()
    }
    expect(store.listRuns('a1')).toEqual([])
    expect(store.get('a1')!.nextRunAt).toBe(due)
    expect(await r.runNowManual('a1')).toEqual({ error: REFUSED, code: 409 })
    peekSays = null
    await r.tick(new Date(clock.getTime() + 3 * 3600_000))
    await r.drain()
    await r.tick(new Date(clock.getTime() + 3 * 3600_000 + 30_000))
    await r.drain()
    expect(store.listRuns('a1').map((x) => x.status)).toEqual(['ok'])
    expect(Date.parse(store.get('a1')!.nextRunAt!)).toBeGreaterThan(clock.getTime())
  })

  it('refused at send time: said plainly in the history as skipped — never a failure', async () => {
    gateSays = REFUSED
    store.create(cron('a2'))
    const r = mkResident({ up: false })
    await r.tick(clock)
    await r.drain()
    const runs = store.listRuns('a2')
    expect(runs.map((x) => x.status)).toEqual(['skipped'])
    expect(runs[0]!.reason).toBe(`its engine can't run: ${REFUSED}`)
  })

  it('a command automation needs no engine: it runs while the engine is refused', async () => {
    peekSays = REFUSED
    store.create({ ...cron('c1'), run: { kind: 'command', argv: ['true'] } } as Automation)
    const r = mkResident()
    expect(await r.runNowManual('c1')).toEqual({ ok: true })
  })
})
