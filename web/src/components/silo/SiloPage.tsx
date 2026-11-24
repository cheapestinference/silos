// SiloPage.tsx — the Silo Standard's two pages (Task 8). /silo/<id> is the
// `list` archetype: sculpted ONCE here and parameterized by whatever the
// manifest declares — identity as the row's protagonist phrase, states always
// in their plain-word labels, the view's columns as the server already
// composed them, the declared facets with counts over the WHOLE set, folding
// that never hides, and the server's own honesty lines (said, unreadable)
// verbatim. Nothing in this file may know a silo by name: every word comes
// from the descriptor or the records route.
//
// Moments (docs/product.md): the list is the lens behind the pulse's silo
// term (moment 1) and the home of the records Home's silo rows dispatch
// (moment 2); it is reached from ⌘K, from Home, and from the rail only when
// the manifest's `rail` slot was granted.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../../store'
import { replacing } from '../../lib/router'
import { relTime } from '../../lib/rel-time'
import { api, ApiError } from '../../lib/api'
import { hasFilter, type ActiveFilter, NO_FILTER } from '../../lib/facets'
import { FacetBar } from '../FacetBar'
import { SystemTabs } from '../SystemTabs'
import { SYSTEM_SILO } from '../../lib/system-house'
import { Fact, PageHeader, Seal, type Crumb } from '../PageHeader'
import { Search } from 'lucide-react'
import { identityWords } from '../../lib/tasks'
import {
  agentWord,
  columnAlign,
  columnHeader,
  facetsWithNames,
  filterToFacets,
  isTerminal,
  siloHeaderParts,
  siloName,
  singleValuePerFacet,
  siloIconOf,
} from '../../lib/silo-view'
import type { SiloDescriptor, SiloRecordsPage, SiloRecordRow, SiloSubmissionRow } from '../../lib/types'
import { submissionFor } from '../../lib/silo-install'
import { SiloRecordPage } from './SiloRecordPage'
import { SiloReviewPage } from './SiloReviewPage'
import { ProducerBinding } from './ProducerBinding'
import { SiloTreePage } from './SiloTreePage'
import { SiloLookPage, SiloLookSection } from './SiloLook'
import { ConfirmButton } from '../ConfirmButton'
import { splitTail } from '../../lib/processes'

// who a silo's routed rows go to, in words: one producer by name; several =
// the writer of each record (the server's rule, surfaces.ts recordProducer)
const routedTo = (to: string[]): string => (to.length <= 1 ? (to[0] ?? 'its producer') : `whoever wrote each record (${to.join(', ')})`)

export function SiloPage() {
  const page = useStore((s) => s.page)
  if (page?.kind !== 'silo') return null
  if (page.review) return <SiloReviewPage key={`${page.id}/review`} siloId={page.id} />
  return page.recordKey ? (
    <SiloRecordPage key={`${page.id}/${page.recordKey}`} siloId={page.id} recordKey={page.recordKey} />
  ) : (
    <SiloListOrTree key={`${page.id}/${page.view ?? ''}`} siloId={page.id} view={page.view ?? null} />
  )
}

// The common band's pieces for every silo page: the place
// is «Silos» (the inventory, Settings › Silos — its one house) and,
// below a silo, the silo itself — each crumb a door up, going there a new
// step in the history, never a Back.
export function silosCrumb(changePage: (p: { kind: 'settings'; tab: 'silos' }) => void): Crumb {
  return { label: 'Silos', title: 'Settings › Silos', onClick: () => changePage({ kind: 'settings', tab: 'silos' }) }
}
// `view`: the list view the crumb lands on (a record of a silo's second
// view goes back to that view, not the first)
export function siloCrumb(changePage: (p: { kind: 'silo'; id: string; view?: string }) => void, id: string, label: string, view?: string | null): Crumb {
  return { label, onClick: () => changePage({ kind: 'silo', id, ...(view ? { view } : {}) }) }
}

// The list view a page shows: the asked one, else the manifest's first —
// and the kind to ask the records route for (only when the silo has several
// to choose between: one list asks as it always did)
export function listOf(
  d: Pick<SiloDescriptor, 'lists'> | undefined,
  view: string | null,
): { id: string; kind: string; label: string | null; ask: { kind?: string } } | null {
  const lists = d?.lists ?? []
  const l = lists.find((x) => x.id === view) ?? lists[0]
  return l ? { ...l, ask: lists.length > 1 ? { kind: l.kind } : {} } : null
}
// one seal for the silo and all that lives in it — the rail's own glyph for
// it (its manifest's icon name, else the layers)
export function SiloSeal({ silo }: { silo?: Pick<SiloDescriptor, 'icon'> | null }) {
  const Icon = siloIconOf(silo)
  return (
    <Seal>
      <Icon size={17} strokeWidth={2} aria-hidden="true" className="text-terracotta" />
    </Seal>
  )
}

// An edge-only silo (relations, no kinds) has no records to list —
// its page is its tree, where the owner draws the relation.
function SiloListOrTree({ siloId, view }: { siloId: string; view: string | null }) {
  const d = useStore((s) => s.silos.find((x) => x.id === siloId))
  if (d && d.state === 'active' && d.tree && (d.kinds ?? []).length === 0) return <SiloTreePage d={d} tree={d.tree} />
  // a silo that brings only a look (spec.theme): its page is the look
  if (d && d.state === 'active' && d.theme && (d.kinds ?? []).length === 0) return <SiloLookPage d={d} />
  return <SiloListPage siloId={siloId} view={view} />
}

