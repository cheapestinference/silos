// automations-validate.ts — strict validation for POST/PATCH
// /api/automations — errors are plain English strings (server.ts forwards
// them as 400 as-is, same pattern as agentErrors/validateProjectsPrefs).
import { randomBytes } from 'node:crypto'
import { isValidCron, isValidTimeZone, nextRun } from './cron.js'
import { AUTOMATION_PERIOD_MIN, SELF_RECURRENT_MIN_GAP_MS, SELF_RECURRENT_RUNS_DAY } from './limits.js'
import { parsePeriod, periodDay, slotsPerDay, stampPeriod, type Period, type PeriodRules } from './period.js'
import { staggeredMinute } from './control.js'
import type { AgentRegistry } from './agent-registry.js'
import { validateOverrides } from './cockpit.js'
import { mentionsAgentState } from './command-run.js'
import { COMMAND_TIMEOUT_MAX_MS, DEFAULT_MAX_RUNS_PER_DAY, KEEP_ALIVE_DEFAULT } from './automations-types.js'
import type {
  Automation,
  AutomationRun,
  CommandRun,
  AutomationRunsOn,
  Trigger,
  Thread,
  ThreadKeep,
  WatchCheck,
  WatchCheckHttp,
  CronTrigger,
  FilesTrigger,
  ConversationTrigger,
  WatchTrigger,
} from './automations-types.js'

/** What a validator filled in that the caller must hear about once: a
 *  webhook secret Silos generated (the route hands it to the requester in
 *  its 201/200 and never again — shownTo hides it from agents after). */
export interface ValidateExtras {
  generatedSecret?: string
}

/** A webhook secret: 32 random bytes, base64url. */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('base64url')
}

const missing = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'string' && v.trim() === '')

// (E10 #16) the two trigger fields a requester may leave out, filled
// from the agent before validation — a `files` trigger watches the agent's
// main folder, a `webhook` gets a generated secret. `prior` is the trigger a
// PATCH replaces: its own folder / secret is kept first, so editing a glob
// never moves the watch and resending a webhook never rotates its secret.
// Anything else (or no agent folder) is left for validateTrigger to judge.
function fillTriggerDefaults(v: unknown, agentFolder: string | null | undefined, extras: ValidateExtras | undefined, prior?: Trigger): unknown {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return v
  const o = v as Record<string, unknown>
  if (o.kind === 'files' && missing(o.folder)) {
    const folder = prior?.kind === 'files' ? prior.folder : agentFolder
    return folder ? { ...o, folder } : o
  }
  if (o.kind === 'webhook' && missing(o.secret)) {
    if (prior?.kind === 'webhook' && prior.secret) return { ...o, secret: prior.secret }
    const secret = generateWebhookSecret()
    if (extras) extras.generatedSecret = secret
    return { ...o, secret }
  }
  return v
}

function obj(v: unknown, msg: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(msg)
  return v as Record<string, unknown>
}

export function validateWatchCheck(v: unknown): WatchCheck {
  const o = obj(v, 'trigger.check required')
  if (o.type === 'http') {
    if (typeof o.url !== 'string' || o.url.trim() === '') throw new Error('trigger.check.url required')
    const out: WatchCheckHttp = { type: 'http', url: o.url }
    if (typeof o.method === 'string') out.method = o.method
    if (typeof o.headers === 'object' && o.headers !== null) out.headers = o.headers as Record<string, string>
    return out
  }
  if (o.type === 'command') {
    if (typeof o.cwd !== 'string' || !o.cwd.startsWith('/')) throw new Error('trigger.check.cwd must be an absolute path')
    if (typeof o.command !== 'string' || o.command.trim() === '') throw new Error('trigger.check.command required')
    return { type: 'command', cwd: o.cwd, command: o.command }
  }
  if (o.type === 'path') {
    if (typeof o.path !== 'string' || !o.path.startsWith('/')) throw new Error('trigger.check.path must be an absolute path')
    return { type: 'path', path: o.path }
  }
  throw new Error('invalid trigger.check.type')
}

