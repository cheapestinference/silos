// digest-job.ts — the platform job that writes the daily digest
// beside the resident's tick but never one of its
// automations: no run, no budget, no agent, zero tokens.
//
// At the owner's hour (notifications.json `digestHour`, default 08:00, read
// in the server's zone or `digestTz` — cron.ts' wall-clock handling, DST
// included) it composes <dataDir>/digests/<YYYY-MM-DD>.json. The file is the
// record, so the job is idempotent: today's file written = nothing to do.
// After a restart that slept through the hour, the first tick writes it late
// (`late: true`) — one file for the newest missed day; its window starts
// where the previous digest ended, so nothing in between is lost or counted
// twice.
//
// The owner's «Seen» on the Home band is an ack in needs-you-acks.json
// (kind `digest`, key `home`, version = the newest date seen): the same
// store, the same «I know about THIS version» — an unread digest is one
// whose date is newer.
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson, backupCorruptJson } from './json-store.js'
import { isValidTimeZone, nextRun } from './cron.js'
import { composeDigest, isDigestFile, sumDigests, type DigestBand, type DigestFacts, type DigestFile } from './digest.js'
import type { InboxRow } from './inbox.js'

export const DEFAULT_DIGEST_HOUR = '08:00'
const HOUR_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
export const isDigestHour = (v: unknown): v is string => typeof v === 'string' && HOUR_RE.test(v)

// ── the owner's notification prefs (a small file, like the other prefs) ────

export interface NotificationPrefs {
  digestHour: string
  digestTz?: string
}

export class NotificationPrefsStore {
  private file: string
  private cache: NotificationPrefs | null = null

  constructor(dataDir: string) {
    this.file = join(dataDir, 'notifications.json')
  }

  get(): NotificationPrefs {
    if (this.cache) return { ...this.cache }
    let out: NotificationPrefs = { digestHour: DEFAULT_DIGEST_HOUR }
    if (existsSync(this.file)) {
      const text = readFileSync(this.file, 'utf8')
      try {
        const raw = JSON.parse(text) as Partial<NotificationPrefs>
        out = {
          digestHour: isDigestHour(raw.digestHour) ? raw.digestHour : DEFAULT_DIGEST_HOUR,
          ...(typeof raw.digestTz === 'string' && isValidTimeZone(raw.digestTz) ? { digestTz: raw.digestTz } : {}),
        }
      } catch {
        backupCorruptJson(this.file, text, 'notifications')
      }
    }
    this.cache = out
    return { ...out }
  }

  setDigestHour(hour: string): NotificationPrefs {
    if (!isDigestHour(hour)) throw new Error('invalid hour')
    const next = { ...this.get(), digestHour: hour }
    atomicWriteJson(this.file, next)
    this.cache = next
    return { ...next }
  }
}

// ── the hour, on the wall clock ────────────────────────────────────────────

// the local day ('YYYY-MM-DD') an instant falls on, in `tz` or the server's zone
export function localDay(ms: number, tz?: string): string {
  if (tz) return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// The newest occurrence of `hour` at or before `now` (cron.ts walks the
// wall clock, so a DST change never skips or doubles a morning).
export function latestSlot(hour: string, now: number, tz?: string): { at: number; date: string } {
  const [h, m] = hour.split(':').map((s) => Number.parseInt(s, 10)) as [number, number]
  const expr = `${m} ${h} * * *`
  let at = nextRun(expr, new Date(now - 49 * 3600_000), tz).getTime()
  for (;;) {
    const next = nextRun(expr, new Date(at), tz).getTime()
    if (next > now) break
    at = next
  }
  return { at, date: localDay(at, tz) }
}

// ── the files ──────────────────────────────────────────────────────────────

const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/
// how far back an unread band reaches — a month away is not a morning
const UNREAD_DAYS = 31

export class DigestStore {
  readonly dir: string

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'digests')
  }

  dates(): string[] {
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return []
    }
    return names
      .flatMap((n) => {
        const m = FILE_RE.exec(n)
        return m ? [m[1]!] : []
      })
      .sort()
  }

  has(date: string): boolean {
    return existsSync(join(this.dir, `${date}.json`))
  }

  read(date: string): DigestFile | null {
    try {
      const raw: unknown = JSON.parse(readFileSync(join(this.dir, `${date}.json`), 'utf8'))
      return isDigestFile(raw) ? raw : null
    } catch {
      return null
    }
  }

  // the newest readable digest strictly before `date`
  previous(date: string): DigestFile | null {
    for (const d of this.dates().reverse()) {
      if (d >= date) continue
      const f = this.read(d)
      if (f) return f
    }
    return null
  }

  write(f: DigestFile): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    atomicWriteJson(join(this.dir, `${f.date}.json`), f, { mode: 0o600 })
  }

  // every readable digest newer than `seen` (the date the owner last
  // marked), within the last month, summed into one band
  unread(seen: string | null, today: string): DigestBand | null {
    const floor = shiftDay(today, -UNREAD_DAYS)
    const files = this.dates()
      .filter((d) => (seen === null || d > seen) && d >= floor)
      .flatMap((d) => {
        const f = this.read(d)
        return f ? [f] : []
      })
    return sumDigests(files)
  }
}

function shiftDay(day: string, by: number): string {
  const [y, m, d] = day.split('-').map((s) => Number.parseInt(s, 10)) as [number, number, number]
  const t = new Date(Date.UTC(y, m - 1, d + by))
  return t.toISOString().slice(0, 10)
}

// ── the job ────────────────────────────────────────────────────────────────

export interface DigestJobOptions {
  store: DigestStore
  prefs: Pick<NotificationPrefsStore, 'get'>
  inbox: (now: number) => InboxRow[]
  facts: (from: number, to: number) => DigestFacts
  // `lateByMs`: how long after its hour the file was written (0 on time)
  onWritten?: (f: DigestFile, lateByMs: number) => void
  // a slot older than this when written counts as late
  lateAfterMs?: number
}

export class DigestJob {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private opts: DigestJobOptions) {}

  // Write today's digest if its hour has come and it isn't written yet.
  // Returns the file written, or null.
  tick(now: number = Date.now()): DigestFile | null {
    const { digestHour, digestTz } = this.opts.prefs.get()
    const slot = latestSlot(digestHour, now, digestTz)
    if (this.opts.store.has(slot.date)) return null
    const previous = this.opts.store.previous(slot.date)
    const prevTo = previous ? Date.parse(previous.to) : NaN
    const from = Number.isFinite(prevTo) && prevTo < now ? prevTo : slot.at - 24 * 3600_000
    const file = composeDigest({
      date: slot.date,
      hour: digestHour,
      from,
      to: now,
      late: now - slot.at > (this.opts.lateAfterMs ?? 5 * 60_000),
      inbox: this.opts.inbox(now),
      facts: this.opts.facts(from, now),
      previous,
    })
    this.opts.store.write(file)
    try {
      this.opts.onWritten?.(file, Math.max(0, now - slot.at))
    } catch (err) {
      console.warn('digest: a listener failed —', err instanceof Error ? err.message : err)
    }
    return file
  }

  private safeTick(): void {
    try {
      this.tick()
    } catch (err) {
      console.warn('digest: could not write today’s digest —', err instanceof Error ? err.message : err)
    }
  }

  // ticks now (the catch-up) and then with the resident's heartbeat
  start(intervalMs: number): void {
    if (this.timer) return
    this.safeTick()
    this.timer = setInterval(() => this.safeTick(), intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
