// proposals.ts — what an agent PROPOSES and only the owner decides: an
// automation (the create body it may not send
// itself — a command, any recurring work outside its weekly think), a skill
// (held in $SILOS_AGENT_STATE/proposed/<name>/, outside the plugin) or a
// change to its own mission (always reviewed in the mission editor).
//
// Persisted in <dataDir>/proposals.json — a restore-sealed file: the
// store writes it through atomicWriteJson, which hands a sealed path to the
// seal. Memory is the truth while the server lives; an outside edit the
// owner keeps («Keep the edit») is reloaded, and THEN the inputHash stamped
// at registration catches an `input` that changed under it.
//
// The cap is PROPOSALS_PENDING_MAX per agent (limits.ts) — proposals sit
// OUTSIDE the weekly «one initiative»: the ledger counts creations,
// never proposals. A pending proposal expires at PROPOSAL_TTL_MS (the
// resident's tick, decidedBy 'silos'). Decided proposals are kept
// DECIDED_KEEP_MS (the agent hears the outcome in its packet; the owner's
// history), then dropped on the next write.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson, backupCorruptJson } from './json-store.js'
import { PROPOSAL_TTL_MS } from './limits.js'
import { MISSION_NEVER_ERROR, MISSION_NEVER_LINE_MAX, MISSION_NEVER_MAX_LINES, MISSION_TEXT_ERROR, MISSION_TEXT_MAX } from './mission.js'

export type ProposalKind = 'automation' | 'skill' | 'mission'
export type ProposalState = 'pending' | 'accepted' | 'dismissed' | 'expired'

export interface Proposal {
  id: string
  /** the proposing agent's id */
  by: string
  /** ISO */
  at: string
  /** the run of the unattended turn that proposed it — stamped by
   *  the SERVER from the turn token, never believed from the body */
  run?: string
  /** the conversation it was proposed in: the session id of the turn,
   *  stamped by the SERVER from the turn token like `run` — the column of
   *  that conversation shows it (GET /api/proposals?conversation=) */
  session?: string
  kind: ProposalKind
  /** one line, ≤ PROPOSAL_REASON_MAX */
  reason: string
  /** automation: the create body · skill: { name } — or { name, folder } for a
   *  change to the skill that project folder already has · mission: { text?, never? } */
  input: Record<string, unknown>
  state: ProposalState
  decidedAt?: string
  /** 'owner', the agent itself (it withdrew it), or 'silos' (expired, tainted) */
  decidedBy?: string
  /** what came of it: the automation id, the skill name, 'edited and saved
   *  by the owner', a dismiss reason, 'expired unanswered', 'tainted' */
  result?: string
  /** ISO — at + PROPOSAL_TTL_MS */
  expiresAt: string
  /** sha-256 of the canonical input, stamped at registration */
  inputHash: string
  /** skill: sha-256 of the names and bytes of every file of proposed/<name> */
  contentHash?: string
  /** a change to a project's skill: the same hash of the copy it replaces,
   *  as it was at propose — what the owner's diff is drawn against */
  baseHash?: string
  /** the end-of-turn audit's tools that read outside */
  readOutside?: string[]
  /** (R6) automation: the fields where it crosses the proposer's projects —
   *  a conversation trigger on an agent it does not know, a kept thread
   *  outside its folders, an http watch at an address that is not public —
   *  stamped at registration. A crossing proposal is a bridge the owner may
   *  grant: decided on its card (review), never by the one-tap accept */
  crosses?: string[]
}

export const PROPOSAL_KINDS: readonly ProposalKind[] = ['automation', 'skill', 'mission']
export const PROPOSAL_REASON_MAX = 300
export const PROPOSAL_DISMISS_REASON_MAX = 300
// an automation's create body, serialized (a create body is a few hundred bytes)
export const PROPOSAL_INPUT_MAX_BYTES = 16 * 1024
const DECIDED_KEEP_MS = 30 * 86_400_000
export const PROPOSAL_ID = /^[0-9a-f-]{36}$/

/** The skill slug — the only names a proposed skill may carry (a name is a
 *  path segment Silos will write under plugin/skills/). */
export const SKILL_SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/

// ---- the exact words ---------------------------------------------

