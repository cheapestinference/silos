// harness.ts — the harness Silos drives, and the one button that updates
// it (a little button to update the harness in use — for now Claude
// Code). Two engines, two binaries, told apart honestly:
//
//   - ONE Claude Code: the `claude` on PATH runs the real
//     consoles (terminal-service.ts, argv of harnesses/claude-code/console.ts)
//     AND the chat turns (the SDK is handed that binary —
//     harnesses/claude-code/binary.ts). On this machine a native install
//     (~/.local/bin/claude → versions/<v>) whose updater is `claude update`.
//     That's what the button runs, and it moves both. New consoles pick up
//     the new binary; open ones keep theirs until that claude exits.
//   - the Agent SDK npm package is the client library only, pinned by
//     server/package.json and paired with one Claude Code release (shown;
//     it moves only with a Silos update).
//
// Compatibility: each engine's adapter declares the minimum
// Silos needs and returns a verdict (harness-run.ts EngineCompat). An
// engine below it is REFUSED — a console open (routes/console.ts) or a chat
// turn (chat-service.ts) gets the verdict's one line, with the update
// command — never run with fallbacks. Verdicts are cached briefly; a refusing
// one is re-read before it refuses (the owner may just have updated in a
// shell), and every update drops the cache.
//
// `latest` is what npm says is published (`npm view`), cached ~10 min; a
// failed lookup is null (the UI then says nothing about "up to date").
// Every process goes through an injectable `run` so tests never spawn a
// real claude or touch the network. Each engine's rows and updater live
// with it (harnesses/claude-code/version.ts, harnesses/opencode/version.ts),
// declared as the adapter's `versions` member with its own defaults; this
// service walks the registry and owns the shape and the one-update-at-a-time
// lock.
// The process runner and version parsing both engines share are in
// harness-run.ts, a leaf that imports no engine (so no import cycle).
import { defaultRun, type CompatPart, type EngineCompat, type OtherHarnessStatus, type RunFn } from './harness-run.js'
import type { HarnessId, HarnessVersions } from './harnesses/contract.js'
import { fallbackHarness, harnessOf, registeredHarnesses } from './harnesses/registry.js'
import type { Agent } from './types.js'

export interface HarnessStatus {
  harness: HarnessId
  name: string
  console: { version: string | null; path: string | null }
  library: { name: string; version: string | null; pairedWith: string | null } | null
  latest: string | null
  checkedAt: string
  others: OtherHarnessStatus[]
  /** Every engine's verdict, in registration order. */
  compat: EngineCompat[]
}

export interface HarnessUpdateResult {
  before: string | null
  after: string | null
  output: string
}

export class HarnessBusyError extends Error {
  constructor() {
    super('an update is already running')
  }
}

export class HarnessUpdateError extends Error {
  constructor(
    message: string,
    readonly output: string,
  ) {
    super(message)
  }
}

const UPDATE_MS = 5 * 60_000
// how long a verdict is trusted before it is read again
const COMPAT_TTL_MS = 60_000
const OUTPUT_MAX = 4000

// ANSI escapes and carriage-return progress redraws out; the tail kept.
function cleanOutput(text: string): string {
  const plain = text
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .split('\n')
    .map((l) => l.split('\r').pop() ?? '')
    .join('\n')
    .trim()
  return plain.length > OUTPUT_MAX ? `…${plain.slice(-OUTPUT_MAX)}` : plain
}

function errOutput(err: unknown): string {
  const e = err as { stdout?: unknown; stderr?: unknown }
  return cleanOutput(`${typeof e?.stdout === 'string' ? e.stdout : ''}\n${typeof e?.stderr === 'string' ? e.stderr : ''}`)
}

export interface HarnessDeps {
  run?: RunFn
  now?: () => number
  // each engine's own options, handed to its versions factory as-is
  // (harnesses/claude-code/version.ts ClaudeVersionOptions: consoleCmd,
  // resolve, pairing; harnesses/opencode/version.ts OpenCodeVersionOptions: cmd,
  // probe — the shared `opencode --version` probe, invalidated on upgrade)
  engines?: Partial<Record<HarnessId, unknown>>
  // run before each compatibility reading (engine-path.ts in production:
  // an engine installed while Silos runs is found without a restart)
  completePath?: () => void
}

export class HarnessService {
  private readonly run: RunFn
  private readonly now: () => number
  private readonly completePath: () => void
  // every registered engine that declares versions, in registration order
  private readonly versions = new Map<HarnessId, HarnessVersions>()
  private updating = false
  private compatCache = new Map<HarnessId, { verdict: EngineCompat; at: number }>()
  private compatInflight = new Map<HarnessId, Promise<EngineCompat>>()

  constructor(deps: HarnessDeps = {}) {
    this.run = deps.run ?? defaultRun
    this.now = deps.now ?? Date.now
    this.completePath = deps.completePath ?? (() => {})
    for (const h of registeredHarnesses()) {
      if (h.versions) this.versions.set(h.id, h.versions({ run: this.run, now: this.now, options: deps.engines?.[h.id] }))
    }
  }

