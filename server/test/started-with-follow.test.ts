// Started with, FOLLOWED: a conversation's transcript is fed as it
// grows instead of being read whole on every request. The reading after
// feeding in growth steps must be the reading of one pass over the whole
// file — proved here over the golden transcripts and over the one shape
// that moves the first turn (a reply before any api-request-shape).
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readStartedWith, TranscriptStartedWith, pyDumps, pyDumpsHead } from '../src/harnesses/claude-code/started-with.js'
import type { StartedWithContext } from '../src/harnesses/contract.js'

const F = join(import.meta.dirname, 'fixtures', 'started-with')
const fixture = (name: string): string[] =>
  (name.endsWith('.gz') ? gunzipSync(readFileSync(join(F, name))).toString('utf8') : readFileSync(join(F, name), 'utf8')).split('\n')
const ctxOf = (name: string): StartedWithContext => JSON.parse(readFileSync(join(F, `${name}.ctx.json`), 'utf8')) as StartedWithContext

// growth steps of varied sizes (1, 2, 5, 11, 23 lines, …, cycling)
function steps(n: number): number[] {
  const sizes = [1, 2, 5, 11, 23, 47, 3]
  const out: number[] = []
  for (let at = 0, i = 0; at < n; i++) {
    const k = Math.min(sizes[i % sizes.length]!, n - at)
    out.push(k)
    at += k
  }
  return out
}

const CASES: [string, string][] = [
  ['builder-console-clear.jsonl', 'builder'],
  ['finance-sdk.jsonl', 'finance'],
  ['finance-console-persisted-hook.jsonl', 'finance'],
  ['titler-sdk.jsonl', 'titler'],
  ['worktree-console.jsonl', 'builder'],
  ['silos-console-long.jsonl.gz', 'silos'],
]

describe('a transcript fed in growth steps reads the same as the whole file', () => {
  for (const [file, ctxName] of CASES) {
    it(`${file}: every growth step equals one pass over that prefix, and the last equals the whole`, () => {
      const lines = fixture(file)
      const ctx = ctxOf(ctxName)
      const feed = new TranscriptStartedWith()
      let at = 0
      const cuts = steps(lines.length)
      // every step on a short transcript; ~40 checkpoints on the long one
      const every = Math.max(1, Math.floor(cuts.length / 40))
      cuts.forEach((k, i) => {
        feed.feed(lines.slice(at, at + k))
        at += k
        const now = feed.reading(ctx) // read between growths: never changes the fed state
        if (i % every === 0) expect(now).toEqual(readStartedWith(lines.slice(0, at), ctx))
      })
      expect(feed.reading(ctx)).toEqual(readStartedWith(lines, ctx))
      expect(feed.reading(ctx).summary.measured).toBe(true)
    })
  }

  it('a reply before any api-request-shape is the first turn only until a shape appears: every prefix agrees', () => {
    const L = (o: unknown): string => JSON.stringify(o)
    const lines = [
      L({
        type: 'attachment',
        entrypoint: 'cli',
        timestamp: 't0',
        attachment: { type: 'instructions', files: [{ path: '/p/CLAUDE.md', type: 'Project', content: 'P'.repeat(50) }] },
      }),
      L({ type: 'user', timestamp: 't1', message: { role: 'user', content: 'first' } }),
      L({ type: 'attachment', timestamp: 't1', attachment: { type: 'prompt_snapshot', systemPrompt: ['S'.repeat(80)] } }),
      L({ type: 'assistant', timestamp: 't2', message: { role: 'assistant', content: [], usage: { input_tokens: 700 } } }),
      L({ type: 'user', timestamp: 't3', message: { role: 'user', content: 'second' } }),
      L({ type: 'attachment', timestamp: 't3', attachment: { type: 'session_context', context: { userEmail: 'a@example.test' } } }),
      L({ type: 'api-request-shape', timestamp: 't4', shape: { system: [{ type: 'text', text: 'E'.repeat(90) }], tools: [] } }),
      L({ type: 'assistant', timestamp: 't5', message: { role: 'assistant', content: [], usage: { input_tokens: 0 } } }),
      L({ type: 'assistant', timestamp: 't6', message: { role: 'assistant', content: [], usage: { input_tokens: 1200 } } }),
      L({ type: 'assistant', timestamp: 't7', message: { role: 'assistant', content: [], usage: { input_tokens: 1500 } } }),
    ]
    const ctx: StartedWithContext = { charter: null, loaded: null, catalog: [], silosPluginDir: '/silos/plugin', projectDir: '/p' }
    const feed = new TranscriptStartedWith()
    for (let i = 0; i < lines.length; i++) {
      feed.feed([lines[i]!])
      expect(feed.reading(ctx)).toEqual(readStartedWith(lines.slice(0, i + 1), ctx))
    }
    // the shape moved the first turn to the reply after it
    expect(feed.reading(ctx).summary).toMatchObject({ totalTokens: 1200, at: 't6' })
  })
})

describe('pyDumpsHead — the first n characters of pyDumps, serializing no further', () => {
  it('equals pyDumps(v).slice(0, n) for strings, arrays and objects of every shape', () => {
    const values: unknown[] = [
      '',
      'plain',
      'q"uote\\back\nline\ttab é ✻ 日本 😀',
      'x'.repeat(5000),
      [],
      [1, 'a', null, true, { k: 'v' }],
      [{ type: 'text', text: '<command-name>/clear</command-name>' + 'y'.repeat(900) }],
      { a: 1, b: [2, 3], c: { d: 'e'.repeat(300) }, u: undefined, n: NaN },
      42,
      null,
      undefined,
      false,
    ]
    for (const v of values) for (const n of [0, 1, 2, 7, 50, 200, 10_000]) expect(pyDumpsHead(v, n)).toBe(pyDumps(v).slice(0, n))
  })
})
