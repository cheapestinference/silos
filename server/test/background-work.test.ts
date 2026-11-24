// background-work.test.ts — the one liveness rule for work a conversation
// started (work-live.ts): live while it WRITES or has a TOOL IN FLIGHT, the
// tool bounded like the main turn's — at every depth. Fixture transcripts
// are built per test: the main turn is CLOSED in all of them (the real
// case: a test suite in a background subagent read as waiting on him).
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionIndex } from '../src/session-index.js'
import { ClaudeReader, claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { SHELL_MAX_MS, TOOL_MAX_MS, agentAtWork, backgroundAtWork, conversationWorking, sessionAtWork, shellAtWork } from '../src/work-live.js'
import { BACKGROUND_BUSY, backgroundBusy, conversationLive } from '../src/conversation-live.js'
import { boardCardOf } from '../src/board.js'
import { metaOf as opencodeMetaOf } from '../src/harnesses/opencode/map.js'
import type { SessionMeta } from '../src/types.js'

const LIVE = 120_000
const FOLDER = '-tmp-project-x'
let root: string, cache: string, idx: SessionIndex, reader: ClaudeReader, NOW: number

const iso = (ms: number): string => new Date(ms).toISOString()
const line = (o: unknown): string => JSON.stringify(o) + '\n'
// the main transcript: the owner asked, the agent spawned a background agent and CLOSED its turn
const mainClosed = (at: number): string =>
  line({ type: 'user', timestamp: iso(at - 60_000), message: { role: 'user', content: 'run the suite in the background' } }) +
  line({
    type: 'assistant',
    timestamp: iso(at - 59_000),
    message: {
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu_agent', name: 'Agent', input: { description: 'suite', prompt: 'npm test', run_in_background: true } }],
    },
  }) +
  line({
    type: 'user',
    timestamp: iso(at - 58_000),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_agent', content: 'Async agent launched' }] },
  }) +
  line({
    type: 'assistant',
    timestamp: iso(at),
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'It runs in the background.' }] },
  }) +
  line({ type: 'system', subtype: 'turn_duration', durationMs: 60_000, timestamp: iso(at) })
// a subagent's own records
const subPrompt = (at: number, text = 'run npm test'): string =>
  line({ type: 'user', isSidechain: true, timestamp: iso(at), message: { role: 'user', content: text } })
const subTool = (at: number, id: string): string =>
  line({
    type: 'assistant',
    isSidechain: true,
    timestamp: iso(at),
    message: {
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test', description: 'Run the full suite' } }],
    },
  })
const subResult = (at: number, id: string): string =>
  line({ type: 'user', isSidechain: true, timestamp: iso(at), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } })
const subDone = (at: number): string =>
  line({
    type: 'assistant',
    isSidechain: true,
    timestamp: iso(at),
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'All green.' }] },
  })

const subDir = (): string => join(root, FOLDER, 'aaa', 'subagents')
function writeSub(rel: string, body: string, mtime: number, sidecar?: Record<string, unknown>): void {
  const f = join(subDir(), rel)
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, body)
  utimesSync(f, mtime / 1000, mtime / 1000)
  if (sidecar) writeFileSync(f.replace(/\.jsonl$/, '.meta.json'), JSON.stringify(sidecar))
}

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'silos-bg-'))
  root = join(base, 'projects')
  cache = join(base, 'sessions-cache.json')
  mkdirSync(join(root, FOLDER), { recursive: true })
  // whole seconds: utimes granularity would otherwise round the ms away
  NOW = Math.floor(Date.now() / 1000) * 1000
  writeFileSync(join(root, FOLDER, 'aaa.jsonl'), mainClosed(NOW - 10 * 60_000))
  reader = new ClaudeReader(root, cache)
  idx = new SessionIndex(reader)
})

async function meta(): Promise<SessionMeta> {
  await idx.init()
  return idx.getMeta(FOLDER, 'aaa')!
}

