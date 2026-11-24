// Messages between agents: one JSON file per
// message, <dataDir>/messages/<to>/<id>.json (0600) — the SERVER's store:
// fenced from every agent (`messages` is in territory.ts DATA_DIR_DENIED)
// and under the restore seal (seal-regimes.ts `messages`). Agents read
// their inbox through the API (GET /api/agents/<self>/messages), never by
// file: «read» is the server's word only if no agent can mark, delete or
// forge a message by editing the store.
//
// MEMORY IS THE TRUTH while the server lives (the restore regime): the
// store loads the directory once at boot (after the seal's boot has set
// aside whatever changed while Silos was off) and from then on serves what
// it wrote. A file that APPEARED in the dir is never served (the seal sets
// it aside and its row's «Keep the edit» is the only way in — adopt()); an
// edited or deleted one keeps being served as Silos wrote it (the seal puts
// its copy back). Every write goes through the seal (seal-hooks.ts) — in a
// test without a seal, an atomic write as always.
//
// No message wakes anyone: work that cannot wait is a task.
import { randomInt } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sealHooks } from './seal-hooks.js'
import { listContained, readContainedTextOrNull } from './safe-file.js'
import { TRASH_KEEP_MS } from './trash-purge.js'
import { AGENT_MESSAGE_STATES, type AgentMessage, type AgentMessageState } from './types.js'

export type { AgentMessage, AgentMessageState } from './types.js'

/** The store's directory under the data dir. */
export const MESSAGES_DIR = 'messages'

// what a recipient may say when it closes a message (PATCH … answer)
export const ANSWER_MAX = 1000

// Retention: an inbox would otherwise grow forever. A DELIVERED message
// (read / answered) whose last state change — the file's mtime: every write
// rewrites it — is older than this window is deleted. Unread (new) and
// needs_owner (still waiting on a person) are never pruned, whatever their
// age. The same 30 days the trash keeps (trash-purge.ts). Deleted, not moved
// to the trash: these are Silos' own records, already handled a month ago.
export const MESSAGE_KEEP_MS = TRASH_KEEP_MS
const PRUNABLE: readonly AgentMessageState[] = ['read', 'answered']

// `<ms base36>-<6 random base36>`: sortable by creation, one path segment.
const MESSAGE_ID = /^[0-9a-z]+-[0-9a-z]{6}$/
// an agent id as the registry mints it — one path segment
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const B36 = '0123456789abcdefghijklmnopqrstuvwxyz'
// a message file is small: text + answer
const MESSAGE_MAX_BYTES = 256 * 1024
// the fields a message carries — anything else is not a message of this
// store (no tolerant reader: `urgent`/`delivery` left with the move)
const FIELDS = new Set(['id', 'from', 'to', 'at', 'text', 'state', 'replyTo', 'answer', 'run', 'readOutside', 'root'])

function newId(): string {
  let rand = ''
  for (let i = 0; i < 6; i++) rand += B36[randomInt(36)]
  return `${Date.now().toString(36)}-${rand}`
}

export function isMessageState(s: unknown): s is AgentMessageState {
  return typeof s === 'string' && (AGENT_MESSAGE_STATES as readonly string[]).includes(s)
}

/** A stored message, strictly: every required field, no unknown one. */
export function parseMessage(raw: unknown): AgentMessage | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  for (const k of Object.keys(o)) if (!FIELDS.has(k)) return null
  if (typeof o.id !== 'string' || !MESSAGE_ID.test(o.id)) return null
  if (typeof o.from !== 'string' || o.from === '' || typeof o.to !== 'string' || !AGENT_ID.test(o.to)) return null
  if (typeof o.at !== 'string' || typeof o.text !== 'string' || !isMessageState(o.state)) return null
  if (o.replyTo !== undefined && typeof o.replyTo !== 'string') return null
  if (o.answer !== undefined && typeof o.answer !== 'string') return null
  if (o.run !== undefined && typeof o.run !== 'string') return null
  if (o.readOutside !== undefined && !(Array.isArray(o.readOutside) && o.readOutside.every((x) => typeof x === 'string'))) return null
  if (o.root !== undefined && o.root !== 'mission') return null
  return {
    id: o.id,
    from: o.from,
    to: o.to,
    at: o.at,
    text: o.text,
    state: o.state,
    ...(typeof o.replyTo === 'string' ? { replyTo: o.replyTo } : {}),
    ...(typeof o.answer === 'string' && o.answer !== '' ? { answer: o.answer } : {}),
    ...(typeof o.run === 'string' && o.run !== '' ? { run: o.run } : {}),
    ...(Array.isArray(o.readOutside) && o.readOutside.length > 0 ? { readOutside: [...(o.readOutside as string[])] } : {}),
    ...(o.root === 'mission' ? { root: 'mission' as const } : {}),
  }
}

