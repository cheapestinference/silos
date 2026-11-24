// context-service.ts — "the agent's REAL context": files you upload for the
// agent to READ with its tools (Read/Grep), placed under its working
// folder (cwd) so they're readable with relative paths.
//
// Three scopes, chosen via a selector in the UI:
//   - shared  → <folder>/context/shared/    (seen by ALL agents in that
//               folder — builder/finance/dev share a cwd, share this)
//   - agent   → <folder>/context/<id>/       (private to that agent)
//   - conversation → <folder>/context/<id>/conversations/<thread id>/
//               (what the owner gave ONE conversation — its whole thread).
//               Only the server names that folder: the
//               thread id is resolved from a session id (task-threads.ts
//               makeThreadIdOf), and `conversations` is a reserved name
//               inside context/<id>/ — the agent's own listing never walks it.
//
// SECURITY — unlike file-service (which reads ANY absolute path: auth is
// its boundary), this DOES have strict containment: upload/delete are
// operations SCOPED to the agent folder's context/ subfolder. The name is
// reduced to a basename (never paths, never `..`) and the real destination
// is verified to fall INSIDE the root via realpath (symlinks included). An
// agent with no folder (master/Anywhere) has no context: callers guard for it.
import { existsSync, linkSync, lstatSync, readdirSync, statSync, realpathSync, unlinkSync } from 'node:fs'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { removeContained, writeContained } from './safe-file.js'
import { classifyFile, FileError, type FileKind } from './file-service.js'
import { registeredHarnesses } from './harnesses/registry.js'
import { containedDir, ContainmentError } from './contained-dir.js'
import { THREAD_ID_RE } from './context-news.js'

export type ContextScope = 'shared' | 'agent' | 'conversation'
// 'own' = the agent's own state folder ($SILOS_AGENT_STATE) — what it
// produced; never an upload/delete target (only shared/agent are).
export type ContextFileScope = ContextScope | 'own'

export interface ContextFile {
  name: string // the basename
  rel: string // the path relative to the scope root, '/'-separated (e.g. analysis/16-audit.md)
  path: string // the real absolute path — what the viewer (/api/file) requests to view/download
  folder: string // the territory (project folder) — or the state folder for 'own'
  scope: ContextFileScope
  size: number
  mtime: number
  kind: FileKind
}

const CONTEXT_DIR = 'context'
// Deliverables live at any depth (context/<agent>/analysis/…): the walk
// goes this deep and stops at this many files — a listing, never a crawl.
export const WALK_DEPTH = 4
const WALK_CAP = 200
// Every entry visited (files AND directories) costs one stat: a tree of
// thousands of empty folders must not turn a listing into a crawl.
const WALK_STAT_BUDGET = 2000
// What Silos itself keeps in an agent's state folder — never "produced":
// its own files plus every entry a harness's plugin writes there
// (Harness.traits.agentStateDirs). Applied at the top level only. A function,
// not a const: the registry is filled after this module is evaluated.
const PRODUCED_FIXED = ['runmode.json', 'status.json', 'status.log.jsonl', 'watch-state.json', 'token', 'inbox', 'asks', 'births', 'support']
export function producedExclude(): ReadonlySet<string> {
  return new Set([...PRODUCED_FIXED, ...registeredHarnesses().flatMap((h) => h.traits.agentStateDirs)])
}
const SHARED = 'shared'
// the reserved first-level name inside context/<agent>/ that holds one
// folder per conversation thread
export const CONVERSATIONS = 'conversations'
// The heading both engines use for files that landed since the agent's
// last turn (exported: the console hook prints the same words).
export const CONTEXT_NEWS_HEADING = 'New context files since your last turn — the owner just added them, read them if relevant:'
// The heading for files the owner gave THIS conversation since its last
// turn (the queued news, context-news.ts) — the console hook prints it too.
export const CONTEXT_GIVEN_HEADING = 'Given to this conversation since your last turn — the owner just handed you these, read them if relevant:'

