// Memories panel: Claude Code's memory layers as they always were — global
// (~/.claude/CLAUDE.md), project (<folder>/CLAUDE.md), auto memory
// (<projects root>/<folder key>/memory/*.md), the agent's own — and, since
// spec memory-places T2, EVERY instruction file a conversation in the folder
// loads (`rows`, asked of the engines through folder-instructions.ts) with
// its origin, reach, when and weight.
//
// A contract/security boundary (T3): a write is allowed only on a file the
// server ITSELF lists — never by its name under a folder. The request's
// resolved path (links resolved) must be an editable row of the engine's
// list for that folder or for the machine's logins, or a new file at one of
// the list's fixed places (a file, or one plain `<name>.md` in a place's
// directory), or the agent's own memory. A machine file needs the owner's
// `confirmed: true`. Backup BEFORE writing (keyed by the file's path relative
// to its root), atomic write; the ignore line only when the create asks and
// the engine offers it (`<folder>/.git` a directory). Owner only (the route's
// guard: agent-authz never lets a bearer write here).
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, copyFileSync, realpathSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { mungePath, type AgentRegistry } from './agent-registry.js'
import { territoriesOf } from './territory.js'
import { folderInstructions, mergedRows, type EngineInstructionRow, type EngineInstructions, type FolderInstructionsDeps } from './folder-instructions.js'
import type { InstructionPlace, InstructionRow } from './harnesses/contract.js'

// Which of the 4 layers an entry belongs to — stamped on every entry list()
// returns, so a consumer that flattens the layers still knows each file's
// origin.
export type MemoryScope = 'global' | 'project' | 'auto' | 'agent'

export interface MemoryFileInfo {
  name: string
  path: string
  scope: MemoryScope
  description?: string
  type?: string
  mtime: number
  exists: boolean
  /** bytes on disk — what this file weighs if it is loaded */
  size?: number
  /** auto notes: the conversation that wrote it (frontmatter metadata.originSessionId) */
  origin?: string
  /** auto notes: whether MEMORY.md links it — the index is what every
   *  conversation loads; a note outside it is found only by searching */
  inIndex?: boolean
  /** the index itself: how many lines it has (Claude Code loads the first 200) */
  lines?: number
  /** auto notes: when the note says it was last written (metadata.modified),
   *  epoch ms — steadier than mtime, which any tool touching the file moves */
  writtenAt?: number
  /** auto notes: the agent whose conversation wrote it (set by the route) */
  author?: string
}

/** One instruction file as Memory answers it (spec memory-places §3: the
 *  server supplies origin, reach, when and weight; the web says them). */
export type MemoryRow = InstructionRow & { engine: string | null }

/** A place a new file may be created at, its engine named. */
export type MemoryPlace = InstructionPlace & { engine: string | null }

export interface MemoryLayers {
  global: MemoryFileInfo
  project: MemoryFileInfo | null
  autoMemory: MemoryFileInfo[]
  // "Agent memory" layer — present only when list() is called with an
  // agentId. Distinct from autoMemory (Claude Code's own auto-memory, per
  // FOLDER): this is the AGENT's own memory, built by Silos (see
  // agentMemoryPath).
  agent: MemoryFileInfo | null
  /** every instruction file, in the engine's load order, the agent's own last */
  rows?: MemoryRow[]
  /** where a new file may be created (T3's fixed places) */
  places?: MemoryPlace[]
  /** the folder's own engine-config dir is a login's: only its top file is the project's */
  homeFolder?: true
  /** the agent's other folders: their instruction files do not load */
  alsoWorksIn?: string[]
  /** the engines' one-liners (caps reached …) */
  notes?: string[]
}

/** A write or read the boundary refuses: 400 not listed / not allowed, 409 read-only or unconfirmed. */
export class MemoryRefusal extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409,
  ) {
    super(message)
  }
}

export interface MemoryWriteOpts {
  /** the folder the page shows (else every active folder the path may belong to is asked) */
  folder?: string
  /** the machine's files: the owner confirmed (Save says its reach) */
  confirmed?: boolean
  /** a create of the private file: add the engine's ignore line too */
  ignoreLine?: boolean
}

