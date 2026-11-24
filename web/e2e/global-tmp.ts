// global-tmp.ts — the e2e run's own temp dir, removed when the run ends: the
// harness mkdtemps a data dir, a root and a home per worker under
// os.tmpdir(), and those deck-e2e-* dirs were never removed (1.38M leftovers
// in /tmp at one point, with the unit tests'). Workers and the servers they spawn
// inherit TMPDIR, so everything they create lands here.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export default function globalSetup(): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'silos-e2e-run-'))
  process.env.TMPDIR = dir
  return () => rmSync(dir, { recursive: true, force: true })
}
