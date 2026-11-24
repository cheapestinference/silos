// The class guard of the event loop (perf 21-11): the server is ONE event
// loop that also relays the owner's live consoles, so a synchronous child
// process (spawnSync / execFileSync / execSync — a fork that blocks the
// loop 20–200 ms on a loaded machine, and forever if the child stalls)
// freezes every terminal for its length. No server module may start one on
// a path a request, a WebSocket message or a periodic tick reaches; the
// tmux calls are async (terminal-service.ts tmuxExec).
//
// What remains is listed here, each with WHY, by the exact number of
// occurrences (a ratchet: a new one anywhere fails; removing one asks for
// its entry to shrink). Identifiers are read from the AST, so a comment
// that names them is not code.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { codeWords } from './helpers/module-specifiers.js'
import { TMUX_TIMEOUT_MS } from '../src/terminal-service.js'

const SRC = new URL('../src/', import.meta.url).pathname
const SYNC_SPAWN = new Set(['spawnSync', 'execFileSync', 'execSync'])

const ALLOWED: Record<string, { count: number; why: string }> = {
  // the `silos` command (doctor, service, update): its own short-lived
  // process in the operator's terminal — never the server's loop
  'cli/main.ts': { count: 6, why: 'the CLI entry point, a separate process' },
  // known debt, bounded (3 s timeout): the git root of a folder for the
  // ~/.claude.json project entry (display). Async needs its readers async.
  'claude-project-key.ts': { count: 3, why: 'git rev-parse for display, bounded at 3 s — debt' },
  // known debt, bounded (3 s timeout): after Silos writes a folder's
  // settings.local.json, git is asked whether it is already ignored.
  'harnesses/claude-code/local-settings.ts': { count: 4, why: 'git check-ignore after an owner settings write, bounded at 3 s — debt' },
}

function files(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...files(p))
    else if (/\.(ts|mts|cts)$/.test(name) && !name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

describe("no synchronous child process in the server (the event loop is the owner's consoles)", () => {
  const found = new Map<string, number>()
  for (const f of files(SRC)) {
    const n = codeWords(readFileSync(f, 'utf8'), f).filter((w) => SYNC_SPAWN.has(w)).length
    if (n > 0) found.set(relative(SRC, f), n)
  }

  it('nothing outside the allowlist', () => {
    const outside = [...found].filter(([f]) => !(f in ALLOWED)).map(([f, n]) => `${f} (${n})`)
    expect(outside, 'a sync spawn froze the loop — use async execFile (terminal-service.ts tmuxExec is the model)').toEqual([])
  })

  it('the allowlist is exact (a ratchet: grow it never, shrink it when debt is paid)', () => {
    for (const [f, a] of Object.entries(ALLOWED)) expect({ file: f, count: found.get(f) ?? 0 }).toEqual({ file: f, count: a.count })
  })

  it('terminal-service.ts — every tmux call — starts none, and its async calls are bounded in seconds', () => {
    expect(found.get('terminal-service.ts') ?? 0).toBe(0)
    // 02-11: one unbounded tmux call hung 14 min (tmux can wait on Silos'
    // own attach client); async or not, a stalled call is killed
    expect(TMUX_TIMEOUT_MS).toBeGreaterThan(0)
    expect(TMUX_TIMEOUT_MS).toBeLessThanOrEqual(10_000)
  })
})
