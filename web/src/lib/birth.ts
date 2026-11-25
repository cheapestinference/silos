// birth.ts — the ONE model of an agent's birth, drawn by Welcome's Project and Who steps
// and the New agent form alike (components/new-agent/BirthFields.tsx), so
// the two can't drift: its project · its name · how it works · its mission
// (and, in the form, its engine — only when more than one is usable).
// Pure; the components only draw and call. The server is the authority
// (POST /api/agents, server/src/birth-project.ts): this only says early
// what it would refuse.
import type { AgentView } from './types'
import { MASTER_ID } from './constants'
import { territoriesOf } from './territory'
import { basename } from './routes'
import { missionProblem, splitMission } from './mission'
import { worksPayload, worksProblem, type Works } from './first-run'
import { projectClash, projectNameEmpty } from './new-agent'

// the agent's project:
//  new      — a new project by name, at <Projects folder>/<slug>; `name: null` follows
//             the agent's name until the owner types one of its own
//  existing — a project Silos knows (an in-play agent's folder)
//  given    — the folder New project just made (its door hands it over);
//             sent as the folder, the one path the form never asks for
export type ProjectPick = { kind: 'new'; name: string | null } | { kind: 'existing'; folder: string } | { kind: 'given'; folder: string }

export interface Birth {
  project: ProjectPick
  name: string
  works: Works
  mission: string
}

export function emptyBirth(): Birth {
  return { project: { kind: 'new', name: null }, name: '', works: 'told', mission: '' }
}

// the projects Silos knows: every in-play agent's folders (managed-folder.ts
// on the server — the only ones it takes as an existing project)
type Agentish = Pick<AgentView, 'id' | 'folder' | 'folders' | 'archived'>
export function knownProjects(agents: readonly Agentish[]): string[] {
  const all = agents.filter((a) => a.id !== MASTER_ID && !a.archived).flatMap((a) => territoriesOf(a))
  return [...new Set(all)].sort((x, y) => basename(x).localeCompare(basename(y)))
}

// a door that opens the form on a folder: a known project is picked as
// such; any other folder is the one that door handed over
export function birthFor(folder: string | null, name: string | null, agents: readonly Agentish[]): Birth {
  const b = emptyBirth()
  const clean = folder?.trim().replace(/(.)\/+$/, '$1') ?? ''
  if (clean !== '') b.project = knownProjects(agents).includes(clean) ? { kind: 'existing', folder: clean } : { kind: 'given', folder: clean }
  if (name) b.name = name
  return b
}

// the same slug rule as the server's (server/src/slug.ts) — its preview
export function slugOf(name: string, max: number): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '')
}
export const AGENT_SLUG_MAX = 32 // agent-registry.ts: /^[a-z0-9][a-z0-9-]{0,31}$/
export const PROJECT_SLUG_MAX = 40 // birth-project.ts

// a new project's name: its own once typed, else the agent's
export function projectName(b: Birth): string {
  return b.project.kind === 'new' ? (b.project.name ?? b.name).trim() : basename(b.project.folder)
}

// the folder a new project's name would take among the known ones
// (<Projects folder>/<slug>, the folder the server said — lib/projects-folder.ts;
// until it has, ~/Silos): known projects at that path
export function projectClashOf(b: Birth, known: readonly string[], projectsFolder: string | null = null): string | null {
  if (b.project.kind !== 'new') return null
  const slug = slugOf(projectName(b), PROJECT_SLUG_MAX)
  const at = (f: string): boolean => (projectsFolder !== null ? f === `${projectsFolder}/${slug}` : f.endsWith(`/Silos/${slug}`))
  return slug !== '' && known.some(at) ? projectClash(projectName(b)) : null
}

export interface BirthProblems {
  project: string | null
  mission: string | null
  nameEmpty: boolean
}
export function birthProblems(b: Birth, known: readonly string[], projectsFolder: string | null = null): BirthProblems {
  const name = b.name.trim()
  const m = splitMission(b.mission)
  const newProject = b.project.kind === 'new'
  return {
    // a new project needs a name of its own only once the agent's leaves none
    project: newProject && name !== '' && slugOf(projectName(b), PROJECT_SLUG_MAX) === '' ? projectNameEmpty : projectClashOf(b, known, projectsFolder),
    mission: missionProblem(m, name || 'it') ?? worksProblem(b.works, m.text, name),
    nameEmpty: slugOf(name, AGENT_SLUG_MAX) === '',
  }
}
export const birthReady = (p: BirthProblems): boolean => !p.nameEmpty && p.project === null && p.mission === null

// what Create sends: the project (never a path the form asked for), the
// name, the mission when written, and the one ask of how it works
export function birthPayload(b: Birth): {
  name: string
  project?: { name: string } | { folder: string }
  folder?: string
  mission?: ReturnType<typeof splitMission>
  control?: 'told' | 'proactive'
} {
  const m = splitMission(b.mission)
  const where =
    b.project.kind === 'new'
      ? { project: { name: projectName(b) } }
      : b.project.kind === 'existing'
        ? { project: { folder: b.project.folder } }
        : { folder: b.project.folder }
  return { name: b.name.trim(), ...where, ...(m.text ? { mission: m } : {}), ...worksPayload(b.works, m.text) }
}
