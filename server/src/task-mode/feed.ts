// The task feed — the visible reply of every turn the machinery sent for a
// task, read from the TRANSCRIPT itself: the briefing's first line is the
// durable marker (the wake store expires at 400/30d and holds no turn id).
// Engine-neutral on purpose: it
// speaks only the harness contract (readTurns + the file-backed predicates).
import { readFile } from 'node:fs/promises'
import type { SessionMeta, TranscriptTurn } from '../types.js'

export interface TaskFeedCard {
  at: string // ts of the turn's first visible segment
  agent: string | null
  via: 'wake' | 'briefed'
  texts: string[] // the turn's visible segments; the folded UI shows the LAST (the answer after tools)
  folder: string
  sessionId: string
}

export interface FeedIndex {
  readTurns(folder: string, id: string): Promise<TranscriptTurn[]>
  hasTranscriptFile(id: string): boolean
  pathOf(folder: string, id: string): string
}

const CARD_TEXT_CAP = 4000 // across a card's segments; the tail survives (the answer lives at the end)
const CARDS_CAP = 40

const wakePrefix = (ref: string): string => `Silos woke you for ONE task — this turn is about ${ref} «`
const workPrefix = (ref: string): string => `The owner opened this conversation to work ONE task — ${ref} «`

// Until d1cf605f every new SDK session's first prompt carried the
// [silos-context] prelude in front of the briefing — without stripping it the
// prefix matches no historical session (started-with.ts strips it the same way).
const stripPrelude = (text: string): string => {
  const m = /^\[silos-context\][\s\S]*?\[\/silos-context\]\s*/.exec(text)
  return m ? text.slice(m[0].length) : text
}

// A reply ends at the next REAL user turn: interjections (the owner typing
// mid-turn), peer messages and compaction markers do not cut it.
const realUserTurn = (t: TranscriptTurn): boolean => t.role === 'user' && t.text.trim() !== '' && !t.interSession && !t.interjection && !t.compact

const capTexts = (texts: string[]): string[] => {
  let budget = CARD_TEXT_CAP
  const out: string[] = []
  for (let i = texts.length - 1; i >= 0; i--) {
    const s = texts[i]!
    if (s.length <= budget) {
      out.unshift(s)
      budget -= s.length
    } else {
      if (budget > 24) out.unshift(`…${s.slice(s.length - budget)}`)
      break
    }
  }
  return out
}

// Pure extraction over one transcript's turns. A card is emitted only when
// its turn is CLOSED (a turnEnded assistant, a duration marker, a synthetic
// notice, or a following real user turn) — never partial cards that grow.
export function cardsOf(turns: readonly TranscriptTurn[], ref: string, folder: string, sessionId: string, agent: string | null): TaskFeedCard[] {
  const wake = wakePrefix(ref)
  const work = workPrefix(ref)
  const out: TaskFeedCard[] = []
  let open: { via: 'wake' | 'briefed'; texts: string[]; at: string | null; closed: boolean } | null = null
  const flush = (): void => {
    if (open && open.closed && open.texts.length > 0) {
      out.push({ at: open.at ?? '', agent, via: open.via, texts: capTexts(open.texts), folder, sessionId })
    }
    open = null
  }
  for (const t of turns) {
    if (t.role === 'user') {
      const stripped = stripPrelude(t.text).trimStart()
      const via = stripped.startsWith(wake) ? ('wake' as const) : stripped.startsWith(work) ? ('briefed' as const) : null
      if (via) {
        if (open) {
          open.closed = true
          flush()
        }
        open = { via, texts: [], at: null, closed: false }
        continue
      }
      if (realUserTurn(t) && open) {
        open.closed = true
        flush()
      }
      continue
    }
    if (!open || t.role !== 'assistant') continue
    if (typeof t.durationMs === 'number' || t.synthetic) {
      open.closed = true
      continue
    }
    if (t.compact) continue
    if (t.text.trim() !== '') {
      open.texts.push(t.text)
      if (open.at === null) open.at = t.ts
    }
    if (t.turnEnded) open.closed = true
  }
  flush() // transcript over: emits only if a close signal was seen (else the turn is still streaming)
  return out
}

interface CacheEntry {
  size: number
  mtime: number
  cards: TaskFeedCard[] | null
} // null = nothing for this ref

// Reads are guarded by a cheap prescan (the raw file must contain `${ref} «`)
// and a per-(ref, session) cache keyed on (size, mtime) — mtime alone is the
// transcript's last timestamp and misses lines without one. readTurns parses
// the whole JSONL synchronously (~700ms on a real 29.5MB session — the event-loop
// freeze class), so a session without the marker is never parsed.
export function makeTaskFeed(index: FeedIndex) {
  const cache = new Map<string, CacheEntry>()
  return async (sessions: readonly SessionMeta[], ref: string, agentOf: (m: SessionMeta) => string | null): Promise<TaskFeedCard[]> => {
    const needle = `${ref} «`
    const out: TaskFeedCard[] = []
    for (const m of sessions) {
      const key = `${ref}|${m.folder}/${m.id}`
      const hit = cache.get(key)
      if (hit && hit.size === m.size && hit.mtime === m.mtime) {
        if (hit.cards) out.push(...hit.cards)
        continue
      }
      let cards: TaskFeedCard[] | null = null
      try {
        let marked = true
        if (index.hasTranscriptFile(m.id)) {
          const raw = await readFile(index.pathOf(m.folder, m.id), 'utf8')
          marked = raw.includes(needle)
        }
        if (marked) {
          const found = cardsOf(await index.readTurns(m.folder, m.id), ref, m.folder, m.id, agentOf(m))
          cards = found.length > 0 ? found : null
        }
      } catch {
        cards = null // trashed mid-read (ENOENT): its cards simply disappear, the feed goes on
      }
      cache.set(key, { size: m.size, mtime: m.mtime, cards })
      if (cards) out.push(...cards)
    }
    out.sort((a, b) => a.at.localeCompare(b.at))
    return out.slice(-CARDS_CAP)
  }
}
