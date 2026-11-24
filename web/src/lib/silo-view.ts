// silo-view.ts — pure derivations for the Silo Standard's pages (Task 8):
// everything the `list` archetype and the `record` page compute from what the
// server already said, with no React and no fetch (the home.ts / vault-page.ts
// pattern). The archetype is sculpted once and parameterized by manifest —
// nothing in this module may know a silo by name: every word comes from the
// descriptor, the kind descriptor or the record itself.
import {
  SiloIcon,
  SiloHelpIcon,
  SiloInvoiceIcon,
  SiloDocumentIcon,
  SiloPeopleIcon,
  SiloSystemIcon,
  SiloInboxIcon,
  SiloTasksIcon,
  SiloCalendarIcon,
} from './icons'
import type { ActiveFilter, Facet } from './facets'
import type { SiloDescriptor, SiloEventView, SiloJournalLine, SiloKindDescriptor, SiloProposalView, SiloRecordDetail, SiloStateWord } from './types'

// ── descriptors: what is visible where ──────────────────────────────────────

// The silos whose pages exist as destinations (⌘K, Home rows). A pending /
// disabled / error silo still has its page — it says its state instead of
// records — but it is not OFFERED anywhere: with zero active silos the whole
// surface is invisible (the mission's gate).
export function activeSilos(silos: readonly SiloDescriptor[]): SiloDescriptor[] {
  return silos.filter((s) => s.state === 'active')
}

// The silos that earned a door on the global rail: the `rail` slot requested
// by the manifest AND granted (the operator can turn it off). The grant is
// the signal — no silo gets a rail entry for merely existing.
export function railSilos(silos: readonly SiloDescriptor[]): SiloDescriptor[] {
  return activeSilos(silos).filter((s) => s.slots.granted.includes('rail'))
}

// The silo's glyph: the name its manifest chose from the standard's icon
// catalog (catalogs.md, Icons), drawn by the house; no name, or one this web
// does not know yet, is the silo glyph.
const SILO_ICONS: Record<string, typeof SiloIcon> = {
  help: SiloHelpIcon,
  invoice: SiloInvoiceIcon,
  document: SiloDocumentIcon,
  people: SiloPeopleIcon,
  system: SiloSystemIcon,
  inbox: SiloInboxIcon,
  tasks: SiloTasksIcon,
  calendar: SiloCalendarIcon,
}
export function siloIconOf(s: Pick<SiloDescriptor, 'icon'> | null | undefined): typeof SiloIcon {
  return (s?.icon ? SILO_ICONS[s.icon] : undefined) ?? SiloIcon
}

export function siloName(s: SiloDescriptor): string {
  return s.name ?? s.id
}

// The one honest sentence under the list page's title, composed only of what
// the descriptor really says: records counted, the producer, freshness when
// a source is past its cadence. Parts joined with ' · ' by the page.
// Who writes a silo's records, in words: the agents bound (at approval, or
// by the disk for a builtin) — the role `any-agent` is a rule, not a name:
// «any agent». Any other role is a word of the manifest, never an agent:
// nobody bound = null, «no producer yet» (one place for both headers).
export function writerWords(s: Pick<SiloDescriptor, 'producers' | 'producer'>): string | null {
  if (s.producers && s.producers.length > 0) return s.producers.join(', ')
  return s.producer?.role === 'any-agent' ? 'any agent' : null
}

export function siloHeaderParts(s: SiloDescriptor): string[] {
  const parts: string[] = []
  const n = s.records.parsed
  parts.push(`${n} record${n === 1 ? '' : 's'}`)
  if (s.kernel) {
    // a kernel source: no agent writes these — the kernel keeps them, from
    // what the catalog says it reads
    parts.push(`kept by Silos from ${s.kernel.reads}`)
  } else if (s.producer) {
    // the agents bound are who writes; nobody bound is said once, by the
    // binding line under the header («No producer yet · Bind ›»)
    const who = writerWords(s)
    if (who !== null) parts.push(s.producer.sync ? `synced from ${s.producer.sync} by ${who}` : `written by ${who}`)
    else if (s.producer.sync) parts.push(`synced from ${s.producer.sync}`)
  }
  if (s.freshness?.term) parts.push(s.freshness.term)
  return parts
}

