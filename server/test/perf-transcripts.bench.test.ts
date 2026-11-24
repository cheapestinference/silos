// The event-loop benchmark of transcript reading and session listing — run
// by hand, never in the suite (SILOS_BENCH=1 npx vitest run
// test/perf-transcripts.bench.test.ts). It PRINTS the longest synchronous
// stretch of each phase and asserts nothing about time (wall-clock asserts
// are flaky on a loaded machine; the behaviour tests live in
// transcript-yield.test.ts). Synthetic install, generic names only: ~1,500
// sessions in lineage chains up to depth 10 and one 40 MB transcript.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry, mungePath } from '../src/agent-registry.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { LineageStore } from '../src/lineage.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { buildServer } from '../src/server.js'
import { asOwner } from './helpers/owner.js'

// worst lateness of a 5 ms interval while `fn` runs = the longest stretch
// the event loop could not serve a timer
async function stall<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const TICK = 5
  let worst = 0
  let last = performance.now()
  const t = setInterval(() => {
    const now = performance.now()
    worst = Math.max(worst, now - last - TICK)
    last = now
  }, TICK)
  try {
    const value = await fn()
    // one more turn so a stretch at the very end is seen
    await new Promise((r) => setTimeout(r, TICK * 2))
    return { ms: Math.round(Math.max(worst, performance.now() - last - TICK)), value }
  } finally {
    clearInterval(t)
  }
}

async function startProfile(): Promise<() => Promise<unknown>> {
  const { Session } = await import('node:inspector')
  const session = new Session()
  session.connect()
  const post = (m: string, p?: object) => new Promise<unknown>((res, rej) => session.post(m, p ?? {}, (err, r) => (err ? rej(err) : res(r))))
  await post('Profiler.enable')
  await post('Profiler.setSamplingInterval', { interval: 200 })
  await post('Profiler.start')
  return async () => {
    const r = (await post('Profiler.stop')) as { profile: unknown }
    session.disconnect()
    return r.profile
  }
}

let ts = Date.parse('2026-10-01T09:00:00Z')
const at = (): string => new Date((ts += 1000)).toISOString()
const pad = (n: number): string => 'lorem ipsum dolor sit amet '.repeat(Math.ceil(n / 27)).slice(0, n)

// one realistic turn of a long agent session (~25 KB)
function turnLines(sid: string, cwd: string, i: number): string {
  const base = { sessionId: sid, cwd, gitBranch: 'main', version: '2.1.300', entrypoint: 'cli', userType: 'external' }
  const tu = `toolu_${i}`
  const lines = [
    { ...base, type: 'user', uuid: randomUUID(), timestamp: at(), message: { role: 'user', content: `step ${i}: ${pad(300)}` } },
    {
      ...base,
      type: 'assistant',
      uuid: randomUUID(),
      timestamp: at(),
      message: {
        id: `msg_${i}a`,
        role: 'assistant',
        model: 'claude-opus-4-1',
        content: [
          { type: 'thinking', thinking: pad(1200) },
          { type: 'text', text: pad(400) },
          {
            type: 'tool_use',
            id: tu,
            name: i % 3 === 0 ? 'Read' : 'Bash',
            input: i % 3 === 0 ? { file_path: `${cwd}/src/file${i}.ts` } : { command: `npm test -- part${i}`, description: 'run tests' },
          },
        ],
        usage: { input_tokens: 12, output_tokens: 900, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 2_000 },
      },
    },
    {
      ...base,
      type: 'user',
      uuid: randomUUID(),
      timestamp: at(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu, content: [{ type: 'text', text: pad(i % 7 === 0 ? 60_000 : 15_000) }] }] },
      toolUseResult: { stdout: pad(2000), stderr: '' },
    },
    {
      ...base,
      type: 'assistant',
      uuid: randomUUID(),
      timestamp: at(),
      message: {
        id: `msg_${i}b`,
        role: 'assistant',
        model: 'claude-opus-4-1',
        content: [{ type: 'text', text: pad(800) }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 300, cache_read_input_tokens: 82_000, cache_creation_input_tokens: 0 },
      },
    },
    { ...base, type: 'system', subtype: 'turn_duration', durationMs: 4000, timestamp: at() },
  ]
  if (i % 50 === 0) lines.push({ type: 'ai-title', aiTitle: `long session ${i}`, sessionId: sid } as never)
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

function smallSession(sid: string, cwd: string, parent: string | null): string {
  const rec = (o: Record<string, unknown>) => JSON.stringify({ sessionId: sid, ...(parent ? { session_id: parent } : {}), cwd, timestamp: at(), ...o })
  return (
    [
      rec({ type: 'user', message: { role: 'user', content: pad(200) } }),
      rec({
        type: 'assistant',
        message: {
          id: `m-${sid}`,
          role: 'assistant',
          model: 'claude-opus-4-1',
          content: [{ type: 'text', text: pad(600) }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 50 },
        },
      }),
      JSON.stringify({ type: 'ai-title', aiTitle: `conversation ${sid.slice(0, 6)}`, sessionId: sid }),
    ].join('\n') + '\n'
  )
}

