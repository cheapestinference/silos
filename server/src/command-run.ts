// command-run.ts — the exec behind a command automation. No shell: argv[0]
// is spawned with argv[1..] as its arguments, so `;`, `>>` or `$( )` in an
// argument are just characters. The child gets ONLY the env it is handed
// (the resident builds it: the agent's Vault + agent state + PATH/HOME),
// runs in its own process group so a timeout takes its children too, and
// its stdout+stderr land in one log — capped, tail kept, and with every
// injected secret value replaced by ••• BEFORE a byte reaches the disk.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

export const LOG_CAP_BYTES = 1024 * 1024
export const REDACTED = '•••'
// A secret shorter than this is not searched for in the output: a value
// like "1" or "eu" would blot out unrelated text and say nothing safe.
export const MIN_SECRET_LENGTH = 4
// How many run logs one automation keeps (oldest go first).
export const LOGS_KEPT_PER_AUTOMATION = 50
const KILL_GRACE_MS = 5000

const STATE_VAR = /\$\{SILOS_AGENT_STATE\}|\$SILOS_AGENT_STATE(?![A-Za-z0-9_])/g

// `$SILOS_AGENT_STATE` / `${SILOS_AGENT_STATE}` → the agent's state dir —
// the one variable Silos knows before the run. Nothing else is
// expanded: there is no shell.
export function expandAgentState(s: string, stateDir: string | null): string {
  if (!mentionsAgentState(s)) return s
  if (stateDir === null) throw new Error('$SILOS_AGENT_STATE is not available for this agent')
  return s.replace(STATE_VAR, () => stateDir)
}

export function mentionsAgentState(s: string): boolean {
  STATE_VAR.lastIndex = 0
  const hit = STATE_VAR.test(s)
  STATE_VAR.lastIndex = 0
  return hit
}

// every secret value (long enough to be one), longest first so a secret that
// contains another is masked whole
export function redactor(secrets: readonly string[]): (text: string) => string {
  const list = [...new Set(secrets.filter((s) => typeof s === 'string' && s.length >= MIN_SECRET_LENGTH))].sort((a, b) => b.length - a.length)
  return (text) => {
    let out = text
    for (const s of list) if (out.includes(s)) out = out.split(s).join(REDACTED)
    return out
  }
}

export function lastNonEmptyLine(text: string, max = 200): string | undefined {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!.trim()
    if (l !== '') return l.length > max ? `${l.slice(0, max - 1)}…` : l
  }
  return undefined
}

export function tailLines(text: string, n: number): string {
  const lines = text.replace(/\n+$/, '').split('\n')
  return lines.slice(-n).join('\n')
}

export interface CommandExecInput {
  argv: string[]
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  logFile: string
  secrets: readonly string[]
  killGraceMs?: number
}

export interface CommandExecResult {
  exitCode?: number
  timedOut: boolean
  error?: string // never started, or ended by a signal it was not sent by us
  durationMs: number
  output: string // the redacted text written to the log (tail kept)
  logBytes: number
  lastLine?: string
}

