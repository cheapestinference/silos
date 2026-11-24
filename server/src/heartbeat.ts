// heartbeat.ts — the heartbeat's clock: ONE automation per agent that
// is On its own with a
// period (not never) —
// `heartbeat-<id>`, «X's heartbeat», origin:'heartbeat' — DERIVED from
// Agent.heartbeat by reconcile() (the resident's tick and the agent PATCH),
// which creates it, re-points it, and deletes it when the agent goes told,
// never, archived, or its derived control falls to told (no territory, no
// mission — controlOf). The automation's shape is Silos': its trigger,
// prompt, thread, agent, run, hooks and pause are refused on PATCH with
// words that name the one place they are set (the agent's page), and so is
// its DELETE (reconcile would bring it back).
import { isDeepStrictEqual } from 'node:util'
import type { AutomationsStore } from './automations-store.js'
import type { Automation } from './automations-types.js'
import { controlOf, heartbeatOf, type Heartbeat } from './control.js'
import type { Period } from './period.js'
import type { Agent } from './types.js'

export const HEARTBEAT_PREFIX = 'heartbeat-'
export function heartbeatAutomationId(agentId: string): string {
  return `${HEARTBEAT_PREFIX}${agentId}`
}
export function isHeartbeat(a: Pick<Automation, 'id' | 'origin'>): boolean {
  return a.origin === 'heartbeat' || a.id.startsWith(HEARTBEAT_PREFIX)
}
// a fresh, short conversation every time: the memory between heartbeats is
// the packet, the considered lines and the agent's files — never a
// thread
export const HEARTBEAT_THREAD = { mode: 'new' } as const
// the automation's own prompt is a placeholder: every turn's text is the
// static prompt + the packet, composed at fire time (heartbeat-prompt.ts,
// carried as promptOverride) — the one source of what the agent hears
export const HEARTBEAT_AUTOMATION_PROMPT = "Your heartbeat — Silos composes this turn's prompt when it fires."

export function heartbeatName(agentName: string): string {
  return `${agentName}'s heartbeat`
}

// ── refusals ──

// what Silos sets on a heartbeat: refused when the PATCH would change it
const DERIVED = ['trigger', 'prompt', 'thread', 'agentId', 'run'] as const
const sameValue = (field: string, asked: unknown, current: unknown): boolean => {
  if (field === 'run') {
    const agentTurn = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'object' && (v as { kind?: unknown }).kind === 'agent')
    return agentTurn(asked) && agentTurn(current)
  }
  return isDeepStrictEqual(asked, current)
}
export const heartbeatShapeRefusal = (name: string): string => `this is ${name}'s heartbeat: its rhythm and hour are set on ${name}'s page`
export const HEARTBEAT_HOOKS_REFUSAL = 'a heartbeat runs with hooks off — there is nothing to inherit'
export const heartbeatPauseRefusal = (name: string): string => `a heartbeat doesn't pause — set ${name} to think never on its page`
export const heartbeatDeleteRefusalWords = (name: string): string =>
  `this is ${name}'s heartbeat: it comes back while ${name} thinks — set ${name} to think never on its page`

/** The 403 of a bearer's PATCH on a heartbeat that NAMES its trigger or
 *  what it runs on: an agent never sets its own
 *  heartbeat's period or model — said in heartbeatShapeRefusal's words. */