  get busy(): boolean {
    return this.updating
  }

  /** The harnesses an update can target, in registration order. */
  updatable(): HarnessId[] {
    return [...this.versions.keys()]
  }

  async status(): Promise<HarnessStatus> {
    const fallback = fallbackHarness()
    const own = this.versions.get(fallback.id)
    if (!own?.primary) throw new Error(`fallback harness ${fallback.id} declares no primary versions`)
    const others = [...this.versions].filter(([id, v]) => id !== fallback.id && v.other).map(([, v]) => v)
    const [p, compat, ...rows] = await Promise.all([own.primary(), this.compatibility(), ...others.map((v) => v.other!())])
    return {
      harness: fallback.id,
      name: fallback.label,
      console: p.console,
      library: p.library,
      latest: p.latest,
      checkedAt: new Date(p.checkedAt).toISOString(),
      others: rows,
      compat,
    }
  }

  /** One engine's verdict: cached COMPAT_TTL_MS; `fresh` reads it again. */
  async compatOf(id: HarnessId, opts: { fresh?: boolean } = {}): Promise<EngineCompat | null> {
    const v = this.versions.get(id)
    if (!v) return null
    const hit = this.compatCache.get(id)
    if (!opts.fresh && hit && this.now() - hit.at < COMPAT_TTL_MS) return hit.verdict
    if (opts.fresh) v.invalidate?.()
    let p = this.compatInflight.get(id)
    if (!p || opts.fresh) {
      this.completePath()
      p = v
        .compat()
        .then((verdict) => {
          this.compatCache.set(id, { verdict, at: this.now() })
          return verdict
        })
        .finally(() => {
          if (this.compatInflight.get(id) === p) this.compatInflight.delete(id)
        })
      this.compatInflight.set(id, p)
    }
    return p
  }

  /** Every engine's verdict, in registration order. */
  async compatibility(): Promise<EngineCompat[]> {
    const all = await Promise.all([...this.versions.keys()].map((id) => this.compatOf(id)))
    return all.filter((c): c is EngineCompat => c !== null)
  }

  /** The last verdicts read, without asking (Home's composition is sync —
   *  the resident tick keeps them warm through compatibility()). */
  peekCompatibility(): EngineCompat[] {
    return [...this.versions.keys()].flatMap((id) => {
      const c = this.compatCache.get(id)
      return c ? [c.verdict] : []
    })
  }

  /** Why an agent's `part` is refused right now, from the LAST verdicts read
   *  (sync — the resident tick keeps them warm; refusal() writes a fresh one
   *  the moment a turn is refused) — null when it may run, or nothing was
   *  read yet. THE one reading the unattended lanes hold their work by
   *  (messages, task wakes, automations) and the inbox folds into the
   *  engineCompat row. */
  peekRefusal(agent: Pick<Agent, 'framework'>, part: CompatPart = 'chat'): string | null {
    const c = this.compatCache.get(harnessOf(agent))?.verdict
    return c && c.refuses.includes(part) ? (c.message ?? `${c.name} can't run`) : null
  }

  /** Why Silos won't start `part` on this engine — the verdict's one line —
   *  or null when it may. A refusing verdict is read again first: an engine
   *  the owner just updated in a shell is never refused from the cache. */
  async refusal(id: HarnessId, part: CompatPart): Promise<string | null> {
    let c = await this.compatOf(id)
    if (c && c.refuses.includes(part)) c = await this.compatOf(id, { fresh: true })
    return c && c.refuses.includes(part) ? c.message : null
  }

  // One update at a time, whichever harness: `claude update` for the
  // console's claude, `opencode upgrade` for OpenCode.
  async update(harness: HarnessId = fallbackHarness().id): Promise<HarnessUpdateResult> {
    if (this.updating) throw new HarnessBusyError()
    const v = this.versions.get(harness)
    if (!v) throw new Error(`harness ${harness} cannot be updated`)
    this.updating = true
    const what = v.updateLabel
    try {
      const before = await v.version()
      let output: string
      try {
        const [cmd, args] = v.updateCommand()
        const r = await this.run(cmd, args, { timeoutMs: UPDATE_MS })
        output = cleanOutput(`${r.stdout}\n${r.stderr}`)
      } catch (err) {
        const out = errOutput(err)
        const killed = (err as { killed?: boolean })?.killed === true
        throw new HarnessUpdateError(killed ? `${what} timed out` : `${what} failed${out ? `: ${out.split('\n').filter(Boolean).pop()}` : ''}`, out)
      } finally {
        // the cached version (and verdict) is stale once the binary may have moved
        v.invalidate?.()
        this.compatCache.delete(harness)
      }
      const after = await v.version()
      return { before, after, output }
    } finally {
      this.updating = false
    }
  }
}
