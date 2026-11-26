// plan-usage.ts — how much of a Claude subscription's 5-hour and weekly
// windows is spent, per account, from the same endpoint Claude Code's own
// /usage reads (GET api.anthropic.com/api/oauth/usage, beta oauth-2025-04-20).
//
// Read-only on the account: the access token is READ from the account's
// .credentials.json and never refreshed nor written (refresh tokens rotate —
// Silos refreshing would race the CLI and could log the owner out). An
// expired token = the last good reading, marked stale; the next claude that
// runs on the account refreshes it. Undocumented endpoint: parsing is
// tolerant, an unknown shape reads as "unavailable", never a guess.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const FRESH_MS = 90_000 // one call per account per 90 s, however many columns ask
const BACKOFF_MS = 5 * 60_000 // after a 429 or a network failure
const TIMEOUT_MS = 10_000

export interface UsageWindow {
  kind: string // 'session' | 'weekly_all' | 'weekly_scoped' | a new one, raw
  label: string // '5h' | 'Week' | the scope's model name ('Fable')
  percent: number
  resetsAt: string | null
  windowMs: number | null // length of the window, for the pace tick (null = unknown)
  severity: 'normal' | 'warning' | 'critical'
  active: boolean // this window is the one holding the account back right now
}

export type PlanUsage =
  | { ok: true; at: number; stale: boolean; windows: UsageWindow[] }
  | { ok: false; at: number; reason: 'not-logged-in' | 'token-expired' | 'unavailable'; detail?: string }

const FIVE_H = 5 * 3600_000
const WEEK = 7 * 24 * 3600_000

function severityOf(raw: unknown, percent: number): UsageWindow['severity'] {
  if (raw === 'normal' || raw === 'warning' || raw === 'critical') return raw
  return percent >= 90 ? 'critical' : percent >= 75 ? 'warning' : 'normal'
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function iso(v: unknown): string | null {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null
}

// The response carries two shapes: `limits` (one entry per window the
// account has, with severity and scope — the one Claude Code's /usage
// draws) and the older per-key objects (five_hour, seven_day, …). `limits`
// first; the keyed form only when it is absent.
export function parseUsage(body: unknown): UsageWindow[] | null {
  if (body === null || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (Array.isArray(b.limits)) {
    const out: UsageWindow[] = []
    for (const l of b.limits as unknown[]) {
      if (l === null || typeof l !== 'object') continue
      const e = l as Record<string, unknown>
      const percent = num(e.percent)
      if (percent === null || typeof e.kind !== 'string') continue
      const group = typeof e.group === 'string' ? e.group : ''
      const scope = e.scope as { model?: { display_name?: unknown } } | null | undefined
      const scoped = typeof scope?.model?.display_name === 'string' ? scope.model.display_name : null
      const label = scoped ?? (group === 'session' || e.kind === 'session' ? '5h' : group === 'weekly' ? 'Week' : e.kind.replace(/_/g, ' '))
      out.push({
        kind: e.kind,
        label,
        percent,
        resetsAt: iso(e.resets_at),
        windowMs: group === 'session' ? FIVE_H : group === 'weekly' ? WEEK : null,
        severity: severityOf(e.severity, percent),
        active: e.is_active === true,
      })
    }
    return out
  }
  const keyed: Array<[string, string, number]> = [
    ['five_hour', '5h', FIVE_H],
    ['seven_day', 'Week', WEEK],
    ['seven_day_opus', 'Opus', WEEK],
    ['seven_day_sonnet', 'Sonnet', WEEK],
  ]
  const out: UsageWindow[] = []
  for (const [key, label, windowMs] of keyed) {
    const w = b[key] as Record<string, unknown> | null | undefined
    const percent = num(w?.utilization)
    if (!w || percent === null) continue
    out.push({ kind: key, label, percent, resetsAt: iso(w.resets_at), windowMs, severity: severityOf(undefined, percent), active: percent >= 100 })
  }
  return out.length > 0 ? out : null
}

interface Credentials {
  token: string
  expiresAt: number | null
}

function readCredentials(configDir: string): Credentials | null {
  try {
    const raw = JSON.parse(readFileSync(join(configDir, '.credentials.json'), 'utf8')) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } }
    const token = raw.claudeAiOauth?.accessToken
    if (typeof token !== 'string' || token === '') return null
    return { token, expiresAt: num(raw.claudeAiOauth?.expiresAt) }
  } catch {
    return null
  }
}

