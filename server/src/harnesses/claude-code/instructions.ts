// harnesses/claude-code/instructions.ts — Harness.instructions for Claude
// Code: every instruction file a conversation in a folder loads (spec
// memory-places §2), ONE row each, with its origin, its engine type, whom it
// reaches by launch kind, when it loads, what it weighs, and whether Silos
// may write it (T3). Read-only: it reads files and transcripts, never writes.
//
// The scan (moved here from loaded-at-start.ts, which now projects it):
//  · the organization's: <managed dir>/CLAUDE.md and its .claude/rules/**;
//  · each login's: <config dir>/CLAUDE.md and rules/** — one row per real
//    file, naming the logins that do not load it (one that keeps its own);
//  · every folder above, from the first below `/` to the folder's parent:
//    CLAUDE.md, .claude/CLAUDE.md, .claude/rules/**, CLAUDE.local.md (and an
//    AGENTS.md where no CLAUDE.md sits) — never a login's config dir;
//  · the folder's: CLAUDE.md, .claude/CLAUDE.md, .claude/rules/**,
//    CLAUDE.local.md, AGENTS.md (alone, or through an import);
//  · subfolders, on demand — the same names, BOUNDED: depth 6, 2,000
//    folders, 60 files; no dot folder but a folder's own .claude (and never
//    one that is a login's config dir), never node_modules, never a link;
//  · every `@path` import, to the engine's depth (5), outside code;
//  · auto memory: the index and its notes under <projects root>/<folder
//    key>/memory, or — moved by `autoMemoryDirectory` — where a settings file
//    put it, then read-only, naming that file.
// Plus every file the folder's transcripts NAME (the ONE reader,
// instructions-record.ts) that the scan missed, classified by where it is.
//
// A row's weight is the newest record's content for it (as loaded), else
// its bytes on disk; rows are matched by their REAL path — the engine names
// one file under each login's dir.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  InstructionKind,
  InstructionLaunch,
  InstructionOrigin,
  InstructionPlace,
  InstructionReach,
  InstructionRow,
  InstructionsInput,
  InstructionsList,
  InstructionsThreadReading,
  InstructionWhen,
} from '../contract.js'
import { mungePath } from '../../agent-registry.js'
import { sliceLines } from '../../jsonl-lines.js'
import { InstructionsReplay, mayMatter, type RecordedFile } from './instructions-record.js'

export const SUBFOLDER_DEPTH = 6
export const SUBFOLDER_MAX_DIRS = 2000
export const SUBFOLDER_MAX_FILES = 60
export const IMPORT_MAX_HOPS = 5
const RULES_MAX = 50
const TEXT_MAX_BYTES = 256 * 1024
const READ_MAX_BYTES = 1024 * 1024
export const DEFAULT_MANAGED_DIR = '/etc/claude-code'

type Source = 'user' | 'project' | 'local'

/** The settings sources each kind of start Silos launches reads (code-read:
 *  headless.ts, task-turns.ts, runs.ts) — what decides a row's reach. */
export const LAUNCH_SOURCES: Readonly<Record<InstructionLaunch, readonly Source[]>> = {
  console: ['user', 'project', 'local'],
  chat: ['user', 'project', 'local'],
  wake: ['user', 'project'],
  run: ['user', 'project'],
  'run-inherits': ['user', 'project', 'local'],
  'run-no-folder': ['user'],
}
const ALL_LAUNCHES = Object.keys(LAUNCH_SOURCES) as InstructionLaunch[]

/** The launches that read a file of this engine type: User needs `user`,
 *  Project `project`, Local `local`; Managed and auto memory load whatever
 *  the sources. */
export function launchesReading(engineType: string | null): InstructionLaunch[] {
  const source: Source | null = engineType === 'User' ? 'user' : engineType === 'Project' ? 'project' : engineType === 'Local' ? 'local' : null
  if (source === null) return [...ALL_LAUNCHES]
  return ALL_LAUNCHES.filter((l) => LAUNCH_SOURCES[l].includes(source))
}

type Json = Record<string, unknown>
const asObject = (v: unknown): Json | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null)
const readJson = (path: string): Json | null => {
  try {
    return asObject(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}
const realOf = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}
const inside = (p: string, dir: string): boolean => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep)
const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}
/** A path with links resolved, even where it does not exist yet: the deepest
 *  existing ancestor's real path, the rest on top. */
const resolvedOf = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    const up = dirname(p)
    return up === p ? p : join(resolvedOf(up), basename(p))
  }
}

