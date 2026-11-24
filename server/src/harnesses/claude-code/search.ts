// search.ts — full-text search across conversation transcripts. No index
// to maintain: a streamed scan over the JSONL files, newest session first,
// with an early stop once enough sessions match. It matches only what a
// human said or read — the MESSAGE TEXT (parser.textOf) — never tool
// internals, thinking, or base64 blobs, so a hit is always something the
// owner could actually have seen in the conversation.
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { textOf, conversationalMessage } from './parser.js'

export interface SearchHit {
  folder: string
  id: string
  role: 'user' | 'assistant' // who said the FIRST matching message
  snippet: string
  count: number // matching messages in this session
  mtime: number
}

export interface SearchResult {
  hits: SearchHit[]
  scanned: number // sessions actually read
  truncated: boolean // stopped early (enough hits) — older sessions unscanned
}

const MAX_SESSION_HITS = 30
const SNIPPET_RADIUS = 80

export async function searchTranscripts(sessions: { folder: string; id: string; mtime: number; path: string }[], q: string): Promise<SearchResult> {
  const needle = q.toLowerCase()
  const hits: SearchHit[] = []
  let scanned = 0
  const ordered = [...sessions].sort((a, b) => b.mtime - a.mtime)
  for (const s of ordered) {
    if (hits.length >= MAX_SESSION_HITS) return { hits, scanned, truncated: true }
    scanned += 1
    const hit = await scanFile(s, needle)
    if (hit) hits.push(hit)
  }
  return { hits, scanned, truncated: false }
}

async function scanFile(s: { folder: string; id: string; mtime: number; path: string }, needle: string): Promise<SearchHit | null> {
  let count = 0
  let first: { role: 'user' | 'assistant'; snippet: string } | null = null
  try {
    const rl = createInterface({ input: createReadStream(s.path, { encoding: 'utf8' }), crlfDelay: Infinity })
    for await (const line of rl) {
      // cheap pre-filter: no JSON.parse unless the raw line can match at all.
      if (!line.toLowerCase().includes(needle)) continue
      let e: Record<string, unknown>
      try {
        e = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (e.isCompactSummary === true) continue
      const msg = conversationalMessage(e)
      if (!msg) continue
      const role = msg.role
      const text = textOf(msg?.content)
      const idx = text.toLowerCase().indexOf(needle)
      if (idx === -1) continue // the raw-line match was in tool internals — not something the owner read
      count += 1
      if (!first) {
        const start = Math.max(0, idx - SNIPPET_RADIUS)
        const end = Math.min(text.length, idx + needle.length + SNIPPET_RADIUS)
        const core = text.slice(start, end).replace(/\s+/g, ' ').trim()
        first = { role, snippet: `${start > 0 ? '…' : ''}${core}${end < text.length ? '…' : ''}` }
      }
    }
  } catch {
    return null // an unreadable file is simply not a hit, never a crash
  }
  return first ? { folder: s.folder, id: s.id, role: first.role, snippet: first.snippet, count, mtime: s.mtime } : null
}
