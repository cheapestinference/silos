// env.ts — environment variables shared by chat-service and exec-service:
// children (the SDK's subprocess, exec's bash) never inherit CLAUDE* context
// from the parent process, but do inherit HOME/PATH (the `claude` login
// depends on them).
//
// The CLEANUP (stripping inherited vars) and the INJECTION (what the agent's
// provider needs) are two separate steps on purpose — the bug this fixes:
// cleanEnv() prunes /^CLAUDE/, so injecting CLAUDE_CONFIG_DIR BEFORE cleaning
// (or within the same pass) would wipe it out again. The provider injection
// for Claude processes lives in harnesses/claude-code/env.ts: it cleans FIRST
// and adds AFTER, so injected values never go through the filter.

import { scrubDevRunEnv } from './inherited-env.js'

/** The owner's credentials Silos may READ from its own environment, once,
 *  at boot — and that no process it starts ever inherits. SILOS_TOKEN is the
 *  owner's static access token (config.ts ensureData: PaaS deploys set it in
 *  their dashboard): inherited, every console, chat turn, command run and
 *  shell would carry the key to the whole API. The boot removes them from
 *  process.env once read (scrubOwnerCredentials, index.ts), so even a spawn
 *  that spreads process.env (and a tmux server started later) has none;
 *  cleanEnv drops them too, so a child never depends on that order. */
export const OWNER_CREDENTIAL_ENV: readonly string[] = ['SILOS_TOKEN']

const INHERIT_NEVER = new Set([
  'SILOS_BRIEFING',
  'SILOS_AGENT_STATE',
  'SILOS_AGENT_TOKEN',
  'SILOS_AGENT_ID',
  'SILOS_SESSION_ID',
  'SILOS_TURN',
  'SILOS_CONSOLE_KEY',
  'SILOS_PROVIDER_KEY',
  'SILOS_ASKS_REPLIES',
  'SILOS_API',
  ...OWNER_CREDENTIAL_ENV,
])

/** A name no child process ever inherits from the server (cleanEnv's rule). */
export function isNeverInherited(name: string): boolean {
  return /^CLAUDE/.test(name) || INHERIT_NEVER.has(name)
}

/** Removes the owner's credentials from `env` (process.env by default) —
 *  call it right after they are read. Returns the names it removed. */
export function scrubOwnerCredentials(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed = OWNER_CREDENTIAL_ENV.filter((k) => k in env)
  for (const k of removed) delete env[k]
  return removed
}

export function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    // SILOS_AGENT_STATE is per-agent platform plumbing: when the server
    // itself runs inside a Silos console, process.env carries the PARENT
    // agent's state dir — inheriting it would point a child agent at
    // another agent's state whenever its own degrades (chat-service
    // re-injects the correct one per turn, last-write-wins). Its siblings
    // SILOS_AGENT_TOKEN and SILOS_AGENT_ID likewise: inherited, they would
    // hand the parent's bearer to master or to an agent not enabled yet.
    // SILOS_SESSION_ID names the conversation a claude was launched for
    // (births: plugin/hooks/birth.py) — inherited, every session the
    // server spawns would present itself as that conversation's child.
    // SILOS_CONSOLE_KEY and SILOS_PROVIDER_KEY are an OpenCode console's
    // plumbing (harnesses/opencode/launch.ts): the key would seal every
    // child as that console's conversation; the provider key is a secret
    // meant for that one process. SILOS_ASKS_REPLIES points an OpenCode
    // plugin at ITS agent's reply dir (asks-store.ts) — never a child's.
    // SILOS_API names the server that launched a process (agent-env.ts):
    // inherited, a test server started from a console would hand its
    // children the owner's real Silos. SILOS_BRIEFING is set per launch only
    // by the launcher that appends the briefing (briefing.ts BRIEFED_ENV):
    // inherited, every child would tell its start hook «my system prompt
    // carries the briefing» when it does not, and get none. OWNER_CREDENTIAL_ENV: see above.
    if (v !== undefined && !isNeverInherited(k)) env[k] = v
  }
  // the boot already scrubbed process.env (index.ts); applied here too so a
  // child never depends on how its server was started (tests, embedders)
  scrubDevRunEnv(env)
  return env
}