function readText(path: string, max = TEXT_MAX_BYTES): string | null {
  try {
    const s = statSync(path)
    if (!s.isFile() || s.size > max) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** The `@path` candidates a CLAUDE.md names, outside fenced code blocks and
 *  inline code spans (the engine skips those). A candidate starts a word
 *  ("@" at line start or after whitespace) — an email never is one. */
export function parseImports(text: string): string[] {
  const out: string[] = []
  let fenced = false
  for (const raw of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const line = raw.replace(/`[^`]*`/g, ' ')
    for (const m of line.matchAll(/(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[^\s@`()<>[\]]+)/g)) {
      const p = m[1]!.replace(/[.,;:!?)]+$/, '')
      if (p !== '' && !out.includes(p)) out.push(p)
    }
  }
  return out
}

/** An import candidate resolved against its file's directory ('~/' = home). */
export function resolveImport(candidate: string, fromFile: string, home: string): string {
  if (candidate.startsWith('~/')) return join(home, candidate.slice(2))
  return isAbsolute(candidate) ? candidate : resolve(dirname(fromFile), candidate)
}

/** A rule's `paths:` frontmatter, unquoted — null when it has none. */
function rulePaths(path: string): string | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readText(path) ?? '')?.[1] ?? ''
  const line = /^paths:\s*(.+)$/m.exec(fm)?.[1]?.trim()
  return line ? line.replace(/^["'[]|["'\]]$/g, '') : null
}

/** One file the scan found, before it is judged and weighed. */
export interface Found {
  path: string
  kind: InstructionKind
  origin: InstructionOrigin
  engineType: string | null
  when: InstructionWhen
  /** a rule's paths: */
  paths?: string
  importedBy?: string
  through?: 'import' | 'alone'
  /** a folder above: that folder (and its distance from the folder, 1 = the parent) */
  above?: { dir: string; depth: number }
  /** the reach of the file that imports it */
  parent?: Found
  inIndex?: boolean
  movedBy?: string
}

export interface ScanInput {
  folder: string | null
  home: string
  loginDirs: string[]
  projectsRoot?: string
  managedDir?: string
}

export interface Scan {
  found: Found[]
  notes: string[]
  /** <folder>/.claude is a login's config dir */
  homeFolder: boolean
  /** auto memory's directory, and the settings file that moved it */
  autoDir: { dir: string; movedBy?: string } | null
}

/** Whether `dir/.claude` is (or lies in) one of the login dirs. */
function claudeIsLogin(dir: string, loginReals: string[]): boolean {
  const c = realOf(join(dir, '.claude'))
  return loginReals.some((d) => inside(c, d))
}

/** The `autoMemoryDirectory` in force for the folder, and its file — the
 *  repository's own settings are ignored for it (schema). */
function movedAutoMemory(folder: string, home: string, userDir: string, managedDir: string): { dir: string; file: string } | null {
  const layers = [join(managedDir, 'managed-settings.json'), join(folder, '.claude', 'settings.local.json'), join(userDir, 'settings.json')]
  for (const file of layers) {
    const v = readJson(file)?.autoMemoryDirectory
    if (typeof v !== 'string' || v.trim() === '') continue
    const t = v.trim()
    const dir = t.startsWith('~/') ? join(home, t.slice(2)) : isAbsolute(t) ? t : resolve(folder, t)
    return { dir, file }
  }
  return null
}

/** The scan alone: synchronous, bounded, no transcript read. */
export function scanInstructions(input: ScanInput): Scan {
  const { folder, home } = input
  const loginDirs = input.loginDirs.length > 0 ? input.loginDirs : [join(home, '.claude')]
  const loginReals = loginDirs.map(realOf)
  const managedDir = input.managedDir ?? DEFAULT_MANAGED_DIR
  const notes: string[] = []
  const found: Found[] = []
  const listed = new Set<string>()
  const add = (f: Found): boolean => {
    if (!isFile(f.path)) return false
    const key = realOf(f.path)
    if (listed.has(key)) return false
    listed.add(key)
    found.push(f)
    return true
  }
  const rulesUnder = (dir: string, mk: (p: string, paths: string | null) => Found): void => {
    let n = 0
    const walk = (d: string, depth: number): void => {
      if (depth > 3 || n >= RULES_MAX) return
      let ents
      try {
        ents = readdirSync(d, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
        if (n >= RULES_MAX) return
        if (e.name.startsWith('.')) continue
        const p = join(d, e.name)
        if (e.isDirectory()) {
          walk(p, depth + 1)
          continue
        }
        if (!e.isFile() || !e.name.endsWith('.md')) continue
        if (add(mk(p, rulePaths(p)))) n++
      }
    }
    walk(dir, 0)
  }
  const ruleWhen = (paths: string | null): InstructionWhen => ({ at: paths ? 'on-demand' : 'start' })

  // ---- the organization's
  add({ path: join(managedDir, 'CLAUDE.md'), kind: 'managed', origin: 'organization', engineType: 'Managed', when: { at: 'start' } })
  rulesUnder(join(managedDir, '.claude', 'rules'), (p, paths) => ({
    path: p,
    kind: 'managed',
    origin: 'organization',
    engineType: 'Managed',
    when: ruleWhen(paths),
    ...(paths ? { paths } : {}),
  }))

  // ---- each login's (the machine's first)
  for (const d of loginDirs) add({ path: join(d, 'CLAUDE.md'), kind: 'personal', origin: 'machine', engineType: 'User', when: { at: 'start' } })
  for (const d of loginDirs)
    rulesUnder(join(d, 'rules'), (p, paths) => ({
      path: p,
      kind: 'personal-rule',
      origin: 'machine',
      engineType: 'User',
      when: ruleWhen(paths),
      ...(paths ? { paths } : {}),
    }))

  let homeFolder = false
  let autoDir: Scan['autoDir'] = null
  if (folder !== null) {
    homeFolder = claudeIsLogin(folder, loginReals)
    // ---- every folder above, from the first below `/` down to the parent
    const ups: string[] = []
    for (let dir = dirname(folder); dirname(dir) !== dir; dir = dirname(dir)) ups.unshift(dir)
    ups.forEach((dir, i) => {
      const above = { dir, depth: ups.length - i }
      const loginHere = claudeIsLogin(dir, loginReals)
      add({ path: join(dir, 'CLAUDE.md'), kind: 'above', origin: 'above', engineType: 'Project', when: { at: 'start' }, above })
      if (!loginHere) add({ path: join(dir, '.claude', 'CLAUDE.md'), kind: 'above', origin: 'above', engineType: 'Project', when: { at: 'start' }, above })
      add({ path: join(dir, 'CLAUDE.local.md'), kind: 'above', origin: 'above', engineType: 'Local', when: { at: 'start' }, above })
      if (!existsSync(join(dir, 'CLAUDE.md')))
        add({ path: join(dir, 'AGENTS.md'), kind: 'above', origin: 'above', engineType: 'Project', when: { at: 'start' }, above, through: 'alone' })
      if (!loginHere)
        rulesUnder(join(dir, '.claude', 'rules'), (p, paths) => ({
          path: p,
          kind: 'above',
          origin: 'above',
          engineType: 'Project',
          when: ruleWhen(paths),
          above,
          ...(paths ? { paths } : {}),
        }))
    })

    // ---- the folder's own
    const projectMd = join(folder, 'CLAUDE.md')
    add({ path: projectMd, kind: 'project', origin: 'project', engineType: 'Project', when: { at: 'start' } })
    if (!homeFolder) add({ path: join(folder, '.claude', 'CLAUDE.md'), kind: 'project', origin: 'project', engineType: 'Project', when: { at: 'start' } })
    // the engine reads a repository's AGENTS.md IN PLACE of CLAUDE.md where
    // none sits beside it; with one, an @AGENTS.md import lists it
    if (!existsSync(projectMd))
      add({ path: join(folder, 'AGENTS.md'), kind: 'agents', origin: 'project', engineType: 'Project', when: { at: 'start' }, through: 'alone' })
    if (!homeFolder)
      rulesUnder(join(folder, '.claude', 'rules'), (p, paths) => ({
        path: p,
        kind: 'project-rule',
        origin: 'project',
        engineType: 'Project',
        when: ruleWhen(paths),
        ...(paths ? { paths } : {}),
      }))
    add({ path: join(folder, 'CLAUDE.local.md'), kind: 'private', origin: 'private', engineType: 'Local', when: { at: 'start' } })

    // ---- subfolders, on demand — bounded
    let dirs = 0
    let files = 0
    let capped = false
    const walk = (dir: string, depth: number): void => {
      if (capped) return
      let ents
      try {
        ents = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      ents.sort((a, b) => a.name.localeCompare(b.name))
      if (depth > 0) {
        const under = `${relative(folder, dir).split(sep).join('/')}/`
        const ownClaude = ents.some((e) => e.name === '.claude' && e.isDirectory()) && !claudeIsLogin(dir, loginReals)
        const names: [string, string][] = [
          ['CLAUDE.md', 'Project'],
          ['CLAUDE.local.md', 'Local'],
        ]
        for (const [f, type] of names) {
          if (!ents.some((e) => e.name === f && e.isFile())) continue
          if (files >= SUBFOLDER_MAX_FILES) {
            capped = true
            return
          }
          if (
            add({
              path: join(dir, f),
              kind: 'subfolder',
              origin: f === 'CLAUDE.local.md' ? 'private' : 'project',
              engineType: type,
              when: { at: 'on-demand', under },
            })
          )
            files++
        }
        if (ownClaude) {
          if (isFile(join(dir, '.claude', 'CLAUDE.md'))) {
            if (files >= SUBFOLDER_MAX_FILES) {
              capped = true
              return
            }
            if (add({ path: join(dir, '.claude', 'CLAUDE.md'), kind: 'subfolder', origin: 'project', engineType: 'Project', when: { at: 'on-demand', under } }))
              files++
          }
          rulesUnder(join(dir, '.claude', 'rules'), (p, paths) => ({
            path: p,
            kind: 'subfolder',
            origin: 'project',
            engineType: 'Project',
            when: { at: 'on-demand', under },
            ...(paths ? { paths } : {}),
          }))
        }
      }
      if (depth >= SUBFOLDER_DEPTH) return
      for (const e of ents) {
        // Dirent.isDirectory() is false for a link: links are never followed
        if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
        const p = join(dir, e.name)
        if (loginReals.includes(realOf(p))) continue
        if (++dirs > SUBFOLDER_MAX_DIRS) {
          capped = true
          return
        }
        walk(p, depth + 1)
      }
    }
    walk(folder, 0)
    if (capped) notes.push(`Subfolders read up to ${SUBFOLDER_MAX_FILES} files and ${SUBFOLDER_MAX_DIRS} folders — there may be more CLAUDE.md deeper in.`)
  }

  // ---- @imports, breadth-first from every file found
  const queue: { from: Found; hop: number }[] = found.map((f) => ({ from: f, hop: 0 }))
  const scanned = new Set<string>()
  const agentsMd = folder !== null ? join(folder, 'AGENTS.md') : null
  while (queue.length > 0) {
    const next = queue.shift()!
    const key = realOf(next.from.path)
    if (scanned.has(key)) continue
    scanned.add(key)
    const text = readText(next.from.path)
    if (text === null || next.hop >= IMPORT_MAX_HOPS) continue
    const importer = next.from
    for (const cand of parseImports(text)) {
      const target = resolveImport(cand, importer.path, home)
      const root = importer.parent ?? importer
      const f: Found =
        target === agentsMd
          ? { path: target, kind: 'agents', origin: 'project', engineType: 'Project', when: importer.when, through: 'import', importedBy: importer.path }
          : {
              path: target,
              kind: 'import',
              origin: root.origin,
              engineType: importer.engineType,
              when: importer.when,
              importedBy: importer.path,
              parent: root,
              ...(root.above ? { above: root.above } : {}),
            }
      if (add(f)) queue.push({ from: f, hop: next.hop + 1 })
    }
  }

  // ---- auto memory
  if (folder !== null && input.projectsRoot !== undefined) {
    const moved = movedAutoMemory(folder, home, loginDirs[0]!, managedDir)
    autoDir = moved ? { dir: moved.dir, movedBy: moved.file } : { dir: join(input.projectsRoot, mungePath(folder), 'memory') }
    const dir = autoDir.dir
    const index = join(dir, 'MEMORY.md')
    const indexText = readText(index)
    const linked = new Set<string>()
    if (indexText !== null) for (const m of indexText.matchAll(/\]\(([^)\s]+\.md)\)/g)) linked.add(basename(m[1]!))
    const movedBy = moved ? { movedBy: moved.file } : {}
    add({ path: index, kind: 'auto-index', origin: 'auto', engineType: 'AutoMem', when: { at: 'start' }, ...movedBy })
    let ents: string[] = []
    try {
      ents = readdirSync(dir)
        .filter((n) => n.endsWith('.md') && n !== 'MEMORY.md')
        .sort()
    } catch {
      /* none yet */
    }
    for (const n of ents)
      add({
        path: join(dir, n),
        kind: 'auto-note',
        origin: 'auto',
        engineType: null,
        when: { at: 'on-demand' },
        ...(indexText !== null ? { inIndex: linked.has(n) } : {}),
        ...movedBy,
      })
  }

  return { found, notes, homeFolder, autoDir }
}

// ------------------------------------------------------------ judgement

const READ_ONLY = {
  organization: 'set by your organization — Silos never writes it',
  above: 'a folder above this project — change it there',
  import: 'an import — open it in Files',
  outside: 'it leads outside its folder through a link',
  home: 'this folder’s .claude is Claude Code’s own config folder — only its CLAUDE.md is the project’s',
  moved: 'auto memory moved by a settings file — Silos writes only the default place',
  excluded: 'under a folder Silos never writes (.git, node_modules, a link, a login’s config dir)',
}

/** Whether the path from `root` down to `p` holds a link, a dot folder (but
 *  `.claude`), `.git` or `node_modules` — the scan's own exclusions. */
function excludedUnder(root: string, p: string): boolean {
  const rel = relative(root, p)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return true
  const parts = rel.split(sep)
  let cur = root
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (part === '.git' || part === 'node_modules') return true
    if (i < parts.length - 1 && part.startsWith('.') && part !== '.claude') return true
    cur = join(cur, part)
    try {
      if (lstatSync(cur).isSymbolicLink() && i < parts.length - 1) return true
    } catch {
      /* not there */
    }
  }
  return false
}

