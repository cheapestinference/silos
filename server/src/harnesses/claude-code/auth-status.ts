// harnesses/claude-code/auth-status.ts — who an account is signed in as,
// asked to Claude Code itself: `claude auth status --json` (listed by
// `claude auth --help`), the documented way. Never Claude's files: the
// login is not always a .credentials.json (macOS keeps it in the Keychain,
// an ANTHROPIC_API_KEY login has none) and ~/.claude.json is the CLI's own
// state, not an interface.
//
// The same `claude` the chats and consoles run (binary.ts), under an env
// built here from nothing: PATH, HOME, the locale and the user — plus
// CLAUDE_CONFIG_DIR for an extra account, and no CLAUDE_CONFIG_DIR at all
// for the machine's own (exactly what its operator would type). Nothing
// CLAUDE_*/ANTHROPIC_*/CLAUDECODE of Silos' own process ever reaches it.
//
// Nothing is guessed: no `claude`, a timeout, a non-zero exit or an answer
// that is not the JSON object ⇒ signed out. Pages list accounts on every
// render, so each account's answer is kept a short while (TTL); a read
// that must be fresh (the sign-in's verify) asks again.
import { execFile } from 'node:child_process'
import { claudeOnPath } from './binary.js'

/** What Silos takes from the answer. */
export interface ClaudeIdentity {
  loggedIn: boolean
  email: string | null
  /** the subscription as said on screen («Max», «Pro»); null without one (an API key) */
  plan: string | null
  organizationName: string | null
}

export const SIGNED_OUT: ClaudeIdentity = Object.freeze({ loggedIn: false, email: null, plan: null, organizationName: null })

export interface AuthStatusCall {
  file: string
  args: string[]
  env: Record<string, string>
  timeoutMs: number
}
/** code null = it never exited by itself (not started, killed by the timeout). */
export type AuthStatusRunner = (call: AuthStatusCall) => Promise<{ code: number | null; stdout: string }>

export const AUTH_STATUS_ARGS = ['auth', 'status', '--json'] as const

const defaultRunner: AuthStatusRunner = (call) =>
  new Promise((resolve) => {
    execFile(
      call.file,
      call.args,
      { env: call.env, timeout: call.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, windowsHide: true },
      (err, stdout) => {
        if (!err) return resolve({ code: 0, stdout: String(stdout) })
        const code = (err as { code?: unknown }).code
        resolve({ code: typeof code === 'number' ? code : null, stdout: String(stdout ?? '') })
      },
    )
  })

// The variables a process needs to be the user on this machine — and only
// those (the locale for Claude's own output, TMPDIR for its scratch).
const KEPT_ENV = ['PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR'] as const

/** The env `claude auth status` runs under — built, never inherited. */
export function authStatusEnv(home: string, configDir: string | null, from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const k of KEPT_ENV) {
    const v = from[k]
    if (typeof v === 'string' && v !== '') env[k] = v
  }
  env.HOME = home
  if (configDir !== null) env.CLAUDE_CONFIG_DIR = configDir
  return env
}

/** The answer → what Silos shows. Not the object Claude prints ⇒ signed out. */
export function parseAuthStatus(stdout: string): ClaudeIdentity {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return SIGNED_OUT
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return SIGNED_OUT
  const o = raw as Record<string, unknown>
  if (o.loggedIn !== true) return SIGNED_OUT
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
  const sub = str(o.subscriptionType)
  return {
    loggedIn: true,
    email: str(o.email),
    plan: sub ? sub.charAt(0).toUpperCase() + sub.slice(1) : null,
    organizationName: str(o.orgName),
  }
}

export interface ClaudeIdentityOptions {
  /** the machine's home (HOME of every ask) — cfg.home, never os.homedir() directly */
  home: string
  runner?: AuthStatusRunner
  /** the `claude` to ask; default: the one on PATH (binary.ts) */
  bin?: () => string | null
  ttlMs?: number
  timeoutMs?: number
  now?: () => number
}

export class ClaudeIdentityReader {
  private readonly home: string
  private readonly runner: AuthStatusRunner
  private readonly bin: () => string | null
  private readonly ttlMs: number
  private readonly timeoutMs: number
  private readonly now: () => number
  private readonly cache = new Map<string, { at: number; value: Promise<ClaudeIdentity> }>()

  constructor(opts: ClaudeIdentityOptions) {
    this.home = opts.home
    this.runner = opts.runner ?? defaultRunner
    this.bin = opts.bin ?? (() => claudeOnPath())
    this.ttlMs = opts.ttlMs ?? 30_000
    this.timeoutMs = opts.timeoutMs ?? 3_000
    this.now = opts.now ?? Date.now
  }

  /** configDir null = the machine's own account. `fresh` skips the kept answer
   *  (and replaces it): the sign-in's verify must see a login the moment it lands. */
  read(configDir: string | null, opts: { fresh?: boolean } = {}): Promise<ClaudeIdentity> {
    const key = configDir ?? ''
    const kept = this.cache.get(key)
    if (!opts.fresh && kept && this.now() - kept.at < this.ttlMs) return kept.value
    const value = this.ask(configDir)
    this.cache.set(key, { at: this.now(), value })
    return value
  }

  private async ask(configDir: string | null): Promise<ClaudeIdentity> {
    const file = this.bin()
    if (!file) return SIGNED_OUT
    try {
      const { code, stdout } = await this.runner({ file, args: [...AUTH_STATUS_ARGS], env: authStatusEnv(this.home, configDir), timeoutMs: this.timeoutMs })
      return code === 0 ? parseAuthStatus(stdout) : SIGNED_OUT
    } catch {
      return SIGNED_OUT
    }
  }
}
