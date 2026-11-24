// titler.ts — auto-titles: the resident synthesizes channel-style
// titles (2-4 words, lowercase, distinctive — "invoice payments",
// "deploy vps") for sessions that only have their first sentence as a
// title. Verified against the real corpus: 0/1268 sessions carry Claude
// Code `summary` entries — there's nothing to read, so it's synthesized.
//
// Hard rules:
// - The owner's MANUAL rename is sacred: never overwritten (manual > auto
//   > raw precedence in session-store.titleResolver; the sweep doesn't
//   even consider sessions with a manual title).
// - LOW-priority sweep on the resident's heartbeat: a capped batch per
//   tick, a persisted daily cap, cooldown on rate limit — never a burst of
//   SDK calls.
// - Never titles a live session (activity in the last 5 min), a muted one,
//   or an ephemeral one.
// - Persisted progress (titler.json): a restart doesn't re-title or
//   retry without limit (max 2 attempts per session, tracked via `attempts`).
//
// Global kill switch: SILOS_NO_AUTOTITLES=1 (read in index.ts at startup —
// the titler simply isn't constructed). Only for harnesses/environments
// that must never touch the SDK (e.g. npm run e2e); not a product-facing setting.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { looksLikeRateLimit } from './fallback.js'
import { isEphemeralFolder } from './ephemeral.js'
import type { SessionIndex } from './session-index.js'
import type { SessionStore } from './session-store.js'
import type { SessionMeta } from './types.js'

const MAX_ATTEMPTS = 2
const DEFAULT_LIVE_MS = 5 * 60_000 // titler's isLive: a recent mtime = an active session, don't touch
const DEFAULT_BATCH_MAX = 3 // per sweep — avoids bursts on the heartbeat
// The daily cap bounds real SDK CALLS, not titles written — every attempt
// (success, invalid output, or error) consumes budget. It's the only
// semantics that actually bounds cost/activity: a persistent error that
// looksLikeRateLimit doesn't recognize (broken auth, 529, missing binary)
// stays capped at 30 spawns/day instead of 3 every 30s.
const DEFAULT_DAILY_CAP = 30
const COOLDOWN_MS = 15 * 60_000 // after an SDK rate limit: not one more attempt until it passes
// A candidate with no complete exchange yet (excerpt null) doesn't consume
// a batch slot, but shouldn't be re-read on every sweep either — it's
// marked with a re-evaluable backoff (in memory: a restart only costs one
// re-read per session). If mtime changes, it's re-evaluated immediately.
const EXCERPT_BACKOFF_MS = 6 * 3600_000
// I/O cap per sweep — since excerptOf reads the whole JSONL, a pathological
// corpus (many unviable candidates still without backoff) must not be able
// to turn a tick into a full disk scan.
const EXAMINE_CAP = 30
const EXCERPT_CAP = 1500
const SIBLINGS_CAP = 30
const TITLE_MAX_CHARS = 40
const TITLE_MAX_WORDS = 6
// Prefix for the generator's own tmpdirs — the sweep's filter excludes it
// UNCONDITIONALLY (regardless of SILOS_NO_EPHEMERAL): if the ephemeral rule
// is off and helper sessions enter the index, they must never become
// candidates (a self-feeding loop).
export const TITLER_TMP_PREFIX = 'silos-titler-'

