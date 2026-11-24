// silo-settings.ts — pure helpers for Settings › Silos, the
// silo-install.ts pattern: no React, no fetch. Everything said comes from GET
// /api/silos (descriptors + `uninstalled` + `available`); these only group
// and word it.
//
// The page has three groups — where each silo stands in what Silos ships
// (the server's `lineup`), never how it is doing:
//   recommended — the silos Silos installs for you (Plans, Task mode,
//                 System): removable, each saying what removing it gives up
//   optional    — the ones Silos ships for the asking (Support, Hierarchy,
//                 Executions, Heather): installed ones and the offers
//   yours       — the silos you or your agents installed from a manifest
// Inside each group a silo is in one of four moments:
//   installed   — decided on (active, turned off, error); opens its page
//   waiting     — in the registry, never approved: with a submission the
//                 dialog is one click away; without one, «Submit for approval…»
//   uninstalled — out of every surface, files kept; «Reinstall…» submits the
//                 manifest the uninstall kept (reached from Home's growth line)
//   available   — an optional silo held nowhere yet: «Install…»
import type { SiloAvailable, SiloDescriptor, SiloLineup, SiloPendingSubmission, SiloUninstalled } from './types'
import { relTime } from './rel-time'
import { writerWords } from './silo-view'

export interface SiloGroup {
  installed: SiloDescriptor[]
  waiting: SiloDescriptor[]
  uninstalled: SiloUninstalled[]
  available: SiloAvailable[]
}
export interface SiloSettingsGroups {
  recommended: SiloGroup
  optional: SiloGroup
  yours: SiloGroup
}

const byName = (a: { id: string; name: string | null }, b: { id: string; name: string | null }): number => (a.name ?? a.id).localeCompare(b.name ?? b.id)

// an older server sends no lineup: provenance builtin was «recommended» then
const lineupOf = (x: { lineup?: SiloLineup | null; provenance?: 'builtin' | null }): SiloLineup | null =>
  x.lineup !== undefined ? x.lineup : x.provenance === 'builtin' ? 'recommended' : null

const emptyGroup = (): SiloGroup => ({ installed: [], waiting: [], uninstalled: [], available: [] })

export function groupSilos(
  silos: readonly SiloDescriptor[],
  uninstalled: readonly SiloUninstalled[] | undefined,
  available: readonly SiloAvailable[] = [],
): SiloSettingsGroups {
  const g: SiloSettingsGroups = { recommended: emptyGroup(), optional: emptyGroup(), yours: emptyGroup() }
  const groupOf = (l: SiloLineup | null): SiloGroup => (l === 'recommended' ? g.recommended : l === 'optional' ? g.optional : g.yours)
  for (const d of [...silos].sort(byName)) groupOf(lineupOf(d))[d.state === 'pending' ? 'waiting' : 'installed'].push(d)
  // the server sends the uninstalled newest first — kept as sent
  for (const u of uninstalled ?? []) groupOf(lineupOf(u)).uninstalled.push(u)
  // every catalog offer is optional (a recommended one is installed at boot)
  g.optional.available.push(...available)
  return g
}

export const groupSize = (x: SiloGroup): number => x.installed.length + x.waiting.length + x.uninstalled.length + x.available.length

export function isEmpty(g: SiloSettingsGroups): boolean {
  return groupSize(g.recommended) + groupSize(g.optional) + groupSize(g.yours) === 0
}

