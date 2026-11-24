#!/usr/bin/env node
// skill-releases.mjs — writes plugin/skills/releases.json: for every skill
// Silos ships, the hash of every version of it Silos has shipped — the
// whole skill DIRECTORY (server/src/skill-releases.ts treeHashOf: a skill
// that is only its SKILL.md hashes to that file's sha256), read from the git
// history of plugin/skills/<name>/ plus the working tree.
//
// Why: Silos copies its skills into an agent's folder once. A copy whose
// tree is one of these hashes was never edited by anyone, so the server may
// replace it with the current one (skill-install.ts syncSkillCopies); any
// other tree is the operator's and is left alone.
//
// The file NEVER shrinks: the result is the union with what releases.json
// already lists. A published repo has a squashed or shallow history, where
// the commits behind old hashes are gone — recomputing from git alone would
// drop them, and every install still on one of those versions would read as
// «edited» and stop following for good.
//
// Run after editing a skill:
//   node scripts/skill-releases.mjs            (this checkout)
//   node scripts/skill-releases.mjs --root <dir>
//   node scripts/skill-releases.mjs --reset    start over: ONLY the trees on
//       disk now — neither the manifest's list nor the history. For a first
//       publication, when no install older than today's trees exists; never
//       afterwards (older installs would read as «edited» and stop following).
// server/test/skill-releases.test.ts fails while the current tree is missing.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const at = process.argv.indexOf('--root')
const root = at !== -1 && process.argv[at + 1] ? process.argv[at + 1] : fileURLToPath(new URL('..', import.meta.url))
const sha = (buf) => createHash('sha256').update(buf).digest('hex')
const git = (...args) => execFileSync('git', ['-C', root, ...args], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })

// the same definition as server/src/skill-releases.ts treeHashOf
function treeHashOf(entries) {
  if (entries.length === 1 && entries[0].path === 'SKILL.md') return entries[0].hash
  return sha(
    [...entries]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((e) => `${e.path}\0${e.hash}\n`)
      .join(''),
  )
}

// a skill directory on disk (skillTreeHash)
function diskTree(dir) {
  if (!existsSync(join(dir, 'SKILL.md'))) return null
  const entries = []
  const walk = (abs, rel) => {
    for (const name of readdirSync(abs)) {
      const p = join(abs, name)
      const r = rel === '' ? name : `${rel}/${name}`
      const st = lstatSync(p)
      if (st.isDirectory()) walk(p, r)
      else if (st.isSymbolicLink()) entries.push({ path: r, hash: sha(`symlink:${readlinkSync(p)}`) })
      else if (st.isFile()) entries.push({ path: r, hash: sha(readFileSync(p)) })
    }
  }
  walk(dir, '')
  return treeHashOf(entries)
}

// the same directory as one commit holds it (git objects; mode 120000 = a link)
function commitTree(commit, prefix) {
  let listing
  try {
    listing = git('ls-tree', '-r', '-z', commit, '--', `${prefix}/`).toString()
  } catch {
    return null
  }
  const entries = []
  for (const line of listing.split('\0').filter(Boolean)) {
    const tab = line.indexOf('\t')
    const [mode, type, object] = line.slice(0, tab).split(' ')
    const path = line.slice(tab + 1).slice(prefix.length + 1)
    if (type !== 'blob') continue
    const bytes = git('cat-file', 'blob', object)
    entries.push({ path, hash: mode === '120000' ? sha(`symlink:${bytes.toString()}`) : sha(bytes) })
  }
  return entries.some((e) => e.path === 'SKILL.md') ? treeHashOf(entries) : null
}

const reset = process.argv.includes('--reset')

function history(name) {
  const hashes = new Set()
  if (reset) {
    const now = diskTree(join(root, 'plugin', 'skills', name))
    return now ? new Set([now]) : hashes
  }
  for (const prefix of [`plugin/skills/${name}`]) {
    let commits = []
    // HEAD's history only: a tree that lives on an unmerged branch or in
    // another worktree was never shipped
    try {
      commits = git('log', 'HEAD', '--format=%H', '--', `${prefix}/`).toString().split('\n').filter(Boolean)
    } catch {
      /* not a git checkout */
    }
    for (const c of commits) {
      const h = commitTree(c, prefix)
      if (h) hashes.add(h)
    }
    const now = diskTree(join(root, prefix))
    if (now) hashes.add(now)
  }
  return hashes
}

const skillsDir = join(root, 'plugin', 'skills')
const manifest = join(skillsDir, 'releases.json')
const skills = readdirSync(skillsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(skillsDir, d.name, 'SKILL.md')))
  .map((d) => d.name)

// what is already listed stays listed (never shrinks), skills that left included
let existing = {}
if (!reset)
  try {
    existing = JSON.parse(readFileSync(manifest, 'utf8'))
  } catch {
    /* first run */
  }
const out = {}
for (const [name, list] of Object.entries(existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {})) {
  if (Array.isArray(list)) out[name] = new Set(list.filter((h) => typeof h === 'string'))
}
for (const name of skills) {
  const set = out[name] ?? (out[name] = new Set())
  for (const h of history(name)) set.add(h)
}
const sorted = Object.fromEntries(
  Object.keys(out)
    .sort()
    .map((k) => [k, [...out[k]].sort()]),
)
writeFileSync(manifest, JSON.stringify(sorted, null, 2) + '\n')
console.log(
  Object.entries(sorted)
    .map(([n, h]) => `${n}: ${h.length}`)
    .join('\n'),
)
