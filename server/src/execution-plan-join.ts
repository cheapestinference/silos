// execution-plan-join.ts — where a plan document lives, independent of the
// checkout it was read from. A team plan's "Execute <doc>" task names the doc
// from the project's main folder (`source`: docs/plans/x.md), while the SDD
// ledger that records its execution usually sits in a worktree
// (<main>/.worktrees/w1/.superpowers/sdd/x/progress.md) and resolves the doc
// inside that worktree. Both are the same doc: same main checkout, same path
// inside the checkout. That pair is the join key.
//
// Read-only and lexical where it can be: a worktree that was merged and
// removed no longer has a .git file to read, so the `.worktrees/<name>`
// convention (the one this product's worktrees use) keys it instead.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

export interface CheckoutKey {
  main: string
  rel: string
}

const WORKTREES_SEG = `${sep}.worktrees${sep}`

// The directory holding `.git` (a dir in a main checkout, a file in a
// worktree), walking up from the path. null when no checkout contains it.
function checkoutRootOf(path: string): string | null {
  let dir = dirname(path)
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

// A worktree's `.git` file says `gitdir: <main>/.git/worktrees/<name>`; the
// main checkout is what precedes `/.git/`. A main checkout is itself.
export function mainCheckoutOf(root: string): string {
  try {
    const dotGit = join(root, '.git')
    if (statSync(dotGit).isDirectory()) return root
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))
    const gitdir = m?.[1]?.trim()
    const i = gitdir ? gitdir.indexOf(`${sep}.git${sep}`) : -1
    return i > 0 ? gitdir!.slice(0, i) : root
  } catch {
    return root
  }
}

/** The main checkout and every live worktree registered under it. */
export function checkoutsOf(main: string): string[] {
  const out = [main]
  try {
    for (const name of readdirSync(join(main, '.git', 'worktrees'))) {
      try {
        const gitdir = readFileSync(join(main, '.git', 'worktrees', name, 'gitdir'), 'utf8').trim()
        const wt = dirname(gitdir) // gitdir names <wt>/.git
        if (wt !== main && existsSync(wt)) out.push(wt)
      } catch {
        /* a half-removed worktree: skip */
      }
    }
  } catch {
    /* no worktrees dir */
  }
  return out
}

export function checkoutKeyOf(path: string): CheckoutKey | null {
  // a worktree under the convention keys lexically — alive or gone
  const w = path.indexOf(WORKTREES_SEG)
  if (w > 0) {
    const after = path.slice(w + WORKTREES_SEG.length)
    const slash = after.indexOf(sep)
    if (slash > 0)
      return {
        main: path.slice(0, w),
        rel: after
          .slice(slash + 1)
          .split(sep)
          .join('/'),
      }
  }
  const root = checkoutRootOf(path)
  if (root === null) return null
  const rel = relative(root, path)
  if (rel === '' || rel.startsWith('..')) return null
  return { main: mainCheckoutOf(root), rel: rel.split(sep).join('/') }
}

export function sameKey(a: CheckoutKey | null, b: CheckoutKey | null): boolean {
  return a !== null && b !== null && a.main === b.main && a.rel === b.rel
}

/** The ledger files a checkout can hold: one per plan. */
export function ledgersIn(root: string): string[] {
  const sdd = join(root, '.superpowers', 'sdd')
  const out: string[] = []
  try {
    for (const d of readdirSync(sdd, { withFileTypes: true })) {
      if (d.isDirectory() && existsSync(join(sdd, d.name, 'progress.md'))) out.push(join(sdd, d.name, 'progress.md'))
    }
  } catch {
    /* no sdd dir */
  }
  return out
}
