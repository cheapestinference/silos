// system-house.ts — System is ONE house: what this machine
// runs, holds on disk and keeps as keys. Its first tab is Vitals — the
// machine told in Silos' terms (/system) — then the System
// silo's list views (Processes · Worktrees — the manifest's, never named
// here), then the two native pages that moved in from the rail: Files and
// Vault. The addresses stay each page's own (/system, /silo/system…, /files,
// /vault); the house is the shared tab row and the rail's one door.
import type { Page } from '../store/types'
import type { SiloDescriptor } from './types'

export const SYSTEM_SILO = 'system'

export interface SystemTab {
  id: string
  label: string
  page: Page
}

function systemSilo(silos: readonly SiloDescriptor[]): SiloDescriptor | null {
  return silos.find((s) => s.id === SYSTEM_SILO && s.state === 'active') ?? null
}

const listPage = (lists: NonNullable<SiloDescriptor['lists']>, i: number): Page => ({
  kind: 'silo',
  id: SYSTEM_SILO,
  ...(i === 0 ? {} : { view: lists[i]!.id }),
})

// Vitals first — always; the silo's lists (when it is on); then Files and Vault — always
export function systemTabs(silos: readonly SiloDescriptor[]): SystemTab[] {
  const lists = systemSilo(silos)?.lists ?? []
  return [
    { id: 'vitals', label: 'Vitals', page: { kind: 'system' } },
    ...lists.map((l, i): SystemTab => ({ id: `list:${l.id}`, label: l.label ?? l.kind, page: listPage(lists, i) })),
    { id: 'files', label: 'Files', page: { kind: 'files' } },
    { id: 'vault', label: 'Vault', page: { kind: 'vault' } },
  ]
}

// the silo's list of one kind (the vitals' «Worktrees ›»), or null when the
// silo is off or holds no such list — then there is no door to draw
export function systemListOf(silos: readonly SiloDescriptor[], kind: string): Page | null {
  const lists = systemSilo(silos)?.lists ?? []
  const i = lists.findIndex((l) => l.kind === kind)
  return i < 0 ? null : listPage(lists, i)
}

// which tab a page is, or null when the page is not in the house (a record's
// page and the install review are the silo's own, without the row)
export function systemTabOf(page: Page | null, silos: readonly SiloDescriptor[]): string | null {
  if (page?.kind === 'system') return 'vitals'
  if (page?.kind === 'files') return 'files'
  if (page?.kind === 'vault') return 'vault'
  if (page?.kind !== 'silo' || page.id !== SYSTEM_SILO || page.recordKey || page.review) return null
  const lists = systemSilo(silos)?.lists ?? []
  const l = page.view ? lists.find((x) => x.id === page.view) : lists[0]
  return l ? `list:${l.id}` : null
}

export function inSystemHouse(page: Page | null): boolean {
  return page?.kind === 'system' || page?.kind === 'files' || page?.kind === 'vault' || (page?.kind === 'silo' && page.id === SYSTEM_SILO)
}

// where the rail's door lands: the house's first tab
export function systemLanding(silos: readonly SiloDescriptor[]): Page {
  return systemTabs(silos)[0]!.page
}
