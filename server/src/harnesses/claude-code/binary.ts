// harnesses/claude-code/binary.ts — the ONE Claude Code binary Silos runs
// (the console CLI and the chat engine always move together,
// never two Claude Code versions). Consoles launch `claude` from PATH
// (console.ts); every Agent SDK query — chat turns, the titler, the model
// catalog — is handed that same binary as `pathToClaudeCodeExecutable`
// (sdk.ts, models.ts), so one `claude update` (or Claude Code's own
// auto-update) moves both. The SDK documents this: «Please ensure Claude
// Code is installed via native installer or specify a valid path with
// options.pathToClaudeCodeExecutable» (sdk.mjs, 0.3.319).
//
// The path handed over is the PATH entry itself (~/.local/bin/claude on a
// native install), never its realpath: the native installer repoints that
// symlink at versions/<new> on update, so every spawn follows it to the
// current version. Resolved per call (a PATH walk, no cache) — an install
// or update between turns is seen at once.
//
// The SDK npm package is the client library only. Its own platform binaries
// (the -linux-x64 / -musl optional packages) are never run. Its package.json
// names the Claude Code release it is paired with (`claudeCodeVersion`,
// 0.3.N ↔ 2.1.N) — Silos' minimum (version.ts).
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { executableOnPath } from '../../engine-path.js'

/** The console's command, the name looked up on PATH. */
export const CLAUDE_CMD = 'claude'

/** The `claude` on PATH (first executable file), or null when there is none. */
export function claudeOnPath(path: string | undefined = process.env.PATH, cmd: string = CLAUDE_CMD): string | null {
  return executableOnPath(cmd, path)
}

/** Where Claude Code's documented native installer puts `claude`
 *  (https://claude.ai/install.sh → ~/.local/bin/claude). */
export function claudeInstallDirs(home: string): string[] {
  return [join(home, '.local', 'bin')]
}

/** Said when no `claude` is on PATH (the turn, the titler, the catalog). */
export const CLAUDE_MISSING = 'Claude Code is not installed — no `claude` on PATH'

/** The options every SDK query gets (sdk.ts, models.ts): the one `claude`.
 *  No `claude` on PATH → refused in one line, never handed to the SDK's
 *  bundled binary. */
export function withClaudeExecutable<T extends object>(options: T): T & { pathToClaudeCodeExecutable: string } {
  const bin = claudeOnPath()
  if (!bin) throw new Error(CLAUDE_MISSING)
  return { ...options, pathToClaudeCodeExecutable: bin }
}

/** The Agent SDK library's version and the Claude Code release it is paired
 *  with (its package.json `claudeCodeVersion`). Read once: it only changes
 *  with a Silos update (npm install + restart). null = unreadable. */
export interface SdkPairing {
  library: string
  pairedWith: string
}

let pairing: SdkPairing | null | undefined

export function sdkPairing(): SdkPairing | null {
  if (pairing !== undefined) return pairing
  pairing = readPairing()
  return pairing
}

function readPairing(): SdkPairing | null {
  try {
    // the package BLOCKS a deep import of its package.json (`exports`); its
    // MAIN entry is allowed and sits next to it (…/claude-agent-sdk/sdk.mjs)
    const main = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk')
    const pkg = JSON.parse(readFileSync(join(dirname(main), 'package.json'), 'utf8')) as { version?: unknown; claudeCodeVersion?: unknown }
    if (typeof pkg.version !== 'string' || typeof pkg.claudeCodeVersion !== 'string') return null
    return { library: pkg.version, pairedWith: pkg.claudeCodeVersion }
  } catch {
    return null
  }
}
