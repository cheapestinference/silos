// doors.test.ts — every page is reachable from the interface, never by URL
// alone (product.md: every surface names where it is reached from in the
// story). This guard reads the Page union and fails on
// any kind that no component navigates to: a page whose only address is its
// URL has no door, and a new page cannot ship without one.
//
// What counts as a door: a `kind: '<name>'` literal in a component or lib
// OUTSIDE the router itself (lib/routes.ts, lib/router.ts) and the store's
// type definitions — i.e. somewhere a person can click. Legacy aliases that
// the router rewrites in place (/board, /constellation, /support) are not in
// the union, so they are not asked for a door.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '../..')

function pageKinds(): string[] {
  const src = readFileSync(join(ROOT, 'web/src/store/types.ts'), 'utf8')
  const union = src.slice(src.indexOf('export type Page ='))
  const end = union.indexOf('\n\n')
  const block = end > 0 ? union.slice(0, end) : union
  return [...block.matchAll(/kind: '([a-z-]+)'/g)].map((m) => m[1]!).filter((k, i, xs) => xs.indexOf(k) === i)
}

function doorFiles(): string[] {
  const out = execFileSync('git', ['ls-files', 'web/src'], { cwd: ROOT, encoding: 'utf8' })
  return out
    .split('\n')
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .filter((f) => f !== 'web/src/lib/routes.ts' && f !== 'web/src/lib/router.ts' && !f.startsWith('web/src/store/'))
}

describe('every page has a door in the interface', () => {
  it('each Page kind is navigated to from at least one component', () => {
    const kinds = pageKinds()
    expect(kinds.length).toBeGreaterThan(10) // the parse found the union
    const files = doorFiles()
    const texts = files.map((f) => readFileSync(join(ROOT, f), 'utf8'))
    const doorless = kinds.filter((k) => !texts.some((t) => t.includes(`kind: '${k}'`)))
    expect(doorless, `pages with no door in the UI (reachable only by URL): ${doorless.join(', ')} — add a visible way in before shipping the page`).toEqual([])
  })
})
