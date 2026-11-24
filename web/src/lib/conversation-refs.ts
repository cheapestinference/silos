// conversation-refs.ts — what agents write about another conversation (a
// Claude Code session name like `silos-35`, or a session id) shown to the
// owner as that conversation's TITLE, clickable — the owner reads the
// conversation's title, never a dull session id.
//
// The server resolves (GET /api/conversation-refs); this module finds the
// candidates in text, asks once per token (batched, cached) and lets any
// component subscribe. A token the server doesn't know stays plain text —
// nothing links to a conversation that isn't there.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { api } from './api'

export interface ConversationRef {
  sessionId: string
  folder: string
  agentId: string
  title: string
  live: boolean
}

export const REF_ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g
// Claude Code names a session `<folder name>-<2 hex>`: silos-35,
// acme-prune-old-rule-29, acme-7a
export const REF_NAME = /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)*-[0-9a-f]{2}\b/g

export interface Found {
  token: string
  index: number
  kind: 'id' | 'name'
}

export function findRefs(text: string): Found[] {
  const out: Found[] = []
  for (const m of text.matchAll(REF_ID)) out.push({ token: m[0], index: m.index ?? 0, kind: 'id' })
  const taken = (i: number, len: number): boolean => out.some((f) => i < f.index + f.token.length && f.index < i + len)
  for (const m of text.matchAll(REF_NAME)) {
    const i = m.index ?? 0
    if (!taken(i, m[0].length)) out.push({ token: m[0], index: i, kind: 'name' })
  }
  return out.sort((a, b) => a.index - b.index)
}

// ---- the cache ---------------------------------------------------------------

// undefined = never asked · null = asked, not a conversation
const cache = new Map<string, { ref: ConversationRef | null; at: number }>()
const pending = new Map<string, Found['kind']>()
const listeners = new Set<() => void>()
let version = 0
let timer: ReturnType<typeof setTimeout> | null = null
// a name belongs to a LIVE session: asked again after a minute (it may
// now name another one); an id never changes what it names
const NAME_TTL_MS = 60_000

function fresh(token: string, kind: Found['kind']): boolean {
  const c = cache.get(token)
  return !!c && (kind === 'id' || Date.now() - c.at < NAME_TTL_MS)
}

// settles when the batch in flight (if any) has been answered
let inflight: Promise<void> = Promise.resolve()
let release: (() => void) | null = null

function flush(): void {
  timer = null
  const batch = [...pending.entries()]
  pending.clear()
  const done = release
  release = null
  if (batch.length === 0) {
    done?.()
    return
  }
  const names = batch.filter(([, k]) => k === 'name').map(([t]) => t)
  const ids = batch.filter(([, k]) => k === 'id').map(([t]) => t)
  api.conversationRefs(names, ids).then(
    (refs) => {
      const now = Date.now()
      for (const [t] of batch) cache.set(t, { ref: refs[t] ?? null, at: now })
      version++
      for (const l of listeners) l()
      done?.()
    },
    () => {
      done?.() /* offline or refused: the text stays as written, asked again next time */
    },
  )
}

/** Ask for every token not fresh yet; resolves once they have been answered. */
export function ensureRefs(found: readonly Found[]): Promise<void> {
  const missing = found.filter((f) => !fresh(f.token, f.kind))
  if (missing.length === 0) return Promise.resolve()
  if (!release)
    inflight = new Promise<void>((r) => {
      release = r
    })
  const wait = inflight
  for (const f of missing) requestRef(f.token, f.kind)
  return wait
}

export function requestRef(token: string, kind: Found['kind']): void {
  if (fresh(token, kind) || pending.has(token)) return
  pending.set(token, kind)
  timer ??= setTimeout(flush, 30)
}

export function cachedRef(token: string): ConversationRef | null | undefined {
  return cache.get(token)?.ref
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** The conversation a token names, or null/undefined while unknown. */
export function useConversationRef(token: string, kind: Found['kind']): ConversationRef | null | undefined {
  useSyncExternalStore(subscribe, () => version)
  requestRef(token, kind)
  return cachedRef(token)
}

// ---- a page's own lookup (never the forever-cache above) ----------------------
//
// The task page and the plan view must not say «gone» from the browser's
// CAPPED list (overview-cap.ts trims what /api/overview sends): before
// giving up on an id they ask the server, whose index is whole. This hook
// keeps its own state per mount — the module cache above stores a «not a
// conversation» answer forever, which would pin a false «gone» asked while
// the index was still warming; here `retry` (store.warming) re-asks once
// the index settles, and `answered` stays false until an answer that can
// be trusted arrived. Without ids there is nothing to ask: answered.
export function useServerConversations(ids: readonly string[], retry: boolean): { refs: Map<string, ConversationRef>; answered: boolean } {
  const key = [...new Set(ids)].sort().join(',')
  const [state, setState] = useState<{ key: string; retry: boolean; refs: Map<string, ConversationRef>; answered: boolean }>({
    key: '',
    retry: false,
    refs: new Map(),
    answered: false,
  })
  useEffect(() => {
    if (key === '') return
    let dead = false
    const sorted = key.split(',')
    const batches: string[][] = []
    for (let i = 0; i < sorted.length; i += 100) batches.push(sorted.slice(i, i + 100))
    // tolerate a partial API (tests mount with a few methods) and a refusal:
    // both read as «no answer yet», never as «gone»
    void Promise.all(batches.map((b) => Promise.resolve(api.conversationRefs?.([], b)).catch(() => undefined))).then((answers) => {
      if (dead) return
      const refs = new Map<string, ConversationRef>()
      let answered = true
      for (const a of answers) {
        if (a === undefined) {
          answered = false
          continue
        }
        for (const [t, r] of Object.entries(a)) if (r) refs.set(t, r)
      }
      setState({ key, retry, refs, answered: answered && !retry })
    })
    return () => {
      dead = true
    }
  }, [key, retry])
  if (key === '') return { refs: new Map(), answered: true }
  if (state.key !== key || state.retry !== retry) return { refs: new Map(), answered: false }
  return { refs: state.refs, answered: state.answered }
}

// tests only
export function resetConversationRefs(): void {
  cache.clear()
  pending.clear()
  version = 0
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

// ---- markdown: a remark plugin ------------------------------------------------

export const REF_HREF = '#silos-ref:'

interface MdNode {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
}

// every candidate in a text node (outside links and code) becomes a link to
// REF_HREF + token; the `a` renderer decides, once resolved, what it shows
export function remarkConversationRefs() {
  const walk = (node: MdNode): void => {
    if (!node.children || node.type === 'link' || node.type === 'linkReference') return
    const next: MdNode[] = []
    for (const child of node.children) {
      if (child.type === 'text' && child.value) {
        const found = findRefs(child.value)
        if (found.length === 0) {
          next.push(child)
          continue
        }
        let last = 0
        for (const f of found) {
          if (f.index > last) next.push({ type: 'text', value: child.value.slice(last, f.index) })
          next.push({ type: 'link', url: `${REF_HREF}${f.kind}:${f.token}`, children: [{ type: 'text', value: f.token }] })
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
