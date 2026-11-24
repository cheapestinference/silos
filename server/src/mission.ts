// mission.ts — the agent's mission (R3):
// why it acts, in the owner's words — a text and the «Never» lines it must
// always ask about first. ONE field replaces role, the old charter
// (systemAppend) and, from t3 on, the responsibility. The owner writes it
// (PATCH /api/agents/:id — owner-only: an agent bearer never writes agents,
// and agents.json is fenced); it reaches EVERY conversation of both engines
// as the system append (chat-service.ts appendFor → systemAppendFor: SDK
// systemPrompt.append, the console's --append-system-prompt-file, OpenCode's
// per-process `instructions`).
//
// One source for: the shape and its exact 400 words, the header the append
// renders (the heartbeat prompt reuses it) and
// the first sentence the fleet roster says (roster-text.ts — its Python
// twin, plugin/hooks/roster.py, carries the same regex).

export interface Mission {
  text: string
  never: string[]
  updatedAt: string
}

export const MISSION_TEXT_MAX = 2000
export const MISSION_NEVER_MAX_LINES = 10
export const MISSION_NEVER_LINE_MAX = 200

export const MISSION_TEXT_ERROR = `mission.text must be 1–${MISSION_TEXT_MAX} characters`
export const MISSION_NEVER_ERROR = `mission.never must be up to ${MISSION_NEVER_MAX_LINES} lines of up to ${MISSION_NEVER_LINE_MAX} characters`

/** A mission as the API receives it ({ text, never? }), validated and
 *  normalized: text trimmed, «Never» lines trimmed with empty ones dropped.
 *  Throws the exact 400 words. `null` passes through (PATCH: clear it). */
export function parseMission(v: unknown, now: Date = new Date()): Mission | null {
  if (v === null) return null
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error(MISSION_TEXT_ERROR)
  const o = v as Record<string, unknown>
  const text = typeof o.text === 'string' ? o.text.trim() : ''
  if (text.length < 1 || text.length > MISSION_TEXT_MAX) throw new Error(MISSION_TEXT_ERROR)
  let never: string[] = []
  if (o.never !== undefined) {
    if (!Array.isArray(o.never) || !o.never.every((l) => typeof l === 'string')) throw new Error(MISSION_NEVER_ERROR)
    never = (o.never as string[]).map((l) => l.trim()).filter((l) => l !== '')
    // a line is ONE line: an embedded newline would dodge the 10-line cap
    if (never.length > MISSION_NEVER_MAX_LINES || never.some((l) => l.length > MISSION_NEVER_LINE_MAX || /[\r\n]/.test(l))) throw new Error(MISSION_NEVER_ERROR)
  }
  return { text, never, updatedAt: now.toISOString() }
}

/** The mission as every conversation hears it — the head of the system
 *  append (its first two lines). The «Never» line exists only when the
 *  owner wrote one. */
export function missionHeader(m: Mission): string {
  const lines = [`Your mission: ${m.text}`]
  if (m.never.length > 0) lines.push(`Never, without the owner's word:\n${m.never.map((l) => `- ${l}`).join('\n')}`)
  return lines.join('\n')
}

/** The first sentence of a mission text, whitespace collapsed — what the
 *  fleet roster says after an agent's name. The whole (collapsed) text when
 *  it has no sentence end. Twin of roster.py's first_sentence. */
export function firstSentence(text: string): string {
  const s = text.split(/\s+/).filter(Boolean).join(' ')
  const m = /^(.+?[.!?])(?=\s|$)/.exec(s)
  return m ? m[1]! : s
}

/** Two missions say the same thing (text and rules, in order). */
export function sameMission(a: Pick<Mission, 'text' | 'never'> | null | undefined, b: Pick<Mission, 'text' | 'never'> | null | undefined): boolean {
  if (!a || !b) return !a && !b
  return a.text === b.text && a.never.length === b.never.length && a.never.every((l, i) => l === b.never[i])
}

/** A mission as READ from agents.json — the file is also written by hand
 *  (the owner writes missions right after t2): a missing `never`, an
 *  untrimmed text or a stray shape must never crash a turn or a screen.
 *  Normalized: text trimmed, `never` = its non-empty trimmed string lines,
 *  `updatedAt` kept or ''. Null when there is no usable text. */
export function normalizeStoredMission(v: unknown): Mission | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const text = typeof o.text === 'string' ? o.text.trim() : ''
  if (text === '') return null
  const never = Array.isArray(o.never)
    ? o.never
        .filter((l): l is string => typeof l === 'string')
        .map((l) => l.trim())
        .filter((l) => l !== '')
    : []
  return { text, never, updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : '' }
}
