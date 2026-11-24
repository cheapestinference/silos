// harnesses/opencode/assemble — the per-process pieces EVERY OpenCode
// process Silos launches for an agent carries, whatever the engine: the
// console (server.ts POST /api/console) and the headless chat engine
// (headless.ts, `opencode run`). One builder so both engines give the agent
// the SAME self:
//   · its context file (briefing + fleet roster — what Claude gets at
//     SessionStart) and role prompt (the same system-prompt append as
//     Claude's) written as files and listed in `instructions`;
//   · the fence as OpenCode permissions relative to the worktree OpenCode
//     itself computes; fenced → the project's AGENTS.md / CLAUDE.md listed
//     here (OpenCode's own project discovery is off, launch.ts);
//   · its own database (OPENCODE_DB, directory created), the config as
//     OPENCODE_CONFIG_CONTENT, SILOS_API, and the agent's env (Vault first,
//     platform plumbing after — the chat engine's order).
//   · the provider the cockpit cascade resolved (the caller resolves it —
//     ChatService.providerForTurn / consoleProviderFor, the Claude engine's
//     cascade) and the model, as config (launch.ts providerLaunch)
//     — the key only as SILOS_PROVIDER_KEY in the env, never in the
//     config string or argv.
// Engine-specific pieces (a console's port and password, a resume's
// session id) are the caller's.

import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Agent } from '../../types.js'
import type { AgentStateStore } from '../../agent-state.js'
import type { VaultStore } from '../../vault-store.js'
import type { FenceOverlay } from '../../territory.js'
import type { ResolvedProvider } from '../../providers-store.js'
import { silosBriefing } from '../briefing.js'
import { agentOwnEnv, agentProcessEnv } from '../../agent-env.js'
import { fenceToPermission, type PermissionAction, type PermissionConfig } from './fence.js'
import { heldSkillNames } from '../../skill-states.js'
import {
  PROVIDER_KEY_ENV,
  assertAgentEnv,
  configContent,
  ownMcpForOpencode,
  providerLaunch,
  defaultPluginPath,
  defaultSkillsPath,
  projectInstructions,
  writeContextFile,
  writeRoleFile,
} from './launch.js'
import { agentDbPath } from './paths.js'
import { ensureRolePluginManifest, rolePluginFor, roleSkillNames, roleSkillsDir } from '../../role-plugin.js'
import { AgentTools } from '../../agent-tools.js'
import { asksRepliesDir } from '../../asks-store.js'
import { worktreeOf } from './worktree.js'
import { deniedSkillNames } from './launch-entries.js'

export interface OpencodeAssemblyDeps {
  agents: () => Agent[]
  agentState: AgentStateStore
  dataDir: string
  home: string
  silosApi: string
  vault?: VaultStore
  territory?: { fenceFor(agentId: string): FenceOverlay | null }
  /** `has`: the skills this launch loads (the briefing's set). */
  systemAppendFor?: (agentId: string, has: readonly string[]) => string | null
  /** «Your Silos inbox» from the server's store (ChatService.inboxFor — the
   *  caller binds HOW it is served: an attended console marks at composing,
   *  a turn by its token's class). Absent: none. */
  inboxFor?: (agentId: string) => string
}

/** `env` is the LaunchSpec.env shape: Vault + agent-state env + OPENCODE_DB,
 *  OPENCODE_CONFIG_CONTENT, SILOS_API (launch.ts envFor takes it apart);
 *  the same pieces typed alongside, for a caller that calls envFor itself. */
export interface OpencodeAssembly {
  fence: FenceOverlay | null
  agentDb: string
  configContent: string
  silosApi: string
  /** Vault first, agent-state env after (SILOS_AGENT_ID, SILOS_AGENT_STATE…). */
  agentEnv: Record<string, string>
  /** The `provider/model` the config names (null: the operator's default). */
  model: string | null
  /** The provider's key, for SILOS_PROVIDER_KEY (kinds that carry one). */
  providerKey?: string
  /** SILOS_ASKS_REPLIES — where the plugin polls for the owner's answers. */
  asksReplies: string
  /** + SILOS_PROVIDER_KEY when the provider carries a key. */
  env: Record<string, string>
}

/** The skill names an agent's folder HOLDS (turned off — moved to Silos'
 *  held store, skill-states.ts): its primary folder's, and the launch cwd's
 *  when that is another folder of its own. */
export function heldSkillsFor(dataDir: string, agent: Agent, cwd: string): string[] {
  const folders = [agent.folder, cwd].filter((f, i, all): f is string => typeof f === 'string' && f !== '' && all.indexOf(f) === i)
  return [...new Set(folders.flatMap((f) => heldSkillNames(dataDir, f)))].sort()
}