describe("the reader: each subagent's open tool call, at the source", () => {
  it('a subagent that wrote 10 s ago: working (it writes) — no tool in flight', async () => {
    writeSub('agent-a1.jsonl', subPrompt(NOW - 20_000) + subTool(NOW - 15_000, 't1') + subResult(NOW - 10_000, 't1'), NOW - 10_000)
    const m = await meta()
    expect(m.turnOpen).toBe(false)
    expect(m.subMtime).toBe(NOW - 10_000)
    expect(m.subToolSince).toBeUndefined()
    expect(conversationWorking(m, NOW, LIVE)).toBe(true)
  })

  it('silent for 5 min with an open tool call: working — subToolSince = the tool_use, on the census row too', async () => {
    const at = NOW - 5 * 60_000
    writeSub('agent-a1.jsonl', subPrompt(at - 5_000) + subTool(at, 't1'), at)
    const m = await meta()
    expect(m.turnOpen).toBe(false)
    expect(m.subToolSince).toBe(at)
    expect(backgroundAtWork(m, NOW, LIVE)).toBe(true)
    expect(sessionAtWork(m, NOW, LIVE)).toBe(true)
    const [row] = await idx.listSubagents(FOLDER, 'aaa')
    expect(row).toMatchObject({ id: 'a1', toolSince: at, lastTool: 'Bash', lastToolDetail: 'Run the full suite' })
    expect(agentAtWork(row!, NOW, LIVE)).toBe(true)
  })

  it('silent for 5 min with NO open tool call: not working (it finished, or waits on nothing of its own)', async () => {
    const at = NOW - 5 * 60_000
    writeSub('agent-a1.jsonl', subPrompt(at - 9_000) + subTool(at - 8_000, 't1') + subResult(at - 1_000, 't1') + subDone(at), at)
    const m = await meta()
    expect(m.subToolSince).toBeUndefined()
    expect(conversationWorking(m, NOW, LIVE)).toBe(false)
    const [row] = await idx.listSubagents(FOLDER, 'aaa')
    expect(row!.toolSince).toBeUndefined()
    expect(agentAtWork(row!, NOW, LIVE)).toBe(false)
  })

  it('an open tool call older than the bound: not working — dead, not busy', async () => {
    // a transcript silent past the bound is not even followed…
    const old = NOW - TOOL_MAX_MS - 60_000
    writeSub('agent-a1.jsonl', subPrompt(old - 5_000) + subTool(old, 't1'), old)
    let m = await meta()
    expect(m.subToolSince).toBeUndefined()
    expect(conversationWorking(m, NOW, LIVE)).toBe(false)
    // …and a tool_use stamped past it, in a fresher file, is out by the bound
    const skewed = NOW - TOOL_MAX_MS - 1
    writeSub('agent-a1.jsonl', subPrompt(skewed - 5_000) + subTool(skewed, 't1'), NOW - 20 * 60_000)
    m = (await idx.refresh(FOLDER, 'aaa'))!
    expect(m.subToolSince).toBe(skewed)
    expect(conversationWorking(m, NOW, LIVE)).toBe(false)
  })

  it('a nested subagent (flat, parentAgentId) and a workflow agent (a subfolder): either one in a silent tool keeps it working, each row listed', async () => {
    const at = NOW - 4 * 60_000
    writeSub('agent-p1.jsonl', subPrompt(at - 60_000) + subTool(at - 50_000, 'tp'), at - 50_000, { agentType: 'general-purpose', description: 'parent' })
    writeSub('agent-c1.jsonl', subPrompt(at - 40_000) + subTool(at, 'tc'), at, {
      agentType: 'general-purpose',
      description: 'child',
      parentAgentId: 'p1',
      spawnDepth: 2,
    })
    let m = await meta()
    expect(m.subToolSince).toBe(at) // the newest in flight
    expect(conversationWorking(m, NOW, LIVE)).toBe(true)
    const rows = await idx.listSubagents(FOLDER, 'aaa')
    expect(rows.find((r) => r.id === 'c1')).toMatchObject({ parentId: 'p1', depth: 2, toolSince: at })
    expect(rows.find((r) => r.id === 'p1')).toMatchObject({ toolSince: at - 50_000 })

    // the flat ones finish; a workflow agent one folder down still runs a silent tool
    writeSub('agent-p1.jsonl', subPrompt(at - 60_000) + subTool(at - 50_000, 'tp') + subResult(at - 30_000, 'tp') + subDone(at - 30_000), NOW - 6 * 60_000)
    writeSub('agent-c1.jsonl', subPrompt(at - 40_000) + subTool(at, 'tc') + subResult(at + 1_000, 'tc') + subDone(at + 1_000), NOW - 6 * 60_000)
    const wf = NOW - 3 * 60_000
    writeSub('workflows/run-1/agent-w1.jsonl', subPrompt(wf - 1_000) + subTool(wf, 'tw'), wf)
    m = (await idx.refresh(FOLDER, 'aaa'))!
    expect(m.subToolSince).toBe(wf)
    expect(conversationWorking(m, NOW, LIVE)).toBe(true)
    expect((await idx.listSubagents(FOLDER, 'aaa')).find((r) => r.id === 'w1')).toMatchObject({ toolSince: wf })
  })

  it('a resumed subagent: finished, then sent a new prompt — its new silent tool counts; before the resume it did not', async () => {
    const done = NOW - 8 * 60_000
    const finished = subPrompt(done - 9_000) + subTool(done - 8_000, 't1') + subResult(done - 1_000, 't1') + subDone(done)
    writeSub('agent-a1.jsonl', finished, done)
    let m = await meta()
    expect(conversationWorking(m, NOW, LIVE)).toBe(false)
    const again = NOW - 5 * 60_000
    appendFileSync(join(subDir(), 'agent-a1.jsonl'), subPrompt(again - 2_000, 'now the e2e suite') + subTool(again, 't2'))
    utimesSync(join(subDir(), 'agent-a1.jsonl'), again / 1000, again / 1000)
    m = (await idx.refresh(FOLDER, 'aaa'))!
    expect(m.subToolSince).toBe(again)
    expect(conversationWorking(m, NOW, LIVE)).toBe(true)
  })

  it('the heartbeat re-emits the meta when a subagent opens a silent tool, and a warm-cache restart recomputes it', async () => {
    const start = NOW - 60_000
    writeSub('agent-a1.jsonl', subPrompt(start), start)
    await idx.init()
    const events: SessionMeta[] = []
    idx.on('session', (m) => events.push(m))
    const at = NOW - 30_000
    appendFileSync(join(subDir(), 'agent-a1.jsonl'), subTool(at, 't1'))
    utimesSync(join(subDir(), 'agent-a1.jsonl'), at / 1000, at / 1000)
    await reader.pollSubagentActivity()
    expect(events.at(-1)?.subToolSince).toBe(at)
    const idx2 = claudeSessionIndex(root, cache)
    await idx2.init()
    expect(idx2.getMeta(FOLDER, 'aaa')!.subToolSince).toBe(at)
  })
})

