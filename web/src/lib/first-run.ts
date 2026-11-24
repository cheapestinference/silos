// first-run.ts — the first-run tour's model (Welcome): what the server
// answered, turned into the rows each step draws, and the owner's choices
// turned into what Create sends. Pure; the components only draw and call.
// Every choice starts on its recommended value, and a default is sent as
// absence, so «a name + Create» is the whole first run when nothing else
// matters.
import type { AgentView, EngineCompat, HarnessDescriptor, SiloAvailable, SiloDescriptor } from './types'
import { MASTER_ID } from './constants'
import { TOUR_STEPS } from './new-agent'

export interface TourChoice {
  engine: string
  provider: string // '' = the machine's own login for that engine
  silos: Record<string, boolean> // only the rows the owner toggled
  start?: Record<string, boolean> // At start: only the classes the owner toggled (for `engine`)
}

// the tour's steps: «At start» only for an engine that declares what a new
// project starts with — one that declares nothing has the four steps
export function tourSteps(classes: readonly unknown[]): (typeof TOUR_STEPS)[number][] {
  return TOUR_STEPS.filter((s) => s.id !== 'at-start' || classes.length > 0)
}

export interface EngineRow {
  id: string
  label: string
  version: string | null
  usable: boolean
  why: string | null
  recommended: boolean
}

// an engine this machine can't run (missing, or below what Silos needs) is
// shown with its verdict but can't be picked; no verdict = nothing known
// against it
export function engineRows(list: readonly HarnessDescriptor[], compat: readonly EngineCompat[]): EngineRow[] {
  return list.map((d) => {
    const v = compat.find((c) => c.harness === d.id) ?? null
    const refused = v !== null && (v.state === 'missing' || v.state === 'outdated')
    return { id: d.id, label: d.label, version: v?.installed ?? null, usable: !refused, why: refused ? v.message : null, recommended: d.default }
  })
}

export interface SiloRow {
  id: string
  name: string
  description: string | null
  installed: boolean
  recommended: boolean
  on: boolean
  loses: string | null
}

// The recommended silos Silos installed (on — unticking one says what it
// gives up), then the catalog's optional offers that need no agent of yours
// (off). An optional silo fed by an agent (Support) waits until there is one.
export function siloRows(installed: readonly SiloDescriptor[], available: readonly SiloAvailable[]): SiloRow[] {
  const recommended = installed
    .filter((s) => (s.lineup !== undefined ? s.lineup === 'recommended' : s.provenance === 'builtin') && s.state !== 'pending')
    .map((s) => ({ id: s.id, name: s.name ?? s.id, description: s.description, installed: true, recommended: true, on: true, loses: s.loses ?? null }))
  // an offer is approved with no producers: only one the kernel fills (or
  // nobody) can be — a task-agent or any-agent one binds agents at approval
  const offers = available
    .filter((a) => a.producerRole == null || a.producerRole === 'kernel')
    .map((a) => ({ id: a.id, name: a.name ?? a.id, description: a.description, installed: false, recommended: false, on: false, loses: null }))
  return [...recommended, ...offers]
}

export function siloOps(rows: readonly SiloRow[], choice: Record<string, boolean>): { uninstall: string[]; install: string[] } {
  const changed = rows.filter((r) => choice[r.id] !== undefined && choice[r.id] !== r.on)
  return {
    uninstall: changed.filter((r) => r.installed).map((r) => r.id),
    install: changed.filter((r) => !r.installed).map((r) => r.id),
  }
}

// a provider belongs to one engine: switching engines goes back to the
// new engine's own login
export function withEngine(choice: TourChoice, engine: string): TourChoice {
  return engine === choice.engine ? choice : { ...choice, engine, provider: '', start: {} }
}

export function agentPayloadExtras(choice: TourChoice, defaultEngine: string): { framework?: string; provider?: string } {
  return {
    ...(choice.engine !== defaultEngine ? { framework: choice.engine } : {}),
    ...(choice.provider !== '' ? { provider: choice.provider } : {}),
  }
}

// How an agent works — asked at birth, never inferred from whether a
// mission was written: «when you give it work» (Only when told; a mission
// only describes the job) or «also on its own» (it wakes on its rhythm and
// answers for its mission — so it needs one).
export type Works = 'told' | 'own'
export function worksProblem(works: Works, missionText: string, name: string): string | null {
  return works === 'own' && missionText.trim() === '' ? `On its own, ${name || 'it'} needs a mission — write what it takes care of.` : null
}
// the server makes a mission On its own unless told otherwise: the one ask
export function worksPayload(works: Works, missionText: string): { control?: 'told' } {
  return works === 'told' && missionText.trim() !== '' ? { control: 'told' } : {}
}

// an install with nothing in it yet: no agent of its own (only the
// catch-all) and no conversation anywhere — Welcome's pane, the sidebar's
// door and the mark on «+» all read this one rule
export function instanceEmpty(agents: readonly Pick<AgentView, 'id' | 'sessions'>[]): boolean {
  return agents.length > 0 && agents.every((a) => a.sessions.length === 0) && !agents.some((a) => a.id !== MASTER_ID)
}
