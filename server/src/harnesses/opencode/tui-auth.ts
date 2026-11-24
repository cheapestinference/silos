// harnesses/opencode/tui-auth — `opencode --version`, run once and cached
// (the version row; every console runs with Silos' per-console basic auth,
// OPENCODE_SERVER_PASSWORD — Silos requires an OpenCode whose TUI honours it).

import { defaultRun, parseVersion, type RunFn } from '../../harness-run.js'
import { opencodeBin } from './bin.js'

const VERSION_MS = 15_000

/** `opencode --version`, run once and cached. A failed or unparseable run is
 *  null and is NOT cached (the next console open asks again). */
export class OpencodeVersionProbe {
  private readonly run: RunFn
  private readonly bin: () => string
  private cached: string | null = null
  private inflight: Promise<string | null> | null = null

  constructor(deps: { run?: RunFn; bin?: () => string } = {}) {
    this.run = deps.run ?? defaultRun
    this.bin = deps.bin ?? opencodeBin
  }

  // bumped by invalidate(): a probe started before it may still resolve, but
  // never lands in the cache nor answers a caller that asked after it.
  private generation = 0

  /** Forget the cached version (after `opencode upgrade` — harness.ts) and
   *  any probe still running against the old binary. */
  invalidate(): void {
    this.cached = null
    this.inflight = null
    this.generation++
  }

  async version(): Promise<string | null> {
    if (this.cached !== null) return this.cached
    if (!this.inflight) {
      const gen = this.generation
      const probe: Promise<string | null> = (async () => {
        try {
          const r = await this.run(this.bin(), ['--version'], { timeoutMs: VERSION_MS })
          return parseVersion(r.stdout)
        } catch {
          return null
        }
      })().then((v) => {
        if (gen === this.generation) {
          this.cached = v
          if (this.inflight === probe) this.inflight = null
        }
        return v
      })
      this.inflight = probe
    }
    return this.inflight
  }
}
