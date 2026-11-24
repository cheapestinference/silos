// KnowsAnatomy.tsx — the reads every Knows surface shares (the agent page's
// Memory / Files / Skills / Tools / At start tabs, the project's Memory /
// Files / Skills / Tools, the conversation column, the drawer): memory
// layers, the skills catalog, context files, produced files, what loads at
// start and — for a folder — its MCP servers and plugins. The
// pictures built on them live in StartsWith.tsx (by scope) and
// KnowsLibrary.tsx (the browsable list).
import { useCallback, useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { AgentView, ContextFile, ContextScope, FolderLoads, LoadedAtStart, MemoryLayers, OwnToolRow, SkillCatalogEntry } from '../../lib/types'

export type LibraryKind = 'memory' | 'skills' | 'context' | 'produced' | 'start' | 'files' | 'tools'
// `item` opens one row on arrival — its key, or a name the row answers to
// (a file's name, a skill's, a plugin's) — and `scope` narrows that match
// to the memory/context layer a live write named
export type LibraryFocus = { kind: LibraryKind; filter?: 'outside-index' | 'recent' | 'here' | 'sign-in'; item?: string; scope?: string }

/** The conversation a Knows surface was opened from (the drawer): its
 *  session id — null before an SDK chat's first message — and the engine it
 *  runs on. It offers the third upload scope, «This conversation». */
export interface FromConversation {
  id: string | null
  harness?: string
}

export interface KnowsSources {
  memory: MemoryLayers | null
  catalog: SkillCatalogEntry[] | null
  context: { shared: ContextFile[]; agent: ContextFile[] } | null
  produced: ContextFile[] | null
  loaded: LoadedAtStart | null
  /** what the folder's conversations load (plugins, MCP servers,
   *  connectors), one row per thing — the project's Tools, and an agent's
   *  (its folder's); null when the folder is no project or the read failed */
  loads: FolderLoads | null
  /** an agent's OWN MCP servers with their state (agent-tools.ts); null for
   *  a folder, or when the read failed (its Tools then fall back to what loads) */
  ownTools: OwnToolRow[] | null
  ready: boolean
  /** some read FAILED this pass: its empty is unknown, not zero — surfaces
   *  say so in one quiet line instead of painting confident zeros */
  failed: boolean
  reload: () => void
}

// The five reads every Knows surface shares. A failed read is an honest
// empty, never an invented list; a reload keeps the old data until the new
// lands (no flash of "Loading…" after a write).
// The project page's subject: the FOLDER itself (the project is
// the house of what the folder owns). Previously the page read
// skills, memory and shared files through a member agent — whose primary
// folder may be elsewhere (a folders[]-only member, an agent nested inside)
// — so it showed and switched ANOTHER folder's skills. A folder subject is
// never an agent: every read and write below branches on it and asks the
// folder's own doors (/api/folders/:folder/…, /api/memory?folder=), never
// an agent route.
export interface FolderSubject extends AgentView {
  house: 'folder'
  folder: string
}
export function folderSubject(folder: string): FolderSubject {
  return { house: 'folder', id: '', name: 'this project', emoji: '', folder, skills: [], sessions: [], liveCount: 0, sessionCount: 0 }
}
/** the folder a Knows subject stands for, or null for a real agent */
export function subjectFolder(a: AgentView): string | null {
  return (a as Partial<FolderSubject>).house === 'folder' ? a.folder : null
}

// the gestures, one per subject kind — a folder subject never reaches an
// agent route (its id is no agent's)
const inFlightMemory = new Map<string, Promise<MemoryLayers>>()

export const knowsDoors = {
  memory(a: AgentView): Promise<MemoryLayers> {
    const f = subjectFolder(a)
    // the column reads an agent's memory twice at once (its Memory row and
    // the conversation's «Learned here»): identical reads in flight share one
    // request, so a knows event or a reconnect costs one fetch, not two
    const key = f !== null ? `f:${f}` : `a:${a.folder ?? ''}:${a.id}`
    const open = inFlightMemory.get(key)
    if (open) return open
    const p = Promise.resolve(f !== null ? api.memory.list(f) : api.memory.list(a.folder ?? undefined, a.id)).finally(() => inFlightMemory.delete(key))
    inFlightMemory.set(key, p)
    return p
  },
  catalog(a: AgentView): Promise<SkillCatalogEntry[]> {
    const f = subjectFolder(a)
    return f !== null ? api.folders.skillsCatalog(f) : api.skillsCatalog(a.id)
  },
  context(a: AgentView): Promise<{ shared: ContextFile[]; agent: ContextFile[] }> {
    const f = subjectFolder(a)
    return f !== null ? api.folders.context(f) : api.context.list(a.id)
  },
  skillState(a: AgentView, name: string, action: 'hold' | 'activate' | 'add'): Promise<SkillCatalogEntry[]> {
    const f = subjectFolder(a)
    return f !== null ? api.folders.skillState(f, name, action) : api.agents.skillState(a.id, name, action)
  },
  // `conversation`: the session id a 'conversation' upload is for
  upload(a: AgentView, scope: ContextScope, name: string, contentBase64: string, conversation?: string): Promise<ContextFile> {
    const f = subjectFolder(a)
    return f !== null
      ? api.folders.uploadShared(f, name, contentBase64)
      : api.context.upload(a.id, scope, name, contentBase64, ...(scope === 'conversation' && conversation ? [conversation] : []))
  },
  removeContext(a: AgentView, scope: ContextScope, name: string): Promise<{ ok: boolean }> {
    const f = subjectFolder(a)
    return f !== null ? api.folders.removeShared(f, name) : api.context.remove(a.id, scope, name)
  },
}

export function useKnowsSources(agent: AgentView, version = 0): KnowsSources {
  const [memory, setMemory] = useState<MemoryLayers | null>(null)
  const [catalog, setCatalog] = useState<SkillCatalogEntry[] | null>(null)
  const [context, setContext] = useState<KnowsSources['context']>(null)
  const [produced, setProduced] = useState<ContextFile[] | null>(null)
  const [loaded, setLoaded] = useState<LoadedAtStart | null>(null)
  const [loads, setLoads] = useState<FolderLoads | null>(null)
  const [ownTools, setOwnTools] = useState<OwnToolRow[] | null>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [tick, setTick] = useState(0)
  const { id, folder } = agent
  useEffect(() => {
    setMemory(null)
    setCatalog(null)
    setContext(null)
    setProduced(null)
    setLoaded(null)
    setLoads(null)
    setOwnTools(null)
    setReady(false)
    setFailed(false)
  }, [id, folder])
  useEffect(() => {
    let cancelled = false
    setFailed(false) // a reload gets a fresh verdict
    const safe = <T,>(p: () => Promise<T> | T | undefined): Promise<T | null> =>
      Promise.resolve()
        .then(p)
        .then((v) => v ?? null)
        .catch(() => {
          if (!cancelled) setFailed(true)
          return null
        })
    // a folder subject has no agent of its own: nothing produced, no
    // start-up picture (those are an agent's) — its three reads are the folder's
    const isFolder = subjectFolder(agent) !== null
    void Promise.all([
      safe(() => knowsDoors.memory(agent)).then((v) => {
        if (!cancelled && v) setMemory(v)
      }),
      safe(() => knowsDoors.catalog(agent)).then((v) => {
        if (!cancelled) setCatalog(v ?? [])
      }),
      folder
        ? safe(() => knowsDoors.context(agent)).then((v) => {
            if (!cancelled) setContext(v ?? { shared: [], agent: [] })
          })
        : Promise.resolve(setContext({ shared: [], agent: [] })),
      isFolder
        ? Promise.resolve(setProduced([]))
        : safe(() => api.context.produced(id)).then((v) => {
            if (!cancelled) setProduced(v ?? [])
          }),
      isFolder
        ? Promise.resolve(setLoaded(null))
        : safe(() => api.agents.loaded(id)).then((v) => {
            if (!cancelled) setLoaded(v)
          }),
      // a folder's own read fails loudly; an agent's folder that is no
      // project (none to read) quietly falls back to what loads at start
      isFolder && folder
        ? safe(() => api.folders.loads(folder)).then((v) => {
            if (!cancelled) setLoads(v)
          })
        : folder
          ? Promise.resolve()
              .then(() => api.folders.loads(folder, id))
              .then(
                (v) => {
                  if (!cancelled) setLoads(v ?? null)
                },
                () => {
                  if (!cancelled) setLoads(null)
                },
              )
          : Promise.resolve(setLoads(null)),
      isFolder
        ? Promise.resolve(setOwnTools(null))
        : safe(() => api.agents.tools.list(id)).then((v) => {
            if (!cancelled) setOwnTools(v?.rows ?? null)
          }),
    ]).then(() => {
      if (!cancelled) setReady(true)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, folder, version, tick])
  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { memory, catalog, context, produced, loaded, loads, ownTools, ready, failed, reload }
}
