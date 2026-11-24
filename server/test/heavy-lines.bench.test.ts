// Heavy transcript lines (200 KB – 2 MB tool results and images among normal
// lines) — by hand only: SILOS_BENCH=1. Prints the worst lateness of a 5 ms
// timer while each sliced reader runs; asserts no time.
import { describe, it } from 'vitest'
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { ClaudeReader } from '../src/harnesses/claude-code/reader.js'
import { TranscriptStartedWith } from '../src/harnesses/claude-code/started-with.js'
import { sliceLines } from '../src/jsonl-lines.js'

async function stall(fn: () => Promise<unknown>): Promise<number> {
  const TICK = 5
  let worst = 0
  let last = performance.now()
  const t = setInterval(() => {
    const now = performance.now()
    worst = Math.max(worst, now - last - TICK)
    last = now
  }, TICK)
  try {
    await fn()
    await new Promise((r) => setTimeout(r, 15))
  } finally {
    clearInterval(t)
  }
  return Math.round(worst)
}

let n = 0
const at = (): string => new Date(Date.parse('2026-10-01T09:00:00Z') + n++ * 1000).toISOString()
// one turn; every `heavyEvery` turns a heavy tool result (an agent's report
// with its usage, or a base64 image)
function turn(i: number): string {
  const tu = `toolu_${i}`
  const lines: unknown[] = [
    { type: 'user', timestamp: at(), cwd: '/tmp/p', message: { role: 'user', content: `step ${i} ` + 'x'.repeat(300) } },
    {
      type: 'assistant',
      timestamp: at(),
      message: {
        id: `m${i}`,
        role: 'assistant',
        model: 'claude-opus-4-1',
        content: [{ type: 'tool_use', id: tu, name: 'Agent', input: { prompt: 'p'.repeat(2000) } }],
        usage: { input_tokens: 4, output_tokens: 100, cache_read_input_tokens: 50_000 },
      },
    },
  ]
  if (i % 4 === 0) {
    const size = 200_000 + ((i * 97_531) % 1_800_000)
    const content =
      i % 8 === 0
        ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: randomBytes(Math.floor(size * 0.75)).toString('base64') } }]
        : [{ type: 'text', text: JSON.stringify({ rows: Array.from({ length: Math.floor(size / 60) }, (_, k) => ({ k, v: `value ${k}`, ok: true })) }) }]
    // a structured result too (an edit's patch hunks: many small objects —
    // what makes real lines costlier per byte than long strings)
    const structured = {
      structuredPatch: Array.from({ length: Math.floor(size / 400) }, (_, k) => ({
        oldStart: k,
        oldLines: 3,
        newStart: k,
        newLines: 4,
        lines: [' a', '-b', '+c', '+d'],
      })),
    }
    lines.push({
      type: 'user',
      timestamp: at(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu, content }] },
      toolUseResult: { status: 'completed', usage: { input_tokens: 9, output_tokens: 9 }, content, ...structured },
    })
  } else {
    lines.push({
      type: 'user',
      timestamp: at(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu, content: 'ok '.repeat(3000) }] },
      toolUseResult: { status: 'completed', usage: { input_tokens: 9, output_tokens: 9 } },
    })
  }
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

describe.skipIf(!process.env.SILOS_BENCH)('heavy lines (benchmark)', () => {
  it('worst 5 ms timer lateness while each sliced reader runs', async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-heavy-'))
    const root = join(base, 'projects')
    const dir = join(root, '-tmp-p', 's1', 'subagents')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    const main = join(root, '-tmp-p', 's1.jsonl')
    let body = ''
    for (let i = 0; Buffer.byteLength(body) < 40 * 1024 * 1024; i++) body += turn(i)
    writeFileSync(main, body)
    writeFileSync(join(dir, 'agent-aaaa1111.jsonl'), body)
    const out: Record<string, number> = { 'file MB': Math.round(Buffer.byteLength(body) / 1048576) }
    out['parse every line (sliceLines + JSON.parse)'] = await stall(() =>
      sliceLines(main, 0, Buffer.byteLength(body), (lines) => {
        for (const l of lines) {
          try {
            JSON.parse(l)
          } catch {
            /* */
          }
        }
      }),
    )
    const reader = new ClaudeReader(root, join(base, 'cache.json'))
    out['reader first read (refresh)'] = await stall(() => reader.refresh('-tmp-p', 's1'))
    out['subagent census (Usage records)'] = await stall(() => reader.listSubagents('-tmp-p', 's1'))
    const feed = new TranscriptStartedWith()
    out['started-with, whole file'] = await stall(() =>
      sliceLines(main, 0, Buffer.byteLength(body), (l) => {
        feed.feed(l)
      }),
    )
    const add = turn(4) + turn(5)
    appendFileSync(main, add)
    out['started-with, growth only'] = await stall(() =>
      sliceLines(main, Buffer.byteLength(body), Buffer.byteLength(body) + Buffer.byteLength(add), (l) => {
        feed.feed(l)
      }),
    )
    reader.stop()
    const report =
      Object.entries(out)
        .map(([k, v]) => `  ${k.padEnd(46)} ${v}`)
        .join('\n') + '\n'
    if (process.env.SILOS_BENCH_OUT) writeFileSync(process.env.SILOS_BENCH_OUT, report)
  }, 600_000)
})
