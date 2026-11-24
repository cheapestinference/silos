// contained-dir.ts — the one way Silos creates (or finds) a directory it is
// about to write into under a folder it does not own outright: a managed
// project folder (context/, .claude/skills, .claude/settings.local.json) or
// an agent's state folder. Fourth review round: ContextService.save checked
// containment against the UNRESOLVED path when the scope dir didn't exist
// yet, then mkdirSync followed a symlinked `context/` — with
// <F>/context → /outside the first upload wrote /outside/shared/x.
//
// The rule, for the whole class: walk the components one by one from the
// root's REAL path. An existing component that is a symlink is followed only
// when its real path stays inside the root (a link within the folder is the
// folder's own business); one that leads outside — or is broken, or is not a
// directory — refuses the write in plain words. A missing component is
// created (when asked) with a plain non-recursive mkdir under a directory
// already proven real and inside, so nothing is ever created through a link.
// The returned path is real: the caller writes there, never through the
// lexical path it started from.
import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'

export class ContainmentError extends Error {}

const inside = (root: string, p: string): boolean => p === root || p.startsWith(root + sep)

/**
 * The real path of `root/<segments…>`, every existing component checked.
 * `create`: make the missing components (the root too, when it is missing);
 * otherwise a missing component answers null (nothing there to act on).
 */
export function containedDir(root: string, segments: readonly string[], opts: { create: boolean; mode?: number }): string | null {
  let rootReal: string
  try {
    rootReal = realpathSync(root)
  } catch {
    if (!opts.create) return null
    mkdirSync(root, { recursive: true, ...(opts.mode !== undefined ? { mode: opts.mode } : {}) })
    rootReal = realpathSync(root)
  }
  return walkFrom(rootReal, root, segments, opts)
}

// The walk below an ALREADY-REAL root path: never re-resolves the root (a
// second realpath of it could land somewhere else if it was swapped).
function walkFrom(rootReal: string, root: string, segments: readonly string[], opts: { create: boolean; mode?: number }): string | null {
  let cur = rootReal
  const walked: string[] = []
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..' || seg.includes('/') || seg.includes('\\'))
      throw new ContainmentError(`invalid path segment ${JSON.stringify(seg)}`)
    walked.push(seg)
    const next = join(cur, seg)
    const said = walked.join('/')
    let st
    try {
      st = lstatSync(next)
    } catch {
      st = null
    }
    if (st === null) {
      if (!opts.create) return null
      try {
        mkdirSync(next, opts.mode !== undefined ? { mode: opts.mode } : undefined)
      } catch (err) {
        // created meanwhile: checked like any existing component below
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        st = lstatSync(next)
      }
      if (st === null) {
        cur = next
        continue
      }
    }
    if (st.isSymbolicLink()) {
      let real: string
      try {
        real = realpathSync(next)
      } catch {
        throw new ContainmentError(`${said} is a broken link in ${root} — Silos won't write through it`)
      }
      if (!inside(rootReal, real)) throw new ContainmentError(`${said} is a link that leads outside ${root} (to ${real}) — Silos won't write through it`)
      if (!statSync(real).isDirectory()) throw new ContainmentError(`${said} in ${root} is not a directory`)
      cur = real
      continue
    }
    if (!st.isDirectory()) throw new ContainmentError(`${said} in ${root} is not a directory`)
    cur = next
  }
  return cur
}

/**
 * An agent's own state dir `<base>/<agentId>/<segments…>` — the root is the
 * AGENT's dir, never the whole base: a link an agent plants in its state
 * that points into ANOTHER agent's state is outside its root and refuses
 * (fifth review round — with the whole base as root, alice/inbox →
 * ../bob/inbox was "inside" and an agent could read and mark bob's
 * messages through its own API routes). The agent's dir itself must be a
 * real directory, never a link.
 */
export function containedAgentDir(base: string, agentId: string, segments: readonly string[], opts: { create: boolean; mode?: number }): string | null {
  const agentRoot = containedDir(base, [agentId], opts)
  if (agentRoot === null) return null
  let baseReal: string
  try {
    baseReal = realpathSync(base)
  } catch {
    return null
  }
  const expected = join(baseReal, agentId)
  if (lstatSync(join(base, agentId)).isSymbolicLink() || agentRoot !== expected) {
    throw new ContainmentError(`${agentId}'s state in ${base} is a link — Silos won't read or write through it`)
  }
  // walked from the verified path itself — not re-resolved (sixth review
  // round: a second containedDir re-realpath'd the agent root, so a swap in
  // between landed in another agent's state) — and the answer must still
  // sit under it; safe-file.ts then re-verifies it at the use
  const out = walkFrom(expected, join(base, agentId), segments, opts)
  if (out !== null && !inside(expected, out)) throw new ContainmentError(`${agentId}'s state in ${base} moved while Silos was using it`)
  return out
}
