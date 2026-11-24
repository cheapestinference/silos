// Reading a transcript never freezes the event loop, and a reader never sees
// it half-read (a live server froze the owner's consoles for seconds
// on long transcripts and on session listing). These tests count WORK and
// behaviour — turns of the loop between slices, what a reader observes
// mid-read, how often the rows are rebuilt — never wall-clock time.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeReader } from '../src/harnesses/claude-code/reader.js'
import { TranscriptAccumulator } from '../src/harnesses/claude-code/parser.js'
import { sliceLines, sliceWholeFile, SLICE_BYTES } from '../src/jsonl-lines.js'
import { SessionIndex } from '../src/session-index.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { NativeStore } from '../src/native-store.js'
import { LineageStore } from '../src/lineage.js'
import { SessionOwners } from '../src/session-owner.js'

const FOLDER = '-tmp-proj'
let n = 0
const at = (): string => new Date(Date.parse('2026-10-01T09:00:00Z') + n++ * 1000).toISOString()
const user = (text: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'user', cwd: '/tmp/proj', timestamp: at(), message: { role: 'user', content: text }, ...extra }) + '\n'
const assistant = (text: string): string =>
  JSON.stringify({
    type: 'assistant',
    cwd: '/tmp/proj',
    timestamp: at(),
    message: {
      id: `m${n}`,
      role: 'assistant',
      model: 'claude-opus-4-1',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 4 },
    },
  }) + '\n'
// ~`bytes` of turns, 2 lines per ~4 KB
function turns(bytes: number): string {
  let out = ''
  while (out.length < bytes) out += user('q '.repeat(1000)) + assistant('a '.repeat(1000))
  return out
}

// counts turns of the event loop while `p` runs, calling `look` at each
async function spinWhile<T>(p: Promise<T>, look: () => void = () => {}): Promise<{ turns: number; value: T }> {
  let turns = 0
  let done = false
  const spin = (): void => {
    if (done) return
    turns++
    look()
    setImmediate(spin)
  }
  setImmediate(spin)
  const value = await p
  done = true
  return { turns, value }
}

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'deck-yield-'))
  const root = join(base, 'projects')
  mkdirSync(join(root, FOLDER), { recursive: true })
  const reader = new ClaudeReader(root, join(base, 'cache.json'))
  const index = new SessionIndex(reader)
  return { base, root, reader, index, file: (id: string) => join(root, FOLDER, `${id}.jsonl`) }
}

let stops: (() => void)[] = []
afterEach(() => {
  for (const s of stops) s()
  stops = []
  vi.restoreAllMocks()
})

describe('sliceLines — bounded slices, the loop released between them', () => {
  it('a file of S bytes is handed over in about S / SLICE_BYTES slices, every line once, and the loop runs between slices', async () => {
    const { base } = setup()
    const path = join(base, 'big.jsonl')
    const body = turns(6 * SLICE_BYTES)
    writeFileSync(path, body + '{"partial":') // an unterminated tail waits
    const seen: string[] = []
    let slices = 0
    let consumedBySlices = 0
    const { turns: loopTurns, value: consumed } = await spinWhile(
      sliceLines(path, 0, Buffer.byteLength(body) + 11, (lines, bytes) => {
        slices++
        consumedBySlices += bytes
        seen.push(...lines)
      }),
    )
    expect(consumed).toBe(Buffer.byteLength(body))
    expect(consumedBySlices).toBe(consumed)
    expect(seen).toEqual(body.slice(0, -1).split('\n'))
    expect(slices).toBeGreaterThanOrEqual(Math.floor(Buffer.byteLength(body) / SLICE_BYTES) - 1)
    // the event loop ran between (at least) every two slices
    expect(loopTurns).toBeGreaterThanOrEqual(slices - 1)
  })

  it('a multi-byte character never splits across slices; a whole-file read hands the unterminated last line too', async () => {
    const { base } = setup()
    const path = join(base, 'utf8.jsonl')
    let body = ''
    while (body.length < 3 * SLICE_BYTES) body += JSON.stringify({ t: 'ñandú — 日本語 ✻ '.repeat(50) }) + '\n'
    writeFileSync(path, body + '{"last":"ü"}')
    const lines: string[] = []
    await sliceWholeFile(path, (l) => lines.push(...l))
    expect(lines).toEqual(readFileSync(path, 'utf8').split('\n'))
  })
})