export interface MemoryServiceOpts {
  /** what the engines' lists are read with (production: home, every login,
   *  the managed dir, the index); absent: the machine's login dir alone,
   *  home its parent, no transcript read */
  instructions?: Omit<FolderInstructionsDeps, 'registry' | 'projectsRoot' | 'loginDirs'> & { loginDirs?: () => string[] }
}

// Path to an agent's own memory file — a pure function (no instance
// dependency) so ChatService can build the same path without needing a
// full MemoryService.
export function agentMemoryPath(dataDir: string, agentId: string): string {
  return join(dataDir, 'agents', agentId, 'memory.md')
}

// Internal classification of an already-resolved (realpath) path against
// the 4 permitted roots — reused by both read/write validation and the
// backup segment computation.
type Kind = { type: MemoryScope; segment: string; rel?: string }

const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]*\.md$/
const realOr = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}
const insideDir = (p: string, dir: string): boolean => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep)
const EVERY_LAUNCH: InstructionRow['reach']['launches'] = ['console', 'chat', 'wake', 'run', 'run-inherits', 'run-no-folder']

export class MemoryService {
  private claudeDir: string

  constructor(
    private root: string,
    private dataDir: string,
    private registry: AgentRegistry,
    private opts: MemoryServiceOpts = {},
  ) {
    // root is <home>/.claude/projects (or its test override) → the parent
    // is <home>/.claude, where the global CLAUDE.md lives.
    this.claudeDir = dirname(root)
  }

  /** What the engines are asked with: the machine's login dir is the one
   *  holding `root` (as the global layer always was), then each extra login's. */
  instructionsDeps(): FolderInstructionsDeps {
    const o = this.opts.instructions
    const own = realOr(this.claudeDir)
    const extra = (o?.loginDirs?.() ?? []).filter((d) => realOr(d) !== own)
    return {
      registry: this.registry,
      ...(o?.index ? { index: o.index } : {}),
      home: o?.home ?? dirname(this.claudeDir),
      loginDirs: () => [this.claudeDir, ...extra],
      projectsRoot: this.root,
      ...(o?.managedDir ? { managedDir: o.managedDir } : {}),
    }
  }

  private globalPath(): string {
    return join(this.claudeDir, 'CLAUDE.md')
  }

  private describe(path: string, scope: MemoryScope): MemoryFileInfo {
    try {
      const st = statSync(path)
      return { name: basename(path), path, scope, mtime: st.mtimeMs, exists: true, size: st.size }
    } catch {
      return { name: basename(path), path, scope, mtime: 0, exists: false }
    }
  }

