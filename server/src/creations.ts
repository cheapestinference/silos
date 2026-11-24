// creations.ts — the ledger of an agent's OWN creations:
// ~/.silos/heartbeats/<agentId>/creations.json
//
//   { items: [{ id, kind: 'task'|'automation', ref, title, createdAt, run?,
//               signal?, by, action?: 'withdrew'|'paused', readOutside?,
//               undoneAt?, undoneBy?, keptAt?, rejected?: { at, why },
//               adopted?: { at, label } }] }
//
// The source of the quota and of the measure. «Own
// creation» = created by the agent in an UNATTENDED turn, by whichever path
// (append-item or editing the plan file); what an attended
// conversation creates is stamped in plans-origins.json, never here
// (Decided is what was decided WITHOUT the owner). Written ONLY by
// plans-provenance.ts (tasks) and the automations route (recurring work and
// the bearer's lone acts on it: withdraw, pause — m7, m4-r7). Silos'
// rejections enter with `rejected` (Measures.rejected).
//
// The file is sealed (heartbeats/** — restore regime): every write
// goes through the seal; while the server lives its memory is the truth.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { sealHooks } from './seal-hooks.js'

export type CreationKind = 'task' | 'automation'

/** Who really restored a creation Silos cancelled or the owner undid: the
 *  label never fabricates an owner's gesture. */
export type AdoptedLabel = 'kept by the owner' | 'restored in an attended conversation'

export interface Creation {
  id: string
  kind: CreationKind
  /** a task: its plans record key (`<location>/<plan>/tasks/<id>`); an
   *  automation: its id */
  ref: string
  title: string
  createdAt: string
  /** the run that created it (live-turns runOfTurn) — what the turn-end restamp looks up */
  run?: string
  signal?: string
  /** the root of the creation: 'mission' when its
   *  signal is `mission`, or it answers a task or a message whose root is
   *  — what the proactive day's count and its open tasks are counted by */
  root?: 'mission'
  /** the agent (the creator) */
  by: string
  /** a lone act of the bearer on its recurring work */
  action?: 'withdrew' | 'paused'
  readOutside?: string[]
  undoneAt?: string
  undoneBy?: string
  /** the owner's «Keep» in the Only-when-told sheet (G6-r6), or the adoption
   *  of a restored undone ref */
  keptAt?: string
  rejected?: { at: string; why: string }
  adopted?: { at: string; label: AdoptedLabel }
  /** each time it reopened this task of its own (done or cancelled → open)
   *  from a proactive turn: a reopen spends the day's count like a creation */
  reopenedAt?: string[]
  /** the owner handed this task to another: it no
   *  longer counts in its creator's open tasks (openFromMissionRoot) */
  handedAt?: string
}

const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

export class CreationsStore {
  private cache = new Map<string, Creation[]>()

  constructor(
    private dataDir: string,
    private now: () => Date = () => new Date(),
  ) {}

  private file(agentId: string): string {
    if (!AGENT_ID.test(agentId)) throw new Error('invalid agent id')
    return join(this.dataDir, 'heartbeats', agentId, 'creations.json')
  }

  private load(agentId: string): Creation[] {
    const hit = this.cache.get(agentId)
    if (hit) return hit
    const f = this.file(agentId)
    let items: Creation[] = []
    if (existsSync(f)) {
      try {
        const raw = JSON.parse(readFileSync(f, 'utf8')) as { items?: unknown }
        if (Array.isArray(raw.items)) items = raw.items.filter(isCreation)
      } catch {
        /* a torn file reads as empty; the seal restores what Silos wrote */
      }
    }
    this.cache.set(agentId, items)
    return items
  }

  private save(agentId: string, items: Creation[]): void {
    const f = this.file(agentId)
    mkdirSync(join(this.dataDir, 'heartbeats', agentId), { recursive: true, mode: 0o700 })
    const text = `${JSON.stringify({ items }, null, 2)}\n`
    this.cache.set(agentId, items)
    if (sealHooks().write?.(f, text) === true) return
    const tmp = `${f}.tmp`
    writeFileSync(tmp, text, { mode: 0o600 })
    renameSync(tmp, f)
  }

  /** Every entry of the agent, oldest first. */
  list(agentId: string): Creation[] {
    try {
      return this.load(agentId).map((c) => ({ ...c }))
    } catch {
      return []
    }
  }

  add(agentId: string, c: Omit<Creation, 'id'> & { id?: string }): Creation {
    const items = [...this.load(agentId)]
    const entry: Creation = { ...c, id: c.id ?? `c-${randomBytes(6).toString('hex')}` }
    items.push(entry)
    this.save(agentId, items)
    return { ...entry }
  }

  update(agentId: string, id: string, patch: Partial<Omit<Creation, 'id'>> & { clear?: Array<keyof Creation> }): Creation | null {
    const items = [...this.load(agentId)]
    const i = items.findIndex((c) => c.id === id)
    if (i < 0) return null
    const { clear, ...rest } = patch
    const next: Creation = { ...items[i]!, ...rest }
    for (const k of clear ?? []) delete (next as unknown as Record<string, unknown>)[k]
    items[i] = next
    this.save(agentId, items)
    return { ...next }
  }

  /** The creation (not a lone act) of a ref, newest first. */
  byRef(agentId: string, ref: string): Creation | null {
    const all = this.load(agentId)
    for (let i = all.length - 1; i >= 0; i--) if (all[i]!.ref === ref && !all[i]!.action) return { ...all[i]! }
    return null
  }

  /** Every creation stamped with a run (the end of a turn re-stamps
   *  and, tainted, undoes what it created). */
  byRun(agentId: string, run: string): Creation[] {
    return this.load(agentId)
      .filter((c) => c.run === run && !c.action)
      .map((c) => ({ ...c }))
  }

  /** The run's final readOutside onto every entry of the run. */
  restampRun(agentId: string, run: string, readOutside: string[]): number {
    if (readOutside.length === 0) return 0
    const items = [...this.load(agentId)]
    let n = 0
    for (let i = 0; i < items.length; i++) {
      const c = items[i]!
      if (c.run !== run) continue
      const merged = [...new Set([...(c.readOutside ?? []), ...readOutside])]
      if (merged.length === (c.readOutside?.length ?? 0)) continue
      items[i] = { ...c, readOutside: merged }
      n++
    }
    if (n > 0) this.save(agentId, items)
    return n
  }

  /** The time base of the store (tests). */
  at(): string {
    return this.now().toISOString()
  }
}

function isCreation(v: unknown): v is Creation {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    (o.kind === 'task' || o.kind === 'automation') &&
    typeof o.ref === 'string' &&
    typeof o.by === 'string' &&
    typeof o.createdAt === 'string'
  )
}

/** A creation that still counts as made (not rejected, or rejected and then
 *  adopted — a restoration consumes its class's quota, M5-r4). */
export function counted(c: Creation): boolean {
  return !c.action && (!c.rejected || c.adopted !== undefined)
}