interface Judge {
  folder: string | null
  folderReal: string | null
  loginDirs: string[]
  loginReals: string[]
  homeFolder: boolean
  autoDefault: string | null
  /** the default auto-memory dir resolves inside the projects root (no link out) */
  autoInside: boolean
}

function judged(f: Found, real: string, j: Judge): { editable: boolean; readOnly?: string; confirm?: true; linkOut?: true } {
  const no = (why: string) => (why === READ_ONLY.outside ? { editable: false, readOnly: why, linkOut: true as const } : { editable: false, readOnly: why })
  switch (f.kind) {
    case 'managed':
      return no(READ_ONLY.organization)
    case 'above':
      return no(READ_ONLY.above)
    case 'import':
      return no(READ_ONLY.import)
    case 'launch':
      return no(READ_ONLY.import)
    case 'personal':
    case 'personal-rule': {
      const ok = j.loginReals.some((d) => {
        const rel = relative(d, real)
        return f.kind === 'personal' ? rel === 'CLAUDE.md' : rel.startsWith(`rules${sep}`) && rel.endsWith('.md') && !excludedUnder(join(d, 'rules'), real)
      })
      return ok ? { editable: true, confirm: true } : no(READ_ONLY.outside)
    }
    case 'auto-index':
    case 'auto-note': {
      if (f.movedBy) return no(READ_ONLY.moved)
      if (j.autoDefault === null || !j.autoInside) return no(READ_ONLY.outside)
      const d = realOf(j.autoDefault)
      return dirname(real) === d && real.endsWith('.md') ? { editable: true } : no(READ_ONLY.outside)
    }
    default: {
      if (j.folderReal === null) return no(READ_ONLY.outside)
      if (j.homeFolder) return real === join(j.folderReal, 'CLAUDE.md') ? { editable: true } : no(READ_ONLY.home)
      if (!inside(real, j.folderReal) || real === j.folderReal) return no(READ_ONLY.outside)
      if (excludedUnder(j.folderReal, real)) return no(READ_ONLY.excluded)
      if (j.loginReals.some((d) => inside(real, d))) return no(READ_ONLY.excluded)
      return { editable: true }
    }
  }
}