  private async describeAuto(dir: string): Promise<MemoryFileInfo[]> {
    let entries: string[]
    try {
      entries = (await readdir(dir)).filter((f) => f.endsWith('.md'))
    } catch {
      return [] // no memory dir yet → an empty layer, not an error
    }
    const out: MemoryFileInfo[] = []
    // the index's links, read once: `[title](file.md)` — a note it names is
    // in front of every conversation; one it doesn't is found only by search
    let indexText: string | null = null
    if (entries.includes('MEMORY.md')) {
      try {
        indexText = readFileSync(join(dir, 'MEMORY.md'), 'utf8')
      } catch {
        indexText = null
      }
    }
    const linked = new Set<string>()
    if (indexText !== null) {
      for (const m of indexText.matchAll(/\]\(([^)\s]+\.md)\)/g)) linked.add(basename(m[1]!))
    }
    for (const f of entries) {
      const p = join(dir, f)
      let st
      try {
        st = await stat(p)
      } catch {
        continue
      }
      if (f === 'MEMORY.md') {
        const lines = indexText === null ? undefined : indexText.split('\n').length - (indexText.endsWith('\n') ? 1 : 0)
        out.push({
          name: 'MEMORY',
          path: p,
          scope: 'auto',
          description: 'Automatic memory index',
          type: 'index',
          mtime: st.mtimeMs,
          exists: true,
          size: st.size,
          ...(lines !== undefined ? { lines } : {}),
        })
        continue
      }
      const fm = this.parseFrontmatter(p)
      out.push({
        name: fm.name ?? f.replace(/\.md$/, ''),
        path: p,
        scope: 'auto',
        description: fm.description,
        type: fm.type,
        mtime: st.mtimeMs,
        exists: true,
        size: st.size,
        ...(fm.originSessionId ? { origin: fm.originSessionId } : {}),
        ...(fm.modified && Number.isFinite(Date.parse(fm.modified)) ? { writtenAt: Date.parse(fm.modified) } : {}),
        ...(indexText !== null ? { inIndex: linked.has(f) } : {}),
      })
    }
    out.sort((a, b) => b.mtime - a.mtime)
    return out
  }

  // Cheap YAML frontmatter parsing (name/description/type only, no
  // dependency on a full YAML parser — memory cards are simple and this
  // panel only needs those three fields).
  private parseFrontmatter(path: string): { name?: string; description?: string; type?: string; originSessionId?: string; modified?: string } {
    try {
      return this.parseFrontmatterText(readFileSync(path, 'utf8'))
    } catch {
      return {}
    }
  }

  // name/description at the top level; type and originSessionId either at
  // the top level or nested one level under `metadata:` (the shape Claude
  // Code's auto memory writes today). A top-level key wins over a nested one.
  private parseFrontmatterText(text: string): { name?: string; description?: string; type?: string; originSessionId?: string; modified?: string } {
    const m = text.slice(0, 4000).match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!m) return {}
    const out: Record<string, string> = {}
    const nested: Record<string, string> = {}
    let inMetadata = false
    for (const line of m[1]!.split(/\r?\n/)) {
      const top = line.match(/^(name|description|type|originSessionId|modified):\s*(.*)$/)
      if (top) {
        out[top[1] as string] = (top[2] ?? '').trim().replace(/^["']|["']$/g, '')
        inMetadata = false
        continue
      }
      if (/^metadata:\s*$/.test(line)) {
        inMetadata = true
        continue
      }
      if (/^\S/.test(line)) {
        inMetadata = false
        continue
      }
      const sub = inMetadata ? line.match(/^\s+(type|originSessionId|modified):\s*(.*)$/) : null
      if (sub) nested[sub[1] as string] = (sub[2] ?? '').trim().replace(/^["']|["']$/g, '')
    }
    return { ...nested, ...out }
  }

  // Lists the layers. folder is agent.folder (an absolute path) as it
  // lives in agents.json — omitted to skip project/autoMemory. agentId
  // additionally requests that agent's "Agent memory" layer — it must be a
  // registered, ACTIVE agent (archived = out of play, same as classify()).
  async list(folder?: string, agentId?: string): Promise<MemoryLayers> {
    const global = this.describe(this.globalPath(), 'global')
    let project: MemoryFileInfo | null = null
    let autoMemory: MemoryFileInfo[] = []
    if (folder !== undefined) {
      // any folder an agent works in — its primary folder or a declared
      // territory (folders[]): the project page reads THAT folder's memory,
      // never a member agent's primary folder instead
      const agent = this.registry.list(true).find((a) => territoriesOf(a).includes(folder))
      if (!agent) throw new Error('folder not recognized')
      project = this.describe(join(folder, 'CLAUDE.md'), 'project')
      const memDir = join(this.root, mungePath(folder), 'memory')
      autoMemory = await this.describeAuto(memDir)
    }
    let agentLayer: MemoryFileInfo | null = null
    let alsoWorksIn: string[] = []
    if (agentId !== undefined) {
      const a = this.registry.list(false).find((x) => x.id === agentId)
      if (!a) throw new Error('agent not recognized')
      agentLayer = { ...this.describe(agentMemoryPath(this.dataDir, agentId), 'agent'), name: 'Agent memory' }
      // Claude Code reads instruction files from the folder a conversation
      // starts in: the agent's other folders load none — said, never listed
      const starts = folder ?? a.folder
      alsoWorksIn = territoriesOf(a).filter((f) => f !== starts)
    }
    const engines = await folderInstructions(this.instructionsDeps(), folder ?? null)
    const rows: MemoryRow[] = mergedRows(engines)
    const places: MemoryPlace[] = engines.flatMap((e) => e.list.places.map((p) => ({ ...p, engine: e.id })))
    if (agentLayer) {
      rows.push(this.agentRow(agentLayer))
      places.push({
        path: agentLayer.path,
        shape: 'file',
        origin: 'agent',
        kind: 'agent',
        reach: { scope: 'agent', launches: EVERY_LAUNCH },
        ...(agentLayer.exists ? { exists: true as const } : {}),
        engine: null,
      })
    }
    const notes = engines.flatMap((e) => e.list.notes)
    return {
      global,
      project,
      autoMemory,
      agent: agentLayer,
      rows,
      places,
      ...(engines.some((e) => e.list.homeFolder) ? { homeFolder: true as const } : {}),
      ...(alsoWorksIn.length > 0 ? { alsoWorksIn } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    }
  }

  /** The agent's own memory as a row: Silos appends it to every conversation it starts for the agent. */
  private agentRow(info: MemoryFileInfo): MemoryRow {
    const bytes = info.size ?? 0
    return {
      path: info.path,
      real: realOr(info.path),
      rel: 'memory.md',
      origin: 'agent',
      kind: 'agent',
      engineType: null,
      engine: null,
      reach: { scope: 'agent', launches: EVERY_LAUNCH },
      when: { at: 'start' },
      weight: { chars: bytes, tokens: Math.round(bytes / 4), as: 'disk' },
      bytes,
      mtime: info.mtime,
      editable: true,
    }
  }

  /** A file's text: one of the four layers, or a row the engines list for
   *  `folder` (absent: every folder the path may belong to, and the
   *  machine's logins). Anything else is refused. */
  async read(rawPath: string, folder?: string): Promise<string> {
    if (typeof rawPath !== 'string' || rawPath.trim() === '') throw new MemoryRefusal('memory path not allowed', 400)
    const real = this.resolveExistingOrSuffix(resolve(rawPath))
    if (!this.classify(real)) {
      const found = await this.listed(real, folder, false, resolve(rawPath))
      if (!found?.row || found.row.linkOut) throw new MemoryRefusal('memory path not allowed', 400)
    }
    if (!existsSync(real)) throw new Error('file not found')
    return readFileSync(real, 'utf8')
  }

  async write(rawPath: string, content: string, opts: MemoryWriteOpts = {}): Promise<{ backup: string | null; ignored?: boolean }> {
    if (typeof rawPath !== 'string' || rawPath.trim() === '') throw new MemoryRefusal('memory path not allowed', 400)
    const real = this.resolveExistingOrSuffix(resolve(rawPath))
    const judged = await this.judgeWrite(real, opts, resolve(rawPath))
    const kind = judged.kind

    const isNew = !existsSync(real)
    let backup: string | null = null
    if (!isNew) {
      backup = this.backupBeforeWrite(real, kind)
    }

    this.atomicWrite(real, content)
    // "needs indexing" = MEMORY.md does not link it yet (appendIndexLine's
    // guard), NOT "the note is new": the note lands before the index, so a
    // failed index write followed by a retry (the note now exists) must
    // still index it
    if (kind.type === 'auto' && basename(real) !== 'MEMORY.md') {
      this.appendIndexLine(real, content, kind)
    }
    // the ignore line: only on a create that asks, only where the engine offers it
    let ignored: boolean | undefined
    if (isNew && opts.ignoreLine === true) ignored = judged.ignoreLine ? this.addIgnoreLine(judged.ignoreLine) : false
    return { backup, ...(ignored !== undefined ? { ignored } : {}) }
  }

  /** The folders a path may belong to: the one asked (it must be an agent's
   *  — an ACTIVE one's for a write), else every such folder holding it or
   *  its auto memory (by its real path, or the path as asked: a link out
   *  of a folder is judged as that folder's row — read-only). */
  private candidateFolders(paths: string[], folder: string | undefined, activeOnly: boolean): string[] {
    const territories = [...new Set(this.registry.list(!activeOnly).flatMap((a) => territoriesOf(a)))]
    if (folder !== undefined) {
      if (!territories.includes(folder)) throw new MemoryRefusal('folder not recognized', 400)
      return [folder]
    }
    const rootReal = realOr(this.root)
    return territories.filter((f) => paths.some((p) => insideDir(p, realOr(f)) || insideDir(p, f) || insideDir(p, join(rootReal, mungePath(f)))))
  }

  /** The engines' row for `real` — or the place a new file at `real` would
   *  take — in the folders it may belong to, then the machine's own list. */
  private async listed(
    real: string,
    folder: string | undefined,
    activeOnly: boolean,
    asked: string = real,
  ): Promise<{ row?: EngineInstructionRow; place?: MemoryPlace; folder: string | null } | null> {
    const deps = this.instructionsDeps()
    const contexts: (string | null)[] = [...this.candidateFolders([real, asked], folder, activeOnly), null]
    const isNew = !existsSync(real)
    for (const ctx of contexts) {
      const engines: EngineInstructions[] = await folderInstructions(deps, ctx, { activeOnly })
      const row = mergedRows(engines).find((r) => r.real === real)
      if (row) return { row, folder: ctx }
      if (!isNew) continue
      for (const e of engines) {
        for (const p of e.list.places) {
          const pReal = this.resolveExistingOrSuffix(resolve(p.path))
          const fits = p.shape === 'file' ? pReal === real : dirname(real) === pReal && PLAIN_NAME.test(basename(real))
          if (fits) return { place: { ...p, engine: e.id }, folder: ctx }
        }
      }
    }
    return null
  }

  /** The write boundary: the root the file is backed up under, or a refusal. */
  private async judgeWrite(real: string, opts: MemoryWriteOpts, asked: string): Promise<{ kind: Kind; ignoreLine?: { file: string; line: string } }> {
    // the agent's own memory: Silos', ACTIVE agents only
    for (const a of this.registry.list(false)) {
      if (real === this.safeRealpath(agentMemoryPath(this.dataDir, a.id))) return { kind: { type: 'agent', segment: a.id } }
    }
    const found = await this.listed(real, opts.folder, true, asked)
    if (!found) throw new MemoryRefusal('memory path not allowed', 400)
    const entry = found.row ?? found.place!
    if (found.row && !found.row.editable) throw new MemoryRefusal(`read-only: ${found.row.readOnly ?? 'Silos does not write this file'}`, 409)
    if (entry.confirm && opts.confirmed !== true)
      throw new MemoryRefusal('confirm: this file reaches every project on this machine — send confirmed: true', 409)
    const kind = this.rootOf(real, entry.origin, found.folder)
    if (!kind) throw new MemoryRefusal('memory path not allowed', 400)
    return { kind, ...(found.place?.ignoreLine ? { ignoreLine: found.place.ignoreLine } : {}) }
  }

  /** The root a written file is backed up under: its segment, and its path relative to it. */
  private rootOf(real: string, origin: InstructionRow['origin'], folder: string | null): Kind | null {
    if (origin === 'machine') {
      const own = realOr(this.claudeDir)
      for (const d of this.instructionsDeps().loginDirs()) {
        const dReal = realOr(d)
        if (!insideDir(real, dReal)) continue
        return { type: 'global', segment: dReal === own ? 'global' : `login-${mungePath(dReal)}`, rel: relative(dReal, real) }
      }
      return null
    }
    // auto memory: only directly in <projects root>/<folder key>/memory, never through a link out
    if (origin === 'auto') {
      const memDir = dirname(real)
      if (dirname(dirname(memDir)) !== realOr(this.root) || basename(memDir) !== 'memory') return null
      return { type: 'auto', segment: basename(dirname(memDir)), rel: basename(real) }
    }
    if (folder === null) return null
    const fReal = realOr(folder)
    if (!insideDir(real, fReal) || real === fReal) return null
    return { type: 'project', segment: mungePath(fReal), rel: relative(fReal, real) }
  }

  /** Appends the engine's ignore line once (git's own local, unversioned exclude file). */
  private addIgnoreLine(ignore: { file: string; line: string }): boolean {
    try {
      const current = existsSync(ignore.file) ? readFileSync(ignore.file, 'utf8') : ''
      if (current.split('\n').some((l) => l.trim() === ignore.line)) return true
      mkdirSync(dirname(ignore.file), { recursive: true })
      appendFileSync(ignore.file, `${current === '' || current.endsWith('\n') ? '' : '\n'}${ignore.line}\n`)
      return true
    } catch {
      return false
    }
  }

  private atomicWrite(real: string, content: string): void {
    mkdirSync(dirname(real), { recursive: true })
    const tmp = join(dirname(real), `.${basename(real)}.tmp-${randomBytes(4).toString('hex')}`)
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, real) // atomic: the original is never left half-written
  }

  // An auto-memory note not yet linked gets its line in the sibling MEMORY.md index
  // (created if missing) — read-modify-write with the same backup + atomic
  // write as any other memory write. Line format:
  // `- [<name>](<basename>) — <description>`; without frontmatter the name
  // falls back to the basename and the dash + description are omitted.
  private appendIndexLine(notePath: string, content: string, kind: Kind): void {
    const file = basename(notePath)
    const fm = this.parseFrontmatterText(content)
    const line = `- [${fm.name || file}](${file})${fm.description ? ` — ${fm.description}` : ''}`
    const idx = join(dirname(notePath), 'MEMORY.md')
    let current = ''
    if (existsSync(idx)) {
      current = readFileSync(idx, 'utf8')
      if (current.includes(`](${file})`)) return // already indexed (e.g. a note recreated after deletion)
      this.backupBeforeWrite(idx, kind)
    }
    const glue = current === '' || current.endsWith('\n') ? '' : '\n'
    this.atomicWrite(idx, `${current}${glue}${line}\n`)
  }

  // Backup BEFORE writing — a read-only invariant over foreign data. Never
  // overwrites an existing backup: if the (ms) timestamp collides, adds a
  // numeric suffix like firstFreeSuffix in harnesses/claude-code/trash.ts (trashTranscript).
  private backupBeforeWrite(real: string, kind: Kind): string {
    // keyed by the file's path relative to its root: CLAUDE.md,
    // .claude/CLAUDE.md and sub/CLAUDE.md never share a backup folder
    const relDir = kind.rel ? dirname(kind.rel) : '.'
    const dir = relDir === '.' ? join(this.dataDir, 'memory-backups', kind.segment) : join(this.dataDir, 'memory-backups', kind.segment, ...relDir.split(sep))
    mkdirSync(dir, { recursive: true })
    const base = basename(real)
    const stamp = new Date().toISOString().replace(/:/g, '-')
    let dest = join(dir, `${base}.${stamp}.md`)
    let n = 1
    while (existsSync(dest)) {
      dest = join(dir, `${base}.${stamp}-${n}.md`)
      n += 1
    }
    copyFileSync(real, dest)
    return dest
  }

  // Unlike an earlier single-level fallback (just dirname), this version
  // climbs recursively until it finds the deepest ancestor that ALREADY
  // EXISTS, resolves ITS realpath (symlinks included), and rebuilds the
  // rest of the requested path on top — needed because an agent's memory
  // might not even have its own directory (dataDir/agents/<id>/) created
  // yet on the first save.
  private resolveExistingOrSuffix(abs: string): string {
    try {
      return realpathSync(abs)
    } catch {
      const parent = dirname(abs)
      if (parent === abs) throw new Error('memory path not allowed') // reached the fs root without finding anything
      return join(this.resolveExistingOrSuffix(parent), basename(abs))
    }
  }

  // The four layers as they always were — what a READ may open without the
  // engines' lists (a write is judged by judgeWrite alone).
  private classify(real: string): Kind | null {
    if (real === this.safeRealpath(this.globalPath())) return { type: 'global', segment: 'global' }
    // ACTIVE agents only: archived = out of play; neither their CLAUDE.md
    // nor their memory.md are editable from here (same criterion extended
    // to agent memory).
    for (const a of this.registry.list(false)) {
      for (const f of territoriesOf(a)) {
        const folderReal = this.safeRealpath(f)
        if (real === join(folderReal, 'CLAUDE.md')) return { type: 'project', segment: mungePath(folderReal) }
      }
      if (real === this.safeRealpath(agentMemoryPath(this.dataDir, a.id))) return { type: 'agent', segment: a.id }
    }
    const rootReal = this.safeRealpath(this.root)
    if ((real === rootReal || real.startsWith(rootReal + sep)) && real.endsWith('.md')) {
      const rel = relative(rootReal, real)
      const parts = rel.split(sep)
      if (parts.length === 3 && parts[1] === 'memory' && parts[0] !== '' && !/^\.+$/.test(parts[0] as string)) {
        return { type: 'auto', segment: parts[0] as string }
      }
    }
    return null
  }

  private safeRealpath(p: string): string {
    try {
      return realpathSync(p)
    } catch {
      return resolve(p) // may not exist yet (a new agent folder, a freshly created root) — a best-effort comparison
    }
  }
}
