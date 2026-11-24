// harnesses/claude-code/sdk.ts — the one place the Claude Agent SDK's query()
// is bound to Silos' QueryFn. Every query runs the `claude` on PATH — the
// same binary the consoles launch (binary.ts withClaudeExecutable: never two
// Claude Code versions); the SDK's own bundled binaries are never used.
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { QueryFn } from './sdk-types.js'
import { withClaudeExecutable } from './binary.js'

// The SDK hands an inline `settings` object to claude as `--settings <json>`
// on its argv (seen on 0.3.330), where every process of the user reads it in
// /proc/<pid>/cmdline — and a turn's settings carry its fence, the map of
// every other project (D8). So once the server names a dir (index.ts: the
// data dir's console-append, 0700, closed to every agent's file tools), the
// object becomes an owner-only file the SDK passes by path (its documented
// form), removed when the query ends. Unset (a smoke script): inline.
let settingsDir: string | null = null
export function sdkSettingsIn(dir: string | null): void {
  settingsDir = dir
}

function settingsToFile(options: Record<string, unknown>): { options: Record<string, unknown>; file: string | null } {
  const s = options.settings
  if (settingsDir === null || s === null || typeof s !== 'object') return { options, file: null }
  try {
    mkdirSync(settingsDir, { recursive: true, mode: 0o700 })
    const file = join(settingsDir, `turn-${randomUUID()}.settings.json`)
    writeFileSync(file, JSON.stringify(s), { mode: 0o600 })
    chmodSync(file, 0o600)
    return { options: { ...options, settings: file }, file }
  } catch {
    // the fence held beats the fence hidden: inline when the file cannot be written
    return { options, file: null }
  }
}

// Explicit adapter: the SDK boundary is typed on the return (iterator +
// interrupt + the servers' status, turn-status.ts) vs the input (options)
export const sdkQueryFn: QueryFn = (args) => {
  const { options, file } = settingsToFile((args.options ?? {}) as Record<string, unknown>)
  let removed = false
  const remove = (): void => {
    if (file !== null && !removed) {
      removed = true
      rmSync(file, { force: true })
    }
  }
  let handle: ReturnType<typeof query>
  try {
    handle = query({ prompt: args.prompt as Parameters<typeof query>[0]['prompt'], options: withClaudeExecutable(options as object) as never })
  } catch (err) {
    remove()
    throw err
  }
  return {
    [Symbol.asyncIterator]: () => {
      const it = handle[Symbol.asyncIterator]()
      return {
        next: async (...a: [] | [unknown]) => {
          try {
            const r = await it.next(...a)
            if (r.done === true) remove()
            return r
          } catch (err) {
            remove()
            throw err
          }
        },
        return: async (v?: unknown) => {
          remove()
          return it.return ? it.return(v as never) : { done: true as const, value: v as never }
        },
        throw: async (e?: unknown) => {
          remove()
          if (it.throw) return it.throw(e)
          throw e
        },
      }
    },
    interrupt: () => handle.interrupt(),
    mcpServerStatus: () => handle.mcpServerStatus(),
    initializationResult: () => handle.initializationResult(),
    close: () => {
      remove()
      handle.close()
    },
  }
}