function reachOf(f: Found, j: Judge, real: string): InstructionReach {
  const src = f.parent ?? f
  const launches = launchesReading(f.engineType ?? src.engineType)
  const paths = f.paths ? { paths: f.paths } : {}
  switch (src.kind) {
    case 'managed':
      return { scope: 'organization', launches: [...ALL_LAUNCHES], ...paths }
    case 'personal':
    case 'personal-rule': {
      // a login that does not name this file under its own dir does not load it
      const rel = j.loginReals.map((d) => relative(d, realOf(src.path))).find((r) => !r.startsWith('..') && !isAbsolute(r)) ?? null
      const notOn = rel === null ? [] : j.loginDirs.filter((d) => realOf(join(d, rel)) !== realOf(src.path))
      return { scope: 'machine', launches, ...paths, ...(notOn.length > 0 ? { notOn } : {}) }
    }
    case 'above':
      return { scope: 'under', under: src.above?.dir ?? dirname(real), launches, ...paths }
    case 'auto-index':
    case 'auto-note':
      return { scope: 'project', launches: [...ALL_LAUNCHES] }
    default:
      return { scope: 'project', launches, ...paths }
  }
}

const shownOf =
  (folder: string | null, home: string) =>
  (p: string): string => {
    if (folder !== null) {
      const r = relative(folder, p)
      if (r !== '' && !r.startsWith('..') && !isAbsolute(r)) return r
    }
    const h = relative(home, p)
    if (h !== '' && !h.startsWith('..') && !isAbsolute(h)) return `~/${h}`
    return p
  }

