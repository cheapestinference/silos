// folder-personal.ts — your personal instructions, on or off in ONE folder
// (Project › Memory, the switch on the «Your machine» row), asked of each
// engine of the folder's agents that declares it (Harness.personal) — and,
// at the launch places (spec scopes T10), for ONE agent or ONE
// conversation: Silos keeps the engine's payload (loads-scopes.ts, the row
// key `personal`) and the engine turns it into its own entries at launch.
// Neutral: names no engine, no file, no key — the engine decides what it
// writes and where; an engine without the switch adds nothing, and the
// row stays a fact.
import { LoadsSwitchError, type LoadsCarried, type LoadsLine, type PersonalInput, type PersonalState } from './harnesses/contract.js'
import { fallbackHarness, findHarness, harnessOf } from './harnesses/registry.js'
import type { AgentRegistry } from './agent-registry.js'
import type { Harness } from './harnesses/contract.js'
import type { LoadsScopesStore } from './loads-scopes.js'

/** The row key a launch place's personal-instructions entry is timed by. */
export const PERSONAL_ROW = 'personal'

export interface FolderPersonalDeps {
  registry: Pick<AgentRegistry, 'list'>
  home: string
  managedDir?: string
  /** every login's own directory on this machine (absent: the engine's default) */
  loginDirs?: () => string[]
  /** what Silos keeps for the launch places (absent: the folder's switch alone) */
  loadsScopes?: Pick<LoadsScopesStore, 'payloadOf' | 'record'>
}

/** ONE conversation, resolved by the server (its thread root and agent). */
export interface PersonalConversation {
  thread: string
  agent: string | null
}

export interface FolderPersonal {
  folder: string
  /** one per engine of the folder that has the switch (none: no switch) */
  engines: ({ id: string; label: string; at?: LoadsLine[] } & PersonalState)[]
}

const agentsOf = (deps: FolderPersonalDeps, folder: string) => deps.registry.list(true).filter((a) => a.folder === folder || (a.folders ?? []).includes(folder))

function enginesOf(deps: FolderPersonalDeps, folder: string): Harness[] {
  const ids = [
    ...new Set(
      agentsOf(deps, folder).flatMap((a) => {
        try {
          return [harnessOf(a)]
        } catch {
          return []
        }
      }),
    ),
  ]
  return (ids.length > 0 ? ids.map((id) => findHarness(id)).filter((h) => h !== undefined) : [fallbackHarness()]).filter((h) => h.personal !== undefined)
}

/** The launch places' payloads for one engine: the folder's agents on it,
 *  and one conversation's (its agent's line is the one it follows). */
function carriedOf(deps: FolderPersonalDeps, folder: string, h: Harness, conv?: PersonalConversation): LoadsCarried | undefined {
  const store = deps.loadsScopes
  if (!store) return undefined
  const agents = agentsOf(deps, folder).filter((a) => {
    try {
      return harnessOf(a) === h.id
    } catch {
      return false
    }
  })
  return {
    agents: agents.map((a) => ({ id: a.id, payload: store.payloadOf('agents', a.id, h.id) })),
    ...(conv
      ? { conversation: { id: conv.thread, payload: store.payloadOf('conversations', conv.thread, h.id), ...(conv.agent ? { agent: conv.agent } : {}) } }
      : {}),
  }
}

const inputOf = (deps: FolderPersonalDeps, folder: string, carried?: LoadsCarried): PersonalInput => {
  const dirs = deps.loginDirs?.()
  return {
    folder,
    home: deps.home,
    ...(dirs && dirs.length > 0 ? { loginDirs: dirs } : {}),
    ...(deps.managedDir ? { managedDir: deps.managedDir } : {}),
    ...(carried ? { carried } : {}),
  }
}

/** `as`: an agent's page — its own line only among the agents. `conv`: one
 *  conversation's column — its own line too; no other conversation's. */
export function folderPersonal(deps: FolderPersonalDeps, folder: string, opts: { as?: string; conv?: PersonalConversation } = {}): FolderPersonal {
  const names = new Map(deps.registry.list(true).map((a) => [a.id, a.name]))
  return {
    folder,
    engines: enginesOf(deps, folder).map((h) => {
      const carried = carriedOf(deps, folder, h, opts.conv)
      const input = inputOf(deps, folder, carried)
      const st = h.personal!.state(input)
      if (!carried || !h.personal!.places) return { id: h.id, label: h.label, ...st }
      const at = h
        .personal!.places(input)
        .filter((l) => opts.as === undefined || l.place !== 'agent' || l.agent === opts.as)
        .map((l) => (l.agent && names.has(l.agent) ? { ...l, agentName: names.get(l.agent)! } : l))
      return { id: h.id, label: h.label, ...st, at }
    }),
  }
}

/** Turns them on or off for new conversations — in the folder (no `at`),
 *  for one of its agents, or for one conversation — on every engine of it
 *  that has the switch. 409: none has it, or an engine's own refusal
 *  (saying what decides); 404 an agent that is not the folder's. */
export function switchFolderPersonal(
  deps: FolderPersonalDeps,
  folder: string,
  to: 'on' | 'off',
  at?: { scope: 'agent'; agent: string } | { scope: 'conversation'; conversation: PersonalConversation },
): void {
  const engines = enginesOf(deps, folder)
  if (engines.length === 0) throw new LoadsSwitchError('no engine here switches personal instructions per project', 409)
  if (!at) {
    const input = inputOf(deps, folder)
    for (const h of engines) h.personal!.switch(input, to)
    return
  }
  const store = deps.loadsScopes
  if (!store) throw new LoadsSwitchError(`nothing keeps what one ${at.scope} loads here`, 409)
  if (at.scope === 'agent') {
    const agent = agentsOf(deps, folder).find((a) => a.id === at.agent)
    if (!agent) throw new LoadsSwitchError(`${at.agent} is not an agent of this project`, 404)
    let engine: string
    try {
      engine = harnessOf(agent)
    } catch {
      throw new LoadsSwitchError(`${at.agent} runs on no engine Silos knows`, 409)
    }
    const h = engines.find((x) => x.id === engine)
    if (!h) throw new LoadsSwitchError(`${agent.name}'s engine has no personal instructions to switch`, 409)
    const carried = carriedOf(deps, folder, h)!
    const answer = h.personal!.switch(inputOf(deps, folder, carried), to, {
      scope: 'agent',
      agent: at.agent,
      payload: store.payloadOf('agents', at.agent, h.id),
    })
    if (answer) store.record('agents', at.agent, h.id, PERSONAL_ROW, answer)
    return
  }
  const conv = at.conversation
  const owner = conv.agent ? agentsOf(deps, folder).find((a) => a.id === conv.agent) : undefined
  let engine: string | undefined
  try {
    engine = owner ? harnessOf(owner) : undefined
  } catch {
    engine = undefined
  }
  const h = engine ? engines.find((x) => x.id === engine) : engines.length === 1 ? engines[0] : undefined
  if (!h) throw new LoadsSwitchError("this conversation's engine has no personal instructions to switch", 409)
  const carried = carriedOf(deps, folder, h, conv)!
  const answer = h.personal!.switch(inputOf(deps, folder, carried), to, {
    scope: 'conversation',
    ...(conv.agent ? { agent: conv.agent } : {}),
    payload: carried.conversation!.payload,
  })
  if (answer) store.record('conversations', conv.thread, h.id, PERSONAL_ROW, answer)
}
