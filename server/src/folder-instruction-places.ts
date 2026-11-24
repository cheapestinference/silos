// folder-instruction-places.ts — «Where it loads» for every instruction file
// Memory lists in a folder (spec memory-places §4, T4), asked of each engine
// of the folder's agents that declares it (Harness.instructions.places /
// .switch) — and, at the launch places, for ONE agent or ONE conversation:
// Silos keeps the engine's payload (loads-scopes.ts, the row key the engine
// names) and the engine turns it into its own entries at launch. The same
// shape as folder-personal.ts. Neutral: names no engine, no file, no key —
// the engine decides what a row's places are and what a switch writes.
import {
  LoadsSwitchError,
  type Harness,
  type InstructionPlacesInput,
  type InstructionPlacesRow,
  type InstructionRow,
  type LoadsCarried,
} from './harnesses/contract.js'
import { findHarness, harnessOf } from './harnesses/registry.js'
import { folderInstructions, instructionsInput, type FolderInstructionsDeps } from './folder-instructions.js'
import type { LoadsScopesStore } from './loads-scopes.js'
import { instructionEntryState } from './switch-proof.js'
import type { PersonalConversation } from './folder-personal.js'
import { territoriesOf } from './territory.js'

export interface FolderInstructionPlacesDeps extends FolderInstructionsDeps {
  /** what Silos keeps for the launch places (absent: the folder's lines alone) */
  loadsScopes?: Pick<LoadsScopesStore, 'payloadOf' | 'record'> & Partial<Pick<LoadsScopesStore, 'get'>>
  /** the process starts Silos itself saw for these sessions in the folder
   *  (the turn ledger's `started`), ms — start markers beside the record's own */
  startsOf?: (folder: string, sessions: readonly string[]) => number[]
}

/** ONE conversation as the proof reads it: its thread, agent and sessions. */
export type InstructionConversation = PersonalConversation & { sessions?: readonly string[] }

export interface FolderInstructionPlaces {
  folder: string
  /** one per engine of the folder that has places */
  engines: { id: string; label: string; rows: InstructionPlacesRow[] }[]
}

/** Where one switch writes: the folder's file (absent / project), the
 *  machine's (with the owner's yes where the line asks), one agent's
 *  launches, one conversation's. */
export type InstructionSwitchAt =
  | { scope: 'project' }
  | { scope: 'machine'; confirmed?: true }
  | { scope: 'agent'; agent: string }
  | { scope: 'conversation'; conversation: PersonalConversation }

const agentsOf = (deps: FolderInstructionPlacesDeps, folder: string) => deps.registry.list(true).filter((a) => territoriesOf(a).includes(folder))

