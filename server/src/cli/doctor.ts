// cli/doctor.ts — `silos doctor`: what this machine needs for Silos to run,
// said one line each, with the command that fixes what is wrong (q4 t48).
//
// The server already knows every one of these facts, but only once it is up
// and only in the browser; doctor is for the moment before that — an install
// that will not start, a console that will not open — and reads the same
// sources: the engines' own verdicts (harness.ts), the data directory the
// server would use (config.ts), the port it would bind. It changes nothing.
//
// Three states: `ok`, `warn` (Silos runs, something is missing) and `fail`
// (Silos, or its consoles, will not run) — the command exits 1 on any fail.
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import type { EngineCompat } from '../harness-run.js'
import type { ServiceStatus } from './service.js'

export type CheckState = 'ok' | 'warn' | 'fail'
export interface Check {
  name: string
  state: CheckState
  says: string
  fix?: string
}

export const NODE_FLOOR: readonly [number, number] = [22, 13]
export const TOOLCHAIN_FIX =
  'install a C/C++ toolchain (Debian/Ubuntu: sudo apt install build-essential python3 · macOS: xcode-select --install), then install Silos again'

export type PortState = 'silos' | 'free' | 'taken'

export interface DoctorDeps {
  nodeVersion: string
  dataDir: string
  host: string
  port: number
  /** first executable of that name on PATH, or null */
  onPath: (cmd: string) => string | null
  /** loads the terminal's native module; throws when it cannot */
  loadTerminal: () => Promise<void>
  /** every registered engine's verdict, and which one Silos cannot do without */
  engines: () => Promise<{ required: string; verdicts: EngineCompat[] }>
  portState: () => Promise<PortState>
  service: () => Promise<ServiceStatus>
}

export function nodeCheck(version: string): Check {
  const [major = 0, minor = 0] = version.split('.').map(Number)
  const ok = major > NODE_FLOOR[0] || (major === NODE_FLOOR[0] && minor >= NODE_FLOOR[1])
  return ok
    ? { name: 'Node.js', state: 'ok', says: version }
    : {
        name: 'Node.js',
        state: 'fail',
        says: `${version} — Silos needs ${NODE_FLOOR.join('.')} or newer`,
        fix: 'install a current Node.js (https://nodejs.org), then run this again',
      }
}

/** An engine's verdict as a check. The engine Silos cannot do without fails
 *  when it is missing or too old; any other engine is optional — absent says
 *  nothing, too old is a warning. */
export function engineCheck(v: EngineCompat, required: boolean): Check | null {
  if (v.state === 'ok') return { name: v.name, state: 'ok', says: v.installed ?? 'installed' }
  // the verdict's own message names the repo's command; an install moves with `silos update`
  if (v.state === 'ahead')
    return {
      name: v.name,
      state: 'warn',
      says: `${v.installed} is newer than this Silos was verified with (${v.needed}) — chats keep running`,
      fix: 'silos update',
    }
  if (v.state === 'missing') {
    return required ? { name: v.name, state: 'fail', says: 'not found on PATH — your agents run on it', fix: v.update ?? undefined } : null
  }
  return { name: v.name, state: required ? 'fail' : 'warn', says: `${v.installed} is older than Silos needs (${v.needed})`, fix: v.update ?? undefined }
}

export function dataDirCheck(dir: string): Check {
  const name = 'Data directory'
  if (!existsSync(dir)) return { name, state: 'ok', says: `${dir} — created at the first start` }
  try {
    accessSync(dir, constants.R_OK | constants.W_OK | constants.X_OK)
  } catch {
    return { name, state: 'fail', says: `${dir} is not writable by this user`, fix: `sudo chown -R "$(id -un)" "${dir}"` }
  }
  // transcripts and credentials end up under it: nobody else on the machine reads it
  // (the server closes it at every start — config.ts; this is a directory it has not started on since)
  if ((statSync(dir).mode & 0o077) !== 0) return { name, state: 'warn', says: `${dir} is readable by other users of this machine`, fix: `chmod 700 "${dir}"` }
  return { name, state: 'ok', says: dir }
}