// an automation's period: the 400s with
// the `trigger.period.` prefix and the floor of one minute
export const AUTOMATION_PERIOD_RULES: PeriodRules = {
  prefix: 'trigger.period.',
  minMinutes: AUTOMATION_PERIOD_MIN,
  floorWords: 'an automation runs every minute at most',
}

export function validateTrigger(v: unknown): Trigger {
  const o = obj(v, 'trigger required')
  switch (o.kind) {
    case 'period':
      return { kind: 'period', period: parsePeriod(o.period, AUTOMATION_PERIOD_RULES) }
    case 'once': {
      if (typeof o.at !== 'string' || Number.isNaN(Date.parse(o.at))) throw new Error('invalid trigger.at')
      return { kind: 'once', at: o.at }
    }
    case 'cron': {
      if (typeof o.expr !== 'string' || !isValidCron(o.expr)) throw new Error('invalid cron')
      const out: CronTrigger = { kind: 'cron', expr: o.expr }
      // tz: the IANA zone the cron's wall clock is read in (default: the
      // server's local zone). An unknown zone is a 400, never stored.
      if (o.tz !== undefined && o.tz !== null) {
        if (typeof o.tz !== 'string' || !isValidTimeZone(o.tz)) throw new Error('invalid trigger.tz (an IANA time zone such as "Europe/Berlin")')
        out.tz = o.tz
      }
      return out
    }
    case 'webhook': {
      if (typeof o.secret !== 'string' || o.secret.trim() === '') throw new Error('trigger.secret required')
      return { kind: 'webhook', secret: o.secret }
    }
    case 'files': {
      if (typeof o.folder !== 'string' || !o.folder.startsWith('/')) throw new Error('trigger.folder must be an absolute path')
      if (typeof o.glob !== 'string' || o.glob.trim() === '') throw new Error('trigger.glob required')
      const out: FilesTrigger = { kind: 'files', folder: o.folder, glob: o.glob }
      if (typeof o.debounceMs === 'number') out.debounceMs = o.debounceMs
      return out
    }
    case 'conversation': {
      if (o.when !== 'finished' && o.when !== 'needs_you') throw new Error('invalid trigger.when')
      const out: ConversationTrigger = { kind: 'conversation', when: o.when }
      if (typeof o.sourceAgentId === 'string') out.sourceAgentId = o.sourceAgentId
      return out
    }
    case 'watch': {
      if (typeof o.every !== 'string' || !isValidCron(o.every)) throw new Error('invalid cron')
      const check = validateWatchCheck(o.check)
      if (o.runWhen !== 'changed' && o.runWhen !== 'nonzero' && o.runWhen !== 'zero' && o.runWhen !== 'matches') {
        throw new Error('invalid trigger.runWhen')
      }
      const out: WatchTrigger = { kind: 'watch', every: o.every, check, runWhen: o.runWhen }
      // runWhen 'matches' compiles trig.pattern as a RegExp at fire time. An
      // invalid pattern must be rejected HERE (at create/patch) — otherwise it
      // throws every fire, aborting the reschedule and busy-looping the check
      // every tick forever. Belt is here; suspenders is the runtime guard in
      // resident.ts (for automations persisted before this validation existed).
      if (o.runWhen === 'matches') {
        if (typeof o.pattern !== 'string' || o.pattern === '') throw new Error('trigger.pattern required for runWhen "matches"')
        try {
          new RegExp(o.pattern)
        } catch {
          throw new Error('trigger.pattern is not a valid regular expression')
        }
        out.pattern = o.pattern
      } else if (typeof o.pattern === 'string') {
        out.pattern = o.pattern
      }
      return out
    }
    default:
      throw new Error('invalid trigger.kind')
  }
}

// what the server writes on a period trigger: `since` (kept while
// unit and every stay as they were) and, on minutes/hours with no `at`, the
// agent's staggered minute — then a band no slot falls in is a 400
function stampTrigger(t: Trigger, agentId: string, prior?: Trigger): Trigger {
  if (t.kind !== 'period') return t
  const before: Period | null = prior?.kind === 'period' ? prior.period : null
  return { kind: 'period', period: stampPeriod(t.period, { prior: before, today: periodDay(Date.now()), staggerMinute: staggeredMinute(agentId) }) }
}