function carriedOf(deps: FolderInstructionPlacesDeps, folder: string, h: Harness, conv?: PersonalConversation): LoadsCarried | undefined {
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

/** Every listed row's places, per engine. `as`: an agent's page — its own
 *  line only among the agents; `conv`: one conversation's — its line too. */
export async function folderInstructionPlaces(
  deps: FolderInstructionPlacesDeps,
  folder: string,
  opts: { as?: string; conv?: InstructionConversation } = {},
): Promise<FolderInstructionPlaces> {
  const names = new Map(deps.registry.list(true).map((a) => [a.id, a.name]))
  const base = instructionsInput(deps, folder)
  const out: FolderInstructionPlaces = { folder, engines: [] }
  for (const e of await folderInstructions(deps, folder)) {
    const h = findHarness(e.id)
    if (!h?.instructions?.places) continue
    const carried = carriedOf(deps, folder, h, opts.conv)
    const input: InstructionPlacesInput = { ...base, ...(carried ? { carried } : {}) }
    const rows = h.instructions.places(input, e.list.rows).map((r) => ({
      ...r,
      at: r.at
        .filter((l) => opts.as === undefined || l.place !== 'agent' || l.agent === opts.as)
        .map((l) => (l.agent && names.has(l.agent) ? { ...l, agentName: names.get(l.agent)! } : l)),
    }))
    out.engines.push({ id: h.id, label: h.label, rows: opts.conv ? await withConversationHere(deps, folder, h, opts.conv, e.list.rows, rows) : rows })
  }
  return out
}

/** The conversation's line, where it keeps an entry of its own, gets where
 *  that entry stands (switch-proof.ts instructionEntryState): read from
 *  the thread's own transcripts by its engine, timed by the entry's own
 *  `at`, its starts from start markers alone (the record's start hooks,
 *  the ledger's process starts). An engine that reads no record, or a
 *  read that fails: no `here` (the when-words say pending). */
async function withConversationHere(
  deps: FolderInstructionPlacesDeps,
  folder: string,
  h: Harness,
  conv: InstructionConversation,
  listed: readonly InstructionRow[],
  rows: InstructionPlacesRow[],
): Promise<InstructionPlacesRow[]> {
  const rec = deps.loadsScopes?.get?.('conversations', conv.thread, h.id) ?? null
  if (!rec || !h.instructions?.reading || !rows.some((r) => r.at.some((l) => l.place === 'conversation' && l.entry !== undefined))) return rows
  const sessions = new Set(conv.sessions ?? [conv.thread])
  const transcripts: string[] = []
  try {
    for (const m of (deps.index?.allSessions() ?? []).filter((x) => sessions.has(x.id)).sort((a, b) => a.mtime - b.mtime)) {
      if (!deps.index!.hasTranscriptFile(m.id)) continue
      try {
        transcripts.push(deps.index!.pathOf(m.folder, m.id))
      } catch {
        /* no file */
      }
    }
  } catch {
    return rows
  }
  let seen
  try {
    seen = await h.instructions.reading(transcripts)
  } catch {
    return rows
  }
  let markers: number[] = []
  try {
    markers = deps.startsOf?.(folder, [...sessions]) ?? []
  } catch {
    markers = []
  }
  return rows.map((r) => {
    const since = Object.prototype.hasOwnProperty.call(rec.at, r.key) ? rec.at[r.key]! : null
    const row = listed.find((x) => x.path === r.path)
    if (since === null || !row) return r
    const file = { paths: [...new Set([row.real, row.path])], onDemand: row.when.at === 'on-demand', exists: row.bytes > 0 || row.mtime > 0 }
    return {
      ...r,
      at: r.at.map((l) =>
        l.place === 'conversation' && l.conversation === conv.thread && l.entry
          ? { ...l, here: instructionEntryState(l.entry, since, file, seen, markers) }
          : l,
      ),
    }
  })
}

/** One listed file on or off at one place, on the engine that lists it.
 *  404: a path no engine of the folder lists, an agent not of the folder;
 *  409: the engine's own refusal (a locked line, a fact, no switch). */
export async function switchFolderInstruction(
  deps: FolderInstructionPlacesDeps,
  folder: string,
  path: string,
  to: 'on' | 'off',
  at: InstructionSwitchAt = { scope: 'project' },
): Promise<void> {
  const base = instructionsInput(deps, folder)
  const engines = await folderInstructions(deps, folder)
  const listed = engines.find((e) => e.list.rows.some((r) => r.path === path || r.real === path))
  if (!listed) throw new LoadsSwitchError('not an instruction file this folder lists', 404)
  const h = findHarness(listed.id)
  if (!h?.instructions?.switch) throw new LoadsSwitchError(`${listed.label} has no switch for its instruction files`, 409)
  const rows = listed.list.rows
  if (at.scope === 'project' || at.scope === 'machine') {
    h.instructions.switch(
      { ...base },
      rows,
      path,
      to,
      at.scope === 'machine' ? { scope: 'machine', ...(at.confirmed ? { confirmed: true as const } : {}) } : { scope: 'project' },
    )
    return
  }
  const store = deps.loadsScopes
  if (!store) throw new LoadsSwitchError(`nothing keeps what one ${at.scope} loads here`, 409)
  const row = rows.find((r) => r.path === path || r.real === path)!
  if (at.scope === 'agent') {
    const agent = agentsOf(deps, folder).find((a) => a.id === at.agent)
    if (!agent) throw new LoadsSwitchError(`${at.agent} is not an agent of this project`, 404)
    let engine: string
    try {
      engine = harnessOf(agent)
    } catch {
      throw new LoadsSwitchError(`${at.agent} runs on no engine Silos knows`, 409)
    }
    if (engine !== h.id) throw new LoadsSwitchError(`${agent.name}'s engine does not load ${row.rel}`, 409)
    const carried = carriedOf(deps, folder, h)!
    const answer = h.instructions.switch({ ...base, carried }, rows, path, to, {
      scope: 'agent',
      agent: at.agent,
      payload: store.payloadOf('agents', at.agent, h.id),
    })
    if (answer) store.record('agents', at.agent, h.id, keyOf(h, base, rows, path, carried), answer)
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
  if (engine !== undefined && engine !== h.id) throw new LoadsSwitchError("this conversation's engine does not load this file", 409)
  const carried = carriedOf(deps, folder, h, conv)!
  const answer = h.instructions.switch({ ...base, carried }, rows, path, to, {
    scope: 'conversation',
    ...(conv.agent ? { agent: conv.agent } : {}),
    payload: carried.conversation!.payload,
  })
  if (answer) store.record('conversations', conv.thread, h.id, keyOf(h, base, rows, path, carried), answer)
}

/** The row key the engine times a launch entry by. */
function keyOf(h: Harness, base: InstructionPlacesInput, rows: readonly InstructionRow[], path: string, carried: LoadsCarried): string {
  const row = rows.find((r) => r.path === path || r.real === path)
  const r = row ? h.instructions?.places?.({ ...base, carried }, [row]).find((x) => x.path === row.path) : undefined
  return r?.key ?? `instruction:${path}`
}
