// silos.ts — the Silos plugin that runs inside every OpenCode process Silos
// launches (OpenCode's Bun runtime: only node:fs/path/crypto).
//
// The OpenCode twin of plugin/hooks/birth.py, plus a permission bridge to
// Silos' Needs you (asks-store.ts) that has no Claude Code hook counterpart:
//   - session.created  → $SILOS_AGENT_STATE/births/<id>.json (first wins)
//   - permission.asked → $SILOS_AGENT_STATE/asks/<sessionID>/<id>.json, then a
//                        poller for $SILOS_ASKS_REPLIES/<sessionID>/<id>.reply.json
//                        written by Silos, answered through the plugin's SDK
//                        client (the live path). The reply dir is Silos-owned
//                        and fenced: the agent's own state dir is writable by
//                        the agent, so a reply there would let it approve its
//                        own asks — it is never read. No SILOS_ASKS_REPLIES →
//                        no reply is ever read (the TUI's dialog stays).
//   - permission.replied → the poller stops, the ask and reply files go away
//   - question.asked   → the same channel for OpenCode's `question` tool (its
//                        AskUserQuestion): an ask file of type 'question'
//                        carrying the questions, answered by Silos with
//                        `{status:'answer', answers}` (one label list per
//                        question) or `{status:'deny'}` → POST
//                        /question/{id}/reply | /reject. No deadline: a
//                        question waits for the owner as long as the process
//                        lives (a timed-out one would vanish from Needs you
//                        while the session still waits on it).
//   - question.replied / question.rejected → poller stops, files go
//   - shell.env        → the agent-facing SILOS_* variables reach the agent's
//                        shells; every other SILOS_* (the provider key, the
//                        console key…) and the TUI server password are blanked;
//                        SILOS_SESSION_ID = the calling session (a nested
//                        `opencode run` is its child)
// File-borne, zero tokens, no network of its own. Outside Silos (no SILOS_AGENT_STATE or
// SILOS_AGENT_ID — an operator running `opencode` by hand) every hook is a
// no-op, and no hook ever throws: a broken marker must never break a session.
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Hooks, Plugin, PluginModule } from '@opencode-ai/plugin'

type Env = Record<string, string | undefined>

/** The same rule birth.py and the server apply: an id is a safe path segment. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const POLL_MS = 500
const DEFAULT_ASK_TIMEOUT_MS = 600_000
/** When this OpenCode process started: a session created after it was born here. */
const PROCESS_STARTED_AT = Date.now() - process.uptime() * 1000

export type BirthRecord = {
  sessionId: string
  agentId: string | null
  parent: string | null
  cwd: string | null
  source: 'startup'
  harness: 'opencode'
  consoleKey: string | null
  at: string
}

export type AskRecord = {
  id: string
  sessionId: string
  type: string
  pattern: string | string[] | null
  title: string | null
  metadata: Record<string, unknown>
  askedAt: string
}

/** One question of OpenCode's `question` tool (QuestionInfo, v2 SDK). */
export type QuestionSpec = {
  question: string
  header: string
  options: { label: string; description: string }[]
  multiple?: boolean
  custom?: boolean
}

/** The ask file for a `question.asked` (QuestionRequest): type 'question'. */
export type QuestionAskRecord = {
  id: string
  sessionId: string
  type: 'question'
  pattern: null
  title: string | null
  questions: QuestionSpec[]
  /** the question tool's call: Silos reads its state in the DB, so a
   *  question whose process died never lingers as pending */
  callId: string | null
  askedAt: string
}

export type QuestionInput = { id: string; sessionID: string; questions?: unknown; tool?: { callID?: unknown } }

