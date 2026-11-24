// file-refs.ts — a path an agent writes (in the chat or in the real
// console) opens the file viewer in ONE click. The same shape as
// conversation-refs.ts: this module finds the candidates in text, asks the
// file service once per path (cached, a few at a time) and only a path
// that IS a file becomes a link — a word that merely looks like a path
// stays plain text. Relative paths resolve against the conversation's cwd.
import { useSyncExternalStore } from 'react'
import { api } from './api'
import { closeFileSheet, openFileSheet } from './router'
import type { FileMeta } from './types'
import type { PlanDoor } from './tasks'

// a run of path characters, not glued to a URL or a word before it; the
// `:line[:col]` an agent appends (`server.ts:42`) rides along and is dropped
const CANDIDATE = /(?<![\p{L}\p{N}_:/.~@+-])(?:\.{1,2}\/|\/)?[\p{L}\p{N}_.@+-]+(?:\/[\p{L}\p{N}_.@+-]+)*(?::\d+(?::\d+)?)?/gu
// a bare name (no slash) counts only with one of these extensions —
// `Node.js` or `e.g.` must not cost a lookup each
const BARE_EXT =
  /\.(?:md|mdx|txt|json|jsonl|ya?ml|toml|csv|tsv|log|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|sh|sql|html?|css|svg|png|jpe?g|gif|webp|pdf|docx?|xlsx?|pptx?|env|ini|conf|lock)$/i

export interface FoundPath {
  token: string
  index: number
  path: string
}

/** The path a candidate names, without its `:line[:col]`, or null if it isn't one. */
export function pathOfToken(raw: string): string | null {
  const token = raw.replace(/[.-]+$/, '') // a sentence's full stop is not part of the path
  const path = token.replace(/:\d+(?::\d+)?$/, '')
  if (path.length < 3 || path.includes('//')) return null
  const last = path.slice(path.lastIndexOf('/') + 1)
  if (last === '' || last === '.' || last === '..') return null
  if (path.startsWith('/')) return path.indexOf('/', 1) > 0 ? path : null // `/tmp` alone is a folder or a word
  if (path.startsWith('./') || path.startsWith('../')) return path
  if (path.includes('/')) return /\.[A-Za-z0-9]{1,8}$/.test(last) ? path : null
  // `Node.js`, `Vue.js`: a framework's name, not a file
  if (/^[A-Z][a-z]+\.js$/.test(path)) return null
  return BARE_EXT.test(path) ? path : null
}

export function findPaths(text: string): FoundPath[] {
  const out: FoundPath[] = []
  for (const m of text.matchAll(CANDIDATE)) {
    const raw = m[0].replace(/[.-]+$/, '')
    const path = pathOfToken(raw)
    if (path) out.push({ token: raw, index: m.index ?? 0, path })
  }
  return out
}

