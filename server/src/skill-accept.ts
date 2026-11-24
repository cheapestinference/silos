// skill-accept.ts — a proposed skill, held and moved with the owner's hands.
// An agent writes a skill in
// $SILOS_AGENT_STATE/proposed/<name>/ — outside its plugin, which nobody
// loads from — and proposes it. Silos never trusts what it signs:
//
//   propose  the name is a slug; proposed/<name> is a REAL directory (lstat,
//            never a symlink); a SKILL.md is there; the whole tree is walked
//            with lstat — any link (symlink, hard link st_nlink > 1), device
//            or fifo refuses — and its contentHash (sha-256 of the names and
//            bytes of every file) is stored with the proposal.
//   accept   MOVE first, validate WHAT WAS MOVED, then move again:
//            rename(proposed/<name> → a staging dir of Silos inside the data
//            dir) — atomic, and out of the agent's reach (territory.ts
//            denies it) — then slug, containment of origin and destination,
//            lstat of the moved dir, the tree walk, the collision and the
//            contentHash all run on the staged tree, never on files a live
//            turn could still rewrite; any failure renames the tree BACK to
//            proposed/<name> and answers its 409. Then rename(staging →
//            plugin/skills/<name>) + the plugin manifest when missing.
//
// A CHANGE to a skill a project already has is the same proposal with a
// `folder`: the agent writes the WHOLE new skill in proposed/<name>/ and
// names its own project folder. At propose the project's copy is read too
// (its hash is the `baseHash`: what the owner's diff is drawn against); the
// accept stages and validates the same way, checks the project's copy is
// still the one the diff showed, moves it to Silos' trash and puts the
// staged tree in its place. An agent never writes .claude/skills itself
// (territory.ts) — this is its door.
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, type Stats } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { foldersOf, type Member } from './project-scope.js'
import { moveDir, silosSkillNames } from './skill-states.js'
import { ensureRolePluginManifest, rolePluginDir, roleSkillsDir } from './role-plugin.js'
import { sealHooks } from './seal-hooks.js'
import {
  NO_PROJECT_SKILL_ERROR,
  NO_SKILL_MD_ERROR,
  SILOS_SKILL_ERROR,
  SKILL_BASE_CHANGED_ERROR,
  SKILL_CHANGED_ERROR,
  SKILL_EXISTS_ERROR,
  SKILL_LINK_ERROR,
  SKILL_SAME_ERROR,
  SKILL_SLUG,
  SKILL_SLUG_ERROR,
} from './proposals.js'

/** <dataDir>/skill-staging — Silos' own; fenced from every agent (territory.ts). */
export const SKILL_STAGING_DIR = 'skill-staging'

export function proposedSkillsDir(agentStateDir: string): string {
  return join(agentStateDir, 'proposed')
}

export interface SkillFile {
  path: string
  size: number
}

export type TreeReading = { ok: true; contentHash: string; files: SkillFile[] } | { ok: false; code: 400 | 404 | 409; error: string }

const within = (root: string, p: string): boolean => {
  const r = resolve(root)
  const x = resolve(p)
  return x !== r && x.startsWith(r + sep)
}

const isLink = (st: Stats): boolean => st.isSymbolicLink() || (!st.isFile() && !st.isDirectory()) || (st.isFile() && st.nlink > 1)

/** Walk `dir` with lstat: every entry a real directory or a regular file
 *  with one link; the hash covers each file's relative path, size and
 *  bytes, in name order. A link anywhere ⇒ a 409. */
export function readSkillTree(dir: string, name: string): TreeReading {
  let top: Stats
  try {
    top = lstatSync(dir)
  } catch {
    return { ok: false, code: 400, error: NO_SKILL_MD_ERROR(name) }
  }
  if (top.isSymbolicLink() || !top.isDirectory()) return { ok: false, code: 409, error: SKILL_LINK_ERROR }
  const hash = createHash('sha256')
  const files: SkillFile[] = []
  const walk = (abs: string, rel: string): boolean => {
    let names: string[]
    try {
      names = readdirSync(abs).sort()
    } catch {
      return false
    }
    for (const n of names) {
      const childAbs = join(abs, n)
      const childRel = rel ? `${rel}/${n}` : n
      let st: Stats
      try {
        st = lstatSync(childAbs)
      } catch {
        return false
      }
      if (isLink(st)) return false
      if (st.isDirectory()) {
        hash.update(`d\0${childRel}\0`)
        if (!walk(childAbs, childRel)) return false
        continue
      }
      let bytes: Buffer
      try {
        bytes = readFileSync(childAbs)
      } catch {
        return false
      }
      hash.update(`f\0${childRel}\0${bytes.length}\0`)
      hash.update(bytes)
      files.push({ path: childRel, size: bytes.length })
    }
    return true
  }
  if (!walk(dir, '')) return { ok: false, code: 409, error: SKILL_LINK_ERROR }
  if (!files.some((f) => f.path === 'SKILL.md')) return { ok: false, code: 400, error: NO_SKILL_MD_ERROR(name) }
  return { ok: true, contentHash: hash.digest('hex'), files }
}