/** «Keep the edit» of a message file (seals.ts registerDir): it must be a
 *  message, and the one its path names. */
export function validateMessageFile(bytes: Buffer, rel: string): string | null {
  let raw: unknown
  try {
    raw = JSON.parse(bytes.toString('utf8'))
  } catch {
    return 'not JSON'
  }
  const m = parseMessage(raw)
  if (!m) return 'not a message (id, from, to, at, text and state — nothing else)'
  const parts = rel.split('/')
  if (parts.length !== 3 || parts[0] !== MESSAGES_DIR || parts[1] !== m.to || parts[2] !== `${m.id}.json`) return 'its path does not name this message'
  return null
}

// An answer is one paragraph: trimmed, every whitespace run (newlines
// included) one space. Null = not a usable answer (empty, or too long).
export function normalizeAnswer(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.replace(/\s+/g, ' ').trim()
  return s === '' || s.length > ANSWER_MAX ? null : s
}

export class MessageStore {
  private byAgent = new Map<string, Map<string, AgentMessage>>()
  readonly dir: string

  constructor(
    private dataDir: string,
    private opts: { now?: () => number } = {},
  ) {
    this.dir = join(dataDir, MESSAGES_DIR)
    this.load()
  }

  /** Read the directory into memory (boot; a test reloads). */
  load(): void {
    this.byAgent.clear()
    let agents: string[]
    try {
      agents = readdirSync(this.dir)
    } catch {
      return
    }
    for (const agentId of agents) {
      if (!AGENT_ID.test(agentId)) continue
      const d = join(this.dir, agentId)
      try {
        if (!lstatSync(d).isDirectory()) continue
      } catch {
        continue
      }
      for (const name of listContained(d)) {
        if (!name.endsWith('.json')) continue
        const text = readContainedTextOrNull(d, name, { maxBytes: MESSAGE_MAX_BYTES })
        if (text === null) continue
        let m: AgentMessage | null = null
        try {
          m = parseMessage(JSON.parse(text))
        } catch {
          m = null
        }
        if (!m || m.to !== agentId || name !== `${m.id}.json`) {
          console.warn(`messages: ${agentId}/${name} is not a message of this store — not served`)
          continue
        }
        this.inbox(agentId, true).set(m.id, m)
      }
    }
  }

  private inbox(agentId: string, create: true): Map<string, AgentMessage>
  private inbox(agentId: string, create?: false): Map<string, AgentMessage> | undefined
  private inbox(agentId: string, create = false): Map<string, AgentMessage> | undefined {
    let box = this.byAgent.get(agentId)
    if (!box && create) {
      box = new Map()
      this.byAgent.set(agentId, box)
    }
    return box
  }

  private fileOf(m: Pick<AgentMessage, 'to' | 'id'>): string {
    return join(this.dir, m.to, `${m.id}.json`)
  }

  // through the seal (copy → file → cache); without one, tmp + rename
  private persist(m: AgentMessage): void {
    const file = this.fileOf(m)
    mkdirSync(join(this.dir, m.to), { recursive: true, mode: 0o700 })
    const text = JSON.stringify(m, null, 2) + '\n'
    if (sealHooks().write?.(file, text, 0o600) === true) return
    const tmp = `${file}.tmp`
    writeFileSync(tmp, text, { mode: 0o600 })
    renameSync(tmp, file)
    try {
      chmodSync(file, 0o600)
    } catch {
      /* best effort */
    }
  }

  private drop(m: AgentMessage): void {
    const file = this.fileOf(m)
    if (sealHooks().remove?.(file) !== true) rmSync(file, { force: true })
    this.inbox(m.to)?.delete(m.id)
  }

  send(m: { from: string; to: string; text: string; replyTo?: string; run?: string; root?: 'mission' }): AgentMessage {
    if (!AGENT_ID.test(m.to)) throw new Error(`no inbox for «${m.to}»`)
    const msg: AgentMessage = {
      id: newId(),
      from: m.from,
      to: m.to,
      at: new Date(this.opts.now?.() ?? Date.now()).toISOString(),
      text: m.text,
      state: 'new',
      ...(m.replyTo !== undefined ? { replyTo: m.replyTo } : {}),
      ...(m.run !== undefined && m.run !== '' ? { run: m.run } : {}),
      ...(m.root === 'mission' ? { root: 'mission' as const } : {}),
    }
    this.persist(msg)
    this.inbox(msg.to, true).set(msg.id, msg)
    return { ...msg }
  }

