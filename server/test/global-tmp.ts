// global-tmp.ts — one private temp dir per test run, removed when the run
// ends. Hundreds of tests mkdtemp under os.tmpdir() and never clean up; with
// TMPDIR pointed here before the workers start, every one of those dirs lands
// inside this run's dir and goes with it (1.38M leftovers had piled up in /tmp
// by 02-11 — half the disk's inodes). The web workspace reuses this file.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export default function setup(): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'silos-test-'))
  process.env.TMPDIR = dir
  // the owner's machine is never reachable from a test: a private HOME (no
  // real ~/.silos, ~/.claude, ~/.claude.json) and a private tmux socket dir
  // (`tmux -L silos` lands in this run's own server, never the owner's live
  // consoles — 09-11: a test without a sandboxed TerminalService launched
  // three real claude consoles there and wrote into ~/.silos/console-append)
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  process.env.HOME = home
  process.env.TMUX_TMPDIR = dir
  return () => {
    // the tmux servers this run started (each test socket under TMUX_TMPDIR)
    const socks = join(dir, `tmux-${process.getuid?.() ?? 0}`)
    try {
      for (const s of readdirSync(socks)) {
        try {
          execFileSync('tmux', ['-S', join(socks, s), 'kill-server'], { stdio: 'ignore' })
        } catch {
          /* already gone */
        }
      }
    } catch {
      /* no tmux this run */
    }
    rmSync(dir, { recursive: true, force: true })
  }
}