// Upload cap: more generous than the inline text-view cap (2 MB) —
// reference PDFs/CSVs fit here. The viewer still serves them by stream.
export const UPLOAD_CAP = 25 * 1024 * 1024 // 25 MB

// name → a safe basename: no separators, no `.`/`..`, not empty. Any path
// attempt collapses to its last segment (or throws if that's empty).
function safeName(raw: unknown): string {
  if (typeof raw !== 'string') throw new FileError('name required', 400)
  const t = raw.trim()
  // EXPLICITLY rejects separators/traversal in the raw name — it doesn't
  // silently collapse to a basename (uploading "sub/x.md" must not
  // silently end up as plain x.md): the name is either a plain basename or invalid.
  if (t === '' || t === '.' || t === '..' || t.includes('/') || t.includes('\\')) {
    throw new FileError('invalid file name', 400)
  }
  const base = basename(t)
  if (base === '' || base === '.' || base === '..') throw new FileError('invalid file name', 400)
  // the listing never walks dot-entries (walk skip): an upload it would
  // hide says no instead of vanishing
  if (base.startsWith('.')) throw new FileError('names starting with a dot are not allowed', 400)
  return base
}

// A safe agent id to use as a folder segment (same criterion): it comes
// from the registry, but isn't trusted to be clean.
function agentSegment(agentId: string): string {
  const base = basename(agentId.trim())
  if (base === '' || base === '.' || base === '..' || base.includes('/') || base.includes('\\') || base === SHARED) {
    throw new FileError('invalid agent id for context', 400)
  }
  return base
}

// A thread id as a folder segment: a session id, never a path.
export function threadSegment(raw: unknown): string {
  if (typeof raw !== 'string' || !THREAD_ID_RE.test(raw)) throw new FileError('invalid conversation id', 400)
  return raw
}

// Rows in territory order (the order given — the primary folder first),
// then by rel inside each territory.
const byTerritoryRel =
  (folders: readonly string[]) =>
  (a: ContextFile, b: ContextFile): number =>
    a.folder === b.folder ? a.rel.localeCompare(b.rel) : folders.indexOf(a.folder) - folders.indexOf(b.folder)

// Never walked, at any level: dot-entries (`.git/` objects, save's in-flight
// `.name.tmp-*`) and node_modules — either would fill WALK_CAP with noise.
export const skipName = (name: string): boolean => name.startsWith('.') || name === 'node_modules'

export interface WalkOptions {
  // levels below the scope root to descend (0 = the root's own files only)
  maxDepth?: number
}

export interface ContextListing {
  shared: ContextFile[]
  agent: ContextFile[]
  conversation: ContextFile[]
}

export class ContextService {
  // Root of a scope inside the agent's folder. Does NOT create the folder
  // (save does that when it actually writes).
  private dir(folder: string, scope: ContextScope, agentId: string, thread?: string): string {
    if (typeof folder !== 'string' || !folder.startsWith('/')) throw new FileError('the agent has no folder', 400)
    return resolve(join(folder, CONTEXT_DIR, ...this.segments(scope, agentId, thread)))
  }

  // The path of a scope under context/: shared · <agent> ·
  // <agent>/conversations/<thread>.
  private segments(scope: ContextScope, agentId: string, thread?: string): string[] {
    if (scope === 'shared') return [SHARED]
    if (scope === 'agent') return [agentSegment(agentId)]
    return [agentSegment(agentId), CONVERSATIONS, threadSegment(thread)]
  }

  // What a listing may walk for a scope: its real dir, or nothing when that
  // dir is a link to another scope or outside the folder (the same rule the
  // writes keep — realDir) — A's list never shows B's private files.
  private listRoot(folder: string, scope: ContextScope, agentId: string, thread?: string): string {
    const lexical = this.dir(folder, scope, agentId, thread) // no folder → the honest FileError, as before
    try {
      // the check only decides WHETHER to list; the walk keeps the lexical
      // path the page and the delete route already speak (an agent whose
      // folder is itself a link keeps its paths)
      this.realDir(folder, scope, agentId, false, thread)
      return lexical
    } catch (err) {
      if (!(err instanceof FileError)) throw err
      return join(folder, CONTEXT_DIR, '.silos-refused-scope') // a path that never exists: an empty list
    }
  }

