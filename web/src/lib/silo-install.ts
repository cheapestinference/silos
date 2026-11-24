// silo-install.ts — pure helpers for the install dialog (pending →
// consequences → approve), the silo-view.ts pattern: no React, no
// fetch. Everything the dialog SAYS about the silo comes from the server's
// consequences answer (installer.ts) — these helpers only word it, choose
// which real agents can be bound, and say why Approve is not possible yet.
// They never derive a consequence: a binding change re-asks the server.
import type { AgentView, SiloConsequences, SiloInstallKind, SiloSubmissionRow } from './types'
import { MASTER_ID } from './constants'

// The action keeps its name through the flow (product.md «One vocabulary»):
// the button says Install, the event says installed, the page says active.
export function actionWord(kind: SiloInstallKind): string {
  return kind === 'update' ? 'Update' : kind === 'reinstall' ? 'Reinstall' : 'Install'
}

// «Install Invoices?» · «Update Invoices 0.1.0 → 0.2.0?»
export function dialogTitle(c: Pick<SiloConsequences, 'kind' | 'name' | 'id' | 'version'>): string {
  const name = c.name ?? c.id
  if (c.kind === 'update') return `Update ${name} ${c.version.from ?? '?'} → ${c.version.to ?? '?'}?`
  return `${actionWord(c.kind)} ${name}${c.version.to ? ` ${c.version.to}` : ''}?`
}

// «submitted by finance, from a draft» — who asked, in the inbox's voice
export function submittedWords(c: Pick<SiloConsequences, 'submittedBy' | 'source'>): string {
  return `submitted by ${c.submittedBy === 'owner' ? 'you' : c.submittedBy}${c.source === 'draft' ? ', from a draft' : ''}`
}

// The author's prose arrives as whatever the manifest held: a string is
// quoted as written; anything else is not prose and is not shown as such.
export function prose(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}
export function proseList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []
}

// The places a slot lands, in the owner's words (the server says WHAT; the
// dialog names WHERE so each preview line has its home).
export function slotPlace(slot: string): string {
  switch (slot) {
    case 'pulse':
      return 'Home’s pulse'
    case 'needs-you':
      return 'Needs you'
    case 'rail':
      return 'The rail'
    case 'agent-section':
      return 'The producer’s page'
    case 'project-machinery':
      return 'The project’s machinery'
    case 'lens':
      return 'A lens on Tasks'
    default:
      return slot
  }
}

// One location a source reads — what is on disk there right now.
export function locationWords(l: { exists: boolean; files: number }): string {
  if (!l.exists) return 'not there yet'
  return l.files === 0 ? 'there, no records yet' : `${l.files} record file${l.files === 1 ? '' : 's'}`
}

// A source reads one place per agent (or project): with a fleet that is a
// dozen paths, most of them empty. The places that hold something are listed;
// the empty ones fold into a counted line that unfolds in place — folded,
// never hidden. Order is the server's.
export function splitLocations<L extends { exists: boolean; files: number }>(locations: readonly L[]): { listed: L[]; quiet: L[] } {
  const listed = locations.filter((l) => l.exists || l.files > 0)
  return { listed, quiet: locations.filter((l) => !listed.includes(l)) }
}

// The agents a producer role can be bound to: real, not archived, never the
// master; the proposed ones first, then by name. `proposed` marks them.
export function producerChoices(
  agents: readonly AgentView[],
  proposed: readonly string[],
): Array<{ id: string; name: string; emoji: string; proposed: boolean }> {
  return agents
    .filter((a) => !a.archived && a.id !== MASTER_ID)
    .map((a) => ({ id: a.id, name: a.name, emoji: a.emoji, proposed: proposed.includes(a.id) }))
    .sort((a, b) => Number(b.proposed) - Number(a.proposed) || a.name.localeCompare(b.name))
}

// Why Approve can't be pressed yet — the server's own refusals, read ahead
// from what it already derived for THIS binding (approve answers 400/409 on
// the same grounds). Empty = nothing stands in the way.
export function approveBlockers(c: Pick<SiloConsequences, 'derived'>, chosen: readonly string[]): string[] {
  const out: string[] = []
  for (const e of c.derived.errors) out.push(`it no longer validates: ${e.message}`)
  // a kernel source's producer is the kernel itself: nobody to bind (installer.ts)
  // an edge-only silo has no producer role at all: nobody to bind
  if (
    chosen.length === 0 &&
    c.derived.producerRole !== null &&
    c.derived.producerRole !== undefined &&
    c.derived.producerRole !== 'any-agent' &&
    c.derived.producerRole !== KERNEL_PRODUCER
  )
    out.push(`bind the producer role ${c.derived.producerRole ?? '?'} to at least one agent`)
  // the requirements answer for the binding they were derived for — while a
  // re-derivation is in flight they may lag one click; approve re-checks
  for (const r of c.derived.requirements) if (r.met === false && !(chosen.length === 0 && r.agentId === null)) out.push(r.what)
  return out
}

// The producer role of a kernel source — the kernel writes those records
// (Silo Standard); the dialog binds no agent and says so.
export const KERNEL_PRODUCER = 'kernel'

// What a kernel source reads, in the dialog's voice: the catalog's words and
// what Silos holds of it right now.
export function kernelReadWords(r: { says?: string; records?: number; kind?: string }): string {
  const n = r.records ?? 0
  return `${r.says ?? `the kernel's ${r.kind ?? 'data'}`} · ${n === 0 ? 'Silos holds none right now' : `${n} record${n === 1 ? '' : 's'} Silos holds now`}`
}

// A prompt's first sentence-line — the gist the card shows before «show all».
export function promptGist(prompt: string): string {
  return (
    prompt
      .split('\n')
      .find((l) => l.trim() !== '')
      ?.trim() ?? ''
  )
}

// The submission waiting for this silo, if any.
export function submissionFor(subs: readonly SiloSubmissionRow[], id: string): SiloSubmissionRow | null {
  return subs.find((s) => s.id === id) ?? null
}