export const KIND_ERROR = 'kind must be automation, skill or mission'
export const REASON_ERROR = 'reason required: one line saying why'
export const SKILL_SLUG_ERROR = 'skill name must be a slug: a-z, 0-9 and dashes'
export const PENDING_MAX_ERROR = (n: number): string => `${n} suggestions already wait for the owner — wait for a decision`
export const CHANGED_ERROR = 'it changed since it was proposed — review it again'
export const COMMAND_REVIEW_ERROR = 'it runs a command, not a prompt — review it in the automation editor'
export const CROSSING_REVIEW_ERROR = "it reaches outside the agent's projects — review it in the automation editor"
export const MISSION_REVIEW_ERROR = "a mission is the owner's text — review it in the mission editor"
export const SKILL_LINK_ERROR = 'the skill contains a link — only regular files load'
export const SKILL_CHANGED_ERROR = 'the skill changed since it was proposed — review it again'
export const SKILL_EXISTS_ERROR = (name: string): string => `a skill called ${name} exists already`
export const SKILL_FOLDER_ERROR = 'folder must be one of your own project folders — the one whose skill you change'
export const NO_PROJECT_SKILL_ERROR = (name: string): string => `that folder has no skill called ${name} — a new skill is proposed without "folder"`
export const SILOS_SKILL_ERROR = (name: string): string => `${name} is Silos' own skill — its copies follow Silos and are not changed in a project`
export const SKILL_SAME_ERROR = (name: string): string => `nothing changes: proposed/${name} is the same as the project's skill`
export const SKILL_BASE_CHANGED_ERROR = "the project's skill changed since it was proposed — review it again"
export const NO_SKILL_MD_ERROR = (name: string): string => `no SKILL.md at $SILOS_AGENT_STATE/proposed/${name}/SKILL.md`
export const ALREADY_ERROR = (state: ProposalState): string => `already ${state}`
export const REVIEW_RESULT = 'edited and saved by the owner'
export const EXPIRED_RESULT = 'expired unanswered'
export const TAINTED_RESULT = 'tainted'

// ---- input -----------------------------------------------------------------

// key-order-independent JSON: two inputs that say the same thing are equal
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

export function inputHashOf(input: unknown): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex')
}

/** The reason as one line: whitespace collapsed (a newline would break the
 *  row and the doorbell's single line). */
export function proposalReason(v: unknown): { reason: string } | { error: string } {
  if (typeof v !== 'string' || v.trim() === '') return { error: REASON_ERROR }
  const reason = v.replace(/\s+/g, ' ').trim()
  if (reason.length > PROPOSAL_REASON_MAX) return { error: `reason too long (${reason.length} > ${PROPOSAL_REASON_MAX} characters): one line` }
  return { reason }
}

export function isProposalKind(v: unknown): v is ProposalKind {
  return typeof v === 'string' && (PROPOSAL_KINDS as readonly string[]).includes(v)
}

/** A mission proposal's input: a full replacement of the field(s) it names
 *  — `text` and/or `never`, with parseMission's words. Normalized like the
 *  PATCH would store it. */
export function missionProposalInput(v: unknown): { input: { text?: string; never?: string[] } } | { error: string } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { error: MISSION_TEXT_ERROR }
  const o = v as Record<string, unknown>
  if (o.text === undefined && o.never === undefined) return { error: MISSION_TEXT_ERROR }
  const out: { text?: string; never?: string[] } = {}
  if (o.text !== undefined) {
    const text = typeof o.text === 'string' ? o.text.trim() : ''
    if (text.length < 1 || text.length > MISSION_TEXT_MAX) return { error: MISSION_TEXT_ERROR }
    out.text = text
  }
  if (o.never !== undefined) {
    if (!Array.isArray(o.never) || !o.never.every((l) => typeof l === 'string')) return { error: MISSION_NEVER_ERROR }
    const never = (o.never as string[]).map((l) => l.trim()).filter((l) => l !== '')
    if (never.length > MISSION_NEVER_MAX_LINES || never.some((l) => l.length > MISSION_NEVER_LINE_MAX || /[\r\n]/.test(l)))
      return { error: MISSION_NEVER_ERROR }
    out.never = never
  }
  return { input: out }
}

/** Whether an automation input runs a command (no Claude, no fence): no
 *  one-touch accept (S5) — judged on the raw input, like the create path. */
export function runsACommand(input: Record<string, unknown>): boolean {
  const run = input.run as { kind?: unknown } | null | undefined
  const trig = input.trigger as { kind?: unknown; check?: { type?: unknown } | null } | null | undefined
  return (
    (typeof run === 'object' && run !== null && run.kind === 'command') ||
    (typeof trig === 'object' &&
      trig !== null &&
      trig.kind === 'watch' &&
      typeof trig.check === 'object' &&
      trig.check !== null &&
      trig.check.type === 'command')
  )
}

/** The proposals whose accept is only «Review ›»: every mission, an
 *  automation that runs a command, and one that crosses the proposer's
 *  projects (R6 — the owner decides a bridge on its card). */
