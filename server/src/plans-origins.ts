// plans-origins.ts — the ORIGIN of every plan task, per installation:
// ~/.silos/plans-origins.json, keyed by the task's
// plans record key, written only by the server and inside the seal (the
// restore regime). What the assign gate and the stamper read.
//
//   by        'owner' | 'unknown' | <agent id>
//   how       how the origin was learnt: the owner's own act (UI or API with
//             the owner's credential — 'owner'), a blessing gesture ('keep':
//             «Keep it — it's mine», 'give': the owner's Give/assign,
//             'keep-all': the baseline's block door), an attended conversation
//             of the agent ('attended'), an own creation ('creation' — its
//             entry lives in creations.json), a baseline record ('baseline'),
//             or nobody ('unclaimed')
//   creation  the pointer to heartbeats/<agent>/creations.json when the ref
//             is an own creation
//   provisional  a single (or several) unattended candidate turns live when it
//             appeared: the verdict waits for their end and a WRITE in their
//             transcript — until then it is treated as unknown
//   keptAt / undoneAt / undoneBy  of refs without an agent creator
//
// A ref absent from both registries is unknown until the stamper registers
// it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { sealHooks } from './seal-hooks.js'

export type OriginHow = 'owner' | 'keep' | 'give' | 'keep-all' | 'attended' | 'creation' | 'baseline' | 'unclaimed'

export interface Candidate {
  agentId: string
  run: string
  turnId: string
  sessionId?: string
  /** the session's folder as its reader keys it, when known */
  folder?: string
  startedAt: string
}

export interface Origin {
  by: string // 'owner' | 'unknown' | agent id
  at: string
  how: OriginHow
  /** the plan file the task lives in (absolute) */
  file?: string
  title?: string
  creation?: { agent: string; id: string }
  provisional?: { candidates: Candidate[]; since: string }
  keptAt?: string
  undoneAt?: string
  undoneBy?: string
  /** what an unattended run left on the task that its reader reads as
   *  context: a NOTE on a task of another owner or a question to the
   *  owner — `waitingOn.asked`. Re-stamped with the run's final
   *  readOutside: the feed, the briefing and the ask row paint it. */
  marks?: Mark[]
}

export interface Mark {
  kind: 'note' | 'ask'
  at: string
  run: string
  agent: string
  readOutside?: string[]
  /** the `at` of the notes it marks */ noteAts?: string[]
}

/** The readOutside of a note on a task (by its author and `at`), or null. */
export function noteReadOutside(o: Origin | null, note: { at: string; by: string }): string[] | null {
  for (const m of o?.marks ?? []) if (m.kind === 'note' && m.agent === note.by && m.noteAts?.includes(note.at) && m.readOutside?.length) return m.readOutside
  return null
}

export class PlansOrigins {
  private refs: Record<string, Origin> | null = null

  constructor(private file: string) {}

  private load(): Record<string, Origin> {
    if (this.refs) return this.refs
    let refs: Record<string, Origin> = {}
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { refs?: unknown }
        if (raw.refs && typeof raw.refs === 'object' && !Array.isArray(raw.refs)) refs = raw.refs as Record<string, Origin>
      } catch {
        /* torn: empty — the seal restores what Silos wrote */
      }
    }
    this.refs = refs
    return refs
  }

  private save(): void {
    const text = `${JSON.stringify({ refs: this.load() }, null, 2)}\n`
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    if (sealHooks().write?.(this.file, text) === true) return
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, text, { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  get(ref: string): Origin | null {
    const o = this.load()[ref]
    return o ? { ...o } : null
  }

  all(): Record<string, Origin> {
    return { ...this.load() }
  }

  set(ref: string, o: Origin): void {
    this.load()[ref] = o
    this.save()
  }

  patch(ref: string, p: Partial<Origin> & { clear?: Array<keyof Origin> }): Origin | null {
    const cur = this.load()[ref]
    if (!cur) return null
    const { clear, ...rest } = p
    const next: Origin = { ...cur, ...rest }
    for (const k of clear ?? []) delete (next as unknown as Record<string, unknown>)[k]
    this.load()[ref] = next
    this.save()
    return { ...next }
  }

  /** A mark of a run on a task (creates an `unknown` origin when absent). */
  addMark(ref: string, m: Mark): void {
    const refs = this.load()
    const cur = refs[ref] ?? { by: 'unknown', how: 'unclaimed', at: m.at }
    refs[ref] = { ...cur, marks: [...(cur.marks ?? []), m].slice(-50) }
    this.save()
  }

  /** the run's final readOutside onto every mark it left. */
  restampMarks(agent: string, run: string, readOutside: string[]): number {
    if (readOutside.length === 0) return 0
    let n = 0
    for (const o of Object.values(this.load())) {
      for (const m of o.marks ?? []) {
        if (m.run !== run || m.agent !== agent) continue
        const merged = [...new Set([...(m.readOutside ?? []), ...readOutside])]
        if (merged.length !== (m.readOutside?.length ?? 0)) {
          m.readOutside = merged
          n++
        }
      }
    }
    if (n > 0) this.save()
    return n
  }

  /** Several at once, one write (the baseline's «Keep them all»). */
  setMany(entries: Array<[string, Origin]>): void {
    if (entries.length === 0) return
    const refs = this.load()
    for (const [k, o] of entries) refs[k] = o
    this.save()
  }
}

/** may the agent's own `assign` (and the packet's `yours`)
 *  treat the ref as an order? Only a known, settled, non-unknown origin.
 *  A provisional one is unknown until confirmed; an absent one too. */
export function originIsKnown(o: Origin | null): boolean {
  return o !== null && o.by !== 'unknown' && o.provisional === undefined
}
