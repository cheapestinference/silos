// sweep-rules.ts — the pure decision behind sweepStaleE2ETmux (helpers.ts).
// A process belongs to an e2e run iff its argv says `-L silos-e2e-<pid>`:
// that covers the tmux server (the claudes' parent — SIGTERM takes them
// with it) and any hung client, and never matches the product's consoles
// (default socket or named sessions). Socket FILES are not the source of
// truth any more — stop()'s old rmSync/kill race deleted the file first
// often enough to blind the old file-based sweep for good (92 orphaned
// claudes, Aug 26–29).

// `cmdline` as /proc/<pid>/cmdline gives it: argv joined with NUL bytes.
export function e2eWorkerOf(cmdline: string): number | null {
  const argv = cmdline.split('\0')
  const i = argv.indexOf('-L')
  if (i === -1) return null
  const m = /^silos-e2e-(\d+)$/.exec(argv[i + 1] ?? '')
  return m ? Number(m[1]) : null
}