export function heartbeatBearerRefusal(current: Automation, body: unknown, agentName: string): string | null {
  if (!isHeartbeat(current) || !body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  return b.trigger !== undefined || b.runsOn !== undefined ? heartbeatShapeRefusal(agentName) : null
}

/** The 409 a PATCH of a heartbeat gets, or null (not a heartbeat, or nothing
 *  of Silos' changes). Unchanged values (a full-form save) are no edit. */
export function heartbeatPatchRefusal(current: Automation, body: unknown, agentName: string): string | null {
  if (!isHeartbeat(current)) return null
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (b.inheritHooks !== undefined && b.inheritHooks !== false) return HEARTBEAT_HOOKS_REFUSAL
  if (b.paused === true) return heartbeatPauseRefusal(agentName)
  const field = DERIVED.find((k) => b[k] !== undefined && !sameValue(k, b[k], current[k]))
  return field === undefined ? null : heartbeatShapeRefusal(agentName)
}

export function heartbeatDeleteRefusal(a: Pick<Automation, 'id' | 'origin'>, agentName: string): string | null {
  return isHeartbeat(a) ? heartbeatDeleteRefusalWords(agentName) : null
}

// ── reconcile ──

export interface HeartbeatClockDeps {
  store: AutomationsStore
  agents(): Agent[] // every agent, archived included
  fenceOn(agentId: string): boolean
  now?: () => Date
}

/** The heartbeat automation an agent should have right now, or null. */
export function wantedHeartbeat(agent: Agent, fenceOn: boolean): { period: Period; hb: Heartbeat } | null {
  if (controlOf(agent, fenceOn) !== 'own') return null
  const hb = heartbeatOf(agent)
  return hb.period ? { period: hb.period, hb } : null
}

export class HeartbeatClock {
  private now: () => Date
  constructor(private d: HeartbeatClockDeps) {
    this.now = d.now ?? (() => new Date())
  }

  /** Every agent's heartbeat brought to what its control and period say;
   *  an orphan heartbeat (its agent gone) deleted. Idempotent. */
  reconcile(): void {
    const seen = new Set<string>()
    for (const agent of this.d.agents()) {
      seen.add(heartbeatAutomationId(agent.id))
      try {
        this.reconcileOne(agent)
      } catch (err) {
        console.warn(`heartbeat: reconcile of ${agent.id} failed —`, err instanceof Error ? err.message : err)
      }
    }
    for (const a of this.d.store.list()) {
      if (a.origin === 'heartbeat' && !seen.has(a.id)) this.d.store.delete(a.id)
    }
  }

  reconcileAgent(agentId: string): void {
    const agent = this.d.agents().find((a) => a.id === agentId)
    const id = heartbeatAutomationId(agentId)
    if (!agent) {
      if (this.d.store.get(id)) this.d.store.delete(id)
      return
    }
    this.reconcileOne(agent)
  }

  private reconcileOne(agent: Agent): void {
    const id = heartbeatAutomationId(agent.id)
    const existing = this.d.store.get(id)
    const want = wantedHeartbeat(agent, this.d.fenceOn(agent.id))
    if (!want) {
      if (existing) this.d.store.delete(id)
      return
    }
    const shape = {
      name: heartbeatName(agent.name),
      agentId: agent.id,
      prompt: HEARTBEAT_AUTOMATION_PROMPT,
      trigger: { kind: 'period' as const, period: want.period },
      thread: { ...HEARTBEAT_THREAD },
      approval: false,
      // an account at its limit: the heartbeat does not retry at the reset,
      // it waits for its slot — derived
      keepAlive: false,
      paused: false,
      // no budget: its period is its ceiling — maxRunsPerDay is
      // never consulted for a heartbeat
      projectSettings: true,
      origin: 'heartbeat' as const,
    }
    if (!existing) {
      // no runsOn (the unattended provider resolves at send time) and
      // hooks off, fixed (inheritHooks is never read on a heartbeat)
      this.d.store.create({ id, ...shape, createdAt: this.now().toISOString() })
      return
    }
    // only what Silos DERIVES is re-written (the fields a PATCH is
    // refused): the owner's edits of the rest (its name, what it runs on)
    // stand — a re-write of those would be a decorative control
    const derived = {
      agentId: shape.agentId,
      prompt: shape.prompt,
      trigger: shape.trigger,
      thread: shape.thread,
      keepAlive: false,
      paused: false,
      projectSettings: true,
      origin: shape.origin,
    }
    const patch: Partial<Omit<Automation, 'id'>> = {}
    for (const [k, v] of Object.entries(derived) as Array<[keyof typeof derived, unknown]>) {
      if (!isDeepStrictEqual(existing[k], v)) (patch as Record<string, unknown>)[k] = v
    }
    if (existing.inheritHooks) patch.inheritHooks = undefined
    if (existing.run !== undefined) patch.run = undefined
    if (existing.autoPaused) patch.autoPaused = undefined
    if (existing.maxRunsPerDay !== undefined) patch.maxRunsPerDay = undefined
    // a moved period recomputes the next slot from the new one
    if (patch.trigger !== undefined) patch.nextRunAt = undefined
    if (Object.keys(patch).length > 0) this.d.store.update(id, patch)
  }
}
