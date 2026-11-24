// harnesses/opencode/version.ts — OpenCode's row in the harness status
// (../../harness.ts HarnessService): its version through the shared probe
// (tui-auth.ts OpencodeVersionProbe in production), where the binary is,
// no published-latest lookup, and its updater command. opencodeVersions(ctx)
// is the adapter's `versions` member: its row in `others` and its updater.
import { minimumVerdict, VERSION_MS, versionOf, type EngineCompat, type OtherHarnessStatus, type RunFn } from '../../harness-run.js'
import type { HarnessVersions, VersionsContext } from '../contract.js'

export class OpenCodeVersions {
  private readonly run: RunFn
  private readonly cmd: string
  private readonly probe: { version(): Promise<string | null>; invalidate?(): void }

  constructor(deps: { run: RunFn; cmd: string; probe: { version(): Promise<string | null>; invalidate?(): void } }) {
    this.run = deps.run
    this.cmd = deps.cmd
    this.probe = deps.probe
  }

  async info(): Promise<OtherHarnessStatus> {
    const cmd = this.cmd
    const [version, path] = await Promise.all([
      this.probe.version(),
      cmd.includes('/')
        ? Promise.resolve(cmd)
        : this.run('which', [cmd], { timeoutMs: VERSION_MS }).then(
            (r) => r.stdout.trim() || null,
            () => null,
          ),
    ])
    return { harness: 'opencode', name: 'OpenCode', version, path: version === null ? null : path, latest: null }
  }

  /** The installed version, through the shared probe. */
  version(): Promise<string | null> {
    return this.probe.version()
  }

  updateCommand(): [string, string[]] {
    return [this.cmd, ['upgrade']]
  }

  // the cached version is stale once the binary may have moved
  invalidate(): void {
    this.probe.invalidate?.()
  }
}

/** HarnessDeps.engines.opencode: OpenCode's binary (default:
 *  $SILOS_OPENCODE_BIN, else `opencode` on PATH) and the shared
 *  `opencode --version` probe (tui-auth.ts OpencodeVersionProbe in
 *  production — one probe for the console's auth gate and this row;
 *  invalidated after an upgrade). Absent probe → asked here. */
export interface OpenCodeVersionOptions {
  cmd?: string
  probe?: { version(): Promise<string | null>; invalidate?(): void }
}

/** The words of its update command (the update error, Settings › Engines). */
export const OPENCODE_UPDATE_LABEL = 'opencode upgrade'
/** OpenCode's documented installer (a missing `opencode`). */
export const OPENCODE_INSTALL = 'curl -fsSL https://opencode.ai/install | bash'

/** The lowest OpenCode Silos runs (no compatibility with older
 *  engines). 1.19.4 is the release every OpenCode fact Silos relies on was
 *  verified against (README: «Verified against the minimum»): `--auto` on
 *  the TUI and on `run` (auto-mode.ts), the TUI honouring
 *  OPENCODE_SERVER_PASSWORD (tui-auth.ts), the TUI control endpoints and
 *  the prompt's model handling (tui-client.ts), Skill discovery
 *  (assemble.ts), the console palette (console-theme.ts). Older releases are
 *  refused, never accommodated. */
export const OPENCODE_MINIMUM = '1.19.4'

/** OpenCode's verdict: one binary runs its consoles and its `run` turns. */
export function opencodeCompat(installed: string | null): EngineCompat {
  return minimumVerdict({
    harness: 'opencode',
    name: 'OpenCode',
    installed,
    needed: OPENCODE_MINIMUM,
    update: OPENCODE_UPDATE_LABEL,
    install: OPENCODE_INSTALL,
  })
}

export function opencodeVersions(ctx: VersionsContext): HarnessVersions {
  const opts = (ctx.options ?? {}) as OpenCodeVersionOptions
  const run = ctx.run
  const cmd = opts.cmd ?? (process.env.SILOS_OPENCODE_BIN || 'opencode')
  const v = new OpenCodeVersions({ run, cmd, probe: opts.probe ?? { version: () => versionOf(run, cmd) } })
  return {
    other: () => v.info(),
    version: () => v.version(),
    compat: async () => opencodeCompat(await v.version()),
    updateCommand: () => v.updateCommand(),
    updateLabel: OPENCODE_UPDATE_LABEL,
    invalidate: () => v.invalidate(),
  }
}