export async function runCommand(input: CommandExecInput): Promise<CommandExecResult> {
  const t0 = Date.now()
  const redact = redactor(input.secrets)
  const margin = Math.max(0, ...input.secrets.map((s) => Buffer.byteLength(s))) + 1
  const windowBytes = LOG_CAP_BYTES + margin
  const chunks: Buffer[] = []
  let kept = 0
  let total = 0
  let dropped = false
  const onData = (b: Buffer): void => {
    chunks.push(b)
    kept += b.length
    total += b.length
    while (chunks.length > 1 && kept - chunks[0]!.length >= windowBytes) {
      kept -= chunks.shift()!.length
      dropped = true
    }
  }

  const finish = (r: { exitCode?: number; timedOut: boolean; error?: string }): CommandExecResult => {
    let buf = Buffer.concat(chunks)
    if (buf.length > windowBytes) {
      buf = buf.subarray(buf.length - windowBytes)
      dropped = true
    }
    let text = redact(buf.toString('utf8'))
    if (dropped) {
      // the head of the window may hold the tail of a secret cut in half —
      // a partial value the redactor cannot recognise: drop it, and the
      // rest of that line
      text = text.slice(margin)
      const nl = text.indexOf('\n')
      if (nl >= 0 && nl < 8192) text = text.slice(nl + 1)
    }
    const header = dropped ? `[… earlier output dropped — ${total} bytes in all, the last ${Math.round(LOG_CAP_BYTES / 1024)} KB kept]\n` : ''
    const room = LOG_CAP_BYTES - Buffer.byteLength(header)
    if (Buffer.byteLength(text) > room) {
      text = Buffer.from(text).subarray(-room).toString('utf8')
      const nl = text.indexOf('\n')
      if (nl >= 0 && nl < 8192) text = text.slice(nl + 1)
    }
    const content = header + text
    let logBytes = 0
    try {
      mkdirSync(dirname(input.logFile), { recursive: true, mode: 0o700 })
      writeFileSync(input.logFile, content, { mode: 0o600 })
      logBytes = Buffer.byteLength(content)
      pruneLogs(dirname(input.logFile))
    } catch (err) {
      console.warn(`command-run: could not write ${input.logFile}: ${err instanceof Error ? err.message : String(err)}`)
    }
    const lastLine = lastNonEmptyLine(text)
    return {
      ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}),
      timedOut: r.timedOut,
      ...(r.error !== undefined ? { error: r.error } : {}),
      durationMs: Date.now() - t0,
      output: text,
      logBytes,
      ...(lastLine !== undefined ? { lastLine } : {}),
    }
  }

  if (input.argv.length === 0 || input.argv[0] === '') return finish({ timedOut: false, error: 'no command to run' })
  if (!isAbsolute(input.cwd) || !existsSync(input.cwd)) return finish({ timedOut: false, error: `its folder does not exist: ${input.cwd}` })

  return new Promise<CommandExecResult>((resolve) => {
    let settled = false
    let timedOut = false
    let killTimer: NodeJS.Timeout | undefined
    let hardTimer: NodeJS.Timeout | undefined
    let timer: NodeJS.Timeout | undefined
    const done = (r: { exitCode?: number; timedOut: boolean; error?: string }): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      if (hardTimer) clearTimeout(hardTimer)
      resolve(finish(r))
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(input.argv[0]!, input.argv.slice(1), {
        cwd: input.cwd,
        env: input.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        shell: false,
      })
    } catch (err) {
      done({ timedOut: false, error: err instanceof Error ? err.message : String(err) })
      return
    }
    const killGroup = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, sig)
      } catch {
        /* already gone */
      }
    }
    const grace = input.killGraceMs ?? KILL_GRACE_MS
    timer = setTimeout(() => {
      timedOut = true
      killGroup('SIGTERM')
      killTimer = setTimeout(() => killGroup('SIGKILL'), grace)
      // a grandchild that left the group can keep the pipes open forever:
      // the run still ends
      hardTimer = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        done({ timedOut: true })
      }, grace * 2)
    }, input.timeoutMs)
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (err) => done({ timedOut: false, error: (err as NodeJS.ErrnoException).code === 'ENOENT' ? `not found: ${input.argv[0]}` : err.message }))
    child.on('close', (code, signal) => {
      if (timedOut) done({ timedOut: true })
      else if (typeof code === 'number') done({ exitCode: code, timedOut: false })
      else done({ timedOut: false, error: `killed by ${signal ?? 'a signal'}` })
    })
  })
}

function pruneLogs(dir: string): void {
  const logs = readdirSync(dir).filter((f) => f.endsWith('.log'))
  if (logs.length <= LOGS_KEPT_PER_AUTOMATION) return
  const byAge = logs
    .map((f) => ({
      f,
      t: (() => {
        try {
          return statSync(join(dir, f)).mtimeMs
        } catch {
          return 0
        }
      })(),
    }))
    .sort((a, b) => a.t - b.t)
  for (const { f } of byAge.slice(0, logs.length - LOGS_KEPT_PER_AUTOMATION)) {
    try {
      unlinkSync(join(dir, f))
    } catch {
      /* gone already */
    }
  }
}
