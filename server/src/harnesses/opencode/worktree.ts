// harnesses/opencode/worktree — the worktree OpenCode computes for a
// process started in `cwd`, which its `edit` permission patterns are
// relative to (fence.ts). Verified in the 1.14.22 embedded source
// (Project.fromDirectory + Instance.provide: the instance worktree is the
// project's `sandbox`):
//   · walk up from cwd for `.git` (a directory, or a file in a linked
//     worktree / submodule); none → "/";
//   · found → its directory m; with git installed and a repo that has a
//     commit, `git rev-parse --show-toplevel` run in m — which is m itself
//     for every ordinary layout (m holds the `.git`).
// So: the directory holding the nearest `.git`, else "/". Pure fs, no git
// spawn.

import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export function worktreeOf(cwd: string): string {
  // OpenCode sees the real path (process.cwd() resolves symlinks)
  let dir: string
  try {
    dir = realpathSync(cwd)
  } catch {
    dir = resolve(cwd)
  }
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const up = dirname(dir)
    if (up === dir) return '/'
    dir = up
  }
}
