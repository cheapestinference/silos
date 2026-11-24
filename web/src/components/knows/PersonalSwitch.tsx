// PersonalSwitch — Project › Memory: your personal instructions (the
// «Your machine» CLAUDE.md row, and your rules beside it) on, or off in
// THIS project. The engine says whether it has the switch (GET
// /api/folders/:folder/personal); without one the row stays a fact. The
// change reaches new conversations only — the Reaches line above the list
// names whom.
//
// Its places (spec scopes T10): ▾ opens «Where it loads» — the machine (the
// file itself, a door), the project's file, each agent's launches and, in
// a conversation's column, that conversation's. An agent's and a
// conversation's are kept by Silos and carried at launch.
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { FolderPersonal, LoadsLine } from '../../lib/types'
import type { PlacesSubject } from '../../lib/loads-places'

export interface PersonalView {
  state: 'on' | 'off' | 'partly'
  rules: boolean
  /** no switch: what decides, in the button's place */
  fact?: { short: string; long: string }
  /** an agent's page: whose line it is, and whether the off is its own */
  agent?: string
  own?: true
}

/** One view over the folder's engines that have the switch (null: none). */
export function personalView(fp: FolderPersonal | null): PersonalView | null {
  const es = fp?.engines ?? []
  if (es.length === 0) return null
  const rules = es.some((e) => e.rules)
  const decided = es.find((e) => e.decidedBy)
  if (decided?.decidedBy) {
    const file = decided.decidedBy.file.split('/').pop() ?? decided.decidedBy.file
    return {
      state: 'off',
      rules,
      fact: { short: `off · set in ${file}`, long: `Kept out by ${decided.decidedBy.key} in ${decided.decidedBy.file} — change it there` },
    }
  }
  const refused = es.find((e) => e.refused)
  if (refused?.refused) return { state: refused.state, rules, fact: { short: 'no switch here', long: refused.refused } }
  const state = es.every((e) => e.state === 'off') ? 'off' : es.every((e) => e.state === 'on') ? 'on' : 'partly'
  return { state, rules }
}

/** On an agent's page: the row as THAT agent's line says it — its own
 *  switch, or the wider place that keeps them out (a fact; ▾ says where). */
export function personalAgentView(line: LoadsLine, folder: PersonalView | null, agentName: string): PersonalView {
  const rules = folder?.rules ?? false
  if (line.locked)
    return {
      state: 'off',
      rules,
      fact: {
        short: line.locked.at === 'project' ? 'off in this project' : 'off above',
        long: `Kept out for every agent here — ${line.locked.at === 'project' ? 'this project turned them off' : 'a settings file above decides'}; ▾ says where`,
      },
      agent: agentName,
    }
  return { state: line.result, rules, agent: agentName, ...(line.entry === 'off' ? { own: true as const } : {}) }
}

/** The row's second line when it is not simply on. */
export function personalWords(v: PersonalView): string | null {
  if (v.agent && v.state === 'off') return v.own ? `Off for ${v.agent} only${v.rules ? ', your rules too' : ''}` : null
  if (v.state === 'off') return v.rules ? 'Off in this project, your rules too' : 'Off in this project'
  if (v.state === 'partly') return 'Off for some logins only — Turn off for all'
  return null
}

/** The row as «Where it loads» draws it: its places, from the engine. */
export function personalSubject(fp: FolderPersonal | null): PlacesSubject | null {
  const e = fp?.engines.find((x) => x.at)
  return e?.at ? { key: 'personal', label: 'your personal instructions', kind: 'personal', engine: e.label, at: e.at } : null
}

/** One launch place's line (an agent's, a conversation's), or none. */
export function personalLineOf(fp: FolderPersonal | null, place: 'agent' | 'conversation', agent?: string): LoadsLine | null {
  return personalSubject(fp)?.at?.find((l) => l.place === place && (place === 'conversation' || l.agent === agent)) ?? null
}

export type PersonalAt = { scope: 'agent'; agent: string } | { scope: 'conversation'; conversation: string }

export function usePersonal(
  folder: string | null,
  version: unknown,
  as?: { agent: string } | { conversation: string },
): {
  view: PersonalView | null
  fp: FolderPersonal | null
  subject: PlacesSubject | null
  turn: (to: 'on' | 'off') => Promise<void>
  turnAt: (to: 'on' | 'off', at: PersonalAt) => Promise<void>
  busy: boolean
} {
  const [fp, setFp] = useState<FolderPersonal | null>(null)
  const [busy, setBusy] = useState(false)
  const asKey = as ? JSON.stringify(as) : ''
  useEffect(() => {
    let cancelled = false
    setFp(null)
    if (!folder) return
    const ask = asKey ? (JSON.parse(asKey) as { agent: string } | { conversation: string }) : undefined
    Promise.resolve()
      .then(() => (ask ? api.folders.personal(folder, ask) : api.folders.personal(folder)))
      .then(
        (r) => {
          if (!cancelled) setFp(r)
        },
        () => {
          /* no switch shown */
        },
      )
    return () => {
      cancelled = true
    }
  }, [folder, version, asKey])
  const turn = async (to: 'on' | 'off'): Promise<void> => {
    if (!folder) return
    setBusy(true)
    try {
      setFp(await api.folders.personalSwitch(folder, to))
    } finally {
      setBusy(false)
    }
  }
  const turnAt = async (to: 'on' | 'off', at: PersonalAt): Promise<void> => {
    if (!folder) return
    setBusy(true)
    // the answer is the view of the place switched — this page's when it
    // asked for that place; a project's page reads its every line again
    try {
      const answer = await api.folders.personalSwitchAt(folder, to, at)
      setFp(as ? answer : await api.folders.personal(folder))
    } finally {
      setBusy(false)
    }
  }
  return { view: personalView(fp), fp, subject: personalSubject(fp), turn, turnAt, busy }
}
