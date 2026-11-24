// An agent's own state dir (<dataDir>/agent-state/<id>): its env
// ($SILOS_AGENT_STATE, its id, its bearer) and the files Silos reads or
// writes there through safe-file.ts. The run-mode channel (runmode.json,
// status.json, watch-state.json) is gone: an agent's
// control is the owner's setting, its memory between heartbeats the packet
// and its considered lines.
import { mkdirSync, readdirSync } from 'node:fs'
import { containedAgentDir } from './contained-dir.js'
import { readContainedTextOrNull, writeContained } from './safe-file.js'
import { join } from 'node:path'

// One path segment, no traversal — agent ids come from the registry but
// this store is also reachable from HTTP routes, so it defends itself.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export class AgentStateStore {
  // tokens: optional provider (agent-tokens.ts) — when present, envFor
  // also hands both engines the agent's bearer as SILOS_AGENT_TOKEN, to
  // EVERY agent, master included, fence on or off: identity is never tied to the fence, which governs file rules only.
  // egressEnv: optional — the egress proxy's env for
  // an agent (egress-proxy.ts egressProxyEnv over its territory policy and
  // its bearer). Here because the proxy URL carries the bearer: it is part
  // of the identity channel every launch site already spreads (both
  // engines, console and SDK, command runs), after the Vault — a Vault
  // entry never stands over it.
  constructor(
    private baseDir: string,
    private tokens?: { tokenFor(agentId: string): string },
    private egressEnv?: (agentId: string, bearer: string | null) => Record<string, string>,
  ) {}

  dirFor(agentId: string): string {
    if (!SAFE_ID.test(agentId)) throw new Error(`invalid agent id: ${JSON.stringify(agentId)}`)
    const dir = join(this.baseDir, agentId)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return dir
  }

  // Same id check and path as dirFor, but NEVER creates the directory —
  // for reads (scans, existence checks) that must not conjure an
  // empty agent-state dir for every agent id just by looking.
  pathFor(agentId: string): string {
    if (!SAFE_ID.test(agentId)) throw new Error(`invalid agent id: ${JSON.stringify(agentId)}`)
    return join(this.baseDir, agentId)
  }

  // The REAL directory <base>/<agentId>/<segments…>, every component checked
  // (contained-dir.ts): a link the agent planted in its own state that leads
  // outside it — another agent's state included — refuses (ContainmentError):
  // Silos never reads or writes through it.
  // `create` false: null when it isn't there.
  containedDirFor(agentId: string, segments: readonly string[], create: boolean): string | null {
    if (!SAFE_ID.test(agentId)) throw new Error(`invalid agent id: ${JSON.stringify(agentId)}`)
    return containedAgentDir(this.baseDir, agentId, segments, { create, mode: 0o700 })
  }

  // The agent's own REAL state dir, verified (containedAgentDir): null when
  // it is missing OR refused (the dir itself a link, into another agent's
  // state or anywhere else) — the readers' tolerance: refused reads as
  // missing. Never creates anything.
  verifiedDir(agentId: string, segments: readonly string[] = []): string | null {
    try {
      return this.containedDirFor(agentId, segments, false)
    } catch {
      return null
    }
  }

  // One file of the agent's own state, read through safe-file.ts: a link
  // or a hard link at the name, a swapped dir, a FIFO — all read as missing.
  readOwnText(agentId: string, segments: readonly string[], name: string, opts: { maxBytes: number }): string | null {
    return readContainedTextOrNull(this.verifiedDir(agentId, segments), name, opts)
  }

  // A file Silos writes in the agent's state (safe-file.ts writeContained):
  // never through a link. A refusal is logged once per file and answered
  // false — the resident's tick never crashes on it.
  writeOwn(agentId: string, segments: readonly string[], name: string, data: string): boolean {
    try {
      writeContained(this.containedDirFor(agentId, segments, true)!, name, data)
      return true
    } catch (err) {
      this.refused(agentId, name, err)
      return false
    }
  }

  private warned = new Set<string>()
  private refused(agentId: string, name: string, err: unknown): void {
    const key = `${agentId}/${name}`
    if (this.warned.has(key)) return
    this.warned.add(key)
    console.warn(`agent-state: refused to write ${name} for ${agentId}: ${err instanceof Error ? err.message : String(err)}`)
  }

  // The agent ids that HAVE a state dir — for scans over every agent's
  // files (births-store.ts). Never creates anything; a missing base dir is
  // an empty list.
  agentIdsOnDisk(): string[] {
    try {
      return readdirSync(this.baseDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && SAFE_ID.test(d.name))
        .map((d) => d.name)
    } catch {
      return []
    }
  }

  envFor(agentId: string): Record<string, string> {
    // SILOS_AGENT_ID rides along so a session can name itself to the
    // platform API without parsing the state dir (the briefing's curl
    // recipes use it — see plugin/context/briefing.d/).
    const env: Record<string, string> = { SILOS_AGENT_STATE: this.dirFor(agentId), SILOS_AGENT_ID: agentId }
    if (this.tokens) {
      // A failed mint (EACCES, disk full) costs the token, never the rest:
      // both engines still get the state channel and the console still opens.
      try {
        env.SILOS_AGENT_TOKEN = this.tokens.tokenFor(agentId)
      } catch (err) {
        console.warn(`agent-state: could not mint SILOS_AGENT_TOKEN for ${agentId}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    // an allowlisted agent without a bearer still gets the proxy (every
    // call a 407): closed, never silently open
    if (this.egressEnv) Object.assign(env, this.egressEnv(agentId, env.SILOS_AGENT_TOKEN ?? null))
    return env
  }
}
