// egress-log.ts — the observable face of the signer:
// every signed call leaves ONE row — who, with which entry, method, host +
// path (NEVER the query: it may carry ids or a second credential), status,
// duration, when. Never a body. The path is treated as potentially sensitive:
// the rows are the OWNER's to read (routes/egress.ts), never an agent's.
//
// <dataDir>/egress/signed.jsonl, APPEND-ONLY, with the same rotation as the
// automations' runs (automations-store.ts): past EGRESS_ROTATE_BYTES the
// current file becomes .jsonl.1 (one generation kept) and readers fold both.
// A sync is hundreds of calls a day — the log is bounded, never infinite.
//
// The egress proxy's refusals live beside it, rejected.jsonl, under
// the same discipline (EgressRejectLog).
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

// the runs' threshold (RUNS_ROTATE_BYTES): a row is ~200 bytes, so one
// generation is ~10k calls — weeks of a busy sync, two generations kept
export const EGRESS_ROTATE_BYTES = 2 * 1024 * 1024

export interface EgressRow {
  at: string // ISO, when the call started
  agent: string | null // the agent that signed; null = the owner naming no agent
  by: 'agent' | 'owner'
  entry: string // the entry's NAME
  entryId: string
  method: string
  host: string // the bound host (scheme + host[:port])
  path: string // the upstream path, query stripped
  status: number // the upstream's, or Silos' own (502 unreachable, 504 idle)
  ms: number
  error?: string // Silos' short word when the upstream never answered whole
}

// One append-only JSONL with one rotated generation — the discipline both
// egress logs share (rotate by size, O(1) by statSync, like runs.jsonl).
class RotatingJsonl<T> {
  private readonly file: string
  private readonly rotated: string

  constructor(
    private readonly dir: string,
    name: string,
    private readonly rotateBytes: number,
    private readonly what: string,
  ) {
    this.file = join(dir, name)
    this.rotated = `${this.file}.1`
  }

  append(row: T): void {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      this.rotateIfNeeded()
      appendFileSync(this.file, `${JSON.stringify(row)}\n`, { mode: 0o600 })
    } catch (err) {
      // the row is the record, not the call: a full disk never fails a call
      console.warn(`egress-log: could not append a ${this.what} row:`, err instanceof Error ? err.message : err)
    }
  }

  private rotateIfNeeded(): void {
    let size = 0
    try {
      size = statSync(this.file).size
    } catch {
      return
    }
    if (size < this.rotateBytes) return
    rmSync(this.rotated, { force: true })
    renameSync(this.file, this.rotated)
  }

  /** The newest rows first, both generations folded, filtered. */
  read(keep: (r: T) => boolean, limit = 50): T[] {
    const cap = Math.max(1, Math.min(limit, 500))
    const rows: T[] = []
    for (const f of [this.rotated, this.file]) {
      if (!existsSync(f)) continue
      let text = ''
      try {
        text = readFileSync(f, 'utf8')
      } catch {
        continue
      }
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        try {
          const r = JSON.parse(line) as T
          if (keep(r)) rows.push(r)
        } catch {
          /* a torn line is skipped, never fatal */
        }
      }
    }
    return rows.reverse().slice(0, cap)
  }
}

export class EgressLog {
  private readonly jsonl: RotatingJsonl<EgressRow>

  constructor(dir: string, rotateBytes = EGRESS_ROTATE_BYTES) {
    this.jsonl = new RotatingJsonl<EgressRow>(dir, 'signed.jsonl', rotateBytes, 'signed-call')
  }

  append(row: EgressRow): void {
    this.jsonl.append(row)
  }

  /** The newest rows first, both generations folded, filtered. */
  read(filter: { agent?: string; entryId?: string; limit?: number } = {}): EgressRow[] {
    return this.jsonl.read(
      (r) => (filter.agent === undefined || r.agent === filter.agent) && (filter.entryId === undefined || r.entryId === filter.entryId),
      filter.limit,
    )
  }
}

// The egress proxy's refusals (egress-proxy.ts): one
// row per refused CONNECT or forward — who, which host (and port), why,
// when. NEVER a path, a query or a body: the proxy never reads inside a
// tunnel, and a plain forward's path is not kept either. The owner's to
// read (routes/territory-egress.ts). <dataDir>/egress/rejected.jsonl.
export interface EgressRejectRow {
  at: string // ISO
  agentId: string
  host: string // the host the agent asked for, lowercased, no port
  port: number
  reason: string // why, in a phrase: not in its allowlist, or the private address it resolved to
}

export class EgressRejectLog {
  private readonly jsonl: RotatingJsonl<EgressRejectRow>

  constructor(dir: string, rotateBytes = EGRESS_ROTATE_BYTES) {
    this.jsonl = new RotatingJsonl<EgressRejectRow>(dir, 'rejected.jsonl', rotateBytes, 'egress-refusal')
  }

  append(row: EgressRejectRow): void {
    this.jsonl.append(row)
  }

  /** The newest rows first, both generations folded, filtered. */
  read(filter: { agentId?: string; limit?: number } = {}): EgressRejectRow[] {
    return this.jsonl.read((r) => filter.agentId === undefined || r.agentId === filter.agentId, filter.limit)
  }
}
