// InstructionPlaces — a Memory row's places (spec memory-places §4, T4): the
// plain switch and ▾ «Where it loads» of every instruction file Memory
// shows, read from GET /api/folders/:folder/instructions (the engine's
// lines, the same LoadsLine the Tools rows draw). The plain switch is the
// page's own place: This project on a project's Memory, Only <agent> on an
// agent's; ▾ has the rest (the block is WhereItLoads, as it stands). A row
// with no place says why in its block (`inert`).
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { FolderInstructionPlaces, InstructionPlacesRow, LoadsLine, LoadsRow } from '../../lib/types'
import { placesPhrase, type PlacesPage, type PlacesSubject } from '../../lib/loads-places'

export type InstructionAt =
  { scope: 'project' } | { scope: 'machine'; confirmed?: true } | { scope: 'agent'; agent: string } | { scope: 'conversation'; conversation: string }

/** A row's places, its block's subject, and the page's own line. */
export interface InstructionView {
  places: InstructionPlacesRow
  subject: PlacesSubject
  /** the page's line: the project's, or the agent's (null: none — inert) */
  line: LoadsLine | null
  /** where the places disagree: one phrase, a door to the block */
  phrase: string | null
}

/** One row's view, matched by the path Memory lists it under (null: the
 *  engines give it no places). */
export function instructionView(
  fp: FolderInstructionPlaces | null,
  path: string,
  label: string,
  page: PlacesPage,
  here: FolderInstructionPlaces | null = null,
): InstructionView | null {
  for (const e of fp?.engines ?? []) {
    const found = e.rows.find((r) => r.path === path)
    if (!found) continue
    // the conversation the page was opened from: its own line, from its read, last
    const thread = page.scope === 'agent' ? page.from?.thread : undefined
    const convLine = thread
      ? here?.engines
          .flatMap((x) => x.rows)
          .find((r) => r.path === path)
          ?.at.find((l) => l.place === 'conversation' && l.conversation === thread)
      : undefined
    const places = convLine ? { ...found, at: [...found.at.filter((l) => l.place !== 'conversation'), convLine] } : found
    const subject: PlacesSubject = {
      key: places.key,
      label,
      kind: places.family === 'override' ? 'auto-memory' : 'instruction',
      engine: e.label,
      at: places.at,
    }
    const line = places.at.find((l) => (page.scope === 'agent' ? l.place === 'agent' && l.agent === page.agentId : l.place === 'project')) ?? null
    const phrase = places.at.length > 0 ? (placesPhrase({ at: places.at } as LoadsRow, page) ?? parentPhrase(line)) : null
    return { places, subject, line, phrase }
  }
  return null
}

/** An import off with the file that imports it, said on its row. */
function parentPhrase(line: LoadsLine | null): string | null {
  return line?.locked?.parent ? `off with ${line.locked.parent}` : null
}

/** Why the plain switch is not a button: what decides, in its place. */
export function instructionFact(v: InstructionView): { short: string; long: string } | null {
  const l = v.line
  if (!l) return v.places.inert ? { short: 'no switch', long: v.places.inert } : null
  if (l.refused?.why === 'file') return { short: 'set by hand', long: l.refused.reason }
  if (l.locked?.parent) return { short: `with ${l.locked.parent}`, long: `It loads with ${l.locked.parent} — ▾ says where that one is off` }
  if (l.locked?.why === 'organization') return { short: 'your organization', long: 'Your organization decides it (managed settings)' }
  if (l.locked && l.entry !== 'off') return { short: l.locked.at === 'project' ? 'off in this project' : 'off above', long: 'Kept out wider — ▾ says where' }
  if (!l.switch && l.entry !== 'off') return { short: 'no switch', long: v.places.inert ?? 'No switch at this place' }
  return null
}

export function useInstructionPlaces(
  folder: string | null,
  version: unknown,
  as?: { agent: string } | { conversation: string },
): {
  fp: FolderInstructionPlaces | null
  turn: (path: string, to: 'on' | 'off', at: InstructionAt) => Promise<void>
  busy: string | null
} {
  const [fp, setFp] = useState<FolderInstructionPlaces | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const agentId = as && 'agent' in as ? as.agent : undefined
  const conversation = as && 'conversation' in as ? as.conversation : undefined
  const asked = (): { agent: string } | { conversation: string } | undefined => (agentId ? { agent: agentId } : conversation ? { conversation } : undefined)
  useEffect(() => {
    let cancelled = false
    setFp(null)
    if (!folder) return
    Promise.resolve()
      .then(() => api.folders.instructions(folder, asked()))
      .then(
        (r) => {
          if (!cancelled) setFp(r)
        },
        () => {
          /* no places shown */
        },
      )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- asked() reads agentId and conversation
  }, [folder, version, agentId, conversation])
  const turn = async (path: string, to: 'on' | 'off', at: InstructionAt): Promise<void> => {
    if (!folder) return
    setBusy(path)
    // the answer is the folder's lines as this page asked for them
    try {
      await api.folders.instructionSwitch(folder, path, to, at)
      setFp(await api.folders.instructions(folder, asked()))
    } finally {
      setBusy(null)
    }
  }
  return { fp, turn, busy }
}
