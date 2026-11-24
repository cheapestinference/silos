// home-tiles.ts — Home's lists open in Sheets (components/Sheet.tsx) from
// their doors: the Needs you list's head counts (its rows by kind), a
// project's tiles. The web's tests reach a list the way the owner does: wait
// for its door, click it, and read inside the sheet.
import { afterEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { useStore } from '../src/store'

// an open sheet lives in the store (it rides the URL): one test's sheet never
// opens over the next test's board
afterEach(() => useStore.setState({ homeSheet: null }))

// the first of these doors on screen, once it is one (a tile with nothing
// to open is a <div>)
export async function openableTile(...testIds: string[]): Promise<HTMLElement> {
  return waitFor(() => {
    for (const id of testIds) {
      const door = screen.queryByTestId(id)
      if (door && door.tagName === 'BUTTON') return door
    }
    throw new Error(`${testIds.join(' / ')} has nothing to open yet`)
  })
}

// click a door and return the sheet it opened
export async function openSheet(doorTestIds: string | string[], sheetTestId: string): Promise<HTMLElement> {
  fireEvent.click(await openableTile(...(Array.isArray(doorTestIds) ? doorTestIds : [doorTestIds])))
  return screen.findByTestId(sheetTestId)
}

// the Needs you list: the head's door, then the sheet's region of rows
export async function openNeedsYou(): Promise<HTMLElement> {
  const sheet = await openSheet('needs-you-all', 'sheet-needs-you')
  return within(sheet).getByRole('region', { name: 'Needs you' })
}

// your own tasks, plans grouped by project (a region per project): the
// head's count, or the foot's line when only the quiet lines are yours
export async function openYours(): Promise<HTMLElement> {
  return openSheet(['yours-all', 'yours-more'], 'sheet-yours')
}
