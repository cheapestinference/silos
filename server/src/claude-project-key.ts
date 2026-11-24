// claude-project-key.ts — which entry of the operator's ~/.claude.json
// `projects` map describes a folder. Claude Code (verified 2.1.316) keys
// that map by the folder's CANONICAL GIT ROOT: inside a repo, the repo's
// top level — for a linked worktree, the MAIN checkout's top level (the
// directory holding the common .git) —; outside any repo, the folder
// itself. So a conversation started in <repo>/web reads the entry keyed at
// <repo>, and a worktree of <repo> reads <repo>'s too. Looking the folder up
// by its own path showed a server the operator had disabled as active, and
// left the operator's per-project servers out.
//
// Display only: ~/.claude.json is the operator's file, READ, never written
// (invariant 3). Every reader of a per-project entry goes through
// claudeJsonProjectOf, so none of them looks the folder up its own way.
// git is asked once per call (callers compute the entry once and reuse it);
// a missing git binary, a folder that isn't there, or a timeout fall back to
// the folder's own path — never a throw.
import { execFileSync } from 'node:child_process'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { canonicalFolder } from './folder-identity.js'

function withoutGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) if (!k.startsWith('GIT_')) out[k] = v
  return out
}

/** The folder's canonical git root as Claude Code computes it, or null when
 *  the folder is in no repo (or git can't say). */
export function canonicalGitRoot(folder: string): string | null {
  let out: string
  try {
    out = execFileSync('git', ['-C', folder, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
      // an inherited GIT_DIR / GIT_WORK_TREE (a server started from a git
      // hook) would answer for THAT repo, not the folder's
      env: { ...withoutGitEnv(process.env), GIT_OPTIONAL_LOCKS: '0' },
    })
  } catch {
    return null
  }
  const [common, top] = out.split('\n').map((l) => l.trim())
  if (!common || !isAbsolute(common)) return null
  // a normal checkout or a linked worktree: the common dir is <main>/.git,
  // and the main checkout is its parent; anything else (a submodule's
  // modules dir, a bare repo) keys at the work tree's own top level
  const root = basename(common) === '.git' ? dirname(common) : top
  return root && isAbsolute(root) ? canonicalFolder(root) : null
}

/** The keys to try. Inside a repo: ONLY the canonical git root — Claude
 *  Code 2.1.316 reads nothing else there, so an entry under a subfolder's
 *  own path is stale and never applies (fourth review round: answering it
 *  showed a disable list Claude ignores). Outside any repo (or when git
 *  can't say): the folder itself, realpath before the path as given.
 *  Deduplicated. */
export function claudeJsonProjectKeys(folder: string): string[] {
  const root = canonicalGitRoot(folder)
  if (root) return [root]
  const out: string[] = []
  for (const k of [canonicalFolder(folder), resolve(folder), folder]) {
    if (k && !out.includes(k)) out.push(k)
  }
  return out
}

type Json = Record<string, unknown>
const asObject = (v: unknown): Json | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null)
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

/** The folder's per-project entry inside a parsed ~/.claude.json, or null.
 *  Keys are data: looked up by OWN property only. */
export function claudeJsonProjectOf(claudeJson: unknown, folder: string): Json | null {
  const projects = asObject(asObject(claudeJson)?.projects)
  if (!projects) return null
  for (const k of claudeJsonProjectKeys(folder)) {
    const p = own(projects, k) ? asObject(projects[k]) : null
    if (p) return p
  }
  return null
}
