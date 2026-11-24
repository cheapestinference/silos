// engine-path.ts — an engine installed where its own installer puts it is
// FOUND, whatever PATH the process that started Silos had.
//
// Every engine process (console, chat turn, version probe) is looked up on
// Silos' own PATH. That PATH is an accident of how Silos was started: a
// service unit, a cron line, `env -i`, a login whose profile ran before the
// engine was installed (Ubuntu's ~/.profile adds ~/.local/bin only if it
// already exists) — all leave out the per-user directory the engine's
// installer writes to. Silos then said «isn't installed» about an engine
// that was (every console refused after a restart with a short PATH).
//
// So each engine declares its command and the directories ITS documented
// installer uses (contract.ts Harness.binary), and Silos completes its PATH:
// for an engine whose command is not on PATH, the first of its directories
// that holds it is APPENDED. The user's own PATH always wins (nothing is
// reordered, nothing is added for an engine PATH already finds); a command
// given as a path (an operator's override) is left alone. Run at boot,
// before anything is spawned, and again before each compatibility reading —
// an engine installed while Silos runs is found without a restart.
//
// A leaf: no engine is named here; the list comes from the registry.
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { Harness, HarnessId } from './harnesses/contract.js'

export function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** `cmd` on `path` (first executable file); a `cmd` with a slash is itself
 *  the answer when executable. null = not found. */
export function executableOnPath(cmd: string, path: string | undefined, isExecutable: (p: string) => boolean = isExecutableFile): string | null {
  if (cmd.includes('/')) return isExecutable(cmd) ? cmd : null
  for (const dir of (path ?? '').split(delimiter)) {
    if (dir === '') continue
    const p = join(dir, cmd)
    if (isExecutable(p)) return p
  }
  return null
}

export interface PathCompletion {
  harness: HarnessId
  dir: string
}

/** Appends to `env.PATH` the install directory of every engine PATH does not
 *  find; returns what was added (empty = PATH already found them all, or
 *  they are not installed). Idempotent. */
export function completeEnginePath(
  engines: readonly Pick<Harness, 'id' | 'binary'>[],
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  isExecutable: (p: string) => boolean = isExecutableFile,
): PathCompletion[] {
  const added: PathCompletion[] = []
  for (const h of engines) {
    if (!h.binary) continue
    const cmd = h.binary.command()
    if (cmd.includes('/') || executableOnPath(cmd, env.PATH, isExecutable) !== null) continue
    const dir = h.binary.installDirs(home).find((d) => isExecutable(join(d, cmd)))
    if (dir === undefined) continue
    env.PATH = env.PATH ? `${env.PATH}${delimiter}${dir}` : dir
    added.push({ harness: h.id, dir })
  }
  return added
}
