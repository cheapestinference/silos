// yield-cpu — a test run lowers its own scheduling priority so it never
// starves the machine (21-11: several conversations ran `vitest run` at once,
// each taking every core, and the Silos server that relays the owner's live
// consoles froze). Called at config load by every vitest config (the root's
// and each workspace's); the workers vitest forks or spawns inherit the
// niceness. Best effort: a platform that refuses keeps running as it was.
import { constants, setPriority } from 'node:os'

export function yieldCpu(): void {
  try {
    setPriority(constants.priority.PRIORITY_BELOW_NORMAL)
  } catch {
    /* not permitted here: the run goes on at its priority */
  }
}

// …and takes half the cores at most, with a per-test timeout that allows for
// running slow on a busy machine: two conversations testing at once fill the
// machine instead of fighting over it twice, and a niced test that waited for
// a core is not a failure (21-11 — at load ~30 eight web tests died on the
// 5 s default and passed alone).
export const calmRun = { maxWorkers: '50%', testTimeout: 20_000 } as const