/** A file a record names that the scan did not list, classified by where it is. */
function foundOfRecord(rec: RecordedFile, folder: string | null, j: Judge, aboveDirs: string[]): Found {
  const real = realOf(rec.path)
  const type = rec.type || null
  const when: InstructionWhen = { at: 'on-demand' }
  for (let i = 0; i < j.loginReals.length; i++) {
    const d = j.loginReals[i]!
    if (!inside(real, d)) continue
    const rel = relative(d, real)
    if (rel === 'CLAUDE.md') return { path: rec.path, kind: 'personal', origin: 'machine', engineType: 'User', when: { at: 'start' } }
    if (rel.startsWith(`rules${sep}`)) return { path: rec.path, kind: 'personal-rule', origin: 'machine', engineType: 'User', when: { at: 'start' } }
    return { path: rec.path, kind: 'import', origin: 'machine', engineType: type, when }
  }
  if (folder !== null && j.folderReal !== null && inside(real, j.folderReal)) {
    const parts = relative(j.folderReal, real).split(sep)
    const name = parts[parts.length - 1]!
    const c = parts.indexOf('.claude')
    const isRule = c >= 0 && parts[c + 1] === 'rules' && name.endsWith('.md')
    const isNamed = name === 'CLAUDE.md' || name === 'CLAUDE.local.md'
    if (isRule || isNamed) {
      // the folder the file belongs to: what precedes its .claude, or its own dir
      const sub = isRule ? parts.slice(0, c) : parts[parts.length - 2] === '.claude' ? parts.slice(0, -2) : parts.slice(0, -1)
      const local = name === 'CLAUDE.local.md' && !isRule
      if (sub.length === 0) {
        return isRule
          ? { path: rec.path, kind: 'project-rule', origin: 'project', engineType: type ?? 'Project', when: { at: 'start' } }
          : {
              path: rec.path,
              kind: local ? 'private' : 'project',
              origin: local ? 'private' : 'project',
              engineType: type ?? (local ? 'Local' : 'Project'),
              when: { at: 'start' },
            }
      }
      return {
        path: rec.path,
        kind: 'subfolder',
        origin: local ? 'private' : 'project',
        engineType: type ?? (local ? 'Local' : 'Project'),
        when: { at: 'on-demand', under: `${sub.join('/')}/` },
      }
    }
    return { path: rec.path, kind: 'import', origin: 'project', engineType: type, when }
  }
  const above = aboveDirs.find((d) => dirname(real) === realOf(d) || dirname(dirname(real)) === realOf(d))
  if (above !== undefined) return { path: rec.path, kind: 'above', origin: 'above', engineType: type, when: { at: 'start' }, above: { dir: above, depth: 0 } }
  return { path: rec.path, kind: 'import', origin: 'project', engineType: type, when }
}

