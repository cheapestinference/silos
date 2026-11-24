// home-since.ts — Home's «Since …» band: what
// happened while the owner was away, composed by the server from what it
// already keeps (zero tokens). The moment it serves: coming back to Home and
// SEEING, in one sentence, what moved without you — above all what an agent
// decided alone, with its Undo one touch away (R10).
//
//   GET /api/home/since → HomeSince
//     from        the owner's previous visit (visits.json; «visit» =
//                 opening Home)
//     done        plan tasks closed done since (the kernel's journal)
//     automations runs that ended since, and how many automations ran them
//     stuck       tasks whose one wake changed nothing — «Stuck» is only ever
//                 «stopped after its tries» (the vocabulary rule)
//     decided     the agents' own creations and lone acts since (the ledger)
//     needsYou    rows that stop work now (blocking + due)
//     usage       the most-used Claude account's weekly window, by ACCOUNT
//                 (shared — never attributed to an agent)
//     cost        today's unattended spend when the unattended provider is an
//                 API key that prices turns («~$2.10 today»)
//
// The visit is stamped ONLY under the owner's credential (an unknown
// GET has no effects, a bearer never reads Home); the band reads the value
// from BEFORE that stamp.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson } from './json-store.js'
import type { Creation } from './creations.js'

export interface HomeSince {
  from: string
  done: number
  automations: { ran: number; of: number }
  stuck: number
  decided: Creation[]
  needsYou: number
  usage: { percent: number; account: string; agents: number } | null
  cost: { usd: number } | null
}

/** ~/.silos/visits.json — `{ homeAt }`: when the owner last opened Home. */
export class VisitsStore {
  private file: string
  private homeAt: string | null = null
  private loaded = false

  constructor(dataDir: string) {
    this.file = join(dataDir, 'visits.json')
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    if (!existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { homeAt?: unknown }
      if (typeof raw.homeAt === 'string' && Number.isFinite(Date.parse(raw.homeAt))) this.homeAt = raw.homeAt
    } catch {
      /* a torn file reads as no visit yet: the band waits for the next one */
    }
  }

  last(): string | null {
    this.load()
    return this.homeAt
  }

  /** The visit now; returns the PREVIOUS one (what the band counts from). */
  stamp(now: number): string | null {
    const prev = this.last()
    this.homeAt = new Date(now).toISOString()
    atomicWriteJson(this.file, { homeAt: this.homeAt }, { mode: 0o600 })
    return prev
  }
}

export interface SinceFacts {
  /** plan tasks done in [from, now) */
  done: number
  /** runs that ended in [from, now), by automation id */
  runs: ReadonlyArray<{ automationId: string }>
  stuck: number
  decided: Creation[]
  needsYou: number
  /** each Claude account's weekly window in use (percent), with how many
   *  live agents run on it */
  accounts: ReadonlyArray<{ account: string; weeklyPercent: number | null; agents: number }>
  /** today's unattended spend in USD when the unattended provider prices
   *  turns (an API key) — null otherwise */
  costUsd: number | null
}

/** The band's numbers from the facts (pure). With no visit before, `from` is
 *  now: nothing happened «since» a first look. */
export function composeSince(from: string | null, now: number, f: SinceFacts): HomeSince {
  const ran = f.runs.length
  const of = new Set(f.runs.map((r) => r.automationId)).size
  const weekly = f.accounts.filter((a) => a.weeklyPercent !== null).sort((a, b) => (b.weeklyPercent ?? 0) - (a.weeklyPercent ?? 0))[0] ?? null
  return {
    from: from ?? new Date(now).toISOString(),
    done: f.done,
    automations: { ran, of },
    stuck: f.stuck,
    decided: f.decided,
    needsYou: f.needsYou,
    usage: weekly ? { percent: Math.round(weekly.weeklyPercent!), account: weekly.account, agents: weekly.agents } : null,
    cost: f.costUsd !== null ? { usd: Math.round(f.costUsd * 100) / 100 } : null,
  }
}

/** The weekly window of a plan-usage reading: the account-wide one («Week»)
 *  when the reading has it, else the most-used weekly window. */
export function weeklyPercentOf(windows: ReadonlyArray<{ kind: string; label: string; percent: number; windowMs: number | null }>): number | null {
  const weekly = windows.filter((w) => w.windowMs === 7 * 24 * 3600_000)
  const all = weekly.find((w) => w.label === 'Week' || w.kind === 'weekly_all' || w.kind === 'seven_day')
  if (all) return all.percent
  return weekly.length > 0 ? Math.max(...weekly.map((w) => w.percent)) : null
}
