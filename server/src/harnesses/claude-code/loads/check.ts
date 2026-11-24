// harnesses/claude-code/loads/check.ts — «Check now» (docs/architecture.md
// «Tool health»): ONE `claude` Silos starts in a folder on the owner's
// click, through the Agent SDK, to read what the engine knows of every MCP
// server and connector there — and nothing else.
//
//   - no prompt, ever: the query's input is a stream that never yields, so
//     the process initializes (dials its servers) and is never asked a turn
//     — no model request, no tokens;
//   - `persistSession: false`: no transcript is written;
//   - hooks off in the flag-tier settings (`disableAllHooks`) — except the
//     ones managed settings impose: the engine runs an organization's
//     managed hooks under any `disableAllHooks` a user can set;
//   - the login's env (env.ts envForProvider) and the given agents' role
//     plugins, so their own tools are read too;
//   - it asks `initializationResult()` (the login it really runs on) and
//     `mcpServerStatus()` — again while a server is still connecting — and
//     closes the process on the answer, or at the bound (20 s) whatever
//     came; nothing waits past it.
//
// `as` (Agent › Tools): the agent's launch entries in the flag tier — the
// check reads what THAT agent's starts load.
//
// `withoutLocal` («See what it sends»): the same, without the folder's
// local settings layer — a folder that turned the account's things off
// there never fetches them; this run does, and writes nothing to the folder.
import type { LoadsCheckInput, LoadsCheckReading, TurnToolStatusServer } from '../../contract.js'
import type { ChatDeps } from '../../../chat-service.js'
import type { SdkQueryHandle } from '../sdk-types.js'
import { envForProvider } from '../env.js'
import { ensureRolePluginManifest, rolePluginFor } from '../../../role-plugin.js'
import { connectorsOnFor, statusServers } from '../turn-status.js'
import { withLaunchEntries } from './launch-entries.js'

/** The bound: the process is closed at it, whatever answered. */
export const CHECK_BOUND_MS = 20_000
/** Between two asks while a server is still connecting. */
const REASK_MS = 750
/** What the check costs, said beside its button. Measured 23-11 on CLI
 *  2.1.330 with 31 servers (3 runs): settled in 2.0–2.3 s, the engine
 *  process peaking at ~285 MB, no prompt sent. */
export const CHECK_COST = 'starts Claude for about 2 s · ~300 MB · no tokens'

const asObject = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/** The query's input: a stream that yields nothing until it is ended. */
function silentPrompt(): { stream: AsyncIterable<never>; end(): void } {
  let end = (): void => {}
  const ended = new Promise<void>((resolve) => {
    end = resolve
  })
  return {
    stream: { [Symbol.asyncIterator]: () => ({ next: () => ended.then(() => ({ done: true as const, value: undefined as never })) }) },
    end: () => end(),
  }
}

export class CheckTimeout extends Error {
  constructor(ms: number) {
    super(`Claude Code didn't answer within ${Math.round(ms / 1000)} s — closed`)
  }
}

export async function claudeLoadsCheck(input: LoadsCheckInput, deps: Pick<ChatDeps, 'queryFn'>): Promise<LoadsCheckReading> {
  const started = Date.now()
  const bound = input.timeoutMs ?? CHECK_BOUND_MS
  const provider = input.provider
  if (provider && provider.kind !== 'claude-account' && provider.kind !== 'anthropic-compatible') throw new Error('this login does not run Claude Code')
  const configDir = provider?.kind === 'claude-account' ? provider.configDir : null
  const sources = input.withoutLocal ? ['user', 'project'] : ['user', 'project', 'local']
  // as an agent: its kept entries ride the flag tier, as its launches carry
  // them (launch-entries.ts, the one allowlist) — what loads for THAT agent
  const settings: Record<string, unknown> = withLaunchEntries({ disableAllHooks: true }, input.as ? [input.as.payload] : undefined, {
    cwd: input.folder,
    ...(configDir ? { loginDirs: [configDir] } : {}),
  })
  const plugins: { type: 'local'; path: string }[] = []
  for (const a of input.agents) {
    const dir = rolePluginFor(a.id, a.stateDir)
    if (!dir) continue
    ensureRolePluginManifest(dir, a.id, a.name)
    plugins.push({ type: 'local', path: dir })
  }
  const prompt = silentPrompt()
  const handle: SdkQueryHandle = deps.queryFn({
    prompt: prompt.stream,
    options: {
      cwd: input.folder,
      settingSources: sources,
      settings,
      persistSession: false,
      ...(plugins.length > 0 ? { plugins } : {}),
      env: envForProvider(provider),
    },
  })
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    prompt.end()
    try {
      if (typeof handle.close === 'function') handle.close()
      else
        void handle.interrupt().catch(() => {
          /* gone */
        })
    } catch {
      /* gone */
    }
  }
  // the process's messages are read (and dropped) so its stream never backs up
  void (async () => {
    try {
      for await (const _ of handle) {
        if (closed) break
      }
    } catch {
      /* the process ended */
    }
  })()

  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'bound'>((resolve) => {
    timer = setTimeout(() => resolve('bound'), bound)
  })
  const race = <T>(p: Promise<T>): Promise<T | 'bound'> => Promise.race([p, deadline])
  let last: TurnToolStatusServer[] | null = null
  let login: string | null = null
  try {
    if (typeof handle.mcpServerStatus !== 'function') throw new Error('this Claude Code cannot report its servers’ status')
    if (typeof handle.initializationResult === 'function') {
      const init = await race(handle.initializationResult().catch(() => null))
      if (init === 'bound') throw new CheckTimeout(bound)
      const email = asObject(asObject(init)?.account)?.email
      login = typeof email === 'string' && email !== '' ? email : null
    }
    for (;;) {
      const rows = await race(handle.mcpServerStatus())
      if (rows === 'bound') break
      if (Array.isArray(rows)) last = statusServers(rows)
      if (!last || !last.some((s) => s.status === 'pending')) break
      const wait = await race(new Promise<'again'>((resolve) => setTimeout(() => resolve('again'), REASK_MS)))
      if (wait === 'bound') break
    }
  } finally {
    clearTimeout(timer)
    close()
  }
  if (last === null) throw new CheckTimeout(bound)
  return {
    login,
    connectorsOn: connectorsOnFor({
      cwd: input.folder,
      home: input.home,
      configDir,
      sources,
      flagSettings: settings,
      claudeLogin: provider === null || provider.kind === 'claude-account',
      strict: false,
      ...(input.managedDir ? { managedDir: input.managedDir } : {}),
    }),
    servers: last,
    complete: !last.some((s) => s.status === 'pending'),
    ms: Date.now() - started,
  }
}

/** Whether a conversation in the folder on this login fetches what its
 *  Claude account sends: a gateway key has no account; a layer that sets
 *  `disableClaudeAiConnectors` turns it off here. */
export function claudeSends(input: { folder: string; home: string; provider: LoadsCheckInput['provider']; managedDir?: string }): {
  account: boolean
  here: boolean
} {
  const account = input.provider === null || input.provider.kind === 'claude-account'
  if (!account) return { account: false, here: false }
  const configDir = input.provider?.kind === 'claude-account' ? input.provider.configDir : null
  return {
    account,
    here: connectorsOnFor({
      cwd: input.folder,
      home: input.home,
      configDir,
      sources: ['user', 'project', 'local'],
      flagSettings: {},
      claudeLogin: true,
      strict: false,
      ...(input.managedDir ? { managedDir: input.managedDir } : {}),
    }),
  }
}
