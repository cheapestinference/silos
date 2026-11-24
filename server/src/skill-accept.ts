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
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, type Stats } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { ensureRolePluginManifest, rolePluginDir, roleSkillsDir } from './role-plugin.js'
import { sealHooks } from './seal-hooks.js'
import { NO_SKILL_MD_ERROR, SKILL_CHANGED_ERROR, SKILL_EXISTS_ERROR, SKILL_LINK_ERROR, SKILL_SLUG, SKILL_SLUG_ERROR } from './proposals.js'

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
  const root = join(proposedSkillsDir(agentStateDir), name)
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
  const name = o.name
  if (typeof name !== 'string' || !SKILL_SLUG.test(name)) return { ok: false, code: 400, error: SKILL_SLUG_ERROR }
  const proposedRoot = proposedSkillsDir(o.agentStateDir)
  const origin = join(proposedRoot, name)
  const skillsRoot = roleSkillsDir(o.agentStateDir)
  const dest = join(skillsRoot, name)
  // containment at both ends (`../commands/evil` dies here as well as at the slug)
  if (!within(proposedRoot, origin) || !within(skillsRoot, dest)) return { ok: false, code: 400, error: SKILL_SLUG_ERROR }
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
  const back = (code: 400 | 404 | 409, error: string): SkillAccept => {
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
  if (exists(dest)) return back(409, SKILL_EXISTS_ERROR(name))
  try {
    mkdirSync(skillsRoot, { recursive: true })
    if (exists(dest)) return back(409, SKILL_EXISTS_ERROR(name))
    renameSync(staged, dest)
  } catch {
    return back(409, SKILL_EXISTS_ERROR(name))
  }
  try {
    rmdirSync(box)
  } catch {
    /* nothing left to remove */
  }
  const pluginDir = rolePluginDir(o.agentStateDir)
  ensureRolePluginManifest(pluginDir, o.agentId, o.agentName)
  // Silos' own write into the plugin: the tree's seal follows
  sealHooks().pluginWritten?.(pluginDir)
  return { ok: true, skill: name, files: tree.files }
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
