// harnesses/claude-code/trash.ts — Claude Code's trash format: how a
// transcript is buried (moved, never deleted — invariant 3) and what a
// buried transcript still says about its owner.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { rename as renameFs } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { TranscriptAccumulator } from './parser.js'

// `<root>/<folder>/<id>.jsonl` (and its `<id>/` subagents dir, 1:1) →
// `<dataDir>/trash/<folder>/<id>[-n].jsonl`; returns the destination.
export async function trashTranscript(root: string, dataDir: string, folder: string, id: string): Promise<string> {
  const src = join(root, folder, id + '.jsonl')
  // Belt and suspenders: even though the server already validates the
  // params, no write path should be able to escape the session index we manage.
  if (!resolve(src).startsWith(resolve(root) + sep)) throw new Error('path outside the index')
  if (!existsSync(src)) throw new Error('session not found')
  const destDir = join(dataDir, 'trash', folder)
  mkdirSync(destDir, { recursive: true })

  // Compute shared suffix for both .jsonl and subdir (1:1 pairing)
  const suffix = firstFreeSuffix(join(destDir, id))
  const dest = join(destDir, id + suffix + '.jsonl')

  await renameFs(src, dest) // move, never rm (invariant)
  const srcSub = join(root, folder, id)
  if (existsSync(srcSub)) {
    await renameFs(srcSub, join(destDir, id + suffix))
  }
  return dest
}

function firstFreeSuffix(base: string): string {
  // Returns '' if base.jsonl and base/ are both free, '-1' if base-1.jsonl and base-1/ are both free, etc.
  if (!existsSync(base + '.jsonl') && !existsSync(base)) return ''
  for (let n = 1; ; n++) {
    if (!existsSync(`${base}-${n}.jsonl`) && !existsSync(`${base}-${n}`)) return `-${n}`
  }
}

// The newest buried copy of `<trashDir>/<folder>/<id>[-n].jsonl` — its
// transcript and its subagents dir (1:1, same suffix) — or null.
export function buriedPath(trashDir: string, folder: string, id: string): { path: string; subDir: string; mtime: number } | null {
  const dir = join(trashDir, folder)
  const re = new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-\\d+)?\\.jsonl$`)
  let newest: { path: string; subDir: string; mtime: number } | null = null
  try {
    for (const name of readdirSync(dir)) {
      if (!re.test(name)) continue
      const path = join(dir, name)
      const mtime = statSync(path).mtimeMs
      if (!newest || mtime > newest.mtime) newest = { path, subDir: path.slice(0, -'.jsonl'.length), mtime }
    }
  } catch {
    /* no such folder in the trash */
  }
  return newest
}

// The newest buried copy of `<trashDir>/<folder>/<id>[-n].jsonl` (a second
// burial of the same id is suffixed), read for what decides ownership.
// null when there is none or it cannot be read.
export function buriedFacts(trashDir: string, folder: string, id: string): { cwd: string | null; skills: string[]; resumedFrom: string | null } | null {
  let result: { cwd: string | null; skills: string[]; resumedFrom: string | null } | null = null
  const newest = buriedPath(trashDir, folder, id)
  if (newest) {
    try {
      const acc = new TranscriptAccumulator()
      acc.feedLines(readFileSync(newest.path, 'utf8').split('\n'))
      result = { cwd: acc.cwd, skills: acc.skills, resumedFrom: acc.resumedFrom }
    } catch {
      result = null
    }
  }
  return result
}
