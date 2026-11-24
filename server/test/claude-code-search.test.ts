// search.test.ts — transcript search: hits only on MESSAGE TEXT (never tool
// internals), honest snippets, per-session counts, newest-first with an
// early stop.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchTranscripts } from '../src/harnesses/claude-code/search.js'

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

function makeFiles(): { a: string; b: string; c: string } {
  const dir = mkdtempSync(join(tmpdir(), 'deck-search-'))
  const a = join(dir, 'a.jsonl')
  writeFileSync(
    a,
    jsonl([
      { type: 'user', message: { role: 'user', content: 'where did the frontier pricing land?' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'The frontier pricing landed at 12€ — see the sheet.' }] } },
    ]),
  )
  const b = join(dir, 'b.jsonl')
  writeFileSync(
    b,
    jsonl([
      // the needle appears ONLY inside a tool_use input — the owner never read it
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'grep frontier notes.md' } }] } },
    ]),
  )
  const c = join(dir, 'c.jsonl')
  writeFileSync(c, jsonl([{ type: 'user', message: { role: 'user', content: 'unrelated chatter' } }]))
  return { a, b, c }
}

describe('searchTranscripts', () => {
  it('hits message text with a snippet and per-session count; tool internals never match', async () => {
    const { a, b, c } = makeFiles()
    const res = await searchTranscripts(
      [
        { folder: 'f', id: 'a', mtime: 3, path: a },
        { folder: 'f', id: 'b', mtime: 2, path: b },
        { folder: 'f', id: 'c', mtime: 1, path: c },
      ],
      'frontier',
    )
    expect(res.hits).toHaveLength(1)
    const hit = res.hits[0]!
    expect(hit.id).toBe('a')
    expect(hit.count).toBe(2) // the user's and the assistant's messages both match
    expect(hit.role).toBe('user') // the first matching message
    expect(hit.snippet).toContain('frontier pricing')
    expect(res.truncated).toBe(false)
  })

  it('an unreadable path is skipped, never a crash', async () => {
    const res = await searchTranscripts([{ folder: 'f', id: 'x', mtime: 1, path: '/nope/missing.jsonl' }], 'frontier')
    expect(res.hits).toHaveLength(0)
    expect(res.scanned).toBe(1)
  })
})

describe('searchTranscripts — request blobs', () => {
  it('a needle that lives only in an api-request-blob is not a hit; a real message counts once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deck-search-blob-'))
    const f = join(dir, 'blob.jsonl')
    writeFileSync(
      f,
      jsonl([
        { type: 'user', message: { role: 'user', content: 'how is the zeppelin doing?' } },
        { type: 'api-request-blob', message: { role: 'user', content: 'how is the zeppelin doing?' } },
        { type: 'api-request-blob', message: { role: 'assistant', content: [{ type: 'text', text: 'zeppelin replay' }] } },
      ]),
    )
    const res = await searchTranscripts([{ folder: 'f', id: 'blob', path: f, mtime: 1 }], 'zeppelin')
    expect(res.hits[0]?.count).toBe(1)
    const onlyBlob = join(dir, 'only.jsonl')
    writeFileSync(onlyBlob, jsonl([{ type: 'api-request-blob', message: { role: 'assistant', content: [{ type: 'text', text: 'zeppelin' }] } }]))
    expect((await searchTranscripts([{ folder: 'f', id: 'only', path: onlyBlob, mtime: 1 }], 'zeppelin')).hits).toHaveLength(0)
  })
})