  // The REAL directory of a scope, every existing component of
  // context/<sub> checked (contained-dir.ts): a component that is a link
  // leading outside the folder refuses — never a write through it. Fourth
  // review round: the old check compared the UNRESOLVED path when the scope
  // dir didn't exist yet, and mkdirSync then followed a symlinked context/.
  private realDir(folder: string, scope: ContextScope, agentId: string, create: boolean, thread?: string): string | null {
    if (typeof folder !== 'string' || !folder.startsWith('/')) throw new FileError('the agent has no folder', 400)
    const segs = this.segments(scope, agentId, thread)
    const sub = segs.join('/')
    try {
      const real = containedDir(folder, [CONTEXT_DIR, ...segs], { create })
      if (real === null) return null
      // a scope dir is its own: context/<A> that is a link to context/<B>
      // (or to shared) stays "inside the folder" but would land A's private
      // uploads in B's — refused like a link leading outside (fifth round).
      // FULL-PATH equality: every component of a conversation's folder
      // (conversations/, conversations/<id>) must be itself, never a link
      // to another thread's
      const contextReal = containedDir(folder, [CONTEXT_DIR], { create: false })
      if (contextReal === null || real !== join(contextReal, ...segs)) {
        throw new ContainmentError(`context/${sub} in ${folder} is a link to another scope — Silos won't read or write through it`)
      }
      return real
    } catch (err) {
      if (err instanceof ContainmentError) throw new FileError(err.message, 400)
      throw err
    }
  }

  // Walks a scope root breadth-first to WALK_DEPTH levels below it, files
  // only, at most WALK_CAP of them and at most WALK_STAT_BUDGET entries
  // visited (files and directories alike). Every entry must stay inside the root
  // after realpath (a symlink that leaves it is skipped, never followed,
  // never thrown); unreadable entries are skipped too.
  // `verified`: `base` is a dir ALREADY verified as real (an agent's state
  // dir): it is the containment root as it is, never resolved again — if it
  // no longer resolves to itself (swapped for a link since), nothing is
  // listed, and every entry must still land under the verified path
  // (seventh review round: a fresh realpath here followed alice's swapped
  // dir into bob's and listed bob's files as what alice produced).
  // `skipDirs`: directory names never descended, at any depth (an agent's
  // walk never enters `conversations/` — those folders are each one
  // conversation's, never the agent's own list).
  private entriesOf(
    base: string,
    scope: ContextFileScope,
    folder: string,
    exclude?: ReadonlySet<string>,
    maxDepth = WALK_DEPTH,
    verified = false,
    skipDirs?: ReadonlySet<string>,
  ): ContextFile[] {
    if (!existsSync(base)) return []
    let baseReal: string
    try {
      baseReal = realpathSync(base)
    } catch {
      return []
    }
    if (verified && baseReal !== base) return []
    const out: ContextFile[] = []
    const queue: Array<[string, number]> = [[base, 0]]
    let stats = 0
    while (queue.length > 0 && out.length < WALK_CAP && stats < WALK_STAT_BUDGET) {
      const [dir, depth] = queue.shift()!
      let names: string[]
      try {
        names = readdirSync(dir).sort()
      } catch {
        continue
      }
      for (const name of names) {
        if (out.length >= WALK_CAP || stats >= WALK_STAT_BUDGET) break
        if (skipName(name)) continue
        if (depth === 0 && exclude?.has(name)) continue
        stats++
        const p = join(dir, name)
        let st, real
        try {
          real = realpathSync(p)
          st = statSync(p) // follows symlinks; skips broken entries
        } catch {
          continue
        }
        if (!(real === baseReal || real.startsWith(baseReal + sep))) continue // escapes the root
        if (st.isDirectory()) {
          if (depth < maxDepth && !skipDirs?.has(name)) queue.push([p, depth + 1])
          continue
        }
        if (!st.isFile()) continue
        out.push({
          name,
          rel: relative(base, p).split(sep).join('/'),
          path: p,
          folder,
          scope,
          size: st.size,
          mtime: st.mtimeMs,
          kind: classifyFile(extname(name)).kind,
        })
      }
    }
    return out
  }

