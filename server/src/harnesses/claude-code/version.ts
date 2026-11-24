// harnesses/claude-code/version.ts — Claude Code's rows in the harness
// status (../../harness.ts HarnessService) and its compatibility verdict.
//
// ONE Claude Code: the `claude` on PATH runs the consoles AND
// the chat turns (binary.ts), so there is one version row — plus the Agent
// SDK library Silos ships (pinned in server/package.json) and the Claude Code
// release it is paired with (its `claudeCodeVersion`, 0.3.N ↔ 2.1.N), npm's
// published latest (cached ~10 min, a failed lookup retried sooner) and the
// updater, `claude update`.
//
// The minimum IS the SDK's paired release (today 2.1.319): Silos is built
// and tested against that pairing, so a `claude` older than it is refused
// (consoles and chat turns) with «run claude update». A `claude` NEWER than
// the pairing (Claude Code auto-updates) is told apart:
//   · same major.minor (2.1.x) — chats keep running. The SDK's control
//     protocol is negotiated, not version-locked: new fields are optional
//     and «a CLI that predates the field ignores it» / «older CLIs ignore
//     the field and behave as if false», capabilities are «advertised … on
//     system/init» (sdk.d.ts 0.3.319, 26 such clauses). A newer 2.1 patch
//     speaks to a 0.3 client the way an older client is designed for. The
//     verdict says Silos should move to the matching SDK, and names it.
//   · another major.minor — no such evidence: chat turns are refused until
//     Silos ships the SDK paired with it (consoles don't use the SDK and
//     keep running).
// claudeVersions(ctx) is the adapter's `versions` member.
import { compareVersions, minimumVerdict, parseVersion, versionOf, type EngineCompat, type RunFn } from '../../harness-run.js'
import type { HarnessVersions, VersionsContext } from '../contract.js'
import { silosUpdateCommand, thisSilosOrigin } from '../../silos-origin.js'
import { CLAUDE_CMD, claudeOnPath, sdkPairing, type SdkPairing } from './binary.js'

export const CLAUDE_CODE_PACKAGE = '@anthropic-ai/claude-code'
export const AGENT_SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk'
const LATEST_MS = 10_000
const LATEST_TTL_MS = 10 * 60_000
const LATEST_FAIL_TTL_MS = 60_000 // a failed lookup is retried sooner, never hammered

/** The words of its update command (the update error, the verdict). */
export const CLAUDE_UPDATE_LABEL = 'claude update'
/** Claude Code's documented native installer (a missing `claude`). */
export const CLAUDE_INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash'

export class ClaudeVersions {
  private readonly run: RunFn
  private readonly consoleCmd: string
  private readonly now: () => number
  private readonly resolve: (cmd: string) => string | null
  private latestCache: { value: string | null; at: number; ttl: number } | null = null

  constructor(deps: { run: RunFn; consoleCmd: string; now: () => number; resolve?: (cmd: string) => string | null }) {
    this.run = deps.run
    this.consoleCmd = deps.consoleCmd
    this.now = deps.now
    this.resolve = deps.resolve ?? ((cmd) => claudeOnPath(process.env.PATH, cmd))
  }

  /** The one `claude`: its version and where it is on PATH. */
  async info(): Promise<{ version: string | null; path: string | null }> {
    const path = this.resolve(this.consoleCmd)
    const version = path === null ? null : await versionOf(this.run, path)
    return { version, path }
  }

  async latest(): Promise<string | null> {
    const c = this.latestCache
    if (c && this.now() - c.at < c.ttl) return c.value
    let value: string | null = null
    try {
      const r = await this.run('npm', ['view', CLAUDE_CODE_PACKAGE, 'version'], { timeoutMs: LATEST_MS })
      value = parseVersion(r.stdout)
    } catch {
      value = null
    }
    this.latestCache = { value, at: this.now(), ttl: value === null ? LATEST_FAIL_TTL_MS : LATEST_TTL_MS }
    return value
  }

  /** When the cached latest was looked up (null: never). */
  get checkedAt(): number | null {
    return this.latestCache?.at ?? null
  }

