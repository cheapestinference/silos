// agent-env.ts — the ONE builder of the env Silos adds to an agent's process.
// Every launch site spreads it: the Claude console
// (claude-code/server-hooks.ts, both opens), the neutral console open
// (console-open.ts), the SDK turn (claude-code/headless.ts), a command
// automation (resident/runs.ts), and OpenCode's assembly as its base
// (opencode/assemble.ts, which keeps its own reserved keys on top).
//
// Order is the rule: the agent's Vault (owner-controlled) first, its
// agent-state plumbing (SILOS_AGENT_STATE / _ID / _TOKEN) after, and
// SILOS_API last — a secret can never point an agent at another Silos.
// SILOS_SESSION_ID only when the launch serves a conversation (`key`): a
// command run or an OpenCode assembly has none (F19). SILOS_TURN — the turn
// token (live-turns.ts) — only when the launch IS a
// turn ChatService minted one for; last, so nothing before can name it.
//
// SILOS_API is the server's REAL address (its host and port), so the
// recipes' `${SILOS_API:-http://127.0.0.1:3210}` talk to the Silos that
// launched them — a test server on another port never reaches the owner's.
// It is never inherited (env.ts INHERIT_NEVER).
//
// The caller's own layers stay the caller's: the provider env (Claude's
// envForProvider / consoleEnvForProvider) goes BEFORE this, a process's
// PATH/HOME before it too.

import { defaultConfig } from './config.js'

export interface AgentEnvDeps {
  vault?: { envFor(agentId: string | null, cwd: string | null): Record<string, string> } | undefined
  agentState?: { envFor(agentId: string): Record<string, string> } | undefined
  /** The server's API URL; absent → the address the config resolves (SILOS_HOST/SILOS_PORT). */
  silosApi?: string | undefined
}

/** http://host:port of a server listening on `host` — a wildcard bind is
 *  reached on loopback, an IPv6 literal goes in brackets. */
export function silosApiUrl(host: string, port: number): string {
  const h = host === '' || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  return `http://${h.includes(':') ? `[${h}]` : h}:${port}`
}

/** The API URL of the server this process is configured to be. */
export function defaultSilosApi(): string {
  const c = defaultConfig()
  return silosApiUrl(c.host, c.port)
}

/** The agent's own env: Vault, then agent state. A state store that refuses
 *  the id (envFor throws on an unsafe one) costs the state channel, never
 *  the launch. */
export function agentOwnEnv(deps: AgentEnvDeps, agentId: string, cwd: string | null): Record<string, string> {
  let state: Record<string, string> = {}
  try {
    state = deps.agentState?.envFor(agentId) ?? {}
  } catch (err) {
    console.warn(`agent-env: no agent-state env for ${agentId}:`, err instanceof Error ? err.message : err)
  }
  return { ...(deps.vault?.envFor(agentId, cwd) ?? {}), ...state }
}

/** The env Silos adds to an agent process: Vault → agent state → SILOS_API
 *  (→ SILOS_SESSION_ID with a key) (→ SILOS_TURN with a turn token). */
export function agentProcessEnv(
  deps: AgentEnvDeps,
  agent: { id: string },
  cwd: string | null,
  key?: string,
  turn?: string,
): Record<string, string> & { SILOS_API: string } {
  return {
    ...agentOwnEnv(deps, agent.id, cwd),
    SILOS_API: deps.silosApi ?? defaultSilosApi(),
    ...(key ? { SILOS_SESSION_ID: key } : {}),
    ...(turn ? { SILOS_TURN: turn } : {}),
  }
}
