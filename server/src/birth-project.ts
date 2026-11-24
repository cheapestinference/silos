// birth-project.ts — where an agent born through POST /api/agents works: its
// project's folder itself, never a subfolder. The New agent form and Welcome
// ask for the project, never a path:
//   project: { name }   — a new project, made at ~/Silos/<slug of the name>
//   project: { folder } — an existing project: a folder Silos manages
//                          (managed-folder.ts — an in-play agent's folder or
//                          territory), nothing else
// A free `folder` stays for the callers that already made or chose one (New
// project's own form, the API); no project and no folder is a new project
// named like the agent, as before. Refusals are ControlErrors in plain
// words — the form shows them under its Project field.
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ControlError } from './control.js'
import { managedFolderOf } from './managed-folder.js'
import { projectsFolderOf } from './project-folder.js'
import { slugify } from './slug.js'
import type { AgentRegistry } from './agent-registry.js'

// a project folder's name: the same slugifier as an agent's id
export const PROJECT_SLUG_MAX = 40

export const PROJECT_SHAPE_ERROR = 'project takes { name } for a new project or { folder } for one Silos knows'
export const PROJECT_AND_FOLDER_ERROR = 'send a project or a folder, not both'
export const projectNameEmpty = (): string => 'the project needs a name — use letters or digits'
export const projectExists = (name: string): string => `a project called ${name} exists — pick it from the list, or name the new one differently`
export const projectFolderTaken = (path: string): string => `${path} already exists with files in it — pick another project name`
export const projectUnknown = (folder: string): string => `${folder} is not a project Silos knows — pick one from the list, or start a new project`

export type BirthProject = { name: string } | { folder: string }

/** The project asked in a POST body: undefined when none was sent; a
 *  400 for any other shape. */
export function parseBirthProject(v: unknown): BirthProject | undefined {
  if (v === undefined) return undefined
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ControlError(400, PROJECT_SHAPE_ERROR)
  const o = v as Record<string, unknown>
  const keys = Object.keys(o)
  if (keys.length !== 1) throw new ControlError(400, PROJECT_SHAPE_ERROR)
  if (typeof o.name === 'string') return { name: o.name }
  if (typeof o.folder === 'string') return { folder: o.folder }
  throw new ControlError(400, PROJECT_SHAPE_ERROR)
}

const isEmptyDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory() && readdirSync(p).length === 0
  } catch {
    return false
  }
}

/** The folder the agent is born in, made when it is a new project's.
 *  Judged BEFORE the registry writes anything: a refusal leaves no agent. */
export function birthFolder(o: {
  project: BirthProject | undefined
  folder: string
  agentId: string
  registry: Pick<AgentRegistry, 'list'> & Partial<Pick<AgentRegistry, 'checkFolder'>>
  home: string
}): string {
  // a new project's folder passes the project folder check (project-folder.ts)
  // BEFORE it is made — a refusal leaves nothing on disk — and is made, and
  // returned, at its real path (the Projects folder may be a symlink)
  const judged = (path: string): string => {
    const v = o.registry.checkFolder?.(path)
    if (v && !v.ok) throw new ControlError(v.conflict ? 409 : 400, v.reason)
    return v?.path ?? path
  }
  if (o.project !== undefined && o.folder !== '') throw new ControlError(400, PROJECT_AND_FOLDER_ERROR)
  if (o.project && 'folder' in o.project) {
    const asked = o.project.folder.trim().replace(/(.)\/+$/, '$1')
    const known = asked.startsWith('/') ? managedFolderOf(o.registry, asked) : null
    if (known === null) throw new ControlError(409, projectUnknown(asked))
    return known
  }
  if (o.project && 'name' in o.project) {
    const name = o.project.name.trim()
    const slug = slugify(name, PROJECT_SLUG_MAX)
    if (slug === '') throw new ControlError(400, projectNameEmpty())
    const asked = join(projectsFolderOf(o.home), slug)
    if (managedFolderOf(o.registry, asked) !== null) throw new ControlError(409, projectExists(name))
    const path = judged(asked)
    if (managedFolderOf(o.registry, path) !== null) throw new ControlError(409, projectExists(name))
    // an unknown folder already there: an empty one is taken as is; one
    // with files is someone's — adopting it is another door
    if (existsSync(path) && !isEmptyDir(path)) throw new ControlError(409, projectFolderTaken(`~/Silos/${slug}`))
    mkdirSync(path, { recursive: true })
    return path
  }
  if (o.folder !== '') return o.folder
  const path = judged(join(projectsFolderOf(o.home), o.agentId))
  mkdirSync(path, { recursive: true })
  return path
}