  list(agentId: string, state?: AgentMessageState): AgentMessage[] {
    const box = this.inbox(agentId)
    if (!box) return []
    return [...box.values()]
      .filter((m) => state === undefined || m.state === state)
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
      .map((m) => ({ ...m }))
  }

  /** What `from` sent, across every inbox — the agent page's «Sent»
   *  (the store is keyed by recipient; this is the one read by sender). */
  sentBy(from: string): AgentMessage[] {
    const out: AgentMessage[] = []
    for (const box of this.byAgent.values()) for (const m of box.values()) if (m.from === from) out.push({ ...m })
    return out.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
  }

  get(agentId: string, id: string): AgentMessage | null {
    const m = this.inbox(agentId)?.get(id)
    return m ? { ...m } : null
  }

  /** A message by id, whatever inbox holds it (who
   *  sent it — a message of its own is no signal — and its root). */
  find(id: string): AgentMessage | null {
    for (const box of this.byAgent.values()) {
      const m = box.get(id)
      if (m) return { ...m }
    }
    return null
  }

  /** Every inbox's agent id (the ones holding at least one message). */
  agentIds(): string[] {
    return [...this.byAgent].filter(([, b]) => b.size > 0).map(([id]) => id)
  }

  // `answer` (already normalised — normalizeAnswer) rides along when given.
  setState(agentId: string, id: string, state: AgentMessageState, answer?: string): AgentMessage | null {
    return this.rewrite(agentId, id, (m) => ({ ...m, state, ...(answer !== undefined ? { answer } : {}) }))
  }

  /** the server marks `read` what a recipient's turn was served — only
   *  the ones still `new` (an answered one stays answered). The ids marked. */
  markRead(agentId: string, ids: Iterable<string>): string[] {
    const out: string[] = []
    for (const id of new Set(ids)) {
      const m = this.inbox(agentId)?.get(id)
      if (!m || m.state !== 'new') continue
      if (this.rewrite(agentId, id, (x) => ({ ...x, state: 'read' }))) out.push(id)
    }
    return out
  }

  /** the final readOutside of a run onto every message it
   *  sent (merged, deduplicated). How many changed. */
  restampRun(from: string, run: string, readOutside: readonly string[]): number {
    if (readOutside.length === 0) return 0
    let n = 0
    for (const box of this.byAgent.values()) {
      for (const m of [...box.values()]) {
        if (m.from !== from || m.run !== run) continue
        const merged = [...new Set([...(m.readOutside ?? []), ...readOutside])]
        if (merged.length === (m.readOutside?.length ?? 0)) continue
        if (this.rewrite(m.to, m.id, (x) => ({ ...x, readOutside: merged }))) n++
      }
    }
    return n
  }

  private rewrite(agentId: string, id: string, fn: (m: AgentMessage) => AgentMessage): AgentMessage | null {
    const m = this.inbox(agentId)?.get(id)
    if (!m) return null
    const next = fn({ ...m })
    this.persist(next)
    this.inbox(agentId, true).set(id, next)
    return { ...next }
  }

  /** «Keep the edit» of a message file (seals.ts onAdopt): the bytes the
   *  owner kept become the message the store serves. */
  adopt(bytes: Buffer, rel: string): void {
    let m: AgentMessage | null = null
    try {
      m = parseMessage(JSON.parse(bytes.toString('utf8')))
    } catch {
      m = null
    }
    if (!m || validateMessageFile(bytes, rel) !== null) return
    this.inbox(m.to, true).set(m.id, m)
  }

  // Every inbox, MESSAGE_KEEP_MS by default; one failing entry never stops
  // the rest.
  prune(now = Date.now(), keepMs = MESSAGE_KEEP_MS): { removed: number } {
    let removed = 0
    for (const box of this.byAgent.values()) {
      for (const m of [...box.values()]) {
        if (!PRUNABLE.includes(m.state)) continue
        try {
          const mtime = statSync(this.fileOf(m)).mtimeMs
          if (now - mtime <= keepMs) continue
          this.drop(m)
          removed++
        } catch {
          /* gone or unreadable — the next pass retries */
        }
      }
    }
    return { removed }
  }
}

// What waits in an inbox, for the overview: `new` = unread.
export function inboxCounts(list: readonly AgentMessage[]): { new: number } {
  return { new: list.filter((m) => m.state === 'new').length }
}

/** «replyTo names no message of yours»: a reply names a message the
 *  replier RECEIVED — one in its own inbox. */
export function replyToIsValid(store: Pick<MessageStore, 'get'>, replier: string, replyTo: string): boolean {
  return store.get(replier, replyTo) !== null
}
