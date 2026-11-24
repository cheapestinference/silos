// ProjectSelector.tsx — with master selected and no session open, replaces
// the chat's EmptyState content (the same gap, see Transcript.tsx): lists
// already-seen projects (GET /api/projects, in the order it arrives — the
// server already sorts them by last activity) to pick one, or accepts a
// free absolute path. Choosing a project populates store.chosenProject,
// which enables the Composer and makes send() send `cwd` in master's new
// chat (see store.ts).
import { useEffect, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ProjectIcon } from '../lib/icons'
import { useStore } from '../store'
import { api } from '../lib/api'
import { basename } from '../lib/routes'
import type { Project } from '../lib/types'

export function ProjectSelector() {
  const chooseProject = useStore((s) => s.chooseProject)
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [freePath, setFreePath] = useState('')

  useEffect(() => {
    let cancelled = false
    void api.projects().then((p) => {
      if (!cancelled) setProjects(p)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // minimal validation: the free path must be absolute.
  const pathValid = freePath.trim().startsWith('/')

  function confirmFreePath(): void {
    const clean = freePath.trim()
    if (!clean.startsWith('/')) return
    // A fresh path IS the new-project gesture: create it first, or both
    // engines refuse the cwd before the first message can even be sent.
    void api
      .mkdir(clean)
      .then(() => chooseProject(clean))
      .catch(() => chooseProject(clean))
  }

  function onPathKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') confirmFreePath()
  }

  return (
    <div data-testid="project-selector" className="flex h-full flex-col items-center justify-center gap-4 overflow-y-auto px-6 py-6 text-center">
      <ProjectIcon size={28} strokeWidth={1.5} className="text-ink-2 opacity-40" aria-hidden="true" />
      <h1 className="font-display text-xl text-ink">Pick a project</h1>

      {projects === null ? (
        <p className="text-sm text-ink-2">loading…</p>
      ) : projects.length > 0 ? (
        <ul className="w-full max-w-sm space-y-0.5 text-left">
          {projects.map((p) => (
            <li key={p.cwd}>
              <button
                type="button"
                onClick={() => chooseProject(p.cwd)}
                className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-display text-sm text-ink">{basename(p.cwd)}</span>
                  <span className="block truncate font-mono text-xs text-ink-2" title={p.cwd}>
                    {p.cwd}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-ink-2">{p.sessions}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="max-w-xs text-sm text-ink-2">No projects seen yet. Type a path below to start one.</p>
      )}

      <div className="flex w-full max-w-sm items-center gap-2">
        <input
          type="text"
          aria-label="project path"
          value={freePath}
          onChange={(e) => setFreePath(e.target.value)}
          onKeyDown={onPathKeyDown}
          placeholder="/absolute/path/to/project"
          className="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-3 py-1.5 font-mono text-sm outline-none focus:border-ink"
        />
        <button
          type="button"
          onClick={confirmFreePath}
          disabled={!pathValid}
          className="shrink-0 rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-canvas hover:opacity-90 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40"
        >
          Use path
        </button>
      </div>
    </div>
  )
}
