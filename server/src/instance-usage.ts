// instance-usage.ts — how much this Silos is used, told to its Silos ID
// broker once a day. Only an instance that signs in through a broker
// (SILOS_ID_URL) has one to tell; SILOS_TELEMETRY=off stops it.
//
// What is kept, per UTC day, in <dataDir>/instance-usage.json:
//   hours       the UTC hours in which the owner's credential reached the
//               API (an open tab polls, so «Silos was open», not «typed»)
//   attended    turns the owner started: a chat turn, a console opened
//   unattended  turns Silos started on its own: heartbeats, wakes, runs
// Nothing else: no names, paths, prompts, agents or content.
//
// What is sent: the finished days not yet sent (UTC days before today, the
// last MAX_UNSENT of them), with the Silos version — POST <broker>/usage.
// Tried at boot and every hour, so a day lands once, the first hour after
// it ends that the instance is up. Sent days are dropped from the file.
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { atomicWriteJson } from './json-store.js'

export interface UsageDay {
  hours: number[]
  attended: number
  unattended: number
}
export interface UsageReport {
  days: Array<{ day: string } & UsageDay>
}

/** at most this many finished days are kept and sent (an instance down for
 *  longer loses the oldest) */
export const MAX_UNSENT = 30

const utcDay = (t: number): string => new Date(t).toISOString().slice(0, 10)

/** SILOS_TELEMETRY: on unless it says off (off, 0, false, no). */
export function telemetryOn(v: string | undefined): boolean {
  return !/^(off|0|false|no)$/i.test((v ?? '').trim())
}

/** The version told with the report: the repo's package version, plus the
 *  commit when the platform names it (Railway: RAILWAY_GIT_COMMIT_SHA). */
export function silosVersion(env: NodeJS.ProcessEnv): string {
  let v = '0.0.0'
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as { version?: unknown }
    if (typeof pkg.version === 'string') v = pkg.version
  } catch {
    /* unknown */
  }
  const sha = (env.RAILWAY_GIT_COMMIT_SHA ?? '').trim()
  return /^[0-9a-f]{7,40}$/i.test(sha) ? `${v}+${sha.slice(0, 7)}` : v
}

export interface InstanceUsageOptions {
  /** absent: memory only (tests) */
  file?: string
  now?: () => number
  /** hands finished days to the broker; true = they landed */
  send: (report: UsageReport) => Promise<boolean>
}

export class InstanceUsage {
  private days: Record<string, UsageDay> = {}
  private readonly now: () => number
  private sending: Promise<void> | null = null

  constructor(private readonly opts: InstanceUsageOptions) {
    this.now = opts.now ?? Date.now
    this.days = this.read()
  }

  private read(): Record<string, UsageDay> {
    const f = this.opts.file
    if (!f || !existsSync(f)) return {}
    try {
      const o = JSON.parse(readFileSync(f, 'utf8')) as { days?: Record<string, Partial<UsageDay>> }
      const out: Record<string, UsageDay> = {}
      for (const [d, u] of Object.entries(o.days ?? {})) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue
        out[d] = {
          hours: Array.isArray(u.hours) ? u.hours.filter((h): h is number => Number.isInteger(h) && h >= 0 && h < 24) : [],
          attended: Number.isInteger(u.attended) ? (u.attended as number) : 0,
          unattended: Number.isInteger(u.unattended) ? (u.unattended as number) : 0,
        }
      }
      return out
    } catch {
      return {}
    }
  }

  private save(): void {
    if (!this.opts.file) return
    try {
      atomicWriteJson(this.opts.file, { days: this.days })
    } catch {
      /* usage never breaks Silos */
    }
  }

  private today(): UsageDay {
    const d = utcDay(this.now())
    return (this.days[d] ??= { hours: [], attended: 0, unattended: 0 })
  }

  /** The owner's credential reached the API: this hour was active. Writes
   *  only when the hour is new (at most 24 writes a day). */
  markActive(): void {
    const h = new Date(this.now()).getUTCHours()
    const day = this.today()
    if (day.hours.includes(h)) return
    day.hours.push(h)
    day.hours.sort((a, b) => a - b)
    this.save()
  }

  /** A turn started — by the owner (attended) or by Silos itself. */
  countTurn(attended: boolean): void {
    const day = this.today()
    if (attended) day.attended++
    else day.unattended++
    this.save()
  }

  /** The finished days still to send (oldest first), at most MAX_UNSENT. */
  pending(): UsageReport['days'] {
    const today = utcDay(this.now())
    return Object.keys(this.days)
      .filter((d) => d < today)
      .sort()
      .slice(-MAX_UNSENT)
      .map((day) => ({ day, ...this.days[day]! }))
  }

  /** Send the finished days; the ones that landed leave the file, and days
   *  past MAX_UNSENT go with them. One send at a time. */
  report(): Promise<void> {
    this.sending ??= (async () => {
      const days = this.pending()
      const today = utcDay(this.now())
      const keep = new Set(days.map((d) => d.day))
      let changed = false
      for (const d of Object.keys(this.days))
        if (d < today && !keep.has(d)) {
          delete this.days[d]
          changed = true
        }
      if (days.length > 0) {
        let landed = false
        try {
          landed = await this.opts.send({ days })
        } catch {
          landed = false
        }
        if (landed) {
          for (const d of days) delete this.days[d.day]
          changed = true
        }
      }
      if (changed) this.save()
    })().finally(() => {
      this.sending = null
    })
    return this.sending
  }
}