// A silo with several list views (System: Processes · Worktrees): one quiet
// row of their names under the header, the shown one underlined in ink.
// Going to another is a step in the history, like every door.
function ViewSwitch({ d, current }: { d: SiloDescriptor; current: string }) {
  const changePage = useStore((s) => s.changePage)
  const lists = d.lists ?? []
  if (lists.length < 2) return null
  return (
    <nav aria-label={`${siloName(d)} views`} className="mb-1 flex gap-5 border-b border-line" data-testid="silo-views">
      {lists.map((l, i) => {
        const on = l.id === current
        return (
          <button
            key={l.id}
            type="button"
            aria-current={on ? 'page' : undefined}
            onClick={() => {
              if (!on) changePage({ kind: 'silo', id: d.id, ...(i === 0 ? {} : { view: l.id }) })
            }}
            className={`-mb-px border-b-2 pb-1.5 text-[13px] transition-colors ${on ? 'border-ink font-medium text-ink' : 'border-transparent text-ink-2 hover:text-ink'}`}
          >
            {l.label ?? l.kind}
          </button>
        )
      })}
    </nav>
  )
}

// The state word of the silo itself, for a page that cannot show records:
// pending / disabled / error say their reason instead of pretending.
// A pending silo with a submission gets the dialog (the band above); one
// without — a manifest placed in the registry by hand — gets the verb
// «Submit it for approval…» submits the manifest the
// registry already holds (POST /api/silos/:id/resubmit, the same gesture as
// Settings › Silos) and opens the dialog; approving stays the dialog's.
function SiloStateNotice({ d, waiting }: { d: SiloDescriptor; waiting: boolean }) {
  const changePage = useStore((s) => s.changePage)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const review = (): void => changePage({ kind: 'silo', id: d.id, review: true })
  async function submit(): Promise<void> {
    setBusy(true)
    setFailed(null)
    try {
      await api.silos.resubmit(d.id)
      review()
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && typeof e.body === 'object' && e.body !== null && 'submission' in e.body) review()
      else setFailed(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mt-8 max-w-[62ch]">
      <p className="text-[14px] text-ink">
        This silo is <strong className="font-semibold">{d.state}</strong> — {d.reason}
      </p>
      {d.state === 'pending' ? (
        <p className="mt-2 text-[13px] text-ink-2">
          Nothing of it reaches Home, ⌘K or this page until you approve it.
          {waiting ? null : ' No submission of it waits yet.'}
        </p>
      ) : null}
      {/* a dimension the server still serves natively: its words, no door */}
      {d.state === 'pending' && !waiting && d.native ? <p className="mt-2 text-[13px] text-ink-2">{d.native}</p> : null}
      {d.state === 'pending' && !waiting && !d.native ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void submit()}
          className="mt-3 rounded-full border border-terracotta/40 bg-canvas px-3 py-0.5 text-[12px] font-medium text-terracotta hover:border-terracotta disabled:opacity-50"
        >
          {busy ? 'Submitting…' : 'Submit it for approval…'}
        </button>
      ) : null}
      {failed ? (
        <p role="alert" className="mt-2 text-[13px] text-terracotta">
          {failed}
        </p>
      ) : null}
    </div>
  )
}

// A version of this silo waiting for the approval click: the door to the
// dialog from the silo's own page (the other door is Home's Needs you row).
function WaitingBand({ sub, installed, onReview }: { sub: SiloSubmissionRow; installed: string | null; onReview: () => void }) {
  const who = sub.submittedBy === 'owner' ? 'you' : sub.submittedBy
  return (
    <div
      className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-terracotta/40 bg-terracotta-soft px-3 py-2.5"
      data-testid="silo-waiting"
    >
      <p className="min-w-0 flex-1 text-[13.5px] text-ink">
        {installed ? (
          <>
            Version {sub.version ?? '?'} waits for your approval — it would replace {installed}. Submitted by {who}.
          </>
        ) : (
          <>
            {sub.version ?? 'A version'} waits for your approval — submitted by {who}.
          </>
        )}
      </p>
      <button
        type="button"
        onClick={onReview}
        className="shrink-0 rounded-full border border-terracotta/40 bg-canvas px-3 py-0.5 text-[12px] font-medium text-terracotta hover:border-terracotta"
      >
        Review{installed ? ' the update' : ''} ›
      </button>
    </div>
  )
}

function Unreadable({ unreadable }: { unreadable: SiloRecordsPage['unreadable'] }) {
  const [open, setOpen] = useState(false)
  if (unreadable.count === 0) return null
  const n = unreadable.count
  return (
    <div className="mt-3 text-[12px] text-ink-2">
      <button type="button" onClick={() => setOpen((v) => !v)} className="underline-offset-2 hover:text-ink hover:underline">
        {n} record{n === 1 ? '' : 's'} can't be read {open ? '— hide' : '— show which'}
      </button>
      {open ? (
        <ul className="mt-1 flex flex-col gap-1">
          {unreadable.items.map((u) => (
            <li key={u.file}>
              <span className="break-all font-mono text-[11px]">{u.rel}</span>
              <span className="block pl-3 text-[11px] text-ink" data-testid="silo-unreadable-reason">
                {u.reason}
              </span>
            </li>
          ))}
          {unreadable.items.length < n ? <li className="font-mono text-[11px] text-ink-3">…and {n - unreadable.items.length} more</li> : null}
        </ul>
      ) : null}
    </div>
  )
}

