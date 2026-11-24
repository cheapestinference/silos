// asks-store.ts — OpenCode agents' permission questions, read and answered.
//
// The OpenCode plugin (plugin-opencode/silos.ts) writes every permission
// question as agent-state/<agent>/asks/<sessionId>/<permissionId>.json and
// polls for the owner's answer, which Silos writes OUT of the agent's reach:
// <dataDir>/asks-replies/<agent>/<sessionId>/<permissionId>.reply.json (0600
// in 0700 dirs; `asks-replies` is fenced — territory.ts DATA_DIR_DENIED).
// The agent's own state dir is writable by the agent (the fence allows its
// own dir for edit), so a reply there would let it approve its own asks.
// The plugin learns its reply dir from SILOS_ASKS_REPLIES (launch.ts envFor,
// both engines) and reads it with fs directly. It answers OpenCode and
// deletes both files; an answer given in the TUI deletes the ask file. File-
// borne, zero tokens — the same channel shape as births-store.ts.
//
// An ask whose reply already waits in the reply dir is answered (the plugin
// just hasn't picked it up yet): it is no longer pending. A reply file with
// no ask is stale and never counts; one planted beside the ask in the
// agent's own dir is never read. If the plugin's answer to OpenCode fails it
// deletes only the reply, so the ask shows again and can be answered again.
//
// Questions (OpenCode's `question` tool, its AskUserQuestion) ride the same
// channel: an ask of type 'question' carries its `questions` and the tool
// `callId`; its answer is `{status:'answer', answers}` — one label list per
// question — or `{status:'deny'}` (rejected), never 'allow'. A permission ask
// takes only allow/deny. The reader drops a question whose tool call is no
// longer waiting in the DB (its process died), so none lingers.
//
// Trust: an agent can write anything under its own state dir, so an ask
// counts only for the agent whose directory holds it, and only when the ids
// inside agree with the path. Ids are path segments: the regex below is the
// one the plugin and the reply route apply.
import { readdirSync } from 'node:fs'
import { sealHooks } from './seal-hooks.js'
import { join } from 'node:path'
import { containedAgentDir } from './contained-dir.js'
import { AlreadyExistsError, ContainmentError, listContained, readContainedTextOrNull, writeContained } from './safe-file.js'
import type { AgentStateStore } from './agent-state.js'

export const ASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/** What Silos reads of one ask file (safe-file.ts reads name a cap): ten
 *  questions with their options fit many times over; past it, no ask. */
export const ASK_MAX_BYTES = 256 * 1024

/** The data-dir entry holding the owner's answers (fenced for every agent). */
export const ASKS_REPLIES_DIR = 'asks-replies'

/** One agent's reply root — what its OpenCode process gets as SILOS_ASKS_REPLIES. */
export function asksRepliesDir(dataDir: string, agentId: string): string {
  return join(dataDir, ASKS_REPLIES_DIR, agentId)
}

export interface AskQuestion {
  question: string
  header: string
  options: { label: string; description: string }[]
  multiple?: boolean
}

export interface PendingAsk {
  agentId: string
  sessionId: string
  id: string
  type: string
  pattern: string | null
  title: string | null
  askedAt: string
  /** type 'question' only: what OpenCode asks, and its tool call */
  questions?: AskQuestion[]
  callId?: string | null
}

/** Permission asks take allow/deny; question asks take answers or deny. */
export type AskReply = 'allow' | 'deny' | { answers: string[][] }

/** Answers Silos accepts for a question: one non-empty list of short
 *  strings per question, as many lists as questions. */
export function validAnswers(answers: unknown, questions: number): answers is string[][] {
  return (
    Array.isArray(answers) &&
    answers.length === questions &&
    questions > 0 &&
    answers.every((a) => Array.isArray(a) && a.length > 0 && a.length <= 20 && a.every((x) => typeof x === 'string' && x.trim() !== '' && x.length <= 2000))
  )
}

function questionsOf(raw: unknown): AskQuestion[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 10) return null
  const out: AskQuestion[] = []
  for (const q of raw) {
    const o = q as Record<string, unknown> | null
    if (!o || typeof o.question !== 'string' || o.question.trim() === '' || !Array.isArray(o.options)) return null
    const options: AskQuestion['options'] = []
    for (const x of o.options) {
      const opt = x as Record<string, unknown> | null
      if (!opt || typeof opt.label !== 'string') return null
      options.push({ label: opt.label, description: typeof opt.description === 'string' ? opt.description : '' })
    }
    out.push({ question: o.question, header: typeof o.header === 'string' ? o.header : '', options, ...(o.multiple === true ? { multiple: true } : {}) })
  }
  return out
}
/** reply(): written · bad input · the ask is gone · a reply already waits (first wins) */
export type ReplyResult = 'ok' | 'invalid' | 'missing' | 'answered'

// The plain line for an ask: its own title, else what it wants to run.
export function askLine(a: Pick<PendingAsk, 'title' | 'type' | 'pattern'>): string {
  return a.title ?? `${a.type} ${a.pattern ?? ''}`.trim()
}

const REPLY_SUFFIX = '.reply.json'

function parseAsk(text: string, agentId: string, sessionId: string, id: string): PendingAsk | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (o.id !== id || o.sessionId !== sessionId || typeof o.type !== 'string' || typeof o.askedAt !== 'string') return null
  // OpenCode's v2 event carries `patterns` (an array): one line for the owner
  const pattern =
    typeof o.pattern === 'string' ? o.pattern : Array.isArray(o.pattern) && o.pattern.every((p) => typeof p === 'string') ? o.pattern.join(' ') : null
  const title = typeof o.title === 'string' && o.title.trim() !== '' ? o.title : null
  if (o.type === 'question') {
    const questions = questionsOf(o.questions)
    if (!questions) return null
    const callId = typeof o.callId === 'string' && o.callId !== '' ? o.callId : null
    return { agentId, sessionId, id, type: 'question', pattern: null, title: title ?? questions[0]!.question, askedAt: o.askedAt, questions, callId }
  }
  return { agentId, sessionId, id, type: o.type, pattern: pattern === '' ? null : pattern, title, askedAt: o.askedAt }
}