  // Lists the files VISIBLE to an agent across every territory it works in:
  // each folder's shared ones + its own private ones (deliverables included,
  // at any depth up to `maxDepth`, default WALK_DEPTH). Sorted by territory
  // in the order given (primary first), then rel.
  // ONE folder's shared files (context/shared) — the project page's
  // «Shared with its agents», asked about the folder itself, never through
  // an agent's territories (whose primary folder may be elsewhere).
  listShared(folder: string, opts: WalkOptions = {}): ContextFile[] {
    return this.entriesOf(this.listRoot(folder, 'shared', ''), 'shared', folder, undefined, opts.maxDepth ?? WALK_DEPTH).sort(byTerritoryRel([folder]))
  }

  // `thread`: also the files given to THAT conversation (its folder in
  // every territory — it lives in one); never another thread's.
  list(folders: readonly string[], agentId: string, opts: WalkOptions & { thread?: string } = {}): ContextListing {
    const depth = opts.maxDepth ?? WALK_DEPTH
    const shared: ContextFile[] = [],
      agent: ContextFile[] = [],
      conversation: ContextFile[] = []
    for (const folder of folders) {
      shared.push(...this.entriesOf(this.listRoot(folder, 'shared', agentId), 'shared', folder, undefined, depth))
      agent.push(...this.entriesOf(this.listRoot(folder, 'agent', agentId), 'agent', folder, undefined, depth, false, SKIP_CONVERSATIONS))
      if (opts.thread !== undefined)
        conversation.push(...this.entriesOf(this.listRoot(folder, 'conversation', agentId, opts.thread), 'conversation', folder, undefined, depth))
    }
    const order = byTerritoryRel(folders)
    return { shared: shared.sort(order), agent: agent.sort(order), conversation: conversation.sort(order) }
  }

  // The threads that hold files in ONE territory: one readdir of
  // context/<agent>/conversations — real directories with an id's shape
  // only (a link is never a thread's folder). [] when there is none.
  conversationThreads(folder: string, agentId: string): string[] {
    let base: string
    try {
      const real = this.realDir(folder, 'agent', agentId, false)
      if (real === null) return []
      base = join(real, CONVERSATIONS)
      if (!lstatSync(base).isDirectory()) return []
    } catch {
      return []
    }
    let names: string[]
    try {
      names = readdirSync(base).sort()
    } catch {
      return []
    }
    return names.filter((n) => {
      if (!THREAD_ID_RE.test(n)) return false
      try {
        return lstatSync(join(base, n)).isDirectory()
      } catch {
        return false
      }
    })
  }

  // What the agent produced in its own state folder ($SILOS_AGENT_STATE),
  // minus Silos' own bookkeeping. A missing folder is an empty list.
  // `stateDir` is the VERIFIED real dir (AgentStateStore.verifiedDir): null
  // when missing or refused — the agent dir itself a link (sixth review
  // round: alice → bob listed bob's files as alice's) lists nothing.
  produced(stateDir: string | null): ContextFile[] {
    if (stateDir === null) return []
    return this.entriesOf(stateDir, 'own', stateDir, producedExclude(), WALK_DEPTH, true).sort(byTerritoryRel([stateDir]))
  }