// The places a silo shows in, each a quiet on/off the owner holds
// (operator slotsOff, PATCH /api/silos/:id/operator). A builtin may be born
// with one off (support's pulse) — this is where it turns on.
// The server's answer repaints the line; nothing is pretended.
const SLOT_WORDS: Record<string, string> = {
  pulse: "Home's pulse",
  'needs-you': 'Needs you',
  rail: 'the rail',
  'agent-section': "agents' pages",
  'project-machinery': "projects' machinery",
  lens: 'the Tasks lens',
}
export function SlotToggles({ silo }: { silo: Pick<SiloDescriptor, 'id' | 'slots'> }) {
  const loadSilos = useStore((s) => s.loadSilos)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // the System house's rail door is the house's own, not a slot to turn off
  const slots = silo.slots.requested.filter((x) => !(silo.id === SYSTEM_SILO && x === 'rail'))
  if (slots.length === 0) return null
  const off = new Set(silo.slots.off)
  async function toggle(slot: string): Promise<void> {
    const next = off.has(slot) ? [...off].filter((s) => s !== slot) : [...off, slot]
    setBusy(slot)
    setError(null)
    try {
      await api.silos.operator(silo.id, { slotsOff: next })
      await loadSilos()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="mt-1.5" data-testid="silo-slots">
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono text-[11.5px] text-ink-3">
        <span>shows on</span>
        {slots.map((slot) => {
          const isOff = off.has(slot)
          return (
            <button
              key={slot}
              type="button"
              aria-pressed={!isOff}
              disabled={busy !== null}
              onClick={() => void toggle(slot)}
              title={isOff ? 'Off — click to show it there' : 'On — click to stop showing it there'}
              className={`rounded px-0.5 disabled:opacity-50 ${isOff ? 'text-ink-3 line-through decoration-ink-3/60 hover:text-terracotta' : 'text-ink-2 hover:text-terracotta'}`}
            >
              {busy === slot ? '…' : (SLOT_WORDS[slot] ?? slot)}
            </button>
          )
        })}
      </p>
      {error ? <p className="mt-1 text-[11px] text-terracotta">{error}</p> : null}
    </div>
  )
}

// Consecutive rows of one group (or the whole page as one ungrouped run).
type Segment = { key: string; group: NonNullable<SiloRecordRow['group']> | null; rows: SiloRecordRow[] }
function groupSegments(rows: readonly SiloRecordRow[], grouped: boolean): Segment[] {
  if (!grouped) return [{ key: 'all', group: null, rows: [...rows] }]
  const out: Segment[] = []
  for (const r of rows) {
    const g = r.group ?? null
    const last = out[out.length - 1]
    if (last && last.group?.value === g?.value && last.rows[0]?.folded === r.folded) last.rows.push(r)
    else out.push({ key: `${r.folded ? 'f' : 'l'}/${g?.value ?? '\u0000none'}/${out.length}`, group: g ?? { value: null, label: '—', count: 0 }, rows: [r] })
  }
  return out
}

// A group's quiet heading: its words, and its count over the whole set — a
// page that shows part of it says «4 of 7» (the rest is past «Show more»).
// When the server says the group's value opens something (`group.opens`: an
// agent, a folder, a conversation that exists), the words ARE that door —
// underlined only on hover, like every quiet door here; without it, words.
type GroupDoor = NonNullable<NonNullable<SiloRecordRow['group']>['opens']>
function useOpenGroup(): (door: GroupDoor) => void {
  const selectAgent = useStore((s) => s.selectAgent)
  const changePage = useStore((s) => s.changePage)
  const openSession = useStore((s) => s.openSession)
  return (door) => {
    if (door.hub === 'agent') selectAgent(door.value)
    else if (door.hub === 'folder') changePage({ kind: 'project', folder: door.value })
    else {
      const cut = door.value.lastIndexOf('/')
      if (cut > 0) void openSession(door.value.slice(0, cut), door.value.slice(cut + 1))
    }
  }
}
const DOOR_WORDS: Record<GroupDoor['hub'], string> = { agent: 'Open the agent', folder: 'Open the project', conversation: 'Open the conversation' }
function GroupHeading({
  group,
  shown,
  folded,
  onOpen,
}: {
  group: NonNullable<SiloRecordRow['group']>
  shown: number
  folded: boolean
  onOpen: (door: GroupDoor) => void
}) {
  const tone = folded ? 'text-ink-3' : group.value === null ? 'text-ink-2' : 'text-ink'
  const door = group.opens
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      {door ? (
        <button
          type="button"
          data-testid="silo-group-door"
          onClick={() => onOpen(door)}
          title={`${DOOR_WORDS[door.hub]} — ${group.label}`}
          className={`min-w-0 truncate rounded-sm text-left text-[12.5px] font-medium ${tone} decoration-terracotta/50 underline-offset-[3px] hover:text-terracotta hover:underline focus-visible:underline`}
        >
          {group.label}
        </button>
      ) : (
        <span className={`min-w-0 truncate text-[12.5px] font-medium ${tone}`} title={group.label}>
          {group.label}
        </span>
      )}
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-3">{shown < group.count ? `${shown} of ${group.count}` : group.count}</span>
    </span>
  )
}

// One records table — used for the live list and for the folded section.
// Desktop: a dense table, identity first and in ink; below sm the same rows
// stack (identity line + the remaining cells joined in mono) so the page
// never scrolls sideways for prose.
// A kernel-verb's door on a row (catalogs.md «Kernel-verbs»): the catalog's
// word («Stop»), behind a confirm, only where the record says its `when`
// holds (row.verbs). Quiet until the row is hovered or focused; its cell is
// always there, so showing it never shifts the columns. From the confirm
// until the kernel's answer AND the re-read records, the door is the
// catalog's pending word («Stopping…»), shown at rest, never clickable.
function RowVerbs({
  page,
  r,
  onVerb,
  busy,
}: {
  page: SiloRecordsPage
  r: SiloRecordRow
  onVerb: (r: SiloRecordRow, name: string) => void
  busy: string | null
}) {
  const verbs = (page.kind.verbs ?? []).filter((v) => (r.verbs ?? []).includes(v.name))
  if (verbs.length === 0) return null
  return (
    <span className="inline-flex items-baseline gap-2" onClick={(e) => e.stopPropagation()}>
      {verbs.map((v) =>
        busy === `${r.key}\u0000${v.name}` ? (
          <span key={v.name} role="status" data-testid="silo-verb-pending" className="font-mono text-[11px] text-terracotta motion-safe:animate-pulse">
            {v.pending ?? `${v.says}…`}
          </span>
        ) : (
          <ConfirmButton
            key={v.name}
            onConfirm={() => onVerb(r, v.name)}
            disabled={busy !== null}
            ariaLabel={`${v.says} ${r.identity || r.id}`}
            confirmLabel={`${v.says} it?`}
            className="font-mono text-[11px] text-ink-3 opacity-0 underline-offset-2 transition-opacity hover:text-terracotta hover:underline focus-visible:opacity-100 group-hover/row:opacity-100 group-focus-within/row:opacity-100 disabled:invisible"
            armedClassName="font-mono text-[11px] font-medium text-terracotta"
          >
            {v.says}
          </ConfirmButton>
        ),
      )}
    </span>
  )
}