describe('an answered question never leaves the flag set', () => {
  const ask = (at: number): string =>
    line({ type: 'user', timestamp: iso(at - 1_000), message: { role: 'user', content: 'go' } }) +
    line({
      type: 'assistant',
      timestamp: iso(at),
      message: {
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'tu_ask',
            name: 'AskUserQuestion',
            input: { questions: [{ question: 'Which suite?', options: [{ label: 'unit' }, { label: 'e2e' }] }] },
          },
        ],
      },
    })
  const answer = (at: number): string =>
    line({
      type: 'user',
      timestamp: iso(at),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_ask', content: 'User has answered your questions: "Which suite?"="unit".' }] },
    })

  it('the answer lands after a server restart (the question came back from the cache) while a subagent runs: the flag clears, the background keeps it working', async () => {
    const at = NOW - 4 * 60_000
    appendFileSync(join(root, FOLDER, 'aaa.jsonl'), ask(at))
    writeSub('agent-a1.jsonl', subPrompt(at - 30_000) + subTool(at - 20_000, 't1'), at - 20_000)
    expect((await meta()).pendingAsk).toBe(true)
    // restart: the context is restored from the cache, not re-parsed
    const idx2 = claudeSessionIndex(root, cache)
    await idx2.init()
    expect(idx2.getMeta(FOLDER, 'aaa')!.pendingAsk).toBe(true)
    appendFileSync(join(root, FOLDER, 'aaa.jsonl'), answer(NOW - 60_000))
    const m = (await idx2.refresh(FOLDER, 'aaa'))!
    expect(m.pendingAsk).toBeUndefined()
    expect(idx2.getContext(FOLDER, 'aaa')!.pending).toBeNull()
    expect(m.subToolSince).toBe(at - 20_000)
    expect(conversationWorking(m, NOW, LIVE)).toBe(true)
  })
})