/** The budget an automation the OWNER creates with a period is born with
 *  max(24, slotsPerDay) — so «≈ n runs a day» is true — unless the
 *  body names its own. A proposal never derives it (it keeps the default:
 *  an agent does not widen its pace with a distracted click). */
export function withPeriodBudget<T extends Pick<Automation, 'trigger' | 'maxRunsPerDay'>>(input: T, body: unknown): T {
  if (input.trigger.kind !== 'period') return input
  const asked = (body as { maxRunsPerDay?: unknown } | null)?.maxRunsPerDay
  if (asked !== undefined && asked !== null) return input
  return { ...input, maxRunsPerDay: Math.max(DEFAULT_MAX_RUNS_PER_DAY, slotsPerDay(input.trigger.period)) }
}

/** An OWNER's PATCH that changes the trigger to a period, or changes its
 *  period, without naming maxRunsPerDay: the
 *  budget rises to max(current, slotsPerDay) — never lowers —
 *  so «≈ n runs a day» stays true after the save. A named max wins. */
export function withPatchedPeriodBudget(patch: Partial<Omit<Automation, 'id'>>, current: Automation, body: unknown): Partial<Omit<Automation, 'id'>> {
  const t = patch.trigger
  if (!t || t.kind !== 'period') return patch
  const asked = (body as { maxRunsPerDay?: unknown } | null)?.maxRunsPerDay
  if (asked !== undefined) return patch
  const before = current.trigger.kind === 'period' ? current.trigger.period : null
  const same =
    before !== null &&
    before.every === t.period.every &&
    before.unit === t.period.unit &&
    before.at === t.period.at &&
    before.day === t.period.day &&
    JSON.stringify(before.between ?? null) === JSON.stringify(t.period.between ?? null)
  if (same) return patch
  const now = current.maxRunsPerDay ?? DEFAULT_MAX_RUNS_PER_DAY
  const want = Math.max(now, slotsPerDay(t.period))
  return want === now ? patch : { ...patch, maxRunsPerDay: want }
}

export function validateThread(v: unknown): Thread {
  const o = obj(v, 'thread required')
  if (o.mode === 'new') return { mode: 'new' }
  if (o.mode === 'keep') {
    const out: ThreadKeep = { mode: 'keep' }
    if (typeof o.folder === 'string') out.folder = o.folder
    if (typeof o.sessionId === 'string') out.sessionId = o.sessionId
    return out
  }
  throw new Error('invalid thread.mode')
}

// Rules shared by create/patch: the agent must exist; master (folder null)
// can only be automated with thread.keep + folder (ChatService requires it
// to be able to resolve a cwd — see C-brief.md "Anywhere needs a folder").
// A command on Anywhere runs where its cwd says — it needs one (unless its
// failure goes to the agent, whose turn still needs the thread's folder).
function checkAgentThread(registry: AgentRegistry, agentId: string, thread: Thread, run?: AutomationRun): void {
  const agent = registry.get(agentId)
  if (!agent) throw new Error('agentId not found')
  if (agent.folder === null && run?.kind === 'command' && run.onFailure === 'inbox') {
    if (!run.cwd) throw new Error('a command on Anywhere needs run.cwd')
    return
  }
  if (agent.folder === null && (thread.mode !== 'keep' || !thread.folder)) {
    throw new Error('Anywhere needs thread.mode "keep" with a folder')
  }
}

// runsOn — the cockpit's own validator (model and provider only, the pair
// Run on pins); an empty pair is the agent's default, i.e. no runsOn.
export function validateRunsOn(v: unknown): AutomationRunsOn | undefined {
  const o = validateOverrides(v)
  for (const key of Object.keys(o)) {
    if (key !== 'model' && key !== 'provider') throw new Error(`runsOn takes model and provider only, not ${key}`)
  }
  const out: AutomationRunsOn = {}
  if (typeof o.provider === 'string') out.provider = o.provider
  if (typeof o.model === 'string') out.model = o.model
  return Object.keys(out).length > 0 ? out : undefined
}

