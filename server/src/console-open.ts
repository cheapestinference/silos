// console-open.ts — the neutral console open of POST /api/console, for a
// harness that brings no openSession / openNew hook of its own
// (Harness.server). It serves only a console whose session id Silos
// chooses (console.idDiscovery 'silos-chosen'): the key IS the session id,
// so a new conversation is born under a fresh UUID and a resume reuses the
// id. A harness whose console reports its id later ('reported-by-plugin')
// needs its own hooks to be opened (OpenCode has them).
//
// The launch goes through the contract only: a LaunchSpec, then
// h.console.command(spec) / h.console.env(spec) into TerminalService.
// Today's two engines both bring their own hooks, so this path serves only
// a future engine (docs/harnesses.md).

import { randomUUID } from 'node:crypto'
import type { Agent, SessionMeta } from './types.js'
import type { ConsoleOpenInput, Harness, LaunchSpec, RouteResult, ServerHookContext } from './harnesses/contract.js'
import { harnessForId, harnessOf } from './harnesses/registry.js'
import { mungePath } from './agent-registry.js'
import { ensureRolePluginManifest, rolePluginFor } from './role-plugin.js'
import { agentProcessEnv } from './agent-env.js'

const noConsole = (h: Harness): RouteResult => ({ code: 400, body: { error: `${h.label} has no console in Silos yet` } })

// the spec of one launch: the same cascades a built-in console honours
// (provider: pick › pin › agent's own; permission mode; model), the
// agent's fence and role append, and its env (agent-env.ts: Vault, agent
// state, SILOS_API, the conversation it serves)
// `pinsAt`: where the conversation's pins live — the resumed id, or a new
// console's key (its picks were pinned there at birth)
function specFor(
  ctx: ServerHookContext,
  h: Harness,
  agent: Agent,
  cwd: string,
  key: string,
  input: ConsoleOpenInput,
  resumeId?: string,
  pinsAt: string | undefined = resumeId,
): LaunchSpec {
  const { chat, vault, agentState, territory, silosApi } = ctx.deps
  const provider = chat.consoleProviderFor?.(agent.id, cwd, pinsAt, input.pick || undefined) ?? null
  const permissionMode = chat.consolePermissionMode?.(cwd, pinsAt)
  const model = chat.consoleModel?.(agent.id, cwd, pinsAt)
  const outputStyle = h.caps.outputStyles ? chat.consoleOutputStyle?.(agent.id, cwd, pinsAt) : undefined
  // the skills such an engine loads are unknown: none is assumed, so a
  // silo's producer brief is never withheld for a skill it may not have
  const append = chat.systemAppendFor?.(agent.id, []) ?? undefined
  const fence = territory?.fenceFor(agent.id) ?? null
  // what Silos keeps for this agent's launches and, resumed, its
  // conversation's thread (loads-scopes.ts)
  const carried = ctx.deps.loadsCarried?.(agent.id, cwd, resumeId) ?? []
  const env = agentProcessEnv({ vault, agentState, silosApi }, agent, cwd, key)
  // the role's own skills (role-plugin.ts): present only when the role HAS
  // skills; the manifest is ensured at launch, like the launches create the
  // state dir when they write into it
  let stateDir: string | null = null
  try {
    stateDir = agentState?.pathFor(agent.id) ?? null
  } catch {
    /* unsafe id: no role plugin */
  }
  const rolePlugin = rolePluginFor(agent.id, stateDir)
  if (rolePlugin) ensureRolePluginManifest(rolePlugin, agent.id, agent.name)
  return {
    agent,
    cwd,
    key,
    ...(resumeId ? { resumeId } : {}),
    ...(input.theme ? { theme: input.theme } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(append ? { append } : {}),
    fence,
    provider,
    env,
    ...(model ? { model } : {}),
    ...(outputStyle ? { outputStyle } : {}),
    ...(rolePlugin ? { rolePlugin } : {}),
    ...(carried.length > 0 ? { carried } : {}),
  }
}

function launch(ctx: ServerHookContext, h: Harness, spec: LaunchSpec, input: ConsoleOpenInput): Promise<{ key: string; theme: 'light' | 'dark' }> {
  return ctx.helpers.terminals.ensureConsole({
    cwd: spec.cwd,
    key: spec.key,
    agentId: spec.agent.id,
    command: h.console.command(spec),
    baseEnv: { TERM: 'xterm-256color' },
    extraEnv: h.console.env(spec),
    harness: h.id,
    ...(input.theme ? { theme: input.theme } : {}),
  })
}

/** An existing session: reattach to its live console, else relaunch it
 *  under its own id, in the agent that owns it. */
export async function genericOpenSession(
  ctx: ServerHookContext,
  h: Harness,
  id: string,
  meta: SessionMeta | undefined,
  input: ConsoleOpenInput,
): Promise<RouteResult> {
  if (h.console.idDiscovery !== 'silos-chosen') return noConsole(h)
  const { terminals, classifyAgentId } = ctx.helpers
  const attached = await terminals.reattachConsole(id)
  if (attached) return { code: 201, body: attached }
  if (!meta || meta.cwd === null) return { code: 400, body: { error: 'session has no cwd — cannot open console' } }
  const agent = ctx.deps.registry.get(classifyAgentId(meta))
  if (!agent || agent.archived || harnessOf(agent) !== h.id)
    return { code: 400, body: { error: `no ${h.label} agent owns this session — cannot open its console` } }
  input.pinPicks(meta.cwd, id)
  return { code: 201, body: await launch(ctx, h, specFor(ctx, h, agent, meta.cwd, id, input, id), input) }
}

/** A new conversation: a console born under a fresh id, which is its key
 *  and its session id; Silos records who gave birth. The agent's waiting
 *  console is REUSED while nothing has been typed into it (still live, its
 *  session not listed yet, an id of this engine) — one idle process per
 *  agent, the rule both built-in engines' own openNew hooks follow. */
export async function genericOpenNew(ctx: ServerHookContext, h: Harness, agent: Agent & { folder: string }, input: ConsoleOpenInput): Promise<RouteResult> {
  if (h.console.idDiscovery !== 'silos-chosen') return noConsole(h)
  const { terminals, freshConsoles } = ctx.helpers
  const pending = freshConsoles.get(agent.id)
  const untouched = async (id: string): Promise<boolean> =>
    harnessForId(id) === h.id && !ctx.deps.index.allSessions().some((m) => m.id === id) && (await terminals.hasConsole(id))
  // an id the harness itself claims (HarnessConsole.newSessionId): a bare
  // UUID would route to the fallback once its reader lists the session
  const key = pending && (await untouched(pending)) ? pending : (h.console.newSessionId?.() ?? randomUUID())
  freshConsoles.set(agent.id, key)
  ctx.deps.native.register(mungePath(agent.folder), key, { agentId: agent.id, createdAt: new Date().toISOString() })
  input.pinPicks(agent.folder, key)
  return { code: 201, body: await launch(ctx, h, specFor(ctx, h, agent, agent.folder, key, input, undefined, key), input) }
}
