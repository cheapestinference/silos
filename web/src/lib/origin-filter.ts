// origin-filter.ts — the ONE scope filter of a list grouped by origin (spec
// scope-ui-review §3.3): «From  All 5 · Project · acme 2 · This machine 2 …».
// One chip per group HEAD (a chip per login, one for «Silos platform»), so
// a chip's count is its head's count; the selection is a group key or none.
// The second row («Only», a condition) composes with it: each row's counts
// are taken with the OTHER row's choice applied — callers hand in the rows
// that already pass «Only» — so no number on screen contradicts the list.
// Pure.

export interface OriginChip {
  group: string
  n: number
}

export interface OriginTally {
  /** every row the list would show with no origin chosen */
  all: number
  /** one per group present, in the heads' order; the chosen one is kept even at 0 */
  chips: OriginChip[]
}

/** the chips over `rows` (top-level rows, after search and «Only») */
export function originTally<R>(
  rows: readonly R[],
  groupOf: (r: R) => string,
  order: (a: string, b: string) => number,
  from: string | null = null,
): OriginTally {
  const n = new Map<string, number>()
  for (const r of rows) {
    const g = groupOf(r)
    n.set(g, (n.get(g) ?? 0) + 1)
  }
  if (from !== null && !n.has(from)) n.set(from, 0)
  return { all: rows.length, chips: [...n].map(([group, count]) => ({ group, n: count })).sort((a, b) => order(a.group, b.group)) }
}

/** the rows of the chosen origin (none chosen: every row) */
export function fromOrigin<R>(rows: readonly R[], groupOf: (r: R) => string, from: string | null): R[] {
  return from === null ? [...rows] : rows.filter((r) => groupOf(r) === from)
}

/** one origin in the list: its head says it — no row at all */
export const showsOriginRow = (t: OriginTally): boolean => t.chips.length > 1

/** a click on a chip: the chosen one again (or «All», null) clears it */
export const pickOrigin = (current: string | null, clicked: string | null): string | null => (clicked === null || clicked === current ? null : clicked)
