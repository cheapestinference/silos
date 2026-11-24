// from-conversation.ts — the agent page opened FROM one of its
// conversations (spec scope-ui-review §4.3): the header says «‹ <title>»
// (store.agentFrom, ?from=), and its Tools / Skills / Memory tabs gain that
// conversation's own line in each row's «Where it loads» — the new house
// of «This conversation» (the column only points here).
//
// The page keeps its agent read and takes each row's conversation line
// from a second read, the one the column made before: GET …/loads?
// conversation= (its line with its switch and where its entry stands) and
// the skills catalog for that conversation. A conversation that runs in
// another folder than its agent's own reads THAT project's rows (narrowed
// to this agent), so the line and the rows it sits on are one project's.
// Not started yet (the server knows no such conversation): no line.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { useStore } from '../../store'
import { sessionViewOf } from '../../store/selectors'
import type { AgentView, FolderLoads, LoadsLine, SkillCatalogEntry } from '../../lib/types'
import type { KnowsSources } from '../knows/KnowsAnatomy'
import type { PlacesFrom } from '../../lib/loads-places'
import type { HereMode } from '../../lib/here-tools'
import { useStartedWith } from '../StartedWithBlock'

/** An agent's read: the other agents' lines out, the project line naming
 *  them all (what the server's agent read answers, folder-loads.ts). */
function asAgent(at: readonly LoadsLine[], agentId: string): LoadsLine[] {
  const reach = at.filter((l) => l.place === 'agent').map((l) => l.agentName ?? 'an agent')
  return at
    .filter((l) => l.place !== 'agent' || l.agent === agentId)
    .map((l) => (l.place === 'project' && reach.length > 0 && !l.agents ? { ...l, agents: reach } : l))
}

/** The agent's rows with that conversation's line in each (pure). */
export function withConversationLines(base: FolderLoads | null, conv: FolderLoads, agentId: string): FolderLoads {
  const thread = conv.conversation?.thread
  if (!thread) return base ?? conv
  // another project than the agent's own: that project's rows, as this agent's page reads them
  if (!base || base.folder !== conv.folder) {
    return {
      ...conv,
      rows: conv.rows.map((r) => (r.at ? { ...r, at: asAgent(r.at, agentId) } : r)),
      origins: (conv.origins ?? []).map((o) => (o.at ? { ...o, at: asAgent(o.at, agentId) } : o)),
    }
  }
  const lineOf = new Map(conv.rows.map((r) => [r.key, r.at?.find((l) => l.place === 'conversation' && l.conversation === thread)]))
  return {
    ...base,
    rows: base.rows.map((r) => {
      const line = lineOf.get(r.key)
      if (!r.at || !line) return r
      return { ...r, at: [...r.at.filter((l) => !(l.place === 'conversation' && l.conversation === thread)), line] }
    }),
    // its own last «Turn all off» that still holds: undone from here too
    undo: [...(base.undo ?? []), ...(conv.undo ?? []).filter((u) => u.scope === 'conversation')],
    conversation: conv.conversation,
  }
}

/** The skills with that conversation's line in each (pure): by name and source. */
export function withConversationSkills(base: SkillCatalogEntry[] | null, conv: readonly SkillCatalogEntry[], thread: string): SkillCatalogEntry[] | null {
  if (!base) return base
  const key = (s: SkillCatalogEntry): string => `${s.source ?? ''}:${s.plugin ?? ''}:${s.name}`
  const lineOf = new Map(conv.map((s) => [key(s), s.at?.find((l) => l.place === 'conversation' && l.conversation === thread)]))
  return base.map((s) => {
    const line = lineOf.get(key(s))
    if (!s.at || !line) return s
    return { ...s, at: [...s.at.filter((l) => !(l.place === 'conversation' && l.conversation === thread)), line] }
  })
}

/** The conversation the page was opened from — and the sources with its
 *  lines; null: opened any other way, another agent's, or not started. */
export function useFromConversation(agent: AgentView, src: KnowsSources): { from: PlacesFrom | null; src: KnowsSources } {
  const opened = useStore((s) => s.agentFrom)
  const view = useStore((s) => sessionViewOf(s.agents, s.agentFrom))
  const mine = opened && view && view.agentId === agent.id && view.cwd ? { folder: opened.folder, id: opened.id, cwd: view.cwd } : null
  const [conv, setConv] = useState<{ loads: FolderLoads; skills: SkillCatalogEntry[] | null } | null>(null)
  const [tick, setTick] = useState(0)
  const sw = useStartedWith(mine?.folder ?? null, mine?.id ?? null)
  const key = mine ? `${mine.cwd}\n${mine.id}` : null
  useEffect(() => {
    setConv(null)
    if (!mine) return
    let cancelled = false
    void Promise.all([
      Promise.resolve()
        .then(() => api.folders.loads(mine.cwd, undefined, mine.id))
        .catch(() => null),
      Promise.resolve()
        .then(() => api.skillsCatalog(agent.id, mine.id))
        .catch(() => null),
    ]).then(([loads, skills]) => {
      if (!cancelled && loads?.conversation) setConv({ loads, skills: skills ?? null })
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, agent.id, tick])
  const { reload: reloadSrc } = src
  const reload = useCallback(() => {
    reloadSrc()
    setTick((t) => t + 1)
  }, [reloadSrc])
  const thread = conv?.loads.conversation?.thread ?? null
  const mode: HereMode = view?.origin?.kind === 'automation' ? 'run' : sw?.mode === 'console' ? (view?.live ? 'console-running' : 'console') : 'chat'
  const from = useMemo<PlacesFrom | null>(
    () => (mine && view && thread ? { id: mine.id, folder: mine.folder, thread, title: view.title || 'this conversation', cwd: mine.cwd, mode } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, thread, view?.title, mode],
  )
  const merged = useMemo<KnowsSources>(() => {
    if (!from || !conv) return src
    return {
      ...src,
      loads: withConversationLines(src.loads, conv.loads, agent.id),
      catalog:
        conv.skills && conv.loads.folder === (src.loads?.folder ?? agent.folder) ? withConversationSkills(src.catalog, conv.skills, from.thread) : src.catalog,
      reload,
    }
  }, [src, conv, from, agent.id, agent.folder, reload])
  return { from, src: merged }
}