describe('the consumers read the same rule', () => {
  const quiet = { id: 'aaa', mtime: NOW - 3 * 3600_000, turnOpen: false, lastRole: 'assistant' as const, subMtime: NOW - 5 * 60_000 }

  it("a task's conversation (conversationLive: the «is working on it now» sentence and the stalls): live while a background agent runs a silent tool — even hours after the main transcript went quiet", () => {
    const live = (s: typeof quiet & { subToolSince?: number }) => conversationLive({ isActive: () => false, sessions: () => [s], now: () => NOW, liveMs: LIVE })
    expect(live({ ...quiet, subToolSince: NOW - 5 * 60_000 })('aaa')).toBe(true)
    expect(live(quiet)('aaa')).toBe(false)
  })

  it("Task mode's busy check holds a wake while the background works — never on a quiet one", () => {
    const busy = (s: typeof quiet & { subToolSince?: number }) => backgroundBusy({ sessions: () => [s], now: () => NOW, liveMs: LIVE })
    expect(busy({ ...quiet, subToolSince: NOW - 5 * 60_000 })('aaa')).toBe(true)
    expect(busy(quiet)('aaa')).toBe(false)
    expect(BACKGROUND_BUSY).toMatch(/subagent/)
  })

  it("a board card (Home's Working now) reads working", () => {
    const m = { ...quiet, folder: FOLDER, title: 't', skills: [], cwd: '/tmp/x', size: 1, turnCount: 2, subToolSince: NOW - 5 * 60_000 } as SessionMeta
    expect(boardCardOf(m, null, NOW, LIVE, 'writer', 't').state).toBe('working')
    expect(boardCardOf({ ...m, subToolSince: undefined }, null, NOW, LIVE, 'writer', 't').state).not.toBe('working')
  })

  it('OpenCode: a tool running in the open turn (a long bash, or a `task` subagent inside it) carries toolSince — its main turn obeys the same bound', () => {
    const row = {
      id: 'oc1',
      project_id: 'p',
      parent_id: null,
      directory: '/tmp/x',
      title: 't',
      version: '1',
      time_created: NOW - 600_000,
      time_updated: NOW - 300_000,
      time_archived: null,
    }
    const msgs = [
      { id: 'm1', session_id: 'oc1', time_created: NOW - 600_000, data: { role: 'user' } },
      {
        id: 'm2',
        session_id: 'oc1',
        time_created: NOW - 590_000,
        data: { role: 'assistant', modelID: 'x', providerID: 'y', tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 },
      },
    ]
    const part = (status: string) => [
      {
        id: 'p1',
        message_id: 'm2',
        session_id: 'oc1',
        time_created: NOW - 300_000,
        data: { type: 'tool', tool: 'task', callID: 'c1', state: { status, time: { start: NOW - 300_000 } } },
      },
    ]
    const m = opencodeMetaOf(row as never, msgs as never, part('running') as never, {})
    expect(m.turnOpen).toBe(true)
    expect(m.toolSince).toBe(NOW - 300_000)
    expect(conversationWorking(m, NOW, LIVE)).toBe(true)
    expect(opencodeMetaOf(row as never, msgs as never, part('completed') as never, {}).toolSince).toBeUndefined()
  })
})