  // Uploads (or overwrites) a context file. Atomic (tmp+rename) so a
  // failure never leaves a half-written file. Returns the file's card.
  // `thread`: the conversation's thread id (scope 'conversation' only).
  save(folder: string, scope: ContextScope, agentId: string, rawName: string, content: Buffer, thread?: string): ContextFile {
    if (content.byteLength > UPLOAD_CAP) throw new FileError('file exceeds the upload cap (25 MB)', 413)
    const base = this.dir(folder, scope, agentId, thread)
    const name = safeName(rawName)
    if (scope === 'agent') reservedAtAgentTop(name)
    // written in the scope's REAL directory (checked component by component)
    const real = this.realDir(folder, scope, agentId, true, thread)!
    const into = join(real, name)
    // safe-file.ts: a fresh temp file verified in the real dir, renamed onto
    // the name (a link at the name is replaced, never followed) — a dir
    // swapped mid-way refuses instead of writing elsewhere
    try {
      writeContained(real, name, content, { mode: 0o644 })
    } catch (err) {
      if (err instanceof ContainmentError) throw new FileError(err.message, 400)
      throw err
    }
    const st = lstatSync(into)
    return { name, rel: name, path: resolve(join(base, name)), folder, scope, size: st.size, mtime: st.mtimeMs, kind: classifyFile(extname(name)).kind }
  }

  // Deletes a context file (strict containment: the scope's real directory,
  // checked like save's). Idempotent: a no-op if it's already gone.
  remove(folder: string, scope: ContextScope, agentId: string, rawName: string, thread?: string): void {
    const name = safeName(rawName)
    const real = this.realDir(folder, scope, agentId, false, thread)
    if (real === null) return // no scope dir: nothing to delete
    // the name, never a link's target (safe-file.ts)
    try {
      removeContained(real, name)
    } catch (err) {
      if (err instanceof ContainmentError) throw new FileError(err.message, 400)
      throw err
    }
  }

  // «Give to the agent»: a file given to one conversation moves up to the
  // agent's top level — told to every conversation of the agent from then
  // on. One move of a REGULAR file (lstat: a link is never moved), refused
  // when the name already exists there (link-then-unlink: the refusal is
  // the filesystem's own, never a check a concurrent write could race).
  promote(folder: string, agentId: string, thread: string, rawName: string): ContextFile {
    const name = safeName(rawName)
    reservedAtAgentTop(name)
    const from = this.realDir(folder, 'conversation', agentId, false, thread)
    if (from === null) throw new FileError('file not found', 404)
    const src = join(from, name)
    let st
    try {
      st = lstatSync(src)
    } catch {
      throw new FileError('file not found', 404)
    }
    if (!st.isFile()) throw new FileError('only a regular file can be given to the agent', 400)
    const to = this.realDir(folder, 'agent', agentId, true)!
    const dst = join(to, name)
    try {
      linkSync(src, dst)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new FileError(`the agent already has a file named ${name}`, 409)
      throw err
    }
    unlinkSync(src)
    const now = lstatSync(dst)
    return {
      name,
      rel: name,
      path: resolve(join(this.dir(folder, 'agent', agentId), name)),
      folder,
      scope: 'agent',
      size: now.size,
      mtime: now.mtimeMs,
      kind: classifyFile(extname(name)).kind,
    }
  }

