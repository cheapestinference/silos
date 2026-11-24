// silos/operator.ts — the OPERATOR's state of every silo, in ONE exportable
// file (Silo Standard «The decision ladder», level 3: a serializable operator
// state):
//
//   <dataDir>/silos/operator.json
//   { "version": 1, "silos": { "<id>": {
//       "decision": "approved" | "disabled" | "uninstalled",
//       "producers": ["finance"],          // the agents bound to the producer role, fixed at approval
//       "slotsOff": ["agent-section"], // slots the operator turned off
//       "automationId": "…",           // the sync automation created at approval (opt-in)
//       "conventions": [...],          // what it read — kept so an uninstalled silo's files can still be watched
//       "name": "Invoices", "decidedAt": "…", "installedAt": "…", "uninstalledAt": "…",
//       "provenance": "builtin" } } } // only for a silo that comes with Silos (native.ts)
//
// The registry reads its decisions from here (SiloOperatorView). Approvals,
// switches and bindings live nowhere else.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson, backupCorruptJson } from '../json-store.js'
import type { SiloOperatorView } from './registry.js'
import type { SourceConvention } from './manifest.js'

export interface OperatorSilo {
  decision: 'approved' | 'disabled' | 'uninstalled'
  producers: string[]
  slotsOff: string[]
  // needs-you entry indexes whose granted `audience: producer-agent` the
  // operator vetoed — those rows come back to the owner's inbox
  audienceOff?: number[]
  // the parsed record count at the moment of uninstall — the live
  // file scan can't tell records from unparseable files after the fact
  keptRecords?: number
  automationId?: string
  conventions?: SourceConvention[]
  name?: string
  decidedAt: string
  installedAt?: string
  uninstalledAt?: string
  // how the silo came: 'builtin' = installed by the platform at boot (it
  // comes with Silos, silos/native.ts); absent = through the door (a
  // submission the owner approved). Kept across an uninstall and a reinstall.
  provenance?: 'builtin'
}

export interface OperatorState {
  version: 1
  silos: Record<string, OperatorSilo>
}

export class SiloOperatorStore implements SiloOperatorView {
  readonly file: string
  private state: OperatorState = { version: 1, silos: {} }

  constructor(private root: string) {
    this.file = join(root, 'operator.json')
    this.load()
  }

  load(): void {
    this.state = { version: 1, silos: {} }
    if (!existsSync(this.file)) return
    let text = ''
    try {
      text = readFileSync(this.file, 'utf8')
      const raw = JSON.parse(text) as Partial<OperatorState>
      if (raw && typeof raw === 'object' && raw.silos && typeof raw.silos === 'object') {
        // The file is exportable and hand-editable, so every entry is
        // normalized on the way in: a minimal {decision} written by hand (or
        // an older shape) never breaks a consumer that spreads its lists.
        const silos: Record<string, OperatorSilo> = {}
        for (const [id, v] of Object.entries(raw.silos as Record<string, Partial<OperatorSilo>>)) {
          if (!v || typeof v !== 'object') continue
          if (v.decision !== 'approved' && v.decision !== 'disabled' && v.decision !== 'uninstalled') continue
          const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [])
          const indexes = (x: unknown): number[] =>
            Array.isArray(x) ? x.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0) : []
          silos[id] = {
            ...v,
            decision: v.decision,
            producers: strings(v.producers),
            slotsOff: strings(v.slotsOff),
            ...(v.audienceOff !== undefined ? { audienceOff: indexes(v.audienceOff) } : {}),
            decidedAt: typeof v.decidedAt === 'string' ? v.decidedAt : '',
          }
          if (silos[id]!.provenance !== 'builtin') delete silos[id]!.provenance
          if (typeof silos[id]!.keptRecords !== 'number' || !Number.isFinite(silos[id]!.keptRecords!) || silos[id]!.keptRecords! < 0)
            delete silos[id]!.keptRecords
        }
        this.state = { version: 1, silos }
      }
    } catch {
      if (text !== '') backupCorruptJson(this.file, text, 'silos operator', { mode: 0o600 })
    }
  }

  private save(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    atomicWriteJson(this.file, this.state, { mode: 0o600 })
  }

  // the whole state, as it is on disk — what an export carries
  export(): OperatorState {
    return JSON.parse(JSON.stringify(this.state)) as OperatorState
  }

  get(id: string): OperatorSilo | null {
    return this.state.silos[id] ? { ...this.state.silos[id]! } : null
  }

  list(): Array<{ id: string } & OperatorSilo> {
    return Object.entries(this.state.silos).map(([id, s]) => ({ id, ...s }))
  }

  set(id: string, s: OperatorSilo): void {
    this.state.silos[id] = s
    this.save()
  }

  patch(id: string, p: Partial<OperatorSilo>): OperatorSilo | null {
    const cur = this.state.silos[id]
    if (!cur) return null
    const next = { ...cur, ...p }
    this.state.silos[id] = next
    this.save()
    return next
  }

  // SiloOperatorView — what the registry asks
  decisionFor(id: string): 'approved' | 'disabled' | null {
    const d = this.state.silos[id]?.decision
    return d === 'approved' || d === 'disabled' ? d : null
  }

  slotsOff(id: string): readonly string[] {
    return this.state.silos[id]?.slotsOff ?? []
  }

  // the agents bound to a silo's producer role; null = never bound (the
  // silo was never approved through the dialog)
  producersOf(id: string): string[] | null {
    const s = this.state.silos[id]
    return s ? [...s.producers] : null
  }

  // needs-you entries whose granted producer-agent audience the operator vetoed
  audienceOff(id: string): number[] {
    return [...(this.state.silos[id]?.audienceOff ?? [])]
  }
}