  updateCommand(): [string, string[]] {
    return [this.consoleCmd, ['update']]
  }
}

const majorMinor = (v: string): string => v.split('-')[0]!.split('.').slice(0, 2).join('.')

/** The SDK release paired with a Claude Code version, when the pattern
 *  (library major.minor + the CLI's patch) holds for it; else null. */
export function pairedSdkFor(cli: string, p: SdkPairing): string | null {
  if (majorMinor(cli) !== majorMinor(p.pairedWith)) return null
  const patch = cli.split('-')[0]!.split('.')[2]
  return patch === undefined ? null : `${majorMinor(p.library)}.${patch}`
}

/** Claude Code's verdict: the one `claude` against the SDK's pairing. */
/** `silosUpdate`: the command that updates THIS Silos when it is not a
 *  source checkout (silos-origin.ts) — an install never sees the repo's
 *  `npm install -w server …`, which only a checkout can run. */
export function claudeCompat(installed: string | null, p: SdkPairing | null, silosUpdate: string | null = null): EngineCompat {
  const name = 'Claude Code'
  // no readable pairing (a broken install of Silos itself): nothing to hold
  // the CLI against but itself — the minimum check still says missing
  const needed = p?.pairedWith ?? installed ?? '?'
  const base = minimumVerdict({ harness: 'claude-code', name, installed, needed, update: CLAUDE_UPDATE_LABEL, install: CLAUDE_INSTALL })
  if (base.state !== 'ok' || !p || installed === null || compareVersions(installed, p.pairedWith) <= 0) return base
  const sdk = pairedSdkFor(installed, p)
  // --save-exact: the pin stays exact whatever the machine's npm config
  // (save-exact=false would write ^0.3.N and let the pairing drift again)
  const update = silosUpdate ?? `npm install -w server --save-exact ${AGENT_SDK_PACKAGE}@${sdk ?? `<the release paired with ${installed}>`}`
  const lib = `Silos' Agent SDK ${p.library} (paired with Claude Code ${p.pairedWith})`
  return sdk
    ? {
        ...base,
        state: 'ahead',
        update,
        refuses: [],
        message: `Claude Code ${installed} is newer than ${lib} — chats keep running; update Silos${silosUpdate ? '' : ` to Agent SDK ${sdk}`}: ${update}`,
      }
    : {
        ...base,
        state: 'ahead',
        update,
        refuses: [],
        message: `Claude Code ${installed} is a newer line than ${lib} — chats keep running, but Silos is not yet verified with ${majorMinor(installed)}.x; update Silos when it ships the paired Agent SDK: ${update}`,
      }
}

/** HarnessDeps.engines['claude-code']: the console's command (default
 *  `claude`, resolved on PATH), how a command resolves (tests), and the SDK
 *  pairing (default: the installed package's; tests pin one). */
export interface ClaudeVersionOptions {
  consoleCmd?: string
  resolve?: (cmd: string) => string | null
  pairing?: () => SdkPairing | null
  silosUpdate?: () => string | null
}

export function claudeVersions(ctx: VersionsContext): HarnessVersions {
  const opts = (ctx.options ?? {}) as ClaudeVersionOptions
  const v = new ClaudeVersions({ run: ctx.run, consoleCmd: opts.consoleCmd ?? CLAUDE_CMD, now: ctx.now, ...(opts.resolve ? { resolve: opts.resolve } : {}) })
  const pairing = opts.pairing ?? sdkPairing
  const silosUpdate = opts.silosUpdate ?? (() => silosUpdateCommand(thisSilosOrigin()))
  return {
    async primary() {
      const [cons, latest] = await Promise.all([v.info(), v.latest()])
      const p = pairing()
      return {
        console: cons,
        library: { name: 'Agent SDK', version: p?.library ?? null, pairedWith: p?.pairedWith ?? null },
        latest,
        checkedAt: v.checkedAt ?? ctx.now(),
      }
    },
    async version() {
      return (await v.info()).version
    },
    async compat() {
      return claudeCompat((await v.info()).version, pairing(), silosUpdate())
    },
    updateCommand: () => v.updateCommand(),
    updateLabel: CLAUDE_UPDATE_LABEL,
  }
}
