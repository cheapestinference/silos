import { existsSync, writeFileSync, renameSync } from 'node:fs'
import { basename } from 'node:path'
import { sealHooks } from './seal-hooks.js'

// Shared JSON-store primitives. Before this, ~13 stores hand-rolled the same
// tmp+rename atomic write and 7 carried a byte-identical corrupt-backup method
// (a fix to either had to be made in every copy). One implementation here.

// Atomic write: write a tmp file then rename over the target (rename is atomic
// on the same filesystem, so a crash mid-write never leaves a truncated file).
// `mode` applies only on creation of the tmp file — callers that must guarantee
// perms on an existing file still chmod separately.
// A file under a restore seal (seals.ts) is written BY
// the seal, in its contract order (copy → file → cache); any other file as
// always.
export function atomicWriteJson(file: string, data: unknown, opts?: { mode?: number }): void {
  const text = JSON.stringify(data, null, 2) + '\n'
  if (sealHooks().write?.(file, text, opts?.mode)) return
  const tmp = file + '.tmp'
  writeFileSync(tmp, text, opts?.mode !== undefined ? { mode: opts.mode } : undefined)
  renameSync(tmp, file)
}

// Preserve a corrupt file before it's replaced: copy its raw text to a
// timestamped, collision-proof `<file>.corrupt-<stamp>` sidecar (never
// overwrites a prior backup). `label` names the store in the warnings; pass
// `mode: 0o600` when the file (and therefore its backup) can hold secrets.
export function backupCorruptJson(file: string, text: string, label: string, opts?: { mode?: number }): void {
  const stamp = new Date().toISOString().replace(/:/g, '-')
  let dest = `${file}.corrupt-${stamp}`
  let n = 1
  while (existsSync(dest)) {
    dest = `${file}.corrupt-${stamp}-${n}`
    n += 1
  }
  try {
    writeFileSync(dest, text, opts?.mode !== undefined ? { mode: opts.mode } : undefined)
    console.warn(`${label}: corrupt ${basename(file)} — copy saved at ${dest}`)
  } catch (err) {
    console.warn(`${label}: could not save the backup of the corrupt file:`, err)
  }
}
