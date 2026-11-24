// file-sheet.test.ts — a file is a sheet over the page you are in, never a
// change of place: ?file=<path> rides any page, is a stop of
// its own (Back closes it), and no page but the rail falls into Files mode.
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { contextKey, intentToSnapshot, routeToState, stateToRoute } from '../src/lib/routes'

const F = '/home/user/proj/plans/launch.plan.json'
const q = `file=${encodeURIComponent(F)}`

describe('?file= rides any page', () => {
  const places = [
    '/',
    '/?sheet=needs-you',
    '/tasks',
    '/tasks?view=open&plan=folder%3Ax%2Fy',
    '/task/p/t1',
    '/project/%2Fhome%2Fuser%2Fproj',
    '/agent/ana',
    '/agent/ana/c/f/s1',
    '/map',
    '/settings/silos',
    '/automation/new?agent=ana',
  ]
  for (const place of places) {
    const withFile = `${place}${place.includes('?') ? '&' : '?'}${q}`
    it(`${withFile} round-trips and keeps its place`, () => {
      const i = routeToState(withFile)
      expect(i.file).toBe(F)
      expect(stateToRoute(intentToSnapshot(i))).toBe(withFile)
      // the place under the sheet is the same place
      expect(stateToRoute({ ...intentToSnapshot(i), file: null })).toBe(place)
    })
    it(`${place}: opening the file is a stop (push), so Back closes it`, () => {
      expect(contextKey(withFile)).not.toBe(contextKey(place))
    })
  }
  it('Files mode carries its own file as ?path= and takes no sheet', () => {
    const i = routeToState(`/files?path=${encodeURIComponent(F)}&${q}`)
    expect(i.file).toBeUndefined()
    expect(stateToRoute({ ...intentToSnapshot(i), file: F })).toBe(`/files?path=${encodeURIComponent(F)}`)
  })
})

// the class, not one button: a page that opens a file navigates nowhere — it
// calls openFileViewer. Only the rail's explorer and the sheet's own «Open in
// Files» door enter Files mode on purpose.
describe('no page falls into Files mode', () => {
  const ALLOWED = new Set(['components/Sidebar.tsx', 'components/FileViewer.tsx', 'components/FilesPage.tsx'])
  const src = join(import.meta.dirname, '..', 'src')
  const files: string[] = []
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.tsx?$/.test(n) && !/\.test\./.test(n)) files.push(p)
    }
  }
  walk(src)
  it("changePage({ kind: 'files' … }) only from the rail and the sheet", () => {
    const offenders = files
      .filter((p) => /kind:\s*'files'\s*,\s*path/.test(readFileSync(p, 'utf8')))
      .map((p) => relative(src, p))
      .filter((p) => !ALLOWED.has(p) && !p.startsWith('lib/'))
    expect(offenders).toEqual([])
  })
})
