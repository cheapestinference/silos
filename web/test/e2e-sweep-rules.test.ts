// e2e-sweep-rules.test.ts — the sweep's decision, pure:
// orphaned claudes survived every run because the old sweep only
// looked at SOCKET FILES, and stop() raced its own rmSync against an async
// kill-server — once the file lost the race, the orphans became invisible
// forever. The rule now reads PROCESSES: any process whose cmdline names a
// silos-e2e-<pid> socket whose worker is dead is sweepable.
import { describe, expect, it } from 'vitest'
import { e2eWorkerOf } from '../e2e/sweep-rules'

// /proc/<pid>/cmdline joins argv with NUL bytes — the parser gets it raw.
const nul = (...args: string[]): string => args.join('\0')

describe('e2eWorkerOf — which e2e worker owns this process, if any', () => {
  it('reads the worker pid out of a tmux -L silos-e2e-<pid> cmdline', () => {
    expect(e2eWorkerOf(nul('tmux', '-L', 'silos-e2e-93075', '-f', '/tmp/silos-console-tmux.conf', 'new-session', '-d'))).toBe(93075)
  })

  it('a claude with no socket in its argv is not attributable — null', () => {
    expect(e2eWorkerOf(nul('claude', '--append-system-prompt-file', '/tmp/deck-e2e-data-x/console-append/files1.md'))).toBeNull()
  })

  it("the product's own consoles (default or named sockets) are never e2e's", () => {
    expect(e2eWorkerOf(nul('tmux', '-L', 'silos', 'attach'))).toBeNull()
    expect(e2eWorkerOf(nul('tmux', 'new-session', '-d', '-s', 'silos-abc'))).toBeNull()
  })

  it('a mention of silos-e2e in an unrelated argument (not after -L) does not match', () => {
    expect(e2eWorkerOf(nul('grep', 'silos-e2e-123', '/var/log/syslog'))).toBeNull()
  })
})