// A long identity cut in the MIDDLE: the head ellipsizes, the last word(s)
// stay (a command's `--port 5180`, an invoice's number) — the whole on hover.
function Identity({ text, className }: { text: string; className: string }) {
  const { head, tail } = splitTail(text)
  return (
    <span className={`flex min-w-0 items-baseline ${className}`}>
      <span className="min-w-0 truncate">{head}</span>
      {tail ? <span className="shrink-0 whitespace-pre">{` ${tail}`}</span> : null}
    </span>
  )
}

export function RecordsTable({
  page,
  onOpen,
  onSetState,
  onVerb,
  verbBusy = null,
  hide = [],
  compact = false,
}: {
  page: SiloRecordsPage
  onOpen: (r: SiloRecordRow) => void
  // a kernel-verb the owner confirmed on a row (its descriptor: kind.verbs)
  onVerb?: (r: SiloRecordRow, name: string) => void
  verbBusy?: string | null
  // the kind's state is owner-settable (kind.stateEdit): the state cell is a
  // select dispatching the same set-field as the record page
  onSetState?: (r: SiloRecordRow, value: string) => void
  hide?: readonly string[] // columns a placement leaves out (the agent's own page: agent)
  compact?: boolean // embedded in a page: long cells two lines each
}) {
  const agents = useStore((s) => s.agents)
  const { kind } = page
  const columns = kind.columns.filter((c) => !hide.includes(c))
  // an empty identity is never a bare id: the project's list's words (the
  // Plans silo's reserved id as the fallback), else «(untitled)»
  const identityOf = (r: SiloRecordRow): string => identityWords(r)
  // an agent anchor is said by its NAME (every silo)
  const nowTick = useStore((s) => s.nowTick)
  const cellOf = (r: SiloRecordRow, c: string): string => {
    if (c === 'agent' && typeof r.anchors.agent === 'string') return agentWord(agents, r.anchors.agent)
    // a past moment reads relative, like every past time in the app;
    // the exact moment rides the cell's title (exactOf below)
    if (c === 'at' && r.at && !Number.isNaN(Date.parse(r.at))) return relTime(Date.parse(r.at), nowTick)
    return r.cells.find((x) => x.column === c)?.text ?? '—'
  }
  const exactOf = (r: SiloRecordRow, c: string): string | undefined => (c === 'at' ? r.cells.find((x) => x.column === c)?.text : undefined)
  const stateEdit = onSetState && kind.stateEdit ? kind.stateEdit : null
  const marks = (r: SiloRecordRow): string[] => [...(r.conflict ? ['conflict'] : r.overlay ? ['your edit stands'] : []), ...r.remarks]
  // the view's groups (list `groupBy`): consecutive rows of one group — the
  // server keeps a group contiguous across pages, so «Show more» extends the
  // last one instead of opening a second heading
  const segments = groupSegments(page.records, kind.groupBy != null)
  // the view's `first` records draw the eye by weight and an ink dot — never
  // an alarm colour (terracotta stays for the one live thing of the page)
  const FirstDot = () => <span aria-hidden="true" className="mr-1.5 inline-block size-[5px] translate-y-[-1.5px] rounded-full bg-ink" />
  // the kind declares kernel-verbs: one trailing cell on every row for their doors
  const verbCell = onVerb !== undefined && (kind.verbs ?? []).length > 0
  // the row a kernel-verb is working on: in transit — dimmed, said busy
  const inTransit = (r: SiloRecordRow): boolean => verbBusy !== null && verbBusy.startsWith(`${r.key}\u0000`)
  const openGroup = useOpenGroup()
  return (
    <>
      <table className="hidden w-full text-[13px] sm:table">
        <thead className="text-left font-mono text-[11px] text-ink-3">
          <tr>
            {columns.map((c, i) => (
              <th key={c} className={`py-1 font-normal ${i === columns.length - 1 ? '' : 'pr-4'} ${columnAlign(c, kind) === 'right' ? 'text-right' : ''}`}>
                {columnHeader(c, kind.name, kind.columnLabels)}
              </th>
            ))}
            {/* one fixed width, room for the armed word too: arming never moves a column */}
            {verbCell ? (
              <th className="w-[5.5rem] min-w-[5.5rem] py-1 pl-3 font-normal">
                <span className="sr-only">Actions</span>
              </th>
            ) : null}
          </tr>
        </thead>
        {segments.map((seg) => (
          <tbody key={seg.key} data-testid={seg.group ? 'silo-group' : undefined}>
            {seg.group ? (
              <tr className="border-t border-line">
                <th colSpan={columns.length + (verbCell ? 1 : 0)} scope="rowgroup" className="pb-1 pt-4 text-left font-normal">
                  <GroupHeading group={seg.group} shown={seg.rows.length} folded={seg.rows[0]?.folded ?? false} onOpen={openGroup} />
                </th>
              </tr>
            ) : null}
            {seg.rows.map((r) => (
              <tr
                key={r.key}
                onClick={() => onOpen(r)}
                aria-busy={inTransit(r) || undefined}
                className={`group/row cursor-pointer border-t border-line/70 align-top hover:bg-panel ${r.folded ? 'text-ink-3' : ''} ${inTransit(r) ? '[&>td]:opacity-50 [&>td]:transition-opacity [&>td:last-child]:opacity-100' : ''}`}
              >
                {columns.map((c, i) => {
                  const text = c === 'identity' && !r.identity ? identityOf(r) : cellOf(r, c)
                  if (c === 'identity') {
                    // one line that ends in an ellipsis, the whole text on hover
                    // (embedded: two lines). The cell takes the room the figures leave.
                    return (
                      <td key={c} className={compact ? 'max-w-[46ch] py-1.5 pr-4' : 'w-full max-w-0 py-1.5 pr-5'} title={compact ? undefined : text}>
                        <span className={`flex min-w-0 items-baseline ${compact ? '' : 'whitespace-nowrap'}`}>
                          {compact ? (
                            <span className={`min-w-0 ${r.folded ? 'text-ink-2' : 'text-ink'} line-clamp-2`}>{text}</span>
                          ) : (
                            <Identity text={text} className={r.folded ? 'text-ink-2' : 'text-ink'} />
                          )}
                          {marks(r).map((m) => (
                            <span key={m} className={`ml-2 shrink-0 font-mono text-[10px] ${m === 'conflict' ? 'text-terracotta' : 'text-ink-3'}`}>
                              {m}
                            </span>
                          ))}
                        </span>
                      </td>
                    )
                  }
                  const terminal = c === 'state' && isTerminal(kind.states, r.state)
                  if (c === 'state' && stateEdit && r.state !== null) {
                    return (
                      <td key={c} className={`whitespace-nowrap py-1 ${i === columns.length - 1 ? '' : 'pr-4'}`} onClick={(e) => e.stopPropagation()}>
                        <select
                          aria-label={`Set ${stateEdit.field}`}
                          value={r.state}
                          onChange={(e) => onSetState!(r, e.target.value)}
                          className={`rounded border border-line bg-panel px-1 py-0.5 font-mono text-[12px] ${terminal || r.folded ? 'text-ink-3' : 'text-ink-2'}`}
                        >
                          {stateEdit.values.map((v) => (
                            <option key={v} value={v}>
                              {kind.states.find((s) => s.value === v)?.one ?? v}
                            </option>
                          ))}
                        </select>
                      </td>
                    )
                  }
                  const long = c.startsWith('last(')
                  if (long) {
                    return (
                      <td key={c} className={`max-w-[40ch] py-1.5 ${i === columns.length - 1 ? '' : 'pr-4'} text-[12.5px] text-ink-2`}>
                        <span className={compact ? 'line-clamp-2' : ''}>{text}</span>
                      </td>
                    )
                  }
                  return (
                    <td
                      key={c}
                      title={exactOf(r, c)}
                      className={`whitespace-nowrap py-1.5 ${i === columns.length - 1 ? '' : 'pr-4'} font-mono text-[12px] ${columnAlign(c, kind) === 'right' ? 'text-right tabular-nums' : ''} ${c === 'state' ? (terminal || r.folded ? 'text-ink-3' : 'text-ink-2') : 'text-ink-2'}`}
                    >
                      {c === 'state' && r.first && !r.folded ? (
                        <span className="-ml-[11px] font-medium text-ink">
                          <FirstDot />
                          {text}
                        </span>
                      ) : (
                        text
                      )}
                    </td>
                  )
                })}
                {verbCell ? (
                  <td className="w-[5.5rem] min-w-[5.5rem] whitespace-nowrap py-1.5 pl-3 text-right">
                    <RowVerbs page={page} r={r} onVerb={onVerb!} busy={verbBusy} />
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
      {/* the same records, stacked for a phone — identity + the one-line voice */}
      <ul className="flex flex-col sm:hidden">
        {segments.map((seg) => [
          seg.group ? (
            <li key={`${seg.key}/heading`} className="border-t border-line pb-1 pt-4">
              <GroupHeading group={seg.group} shown={seg.rows.length} folded={seg.rows[0]?.folded ?? false} onOpen={openGroup} />
            </li>
          ) : null,
          ...seg.rows.map((r) => (
            <li
              key={r.key}
              aria-busy={inTransit(r) || undefined}
              className={`group/row flex items-start gap-3 border-t border-line/70 ${inTransit(r) ? '[&>button]:opacity-50 [&>button]:transition-opacity' : ''}`}
            >
              <button type="button" onClick={() => onOpen(r)} className="min-w-0 flex-1 py-2 text-left">
                <span className={`block text-[13.5px] ${r.folded ? 'text-ink-2' : 'text-ink'}`}>
                  {identityOf(r)}
                  {marks(r).map((m) => (
                    <span key={m} className={`ml-2 font-mono text-[10px] ${m === 'conflict' ? 'text-terracotta' : 'text-ink-3'}`}>
                      {m}
                    </span>
                  ))}
                </span>
                <span className="mt-0.5 block font-mono text-[11px] text-ink-2">
                  {r.first && !r.folded ? (
                    <span className="font-medium text-ink">
                      <FirstDot />
                      {r.stateLabel}
                    </span>
                  ) : null}
                  {columns
                    .filter((c) => c !== 'identity' && !(c === 'state' && r.first && !r.folded))
                    .map((c) => cellOf(r, c))
                    .filter((t) => t !== '—')
                    .map((t, i) => ((r.first && !r.folded) || i > 0 ? ` · ${t}` : t))
                    .join('')}
                </span>
              </button>
              {verbCell ? (
                <span className="shrink-0 py-2 [&_button]:opacity-100">
                  <RowVerbs page={page} r={r} onVerb={onVerb!} busy={verbBusy} />
                </span>
              ) : null}
            </li>
          )),
        ])}
      </ul>
    </>
  )
}

// The «retire» half of the inventory's promise («Install, review and
// retire», SilosPage): the door lives on the silo's own page, with the
// operator's other controls. It asks once before acting, says honestly
// that the uninstall keeps everything on disk (installer.ts: the manifest
// moves aside; records, files and conventions stay, with a Reinstall door
// in Settings › Silos), and a refusal is shown in the server's words. A
// recommended silo says first, plainly, what removing it gives up (the
// server's `loses`, native.ts).
function UninstallDoor({ id, name, loses }: { id: string; name: string; loses: string | null }) {
  const loadSilos = useStore((s) => s.loadSilos)
  const changePage = useStore((s) => s.changePage)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function run(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await api.silos.uninstall(id)
      await loadSilos()
      replacing(() => changePage({ kind: 'settings', tab: 'silos' })) // its page is gone: the inventory replaces it
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  return (
    <div className="mt-8 border-t border-line pt-3" data-testid="silo-uninstall">
      {asking ? (
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12.5px] text-ink-2">
          <span>
            Uninstall {name}? {loses ? <span className="text-ink">{loses} </span> : null}Its records, files and conventions stay on disk, and Settings › Silos
            keeps a Reinstall door.
          </span>
          <button
            type="button"
            data-testid="silo-uninstall-confirm"
            disabled={busy}
            onClick={() => void run()}
            className="rounded border border-line px-2 py-0.5 text-xs transition-colors hover:border-terracotta hover:text-terracotta disabled:opacity-50"
          >
            {busy ? 'Uninstalling…' : 'Yes, uninstall'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setAsking(false)
              setError(null)
            }}
            className="text-xs hover:text-terracotta"
          >
            Keep it
          </button>
        </p>
      ) : (
        <button
          type="button"
          data-testid="silo-uninstall-open"
          onClick={() => setAsking(true)}
          className="font-mono text-[11.5px] text-ink-3 underline-offset-2 hover:text-terracotta hover:underline"
        >
          Uninstall…
        </button>
      )}
      {error ? (
        <p role="alert" className="mt-1 text-[11px] text-terracotta">
          {error}
        </p>
      ) : null}
    </div>
  )
}

// The list's one text filter: quiet as the facet chips beside it, its words
// the kind's own noun («Find a process»). Esc clears it.
function SearchField({ value, onChange, noun }: { value: string; onChange: (v: string) => void; noun: string }) {
  return (
    <label className="group relative inline-flex w-full items-center sm:w-[15rem]">
      <Search size={11} aria-hidden="true" className="pointer-events-none absolute left-2 text-ink-3 group-focus-within:text-ink-2" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value !== '') {
            e.stopPropagation()
            onChange('')
          }
        }}
        placeholder={`Find ${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`}
        aria-label={`Find ${noun}s by their words`}
        spellCheck={false}
        className="w-full rounded-full border border-line bg-transparent py-0.5 pl-6 pr-2 font-mono text-[11px] text-ink placeholder:text-ink-3 hover:border-ink-3/60 focus:border-ink-3 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
      />
    </label>
  )
}

function SiloListPage({ siloId, view }: { siloId: string; view: string | null }) {
  const silos = useStore((s) => s.silos)
  const loadSilos = useStore((s) => s.loadSilos)
  const changePage = useStore((s) => s.changePage)
  const siloTick = useStore((s) => s.siloTick)
  const descriptor = silos.find((s) => s.id === siloId)
  // the list view shown (descriptor.lists): a page asked for one waits for
  // the descriptor rather than flash the first one's records
  const list = listOf(descriptor, view)
  // the System house (lib/system-house.ts): its lists are tabs of the
  // house's row, beside Files and Vault — never a second switch below
  // and its band is the house's (no «Silos» crumb, seal or description), so
  // the tab row sits at one height on all four tabs
  const house = siloId === SYSTEM_SILO
  const kindAsk = list?.ask.kind
  const waitsForList = view !== null && descriptor === undefined

  const [data, setData] = useState<SiloRecordsPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<ActiveFilter>(NO_FILTER)
  // the search: typed words, asked of the server once typing pauses (the
  // count line stays the server's — «3 of 24 match»)
  const [typed, setTyped] = useState('')
  const [query, setQuery] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setQuery(typed.trim()), 180)
    return () => clearTimeout(t)
  }, [typed])
  // «N folded» under the live list: its count comes from the same route
  // (folded=only, limit 1 → matching), never computed client-side.
  const [foldedCount, setFoldedCount] = useState<number | null>(null)
  const [folded, setFolded] = useState<SiloRecordsPage | null>(null)
  const [showFolded, setShowFolded] = useState(false)
  // a kernel-verb confirmed on a row (runVerb below): its door says the
  // pending word until the kernel answered AND the records were read again
  // — clearing it on the answer alone flashed the row back to «Stop» for
  // the moment the re-read took. `settling`: answered, re-read due.
  const [verbBusy, setVerbBusy] = useState<string | null>(null)
  const settling = useRef(false)
  const settled = (): void => {
    if (settling.current) {
      settling.current = false
      setVerbBusy(null)
    }
  }

  useEffect(() => {
    void loadSilos()
  }, [loadSilos])
  // a version of this silo waiting for approval (installed or not) — re-read
  // on the same `silos` signal the records follow
  const [subs, setSubs] = useState<SiloSubmissionRow[]>([])
  useEffect(() => {
    let cancelled = false
    Promise.resolve(api.silos.submissions())
      .then((s) => {
        if (!cancelled && Array.isArray(s)) setSubs(s)
      })
      .catch(() => {
        if (!cancelled) setSubs([])
      })
    return () => {
      cancelled = true
    }
  }, [siloId, siloTick])
  const waiting = submissionFor(subs, siloId)
  const review = (): void => changePage({ kind: 'silo', id: siloId, review: true })
  // a filter is an explicit ask for those records — it overrides the fold
  // (filtering by a folded state would otherwise show an empty list).
  const filtered = hasFilter(filter) || query !== ''
  const active = descriptor === undefined || descriptor.state === 'active'

  useEffect(() => {
    if (!active || waitsForList) return
    let cancelled = false
    const facets = filterToFacets(filter)
    const kind = kindAsk ? { kind: kindAsk } : {}
    Promise.resolve(api.silos.records(siloId, { ...kind, facets, ...(query ? { q: query } : {}), ...(filtered ? {} : { folded: 'exclude' as const }) }))
      .then((p) => {
        if (!cancelled) {
          setData(p)
          setError(null)
          settled()
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
          setData(null)
          settled()
        }
      })
    if (!filtered) {
      Promise.resolve(api.silos.records(siloId, { ...kind, folded: 'only', limit: 1 }))
        .then((p) => {
          if (!cancelled) setFoldedCount(p.matching)
        })
        .catch(() => {
          if (!cancelled) setFoldedCount(null)
        })
    } else {
      setFoldedCount(null)
      setShowFolded(false)
    }
    return () => {
      cancelled = true
    }
  }, [siloId, filter, query, filtered, siloTick, active, kindAsk, waitsForList])

  useEffect(() => {
    if (!showFolded || filtered || !active || waitsForList) {
      setFolded(null)
      return
    }
    let cancelled = false
    Promise.resolve(api.silos.records(siloId, { ...(kindAsk ? { kind: kindAsk } : {}), folded: 'only' }))
      .then((p) => {
        if (!cancelled) setFolded(p)
      })
      .catch(() => {
        if (!cancelled) setFolded(null)
      })
    return () => {
      cancelled = true
    }
  }, [siloId, showFolded, filtered, siloTick, active, kindAsk, waitsForList])

  async function showMore(target: SiloRecordsPage, set: (p: SiloRecordsPage) => void, foldedOnly: boolean): Promise<void> {
    try {
      const next = await api.silos.records(siloId, {
        ...(kindAsk ? { kind: kindAsk } : {}),
        facets: filterToFacets(filter),
        ...(query && !foldedOnly ? { q: query } : {}),
        offset: target.offset + target.records.length,
        ...(foldedOnly ? { folded: 'only' as const } : filtered ? {} : { folded: 'exclude' as const }),
      })
      set({ ...next, offset: target.offset, records: [...target.records, ...next.records] })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const agents = useStore((s) => s.agents)
  const facetBars = useMemo(() => (data ? facetsWithNames(data.kind, agents) : []), [data, agents])
  // the row's state select: the same set-field the record page dispatches
  // (no CAS from a list row — the native table had none either); every
  // change re-reads the page so nothing is pretended
  const [rowError, setRowError] = useState<string | null>(null)
  const setState = (r: SiloRecordRow, value: string): void => {
    const field = data?.kind.stateEdit?.field
    if (!field) return
    Promise.resolve(api.silos.setField(siloId, { key: r.key, field, value }))
      .then(() => {
        setRowError(null)
        useStore.setState((s) => ({ siloTick: s.siloTick + 1 }))
      })
      .catch((e: unknown) => setRowError(e instanceof Error ? e.message : String(e)))
  }
  // a kernel-verb confirmed on a row: the kernel acts, its words are said
  // above the list (a refusal too, verbatim), and the page re-reads
  const [verbSaid, setVerbSaid] = useState<{ words: string; failed: boolean } | null>(null)
  const runVerb = (r: SiloRecordRow, name: string): void => {
    settling.current = false
    setVerbBusy(`${r.key}\u0000${name}`)
    setVerbSaid(null)
    Promise.resolve(api.silos.kernelVerb(siloId, { key: r.key, name }))
      .then((a) => setVerbSaid({ words: a.says, failed: a.outcome === 'partial' }))
      .catch((e: unknown) => setVerbSaid({ words: e instanceof Error ? e.message : String(e), failed: true }))
      .finally(() => {
        settling.current = true
        useStore.setState((s) => ({ siloTick: s.siloTick + 1 }))
      })
  }
  const open = (r: SiloRecordRow): void => changePage({ kind: 'silo', id: siloId, recordKey: r.key })
  const title = descriptor ? siloName(descriptor) : (data?.silo.name ?? waiting?.name ?? siloId)
  const headerParts = descriptor ? siloHeaderParts(descriptor) : []
  // the freshness term the records answer carries is the live one
  const freshness = data?.silo.freshness ?? descriptor?.freshness?.term ?? null
  const shown = (p: SiloRecordsPage): string | null => p.said ?? (p.records.length < p.matching ? `showing ${p.records.length} of ${p.matching}` : null)

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <PageHeader
        testId="silo-header"
        crumbs={house ? [] : [silosCrumb(changePage)]}
        seal={house ? undefined : <SiloSeal silo={descriptor} />}
        title={title}
        facts={
          headerParts.length > 0 || freshness ? (
            <>
              {/* one sentence (counts · producer): it ellipsizes as one */}
              <Fact truncate>
                <span className="min-w-0 truncate">{(descriptor ? siloHeaderParts({ ...descriptor, freshness: null }) : []).join(' · ')}</span>
              </Fact>
              {freshness ? <Fact className="text-terracotta">{freshness}</Fact> : null}
            </>
          ) : null
        }
        tabs={house ? <SystemTabs /> : undefined}
        notes={
          !house && descriptor?.description ? (
            <p className="mt-0.5 truncate text-[12.5px] text-ink-3" title={descriptor.description}>
              {descriptor.description}
            </p>
          ) : null
        }
      />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[56rem] px-4 pb-12 pt-4 sm:px-5">
          {/* audience routing (operator-granted): the owner lands here from
              Home's «with Finance» line — the page says whose queue this is */}
          {descriptor?.routing ? (
            <p className="font-mono text-[11.5px] text-ink-2" data-testid="silo-routing">
              {/* several bound: each row goes to the agent that wrote its record */}
              {descriptor.routing.entries.length === descriptor.routing.of
                ? `Its needs-you rows go to ${routedTo(descriptor.routing.to)} — your inbox gets what it escalates.`
                : `Some of its needs-you rows go to ${routedTo(descriptor.routing.to)} — your inbox keeps the rest.`}
            </p>
          ) : null}

          {descriptor && descriptor.state === 'active' && list && !house ? <ViewSwitch d={descriptor} current={list.id} /> : null}
          {descriptor && descriptor.state === 'active' ? <SlotToggles silo={descriptor} /> : null}
          {descriptor && descriptor.state === 'active' ? <ProducerBinding silo={descriptor} /> : null}
          {/* a silo with records that also brings a look: the look, and its door */}
          {descriptor && descriptor.state === 'active' && descriptor.theme ? <SiloLookSection d={descriptor} /> : null}

          {waiting ? (
            <WaitingBand sub={waiting} installed={descriptor && descriptor.state !== 'pending' ? descriptor.version : null} onReview={review} />
          ) : null}

          {descriptor === undefined && waiting ? (
            <p className="mt-6 max-w-[62ch] text-[14px] text-ink">Not installed — nothing of it reaches Home, ⌘K or this page until you approve it.</p>
          ) : descriptor && descriptor.state !== 'active' ? (
            <SiloStateNotice d={descriptor} waiting={waiting !== null} />
          ) : (
            <>
              {error ? (
                <div role="alert" className="mt-4 text-[13px] text-terracotta">
                  {error}
                </div>
              ) : null}
              {data ? (
                <>
                  {/* the one filter line: find, the facets, and what they leave */}
                  {data.total > 0 ? (
                    <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1.5">
                      <SearchField value={typed} onChange={setTyped} noun={columnHeader('identity', data.kind.name, data.kind.columnLabels)} />
                      <FacetBar facets={facetBars} filter={filter} onChange={(f) => setFilter(singleValuePerFacet(filter, f))} />
                      {filtered ? (
                        <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-ink-2" data-testid="silo-matching" aria-live="polite">
                          {data.matching} of {data.total} match
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  {data.matching === 0 ? (
                    <p className="mt-4 text-[13px] text-ink-2">
                      {data.total === 0 ? (
                        (data.kind.reads ?? descriptor?.kernel?.reads) ? (
                          `No records yet — Silos keeps them here from ${data.kind.reads ?? descriptor?.kernel?.reads}.`
                        ) : (
                          'No records yet — they appear here as the producer writes them.'
                        )
                      ) : (
                        <>
                          Nothing matches
                          {query ? (
                            <>
                              {' '}
                              <span className="text-ink">«{query}»</span>
                            </>
                          ) : null}
                          {hasFilter(filter) ? (query ? ' with these filters' : ' these filters') : ''}.{' '}
                          <button
                            type="button"
                            onClick={() => {
                              setTyped('')
                              setQuery('')
                              setFilter(NO_FILTER)
                            }}
                            className="underline underline-offset-2 hover:text-ink"
                          >
                            Show all {data.total}
                          </button>
                        </>
                      )}
                    </p>
                  ) : (
                    <div className="mt-3">
                      {rowError ? (
                        <div role="alert" className="mb-2 text-[12px] text-terracotta">
                          {rowError}
                        </div>
                      ) : null}
                      {verbSaid ? (
                        <div role="status" data-testid="silo-verb-said" className={`mb-2 text-[12.5px] ${verbSaid.failed ? 'text-terracotta' : 'text-ink-2'}`}>
                          {verbSaid.words}
                        </div>
                      ) : null}
                      <RecordsTable page={data} onOpen={open} onSetState={setState} onVerb={runVerb} verbBusy={verbBusy} />
                      {shown(data) ? (
                        <div className="mt-2 flex items-center gap-3 border-t border-line/70 pt-2 font-mono text-[11px] text-ink-2">
                          <span>{shown(data)}</span>
                          <button
                            type="button"
                            onClick={() => void showMore(data, setData, false)}
                            className="underline-offset-2 hover:text-ink hover:underline"
                          >
                            Show more
                          </button>
                        </div>
                      ) : null}
                    </div>
                  )}
                  {!filtered && foldedCount !== null && foldedCount > 0 ? (
                    <div className="mt-4 border-t border-line pt-2">
                      <button
                        type="button"
                        aria-expanded={showFolded}
                        onClick={() => setShowFolded((v) => !v)}
                        className="font-mono text-[11.5px] text-ink-2 underline-offset-2 hover:text-ink hover:underline"
                      >
                        {/* what the fold holds, in the view's words (fold.label) — else «N more» */}
                        {foldedCount} {data.kind.fold?.label ?? 'more'} <span className="text-ink-3">·</span> {showFolded ? 'Hide' : 'Show'}
                      </button>
                      {showFolded && folded ? (
                        <div className="mt-2">
                          <RecordsTable page={folded} onOpen={open} onSetState={setState} onVerb={runVerb} verbBusy={verbBusy} />
                          {shown(folded) ? (
                            <div className="mt-2 flex items-center gap-3 border-t border-line/70 pt-2 font-mono text-[11px] text-ink-2">
                              <span>{shown(folded)}</span>
                              <button
                                type="button"
                                onClick={() => void showMore(folded, setFolded, true)}
                                className="underline-offset-2 hover:text-ink hover:underline"
                              >
                                Show more
                              </button>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  <Unreadable unreadable={data.unreadable} />
                </>
              ) : !error && descriptor === undefined && silos.length > 0 ? (
                <p className="mt-4 text-[13px] text-ink-2">
                  No silo named <span className="font-mono">{siloId}</span> is installed.
                </p>
              ) : null}
              {descriptor !== undefined ? <UninstallDoor id={siloId} name={descriptor.name ?? siloId} loses={descriptor.loses ?? null} /> : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