// ── the list's facets (server counts, single-value selection) ───────────────

// A facet's plain-word label: the last dot segment ('total.currency' →
// 'currency'); 'state' and anchor names already read plainly.
export function facetLabel(name: string): string {
  return name.split('.').pop() ?? name
}

export function facetsToBars(kind: Pick<SiloKindDescriptor, 'facets'>): Facet[] {
  return kind.facets.map((f) => ({ id: f.name, label: facetLabel(f.name), values: f.values }))
}

// The records route takes ONE value per facet (facet.<name>=v) — the chip UI
// is multi-select by trade, so a toggle that grows a set keeps only what was
// just added. Clearing stays clearing.
export function singleValuePerFacet(prev: ActiveFilter, next: ActiveFilter): ActiveFilter {
  const out: Record<string, ReadonlySet<string>> = {}
  for (const [id, sel] of Object.entries(next)) {
    if (sel.size <= 1) {
      out[id] = sel
      continue
    }
    const before = prev[id] ?? new Set<string>()
    const added = [...sel].find((v) => !before.has(v))
    out[id] = new Set(added !== undefined ? [added] : [[...sel][0]!])
  }
  return out
}

// The query the server understands: the (single) chosen value of each facet.
export function filterToFacets(filter: ActiveFilter): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [id, sel] of Object.entries(filter)) {
    const v = [...sel][0]
    if (v !== undefined) out[id] = v
  }
  return out
}

// ── columns ─────────────────────────────────────────────────────────────────

// A column header in plain words: 'identity' is the thing itself — it reads
// as the kind's own noun ('invoice', 'document'); 'at' is the record's
// moment — 'date'; a dotted field keeps its last segment.
export function columnHeader(column: string, kindName: string, labels?: Record<string, string>): string {
  // the field's declared words (fieldSpec `label`) win: «memory», «started»
  const declared = labels?.[column]
  if (declared) return declared
  if (column === 'identity') return kindName.split('/').pop() ?? kindName
  if (column === 'at') return 'date'
  // a column over a sub-kind (views.ts): count(threads) → 'threads',
  // last(notes) → 'last note'
  const child = /^(count|last)\(([A-Za-z_][A-Za-z0-9_]*)\)$/.exec(column)
  if (child) return child[1] === 'count' ? child[2]! : `last ${child[2]!.replace(/s$/, '')}`
  // a camelCase field reads as words: customerEmail → 'customer email'
  return (column.split('.').pop() ?? column).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
}

// An agent anchor in words: the agent's NAME, never its id (shared by every
// silo page — the list cells, the facet chips, the record's anchors).
export function agentWord(agents: ReadonlyArray<{ id: string; name: string }>, id: string): string {
  return agents.find((a) => a.id === id)?.name ?? id
}

// The producer a record's «Make it a task for X ›» names — the server's
// producersOf, first in play (a task has ONE owner): the agents the owner
// bound that are not archived. A role is a word of the manifest, never an
// agent id: never bound = nobody to give it to (null).
export function producerAgent(
  d: Pick<SiloDescriptor, 'producer' | 'producers'> | undefined,
  agents: ReadonlyArray<{ id: string; name: string; archived?: boolean }>,
): { id: string; name: string } | null {
  if (!d) return null
  const inPlay = (id: string) => agents.find((a) => a.id === id && !a.archived) ?? null
  for (const id of d.producers ?? []) {
    const a = inPlay(id)
    if (a) return { id: a.id, name: a.name }
  }
  return null
}

// The facet bars with agent ids said as names (the server counts by id).
export function facetsWithNames(kind: Pick<SiloKindDescriptor, 'facets'>, agents: ReadonlyArray<{ id: string; name: string }>): Facet[] {
  return facetsToBars(kind).map((f) => (f.id === 'agent' ? { ...f, values: f.values.map((v) => ({ ...v, label: agentWord(agents, v.value) })) } : f))
}

