// OrgTile — the org chart's standing place on Home (it was too
// hidden — the edge-only silo was deliberately tile-less and the owner
// never found the chart; what exists must exist where the eye passes). Real
// content, never a crowned box: the teams and the loners, read from the
// installed relation's edges; the door opens Map › Org. A fetch failure
// renders nothing here — Home shows no error text (panel, not detail); the
// chart's own page says what broke. Named «Org» on Home and on a project's
// Now alike — the word of the Map's tab and of the way back.
import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { orgProjects, orgSource, orgTileFacts } from '../../lib/org'
import { sameProject } from '../../../../server/src/project-scope'
import { basename } from '../../lib/routes'
import type { SiloRelationEdge } from '../../lib/types'
import { Tile } from '../Tile'

export function OrgTile({ folder }: { folder?: string } = {}) {
  const silos = useStore((s) => s.silos)
  const agents = useStore((s) => s.agents)
  const changePage = useStore((s) => s.changePage)
  const siloTick = useStore((s) => s.siloTick)
  const source = useMemo(() => orgSource(silos), [silos])
  const [edges, setEdges] = useState<SiloRelationEdge[] | null>(null)
  useEffect(() => {
    if (!source) return
    let cancelled = false
    api.silos
      .relation(source.silo, source.relation)
      .then((r) => {
        if (!cancelled) setEdges(r.edges)
      })
      .catch(() => {
        if (!cancelled) setEdges(null)
      })
    return () => {
      cancelled = true
    }
  }, [source?.silo, source?.relation, siloTick]) // eslint-disable-line react-hooks/exhaustive-deps
  // one org per project: the projects with two or more agents — on a
  // project's Now, only its own
  const facts = useMemo(
    () =>
      edges === null
        ? null
        : orgProjects(agents)
            // a nested folder's page shows the org of the project it is part of
            .filter((p) => p.ids.length > 1 && (folder === undefined || sameProject(p.folder, folder)))
            .map((p) => orgTileFacts(agents, edges, p.folder)),
    [agents, edges, folder],
  )
  if (!source || facts === null || facts.length === 0) return null
  const name = (id: string): string => agents.find((a) => a.id === id)?.name ?? id
  const emoji = (id: string): string | undefined => agents.find((a) => a.id === id)?.emoji
  const withTeams = facts.filter((f) => f.teams.length > 0)
  const one = (f: (typeof facts)[number]): string => {
    const t = f.teams.map((x) => `${name(x.root)} leads ${x.members.length}`).join(', ')
    const l = f.loners.length === 0 ? '' : ` — ${f.loners.length === 1 ? `${name(f.loners[0]!)} on its own` : `${f.loners.length} on their own`}`
    return `${t}${l}`
  }
  const lead =
    withTeams.length === 0
      ? 'Nobody reports to anybody yet.'
      : withTeams.length === 1
        ? `${folder === undefined ? `${basename(withTeams[0]!.folder)}: ` : ''}${one(withTeams[0]!)}.`
        : `${withTeams.length} projects have a team.`
  return (
    <Tile
      testId="org-tile"
      name="Org"
      quiet={withTeams.length === 0}
      door="Open"
      onOpen={() => changePage({ kind: 'map', view: 'org' })}
      lead={lead}
      lines={withTeams.flatMap((f) =>
        f.teams.map((t) => ({
          key: `${f.folder}:${t.root}`,
          mark: emoji(t.root),
          text: `${name(t.root)} — ${t.members.map(name).join(', ')}`,
          meta: folder === undefined ? <span className="font-body">{basename(f.folder)}</span> : undefined,
        })),
      )}
    />
  )
}