// ------------------------------------------------------------ transcripts

/** Each transcript's replay, FOLLOWED: a file that grew is fed only what was
 *  appended since its last read (a live conversation's 40 MB transcript is
 *  never re-read whole); one that shrank or was replaced is read again. */
const follow = new Map<string, { size: number; offset: number; replay: InstructionsReplay }>()
const FOLLOW_MAX = 256

export async function replayOf(path: string): Promise<InstructionsReplay | null> {
  let size: number
  try {
    size = (await stat(path)).size
  } catch {
    follow.delete(path)
    return null
  }
  let hit = follow.get(path)
  if (!hit || size < hit.size) hit = { size: 0, offset: 0, replay: new InstructionsReplay() }
  if (size > hit.offset) {
    const h = hit
    try {
      await sliceLines(path, h.offset, size, (lines, bytes) => {
        h.replay.feed(lines.filter(mayMatter))
        h.offset += bytes
      })
    } catch {
      return hit.replay
    }
  }
  hit.size = size
  follow.delete(path)
  follow.set(path, hit)
  while (follow.size > FOLLOW_MAX) follow.delete(follow.keys().next().value!)
  return hit.replay
}

/** The rows the newest records name, by real path → as loaded. */
async function recordedOf(
  transcripts: readonly string[],
): Promise<{ byReal: Map<string, { chars: number; at: string | null; rec: RecordedFile }>; all: RecordedFile[] }> {
  const byReal = new Map<string, { chars: number; at: string | null; rec: RecordedFile }>()
  const all: RecordedFile[] = []
  for (const t of transcripts) {
    const replay = await replayOf(t)
    if (!replay) continue
    const r = replay.reading()
    for (const f of [...r.files, ...r.nested]) {
      const real = realOf(f.path)
      if (byReal.has(real)) continue
      byReal.set(real, { chars: [...f.content].length, at: f.at, rec: f })
      all.push(f)
    }
  }
  return { byReal, all }
}