export class AsksStore {
  private cache: PendingAsk[] = []
  private checkedAt = -Infinity
  private ttlMs: number
  private dataDir: string

  constructor(
    private agentState: AgentStateStore,
    opts: { dataDir: string; ttlMs?: number },
  ) {
    this.dataDir = opts.dataDir
    this.ttlMs = opts.ttlMs ?? 1000
  }

  /** Every pending ask across agents, newest first. */
  all(): PendingAsk[] {
    this.refresh()
    return this.cache
  }

  forSession(sessionId: string): PendingAsk[] {
    return this.all().filter((a) => a.sessionId === sessionId)
  }

  /**
   * Writes the owner's answer for the plugin to pick up:
   * `<dataDir>/asks-replies/<agent>/<session>/<id>.reply.json` `{ status, at }`, 0600. Nothing is written when a segment is unsafe or
   * the status unknown ('invalid'), when the ask itself is gone — answered
   * in the TUI, timed out, never existed ('missing') — or when a reply
   * already waits beside it ('answered': the first answer wins, linked into
   * place from a temp file so two racing answers cannot both land).
   */
  reply(agentId: string, sessionId: string, id: string, status: AskReply): ReplyResult {
    if (![agentId, sessionId, id].every((s) => ASK_ID.test(s))) return 'invalid'
    // the agent's OWN ask, read through safe-file.ts: a linked asks/ (into
    // another agent's state), a link or hard link at the file — all missing
    const text = this.agentState.readOwnText(agentId, ['asks', sessionId], `${id}.json`, { maxBytes: ASK_MAX_BYTES })
    if (text === null) return 'missing'
    const ask = parseAsk(text, agentId, sessionId, id)
    if (!ask) return 'invalid'
    // a question is answered or rejected, never «allowed»; a permission is
    // allowed or denied, never given answers
    const body =
      ask.type === 'question'
        ? status === 'deny'
          ? { status: 'deny' }
          : typeof status === 'object' && validAnswers(status.answers, ask.questions!.length)
            ? { status: 'answer', answers: status.answers }
            : null
        : status === 'allow' || status === 'deny'
          ? { status }
          : null
    if (!body) return 'invalid'
    // every level 0700 (asks-replies, the agent's, the session's): only
    // Silos — but the agent's Bash can reach it, so the dir is resolved as
    // the agent's OWN (containedAgentDir: never a link into another agent's
    // replies or anywhere else) and the reply lands exclusively through
    // safe-file.ts: the first answer wins, two racing answers never both land
    try {
      const dir = containedAgentDir(join(this.dataDir, ASKS_REPLIES_DIR), agentId, [sessionId], { create: true, mode: 0o700 })!
      // asks-replies is under a restore seal (seals.ts): copy
      // first, the file, then the cache — a reply nobody but Silos wrote is held
      const text = JSON.stringify({ ...body, at: new Date().toISOString() })
      const file = join(dir, `${id}${REPLY_SUFFIX}`)
      sealHooks().stage?.(file, text)
      try {
        writeContained(dir, `${id}${REPLY_SUFFIX}`, text, { mode: 0o600, exclusive: true })
      } catch (err) {
        sealHooks().abort?.(file)
        throw err
      }
      sealHooks().commit?.(file)
    } catch (err) {
      if (err instanceof AlreadyExistsError) return 'answered'
      if (err instanceof ContainmentError) {
        console.warn(`asks: refused to write the reply for ${agentId}/${sessionId}/${id}: ${err.message}`)
        return 'invalid'
      }
      throw err
    }
    this.checkedAt = -Infinity // the owner's own answer never lingers in a cached scan
    return 'ok'
  }

  private refresh(): void {
    const now = Date.now()
    if (this.ttlMs > 0 && now - this.checkedAt < this.ttlMs) return
    this.checkedAt = now
    const out: PendingAsk[] = []
    for (const agentId of this.agentState.agentIdsOnDisk()) {
      // only the agent's OWN asks dir (safe-file.ts): a linked asks/ or a
      // linked session dir reads as no asks, a linked/hard-linked file as none
      const root = this.agentState.verifiedDir(agentId, ['asks'])
      const sessions = listContained(root).filter((n) => ASK_ID.test(n))
      for (const sessionId of sessions) {
        const sdir = this.agentState.verifiedDir(agentId, ['asks', sessionId])
        const names = listContained(sdir)
        if (sdir === null) continue
        // answered = a reply waits in the Silos-owned dir (never beside the ask)
        let replied: Set<string>
        try {
          replied = new Set(readdirSync(join(asksRepliesDir(this.dataDir, agentId), sessionId)))
        } catch {
          replied = new Set()
        }
        for (const name of names) {
          if (!name.endsWith('.json') || name.endsWith(REPLY_SUFFIX)) continue
          const id = name.slice(0, -'.json'.length)
          if (!ASK_ID.test(id) || replied.has(`${id}${REPLY_SUFFIX}`)) continue
          const text = readContainedTextOrNull(sdir, name, { maxBytes: ASK_MAX_BYTES })
          if (text === null) continue // answered and deleted between the listing and the read, or refused
          const ask = parseAsk(text, agentId, sessionId, id)
          if (ask) out.push(ask)
        }
      }
    }
    this.cache = out.sort((a, b) => b.askedAt.localeCompare(a.askedAt))
  }
}
