// harnesses/claude-code/turn-status.ts — the turn's own status reading of
// its MCP servers: `Query.mcpServerStatus()` (sdk.d.ts), asked of the
// process the turn already runs — no tokens, no new process.
//
// A Silos turn is a single prompt (sdk-types.ts QueryArgs) and in that mode
// the process exits after the turn, so the status is asked on the turn's
// first assistant or tool message — the servers have been dialed by then —
// and once more on a later one when a server was still connecting. It is
// NEVER awaited: the turn's messages flow through unchanged, a query without
// the method or one that throws records nothing, and an answer that comes
// after the result is dropped without an error.
//
// What leaves this file is the engine's status minus its `config` (it can
// carry URLs and headers with secrets): only «has no address» is kept — an
// entry a plugin declares with no URL and no command (a placeholder, by
// structure, never by name).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TurnToolStatusServer } from '../contract.js'
import type { SdkMessage, SdkQueryHandle } from './sdk-types.js'
import { claudeManagedSettingsDir, managedFiles } from '../../plugin-enablement.js'

const STATUSES: ReadonlySet<string> = new Set(['connected', 'failed', 'needs-auth', 'pending', 'disabled'])
type Json = Record<string, unknown>
const asObject = (v: unknown): Json | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null)
const own = (o: Json | null, k: string): unknown => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined)
const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** The engine's status rows, kept to what Silos records — `config` never
 *  leaves; a row that is not one (no name, an unknown status) is skipped. */
export function statusServers(rows: unknown): TurnToolStatusServer[] {
  if (!Array.isArray(rows)) return []
  const out: TurnToolStatusServer[] = []
  for (const raw of rows) {
    const r = asObject(raw)
    const name = text(own(r, 'name'))
    const status = own(r, 'status')
    if (!name || typeof status !== 'string' || !STATUSES.has(status)) continue
    const config = asObject(own(r, 'config'))
    const type = own(config, 'type')
    const noAddress = config !== null && type !== 'sdk' && type !== 'claudeai-proxy' && !text(own(config, 'url')) && !text(own(config, 'command'))
    const tools = own(r, 'tools')
    out.push({
      name,
      status: status as TurnToolStatusServer['status'],
      ...(text(own(r, 'error')) ? { error: text(own(r, 'error'))! } : {}),
      ...(text(own(r, 'source')) ? { source: text(own(r, 'source'))! } : {}),
      ...(text(own(r, 'scope')) ? { scope: text(own(r, 'scope'))! } : {}),
      ...(Array.isArray(tools) ? { tools: tools.length } : {}),
      ...(noAddress ? { noAddress: true as const } : {}),
    })
  }
  return out
}

/** A message that says the servers have been dialed: the model answered,
 *  or a tool ran. */
function isAssistantOrTool(m: SdkMessage): boolean {
  if (m.type === 'assistant' || m.type === 'tool_progress') return true
  if (m.type !== 'user') return false
  const content = asObject((m as { message?: unknown }).message)?.content
  return Array.isArray(content) && content.some((c) => asObject(c)?.type === 'tool_result')
}

/** One turn's asker: `see` every message of the turn, in order. `skip`: the
 *  turn has no servers to read (a heartbeat without its tools). */
export function turnStatusAsker(handle: SdkQueryHandle, skip: boolean, onReading: (servers: TurnToolStatusServer[]) => void): { see(m: SdkMessage): void } {
  let asks = 0
  let inFlight = false
  let stillConnecting = false
  let over = false
  const ask = (): void => {
    const fn = (handle as { mcpServerStatus?: unknown }).mcpServerStatus
    if (typeof fn !== 'function') return
    asks++
    let p: unknown
    try {
      p = (fn as () => unknown).call(handle)
    } catch {
      return
    }
    inFlight = true
    Promise.resolve(p).then(
      (rows) => {
        inFlight = false
        if (over) return // the process is gone: dropped, never an error
        const servers = statusServers(rows)
        if (!Array.isArray(rows)) return
        stillConnecting = servers.some((s) => s.status === 'pending')
        try {
          onReading(servers)
        } catch {
          /* a reading never breaks a turn */
        }
      },
      () => {
        inFlight = false
      },
    )
  }
  return {
    see(m) {
      if (m.type === 'result') {
        over = true
        return
      }
      if (skip || over || !isAssistantOrTool(m)) return
      if (asks === 0 || (asks === 1 && stillConnecting && !inFlight)) ask()
    },
  }
}

/** Whether the turn's process fetches the Claude account's connectors: no
 *  layer it reads (managed always; user, project, local as its sources say;
 *  its flag settings) sets `disableClaudeAiConnectors`, and it runs on a
 *  Claude login (a gateway key has no connectors). */
export function connectorsOnFor(input: {
  cwd: string
  home: string
  configDir: string | null
  sources: readonly string[]
  flagSettings: Record<string, unknown>
  claudeLogin: boolean
  strict: boolean
  managedDir?: string
}): boolean {
  if (!input.claudeLogin || input.strict) return false
  const read = (p: string): Json | null => {
    try {
      return asObject(JSON.parse(readFileSync(p, 'utf8')))
    } catch {
      return null
    }
  }
  const layers: (Json | null)[] = [
    ...managedFiles(input.managedDir ?? claudeManagedSettingsDir()).map(asObject),
    input.flagSettings,
    ...(input.sources.includes('user') ? [read(join(input.configDir ?? join(input.home, '.claude'), 'settings.json'))] : []),
    ...(input.sources.includes('project') ? [read(join(input.cwd, '.claude', 'settings.json'))] : []),
    ...(input.sources.includes('local') ? [read(join(input.cwd, '.claude', 'settings.local.json'))] : []),
  ]
  return !layers.some((l) => own(l, 'disableClaudeAiConnectors') === true)
}
