// server/test/execution-plan-join.test.ts — the checkout key a document is
// joined by: (main checkout, path inside the checkout), so a doc executed in
// a worktree is the doc a task names from the main folder. The join itself
// is the kernel kind `execution`'s document edge (silo-executions.test.ts).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkoutKeyOf } from '../src/execution-plan-join.js'

let main: string
beforeEach(() => {
  main = realpathSync(mkdtempSync(join(tmpdir(), 'silos-main-')))
  mkdirSync(join(main, '.git', 'worktrees'), { recursive: true })
  mkdirSync(join(main, 'docs', 'plans'), { recursive: true })
  writeFileSync(join(main, 'docs', 'plans', 'x.md'), '# X\n### Task 1: a\n### Task 2: b\n### Task 3: c\n')
})
afterEach(() => {
  rmSync(main, { recursive: true, force: true })
})

// a worktree the way `git worktree add` lays it out: <wt>/.git is a file
// naming <main>/.git/worktrees/<name>, whose gitdir file points back.
function worktree(name: string): string {
  const wt = join(main, '.worktrees', name)
  mkdirSync(join(wt, 'docs', 'plans'), { recursive: true })
  writeFileSync(join(wt, 'docs', 'plans', 'x.md'), '# X\n### Task 1: a\n### Task 2: b\n### Task 3: c\n')
  mkdirSync(join(main, '.git', 'worktrees', name), { recursive: true })
  writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', name)}\n`)
  writeFileSync(join(main, '.git', 'worktrees', name, 'gitdir'), `${join(wt, '.git')}\n`)
  return wt
}

describe('checkoutKeyOf', () => {
  it('names a path by its main checkout and its place inside the checkout', () => {
    const wt = worktree('w1')
    expect(checkoutKeyOf(join(main, 'docs', 'plans', 'x.md'))).toEqual({ main, rel: 'docs/plans/x.md' })
    expect(checkoutKeyOf(join(wt, 'docs', 'plans', 'x.md'))).toEqual({ main, rel: 'docs/plans/x.md' })
  })
  it('a worktree that is gone still keys by the .worktrees convention', () => {
    expect(checkoutKeyOf(join(main, '.worktrees', 'gone', 'docs', 'plans', 'x.md'))).toEqual({ main, rel: 'docs/plans/x.md' })
  })
  it('a path in no checkout has no key', () => {
    const loose = mkdtempSync(join(tmpdir(), 'silos-loose-'))
    try {
      expect(checkoutKeyOf(join(loose, 'x.md'))).toBeNull()
    } finally {
      rmSync(loose, { recursive: true, force: true })
    }
  })
})
