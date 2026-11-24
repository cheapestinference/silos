// instance-lock.ts — one Silos server per data directory.
//
// `tsx watch` can start TWO children at once when a merge touches many files
// (seen in server.log: two pids 92 ms apart). Only
// one wins the port, but the loser had already run every boot side effect
// before `listen` — builtin installs said twice in the silo journal, and any
// boot write could interleave with the winner's. The guard is the first
// thing the boot does after the data directory exists: an exclusive file
// (`server.lock`, linked into place) holding the pid. A second server over the same
// data finds a LIVE holder and leaves before touching anything; a holder
// that is dead (crash, SIGKILL) is stale and taken over.
//
// «Live» is a running node process with that pid — not just any pid: after
// a reboot the number can belong to something else, and a false refusal
// would keep Silos down. The lock is released on exit (only if it is still
// ours).
import { linkSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const LOCK_FILE = 'server.lock'

export interface LockDeps {
  pid: number
  // a node process with this pid is running right now
  isLiveServer: (pid: number) => boolean
}

export type LockResult = { ok: true; release: () => void } | { ok: false; holder: number }

export function isLiveNode(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    // EPERM = it exists but belongs to someone else — not a Silos of ours
    return false
  }
  try {
    // linux: the process's argv; elsewhere trust the signal probe
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    return argv.includes('node') || argv.includes('tsx')
  } catch {
    return process.platform !== 'linux'
  }
}

function readHolder(file: string): number | null {
  try {
    const n = Number.parseInt(readFileSync(file, 'utf8').trim(), 10)
    return Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

export function acquireInstanceLock(dataDir: string, deps: LockDeps = { pid: process.pid, isLiveServer: isLiveNode }): LockResult {
  const file = join(dataDir, LOCK_FILE)
  // the pid is written to a private file first and LINKED into place: link()
  // fails with EEXIST atomically, and the lock never exists without its pid
  const tmp = join(dataDir, `${LOCK_FILE}.${deps.pid}.tmp`)
  writeFileSync(tmp, `${deps.pid}\n`, { mode: 0o600 })
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(tmp, file)
        const release = (): void => {
          if (readHolder(file) !== deps.pid) return // someone took over a lock we no longer own
          try {
            unlinkSync(file)
          } catch {
            /* already gone */
          }
        }
        return { ok: true, release }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        const holder = readHolder(file)
        if (holder !== null && holder !== deps.pid && deps.isLiveServer(holder)) return { ok: false, holder }
        // dead, unreadable, or this very pid number from before a reboot:
        // stale — removed, and the link tried again
        try {
          unlinkSync(file)
        } catch {
          /* a racer removed it first */
        }
      }
    }
    return { ok: false, holder: readHolder(file) ?? -1 }
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      /* gone */
    }
  }
}