// ------------------------------------------------------------ the list

function judgeOf(input: { folder: string | null; home: string; loginDirs: string[]; projectsRoot?: string }, scan: Scan): Judge {
  const loginDirs = input.loginDirs.length > 0 ? input.loginDirs : [join(input.home, '.claude')]
  const autoDefault = scan.autoDir && !scan.autoDir.movedBy ? scan.autoDir.dir : null
  return {
    autoInside: autoDefault !== null && input.projectsRoot !== undefined && inside(resolvedOf(autoDefault), realOf(input.projectsRoot)),
    folder: input.folder,
    folderReal: input.folder !== null ? realOf(input.folder) : null,
    loginDirs,
    loginReals: loginDirs.map(realOf),
    homeFolder: scan.homeFolder,
    autoDefault,
  }
}

function rowOf(f: Found, j: Judge, shown: (p: string) => string, loaded: { chars: number; at: string | null } | undefined): InstructionRow {
  const real = realOf(f.path)
  let bytes = 0
  let mtime = 0
  try {
    const s = statSync(f.path)
    bytes = s.size
    mtime = s.mtimeMs
  } catch {
    /* gone since */
  }
  const judge = judged(f, real, j)
  return {
    path: f.path,
    real,
    rel: shown(f.path),
    origin: f.origin,
    kind: f.kind,
    engineType: f.engineType,
    reach: reachOf(f, j, real),
    when: f.when,
    weight: loaded
      ? { chars: loaded.chars, tokens: Math.round(loaded.chars / 4), as: 'loaded', ...(loaded.at ? { at: loaded.at } : {}) }
      : { chars: bytes, tokens: Math.round(bytes / 4), as: 'disk' },
    bytes,
    mtime,
    ...judge,
    ...(f.importedBy ? { importedBy: shown(f.importedBy) } : {}),
    ...(f.through ? { through: f.through } : {}),
    ...(f.movedBy ? { movedBy: f.movedBy } : {}),
    ...(f.inIndex !== undefined ? { inIndex: f.inIndex } : {}),
  }
}

function placesOf(input: InstructionsInput, scan: Scan, j: Judge): InstructionPlace[] {
  const out: InstructionPlace[] = []
  const exists = (p: string): { exists?: true } => (isFile(p) ? { exists: true } : {})
  for (const d of j.loginDirs) {
    const reach: InstructionReach = { scope: 'machine', launches: launchesReading('User') }
    out.push({ path: join(d, 'CLAUDE.md'), shape: 'file', origin: 'machine', kind: 'personal', reach, confirm: true, ...exists(join(d, 'CLAUDE.md')) })
    out.push({ path: join(d, 'rules'), shape: 'dir', origin: 'machine', kind: 'personal-rule', reach, confirm: true })
  }
  const folder = input.folder
  if (folder !== null) {
    const project: InstructionReach = { scope: 'project', launches: launchesReading('Project') }
    out.push({ path: join(folder, 'CLAUDE.md'), shape: 'file', origin: 'project', kind: 'project', reach: project, ...exists(join(folder, 'CLAUDE.md')) })
    if (!scan.homeFolder) {
      const local = join(folder, 'CLAUDE.local.md')
      let gitDir = false
      try {
        gitDir = lstatSync(join(folder, '.git')).isDirectory()
      } catch {
        gitDir = false
      }
      out.push({
        path: local,
        shape: 'file',
        origin: 'private',
        kind: 'private',
        reach: { scope: 'project', launches: launchesReading('Local') },
        ...exists(local),
        ...(gitDir ? { ignoreLine: { file: join(folder, '.git', 'info', 'exclude'), line: 'CLAUDE.local.md' } } : { ignoreElsewhere: true as const }),
      })
      out.push({ path: join(folder, '.claude', 'rules'), shape: 'dir', origin: 'project', kind: 'project-rule', reach: project })
    }
    if (j.autoDefault !== null && j.autoInside)
      out.push({ path: j.autoDefault, shape: 'dir', origin: 'auto', kind: 'auto-note', reach: { scope: 'project', launches: [...ALL_LAUNCHES] } })
  }
  // a place is offered only where it resolves inside its own root — a
  // rules folder or a file linked out of the folder (or the login dir) is no
  // place to create anything
  return out.filter((p) => {
    const at = resolvedOf(p.path)
    if (p.origin === 'machine') return j.loginReals.some((d) => inside(at, d))
    if (p.origin === 'auto') return true
    return j.folderReal !== null && inside(at, j.folderReal) && at !== j.folderReal
  })
}

