// projects-folder.ts — the Projects folder as the server says it (GET
// /api/settings `projectsDir`): where the next new project is born. Read
// once and shared by Welcome, the New agent form and Settings › Territory,
// which updates it after a change. Until the server answers (or on an older
// one) it is the default, ~/Silos — never a path the web makes up beyond it.
import { useSyncExternalStore } from 'react'
import { api } from './api'
import type { PlatformSettingsView } from './types'

export interface ProjectsFolder {
  path: string | null
  shown: string
  chosen: boolean
}

const DEFAULT: ProjectsFolder = { path: null, shown: '~/Silos', chosen: false }
let current: ProjectsFolder = DEFAULT
let asked = false
const listeners = new Set<() => void>()

/** What a settings answer says (Settings › Territory after a change). */
export function setProjectsFolder(view: PlatformSettingsView | null | undefined): void {
  const d = view?.projectsDir
  current = d ? { path: d.path, shown: d.shown, chosen: d.chosen } : DEFAULT
  for (const l of listeners) l()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  if (!asked) {
    asked = true
    // an older server (or none): the default stands
    try {
      Promise.resolve(api.platformSettings.get())
        .then(setProjectsFolder)
        .catch(() => {})
    } catch {
      /* the default stands */
    }
  }
  return () => {
    listeners.delete(cb)
  }
}

export function useProjectsFolder(): ProjectsFolder {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  )
}
