// escalation/store.ts — what the escalation remembers, in Silos' OWN data
// dir (<dataDir>/escalation/state.json, through safe-file.ts):
//
//   settings  the window between hops (hours; default 24) — the one knob,
//             set by the owner on the chain silo's page
//   cases     every stuck thing being asked about: its subject, when the
//             case opened, the hops made (who, when)
//   closed    the last CLOSED_KEEP cases that closed (who moved it, when) —
//             the page's short history
//
// A corrupt file is set aside (backupCorruptJson) and the escalation starts
// clean: an open case forgotten re-opens from its subject — it asks again
// from the first hop, never skips one it cannot prove.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { readContainedTextOrNull, writeContained } from '../safe-file.js'
import { backupCorruptJson } from '../json-store.js'
import { DEFAULT_WINDOW_HOURS, MAX_WINDOW_HOURS, MIN_WINDOW_HOURS, type Case } from './evaluate.js'

export const STATE_MAX_BYTES = 2 * 1024 * 1024
export const CLOSED_KEEP = 50

export interface EscalationState {
  version: 1
  settings: { windowHours: number }
  cases: Record<string, Case>
  closed: Array<Case & { closedAt: string }>
  // when the engine first looked at routed rows — set once; until then the
  // next look is the strict baseline (evaluate.ts)
  routedBaselineAt?: string
}

const empty = (): EscalationState => ({ version: 1, settings: { windowHours: DEFAULT_WINDOW_HOURS }, cases: {}, closed: [] })
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function validWindowHours(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= MIN_WINDOW_HOURS && v <= MAX_WINDOW_HOURS ? v : null
}

export class EscalationStore {
  readonly dir: string
  private state: EscalationState = empty()

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'escalation')
    this.load()
  }

  private load(): void {
    let text: string | null = null
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      text = readContainedTextOrNull(this.dir, 'state.json', { maxBytes: STATE_MAX_BYTES })
      if (text === null) return
      const raw = JSON.parse(text) as unknown
      if (!isObj(raw) || raw.version !== 1) throw new Error('not an escalation state')
      const settings = isObj(raw.settings) ? raw.settings : {}
      this.state = {
        version: 1,
        settings: { windowHours: validWindowHours(settings.windowHours) ?? DEFAULT_WINDOW_HOURS },
        cases: isObj(raw.cases)
          ? (Object.fromEntries(Object.entries(raw.cases).filter(([, c]) => isObj(c) && Array.isArray((c as Record<string, unknown>).hops))) as Record<
              string,
              Case
            >)
          : {},
        closed: Array.isArray(raw.closed) ? (raw.closed as EscalationState['closed']).filter(isObj).slice(-CLOSED_KEEP) : [],
        ...(typeof raw.routedBaselineAt === 'string' ? { routedBaselineAt: raw.routedBaselineAt } : {}),
      }
    } catch {
      if (text !== null && text !== '') {
        try {
          backupCorruptJson(join(this.dir, 'state.json'), text, 'escalation', { mode: 0o600 })
        } catch {
          /* set aside or not, start clean */
        }
      }
      this.state = empty()
    }
  }

  private save(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    writeContained(this.dir, 'state.json', JSON.stringify(this.state), { mode: 0o600 })
  }

  windowHours(): number {
    return this.state.settings.windowHours
  }
  windowMs(): number {
    return this.state.settings.windowHours * 3600_000
  }
  cases(): Record<string, Case> {
    return this.state.cases
  }
  closed(): ReadonlyArray<Case & { closedAt: string }> {
    return this.state.closed
  }
  routedBaselineAt(): string | undefined {
    return this.state.routedBaselineAt
  }

  markRoutedBaseline(now: number): void {
    this.state.routedBaselineAt = new Date(now).toISOString()
    this.save()
  }

  setWindowHours(h: number): void {
    this.state.settings.windowHours = h
    this.save()
  }

  // the cases now, and the ones that closed — saved only when something changed
  commit(cases: Record<string, Case>, closed: readonly Case[], now: number): void {
    const changed = closed.length > 0 || JSON.stringify(cases) !== JSON.stringify(this.state.cases)
    if (!changed) return
    const at = new Date(now).toISOString()
    this.state.cases = cases
    this.state.closed = [...this.state.closed, ...closed.map((c) => ({ ...c, closedAt: at }))].slice(-CLOSED_KEEP)
    this.save()
  }
}