export interface PlanUsageDeps {
  // provider id → config dir ('default' → ~/.claude, 'account:<name>' → its dir)
  configDirOf: (providerId: string) => string | null
  fetch?: typeof fetch
  now?: () => number
  // where each account's last GOOD reading is kept across restarts
  // (<dataDir>/plan-usage.json, 0600): without it a restart forgot every
  // reading, and an account the endpoint then answered 429 for showed no
  // bars at all — a failure is meant to show the last good one, stale.
  // Absent (tests): memory only, as before.
  cacheFile?: string
}

interface Entry {
  reading: PlanUsage | null
  good: Extract<PlanUsage, { ok: true }> | null
  until: number
  inflight: Promise<PlanUsage> | null
}

export class PlanUsageService {
  private cache = new Map<string, Entry>()
  private fetchFn: typeof fetch
  private now: () => number

  constructor(private deps: PlanUsageDeps) {
    this.fetchFn = deps.fetch ?? fetch
    this.now = deps.now ?? Date.now
    // the last good readings a previous run kept: they stand as stale until
    // a fresh one lands (never as fresh — `until` 0 asks the endpoint first)
    if (deps.cacheFile) {
      try {
        const kept = JSON.parse(readFileSync(deps.cacheFile, 'utf8')) as Record<string, unknown>
        for (const [id, g] of Object.entries(kept)) {
          const r = g as { at?: unknown; windows?: unknown }
          if (typeof r?.at === 'number' && Array.isArray(r.windows)) {
            this.cache.set(id, { reading: null, good: { ok: true, at: r.at, stale: false, windows: r.windows as UsageWindow[] }, until: 0, inflight: null })
          }
        }
      } catch {
        /* none kept, or unreadable: start empty */
      }
    }
  }

  private persist(): void {
    if (!this.deps.cacheFile) return
    const out: Record<string, { at: number; windows: UsageWindow[] }> = {}
    for (const [id, e] of this.cache) if (e.good) out[id] = { at: e.good.at, windows: e.good.windows }
    try {
      const tmp = `${this.deps.cacheFile}.tmp`
      writeFileSync(tmp, JSON.stringify(out) + '\n', { mode: 0o600 })
      renameSync(tmp, this.deps.cacheFile)
    } catch {
      /* a reading that is not kept is only lost at the next restart */
    }
  }

  async get(providerId: string): Promise<PlanUsage | null> {
    const dir = this.deps.configDirOf(providerId)
    if (dir === null) return null // not a Claude account
    let e = this.cache.get(providerId)
    if (!e) {
      e = { reading: null, good: null, until: 0, inflight: null }
      this.cache.set(providerId, e)
    }
    if (e.reading && this.now() < e.until) return e.reading
    if (e.inflight) return e.inflight
    const entry = e
    entry.inflight = this.read(dir, entry).finally(() => {
      entry.inflight = null
    })
    return entry.inflight
  }

  // The reading already in hand — never a fetch. The inbox composes
  // synchronously (every resident tick), so it reads this and warms with get().
  peek(providerId: string): PlanUsage | null {
    return this.cache.get(providerId)?.reading ?? null
  }

  // a failure keeps showing the last good reading (stale) rather than
  // blanking the bars; with no good reading yet, the reason itself.
  private fallback(e: Entry, reason: Extract<PlanUsage, { ok: false }>['reason'], detail?: string): PlanUsage {
    return e.good ? { ...e.good, stale: true } : { ok: false, at: this.now(), reason, ...(detail ? { detail } : {}) }
  }

  private async read(dir: string, e: Entry): Promise<PlanUsage> {
    const now = this.now()
    const creds = readCredentials(dir)
    let out: PlanUsage
    let ttl = FRESH_MS
    if (!creds) {
      out = { ok: false, at: now, reason: 'not-logged-in' }
    } else if (creds.expiresAt !== null && creds.expiresAt <= now) {
      out = this.fallback(e, 'token-expired')
      ttl = 30_000 // re-read the file soon: a running claude refreshes it
    } else {
      try {
        const res = await this.fetchFn(USAGE_URL, {
          headers: { authorization: `Bearer ${creds.token}`, 'anthropic-beta': 'oauth-2025-04-20' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
        if (!res.ok) {
          out = this.fallback(e, res.status === 401 ? 'token-expired' : 'unavailable', `HTTP ${res.status}`)
          if (res.status === 429) ttl = BACKOFF_MS
        } else {
          const windows = parseUsage(await res.json())
          if (windows === null) {
            out = this.fallback(e, 'unavailable', 'unknown response')
          } else {
            e.good = { ok: true, at: now, stale: false, windows }
            out = e.good
            this.persist()
          }
        }
      } catch {
        out = this.fallback(e, 'unavailable', 'network')
        ttl = BACKOFF_MS
      }
    }
    e.reading = out
    e.until = now + ttl
    return out
  }
}
