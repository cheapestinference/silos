// OrgByProject — one org per project (a finance
// agent in one project and another in a different one). Each project with
// two or more agents is its own section, headed by the project (a door to
// it), with its own tree; a project with a single agent has nobody to report
// to and is named once, quietly, at the end. Both placements use it: Map ›
// Org (read-only) and the Hierarchy silo's page (the editor).
import { useMemo } from 'react'
import { useStore } from '../../store'
import { orgProjects } from '../../lib/org'
import { sameProject } from '../../../../server/src/project-scope'
import { basename } from '../../lib/routes'
import type { SiloRelationEdge } from '../../lib/types'
import { OrgTree } from './OrgTree'

export function OrgByProject({
  silo,
  relation,
  edges,
  editable = false,
  onChanged,
  only,
}: {
  silo: string
  relation: string
  edges: readonly SiloRelationEdge[]
  editable?: boolean
  onChanged?: (edges: SiloRelationEdge[]) => void
  // a project's own page: just its org
  only?: string
}) {
  const agents = useStore((s) => s.agents)
  const changePage = useStore((s) => s.changePage)
  const projects = useMemo(() => orgProjects(agents).filter((p) => only === undefined || sameProject(p.folder, only)), [agents, only])
  const teams = projects.filter((p) => p.ids.length > 1)
  const solo = projects.filter((p) => p.ids.length === 1)
  const nameOf = (id: string): string => agents.find((a) => a.id === id)?.name ?? id
  return (
    <div data-testid="org-by-project">
      {teams.length === 0 ? (
        <p className="text-[13px] text-ink-2">No project has two agents yet — an org starts when a project has someone to report to.</p>
      ) : null}
      {teams.map((p, i) => (
        <section key={p.folder} className={i > 0 ? 'mt-9' : ''} data-testid="org-project" data-folder={p.folder}>
          <h2 className="mb-3 flex items-baseline gap-2">
            <button
              type="button"
              onClick={() => changePage({ kind: 'project', folder: p.folder })}
              className="font-display text-[17px] text-ink hover:text-terracotta"
            >
              {basename(p.folder)}
            </button>
            <span className="text-[12px] text-ink-3">{p.ids.length} agents</span>
          </h2>
          <OrgTree silo={silo} relation={relation} edges={edges} folder={p.folder} editable={editable} onChanged={onChanged} />
        </section>
      ))}
      {solo.length > 0 && only === undefined ? (
        <p className="mt-9 max-w-[62ch] text-[12px] leading-relaxed text-ink-3" data-testid="org-solo">
          One agent each, nobody to report to:{' '}
          {solo.map((p, i) => (
            <span key={p.folder}>
              {i > 0 ? ' · ' : ''}
              <button type="button" onClick={() => changePage({ kind: 'project', folder: p.folder })} className="hover:text-terracotta">
                {nameOf(p.ids[0]!)} in {basename(p.folder)}
              </button>
            </span>
          ))}
        </p>
      ) : null}
    </div>
  )
}