/** At propose: the slug, then the real tree under proposed/<name>. */
export function readProposedSkill(agentStateDir: string, name: unknown): TreeReading & { name?: string } {
  if (typeof name !== 'string' || !SKILL_SLUG.test(name)) return { ok: false, code: 400, error: SKILL_SLUG_ERROR }
  const root = proposedSkillsDir(agentStateDir)
  const origin = join(root, name)
  if (!within(root, origin)) return { ok: false, code: 400, error: SKILL_SLUG_ERROR }
  return readSkillTree(origin, name)
}

/** One file of a proposed skill, for the owner's sheet (each file openable):
 *  only a regular, single-link file inside proposed/<name>; null else. */
export function readProposedFile(agentStateDir: string, name: string, rel: string, maxBytes = 256 * 1024): string | null {
  if (!SKILL_SLUG.test(name)) return null
  return readTreeFile(join(proposedSkillsDir(agentStateDir), name), rel, maxBytes)
}

/** One regular, single-link file inside the skill tree at `root`, with no
 *  link along the way; null else. */
function readTreeFile(root: string, rel: string, maxBytes = 256 * 1024): string | null {
  const abs = join(root, rel)
  if (!within(root, abs)) return null
  // every component a real directory (no link along the way)
  let cur = root
  try {
    if (isLink(lstatSync(cur)) || !lstatSync(cur).isDirectory()) return null
  } catch {
    return null
  }
  for (const part of relative(root, abs).split(sep)) {
    cur = join(cur, part)
    let st: Stats
    try {
      st = lstatSync(cur)
    } catch {
      return null
    }
    if (isLink(st)) return null
  }
  let st: Stats
  try {
    st = lstatSync(abs)
  } catch {
    return null
  }
  if (!st.isFile() || st.size > maxBytes) return null
  try {
    return readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

export type SkillAccept = { ok: true; skill: string; files: SkillFile[] } | { ok: false; code: 400 | 404 | 409; error: string }

interface Staged {
  ok: true
  name: string
  staged: string
  files: SkillFile[]
  back: (code: 400 | 404 | 409, error: string) => { ok: false; code: 400 | 404 | 409; error: string }
  done: () => void
}

/** The first half of every accept: rename proposed/<name> into Silos'
 *  staging, then validate WHAT WAS MOVED against the hash stored at propose.
 *  `back` gives the tree back to the agent; `done` drops the empty box. */
function stageProposed(o: {
  agentStateDir: string
  dataDir: string
  name: unknown
  contentHash: string | undefined
}): Staged | { ok: false; code: 400 | 404 | 409; error: string } {
  const name = o.name
  if (typeof name !== 'string' || !SKILL_SLUG.test(name)) return { ok: false, code: 400, error: SKILL_SLUG_ERROR }
  const proposedRoot = proposedSkillsDir(o.agentStateDir)
  const origin = join(proposedRoot, name)
  if (!within(proposedRoot, origin)) return { ok: false, code: 400, error: SKILL_SLUG_ERROR }
  let st: Stats
  try {
    st = lstatSync(origin)
  } catch {
    return { ok: false, code: 409, error: NO_SKILL_MD_ERROR(name) }
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, code: 409, error: SKILL_LINK_ERROR }
  const stagingRoot = join(o.dataDir, SKILL_STAGING_DIR)
  mkdirSync(stagingRoot, { recursive: true, mode: 0o700 })
  const box = join(stagingRoot, randomUUID())
  mkdirSync(box, { mode: 0o700 })
  const staged = join(box, name)
  try {
    renameSync(origin, staged)
  } catch {
    try {
      rmdirSync(box)
    } catch {
      /* left empty */
    }
    return { ok: false, code: 409, error: SKILL_CHANGED_ERROR }
  }
  const back: Staged['back'] = (code, error) => {
    putBack(staged, origin, proposedRoot, name)
    try {
      rmdirSync(box)
    } catch {
      /* not empty: the tree stays there */
    }
    return { ok: false, code, error }
  }
  // every check on WHAT WAS MOVED
  const tree = readSkillTree(staged, name)
  // a SKILL.md gone since the propose is a change like any other
  if (!tree.ok) return back(409, tree.code === 409 ? tree.error : SKILL_CHANGED_ERROR)
  if (!o.contentHash || tree.contentHash !== o.contentHash) return back(409, SKILL_CHANGED_ERROR)
  return {
    ok: true,
    name,
    staged,
    files: tree.files,
    back,
    done: () => {
      try {
        rmdirSync(box)
      } catch {
        /* nothing left to remove */
      }
    },
  }
}

/** The accept: move-validate-move. `contentHash` is the one stored at
 *  propose. Never throws for what the agent controls. */
export function acceptProposedSkill(o: {
  agentStateDir: string
  dataDir: string
  agentId: string
  agentName?: string
  name: unknown
  contentHash: string | undefined
}): SkillAccept {
  const s = stageProposed(o)
  if (!s.ok) return s
  const skillsRoot = roleSkillsDir(o.agentStateDir)
  const dest = join(skillsRoot, s.name)
  // containment at the destination too (`../commands/evil` dies at the slug as well)
  if (!within(skillsRoot, dest)) return s.back(400, SKILL_SLUG_ERROR)
  if (exists(dest)) return s.back(409, SKILL_EXISTS_ERROR(s.name))
  try {
    mkdirSync(skillsRoot, { recursive: true })
    if (exists(dest)) return s.back(409, SKILL_EXISTS_ERROR(s.name))
    renameSync(s.staged, dest)
  } catch {
    return s.back(409, SKILL_EXISTS_ERROR(s.name))
  }
  s.done()
  const pluginDir = rolePluginDir(o.agentStateDir)
  ensureRolePluginManifest(pluginDir, o.agentId, o.agentName)
  // Silos' own write into the plugin: the tree's seal follows
  sealHooks().pluginWritten?.(pluginDir)
  return { ok: true, skill: s.name, files: s.files }
}

// ---- a change to a project's skill -------------------------------------------

/** <folder>/.claude/skills/<name> — where a project's own skill lives. */
export function projectSkillDir(folder: string, name: string): string {
  return join(folder, '.claude', 'skills', name)
}

const stripSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') || '/' : p)

/** The folder a change names: exactly one of the proposer's own declared
 *  folders (never a path inside one, never another project's). */
export function ownSkillFolder(agent: Pick<Member, 'folder' | 'folders'> | null | undefined, folder: unknown): string | null {
  if (!agent || typeof folder !== 'string' || !folder.startsWith('/')) return null
  const f = stripSlash(folder)
  return foldersOf(agent).includes(f) ? f : null
}

export type ChangeReading = { ok: true; contentHash: string; baseHash: string; files: SkillFile[] } | { ok: false; code: 400 | 404 | 409; error: string }

/** At propose, for a change: the proposed tree AND the project's copy it
 *  replaces. Silos' own skills are never changed in a project (their copies
 *  follow Silos: skill-install.ts would write over the change). */
export function readSkillChange(agentStateDir: string, name: unknown, folder: string, silosSkills: readonly string[] = silosSkillNames()): ChangeReading {
  const proposed = readProposedSkill(agentStateDir, name)
  if (!proposed.ok) return proposed
  const n = name as string
  if (silosSkills.includes(n)) return { ok: false, code: 400, error: SILOS_SKILL_ERROR(n) }
  const base = readSkillTree(projectSkillDir(folder, n), n)
  if (!base.ok) return { ok: false, code: base.code === 409 ? 409 : 404, error: base.code === 409 ? base.error : NO_PROJECT_SKILL_ERROR(n) }
  if (base.contentHash === proposed.contentHash) return { ok: false, code: 400, error: SKILL_SAME_ERROR(n) }
  return { ok: true, contentHash: proposed.contentHash, baseHash: base.contentHash, files: proposed.files }
}

export interface ChangedFile extends SkillFile {
  change: 'new' | 'changed' | 'same'
}

const bytesOf = (root: string, rel: string): Buffer | null => {
  try {
    return readFileSync(join(root, rel))
  } catch {
    return null
  }
}

/** The owner's sheet for a change: every file that would load, marked
 *  against the project's copy, and the files the change removes. Null when
 *  either tree can't be read. */
export function skillChangeFiles(agentStateDir: string, name: string, folder: string): { files: ChangedFile[]; removed: string[] } | null {
  if (!SKILL_SLUG.test(name)) return null
  const next = join(proposedSkillsDir(agentStateDir), name)
  const prev = projectSkillDir(folder, name)
  const a = readSkillTree(next, name)
  const b = readSkillTree(prev, name)
  if (!a.ok || !b.ok) return null
  const before = new Set(b.files.map((f) => f.path))
  const files = a.files.map((f): ChangedFile => {
    if (!before.has(f.path)) return { ...f, change: 'new' }
    const x = bytesOf(next, f.path)
    const y = bytesOf(prev, f.path)
    return { ...f, change: x !== null && y !== null && x.equals(y) ? 'same' : 'changed' }
  })
  const now = new Set(a.files.map((f) => f.path))
  return { files, removed: b.files.map((f) => f.path).filter((p) => !now.has(p)) }
}

export type DiffLine = [' ' | '+' | '-', string]
const DIFF_MAX_LINES = 2000

/** A line diff (longest common subsequence) — what changed, in order. Null
 *  past DIFF_MAX_LINES on either side: the sheet then shows the new text. */
export function lineDiff(before: string, after: string): DiffLine[] | null {
  const a = before.split('\n')
  const b = after.split('\n')
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) return null
  const w = b.length + 1
  const t = new Uint32Array((a.length + 1) * w)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push([' ', a[i]!])
      i++
      j++
    } else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) out.push(['-', a[i++]!])
    else out.push(['+', b[j++]!])
  }
  while (i < a.length) out.push(['-', a[i++]!])
  while (j < b.length) out.push(['+', b[j++]!])
  return out
}