/** Harness.instructions.list for Claude Code. */
export async function claudeInstructions(input: InstructionsInput): Promise<InstructionsList> {
  const scan = scanInstructions(input)
  const j = judgeOf(input, scan)
  const shown = shownOf(input.folder, input.home)
  const { byReal, all } = await recordedOf(input.transcripts)
  const rows = scan.found.map((f) => rowOf(f, j, shown, byReal.get(realOf(f.path))))
  // the files the folder's records name that the scan missed (deeper than
  // its caps, a moved file): listed, judged by where they are
  const listed = new Set(rows.map((r) => r.real))
  const aboveDirs: string[] = []
  if (input.folder !== null) for (let d = dirname(input.folder); dirname(d) !== d; d = dirname(d)) aboveDirs.push(d)
  for (const rec of all) {
    const real = realOf(rec.path)
    if (listed.has(real) || !isFile(rec.path)) continue
    listed.add(real)
    const f = foundOfRecord(rec, input.folder, j, aboveDirs)
    rows.push({ ...rowOf(f, j, shown, byReal.get(real)), fromRecord: true })
  }
  return {
    engine: 'Claude Code',
    folder: input.folder,
    rows,
    places: placesOf(input, scan, j),
    notes: scan.notes,
    ...(scan.homeFolder ? { homeFolder: true as const } : {}),
  }
}

/** Harness.instructions.read for Claude Code: a LISTED file's text. */
export async function readClaudeInstruction(input: InstructionsInput, path: string): Promise<{ row: InstructionRow; content: string }> {
  const list = await claudeInstructions(input)
  const real = realOf(resolve(path))
  const row = list.rows.find((r) => r.real === real || r.path === path)
  if (!row) throw new Error('not listed')
  const content = readText(row.real, READ_MAX_BYTES)
  if (content === null) throw new Error('file not found')
  return { row, content }
}

/** Harness.instructions.reading: one conversation's own record (spec
 *  memory-places §6) — its transcripts oldest first, each through the one
 *  reader. The session that last started or recorded is the one in force:
 *  its replay (a start with no record since keeps the record before it — the
 *  CLI writes none when nothing changed), or nothing at all when it never
 *  recorded (a fresh session that loaded no file). Paths are real paths. */
export async function claudeInstructionsReading(transcripts: readonly string[]): Promise<InstructionsThreadReading> {
  const ms = (iso: string | null): number => (iso === null ? NaN : Date.parse(iso))
  const starts: number[] = []
  let last: ReturnType<InstructionsReplay['reading']> | null = null
  for (const t of transcripts) {
    const replay = await replayOf(t)
    if (!replay) continue
    const r = replay.reading()
    for (const s of r.starts) {
      const v = ms(s)
      if (Number.isFinite(v)) starts.push(v)
    }
    if (r.state !== 'unread') last = r
  }
  const recorded = last !== null && (last.state === 'recorded' || last.state === 'unchanged')
  return {
    inForce: recorded ? [...new Set(last!.files.filter((f) => f.path !== '').map((f) => realOf(f.path)))] : [],
    nested: recorded ? last!.nested.map((n) => ({ path: realOf(n.path), at: ms(n.at) })).filter((n) => Number.isFinite(n.at)) : [],
    starts: starts.sort((a, b) => a - b),
  }
}