// the silo's state in one plain word (the registry's own states)
export function stateWord(d: Pick<SiloDescriptor, 'state'>): string {
  return d.state === 'active' ? 'Active' : d.state === 'disabled' ? 'Turned off' : d.state === 'error' ? 'Error' : 'Not approved'
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const who = (by: string): string => (by === 'owner' ? 'you' : by)

// «12 records, 2 unreadable · written by finance · sync automation paused»
export function installedFacts(d: SiloDescriptor): string {
  const parts: string[] = []
  if (d.state === 'error') parts.push(d.reason)
  // an edge-only silo keeps relations, not records — drawn by you
  const rels = (d.kinds ?? []).length === 0 ? (d.relations ?? []) : []
  if (rels.length > 0) parts.push(`${rels.map((r) => r.name.replace(/_/g, ' ')).join(', ')} — drawn by you on its page`)
  // a silo that brings only a look: its look, never «0 records»
  else if ((d.kinds ?? []).length === 0 && d.theme) parts.push(`a look, ${d.theme.name} — a choice in Appearance`)
  else parts.push(`${plural(d.records.parsed, 'record')}${d.records.failed > 0 ? `, ${d.records.failed} unreadable` : ''}`)
  // the agents bound; a role is never an agent — nobody bound, no producer yet
  const writers = writerWords(d)
  // a kernel source: no agent writes these — Silos keeps them
  if (d.kernel) parts.push(`kept by Silos from ${d.kernel.reads}`)
  else if (writers) parts.push(`written by ${writers}`)
  else if (d.producer) parts.push('no producer yet')
  if (d.automation) parts.push(`sync automation ${d.automation.paused ? 'paused' : 'on'}`)
  if (d.state === 'active' && d.freshness?.stale && d.freshness.term) parts.push(d.freshness.term)
  return parts.join(' · ')
}

// a submission waiting for the owner, in the inbox's voice
export function waitingWords(s: SiloPendingSubmission): string {
  return `${s.version ?? 'A version'} waits for your approval — submitted by ${who(s.submittedBy)}`
}

export function waitingFacts(d: SiloDescriptor): string {
  if (d.submission) return waitingWords(d.submission)
  // the section already says what «never approved» means — the row says only what is missing
  return `${d.version ? `Version ${d.version}` : 'No version'} · nothing submitted yet`
}

// what the owner can do with a manifest waiting in the registry — the same
// rule: a door only where the server would open it
export type WaitingAction = { kind: 'review' } | { kind: 'submit' } | { kind: 'none'; says: string }

export function waitingAction(d: SiloDescriptor): WaitingAction {
  if (d.submission) return { kind: 'review' }
  if (d.native) return { kind: 'none', says: d.native }
  return { kind: 'submit' }
}

// «Uninstalled 3d ago · 4 files stay, with your overlay and the journal · finance kept writing: 2 new since»
export function uninstalledFacts(u: SiloUninstalled, now: number = Date.now()): string {
  const parts: string[] = []
  const at = u.uninstalledAt ? Date.parse(u.uninstalledAt) : NaN
  parts.push(Number.isFinite(at) ? `Uninstalled ${relTime(at, now)}` : 'Uninstalled')
  // records when the uninstall recorded the parsed count; the
  // live file scan alone can't tell records from unparseable files
  // kernel data (a kernel source): no files — the records stay with Silos
  const kernelOnly = u.kept.conventions.length > 0 && u.kept.conventions.every((c) => c.startsWith('kernel:'))
  if (kernelOnly)
    parts.push(
      `${u.kept.records !== null ? `${plural(u.kept.records, 'record')} ${u.kept.records === 1 ? 'stays' : 'stay'}` : 'its records stay'} with Silos (kernel data), with the journal`,
    )
  else
    parts.push(
      u.kept.records !== null
        ? `${plural(u.kept.records, 'record')} ${u.kept.records === 1 ? 'stays' : 'stay'} on disk (${plural(u.kept.files, 'file')}), with your overlay and the journal`
        : `${plural(u.kept.files, 'file')} ${u.kept.files === 1 ? 'stays' : 'stay'} on disk, with your overlay and the journal`,
    )
  if (u.grown > 0) parts.push(`${u.producers.length > 0 ? u.producers.join(', ') : 'its producers'} kept writing: ${u.grown} new since`)
  if (u.automation) parts.push(`sync automation ${u.automation.paused ? 'paused' : 'on'}`)
  return parts.join(' · ')
}

// what the owner can do with an uninstalled silo — never a dead button
export type UninstalledAction = { kind: 'review'; says: string } | { kind: 'reinstall'; version: string | null } | { kind: 'none'; says: string }

export function uninstalledAction(u: SiloUninstalled): UninstalledAction {
  if (u.submission) return { kind: 'review', says: waitingWords(u.submission) }
  // the server refuses this id at the door (a dimension Silos still serves
  // natively): its words, never a button the server would answer 409 to
  if (u.native) return { kind: 'none', says: u.native }
  if (u.manifest) return { kind: 'reinstall', version: u.manifest.version }
  return { kind: 'none', says: 'No manifest was kept at the uninstall — its author has to submit it again' }
}