  // Note for systemPrompt.append (ChatService): tells the agent these files
  // exist and can be READ with Read when needed — without injecting their
  // content (on demand, costs no tokens). null if there's nothing.
  //
  // `newSince` (ms): files that appeared or changed AFTER that instant get a
  // "New since your last turn" section on top — the owner uploads a file
  // mid-conversation and the agent must not
  // have to be told by hand. ChatService passes its last turn per agent;
  // the console gets the same note from a UserPromptSubmit hook
  // (harnesses/claude-code/console.ts contextNewsHookCommand — same rule, same wording).
  //
  // `thread`: the conversation this note is for — its own folder (in the
  // territory `thread.folder`) is listed under «Given to this
  // conversation», with the paths the agent opens from `thread.cwd`. `news`:
  // that thread's queued lines (context-news.ts), printed on top. Never
  // another thread's folder.
  awarenessNote(folder: string, agentId: string, opts: { newSince?: number; thread?: ConversationAt; news?: readonly string[] } = {}): string | null {
    // Top-level files only: what the owner hands the agent. Deeper ones are
    // the agent's own deliverables (context/<agent>/analysis/…) — announcing
    // them as "the owner just added" would be false — and every SDK turn
    // calls this, so it never walks below the root (maxDepth 0).
    const { shared, agent } = this.list([folder], agentId, { maxDepth: 0 })
    const t = opts.thread
    const given = t ? this.list([t.folder], agentId, { maxDepth: 0, thread: t.id }).conversation : []
    const news = opts.news ?? []
    if (shared.length === 0 && agent.length === 0 && given.length === 0 && news.length === 0) return null
    const lines: string[] = ['# Context files', '']
    if (news.length > 0) {
      lines.push(CONTEXT_GIVEN_HEADING)
      for (const n of news) lines.push(`- ${n}`)
      lines.push('')
    }
    const fresh = opts.newSince === undefined ? [] : [...shared, ...agent].filter((f) => f.mtime > opts.newSince!)
    if (fresh.length > 0) {
      lines.push(CONTEXT_NEWS_HEADING)
      for (const f of fresh) lines.push(`- ${CONTEXT_DIR}/${f.scope === 'shared' ? SHARED : agentSegment(agentId)}/${f.name}`)
      lines.push('')
    }
    if (shared.length > 0 || agent.length > 0 || given.length > 0)
      lines.push('Reference files available in this workspace — read them with the Read tool when relevant (they are not preloaded):', '')
    if (shared.length > 0) {
      lines.push('Shared (all agents in this folder):')
      for (const f of shared) lines.push(`- ${CONTEXT_DIR}/${SHARED}/${f.name}`)
      lines.push('')
    }
    if (agent.length > 0) {
      lines.push('Yours (private to this agent):')
      for (const f of agent) lines.push(`- ${CONTEXT_DIR}/${agentSegment(agentId)}/${f.name}`)
      lines.push('')
    }
    if (t && given.length > 0) {
      lines.push('Given to this conversation:')
      for (const f of given) lines.push(`- ${conversationFilePath(t, agentId, f.name)}`)
    }
    return lines.join('\n').trim()
  }
}

/** One conversation, as a note or a queued line needs it: its thread id,
 *  the territory its folder lives in, and the cwd it runs from. */
export interface ConversationAt {
  id: string
  folder: string
  cwd: string
}

const SKIP_CONVERSATIONS: ReadonlySet<string> = new Set([CONVERSATIONS])

// `conversations` is the agent's reserved first-level name: a file by that
// name at its top level would stand where the threads' folders live.
function reservedAtAgentTop(name: string): void {
  if (name === CONVERSATIONS) throw new FileError(`"${CONVERSATIONS}" is a reserved name in an agent's context folder`, 400)
}

/** The path an agent opens a conversation's file by, from where it runs:
 *  relative when the file's territory IS its cwd, absolute otherwise. The
 *  start note and the queued news line say the same thing. */
export function conversationFilePath(at: ConversationAt, agentId: string, name: string): string {
  const rel = [CONTEXT_DIR, agentSegment(agentId), CONVERSATIONS, threadSegment(at.id), name].join('/')
  return resolve(at.folder) === resolve(at.cwd) ? rel : join(at.folder, rel)
}

/** The territory a conversation's folder lives in: its cwd when that is
 *  one of the agent's folders, else the agent's primary folder. */
export function conversationTerritory(territories: readonly string[], cwd: string | null | undefined): string | null {
  if (cwd && territories.some((t) => resolve(t) === resolve(cwd))) return territories.find((t) => resolve(t) === resolve(cwd))!
  return territories[0] ?? null
}
