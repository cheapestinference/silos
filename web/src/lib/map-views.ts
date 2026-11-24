// map-views.ts — the ONE registry of the Map's sibling views.
//
// product.md design rule: «a view that exists is reachable
// by name» — every door that names the Map's views derives from this list
// (the Map's tab row, Home's lens line, ⌘K), so the next view appears in
// all three or does not compile. Org, the fourth view, spent four days
// named nowhere outside its own page because those doors were three
// hand-written lists.
import { orgSource } from './org'
import type { SiloDescriptor } from './types'

export type MapMode = 'uses' | 'org'

export type MapViewDef = {
  id: MapMode
  /** the Map's tab */
  label: string
  /** Home's lens line word (lowercase; `map` is the landing view) */
  word: string
  /** what the view answers, in one quiet line — the word's tooltip and the ⌘K row */
  about: string
  /** present only while its data source exists — a door never leads nowhere */
  available?: (silos: readonly SiloDescriptor[]) => boolean
}

export const MAP_VIEWS: readonly MapViewDef[] = [
  // the landing view (the wiring graph retired — the Map
  // draws what was used, not what the configuration says could be)
  { id: 'uses', label: 'Uses', word: 'map', about: 'who actually used what' },
  { id: 'org', label: 'Org', word: 'org', about: 'who reports to whom', available: (silos) => orgSource(silos) !== null },
]

export function mapViewsFor(silos: readonly SiloDescriptor[]): MapViewDef[] {
  return MAP_VIEWS.filter((v) => v.available?.(silos) ?? true)
}

/** the store page a view's door navigates to — Uses is the Map itself */
export function mapPageOf(v: MapViewDef): { kind: 'map'; view?: 'org' } {
  return v.id === 'uses' ? { kind: 'map' } : { kind: 'map', view: v.id }
}
