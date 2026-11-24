// harnesses/claude-code/loads/projected.ts — what a plugin this project does
// not load would add to every start, in Claude Code's own estimate
// (docs/architecture.md «Tool weight»; spec tools-origin §6 Weight).
//
// `claude plugin details <id>` — a documented subcommand (`claude plugin
// --help`) that starts no session, sends no prompt and writes nothing —
// prints a table for people, with no machine output. Silos reads ONE figure
// from it: the «Always-on: ~N tok added to every session» line, and only on
// an engine version that line was confirmed on (PROJECTED_CONFIRMED_ON):
// another version shows nothing until it is confirmed. Every count a row
// shows comes from the plugin's manifest (inventory.ts carriesOf), never
// from this output — its MCP count includes placeholders and it does not
// count MCP tool schemas.
//
// Run as `claude auth status --json` is (auth-status.ts): the same `claude`
// on PATH, an env built from nothing but the user's (and the login's config
// dir), bounded and killed at the bound, ONE at a time machine-wide, and
// only when the owner opens the row (the route is owner-only). A figure is
// kept in memory per plugin version (and login and engine version): a
// second opening never runs it again. A timeout or a refusal is not kept —
// the next opening asks again.
import { execFile } from 'node:child_process'
import { claudeOnPath } from '../binary.js'
import { authStatusEnv } from '../auth-status.js'
import type { LoadsProjectedInput } from '../../contract.js'

/** The engine versions the Always-on line was read on, by hand, from the
 *  real output (23-11: 2.1.330 — «  Always-on:   ~619 tok   added to every
 *  session», «~1,125 tok» with a thousands comma). */
export const PROJECTED_CONFIRMED_ON: readonly string[] = ['2.1.330']
/** The bound: the process is killed at it. */
export const PROJECTED_BOUND_MS = 8_000
/** Whose estimate, said after the figure. */
export const PROJECTED_BY = 'Claude Code’s estimate'

export interface DetailsCall {
  file: string
  args: string[]
  env: Record<string, string>
  cwd: string
  timeoutMs: number
}
/** code null = it never exited by itself (not started, killed at the bound). */
export type DetailsRunner = (call: DetailsCall) => Promise<{ code: number | null; stdout: string }>

const defaultRunner: DetailsRunner = (call) =>
  new Promise((resolve) => {
    execFile(
      call.file,
      call.args,
      { env: call.env, cwd: call.cwd, timeout: call.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, windowsHide: true },
      (err, stdout) => {
        if (!err) return resolve({ code: 0, stdout: String(stdout) })
        const code = (err as { code?: unknown }).code
        resolve({ code: typeof code === 'number' ? code : null, stdout: String(stdout ?? '') })
      },
    )
  })

// a plugin id as the engine names it: `<name>@<marketplace>` — never
// something the CLI could read as a flag
const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/
// the one line read: «  Always-on:   ~619 tok   added to every session»
const ALWAYS_ON = /^\s*Always-on:\s+~?(\d{1,3}(?:,\d{3})+|\d+|\d+(?:\.\d+)?k)\s+tok\s+added to every session\s*$/

/** The Always-on figure, or null when the output is not the confirmed shape:
 *  exactly one such line, under the «Projected token cost» heading. */
export function parseAlwaysOn(stdout: string): number | null {
  const lines = stdout.split(/\r?\n/)
  const head = lines.findIndex((l) => l.trim() === 'Projected token cost')
  if (head < 0) return null
  const hits = lines.map((l, i) => ({ i, m: ALWAYS_ON.exec(l) })).filter((x) => x.m !== null)
  if (hits.length !== 1 || hits[0]!.i !== head + 1) return null
  const raw = hits[0]!.m![1]!
  const n = raw.endsWith('k') ? Math.round(Number(raw.slice(0, -1)) * 1000) : Number(raw.replace(/,/g, ''))
  return Number.isFinite(n) && n >= 0 ? n : null
}

export interface ProjectionOptions {
  runner?: DetailsRunner
  /** the `claude` to run; default: the one on PATH (binary.ts) */
  bin?: () => string | null
  timeoutMs?: number
}

export class ClaudePluginProjection {
  private readonly runner: DetailsRunner
  private readonly bin: () => string | null
  private readonly timeoutMs: number
  private readonly kept = new Map<string, Promise<number | null>>()
  private tail: Promise<unknown> = Promise.resolve()

  constructor(opts: ProjectionOptions = {}) {
    this.runner = opts.runner ?? defaultRunner
    this.bin = opts.bin ?? (() => claudeOnPath())
    this.timeoutMs = opts.timeoutMs ?? PROJECTED_BOUND_MS
  }

  /** The tokens the plugin row would add to every start, or null: not a
   *  plugin, an engine version the line was not confirmed on, no `claude`,
   *  a timeout, a refusal, an output it cannot read. */
  estimate(input: LoadsProjectedInput): Promise<number | null> {
    const { row } = input
    if (row.kind !== 'plugin' || !PLUGIN_ID.test(row.name)) return Promise.resolve(null)
    if (typeof input.engineVersion !== 'string' || !PROJECTED_CONFIRMED_ON.includes(input.engineVersion)) return Promise.resolve(null)
    const configDir = input.provider?.kind === 'claude-account' ? (input.provider.configDir ?? null) : null
    const key = [configDir ?? '', row.name, row.detail ?? '', input.engineVersion].join('\u0000')
    const kept = this.kept.get(key)
    if (kept) return kept
    const value = this.queued(() => this.ask(row.name, input.folder, input.home, configDir)).then((r) => {
      if (!r.keep) this.kept.delete(key)
      return r.tokens
    })
    this.kept.set(key, value)
    return value
  }

  // one at a time: each run starts when the one before it has ended
  private queued<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(run, run)
    this.tail = next.catch(() => undefined)
    return next
  }

  private async ask(id: string, folder: string, home: string, configDir: string | null): Promise<{ tokens: number | null; keep: boolean }> {
    const file = this.bin()
    if (!file) return { tokens: null, keep: false }
    try {
      const { code, stdout } = await this.runner({
        file,
        args: ['plugin', 'details', id],
        env: authStatusEnv(home, configDir),
        cwd: folder,
        timeoutMs: this.timeoutMs,
      })
      if (code !== 0) return { tokens: null, keep: false }
      return { tokens: parseAlwaysOn(stdout), keep: true }
    } catch {
      return { tokens: null, keep: false }
    }
  }
}