describe.skipIf(!process.env.SILOS_BENCH)('transcript + listing event-loop stalls (benchmark)', () => {
  it('measures (a) first read, (b) incremental refresh, (c) the list route, (d) warm-up', async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-bench-'))
    const root = join(base, 'projects')
    const data = join(base, 'data')
    mkdirSync(join(data, 'trash'), { recursive: true })
    const projects = Array.from({ length: 15 }, (_, i) => join(base, 'work', `project-${i}`))
    for (const p of projects) {
      mkdirSync(p, { recursive: true })
      mkdirSync(join(root, mungePath(p)), { recursive: true })
    }
    // 1,500 sessions: chains of depth 1..10
    let n = 0
    let chain = 0
    while (n < 1500) {
      const depth = 1 + (chain % 10)
      const cwd = projects[chain % projects.length]!
      let parent: string | null = null
      for (let d = 0; d < depth && n < 1500; d++, n++) {
        const sid = randomUUID()
        writeFileSync(join(root, mungePath(cwd), `${sid}.jsonl`), smallSession(sid, cwd, parent))
        parent = sid
      }
      chain++
    }
    // the 40 MB transcript
    const bigCwd = projects[0]!
    const bigId = randomUUID()
    const bigPath = join(root, mungePath(bigCwd), `${bigId}.jsonl`)
    const chunks: string[] = []
    let bytes = 0
    for (let i = 0; bytes < 40 * 1024 * 1024; i++) {
      const t = turnLines(bigId, bigCwd, i)
      chunks.push(t)
      bytes += Buffer.byteLength(t)
    }
    writeFileSync(bigPath, chunks.join(''))

    const results: Record<string, number> = {}
    // (d) warm-up with no cache: every transcript read cold (includes the 40 MB one)
    const index = claudeSessionIndex(root, join(data, 'cache', 'sessions.json'))
    mkdirSync(join(data, 'cache'), { recursive: true })
    const t0 = performance.now()
    results['d: warm-up, no cache (1,500 + 40 MB)'] = (await stall(() => index.init())).ms
    results['d: (wall time of that warm-up)'] = Math.round(performance.now() - t0)
    expect(index.allSessions().length).toBe(1501)

    // (a) first read of the big transcript by a reader that has never seen it
    const fresh = claudeSessionIndex(join(base, 'empty-root'), join(data, 'cache', 'other.json'))
    await fresh.init()
    const freshRoot = join(base, 'empty-root', mungePath(bigCwd))
    mkdirSync(freshRoot, { recursive: true })
    writeFileSync(join(freshRoot, `${bigId}.jsonl`), chunks.join(''))
    results['a: first read of 40 MB'] = (await stall(() => fresh.refresh(mungePath(bigCwd), bigId))).ms
    fresh.stopHeartbeat()

    // (b) incremental refresh after appending ~200 KB
    let add = ''
    for (let i = 100_000; Buffer.byteLength(add) < 200 * 1024; i++) add += turnLines(bigId, bigCwd, i)
    appendFileSync(bigPath, add)
    results['b: refresh after +200 KB'] = (await stall(() => index.refresh(mungePath(bigCwd), bigId))).ms
    // the other whole-transcript reads: the conversation's turns, Usage, the audit
    results['e: readTurns of 40 MB'] = (await stall(() => index.readTurns(mungePath(bigCwd), bigId))).ms
    results['e: usageRecords, first read of 40 MB'] = (await stall(() => index.usageRecords(mungePath(bigCwd), bigId))).ms
    results['e: toolCalls of 40 MB'] = (await stall(() => index.toolCalls(mungePath(bigCwd), bigId))).ms

    // (d') restart with a cache flushed before the big file grew again
    await index.flushCache()
    appendFileSync(bigPath, add)
    const again = claudeSessionIndex(root, join(data, 'cache', 'sessions.json'))
    results['d: warm-up, cache present, live file grew'] = (await stall(() => again.init())).ms
    again.stopHeartbeat()

    // (c) the sessions list route (the sidebar's overview) over 1,500 sessions
    const registry = new AgentRegistry(join(data, 'agents.json'))
    registry.load()
    registry.create({ id: 'alpha', name: 'Alpha', folder: projects[0]!, default: true })
    for (let i = 1; i < 6; i++) registry.create({ id: `agent-${i}`, name: `Agent ${i}`, folder: projects[i]! })
    const native = new NativeStore(join(data, 'native.json'))
    const lineage = new LineageStore(join(data, 'lineage.json'))
    const chat = new ChatService({
      registry,
      native,
      queryFn: () => {
        throw new Error('no sdk')
      },
    })
    const app = buildServer({
      index,
      registry,
      native,
      chat,
      lineage,
      dataDir: data,
      store: new SessionStore(root, data),
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs: new PrefsStore(data),
      memory: new MemoryService(root, data, registry),
      token: 't0k',
      liveMs: 120_000,
    })
    asOwner(app, 't0k')
    // the first one also writes down every continuation's owner (lineage.json, once per session ever)
    const first = await stall(() => app.inject({ method: 'GET', url: '/api/overview', headers: { host: '127.0.0.1:3210' } }))
    expect(first.value.statusCode).toBe(200)
    results['c: GET /api/overview (first)'] = first.ms
    // SILOS_BENCH_PROF=<file>: a CPU profile of the steady-state overview
    const prof = process.env.SILOS_BENCH_PROF ? await startProfile() : null
    results['c: GET /api/overview (second)'] = (await stall(() => app.inject({ method: 'GET', url: '/api/overview', headers: { host: '127.0.0.1:3210' } }))).ms
    if (prof) writeFileSync(process.env.SILOS_BENCH_PROF, JSON.stringify(await prof()))
    await app.close()
    index.stopHeartbeat()
    const report =
      '[bench] longest synchronous stretch (ms)\n' +
      Object.entries(results)
        .map(([k, v]) => `  ${k.padEnd(48)} ${v}`)
        .join('\n') +
      '\n'
    if (process.env.SILOS_BENCH_OUT) writeFileSync(process.env.SILOS_BENCH_OUT, report)
    console.log(report)
  }, 600_000)
})
