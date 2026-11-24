// knows-watcher.ts — the Knows Drawer's live feed: watches the memory /
// context / skills paths of every registered agent and folder and
// broadcasts a `knows` event over the existing /ws, telling the client
// WHAT changed, per folder.
//
// Watched:
//   ~/.claude/CLAUDE.md                              memory · global
//   <folder>/CLAUDE.md                               memory · project
//   ~/.claude/projects/<mungePath(folder)>/memory/   memory · auto   (*.md, top level)
//   ~/.silos/agents/<id>/memory.md                   memory · agent
//   <folder>/context/{shared,<id>}/**                context · shared | agent (as deep as the page's walk)
//   <folder>/.claude/skills/, ~/.claude/skills/      skills · project | user
//   <territory>/plans/*.plan.json                    plans · project (every territory of every agent)
//   every installed silo's convention folders        → onSiloFile (the kernel re-reads that silo)
//
// chokidar 5 can't watch a directory that doesn't exist yet (a missing
// memory/ or context/ is the common case for a fresh agent), so each target
// is watched through its nearest EXISTING ancestor — never above the
// target's own ROOT (the territory, the projects root, the data dir's
// agents/, ~/.claude) — with an `ignored` filter that only lets through
// ancestors of a target and paths inside one; when the dir appears later,
// chokidar descends into it on its own. A target whose root is missing
// watches nothing: the resync retries it every resyncMs (the cheap poll).
// Unbounded, a home directly under /tmp anchored the watch at /tmp itself
// (1.37M entries) and the process ran out of memory in ~5 min.
//
// Coalescing: events are keyed by (kind, folder); within the debounce
// window the LAST event for a key wins and is the one broadcast (a burst of
// 10 memory writes = 1 event). The registry is re-read every resyncMs so a
// newly created agent/folder starts being watched without a restart.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { watch, type FSWatcher } from 'chokidar'
import { mungePath, type AgentRegistry } from './agent-registry.js'
import { agentMemoryPath } from './memory-service.js'
import { skipName, WALK_DEPTH } from './context-service.js'
import { territoriesOf } from './territory.js'

export interface KnowsEvent {
  type: 'knows'
  folder: string // the project folder ('' for global)
  agentId?: string // only per-agent paths (context/<id>, agents/<id>/memory.md)
  kind: 'memory' | 'context' | 'skills' | 'plans'
  action: 'added' | 'changed' | 'removed'
  name: string // basename (for skills: the skill's directory name)
  scope: string // 'global'|'project'|'auto'|'agent'|'shared'|'conversation'|'user'|'plugin'
}

type Mode = 'file' | 'md-dir' | 'context' | 'skills' | 'plans'
interface Target {
  path: string
  mode: Mode
  kind: KnowsEvent['kind']
  scope: string
  folder: string
  agentId?: string
  // the broadest directory this target may be anchored at (see anchorFor)
  root: string
}

// How deep under a skills root we still care (skill/<file>, skill/<dir>/<file>).
const SKILLS_DEPTH = 3

export interface KnowsWatcherOptions {
  registry: Pick<AgentRegistry, 'list'>
  broadcast: (e: KnowsEvent) => void
  debounceMs?: number
  // Path roots — production passes cfg.home / cfg.root / cfg.dataDir; the
  // defaults are only a last resort for direct construction.
  home?: string
  projectsRoot?: string // ~/.claude/projects (its parent holds the global CLAUDE.md, as in MemoryService)
  dataDir?: string // ~/.silos
  resyncMs?: number
  // The silos' convention folders (kernel.ts watchedFolders) — the same
  // watcher covers them, so no silo ever needs one of its own. Every file
  // event inside one goes to onSiloFile with its path (never a `knows`
  // event: the kernel re-reads, and the board's silo/inbox events follow).
  siloFolders?: () => string[]
  onSiloFile?: (path: string) => void
}