/** Whether OpenCode loads the operator's personal ~/.claude/skills. It does
 *  by default (1.19.4 Skill discovery walks <home>/.claude and <home>/.agents
 *  plus the same dirs up from the project) unless its own env switches turn
 *  that off: OPENCODE_DISABLE_EXTERNAL_SKILLS, OPENCODE_DISABLE_CLAUDE_CODE,
 *  OPENCODE_DISABLE_CLAUDE_CODE_SKILLS (booleans: true/1/yes/on). The same
 *  switches stop OpenCode reading <folder>/.claude/skills too — Silos'
 *  catalog doesn't model that (it would need a folder-copy state per engine);
 *  only the personal twin's question below depends on it. */
export function opencodeLoadsPersonalSkills(env: NodeJS.ProcessEnv = process.env): boolean {
  const on = (k: string): boolean => /^(true|1|yes|on)$/i.test((env[k] ?? '').trim())
  return !(on('OPENCODE_DISABLE_EXTERNAL_SKILLS') || on('OPENCODE_DISABLE_CLAUDE_CODE') || on('OPENCODE_DISABLE_CLAUDE_CODE_SKILLS'))
}

/** The held names the launch may deny: OpenCode filters skills BY NAME
 *  (permission.skill), so denying a name that also exists as the operator's
 *  personal skill (~/.claude/skills/<name>, which OpenCode loads) would turn
 *  that personal skill off too — Silos never does. Such a name
 *  is left loading, and the catalog says so on the held row (stillLoads). */
export function deniableHeldSkills(held: string[], home: string, loadsPersonal: boolean = opencodeLoadsPersonalSkills()): string[] {
  if (!loadsPersonal) return held
  return held.filter((n) => !existsSync(join(home, '.claude', 'skills', n, 'SKILL.md')))
}

/** Held means off on OpenCode too. Moving the folder copy out is not enough
 *  here: every launch hands OpenCode Silos' plugin/skills as a skills.paths
 *  root, so a held name would still load from there. OpenCode's own gate is
 *  `permission.skill` — a `deny` hides the skill from the agent's available
 *  list and refuses it (1.19.4: Skill.available filters on
 *  evaluate("skill", name, agent.permission) !== "deny"). Each held name is
 *  appended as a `deny` AFTER any rule already there (last match wins), so
 *  nothing earlier can let it back in. No held names: the permission as it
 *  was (null stays null — no config key invented). */
export function withHeldSkillsDenied(permission: PermissionConfig | null, held: string[]): PermissionConfig | null {
  if (held.length === 0) return permission
  const prior = permission?.skill
  const rules: Record<string, PermissionAction> = typeof prior === 'string' ? { '*': prior } : { ...(prior ?? {}) }
  for (const name of held) {
    delete rules[name] // re-inserted last: key order is rule order
    rules[name] = 'deny'
  }
  return { ...(permission ?? {}), skill: rules }
}

/** The skill names under OpenCode's skills.paths roots: each entry holding
 *  a SKILL.md. An unreadable root adds none. */
export function skillNamesIn(roots: readonly string[]): string[] {
  const out = new Set<string>()
  for (const root of roots) {
    try {
      for (const d of readdirSync(root, { withFileTypes: true })) {
        if ((d.isDirectory() || d.isSymbolicLink()) && existsSync(join(root, d.name, 'SKILL.md'))) out.add(d.name)
      }
    } catch {
      /* not there */
    }
  }
  return [...out].sort()
}

/** `provider`: what the cockpit cascade resolved for this launch (null = no
 *  Silos provider); `model`: the cockpit's model (agent › conversation › turn). */
/** `carried`: what Silos keeps for this launch's places, in overlay order
 *  (ServerDeps/ChatDeps.loadsCarried) — through the allowlist into the
 *  config content (launch-entries.ts). */