/** Only well-formed questions travel (strings where strings belong). */
export function questionSpecs(raw: unknown): QuestionSpec[] {
  if (!Array.isArray(raw)) return []
  const out: QuestionSpec[] = []
  for (const q of raw) {
    const o = q as Record<string, unknown> | null
    if (!o || typeof o.question !== 'string' || !Array.isArray(o.options)) continue
    const options = o.options
      .filter((x): x is { label: string; description?: unknown } => !!x && typeof (x as { label?: unknown }).label === 'string')
      .map((x) => ({ label: x.label, description: typeof x.description === 'string' ? x.description : '' }))
    out.push({
      question: o.question,
      header: typeof o.header === 'string' ? o.header : '',
      options,
      ...(o.multiple === true ? { multiple: true } : {}),
      ...(o.custom === false ? { custom: false } : {}),
    })
  }
  return out
}

/** The ask file Silos reads to show an OpenCode question. */
export function questionRecord(input: QuestionInput): QuestionAskRecord {
  const questions = questionSpecs(input.questions)
  return {
    id: input.id,
    sessionId: input.sessionID,
    type: 'question',
    pattern: null,
    title: questions[0]?.question ?? null,
    questions,
    callId: typeof input.tool?.callID === 'string' ? input.tool.callID : null,
    askedAt: new Date().toISOString(),
  }
}

/**
 * The fields the bridge reads from a permission question: the
 * `permission.asked` event's v2 `PermissionRequest` (`permission`,
 * `patterns`); the v1 names (`type`, `pattern`, `title`) are read too.
 */
export type PermissionInput = {
  id: string
  sessionID: string
  type?: string
  permission?: string
  pattern?: string | string[]
  patterns?: string[]
  title?: string
  metadata?: Record<string, unknown>
}

/**
 * The SDK client OpenCode hands the plugin: on the 1.19.4 minimum the v2
 * `OpencodeClient` (the only generated client in the binary, 09-11 smoke —
 * no `postSessionIdPermissionsPermissionId` anywhere in it): permissions are
 * answered with `permission.reply` (`POST /permission/{requestID}/reply`),
 * questions with `question.reply` / `question.reject`.
 */
type ReplyClient = {
  question?: {
    reply?: (p: { requestID: string; answers: string[][] }) => Promise<unknown>
    reject?: (p: { requestID: string }) => Promise<unknown>
  }
  permission?: { reply?: (p: { requestID: string; reply: 'once' | 'reject' }) => Promise<unknown> }
}

const isId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v)

export type SessionInfo = { id: string; directory?: string; parentID?: string }

/**
 * The birth marker for a session (`source: 'startup'` is what
 * session-owner.ts trusts). The parent is OpenCode's own `parentID` (a
 * subagent session) or else the session that launched this process
 * (`SILOS_SESSION_ID`), never the session itself.
 */
export function birthRecord(env: Env, info: SessionInfo): BirthRecord {
  const launcher = env.SILOS_SESSION_ID || null
  const parent = isId(info.parentID) ? info.parentID : launcher
  return {
    sessionId: info.id,
    agentId: env.SILOS_AGENT_ID || null,
    parent: parent === info.id ? null : parent,
    cwd: typeof info.directory === 'string' ? info.directory : null,
    source: 'startup',
    harness: 'opencode',
    // a child (OpenCode subagent) runs in its parent's console: the key is
    // the parent's, never the child's to advertise
    consoleKey: isId(info.parentID) ? null : env.SILOS_CONSOLE_KEY || null,
    at: new Date().toISOString(),
  }
}

/** The ask file Silos reads to show a permission question. */
export function askRecord(input: PermissionInput): AskRecord {
  return {
    id: input.id,
    sessionId: input.sessionID,
    type: input.type ?? input.permission ?? '',
    pattern: input.pattern ?? input.patterns ?? null,
    title: input.title ?? null,
    metadata: input.metadata ?? {},
    askedAt: new Date().toISOString(),
  }
}