// run — what its runs execute. Absent / null / {kind:'agent'} = an agent turn (returned as undefined:
// the default is never stored). A command is argv (no shell), an absolute
// cwd (or one under $SILOS_AGENT_STATE), a bounded timeout and what to do
// on failure.
export const ARGV_MAX_ITEMS = 64
export const ARGV_MAX_LENGTH = 4096
export function validateRun(v: unknown): AutomationRun | undefined {
  if (v === undefined || v === null) return undefined
  const o = obj(v, 'run must be an object')
  if (o.kind === 'agent') return undefined
  if (o.kind !== 'command') throw new Error('invalid run.kind (agent or command)')
  if (!Array.isArray(o.argv) || o.argv.length === 0) throw new Error('run.argv must be a non-empty list of arguments')
  if (o.argv.length > ARGV_MAX_ITEMS) throw new Error(`run.argv takes at most ${ARGV_MAX_ITEMS} arguments`)
  for (const a of o.argv) {
    if (typeof a !== 'string' || a === '') throw new Error('every run.argv item must be a non-empty string')
    if (a.length > ARGV_MAX_LENGTH) throw new Error(`a run.argv item is longer than ${ARGV_MAX_LENGTH} characters`)
    if (a.includes('\0')) throw new Error('run.argv items may not contain NUL')
  }
  if (o.onFailure !== 'inbox' && o.onFailure !== 'agent') throw new Error('run.onFailure must be "inbox" or "agent"')
  const out: CommandRun = { kind: 'command', argv: o.argv as string[], onFailure: o.onFailure }
  if (o.cwd !== undefined && o.cwd !== null && o.cwd !== '') {
    // absolute, or rooted at the agent's state dir (expanded at run time)
    const rooted = typeof o.cwd === 'string' && (o.cwd.startsWith('/') || (/^\$\{?SILOS_AGENT_STATE/.test(o.cwd) && mentionsAgentState(o.cwd)))
    if (!rooted || (o.cwd as string).includes('\0') || (o.cwd as string).length > ARGV_MAX_LENGTH) throw new Error('run.cwd must be an absolute path')
    out.cwd = o.cwd as string
  }
  if (o.timeoutMs !== undefined && o.timeoutMs !== null) {
    if (typeof o.timeoutMs !== 'number' || !Number.isInteger(o.timeoutMs) || o.timeoutMs < 1000 || o.timeoutMs > COMMAND_TIMEOUT_MAX_MS) {
      throw new Error(`run.timeoutMs must be between 1000 and ${COMMAND_TIMEOUT_MAX_MS} (60 min)`)
    }
    out.timeoutMs = o.timeoutMs
  }
  if (o.okCodes !== undefined && o.okCodes !== null) {
    if (!Array.isArray(o.okCodes) || o.okCodes.length > 16 || o.okCodes.some((c) => typeof c !== 'number' || !Number.isInteger(c) || c < 0 || c > 255)) {
      throw new Error('run.okCodes must be a list of exit codes (0-255)')
    }
    const codes = [...new Set(o.okCodes as number[])]
    if (!(codes.length === 1 && codes[0] === 0)) out.okCodes = codes
  }
  return out
}

// A command that hands its failure to the agent needs something to ask it;
// a command that only tells you does not.
function checkPrompt(prompt: unknown, run: AutomationRun | undefined): string {
  if (run?.kind === 'command' && run.onFailure === 'inbox') {
    if (prompt === undefined || prompt === null) return ''
    if (typeof prompt !== 'string') throw new Error('prompt must be a string')
    return prompt
  }
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new Error(run?.kind === 'command' ? 'prompt required: it is what the agent is asked when the command fails' : 'prompt required')
  }
  return prompt
}

