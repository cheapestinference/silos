// resident/helpers.ts — the resident's small pure helpers and its default
// process probes (moved verbatim from resident.ts).
import { timingSafeEqual } from 'node:crypto'
import { exec as execCb } from 'node:child_process'
import { promisify } from 'node:util'
import type { Run } from '../automations-types.js'

const pexec = promisify(execCb)

export function contextWindowFor(model?: string): number {
  // Cheap heuristic: "[1m]" models (Fable 5 with a 1M window) vs. the 200k
  // standard — enough for the 85% threshold, no need for an exact
  // per-model catalog.
  if (model && /1m/i.test(model)) return 1_000_000
  return 200_000
}

export function looksLikeTooLong(text: string): boolean {
  return text.toLowerCase().includes('prompt is too long')
}

// The most recent instant a Run shows activity, for the mission watchdog's
// min-interval check — the latest of whichever of endedAt/startedAt/at are
// present (rather than a fixed preference order) so a run with an unusual
// or partial shape (e.g. 'skipped'/'waiting_approval', which never got a
// startedAt/endedAt) still yields its truest last-activity instant instead
// of NaN. `at` alone is guaranteed present on every Run, so this only
// returns null when there's no run at all.
export function lastRunActivityMs(run: Run | null): number | null {
  if (!run) return null
  const candidates = [run.endedAt, run.startedAt, run.at]
    .filter((s): s is string => typeof s === 'string')
    .map((s) => Date.parse(s))
    .filter((n) => !Number.isNaN(n))
  return candidates.length > 0 ? Math.max(...candidates) : null
}

// Constant-time comparison of the webhook secret. `timingSafeEqual`
// requires equal-length buffers (or it throws) — that's why each string is
// PADDED to the same max length BEFORE comparing (so not even the secret's
// real length leaks via an early return), and the real length equality is
// checked separately with a normal boolean (it isn't secret: anyone
// looking at the body/headers already knows it).
export function secretsMatch(expected: string, actual: string): boolean {
  const maxLen = Math.max(expected.length, actual.length, 1)
  const a = Buffer.alloc(maxLen)
  const b = Buffer.alloc(maxLen)
  a.write(expected, 'utf8')
  b.write(actual, 'utf8')
  return timingSafeEqual(a, b) && expected.length === actual.length
}

// Minimal glob (chokidar 5 doesn't accept them — same criterion as
// harnesses/claude-code/watcher.ts): supports '*' (anything but '/'), '**' (anything incl. '/')
// and '?'.
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*'
      i += 1
      if (glob[i + 1] === '/') i += 1
    } else if (c === '*') {
      re += '[^/]*'
    } else if (c === '?') {
      re += '[^/]'
    } else if ('.+^$()|{}[]\\'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return new RegExp('^' + re + '$')
}

export interface CheckResult {
  fingerprint: string
  summary: string
  exitCode?: number
  matchedText?: string
}

export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function defaultExecFn(command: string, cwd: string): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await pexec(command, { cwd })
    return { stdout, code: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number }
    return { stdout: (e.stdout ?? '') + (e.stderr ?? ''), code: typeof e.code === 'number' ? e.code : 1 }
  }
}
