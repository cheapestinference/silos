// fleet-events.ts — the fleet's control history: an
// append-only JSONL at <dataDir>/fleet/control.jsonl, one line per change of
// an agent's POSITION on the control ladder (control.ts positionOf: told ·
// own · proactive — the derived one, what the page's switch draws).
//
// Two writers, one file:
//   - the owner's PATCH /api/agents/:id (routes/agents.ts) writes the change
//     it made, at the instant it made it — `from` is the position before;
//   - the vitals read (vitals.ts noteFleet) reconciles: an agent whose
//     position moved by another path (Silos' cut, the fence turned off, an
//     archive) gets its change written when it is first seen, and an agent
//     never written yet gets a `seen` baseline — what the next change is
//     measured from. A `seen` line is no event: it only says «at this
//     instant it was here».
// Nothing is ever rewritten; a line that does not parse is skipped.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Position } from './control.js'

export type FleetLine =
  { at: string; kind: 'control'; agent: string; from: Position; to: Position } | { at: string; kind: 'seen'; agent: string; position: Position }

const POSITIONS: ReadonlySet<string> = new Set(['told', 'own', 'proactive'])
const isPos = (v: unknown): v is Position => typeof v === 'string' && POSITIONS.has(v)

export function fleetLogPath(dataDir: string): string {
  return join(dataDir, 'fleet', 'control.jsonl')
}

/** Every valid line, in the order written. */
export function readFleetLog(dataDir: string): FleetLine[] {
  const file = fleetLogPath(dataDir)
  if (!existsSync(file)) return []
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out: FleetLine[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let o: Record<string, unknown>
    try {
      o = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (typeof o.at !== 'string' || !Number.isFinite(Date.parse(o.at)) || typeof o.agent !== 'string') continue
    if (o.kind === 'control' && isPos(o.from) && isPos(o.to)) out.push({ at: o.at, kind: 'control', agent: o.agent, from: o.from, to: o.to })
    else if (o.kind === 'seen' && isPos(o.position)) out.push({ at: o.at, kind: 'seen', agent: o.agent, position: o.position })
  }
  return out
}

export function appendFleetLines(dataDir: string, lines: readonly FleetLine[]): void {
  if (lines.length === 0) return
  const file = fleetLogPath(dataDir)
  mkdirSync(join(dataDir, 'fleet'), { recursive: true })
  appendFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

/** A change made by the owner's PATCH: written only when the position moved.
 *  Never throws (the agent is already saved). */
export function noteControlChange(dataDir: string | undefined, agent: string, from: Position, to: Position, now = Date.now()): void {
  if (!dataDir || from === to) return
  try {
    appendFleetLines(dataDir, [{ at: new Date(now).toISOString(), kind: 'control', agent, from, to }])
  } catch (err) {
    console.warn(`fleet: could not write the control change of ${agent} —`, err instanceof Error ? err.message : err)
  }
}

/** The position each agent was last written at (its last change's `to`, or its `seen`). */
export function lastPositions(lines: readonly FleetLine[]): Map<string, Position> {
  const out = new Map<string, Position>()
  for (const l of lines) out.set(l.agent, l.kind === 'control' ? l.to : l.position)
  return out
}
