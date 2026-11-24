// FileExplorer.tsx — a file explorer: navigates the tree of a folder, opens
// any file in the usual viewer (FileViewer). The Files page's column —
// rooted at home, or at one folder when a project's «Browse the folder ›»
// opened it.
//
// Navigation BOUNDED to `root`: you can enter subfolders and go up via the
// breadcrumb, but never above the root it was opened with (no ".." that
// escapes). The listing is served by /api/dir (the same auth boundary as /api/file).
import { openFileViewer } from '../lib/file-refs'
import { useEffect, useRef, useState } from 'react'
import { Folder, FileText, Loader2 } from 'lucide-react'
import { api } from '../lib/api'
import type { DirEntry } from '../lib/types'

function baseName(p: string): string {
  const q = p.replace(/\/+$/, '')
  const i = q.lastIndexOf('/')
  return i >= 0 ? q.slice(i + 1) : q
}

// `onOpenFile` (optional): when given, clicking a file calls it instead of
// opening the built-in modal — used by the Files mode to route the file to the
// main area.
// `selected` (optional): the file open beside it (Files mode). The explorer
// SHOWS it — opens on its folder with the file marked — or the column of
// folders would say nothing about what you are reading.
// Only when it lives under `root`; browsing elsewhere afterwards is free.
export function FileExplorer({ root, onOpenFile, selected }: { root: string; onOpenFile?: (path: string) => void; selected?: string }) {
  const folderOfSelected = selected && selected.startsWith(`${root}/`) ? selected.slice(0, selected.lastIndexOf('/')) : null
  const [cwd, setCwd] = useState(folderOfSelected ?? root)
  const [data, setData] = useState<{ path: string; entries: DirEntry[] } | null>(null)
  const [error, setError] = useState<string | null>(null)

  // returns to the root when the root changes (another agent/project); to
  // the open file's folder when another file is opened
  useEffect(() => {
    setCwd(folderOfSelected ?? root)
  }, [root, folderOfSelected])
  const marked = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    marked.current?.scrollIntoView?.({ block: 'nearest' })
  }, [data, selected])

  useEffect(() => {
    let cancel = false
    setData(null)
    setError(null)
    Promise.resolve(api.file.dir(cwd))
      .then((d) => {
        if (!cancel) setData(d ?? { path: cwd, entries: [] })
      })
      .catch((e: unknown) => {
        if (!cancel) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancel = true
    }
  }, [cwd])

  // breadcrumb: the root + the segments below it down to `cwd`.
  const rel = cwd.startsWith(root) ? cwd.slice(root.length).replace(/^\/+/, '') : ''
  const segments = rel === '' ? [] : rel.split('/')
  const goToSegment = (i: number): void => setCwd(i < 0 ? root : `${root}/${segments.slice(0, i + 1).join('/')}`)

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* breadcrumb */}
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-3 py-2 font-mono text-xs text-ink-2">
        <button type="button" onClick={() => goToSegment(-1)} className="hover:text-terracotta">
          {baseName(root) || root}
        </button>
        {segments.map((s, i) => (
          <span key={i} className="flex items-center gap-1">
            <span aria-hidden="true" className="text-ink-3">
              /
            </span>
            <button type="button" onClick={() => goToSegment(i)} className="hover:text-terracotta">
              {s}
            </button>
          </span>
        ))}
      </div>

      {/* the open file lives outside this tree: say so, never a silent column */}
      {selected && !folderOfSelected ? (
        <p data-testid="explorer-outside" className="shrink-0 border-b border-line px-3 py-2 text-[11px] text-ink-2">
          Open: <span className="break-all font-mono text-ink">{selected}</span> — outside this folder tree
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {error ? <p className="px-1 py-2 text-xs text-ink-2">{error}</p> : null}
        {!error && data === null ? (
          <p className="flex items-center gap-2 px-1 py-2 text-xs text-ink-2">
            <Loader2 size={13} className="animate-spin" /> Loading…
          </p>
        ) : null}
        {data && data.entries.length === 0 ? <p className="px-1 py-2 text-xs text-ink-3">Empty folder.</p> : null}
        {data ? (
          <ul role="list" className="space-y-0.5">
            {data.entries.map((e) => {
              const isOpen = selected === `${cwd}/${e.name}`
              return (
                <li key={e.name}>
                  <button
                    type="button"
                    ref={isOpen ? marked : undefined}
                    aria-current={isOpen ? 'true' : undefined}
                    onClick={() => {
                      const full = `${cwd}/${e.name}`
                      if (e.type === 'dir') setCwd(full)
                      else if (onOpenFile) onOpenFile(full)
                      else openFileViewer(full)
                    }}
                    className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm ${isOpen ? 'bg-terracotta-soft' : 'hover:bg-panel'}`}
                  >
                    {e.type === 'dir' ? <Folder size={14} className="shrink-0 text-terracotta" /> : <FileText size={14} className="shrink-0 text-ink-2" />}
                    <span className={`min-w-0 flex-1 truncate ${e.type === 'dir' ? 'text-ink' : `font-mono ${isOpen ? 'text-terracotta' : 'text-ink-2'}`}`}>
                      {e.name}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        ) : null}
      </div>
    </div>
  )
}
