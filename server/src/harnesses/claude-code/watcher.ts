import { watch } from 'chokidar'
import { relative, sep } from 'node:path'
import type { SessionIndex } from '../../session-index.js'
import { isEphemeralFolder } from '../../ephemeral.js'

// chokidar 5 doesn't accept globs: we filter top-level *.jsonl files by hand.
// Muted folders (muted.json) are filtered here, in parse() — cheaper than a
// chokidar `ignored` (which would still have to evaluate every path) and
// with the same effect: no event from a muted folder ever reaches
// index.refresh(), so it can never "resurrect" it in the index.
// Same treatment for ephemeral folders (noise under the OS tmpdir) — see
// ephemeral.ts for why the prefix is derived from os.tmpdir().
export function startWatcher(
  root: string,
  index: SessionIndex,
  muted: readonly string[] = [],
  ephemeralPrefix: string | null = null,
): { close(): Promise<void> } {
  const timers = new Map<string, NodeJS.Timeout>()
  const inflight = new Set<Promise<unknown>>()
  const mutedSet = new Set(muted)

  const shouldSkip = (folder: string): boolean => mutedSet.has(folder) || (ephemeralPrefix !== null && isEphemeralFolder(folder, ephemeralPrefix))

  const parse = (path: string): { folder: string; id: string } | null => {
    const rel = relative(root, path)
    const parts = rel.split(sep)
    if (parts.length !== 2 || !parts[1]!.endsWith('.jsonl')) return null
    if (shouldSkip(parts[0]!)) return null
    return { folder: parts[0]!, id: parts[1]!.slice(0, -'.jsonl'.length) }
  }

  const debounced = (path: string): void => {
    const target = parse(path)
    if (!target) return
    const prev = timers.get(path)
    if (prev) clearTimeout(prev)
    timers.set(
      path,
      setTimeout(() => {
        timers.delete(path)
        const p = index
          .refresh(target.folder, target.id)
          // the file can disappear between the fs event and the read; the next fs event reconciles
          .catch(() => {})
        inflight.add(p)
        p.finally(() => inflight.delete(p))
      }, 100),
    )
  }

  const watcher = watch(root, { ignoreInitial: true, depth: 1 })
  // CRITICAL: without an 'error' listener, chokidar takes down the whole
  // process (an EventEmitter with no 'error' listener → throw). The main
  // ~/.claude/projects watcher must never die.
  watcher.on('error', (err) => {
    console.warn('watcher: error observing', root, '—', err instanceof Error ? err.message : String(err))
  })
  watcher.on('add', debounced)
  watcher.on('change', debounced)
  watcher.on('unlink', (path) => {
    const target = parse(path)
    if (target) {
      // clear the pending timer before removing, so the session isn't resurrected
      const prev = timers.get(path)
      if (prev) clearTimeout(prev)
      timers.delete(path)
      index.remove(target.folder, target.id)
    }
  })

  return {
    async close(): Promise<void> {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
      await Promise.allSettled([...inflight])
      await watcher.close()
    },
  }
}