describe('ClaudeReader — a reader never observes a half-fed transcript', () => {
  it('mid-read, meta, context and the listed row stay the last complete state; after, they equal a full parse', async () => {
    const h = setup()
    writeFileSync(h.file('s1'), user('hello') + assistant('hi'))
    await h.index.init()
    stops.push(() => h.index.stopHeartbeat())
    const before = h.index.getMeta(FOLDER, 's1')!
    const ctxBefore = h.index.getContext(FOLDER, 's1')
    expect(before.turnCount).toBe(2)
    appendFileSync(h.file('s1'), turns(5 * SLICE_BYTES))
    let looks = 0
    const { turns: loopTurns, value: meta } = await spinWhile(h.index.refresh(FOLDER, 's1'), () => {
      looks++
      expect(h.index.getMeta(FOLDER, 's1')).toEqual(before)
      expect(h.index.getContext(FOLDER, 's1')).toEqual(ctxBefore)
      expect(h.index.allSessions().find((m) => m.id === 's1')).toEqual(before)
    })
    expect(loopTurns).toBeGreaterThanOrEqual(4) // it did yield, and every look saw the old state
    expect(looks).toBe(loopTurns)
    expect(meta!.turnCount).toBeGreaterThan(before.turnCount)
    // the same answer a reader that parsed the whole file in one go gives
    const cold = new ClaudeReader(h.root, join(h.base, 'cold-cache.json'))
    await cold.init()
    stops.push(() => cold.stop())
    expect(h.index.getMeta(FOLDER, 's1')).toEqual(cold.getMeta(FOLDER, 's1'))
    expect(h.index.getContext(FOLDER, 's1')).toEqual(cold.getContext(FOLDER, 's1'))
  })

  it('a transcript first seen mid-read is not known yet: no meta, no context, no row', async () => {
    const h = setup()
    await h.index.init()
    stops.push(() => h.index.stopHeartbeat())
    writeFileSync(h.file('big'), turns(4 * SLICE_BYTES))
    const { turns: loopTurns, value } = await spinWhile(h.index.refresh(FOLDER, 'big'), () => {
      expect(h.index.getMeta(FOLDER, 'big')).toBeNull()
      expect(h.index.getContext(FOLDER, 'big')).toBeNull()
      expect(h.index.allSessions()).toHaveLength(0)
    })
    expect(loopTurns).toBeGreaterThanOrEqual(3)
    expect(value).not.toBeNull()
    expect(h.index.allSessions()).toHaveLength(1)
  })

  it('a watcher event, a request and warm-up asking at once parse every line exactly once', async () => {
    const h = setup()
    const body = turns(3 * SLICE_BYTES)
    writeFileSync(h.file('s2'), body)
    const lines = body.split('\n').filter((l) => l.trim() !== '').length
    const fed = vi.spyOn(TranscriptAccumulator.prototype, 'feedRecord')
    const all = await Promise.all([h.index.init(), h.index.refresh(FOLDER, 's2'), h.index.refresh(FOLDER, 's2'), h.index.refresh(FOLDER, 's2')])
    stops.push(() => h.index.stopHeartbeat())
    expect(fed).toHaveBeenCalledTimes(lines)
    expect(all[1]).toEqual(h.index.getMeta(FOLDER, 's2'))
    expect(all[3]).toEqual(all[1])
  })
})

describe('SessionIndex — the rows are kept between changes', () => {
  it('allSessions() is the same array until a session changes, and the reader is not listed again', async () => {
    const h = setup()
    for (let i = 0; i < 20; i++) writeFileSync(h.file(`s${i}`), user(`hi ${i}`))
    await h.index.init()
    stops.push(() => h.index.stopHeartbeat())
    const listed = vi.spyOn(h.reader, 'list')
    const first = h.index.allSessions()
    for (let i = 0; i < 50; i++) expect(h.index.allSessions()).toBe(first)
    for (let i = 0; i < 20; i++) expect(h.index.metaById(`s${i}`)?.id).toBe(`s${i}`)
    expect(listed.mock.calls.length).toBeLessThanOrEqual(1)
    appendFileSync(h.file('s3'), assistant('more'))
    await h.index.refresh(FOLDER, 's3')
    const second = h.index.allSessions()
    expect(second).not.toBe(first)
    expect(second.find((m) => m.id === 's3')!.turnCount).toBe(2)
    h.index.remove(FOLDER, 's4')
    expect(h.index.allSessions()).toHaveLength(19)
    expect(h.index.metaById('s4')).toBeNull()
  })

  it('resolving the owner of N sessions in chains of depth 10 lists the index a constant number of times', async () => {
    const h = setup()
    const ids: string[] = []
    for (let c = 0; c < 10; c++) {
      let parent: string | null = null
      for (let d = 0; d < 10; d++) {
        const id = `c${c}-d${d}`
        // a `--resume` continuation: records carry the origin's id
        writeFileSync(h.file(id), user(`step ${d}`, parent ? { sessionId: id, session_id: parent } : { sessionId: id }))
        ids.push(id)
        parent = id
      }
    }
    await h.index.init()
    stops.push(() => h.index.stopHeartbeat())
    const registry = new AgentRegistry(join(h.base, 'agents.json'))
    registry.load()
    registry.create({ id: 'writer', name: 'Writer', folder: '/tmp/proj', default: true })
    const owners = new SessionOwners({
      registry,
      native: new NativeStore(join(h.base, 'native.json')),
      lineage: new LineageStore(join(h.base, 'lineage.json')),
      index: h.index,
      trashDir: null,
    })
    const listed = vi.spyOn(h.reader, 'list')
    for (const m of h.index.allSessions()) expect(owners.agentIdOf(m)).toBe('writer')
    expect(owners.ancestry.ancestorIdsOf(h.index.metaById('c0-d9')!, true, Infinity)).toHaveLength(9)
    expect(listed.mock.calls.length).toBeLessThanOrEqual(1)
    expect(ids).toHaveLength(100)
  })
})