/**
 * Writes `json` to `path` atomically, 0600, never overwriting an existing
 * file: an exclusive temp file in the same directory is RENAMED into place,
 * so the file only ever has one name. Never link-then-unlink: for that
 * instant the file had two names, and Silos refuses a file with more than
 * one (a hard link into another agent's state looks just like it) — a
 * process killed in between left it unreadable for good. The existence check
 * runs right before the rename; only a writer racing for the very same name
 * within that instant could land second (births and asks are named by
 * unique ids). Creates the directory 0700. Returns false when the file
 * already existed.
 */
export function writeAtomic(path: string, json: unknown): boolean {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = join(dir, `.${randomBytes(6).toString('hex')}.tmp`)
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    try {
      writeSync(fd, JSON.stringify(json) + '\n')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    if (exists(path)) return false
    renameSync(tmp, path)
    return true
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      /* renamed into place */
    }
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** The agent's state dir when this process runs as a Silos agent, else null. */
function stateDir(env: Env): string | null {
  return env.SILOS_AGENT_STATE && env.SILOS_AGENT_ID ? env.SILOS_AGENT_STATE : null
}

function askTimeoutMs(env: Env): number {
  const n = Number(env.SILOS_ASK_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ASK_TIMEOUT_MS
}

/** Silos' answer in a reply file, or null while there is none (or it is unreadable). */
function readReply(path: string | null): 'allow' | 'deny' | null {
  if (!path) return null
  try {
    const status = JSON.parse(readFileSync(path, 'utf8'))?.status
    return status === 'allow' || status === 'deny' ? status : null
  } catch {
    return null
  }
}

type QuestionReply = { answers: string[][] } | 'deny'

/** Silos' answer to a question: `{status:'answer', answers}` (each a list of
 *  strings) or `{status:'deny'}`; null while none (or malformed). */
function readQuestionReply(path: string | null): QuestionReply | null {
  if (!path) return null
  try {
    const o = JSON.parse(readFileSync(path, 'utf8'))
    if (o?.status === 'deny') return 'deny'
    const a = o?.answers
    if (o?.status === 'answer' && Array.isArray(a) && a.length > 0 && a.every((x: unknown) => Array.isArray(x) && x.every((y) => typeof y === 'string')))
      return { answers: a }
    return null
  } catch {
    return null
  }
}

/** The ask file (agent's state dir) and Silos' reply file (SILOS_ASKS_REPLIES,
 *  an absolute path; null when unset — no answer is ever read then). */
const askPaths = (state: string, env: Env, sessionID: string, id: string): { ask: string; reply: string | null } => ({
  ask: join(state, 'asks', sessionID, `${id}.json`),
  reply: env.SILOS_ASKS_REPLIES && isAbsolute(env.SILOS_ASKS_REPLIES) ? join(env.SILOS_ASKS_REPLIES, sessionID, `${id}.reply.json`) : null,
})

function removeFiles(...paths: (string | null)[]): void {
  for (const p of paths) if (p) rmSync(p, { force: true })
}

type RawInfo = { id?: unknown; directory?: unknown; parentID?: unknown; time?: { created?: unknown } } | null | undefined

function recordBirth(state: string, env: Env, info: RawInfo, directory: string): void {
  if (!isId(info?.id)) return
  const record = birthRecord(env, {
    id: info.id,
    directory: typeof info.directory === 'string' ? info.directory : directory,
    parentID: typeof info.parentID === 'string' ? info.parentID : undefined,
  })
  writeAtomic(join(state, 'births', `${info.id}.json`), record)
}

/**
 * `opencode run` creates its session in the same request that loads the
 * plugin, and that session.created never reaches the plugin (observed 26-10). The
 * first session.updated of a session created after this process started
 * stands in for it; a resumed session (created earlier) is never claimed.
 */
function bornInThisProcess(info: RawInfo): boolean {
  const created = info?.time?.created
  return typeof created === 'number' && created >= PROCESS_STARTED_AT
}

/** OpenCode ≤1.x names the id `permissionID`; the v2 event names it `requestID`. */
function clearReplied(state: string, env: Env, props: unknown): void {
  const p = props as { sessionID?: unknown; permissionID?: unknown; requestID?: unknown } | null | undefined
  const id = p?.permissionID ?? p?.requestID
  if (!isId(p?.sessionID) || !isId(id)) return
  const { ask, reply } = askPaths(state, env, p.sessionID, id)
  removeFiles(ask, reply)
}

/** An HTTP status on a thrown error or a resolved `{ error, response }`. */
function statusOf(v: unknown): number | null {
  const o = v as { status?: unknown; response?: { status?: unknown } } | null | undefined
  const st = o?.status ?? o?.response?.status
  return typeof st === 'number' ? st : null
}

/**
 * Answers OpenCode for Silos through the client's `permission.reply`. The
 * generated SDK client resolves `{ error, response }` instead of throwing,
 * so a resolved error is thrown here; a 404 (the request is already
 * answered or gone) is 'gone'.
 */
async function replyToOpenCode(client: ReplyClient, id: string, answer: 'allow' | 'deny'): Promise<'ok' | 'gone'> {
  const reply = answer === 'allow' ? 'once' : 'reject'
  let result: unknown
  try {
    if (typeof client?.permission?.reply === 'function') result = await client.permission.reply({ requestID: id, reply })
    else throw new Error('client has no permission reply method')
  } catch (err) {
    if (statusOf(err) === 404) return 'gone'
    throw err
  }
  const r = result as { error?: unknown } | null | undefined
  if (r && typeof r === 'object' && r.error) {
    if (statusOf(r) === 404) return 'gone'
    throw new Error(`permission reply refused (${statusOf(r) ?? 'no status'}): ${JSON.stringify(r.error)}`)
  }
  return 'ok'
}

/** Answers an OpenCode question for Silos through the client's `question`
 *  methods. 404 = already answered or gone. */
async function replyQuestionToOpenCode(client: ReplyClient, id: string, answer: QuestionReply): Promise<'ok' | 'gone'> {
  let result: unknown
  try {
    if (answer === 'deny') {
      if (typeof client?.question?.reject === 'function') result = await client.question.reject({ requestID: id })
      else throw new Error('client has no question reject method')
    } else {
      if (typeof client?.question?.reply === 'function') result = await client.question.reply({ requestID: id, answers: answer.answers })
      else throw new Error('client has no question reply method')
    }
  } catch (err) {
    if (statusOf(err) === 404) return 'gone'
    throw err
  }
  const r = result as { error?: unknown } | null | undefined
  if (r && typeof r === 'object' && r.error) {
    if (statusOf(r) === 404) return 'gone'
    throw new Error(`question reply refused (${statusOf(r) ?? 'no status'}): ${JSON.stringify(r.error)}`)
  }
  return 'ok'
}

/**
 * The live bridge: a `permission.asked` event writes the ask file and
 * starts a non-blocking poller (500 ms, up to SILOS_ASK_TIMEOUT_MS). Silos'
 * reply is sent through the client and both files go — also when OpenCode
 * says the request is already answered (404). When the client fails, only
 * the reply goes: the ask stays in Silos' Needs you and the poller keeps
 * waiting for the owner to answer again. On timeout the ask file (and a
 * reply that landed at the deadline) goes and the TUI's own dialog stays; `onDone` runs when the poller ends. Its
 * timers are unref'd: a headless `opencode run` may exit while it waits.
 * Returns the poller's stop function, or null when nothing was started.
 */
type Channel<A> = { record: unknown; read: (path: string | null) => A | null; send: (answer: A) => Promise<unknown>; deadline: number }

function permissionChannel(env: Env, client: ReplyClient, input: PermissionInput): Channel<'allow' | 'deny'> {
  return { record: askRecord(input), read: readReply, send: (a) => replyToOpenCode(client, input.id, a), deadline: Date.now() + askTimeoutMs(env) }
}

function questionChannel(client: ReplyClient, input: QuestionInput): Channel<QuestionReply> {
  return { record: questionRecord(input), read: readQuestionReply, send: (a) => replyQuestionToOpenCode(client, input.id, a), deadline: Infinity }
}

function watchAsk<A>(state: string, env: Env, input: { id: string; sessionID: string }, channel: () => Channel<A>, onDone: () => void): (() => void) | null {
  if (!isId(input?.id) || !isId(input?.sessionID)) return null
  const { id, sessionID } = input
  const { ask, reply } = askPaths(state, env, sessionID, id)
  const ch = channel()
  writeAtomic(ask, ch.record)
  const deadline = ch.deadline
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const tick = async () => {
    if (stopped) return
    const answer = ch.read(reply)
    if (answer) {
      let sent = false
      try {
        await ch.send(answer)
        sent = true
      } catch (err) {
        if (env.SILOS_PLUGIN_DEBUG) console.error(`silos: permission reply failed (${id}): ${String(err)}`)
      }
      if (sent) {
        stopped = true
        await quietly(() => removeFiles(ask, reply))
        onDone()
        return
      }
      await quietly(() => removeFiles(reply)) // the ask stays: answer it again
      if (stopped) return // answered in the TUI meanwhile
    }
    const left = deadline - Date.now()
    if (left <= 0) {
      stopped = true
      await quietly(() => removeFiles(ask, reply)) // a straggling reply goes with it
      onDone()
      return
    }
    timer = schedule(tick, Math.min(POLL_MS, left === Infinity ? POLL_MS : left))
  }
  timer = schedule(tick, 0)
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

/** setTimeout that never keeps the process alive on its own. */
function schedule(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const t = setTimeout(fn, ms)
  ;(t as { unref?: () => void }).unref?.()
  return t
}

/**
 * The SILOS_* variables an agent's shell keeps — exactly what the briefing's
 * recipes, the skills and the hooks read there (plugin/context/recipes,
 * plugin/skills, plugin/hooks): where Silos is, who the agent is, its own
 * bearer, its state dir, the turn and the calling session. An allowlist on
 * purpose: a SILOS_* variable Silos adds tomorrow stays out of the shell
 * until someone decides an agent needs it.
 */
export const AGENT_SHELL_SILOS_ENV: readonly string[] = [
  'SILOS_API',
  'SILOS_AGENT_ID',
  'SILOS_AGENT_STATE',
  'SILOS_AGENT_TOKEN',
  'SILOS_TURN',
  'SILOS_SESSION_ID',
]

/**
 * Credentials the launcher hands the OpenCode PROCESS that are not SILOS_*
 * (server/src/harnesses/opencode/launch.ts envFor): the TUI server's
 * basic-auth password — with it a shell could answer the agent's own
 * permission asks through that server. Blanked like every SILOS_* off the
 * list (SILOS_PROVIDER_KEY, SILOS_CONSOLE_KEY, SILOS_ASKS_REPLIES…).
 */
export const ENGINE_CREDENTIAL_ENV: readonly string[] = ['OPENCODE_SERVER_PASSWORD']

/**
 * What the agent's shells get. The rule: a shell sees the agent-facing
 * SILOS_* variables (AGENT_SHELL_SILOS_ENV) and nothing else of Silos'
 * wiring — every other SILOS_* variable the process carries, and every
 * ENGINE_CREDENTIAL_ENV name, is set to ''. Blanked, never just omitted:
 * OpenCode spreads its OWN process env under this output (1.19.4
 * ShellTool.shellEnv: `{...process.env, ...k.env}`; the `!` shell and the
 * PTY extend it too), so an omitted name would come through with the
 * process's value. Empty reads as "unset" everywhere (birthRecord, the
 * recipes' `:-`). So SILOS_PROVIDER_KEY (the provider's API key) and the
 * console key never reach a shell. The Vault's entries are not SILOS_*
 * (vault-store.ts refuses the prefix): they pass, as the owner meant.
 *
 * SILOS_SESSION_ID = the calling session (OpenCode's `shell.env` input,
 * else the process env). A nested `opencode run` from the console's shell
 * then presents itself as that session's child (parent set, no console key)
 * and folds as a nested run — with the key it would read as a new
 * conversation in the console and take its binding (registrar.ts). Such a
 * nested run has no provider key either: it runs on what OpenCode itself
 * is signed in to, or fails.
 *
 * Not a wall: a shell of the same Unix user can still read the OpenCode
 * process's own environment (/proc/<pid>/environ). This keeps the secret out
 * of `env` dumps, logs and transcripts; it is not isolation.
 */
export function silosEnv(env: Env, sessionID?: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string') continue
    if (AGENT_SHELL_SILOS_ENV.includes(k)) out[k] = v
    else if (k.startsWith('SILOS_') || ENGINE_CREDENTIAL_ENV.includes(k)) out[k] = ''
  }
  if (isId(sessionID)) out.SILOS_SESSION_ID = sessionID
  return out
}

/** Runs a hook body, swallowing every error. */
async function quietly(fn: () => unknown): Promise<void> {
  try {
    await fn()
  } catch {
    /* a marker that cannot be written must never break the session */
  }
}

export const SilosPlugin: Plugin = async ({ directory, client }) => {
  const seen = new Set<string>() // sessions already presented by this process
  const pollers = new Map<string, () => void>() // live asks by permission id
  const asked = (state: string, props: unknown) => {
    const input = props as PermissionInput
    if (!isId(input?.id) || pollers.has(input.id)) return
    const c = client as unknown as ReplyClient
    const stop = watchAsk(
      state,
      process.env,
      input,
      () => permissionChannel(process.env, c, input),
      () => pollers.delete(input.id),
    )
    if (stop) pollers.set(input.id, stop)
  }
  const questioned = (state: string, props: unknown) => {
    const input = props as QuestionInput
    if (!isId(input?.id) || pollers.has(input.id)) return
    const c = client as unknown as ReplyClient
    const stop = watchAsk(
      state,
      process.env,
      input,
      () => questionChannel(c, input),
      () => pollers.delete(input.id),
    )
    if (stop) pollers.set(input.id, stop)
  }
  const replied = (state: string, props: unknown) => {
    const p = props as { permissionID?: unknown; requestID?: unknown } | null | undefined
    const id = p?.permissionID ?? p?.requestID
    if (typeof id === 'string') {
      pollers.get(id)?.()
      pollers.delete(id)
    }
    clearReplied(state, process.env, props)
  }
  const present = (state: string, info: RawInfo) => {
    if (!isId(info?.id) || seen.has(info.id)) return
    seen.add(info.id)
    recordBirth(state, process.env, info, directory)
  }
  const hooks: Hooks = {
    event: ({ event }) =>
      quietly(() => {
        const state = stateDir(process.env)
        if (!state || !event) return
        const e = event as { type: string; properties?: { info?: RawInfo } }
        const info = e.properties?.info
        if (e.type === 'session.created') present(state, info)
        else if (e.type === 'session.updated' && bornInThisProcess(info)) present(state, info)
        else if (e.type === 'permission.asked') asked(state, e.properties)
        else if (e.type === 'permission.replied') replied(state, e.properties)
        else if (e.type === 'question.asked') questioned(state, e.properties)
        else if (e.type === 'question.replied' || e.type === 'question.rejected') replied(state, e.properties)
      }),
    'shell.env': (input, output) =>
      quietly(() => {
        if (stateDir(process.env)) Object.assign(output.env, silosEnv(process.env, input?.sessionID))
      }),
  }
  return hooks
}

/**
 * OpenCode loads a module either by its `{ id, server }` default export
 * or, failing that, by calling EVERY exported function as a plugin — which
 * would run the helpers above as plugins. A path plugin must name its `id`.
 */
const plugin: PluginModule = { id: 'silos', server: SilosPlugin }
export default plugin