export function assembleOpencode(
  deps: OpencodeAssemblyDeps,
  agent: Agent,
  cwd: string,
  launch: { provider: ResolvedProvider | null; model: string | null; heartbeat?: boolean | 'tools'; carried?: readonly unknown[] } = {
    provider: null,
    model: null,
  },
): OpencodeAssembly {
  // the REAL state dir (never a link into another agent's state): the
  // briefing and role files are written under it through safe-file.ts
  deps.agentState.dirFor(agent.id)
  const stateDir = deps.agentState.containedDirFor(agent.id, [], true)!
  const stateEnv = deps.agentState.envFor(agent.id)
  // the role's own skills (role-plugin.ts): OpenCode's dialect is a second
  // skills.paths root; its own MCP servers (agent-tools.ts) its config's
  // `mcp` — none in a heartbeat without tools (Claude's strictMcpConfig twin)
  const rolePlugin = rolePluginFor(agent.id, stateDir)
  if (rolePlugin) ensureRolePluginManifest(rolePlugin, agent.id, agent.name)
  const skillsPaths = [defaultSkillsPath(), ...(rolePlugin && roleSkillNames(stateDir).length > 0 ? [roleSkillsDir(stateDir)] : [])]
  const ownMcp = rolePlugin && launch.heartbeat !== true ? ownMcpForOpencode(agent.id, new AgentTools(deps.agentState).activeConfigs(agent.id)) : {}
  const deniedSkills = deniableHeldSkills(heldSkillsFor(deps.dataDir, agent, cwd), deps.home)
  // the briefing names only skills this launch loads: the
  // skills.paths roots, minus every name permission.skill denies — the held
  // names, and what the launch's places carry (a project's, an agent's, a
  // conversation's deny: launch-entries.ts, merged by configContent)
  const denied = new Set([...deniedSkills, ...deniedSkillNames(launch.carried)])
  const has = skillNamesIn(skillsPaths).filter((n) => !denied.has(n))
  // + the agent's unread messages after the roster (inbox-text.ts, the
  // twin of the hook's inbox.py): what a Claude console gets at SessionStart
  const briefing = silosBriefing(deps.agents(), agent.id, { withBearer: 'SILOS_AGENT_TOKEN' in stateEnv, has, cwd })
  let inbox = ''
  try {
    inbox = deps.inboxFor?.(agent.id) ?? ''
  } catch {
    /* the inbox never breaks a launch */
  }
  const instructions = [writeContextFile(stateDir, inbox ? (briefing ? `${briefing}\n\n${inbox}` : inbox) : briefing)]
  const append = deps.systemAppendFor?.(agent.id, has) ?? null
  if (append && append.trim() !== '') instructions.push(writeRoleFile(stateDir, append))
  const fence = deps.territory?.fenceFor(agent.id) ?? null
  const worktree = worktreeOf(cwd)
  // fenced: OpenCode's project discovery is off (launch.ts), so the
  // project's AGENTS.md / CLAUDE.md are listed here — absolute, after ours
  if (fence) instructions.push(...projectInstructions(cwd, worktree))
  const fencePermission = fence ? fenceToPermission(fence, { worktree, allowPaths: [deps.agentState.pathFor(agent.id)], home: deps.home }) : null
  const permission = withHeldSkillsDenied(fencePermission, deniedSkills)
  const agentDb = agentDbPath(deps.dataDir, agent.id)
  mkdirSync(dirname(agentDb), { recursive: true })
  const p = providerLaunch(launch.provider, launch.model)
  const config = configContent({
    pluginPath: defaultPluginPath(),
    skillsPaths,
    instructions,
    permission,
    provider: p.provider,
    model: p.model,
    ...(launch.heartbeat ? { heartbeat: launch.heartbeat } : {}),
    ...(Object.keys(ownMcp).length > 0 ? { mcp: ownMcp } : {}),
    ...(launch.carried && launch.carried.length > 0 ? { carried: launch.carried } : {}),
  })
  // the agent's process env (agent-env.ts, the one builder every engine's
  // launch uses) is the base; OpenCode's reserved keys (launch.ts
  // RESERVED_ENV) are refused in the agent's OWN part — checked HERE,
  // before the platform's keys are merged in: once merged, a Vault
  // SILOS_PROVIDER_KEY would read as the provider's key downstream
  const own = agentOwnEnv({ vault: deps.vault, agentState: { envFor: () => stateEnv } }, agent.id, cwd)
  assertAgentEnv(own)
  const { SILOS_API: silosApi, ...agentEnv } = agentProcessEnv({ vault: { envFor: () => own }, silosApi: deps.silosApi }, agent, cwd)
  const asksReplies = asksRepliesDir(deps.dataDir, agent.id)
  return {
    fence,
    agentDb,
    configContent: config,
    silosApi,
    agentEnv,
    model: p.model,
    asksReplies,
    ...(p.providerKey !== undefined ? { providerKey: p.providerKey } : {}),
    env: {
      ...agentEnv,
      OPENCODE_DB: agentDb,
      OPENCODE_CONFIG_CONTENT: config,
      SILOS_API: silosApi,
      SILOS_ASKS_REPLIES: asksReplies,
      ...(p.providerKey !== undefined ? { [PROVIDER_KEY_ENV]: p.providerKey } : {}),
    },
  }
}