export function validateAutomationCreate(body: unknown, registry: AgentRegistry, extras?: ValidateExtras): Omit<Automation, 'id' | 'createdAt'> {
  const o = obj(body, 'invalid body')
  if (typeof o.name !== 'string' || o.name.trim() === '') throw new Error('name required')
  if (typeof o.agentId !== 'string' || o.agentId.trim() === '') throw new Error('agentId required')
  const run = validateRun(o.run)
  const prompt = checkPrompt(o.prompt, run)
  const trigger = stampTrigger(validateTrigger(fillTriggerDefaults(o.trigger, registry.get(o.agentId)?.folder, extras)), o.agentId)
  const thread = o.thread !== undefined ? validateThread(o.thread) : { mode: 'new' as const }
  checkAgentThread(registry, o.agentId, thread, run)
  const out: Omit<Automation, 'id' | 'createdAt'> = {
    name: o.name.trim(),
    agentId: o.agentId,
    prompt,
    trigger,
    thread,
    // keepAlive defaults ON: a usage limit waits for its reset
    // and retries by itself unless the creator says otherwise. Only a create
    // without the field — stored automations keep what they have.
    approval: o.approval === true,
    keepAlive: o.keepAlive === undefined ? KEEP_ALIVE_DEFAULT : o.keepAlive === true,
    paused: o.paused === true,
  }
  if (typeof o.maxRunsPerDay === 'number' && o.maxRunsPerDay > 0) out.maxRunsPerDay = o.maxRunsPerDay
  if (o.inheritHooks === true) out.inheritHooks = true
  if (o.runsOn !== undefined && o.runsOn !== null) {
    const runsOn = validateRunsOn(o.runsOn)
    if (runsOn) out.runsOn = runsOn
  }
  if (run) out.run = run
  // every agent automation with a folder sees the folder's own settings —
  // its skills load; hooks stay off (isolation)
  if (registry.get(o.agentId)?.folder) out.projectSettings = true
  return out
}

// ── its own recurring work, created in its weekly think ───────

export const SELF_WEEKLY = 'your own recurring work runs at most once a week: a cron whose fires are 7 days apart or more'
export const SELF_NOT_COMMAND = 'your own recurring work runs a prompt, not a command — propose the command instead (POST /api/proposals)'
// G7-r7: its shape is fixed at birth too — Silos sets how it runs
export const SELF_SHAPE_AT_BIRTH = 'your own recurring work keeps its shape — Silos sets how it runs'
export const SELF_SHAPE_FIELDS = ['runsOn', 'inheritHooks', 'keepAlive', 'thread'] as const

/** The «self» validation of a bearer's create in its think turn, on the RAW
 *  body (before the general validator, so a command hears its own words, not
 *  the owner-only exec 403): no command, no shape fields, a cron whose next
 *  3 fires are SELF_RECURRENT_MIN_GAP apart or more. null: valid. */
export function validateSelfAutomation(body: unknown, now: Date): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null // the general validator says it
  const o = body as Record<string, unknown>
  const run = o.run as { kind?: unknown } | null | undefined
  if (typeof run === 'object' && run !== null && run.kind === 'command') return SELF_NOT_COMMAND
  if (SELF_SHAPE_FIELDS.some((f) => o[f] !== undefined)) return SELF_SHAPE_AT_BIRTH
  const t = o.trigger as { kind?: unknown; expr?: unknown; tz?: unknown } | null | undefined
  if (typeof t !== 'object' || t === null || t.kind !== 'cron' || typeof t.expr !== 'string' || !isValidCron(t.expr)) return SELF_WEEKLY
  const tz = typeof t.tz === 'string' && isValidTimeZone(t.tz) ? t.tz : undefined
  try {
    const f1 = nextRun(t.expr, now, tz)
    const f2 = nextRun(t.expr, f1, tz)
    const f3 = nextRun(t.expr, f2, tz)
    if (f2.getTime() - f1.getTime() < SELF_RECURRENT_MIN_GAP_MS || f3.getTime() - f2.getTime() < SELF_RECURRENT_MIN_GAP_MS) return SELF_WEEKLY
  } catch {
    return SELF_WEEKLY
  }
  return null
}

/** What Silos sets on a self-created automation, whatever the body said
 *  one run a day, no approval gate. */
export function selfShaped<T extends { maxRunsPerDay?: number; approval: boolean }>(input: T): T {
  return { ...input, maxRunsPerDay: SELF_RECURRENT_RUNS_DAY, approval: false }
}