// A column is set by its declared type, which the server composes with the
// view (views.ts columnTypes): money and numbers read as figures — right-
// aligned, so they stack by their digits. Everything else reads as text.
export function columnAlign(column: string, kind: Pick<SiloKindDescriptor, 'columnTypes'>): 'left' | 'right' {
  const t = kind.columnTypes?.[column]
  return t === 'money' || t === 'number' ? 'right' : 'left'
}

export function stateWord(states: readonly SiloStateWord[], value: string | null | undefined): string {
  if (value == null) return ''
  return states.find((s) => s.value === value)?.one ?? value
}

export function isTerminal(states: readonly SiloStateWord[], value: string | null | undefined): boolean {
  return value != null && (states.find((s) => s.value === value)?.terminal ?? false)
}

// ── values in voice (overlay, proposals) ────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function isMoney(v: unknown): v is { amount: number; currency: string } {
  return isObj(v) && typeof v.amount === 'number' && typeof v.currency === 'string'
}

// One value said plainly — the same voice as the server's cells (money as
// money, never a raw object dump).
export function valueWord(v: unknown, states?: readonly SiloStateWord[]): string {
  if (v === null || v === undefined || v === '') return '—'
  if (isMoney(v)) {
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: v.currency }).format(v.amount)
    } catch {
      return `${v.amount} ${v.currency}`
    }
  }
  if (typeof v === 'string') return states ? stateWord(states, v) : v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

// «set-field state: open → paid · proposed by finance» — the same words the
// server's proposalLine and events speak.
export function proposalWords(p: Pick<SiloProposalView, 'verb' | 'field' | 'from' | 'to' | 'by'>, states?: readonly SiloStateWord[]): string {
  return `${p.verb} ${p.field}: ${valueWord(p.from, states)} → ${valueWord(p.to, states)} · proposed by ${p.by}`
}

// ── set-field on a field with no declared values ────────────────────────────

// How the owner edits a writable field the manifest gives no value list:
// text-shaped types as text, money as its amount (the record's currency
// kept — a figure without its currency is not money), yes/no as a choice.
// What can't be typed honestly (an attachment, sibling refs, money with no
// currency yet) stays read-only and says why.
export type FieldEditor =
  | { kind: 'text'; initial: string; placeholder: string }
  | { kind: 'money'; initial: string; currency: string }
  | { kind: 'boolean'; initial: boolean }
  | { kind: 'none'; why: string }

const TEXT_TYPES = new Set(['string', 'email', 'url', 'actor', 'path', 'timestamp'])

export function editorFor(field: { type: string; value: unknown }): FieldEditor {
  if (field.type === 'money') {
    return isMoney(field.value)
      ? { kind: 'money', initial: String(field.value.amount), currency: field.value.currency }
      : { kind: 'none', why: 'an amount needs its currency, and this record has none yet' }
  }
  if (field.type === 'boolean') return { kind: 'boolean', initial: field.value === true }
  if (TEXT_TYPES.has(field.type)) {
    const initial = typeof field.value === 'string' ? field.value : typeof field.value === 'number' ? String(field.value) : ''
    return { kind: 'text', initial, placeholder: field.type === 'timestamp' ? 'YYYY-MM-DD' : field.type === 'email' ? 'name@example.com' : '' }
  }
  return { kind: 'none', why: `a ${field.type} value is written by the producer` }
}

// The value set-field sends for what the owner typed — or why not. An empty
// text clears the field only where the manifest says it may be cleared.
export function parseEdit(editor: FieldEditor, input: string, clearable: boolean): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (editor.kind === 'none') return { ok: false, reason: editor.why }
  if (editor.kind === 'boolean') return { ok: true, value: input === 'true' }
  const t = input.trim()
  if (t === '') return clearable ? { ok: true, value: null } : { ok: false, reason: 'this field can’t be left empty' }
  if (editor.kind === 'text') return { ok: true, value: t }
  // money: «1234.5», «1,234.50», «1234,5» — a lone comma is a decimal comma
  const normalized = t.includes('.') ? t.replace(/,/g, '') : t.replace(',', '.')
  const amount = Number(normalized)
  if (!Number.isFinite(amount) || !/^-?[\d.]+$/.test(normalized)) return { ok: false, reason: `${t} is not an amount` }
  return { ok: true, value: { amount, currency: editor.currency } }
}