// Sanitizes the model's output into a channel-style SLUG (like
// #the-things-in-my-house — the fewest words that still reference the
// topic, joined by hyphens; reads more "topic" than text with spaces).
// Returns null (= rejected, counts as a failed attempt) if the model didn't
// comply: multiline, more than TITLE_MAX_WORDS segments, or nothing useful
// after cleanup. Normalizes: strips #, quotes, emoji, Unicode control
// chars; lowercases; spaces and punctuation → hyphens; collapsed hyphens
// with none at the start/end; capped at 40 chars. Unicode letters/digits
// are kept (á, ñ… are valid in a slug); only separators get hyphenated.
export function sanitizeTitle(raw: string): string | null {
  let t = raw.trim()
  if (t === '') return null
  if (/[\r\n]/.test(t)) return null // multiline = an explanation, not a title
  t = t.replace(/\p{Extended_Pictographic}|\u{FE0F}/gu, '') // a channel has no emoji (nor a stray VS16)
  // Also strip flags (regional indicators — 🇪🇸 isn't Extended_Pictographic)
  // and EVERY Unicode control/format character: bidi overrides (U+202E can
  // invert/spoof the title in the sidebar and ⌘K), zero-widths
  // (U+200B/U+200C/U+2060 would make titles look "empty" while passing the
  // empty check), and ZWJ (covered by Cf).
  t = t.replace(/[\u{1F1E6}-\u{1F1FF}]|\p{Cf}|\p{Cc}/gu, '')
  t = t.replace(/^#+\s*/, '')
  t = t.toLowerCase()
  // kebab-case — anything that isn't a Unicode letter/digit becomes a
  // hyphen (spaces, quotes, punctuation, symbols), hyphens collapsed and
  // trimmed from both ends. `\p{L}`/`\p{N}` preserve accents and ñ.
  t = t.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')
  if (t === '') return null
  if (t.split('-').length > TITLE_MAX_WORDS) return null
  if (t.length > TITLE_MAX_CHARS) {
    // trim at a hyphen so we don't leave a word cut in half
    t = t
      .slice(0, TITLE_MAX_CHARS)
      .replace(/-+[^-]*$/, '')
      .replace(/-+$/, '')
  }
  return t === '' ? null : t
}

export interface TitleInput {
  excerpt: string // the user's first ~2 messages + the first reply, trimmed
  siblings: string[] // titles already in use by the same agent — the new one must be distinct
}
// Injectable: tests NEVER call the real SDK — they pass a fake.
export type GenerateTitle = (input: TitleInput) => Promise<string>

interface TitlerState {
  day: string // YYYY-MM-DD of the daily counter
  // Real SDK CALLS today (not titles written) — see DEFAULT_DAILY_CAP.
  // Incremented before each call's result is known.
  countToday: number
  // ONLY invalid model outputs (sanitizeTitle → null) consume attempts — an
  // SDK/env/rate-limit error never does: that budget exists for "the model
  // doesn't comply with this content", not for infrastructure hiccups that
  // would blacklist sessions the model never actually saw.
  attempts: Record<string, number> // "folder/id" → invalid outputs (capped at MAX_ATTEMPTS, no expiry)
  // PERSISTED cooldown — with tsx watch every save restarts the process; an
  // in-memory-only cooldown would be wiped and every restart would burn
  // another call against a still-active limit.
  cooldownUntil?: string // ISO
}

export interface TitlerDeps {
  index: SessionIndex
  store: SessionStore
  dataDir: string
  generateTitle: GenerateTitle
  // Same classification as server.ts/resident.ts (native-owner rules, else
  // classify by cwd/skills) — to gather the agent's sibling titles.
  classifyAgentId: (m: SessionMeta) => string
  now?: () => Date
  // Belt and suspenders: the index already excludes muted and ephemeral
  // sessions (SessionIndex.shouldSkip), but no path in THIS module should
  // be able to title one even if the index changed.
  muted?: readonly string[]
  ephemeralPrefix?: string | null
  // Whether Silos gave birth to the session (an automation run or a
  // message conversation — session-origins.ts). The daily cap is spent on
  // the owner's own conversations first; these come after them in each
  // sweep. Absent: every session is the owner's.
  bornOfSilos?: (m: SessionMeta) => boolean
  liveMs?: number
  batchMax?: number
  dailyCap?: number
}

export class Titler {
  private sweeping = false
  // Re-evaluable backoff for candidates with no complete exchange yet
  // (excerpt null) — they don't consume a batch slot, but also aren't
  // re-read on every sweep. In-memory on purpose: a restart only costs one
  // re-read per session, nothing that deserves disk. If mtime changes it's
  // re-evaluated right away.
  private excerptBackoff = new Map<string, { until: number; mtime: number }>()
  private stateFile: string
  private now: () => Date
  private muted: Set<string>
  private ephemeralPrefix: string | null
  private liveMs: number
  private batchMax: number
  private dailyCap: number

  constructor(private deps: TitlerDeps) {
    this.stateFile = join(deps.dataDir, 'titler.json')
    this.now = deps.now ?? (() => new Date())
    this.muted = new Set(deps.muted ?? [])
    this.ephemeralPrefix = deps.ephemeralPrefix ?? null
    this.liveMs = deps.liveMs ?? DEFAULT_LIVE_MS
    this.batchMax = deps.batchMax ?? DEFAULT_BATCH_MAX
    this.dailyCap = deps.dailyCap ?? DEFAULT_DAILY_CAP
  }

  // One sweep: picks candidates (no manual or auto title, at least one
  // exchange, not live), most recent first, and synthesizes titles until a
  // batch of batchMax real CALLS fills up. Returns how many got titled
  // (for tests). Reentrancy and intervals: the `sweeping` flag keeps a long
  // sweep from overlapping with the next tick; the persisted cooldown cuts
  // everything off after a rate limit.
  async sweep(now = this.now()): Promise<number> {
    if (this.sweeping) return 0
    this.sweeping = true
    try {
      return await this.doSweep(now)
    } finally {
      this.sweeping = false
    }
  }

  private async doSweep(now: Date): Promise<number> {
    const state = this.readState(now)
    // Cooldown read from PERSISTED state — survives restarts.
    if (state.cooldownUntil !== undefined) {
      if (new Date(state.cooldownUntil).getTime() > now.getTime()) return 0
      delete state.cooldownUntil // expired — cleared on the next write
    }
    const remaining = this.dailyCap - state.countToday
    if (remaining <= 0) return 0

    const manual = this.deps.store.titleOverrides()
    const autoTitles = this.deps.store.autoTitles()
    const all = this.deps.index.allSessions()
    // Prune orphaned marks (trashed sessions) — only once the index is
    // warm: during warmup allSessions() is empty and we'd prune legitimate marks.
    if (this.deps.index.isReady()) this.pruneOrphans(state, all)

    const candidates = all
      .filter((m) => {
        const key = `${m.folder}/${m.id}`
        if (manual[key] !== undefined) return false // a manual title is sacred, not even looked at
        if (autoTitles[key] !== undefined) return false // already titled
        if ((state.attempts[key] ?? 0) >= MAX_ATTEMPTS) return false // the model failed to comply twice: leave it alone
        if (now.getTime() - m.mtime < this.liveMs) return false // a live session: never title it while hot
        if (m.turnCount < 2) return false // at least one user+assistant exchange is required
        // The generator's OWN helper sessions are never candidates —
        // unconditional, even if the ephemeral rule is off
        // (SILOS_NO_EPHEMERAL) and they entered the index. Without this:
        // titling the helper creates another helper → a self-feeding loop.
        if (m.folder.includes(TITLER_TMP_PREFIX)) return false
        if (this.muted.has(m.folder)) return false
        if (this.ephemeralPrefix !== null && isEphemeralFolder(m.folder, this.ephemeralPrefix)) return false
        return true
      })
      // the owner's conversations first, then what Silos opened (runs,
      // message conversations); most recent activity first within each
      .sort((a, b) => {
        const sa = this.deps.bornOfSilos?.(a) ? 1 : 0
        const sb = this.deps.bornOfSilos?.(b) ? 1 : 0
        return sa - sb || b.mtime - a.mtime
      })

    // The batch fills up with VIABLE candidates — one with no complete
    // exchange (excerpt null) doesn't consume a slot: previously, 3 recent
    // unviable ones would hog the slice and the older backlog would be
    // starved forever (0 calls, 0 titles, silently).
    const batchSize = Math.min(this.batchMax, remaining)
    let titled = 0
    let called = 0
    let examined = 0
    for (const m of candidates) {
      if (called >= batchSize) break
      if (examined >= EXAMINE_CAP) break // I/O cap per sweep
      const key = `${m.folder}/${m.id}`
      const back = this.excerptBackoff.get(key)
      if (back !== undefined && back.mtime === m.mtime && now.getTime() < back.until) continue
      examined += 1

      let excerpt: string | null
      try {
        excerpt = await this.excerptOf(m.folder, m.id)
      } catch {
        excerpt = null
      }
      // No real exchange yet (or an unreadable JSONL mid-write): neither a
      // batch slot nor an attempt — a re-evaluable backoff, move to the next candidate.
      if (excerpt === null) {
        this.excerptBackoff.set(key, { until: now.getTime() + EXCERPT_BACKOFF_MS, mtime: m.mtime })
        continue
      }
      this.excerptBackoff.delete(key)

      const siblings = this.siblingTitles(m, all, manual, autoTitles)
      // The CALL consumes the daily budget — tracked BEFORE the result is
      // known (a crash mid-call already counted).
      called += 1
      state.countToday += 1
      this.writeState(state)
      let raw: string
      try {
        raw = await this.deps.generateTitle({ excerpt, siblings })
      } catch (err) {
        // An error (SDK/env/rate limit) does NOT consume the session's
        // attempts — the model never saw its content. Cost stays bounded
        // by the daily call cap and, if it smells like a rate limit, by
        // the persisted cooldown.
        const msg = err instanceof Error ? err.message : String(err)
        if (looksLikeRateLimit(msg)) {
          state.cooldownUntil = new Date(now.getTime() + COOLDOWN_MS).toISOString()
          this.writeState(state)
          break
        }
        continue
      }

      const title = sanitizeTitle(raw)
      if (title === null) {
        // an invalid output from the MODEL: this does consume an attempt (max 2).
        state.attempts[key] = (state.attempts[key] ?? 0) + 1
        this.writeState(state)
        continue
      }

      this.deps.store.setAutoTitle(m.folder, m.id, title)
      autoTitles[key] = title // the next candidates in this pass see it as a sibling
      delete state.attempts[key]
      this.writeState(state)
      titled += 1
    }
    return titled
  }

  // Marks for sessions that no longer exist in the index (trashed) — out,
  // so titler.json and the backoff don't grow without bound. Only
  // called with the index warm (see doSweep).
  private pruneOrphans(state: TitlerState, all: SessionMeta[]): void {
    const keys = new Set(all.map((m) => `${m.folder}/${m.id}`))
    let changed = false
    for (const k of Object.keys(state.attempts)) {
      if (!keys.has(k)) {
        delete state.attempts[k]
        changed = true
      }
    }
    for (const k of [...this.excerptBackoff.keys()]) {
      if (!keys.has(k)) this.excerptBackoff.delete(k)
    }
    if (changed) this.writeState(state)
  }

  // The user's first ~2 messages + the assistant's first reply, in
  // transcript order, trimmed to EXCERPT_CAP. null if the session doesn't
  // have a complete exchange yet (user AND assistant with text).
  private async excerptOf(folder: string, id: string): Promise<string | null> {
    const turns = await this.deps.index.readTurns(folder, id)
    const parts: string[] = []
    let users = 0
    let assistants = 0
    for (const t of turns) {
      if (t.text.trim() === '') continue
      // A message from ANOTHER session (interSession) carries role:'user'
      // but isn't the owner's ask — labeling it "User: …" would hand the
      // title generator words the owner never said (and would contradict
      // the invariant "a peer never sets the title", which the heuristic
      // path already upholds). Skipped entirely.
      if (t.interSession) continue
      if (t.role === 'user' && users < 2) {
        parts.push(`User: ${t.text.trim().slice(0, 600)}`)
        users += 1
      } else if (t.role === 'assistant' && assistants < 1) {
        parts.push(`Assistant: ${t.text.trim().slice(0, 600)}`)
        assistants += 1
      }
      if (users >= 2 && assistants >= 1) break
    }
    if (users === 0 || assistants === 0) return null
    return parts.join('\n').slice(0, EXCERPT_CAP)
  }

  // Effective titles (manual ?? auto) of the rest of the SAME agent's
  // sessions — the prompt asks the model to distinguish itself from them.
  private siblingTitles(m: SessionMeta, all: SessionMeta[], manual: Record<string, string>, autoTitles: Record<string, string>): string[] {
    const agentId = this.deps.classifyAgentId(m)
    const out = new Set<string>()
    for (const s of all) {
      if (s.folder === m.folder && s.id === m.id) continue
      const key = `${s.folder}/${s.id}`
      const t = manual[key] ?? autoTitles[key]
      if (t === undefined) continue
      if (this.deps.classifyAgentId(s) !== agentId) continue
      out.add(t)
      if (out.size >= SIBLINGS_CAP) break
    }
    return [...out]
  }

  // ---- persisted state (daily counter + attempts) -------------------------

  private readState(now: Date): TitlerState {
    const day = now.toISOString().slice(0, 10)
    let s: TitlerState = { day, countToday: 0, attempts: {} }
    try {
      if (existsSync(this.stateFile)) {
        const raw = JSON.parse(readFileSync(this.stateFile, 'utf8')) as Partial<TitlerState>
        s = {
          day: typeof raw.day === 'string' ? raw.day : day,
          countToday: typeof raw.countToday === 'number' ? raw.countToday : 0,
          attempts: raw.attempts && typeof raw.attempts === 'object' ? raw.attempts : {},
          // the cooldown travels with the state — a restart doesn't erase it
          ...(typeof raw.cooldownUntil === 'string' ? { cooldownUntil: raw.cooldownUntil } : {}),
        }
      }
    } catch {
      /* corrupt → start fresh (worst case: over-titling for one extra day) */
    }
    // day change: the daily counter resets; failed attempts do NOT (a
    // session whose output was invalid twice isn't retried the next day)
    // and neither does the cooldown (it's an absolute window).
    if (s.day !== day) {
      s = { day, countToday: 0, attempts: s.attempts, ...(s.cooldownUntil !== undefined ? { cooldownUntil: s.cooldownUntil } : {}) }
    }
    return s
  }

  private writeState(s: TitlerState): void {
    const tmp = this.stateFile + '.tmp'
    writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n')
    renameSync(tmp, this.stateFile)
  }
}