export function reviewOnly(p: Pick<Proposal, 'kind' | 'input' | 'crosses'>): boolean {
  return p.kind === 'mission' || (p.kind === 'automation' && (runsACommand(p.input) || (p.crosses?.length ?? 0) > 0))
}

// ---- the store ---------------------------------------------------------------

function isProposal(v: unknown): v is Proposal {
  if (!v || typeof v !== 'object') return false
  const p = v as Record<string, unknown>
  return (
    typeof p.id === 'string' &&
    typeof p.by === 'string' &&
    typeof p.at === 'string' &&
    typeof p.reason === 'string' &&
    isProposalKind(p.kind) &&
    !!p.input &&
    typeof p.input === 'object' &&
    !Array.isArray(p.input) &&
    (p.state === 'pending' || p.state === 'accepted' || p.state === 'dismissed' || p.state === 'expired') &&
    typeof p.expiresAt === 'string' &&
    typeof p.inputHash === 'string' &&
    (p.run === undefined || typeof p.run === 'string') &&
    (p.readOutside === undefined || (Array.isArray(p.readOutside) && p.readOutside.every((x) => typeof x === 'string'))) &&
    (p.crosses === undefined || (Array.isArray(p.crosses) && p.crosses.every((x) => typeof x === 'string')))
  )
}

export interface NewProposal {
  by: string
  kind: ProposalKind
  reason: string
  input: Record<string, unknown>
  run?: string
  session?: string
  contentHash?: string
  baseHash?: string
  crosses?: string[]
}

export class ProposalsStore {
  private items: Proposal[] = []
  readonly file: string

  constructor(
    dataDir: string,
    private now: () => number = () => Date.now(),
  ) {
    this.file = join(dataDir, 'proposals.json')
  }