// two things an open tool_use is NOT. A Monitor, a wakeup or a
// workflow PARKS the conversation (waiting on something — never working);
// a Bash sent to the background answers at once, and the conversation works
// with its turn closed until the engine's notification names that command.
describe('parked is not working; a background command it awaits is', () => {
  const open = (at: number): string => line({ type: 'user', timestamp: iso(at), message: { role: 'user', content: 'go' } })
  const use = (at: number, id: string, name: string, input: unknown = {}): string =>
    line({ type: 'assistant', timestamp: iso(at), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] } })
  const bgResult = (at: number, id: string, task: string): string =>
    line({
      type: 'user',
      timestamp: iso(at),
      toolUseResult: { backgroundTaskId: task },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Command running in background with ID: ${task}.` }] },
    })
  const closed = (at: number): string =>
    line({ type: 'assistant', timestamp: iso(at), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'It runs.' }] } }) +
    line({ type: 'system', subtype: 'turn_duration', durationMs: 1000, timestamp: iso(at) })
  const notified = (at: number, task: string): string =>
    line({
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: iso(at),
      content: `<task-notification>\n<task-id>${task}</task-id>\n<status>completed</status>\n</task-notification>`,
    })
  const write = (body: string): void => writeFileSync(join(root, FOLDER, 'aaa.jsonl'), body)

  it.each(['Monitor', 'ScheduleWakeup', 'Workflow'])('an open %s, 14 min in: no tool in flight — the card reads waiting, not working', async (name) => {
    const t = NOW - 14 * 60_000
    write(open(t - 1000) + use(t, 'tu_park', name, { description: 'the error rate' }))
    const m = await meta()
    expect(m.toolSince).toBeUndefined()
    expect(conversationWorking(m, NOW, LIVE)).toBe(false)
    expect(boardCardOf(m, idx.getContext(FOLDER, 'aaa'), NOW, LIVE, 'writer', 't').state).toBe('waiting')
  })

  it('a parking tool beside a computing one: the computing one is in flight', async () => {
    const t = NOW - 5 * 60_000
    write(
      open(t - 1000) +
        line({
          type: 'assistant',
          timestamp: iso(t),
          message: {
            role: 'assistant',
            stop_reason: 'tool_use',
            content: [
              { type: 'tool_use', id: 'a', name: 'Monitor', input: {} },
              { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'npm test' } },
            ],
          },
        }),
    )
    expect((await meta()).toolSince).toBe(t)
  })

  it('a Bash sent to the background: working with the turn closed, until its notification — and never past the bound', async () => {
    const t = NOW - 10 * 60_000
    const body =
      open(t - 2000) + use(t - 1000, 'tu_bg', 'Bash', { command: 'npm run e2e', run_in_background: true }) + bgResult(t, 'tu_bg', 'sh1') + closed(t + 1000)
    write(body)
    const m = await meta()
    expect(m.turnOpen).toBe(false)
    expect(m.shellSince).toBe(t)
    expect(conversationWorking(m, NOW, LIVE)).toBe(true)
    expect(boardCardOf(m, null, NOW, LIVE, 'writer', 't').state).toBe('working')
    expect(shellAtWork({ shellSince: NOW - SHELL_MAX_MS - 1 }, NOW)).toBe(false)
    // a wake is never held by it: the engine takes input while a command runs
    expect(backgroundBusy({ sessions: () => [{ ...m, id: 'aaa' }], now: () => NOW, liveMs: LIVE })('aaa')).toBe(false)
    // its notification lands (appended — the incremental read): no longer awaited
    appendFileSync(join(root, FOLDER, 'aaa.jsonl'), notified(NOW - 1000, 'sh1'))
    expect((await idx.refresh(FOLDER, 'aaa', false))!.shellSince).toBeUndefined()
  })

  it("a background id that is not a Bash's (a Monitor answers with one too) is not a command it awaits", async () => {
    const t = NOW - 10 * 60_000
    write(open(t - 2000) + use(t - 1000, 'tu_m', 'Monitor', {}) + bgResult(t, 'tu_m', 'mon1') + closed(t + 1000))
    expect((await meta()).shellSince).toBeUndefined()
  })
})