// ── overlay: the owner's values over a sync source ──────────────────────────

export interface OverlayRow {
  field: string
  owner: unknown
  base: unknown
  at: string
  conflict: { sourceValue: unknown; seenAt: string } | null
}

export function overlayRows(detail: Pick<SiloRecordDetail, 'overlay'>): OverlayRow[] {
  return Object.entries(detail.overlay ?? {}).map(([field, f]) => ({
    field,
    owner: f.value,
    base: f.base,
    at: f.at,
    conflict: f.conflict ?? null,
  }))
}

// ── anchors ─────────────────────────────────────────────────────────────────

export interface AnchorLink {
  hub: string // 'agent' | 'folder' | 'conversation' | whatever the kind maps
  value: string
}

export function anchorLinks(anchors: Record<string, unknown>): AnchorLink[] {
  return Object.entries(anchors)
    .filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '')
    .map(([hub, value]) => ({ hub, value }))
}

// ── the record's story: journal + action events in one voice ────────────────

export interface StoryLine {
  at: string
  text: string
  source: 'journal' | 'event'
}

// The standard's honesty rules, verbatim: the first observation is a
// baseline, never an event — «arrived paid» ≠ «was paid here»; a transition
// is dated to when it was SEEN, and says the window it happened in when the
// journal knows it.
export function storyOf(
  history: readonly SiloJournalLine[],
  events: readonly SiloEventView[],
  states: readonly SiloStateWord[],
  when: (iso: string) => string,
): StoryLine[] {
  const word = (v: string | null | undefined): string => stateWord(states, v) || (v ?? '')
  const lines: StoryLine[] = []
  for (const l of history) {
    if (l.event === 'opened') continue
    if (l.event === 'baseline') lines.push({ at: l.at, source: 'journal', text: `first seen — arrived ${word(l.to)}` })
    else if (l.event === 'appeared') lines.push({ at: l.at, source: 'journal', text: `appeared — ${word(l.to)}` })
    else if (l.event === 'transition') {
      const window = l.prevSeenAt ? ` · after ${when(l.prevSeenAt)}` : ''
      lines.push({ at: l.at, source: 'journal', text: `${word(l.from)} → ${word(l.to)} · seen ${when(l.at)}${window}` })
    } else if (l.event === 'removed') {
      lines.push({ at: l.at, source: 'journal', text: `the file disappeared — was ${word(l.from)}` })
    }
  }
  for (const e of events) lines.push({ at: e.at, source: 'event', text: e.text })
  return lines.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0))
}

// A moment in the standard's voice — the same words the server's cells and
// freshness terms use (silos/freshness.ts formatMoment): 'Oct 30' for a
// day-granularity value, 'Oct 30, 14:02 UTC' otherwise.
export function momentWord(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const d = new Date(t)
  const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return day
  const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })
  return `${day}, ${hm} UTC`
}

// ── templates: the preview before sending ───────────────────────────────────

// What the owner reads before the message goes: the declared template with
// the record's own words in its slots — the same fields the server will fill
// ({{identity}} and any declared field, money as money). An unknown slot is
// left as written: the preview never invents.
export function fillTemplate(template: string, detail: Pick<SiloRecordDetail, 'record' | 'fields'>): string {
  const byName = new Map(detail.fields.map((f) => [f.name, f.text]))
  return template.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (whole, name: string) => {
    if (name === 'identity') return detail.record.identity || detail.record.id
    if (name === 'state') return detail.record.stateLabel
    if (name === 'at') return detail.record.at ?? '—'
    return byName.get(name) ?? whole
  })
}
