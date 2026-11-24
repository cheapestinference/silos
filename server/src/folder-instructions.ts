// folder-instructions.ts — every instruction file a conversation in a
// folder loads (spec memory-places T2), asked of each engine of the
// folder's agents that declares it (Harness.instructions) — or, with no
// folder, of every registered engine for the machine's own files. The ONE
// list Memory draws and the ONE list a memory write is judged against
// (memory-service.ts, T3). Neutral: names no engine, no file, no key — the
// engine decides what it lists, what it reaches and what may be written;
// an engine without `instructions` adds nothing.
import type { Harness, InstructionRow, InstructionsInput, InstructionsList } from './harnesses/contract.js'
import { fallbackHarness, findHarness, harnessOf, registeredHarnesses } from './harnesses/registry.js'
import type { AgentRegistry } from './agent-registry.js'
import type { SessionIndex } from './session-index.js'
import { territoriesOf } from './territory.js'

/** The newest conversations of the folder whose records are read for weight. */
export const FOLDER_TRANSCRIPTS = 12

export interface FolderInstructionsDeps {
  registry: Pick<AgentRegistry, 'list'>
  /** the conversations' index (absent: no transcript is read — every weight «on disk») */
  index?: Pick<SessionIndex, 'allSessions' | 'hasTranscriptFile' | 'pathOf'>
  home: string
  /** every login's own config dir, the machine's own first */
  loginDirs: () => string[]
  /** where the engine keeps each folder's conversations */
  projectsRoot: string
  managedDir?: string
}

/** One engine's rows, each stamped with it. */
export interface EngineInstructions {
  id: string
  label: string
  list: InstructionsList
}

export interface FolderInstructionsOpts {
  /** judge against ACTIVE agents only (a write): an archived agent's folder is out of play */
  activeOnly?: boolean
}

function agentsOf(deps: FolderInstructionsDeps, folder: string, activeOnly: boolean) {
  return deps.registry.list(!activeOnly).filter((a) => territoriesOf(a).includes(folder))
}

function enginesOf(deps: FolderInstructionsDeps, folder: string | null, activeOnly: boolean): Harness[] {
  if (folder === null) return registeredHarnesses().filter((h) => h.instructions !== undefined)
  const ids = [
    ...new Set(
      agentsOf(deps, folder, activeOnly).flatMap((a) => {
        try {
          return [harnessOf(a)]
        } catch {
          return []
        }
      }),
    ),
  ]
  return (ids.length > 0 ? ids.map((id) => findHarness(id)).filter((h) => h !== undefined) : [fallbackHarness()]).filter((h) => h.instructions !== undefined)
}

/** What the engines are handed for the folder (null: the machine's files only). */
export function instructionsInput(deps: FolderInstructionsDeps, folder: string | null): InstructionsInput {
  const transcripts: string[] = []
  if (folder !== null && deps.index) {
    const here = deps.index
      .allSessions()
      .filter((m) => m.cwd === folder)
      .sort((a, b) => b.mtime - a.mtime)
    for (const m of here) {
      if (transcripts.length >= FOLDER_TRANSCRIPTS) break
      if (!deps.index.hasTranscriptFile(m.id)) continue
      try {
        transcripts.push(deps.index.pathOf(m.folder, m.id))
      } catch {
        /* no file */
      }
    }
  }
  return {
    folder,
    home: deps.home,
    loginDirs: deps.loginDirs(),
    projectsRoot: deps.projectsRoot,
    ...(deps.managedDir ? { managedDir: deps.managedDir } : {}),
    transcripts,
  }
}

/** Each engine's list for the folder (null: the machine's own files). */
export async function folderInstructions(
  deps: FolderInstructionsDeps,
  folder: string | null,
  opts: FolderInstructionsOpts = {},
): Promise<EngineInstructions[]> {
  const input = instructionsInput(deps, folder)
  const out: EngineInstructions[] = []
  for (const h of enginesOf(deps, folder, opts.activeOnly === true)) {
    out.push({ id: h.id, label: h.label, list: await h.instructions!.list(input) })
  }
  return out
}

/** A row as Memory answers it: its engine named. */
export type EngineInstructionRow = InstructionRow & { engine: string }

/** Every engine's rows, ONE per real file (the first engine that lists it). */
export function mergedRows(engines: readonly EngineInstructions[]): EngineInstructionRow[] {
  const seen = new Set<string>()
  const out: EngineInstructionRow[] = []
  for (const e of engines) {
    for (const r of e.list.rows) {
      if (seen.has(r.real)) continue
      seen.add(r.real)
      out.push({ ...r, engine: e.id })
    }
  }
  return out
}