export function portCheck(state: PortState, host: string, port: number): Check {
  const name = `Port ${port}`
  if (state === 'silos') return { name, state: 'ok', says: `Silos is running at http://${host}:${port}` }
  if (state === 'free') return { name, state: 'ok', says: 'free' }
  return { name, state: 'fail', says: 'taken by another program', fix: `stop it, or start Silos on another port: SILOS_PORT=${port + 1} silos` }
}

export function serviceCheck(s: ServiceStatus): Check {
  const name = 'Background service'
  if (s.kind === 'unsupported') return { name, state: 'ok', says: `not available here (${s.why}) — Silos runs while its terminal is open` }
  if (!s.installed) return { name, state: 'ok', says: 'not installed — Silos stops when its terminal closes; `silos service install` keeps it running' }
  return s.active
    ? { name, state: 'ok', says: 'installed and running' }
    : { name, state: 'warn', says: 'installed but not running', fix: 'silos service start   (what it said last: silos service logs)' }
}

export async function runDoctor(d: DoctorDeps): Promise<Check[]> {
  const checks: Check[] = [nodeCheck(d.nodeVersion)]

  // the terminal module first: the engines' adapters load it too
  let terminal = true
  try {
    await d.loadTerminal()
    checks.push({ name: 'Terminal module', state: 'ok', says: 'node-pty loads' })
  } catch (err) {
    terminal = false
    checks.push({
      name: 'Terminal module',
      state: 'fail',
      says: `node-pty does not load (${firstLine(err)}) — the console in the browser needs it`,
      fix: TOOLCHAIN_FIX,
    })
  }

  try {
    const { required, verdicts } = await d.engines()
    for (const v of verdicts) {
      const c = engineCheck(v, v.harness === required)
      if (c) checks.push(c)
    }
  } catch (err) {
    // without the terminal module the adapters may not load at all: one failure, said once
    if (terminal) checks.push({ name: 'Engines', state: 'fail', says: `could not be read (${firstLine(err)})` })
  }

  checks.push(
    d.onPath('tmux')
      ? { name: 'tmux', state: 'ok', says: 'installed' }
      : {
          name: 'tmux',
          state: 'warn',
          says: 'not installed — conversations open as chat, without the real console',
          fix: 'Debian/Ubuntu: sudo apt install tmux · macOS: brew install tmux',
        },
  )
  checks.push(
    d.onPath('git')
      ? { name: 'git', state: 'ok', says: 'installed' }
      : {
          name: 'git',
          state: 'warn',
          says: 'not installed — agents work in real repositories',
          fix: 'Debian/Ubuntu: sudo apt install git · macOS: xcode-select --install',
        },
  )

  checks.push(dataDirCheck(d.dataDir))
  checks.push(portCheck(await d.portState(), d.host, d.port))
  checks.push(serviceCheck(await d.service()))
  return checks
}

const MARK: Record<CheckState, string> = { ok: '✓', warn: '!', fail: '✗' }

export function renderChecks(checks: Check[]): string {
  const lines: string[] = []
  for (const c of checks) {
    lines.push(`${MARK[c.state]} ${c.name}: ${c.says}`)
    if (c.fix && c.state !== 'ok') lines.push(`    → ${c.fix}`)
  }
  const fails = checks.filter((c) => c.state === 'fail').length
  const warns = checks.filter((c) => c.state === 'warn').length
  lines.push('')
  lines.push(
    fails > 0
      ? `${fails} thing${fails === 1 ? '' : 's'} to fix before Silos runs well.`
      : warns > 0
        ? `Silos runs. ${warns} thing${warns === 1 ? '' : 's'} worth a look.`
        : 'Everything Silos needs is here.',
  )
  return lines.join('\n')
}

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 160)
}

/** Who holds the port: a Silos that answers its health route, nobody, or
 *  something else. */
export async function probePort(host: string, port: number, fetchFn: typeof fetch = fetch): Promise<PortState> {
  try {
    const res = await fetchFn(`http://${host}:${port}/healthz`, { signal: AbortSignal.timeout(1500) })
    const body = (await res.json()) as { ok?: unknown }
    if (res.ok && body?.ok === true) return 'silos'
  } catch {
    /* nobody answers there, or not a Silos */
  }
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve('taken'))
    probe.listen({ host, port }, () => probe.close(() => resolve('free')))
  })
}
