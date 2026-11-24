// knows-here.ts — the conversation column's Knows (spec scope-ui-review
// §4.1): ONE summary line per kind, read as THIS conversation sees them —
// how many load, and what differs here (an entry of its own). The column
// only points: each line is a door to its agent's tab, where the
// conversation's line switches (agent/from-conversation.ts). Not started
// yet (the server knows no such conversation): the counts without «here».
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { topLevel } from '../../lib/loads-view'
import type { FolderInstructionPlaces, FolderLoads, SkillCatalogEntry } from '../../lib/types'
import { personalLineOf, usePersonal } from './PersonalSwitch'

export interface HereCounts {
  load: number
  off: number
  onOnly: number
  nameOnly: number
}

/** Tools as one conversation sees them: the top-level rows its line loads
 *  (a row with no places: the folder's state), and its own entries. */
export function toolsHere(loads: FolderLoads): HereCounts {
  const thread = loads.conversation?.thread
  const out: HereCounts = { load: 0, off: 0, onOnly: 0, nameOnly: 0 }
  for (const r of topLevel(loads.rows)) {
    const line = r.at?.find((l) => l.place === 'conversation' && (!thread || l.conversation === thread))
    if (line ? line.result === 'on' : r.state === 'active') out.load++
    if (line?.entry === 'off') out.off++
    if (line?.entry === 'on') out.onOnly++
  }
  return out
}

/** Skills as one conversation sees them: each skill once, those not off
 *  there, and its own positions (an engine-locked one has none). */
export function skillsHere(skills: readonly SkillCatalogEntry[], thread: string | null): HereCounts {
  const out: HereCounts = { load: 0, off: 0, onOnly: 0, nameOnly: 0 }
  const seen = new Set<string>()
  for (const s of skills) {
    const k = `${s.source ?? ''}:${s.plugin ?? ''}:${s.name}`
    if (seen.has(k)) continue
    seen.add(k)
    const line = s.at?.find((l) => l.place === 'conversation' && (!thread || l.conversation === thread))
    if (line ? line.result !== 'off' : (s.state ?? 'active') === 'active') out.load++
    if (line?.entry === 'off') out.off++
    else if (line?.entry === 'name-only') out.nameOnly++
    else if (line?.entry === 'on') out.onOnly++
  }
  return out
}

/** Instruction files with an entry of this conversation's own (spec
 *  memory-places T5): how many it keeps off, how many of those didn't take. */
export function instructionsHere(fp: FolderInstructionPlaces): { off: number; didntTake: number } {
  const thread = fp.conversation?.thread
  let off = 0,
    didntTake = 0
  for (const r of fp.engines.flatMap((e) => e.rows)) {
    const l = r.at.find((x) => x.place === 'conversation' && (!thread || x.conversation === thread))
    if (l?.entry !== 'off') continue
    off++
    if (l.here?.state === 'didnt-take') didntTake++
  }
  return { off, didntTake }
}

/** The reads behind the summaries; null parts: not read (not started, or
 *  the read failed) — the column then says the agent's counts. */
export function useKnowsHere(
  agentId: string,
  cwd: string | null,
  id: string,
  version: number,
): { tools: HereCounts | null; skills: HereCounts | null; personalOff: boolean; instructions: { off: number; didntTake: number } | null } {
  const [tools, setTools] = useState<HereCounts | null>(null)
  const [skills, setSkills] = useState<HereCounts | null>(null)
  const [instructions, setInstructions] = useState<{ off: number; didntTake: number } | null>(null)
  useEffect(() => {
    setTools(null)
    setSkills(null)
    setInstructions(null)
    if (!cwd) return
    let cancelled = false
    Promise.resolve()
      .then(() => api.folders.instructions(cwd, { conversation: id }))
      .then(
        (v) => {
          if (!cancelled && v?.engines) setInstructions(instructionsHere(v))
        },
        () => {
          /* not started: no «here» */
        },
      )
    Promise.resolve()
      .then(() => api.folders.loads(cwd, undefined, id))
      .then(
        (v) => {
          if (!cancelled && v?.conversation) setTools(toolsHere(v))
        },
        () => {
          /* not started: no «here» */
        },
      )
    Promise.resolve()
      .then(() => api.skillsCatalog(agentId, id))
      .then(
        (v) => {
          if (!cancelled && Array.isArray(v)) setSkills(skillsHere(v, null))
        },
        () => {
          /* not started: no «here» */
        },
      )
    return () => {
      cancelled = true
    }
  }, [agentId, cwd, id, version])
  const personal = usePersonal(cwd, version, { conversation: id })
  const line = personalLineOf(personal.fp, 'conversation')
  return { tools, skills, personalOff: line?.entry === 'off', instructions }
}