/** One file of a change, for the sheet: its new text (null when the change
 *  removes it) and, when the project has it, the diff against that copy. */
export function readChangeFile(agentStateDir: string, name: string, folder: string, rel: string): { text: string | null; diff?: DiffLine[] } | null {
  const text = readProposedFile(agentStateDir, name, rel)
  const before = readTreeFile(projectSkillDir(folder, name), rel)
  if (text === null && before === null) return null
  if (before === null || text === before) return { text }
  if (text === null) return { text, diff: before.split('\n').map((l): DiffLine => ['-', l]) }
  const diff = lineDiff(before, text)
  return { text, ...(diff ? { diff } : {}) }
}

/** The accept of a change: stage and validate the proposed tree, check the
 *  project's copy is still the one the owner's diff was drawn against, move
 *  it to Silos' trash and put the staged tree in its place. A failure at any
 *  point leaves the project's skill as it was and the tree back in proposed/. */
export function acceptSkillChange(o: {
  agentStateDir: string
  dataDir: string
  name: unknown
  folder: string
  contentHash: string | undefined
  baseHash: string | undefined
}): SkillAccept {
  const s = stageProposed(o)
  if (!s.ok) return s
  const dest = projectSkillDir(o.folder, s.name)
  const base = readSkillTree(dest, s.name)
  if (!base.ok || !o.baseHash || base.contentHash !== o.baseHash) return s.back(409, SKILL_BASE_CHANGED_ERROR)
  const trash = join(o.dataDir, 'trash', 'skills')
  const old = join(trash, `${s.name}-${Date.now()}-${randomUUID().slice(0, 8)}`)
  try {
    mkdirSync(trash, { recursive: true, mode: 0o700 })
    moveDir(dest, old)
  } catch {
    return s.back(409, SKILL_BASE_CHANGED_ERROR)
  }
  try {
    moveDir(s.staged, dest)
  } catch {
    // the project's skill goes back where it was
    try {
      moveDir(old, dest)
    } catch {
      /* it stays in the trash, whole */
    }
    return s.back(409, SKILL_BASE_CHANGED_ERROR)
  }
  s.done()
  return { ok: true, skill: s.name, files: s.files }
}

function exists(p: string): boolean {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

// A failed accept gives the tree back to the agent at proposed/<name>. If a
// live turn recreated that name meanwhile, it lands beside it instead
// (proposed/<name>.returned-<n>) — never over what the agent wrote since.
function putBack(staged: string, origin: string, proposedRoot: string, name: string): void {
  try {
    mkdirSync(proposedRoot, { recursive: true })
  } catch {
    /* the rename says */
  }
  if (!exists(origin)) {
    try {
      renameSync(staged, origin)
      return
    } catch {
      /* fall through */
    }
  }
  for (let n = 1; n < 100; n++) {
    const alt = join(proposedRoot, `${name}.returned-${n}`)
    if (exists(alt)) continue
    try {
      renameSync(staged, alt)
      return
    } catch {
      /* next */
    }
  }
}