// How deep under a silo's convention folder a write is still seen: the
// deepest a source's ** may reach (files-source.ts MAX_GLOB_DEPTH) plus its
// file pattern.
const SILO_DEPTH = 10

const isInside = (parent: string, p: string): boolean => p.startsWith(parent + sep)
const segmentsUnder = (parent: string, p: string): string[] => relative(parent, p).split(sep)

// Where to watch `target` from: the target itself if it exists, else its
// nearest existing ancestor — but never above `root`, the directory the
// target belongs to. A missing root (or a target outside it) = null: watch
// nothing yet.
export function anchorFor(target: string, root: string): string | null {
  if (target !== root && !isInside(root, target)) return null
  let cur = target
  for (;;) {
    if (existsSync(cur)) return cur
    if (cur === root) return null
    const up = dirname(cur)
    if (up === cur) return null
    cur = up
  }
}

export function startKnowsWatcher(opts: KnowsWatcherOptions): { close(): Promise<void>; anchors(): string[]; ready: Promise<void> } {
  const home = opts.home ?? homedir()
  const projectsRoot = opts.projectsRoot ?? join(home, '.claude', 'projects')
  const dataDir = opts.dataDir ?? join(home, '.silos')
  const debounceMs = opts.debounceMs ?? 300

  const computeTargets = (): Map<string, Target> => {
    const out = new Map<string, Target>()
    const put = (t: Target) => {
      if (!out.has(t.path)) out.set(t.path, t)
    }
    put({ path: join(dirname(projectsRoot), 'CLAUDE.md'), mode: 'file', kind: 'memory', scope: 'global', folder: '', root: dirname(projectsRoot) })
    put({ path: join(home, '.claude', 'skills'), mode: 'skills', kind: 'skills', scope: 'user', folder: '', root: join(home, '.claude') })
    for (const a of opts.registry.list()) {
      const folder = a.folder ?? ''
      const memoryPath = agentMemoryPath(dataDir, a.id)
      put({ path: memoryPath, mode: 'file', kind: 'memory', scope: 'agent', folder, agentId: a.id, root: dirname(dirname(memoryPath)) })
      // A folder that doesn't exist would anchor the watch at some far
      // ancestor (possibly /) — skipped until it exists (next resync).
      // Auto-memory lives under the munged PRIMARY cwd only.
      if (a.folder && existsSync(a.folder)) {
        put({ path: join(projectsRoot, mungePath(a.folder), 'memory'), mode: 'md-dir', kind: 'memory', scope: 'auto', folder, root: projectsRoot })
      }
      // Every territory (Agent.folders) is membership: its CLAUDE.md,
      // context/ and project skills are watched like the primary's.
      for (const raw of territoriesOf(a)) {
        const t = resolve(raw)
        if (!existsSync(t)) continue
        put({ path: join(t, 'CLAUDE.md'), mode: 'file', kind: 'memory', scope: 'project', folder: t, root: t })
        put({ path: join(t, 'context'), mode: 'context', kind: 'context', scope: 'shared', folder: t, root: t })
        put({ path: join(t, '.claude', 'skills'), mode: 'skills', kind: 'skills', scope: 'project', folder: t, root: t })
        // Team plans: one target per distinct territory across all agents
        // (put() dedupes by path); folder = the normalised territory.
        put({ path: join(t, 'plans'), mode: 'plans', kind: 'plans', scope: 'project', folder: t, root: t })
      }
    }
    return out
  }

  let targets = computeTargets()
  const computeSiloFolders = (): string[] => {
    try {
      return [...new Set((opts.siloFolders?.() ?? []).map((p) => resolve(p)))]
    } catch {
      return []
    }
  }
  let siloFolders = computeSiloFolders()
  // A silo's record folder lives under Silos' data dir (agent-state) or in a
  // managed project folder: the narrowest of those that holds it is its root,
  // never anything above. Outside both, the folder is its own root (watched
  // once it exists; the resync picks it up).
  const siloRootOf = (d: string): string => {
    const homes = [resolve(dataDir), ...opts.registry.list().flatMap((a) => territoriesOf(a).map((t) => resolve(t)))]
    const holders = homes.filter((h) => d === h || isInside(h, d))
    return holders.sort((a, b) => b.length - a.length)[0] ?? d
  }
  const inSiloFolder = (p: string): boolean => siloFolders.some((d) => p === d || isInside(d, p))

  // Paths chokidar may walk: ancestors of a target (to reach it once it
  // exists), the target itself, and what's inside it up to its mode's depth.
  const wanted = (p: string): boolean => {
    for (const d of siloFolders) {
      if (p === d || isInside(p, d)) return true // an ancestor on the way to it
      if (!isInside(d, p)) continue
      const segs = segmentsUnder(d, p)
      if (segs.length <= SILO_DEPTH && !segs.some((s) => s.startsWith('.') || s === 'node_modules')) return true
    }
    for (const t of targets.values()) {
      if (p === t.path || isInside(p, t.path)) return true
      if (!isInside(t.path, p)) continue
      const depth = segmentsUnder(t.path, p).length
      if ((t.mode === 'md-dir' || t.mode === 'plans') && depth === 1) return true
      // context/<scope>/ plus the walk's depth of folders below it — the
      // same tree the agent page lists (dot-entries and node_modules never).
      if (t.mode === 'context') return depth <= 2 + WALK_DEPTH && !segmentsUnder(t.path, p).some(skipName)
      if (t.mode === 'skills' && depth <= SKILLS_DEPTH) return true
    }
    return false
  }

  const classify = (fsEvent: string, p: string): KnowsEvent | null => {
    const name = basename(p)
    if (name.startsWith('.')) return null // atomic-write temps (.x.tmp-…) and dotfiles
    const action: KnowsEvent['action'] | null =
      fsEvent === 'add' || fsEvent === 'addDir'
        ? 'added'
        : fsEvent === 'change'
          ? 'changed'
          : fsEvent === 'unlink' || fsEvent === 'unlinkDir'
            ? 'removed'
            : null
    if (!action) return null
    const isDir = fsEvent === 'addDir' || fsEvent === 'unlinkDir'
    const base = { type: 'knows' as const }
    for (const t of targets.values()) {
      if (t.mode === 'file') {
        if (p !== t.path || isDir) continue
        return { ...base, folder: t.folder, ...(t.agentId ? { agentId: t.agentId } : {}), kind: t.kind, action, name, scope: t.scope }
      }
      if (!isInside(t.path, p)) continue
      const segs = segmentsUnder(t.path, p)
      if (t.mode === 'md-dir') {
        if (isDir || segs.length !== 1 || !name.endsWith('.md')) return null
        return { ...base, folder: t.folder, kind: t.kind, action, name, scope: t.scope }
      }
      if (t.mode === 'plans') {
        if (isDir || segs.length !== 1 || !name.endsWith('.plan.json')) return null
        return { ...base, folder: t.folder, kind: 'plans', action, name, scope: t.scope }
      }
      if (t.mode === 'context') {
        if (isDir || segs.length < 2 || segs.length > 2 + WALK_DEPTH || segs.some(skipName)) return null
        const sub = segs[0]!
        // Named by its path under the scope dir, as the page's rows are.
        const rel = segs.slice(1).join('/')
        if (sub === 'shared') return { ...base, folder: t.folder, kind: 'context', action, name: rel, scope: 'shared' }
        // context/<id>/conversations/<thread>/… is ONE conversation's, never
        // the agent's own: the same context event, its
        // own scope, named under the thread's folder
        if (segs[1] === 'conversations' && segs.length >= 4)
          return { ...base, folder: t.folder, agentId: sub, kind: 'context', action, name: segs.slice(3).join('/'), scope: 'conversation' }
        return { ...base, folder: t.folder, agentId: sub, kind: 'context', action, name: rel, scope: 'agent' }
      }
      // skills: named by the skill's directory. The dir itself or its
      // SKILL.md appearing/disappearing is added/removed; anything else
      // inside is a change to that skill.
      const skill = segs[0]!
      if (skill.startsWith('.') || segs.some((s) => s.startsWith('.'))) return null
      const structural = segs.length === 1 || (segs.length === 2 && name === 'SKILL.md')
      return { ...base, folder: t.folder, kind: 'skills', action: structural ? action : 'changed', name: skill, scope: t.scope }
    }
    return null
  }

  const pending = new Map<string, { event: KnowsEvent; timer: NodeJS.Timeout }>()
  let closed = false
  const onFs = (fsEvent: string, p: string): void => {
    if (closed) return
    if (opts.onSiloFile && fsEvent !== 'addDir' && inSiloFolder(p) && !basename(p).startsWith('.') && !p.endsWith('.tmp')) {
      try {
        opts.onSiloFile(p)
      } catch (err) {
        console.warn('knows-watcher: a silo listener failed —', err instanceof Error ? err.message : String(err))
      }
    }
    const event = classify(fsEvent, p)
    if (!event) return
    const key = `${event.kind}\0${event.folder}`
    const prev = pending.get(key)
    if (prev) clearTimeout(prev.timer)
    pending.set(key, {
      event,
      timer: setTimeout(() => {
        pending.delete(key)
        if (!closed) opts.broadcast(event)
      }, debounceMs),
    })
  }

  // Watched anchors, only ever added. Never unwatch(): chokidar puts an
  // unwatched path (and everything under it) on its ignore list for EVERY
  // anchor, so dropping a removed agent's anchor could silence a live one
  // nested under it. A removed target just stops matching wanted/classify;
  // its handle lingers until restart (cheap). A deleted-then-recreated
  // anchor is picked back up by chokidar itself (tested).
  const anchored = new Set<string>() // target paths already covered
  const watched = new Set<string>()
  const watcher: FSWatcher = watch([], {
    ignoreInitial: true,
    ignored: (p: string) => !wanted(p),
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 },
  })
  // CRITICAL: without an 'error' listener chokidar throws and takes down the process.
  watcher.on('error', (err) => {
    console.warn('knows-watcher: error —', err instanceof Error ? err.message : String(err))
  })
  watcher.on('all', onFs)
  // settles once chokidar has scanned the first anchors (its one 'ready');
  // a write after it is seen. Nothing to watch yet: settled at once.
  let initialAnchors = 0
  const ready = new Promise<void>((done) => {
    watcher.once('ready', () => done())
    queueMicrotask(() => {
      if (initialAnchors === 0) done()
    })
  })

  const sync = (): number => {
    const add: string[] = []
    // every target keeps its root (never climb above it — a root under /tmp
    // once walked all of /tmp); a silo's record folder is rooted at the
    // narrowest known home that holds it (siloRootOf), so a folder not created
    // yet is watched from there and caught the moment it appears
    const wantedPaths: Array<[string, string]> = [
      ...[...targets].map(([path, t]): [string, string] => [path, t.root]),
      ...siloFolders.map((d): [string, string] => [d, siloRootOf(d)]),
    ]
    for (const [path, root] of wantedPaths) {
      if (anchored.has(path)) continue
      const anchor = anchorFor(path, root)
      if (!anchor) continue
      anchored.add(path)
      if (!watched.has(anchor)) {
        watched.add(anchor)
        add.push(anchor)
      }
    }
    if (add.length > 0) watcher.add(add)
    return add.length
  }
  initialAnchors = sync()

  const resync = setInterval(() => {
    targets = computeTargets()
    siloFolders = computeSiloFolders()
    sync()
  }, opts.resyncMs ?? 10_000)
  resync.unref()

  return {
    ready,
    anchors: () => [...watched],
    async close() {
      closed = true
      clearInterval(resync)
      for (const { timer } of pending.values()) clearTimeout(timer)
      pending.clear()
      await watcher.close()
    },
  }
}