  load(): void {
    this.items = []
    if (!existsSync(this.file)) return
    const text = readFileSync(this.file, 'utf8')
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      backupCorruptJson(this.file, text, 'proposals')
      return
    }
    const list = (raw as { proposals?: unknown } | null)?.proposals
    if (!Array.isArray(list)) return
    for (const p of list) {
      if (isProposal(p)) this.items.push(p)
      else console.warn('proposals: an entry was discarded (malformed)')
    }
  }

  /** newest first */
  list(): Proposal[] {
    return [...this.items].sort((a, b) => b.at.localeCompare(a.at))
  }

  pending(): Proposal[] {
    return this.list().filter((p) => p.state === 'pending')
  }

  get(id: string): Proposal | null {
    return this.items.find((p) => p.id === id) ?? null
  }

  /** The pending proposal of `by` of the same kind saying the same thing:
   *  the route answers it (200) instead of stacking a twin. */
  pendingTwin(by: string, kind: ProposalKind, inputHash: string): Proposal | null {
    return this.items.find((p) => p.state === 'pending' && p.by === by && p.kind === kind && p.inputHash === inputHash) ?? null
  }

  pendingCount(by: string): number {
    return this.items.filter((p) => p.state === 'pending' && p.by === by).length
  }

  add(n: NewProposal): Proposal {
    const at = this.now()
    const p: Proposal = {
      id: randomUUID(),
      by: n.by,
      at: new Date(at).toISOString(),
      ...(n.run !== undefined ? { run: n.run } : {}),
      ...(n.session !== undefined ? { session: n.session } : {}),
      kind: n.kind,
      reason: n.reason,
      input: n.input,
      state: 'pending',
      expiresAt: new Date(at + PROPOSAL_TTL_MS).toISOString(),
      inputHash: inputHashOf(n.input),
      ...(n.contentHash !== undefined ? { contentHash: n.contentHash } : {}),
      ...(n.baseHash !== undefined ? { baseHash: n.baseHash } : {}),
      ...(n.crosses !== undefined && n.crosses.length > 0 ? { crosses: [...n.crosses] } : {}),
    }
    this.items.push(p)
    this.save()
    return p
  }

  /** The input still hashes to what was stamped at registration. */
  inputIntact(p: Proposal): boolean {
    return inputHashOf(p.input) === p.inputHash
  }

  decide(id: string, state: Exclude<ProposalState, 'pending'>, decidedBy: string, result?: string): Proposal {
    const p = this.get(id)
    if (!p) throw new Error('proposal not found')
    p.state = state
    p.decidedAt = new Date(this.now()).toISOString()
    p.decidedBy = decidedBy
    if (result !== undefined && result !== '') p.result = result
    else delete p.result
    this.save()
    return p
  }

  /** The resident's tick: every pending proposal past its expiresAt
   *  is `expired`, decidedBy 'silos'. The count marked. */
  expireDue(now: number = this.now()): number {
    let n = 0
    const at = new Date(now).toISOString()
    for (const p of this.items) {
      if (p.state !== 'pending' || (Date.parse(p.expiresAt) || 0) > now) continue
      p.state = 'expired'
      p.decidedAt = at
      p.decidedBy = 'silos'
      p.result = EXPIRED_RESULT
      n++
    }
    if (n > 0) this.save()
    return n
  }

  // ---- «Review ›»: the editor the row opens carries the proposal's
  // id; its save resolves it. Checked BEFORE the save (so a stale or
  // changed proposal never rides it), resolved AFTER it succeeded. Closing
  // the editor without saving calls nothing: the proposal stays pending.

  reviewable(id: unknown, kind: ProposalKind, agentId: string): { ok: true; proposal: Proposal } | { ok: false; code: 400 | 404 | 409; error: string } {
    if (typeof id !== 'string' || !PROPOSAL_ID.test(id)) return { ok: false, code: 400, error: 'invalid proposal id' }
    const p = this.get(id)
    if (!p) return { ok: false, code: 404, error: 'proposal not found' }
    if (p.state !== 'pending') return { ok: false, code: 409, error: ALREADY_ERROR(p.state) }
    if (p.kind !== kind || p.by !== agentId) return { ok: false, code: 409, error: `that proposal is not a ${kind} of ${agentId}` }
    if (!this.inputIntact(p)) return { ok: false, code: 409, error: CHANGED_ERROR }
    return { ok: true, proposal: p }
  }

  resolveReviewed(id: string): Proposal | null {
    const p = this.get(id)
    if (!p || p.state !== 'pending') return null
    return this.decide(id, 'accepted', 'owner', REVIEW_RESULT)
  }

  // ---- the end-of-turn audit's hooks (wired by resident/runs.ts) ----

  /** Every proposal `agentId` made in `run`. */
  byRun(agentId: string, run: string): Proposal[] {
    return this.list().filter((p) => p.by === agentId && p.run === run)
  }

  /** The audit re-stamps: every proposal of the run gains the final
   *  `readOutside` (merged, deduplicated). The proposals touched. */
  restampRun(agentId: string, run: string, readOutside: readonly string[]): Proposal[] {
    if (readOutside.length === 0) return []
    const touched: Proposal[] = []
    for (const p of this.items) {
      if (p.by !== agentId || p.run !== run) continue
      const merged = [...new Set([...(p.readOutside ?? []), ...readOutside])]
      if (p.readOutside && merged.length === p.readOutside.length) continue
      p.readOutside = merged
      touched.push(p)
    }
    if (touched.length > 0) this.save()
    return touched
  }

  /** A tainted heartbeat run: its pending proposals are dismissed by
   *  Silos, result 'tainted'. The proposals dismissed. */
  dismissTainted(agentId: string, run: string): Proposal[] {
    const at = new Date(this.now()).toISOString()
    const out: Proposal[] = []
    for (const p of this.items) {
      if (p.by !== agentId || p.run !== run || p.state !== 'pending') continue
      p.state = 'dismissed'
      p.decidedAt = at
      p.decidedBy = 'silos'
      p.result = TAINTED_RESULT
      out.push(p)
    }
    if (out.length > 0) this.save()
    return out
  }

  private save(): void {
    const cutoff = this.now() - DECIDED_KEEP_MS
    this.items = this.items.filter((p) => p.state === 'pending' || (Date.parse(p.decidedAt ?? p.at) || 0) >= cutoff)
    atomicWriteJson(this.file, { proposals: this.items })
  }
}

// ---- the words the owner reads (server-computed; the web paints them) ---------

/** The proposal's outcome as the agent hears it in its packet. */
export function decidedWords(p: Proposal): string {
  const what = `your suggestion «${p.reason}»`
  if (p.state === 'expired') return `${what} expired unanswered — don't resend it without a new signal`
  if (p.state === 'accepted') return p.result === REVIEW_RESULT ? `${what} was accepted — ${REVIEW_RESULT}` : `${what} was accepted`
  if (p.decidedBy === p.by) return `${what} was withdrawn by you`
  if (p.decidedBy === 'silos' && p.result === TAINTED_RESULT) return `${what} was dismissed by Silos: it was written after reading outside`
  return p.result ? `${what} was dismissed: ${p.result}` : `${what} was dismissed`
}

/** « · written after reading the web (WebFetch)» — the audit's mark. */
export function readOutsideWords(tools: readonly string[] | undefined): string | null {
  return tools && tools.length > 0 ? `written after reading the web (${tools.join(', ')})` : null
}
