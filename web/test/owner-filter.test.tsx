// owner-filter.test.tsx — the ONE scope filter (spec scope-ui-review §3.3):
// origin-filter.ts (chips per group head, counts under the other row's
// choice) and OriginFilter (the «From» row: a radio row, a chip narrows to
// its group, the chosen one again or «All» clears it). Behaviour, not words.
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { OriginFilter } from '../src/components/OwnerFilter'
import { fromOrigin, originTally, pickOrigin, showsOriginRow } from '../src/lib/origin-filter'

interface R {
  name: string
  group: string
  off?: boolean
}
const rows: R[] = [
  { name: 'a', group: 'project' },
  { name: 'b', group: 'project', off: true },
  { name: 'c', group: 'you' },
  { name: 'd', group: 'account:sam@example.com', off: true },
  { name: 'e', group: 'account:kim@example.com' },
]
const groupOf = (r: R): string => r.group
const order = (a: string, b: string): number => a.localeCompare(b)

describe('origin-filter', () => {
  it("one chip per head: two logins make two chips; counts are the heads' counts", () => {
    const t = originTally(rows, groupOf, order)
    expect(t.all).toBe(5)
    expect(t.chips.map((c) => c.group)).toEqual(['account:kim@example.com', 'account:sam@example.com', 'project', 'you'])
    expect(t.chips.find((c) => c.group === 'project')!.n).toBe(fromOrigin(rows, groupOf, 'project').length)
  })

  it('under an «Only» choice every chip counts what its head then shows; the chosen origin stays, even at 0', () => {
    const only = rows.filter((r) => r.off)
    const t = originTally(only, groupOf, order, 'you')
    for (const c of t.chips) expect(c.n).toBe(fromOrigin(only, groupOf, c.group).length)
    expect(t.chips.find((c) => c.group === 'you')!.n).toBe(0)
    expect(t.all).toBe(2)
  })

  it('one origin in the list: no row', () => {
    expect(
      showsOriginRow(
        originTally(
          rows.filter((r) => r.group === 'project'),
          groupOf,
          order,
        ),
      ),
    ).toBe(false)
    expect(showsOriginRow(originTally(rows, groupOf, order))).toBe(true)
  })

  it('a chip narrows to its group; the chosen one again, or «All», clears it', () => {
    expect(fromOrigin(rows, groupOf, 'you').map((r) => r.name)).toEqual(['c'])
    expect(fromOrigin(rows, groupOf, null)).toHaveLength(5)
    expect(pickOrigin(null, 'you')).toBe('you')
    expect(pickOrigin('you', 'you')).toBeNull()
    expect(pickOrigin('you', null)).toBeNull()
    expect(pickOrigin('you', 'project')).toBe('project')
  })
})

function Harness() {
  const [v, setV] = useState<string | null>(null)
  return (
    <>
      <OriginFilter tally={originTally(rows, groupOf, order)} labelOf={(g) => g} value={v} onChange={setV} />
      <ul aria-label="list">
        {fromOrigin(rows, groupOf, v).map((r) => (
          <li key={r.name}>{r.name}</li>
        ))}
      </ul>
    </>
  )
}

describe('OriginFilter', () => {
  it('a radio row: All first, then one per head; a click narrows the list, the same click clears it', () => {
    render(<Harness />)
    const from = within(screen.getByRole('radiogroup', { name: 'From' }))
    expect(from.getAllByRole('radio')).toHaveLength(5)
    expect(from.getByRole('radio', { name: /^All/ })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(from.getByRole('radio', { name: /^project/ }))
    expect(from.getByRole('radio', { name: /^project/ })).toHaveAttribute('aria-checked', 'true')
    expect(
      within(screen.getByRole('list', { name: 'list' }))
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['a', 'b'])
    fireEvent.click(from.getByRole('radio', { name: /^project/ }))
    expect(from.getByRole('radio', { name: /^All/ })).toHaveAttribute('aria-checked', 'true')
    expect(within(screen.getByRole('list', { name: 'list' })).getAllByRole('listitem')).toHaveLength(5)
  })
})
