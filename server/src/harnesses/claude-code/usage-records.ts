// harnesses/claude-code/usage-records.ts — a Claude Code transcript's
// assistant records as Usage reads them (contract.ts UsageRecord): when,
// which model, what it used, and its price from
// model-prices.ts (the ONE price table — neutral code never names it).
//
// One assistant message id = one bill, however many lines repeat it (Claude
// Code writes one line per content block, each with the same usage): the
// FIRST line of an id with non-zero usage counts — the rule context.ts
// countUsage and reader.ts scanSubUsage already follow. `<synthetic>` lines
// (the CLI's own placeholders) never count. A line without a timestamp can't
// be placed in a window: it is skipped, never guessed.
//
// Incremental (UsageFileCache): a finished file is read once and remembered
// by (bytes, mtime); a live one only pays for what was appended. In memory
// only, and BOUNDED: past a total of records the least recently read files
// are forgotten (read again from the start if asked for). A file that shrank
// is read again from the start.
import { stat } from 'node:fs/promises'
import { sliceLines } from '../../jsonl-lines.js'
import { priceUsage } from './model-prices.js'
import type { UsageRecord } from '../contract.js'

const n = (v: unknown): number => (typeof v === 'number' && v > 0 ? v : 0)

/** The records of `lines` (one transcript, or one subagent's), each new
 *  message id once — `seen` carries the ids already counted in this file. */
export function usageRecordsOfLines(lines: readonly string[], session: string, seen: Set<string> = new Set()): UsageRecord[] {
  const out: UsageRecord[] = []
  for (const line of lines) {
    if (!line.includes('"usage"')) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (obj.type !== 'assistant') continue
    const msg = obj.message as { id?: unknown; model?: unknown; usage?: unknown } | undefined
    if (!msg || typeof msg.id !== 'string' || seen.has(msg.id)) continue
    if (typeof msg.model !== 'string' || msg.model === '<synthetic>') continue
    const at = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN
    if (!Number.isFinite(at)) continue
    const u = msg.usage as
      | {
          input_tokens?: unknown
          output_tokens?: unknown
          cache_read_input_tokens?: unknown
          cache_creation_input_tokens?: unknown
          cache_creation?: { ephemeral_1h_input_tokens?: unknown }
        }
      | undefined
    if (!u || typeof u !== 'object') continue
    const input = n(u.input_tokens)
    const output = n(u.output_tokens)
    const cacheRead = n(u.cache_read_input_tokens)
    const cacheWrite = n(u.cache_creation_input_tokens)
    if (input + output + cacheRead + cacheWrite === 0) continue
    seen.add(msg.id)
    const write1h = Math.min(n(u.cache_creation?.ephemeral_1h_input_tokens), cacheWrite)
    const costUsd = priceUsage(msg.model, { input, output, cacheRead, cacheWrite5m: cacheWrite - write1h, cacheWrite1h: write1h })
    out.push({ id: msg.id, at, model: msg.model, tokens: { in: input, out: output, cacheRead, cacheWrite }, costUsd, session })
  }
  return out
}

/** One subagent's bill for the census (DiskSubagent.usage): the sum of its
 *  file's records — exactly what Usage sums for it (one message id once, the
 *  four kinds of tokens) — and its dollars, null when any record has no
 *  price (never a lying partial figure). Null when it used nothing. */
export function subagentBill(
  recs: readonly UsageRecord[],
): { input: number; output: number; cacheRead: number; cacheWrite: number; usd: number | null } | null {
  if (recs.length === 0) return null
  const b = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 as number | null }
  for (const r of recs) {
    b.input += r.tokens.in
    b.output += r.tokens.out
    b.cacheRead += r.tokens.cacheRead
    b.cacheWrite += r.tokens.cacheWrite
    b.usd = b.usd === null || r.costUsd === null ? null : b.usd + r.costUsd
  }
  return b
}

interface FileUsage {
  bytes: number
  mtime: number
  seen: Set<string>
  records: UsageRecord[]
}

/** What the cache keeps at most, in records across its files (~a few
 *  hundred bytes each): a 30-day read of a busy machine fits. */
export const USAGE_CACHE_MAX_RECORDS = 150_000

/** Per-path incremental reads (see the header). */
export class UsageFileCache {
  // insertion order = least recently read first
  private files = new Map<string, FileUsage>()
  private pending = new Map<string, Promise<UsageRecord[] | null>>()
  private total = 0

  constructor(private maxRecords = USAGE_CACHE_MAX_RECORDS) {}

  /** records held now (tests) */
  get size(): number {
    return this.total
  }

  /** The records of the file at `path`, attributed to `session`; null when
   *  the file can't be read. Reads of one path run one after another. */
  read(path: string, session: string): Promise<UsageRecord[] | null> {
    const prev = this.pending.get(path) ?? Promise.resolve(null)
    const next = prev.catch(() => null).then(() => this.advance(path, session))
    this.pending.set(path, next)
    void next
      .finally(() => {
        if (this.pending.get(path) === next) this.pending.delete(path)
      })
      .catch(() => {})
    return next
  }

  private forget(path: string): void {
    const f = this.files.get(path)
    if (!f) return
    this.total -= f.records.length
    this.files.delete(path)
  }

  // the least recently read files go first; the one just read stays
  private evict(keep: string): void {
    for (const p of this.files.keys()) {
      if (this.total <= this.maxRecords) return
      if (p !== keep) this.forget(p)
    }
  }

  private async advance(path: string, session: string): Promise<UsageRecord[] | null> {
    const st = await stat(path).catch(() => null)
    if (!st) {
      this.forget(path)
      return null
    }
    let f = this.files.get(path)
    if (!f || st.size < f.bytes) {
      this.forget(path)
      f = { bytes: 0, mtime: 0, seen: new Set(), records: [] }
    } else this.files.delete(path)
    this.files.set(path, f) // most recently read
    if (st.size === f.bytes && st.mtimeMs === f.mtime) return f.records
    f.mtime = st.mtimeMs
    // complete lines only (a partial tail waits), in slices with the loop
    // released between them (jsonl-lines.ts) — a first read can be tens of MB
    const file = f
    await sliceLines(path, f.bytes, st.size, (lines, bytes) => {
      const added = usageRecordsOfLines(lines, session, file.seen)
      for (const r of added) file.records.push(r)
      // another path's read may have forgotten this one meanwhile: its
      // records then no longer count in the total
      if (this.files.get(path) === file) this.total += added.length
      file.bytes += bytes
    }).catch(() => 0) // unreadable now: what was read stands, the next read goes on
    this.evict(path)
    return f.records
  }
}