// PATCH by a bearer on its own recurring work is an ALLOW-LIST (M2-r6):
// only a pause; unpausing is the owner's (m14); every other field is shape
export const SELF_UNPAUSE = "unpausing is the owner's — propose it (POST /api/proposals)"
export const SELF_SHAPE_PATCH = 'your own recurring work keeps its shape — propose the change, or the owner edits it'
export function selfPatchRefusal(body: unknown): string | null {
  const o = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>
  if (Object.keys(o).some((k) => k !== 'paused' && o[k] !== undefined)) return SELF_SHAPE_PATCH
  if (o.paused !== undefined && o.paused !== true) return o.paused === false ? SELF_UNPAUSE : SELF_SHAPE_PATCH
  return null
}

// PATCH: same per-field validators, but only for what's present in the
// body (a partial merge — same criterion as AgentRegistry.update).
export function validateAutomationPatch(body: unknown, registry: AgentRegistry, current: Automation, extras?: ValidateExtras): Partial<Omit<Automation, 'id'>> {
  const o = obj(body, 'invalid body')
  const patch: Partial<Omit<Automation, 'id'>> = {}
  if (o.name !== undefined) {
    if (typeof o.name !== 'string' || o.name.trim() === '') throw new Error('name required')
    patch.name = o.name.trim()
  }
  // run: null / {kind:'agent'} = back to an agent turn (stored as absent)
  if (o.run !== undefined) patch.run = validateRun(o.run)
  const effectiveRun = 'run' in patch ? patch.run : current.run
  if (o.prompt !== undefined || 'run' in patch) {
    patch.prompt = checkPrompt(o.prompt !== undefined ? o.prompt : current.prompt, effectiveRun)
  }
  if (o.agentId !== undefined) {
    if (typeof o.agentId !== 'string' || o.agentId.trim() === '') throw new Error('agentId required')
    patch.agentId = o.agentId
    // moved to an agent with a folder: it sees that folder's settings
    if (registry.get(o.agentId)?.folder) patch.projectSettings = true
  }
  if (o.trigger !== undefined) {
    const agentId = typeof o.agentId === 'string' && o.agentId.trim() !== '' ? o.agentId : current.agentId
    // the stored trigger's folder/secret are kept only while the agent stays
    patch.trigger = stampTrigger(
      validateTrigger(fillTriggerDefaults(o.trigger, registry.get(agentId)?.folder, extras, agentId === current.agentId ? current.trigger : undefined)),
      agentId,
      current.trigger,
    )
  }
  if (o.thread !== undefined) patch.thread = validateThread(o.thread)
  const effectiveAgentId = (patch.agentId ?? current.agentId) as string
  const effectiveThread = patch.thread ?? current.thread
  if (o.agentId !== undefined || o.thread !== undefined || 'run' in patch) checkAgentThread(registry, effectiveAgentId, effectiveThread, effectiveRun)
  if (o.approval !== undefined) {
    if (typeof o.approval !== 'boolean') throw new Error('approval must be a boolean')
    patch.approval = o.approval
  }
  if (o.keepAlive !== undefined) {
    if (typeof o.keepAlive !== 'boolean') throw new Error('keepAlive must be a boolean')
    patch.keepAlive = o.keepAlive
  }
  if (o.paused !== undefined) {
    if (typeof o.paused !== 'boolean') throw new Error('paused must be a boolean')
    patch.paused = o.paused
  }
  if (o.maxRunsPerDay !== undefined) {
    if (typeof o.maxRunsPerDay !== 'number' || o.maxRunsPerDay <= 0) throw new Error('invalid maxRunsPerDay')
    patch.maxRunsPerDay = o.maxRunsPerDay
  }
  if (o.inheritHooks !== undefined) {
    if (typeof o.inheritHooks !== 'boolean') throw new Error('inheritHooks must be a boolean')
    patch.inheritHooks = o.inheritHooks
  }
  // null (or an empty pair) = back to the agent's default
  if (o.runsOn !== undefined) patch.runsOn = o.runsOn === null ? undefined : validateRunsOn(o.runsOn)
  return patch
}