/** `path` made absolute against `cwd` (null when relative and no cwd). */
export function resolvePath(path: string, cwd: string | null | undefined): string | null {
  if (!path.startsWith('/') && !cwd) return null
  const parts: string[] = []
  for (const seg of (path.startsWith('/') ? path : `${cwd}/${path}`).split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return `/${parts.join('/')}`
}

// ---- the cache ---------------------------------------------------------------

// undefined = never asked · null = asked, not a file
const cache = new Map<string, FileMeta | null>()
const queue: string[] = []
const listeners = new Set<() => void>()
let version = 0
let running = 0
const PARALLEL = 4

function pump(): void {
  while (running < PARALLEL && queue.length > 0) {
    const path = queue.shift()!
    running++
    // through a promise: a synchronous throw from the client is an answer
    // (not a file), never an exception inside a render that asked
    Promise.resolve()
      .then(() => api.file.meta(path))
      .then(
        (m) => {
          cache.set(path, m)
        },
        () => {
          cache.set(path, null) /* missing, a folder, refused: plain text */
        },
      )
      .finally(() => {
        running--
        version++
        for (const l of listeners) l()
        pump()
      })
  }
}

export function requestFile(path: string): void {
  if (cache.has(path) || queue.includes(path)) return
  queue.push(path)
  pump()
}

export function cachedFile(path: string): FileMeta | null | undefined {
  return cache.get(path)
}

/** Settles once every path has an answer (the console asks this way). */
export function ensureFiles(paths: readonly string[]): Promise<void> {
  const missing = paths.filter((p) => !cache.has(p))
  if (missing.length === 0) return Promise.resolve()
  for (const p of missing) requestFile(p)
  return new Promise((done) => {
    const check = (): void => {
      if (missing.every((p) => cache.has(p))) {
        listeners.delete(check)
        done()
      }
    }
    listeners.add(check)
  })
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** The file an absolute path names, or null/undefined while unknown. */
export function useFileRef(path: string | null): FileMeta | null | undefined {
  useSyncExternalStore(subscribe, () => version)
  if (!path) return null
  requestFile(path)
  return cachedFile(path)
}

// tests only
export function resetFileRefs(): void {
  cache.clear()
  queue.length = 0
  version = 0
}

// ---- a file a conversation used: what its click does ---------------------------

/** What a click on a file a conversation used does: `open` it in the one
 *  viewer (the absolute path — a relative one resolved against the
 *  conversation's cwd, as the engine resolved it), say it is `gone` (the
 *  file service answered: no file there now — moved, deleted, a removed
 *  worktree), or say Silos can't open it here (`unreachable`: a relative
 *  path with no folder to resolve it against). Not answered yet = `open`:
 *  the viewer says the rest. A memory note is a file like any other — it
 *  opens in the same viewer, never in a reader that takes only memory. */
export type UsedFileDoor = { kind: 'open'; path: string } | { kind: 'gone'; path: string } | { kind: 'unreachable' }

export function usedFileDoor(path: string, cwd: string | null | undefined, meta: FileMeta | null | undefined): UsedFileDoor {
  const abs = resolvePath(path, cwd)
  if (abs === null) return { kind: 'unreachable' }
  if (meta === null) return { kind: 'gone', path: abs }
  return { kind: 'open', path: abs }
}

/** A failure to open a file, in the owner's words — never a server's
 *  message or an error code. */
export function fileErrorWords(e: unknown): string {
  const status = typeof e === 'object' && e !== null && typeof (e as { status?: unknown }).status === 'number' ? (e as { status: number }).status : null
  if (status === 404) return 'This file is no longer there — it was moved or deleted since.'
  if (status === 400 || status === 403) return 'Silos can’t open this path here.'
  return 'This file could not be opened.'
}

// ---- the one viewer every link opens ------------------------------------------

// the viewer's state lives in the store (State.viewingFile) and rides the
// URL as ?file= (lib/router.ts) — opening a file is a sheet over the page,
// Back closes it.
export function openFileViewer(path: string | null): void {
  if (path) openFileSheet(path)
  else closeFileSheet()
}

// go through a plan's door (tasks.ts planDoor): its house is a page, a closed
// or unreadable plan's door is its read-only file
export function openPlanDoor(door: PlanDoor, changePage: (page: Extract<PlanDoor, { kind: 'house' }>['page']) => void): void {
  if (door.kind === 'file') openFileViewer(door.path)
  else changePage(door.page)
}

// ---- markdown: a remark plugin ------------------------------------------------

export const FILE_HREF = '#silos-file:'

interface MdNode {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
}

// every candidate in a text node (outside links and code) becomes a link to
// FILE_HREF + token; the `a` renderer decides, once the file service has
// answered, whether it is a link or the text as written
export function remarkFileRefs() {
  const walk = (node: MdNode): void => {
    if (!node.children || node.type === 'link' || node.type === 'linkReference') return
    const next: MdNode[] = []
    for (const child of node.children) {
      if (child.type === 'text' && child.value) {
        const found = findPaths(child.value)
        if (found.length === 0) {
          next.push(child)
          continue
        }
        let last = 0
        for (const f of found) {
          if (f.index > last) next.push({ type: 'text', value: child.value.slice(last, f.index) })
          next.push({ type: 'link', url: `${FILE_HREF}${encodeURIComponent(f.token)}`, children: [{ type: 'text', value: f.token }] })
          last = f.index + f.token.length
        }
        if (last < child.value.length) next.push({ type: 'text', value: child.value.slice(last) })
      } else {
        walk(child)
        next.push(child)
      }
    }
    node.children = next
  }
  return (tree: MdNode) => walk(tree)
}
