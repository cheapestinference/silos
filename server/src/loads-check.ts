// loads-check.ts — «Check now» and «See what it sends» on a project's Tools
// (docs/architecture.md «Tool health»). Neutral: it groups the folder's
// agents by the login each runs on by default, hands one login's check to
// its engine (Harness.loads.check) and keeps the reading in the ledger as
// `check` (tool-health.ts) — never an engine named here.
//
// The owner's gesture, and only his: nothing here runs on a timer, at a
// project's birth or after a switch; the route is owner-only (an agent's
// bearer is refused by the agent-authz allow-lists). One check at a time
// per folder: a second one answers busy (409) while the first runs.
//
// «See what it sends» runs without the folder's local layer: its reading
// is no reading of the folder (a switch there would not have held), so only
// the login's connector list is kept from it — and nothing is written to
// the folder.
import type { Agent } from './types.js'
import type { HarnessLoads, LoadsCheckReading } from './harnesses/contract.js'
import type { QueryFn } from './harnesses/claude-code/sdk-types.js'
import type { ResolvedProvider } from './providers-store.js'
import type { ToolHealthLedger } from './tool-health.js'
import { fallbackHarness, findHarness, harnessOf } from './harnesses/registry.js'

export interface LoadsChecksDeps {
  registry: { list(all?: boolean): Agent[] }
  providers?: { resolveForAgent(agentId: string, providerId: string | undefined): ResolvedProvider }
  ledger?: Pick<ToolHealthLedger, 'record' | 'recordSends' | 'readings' | 'connectorsOf'>
  queryFn: QueryFn
  home: string
  managedDir?: string
  /** the payload Silos keeps for an agent on an engine (loads-scopes.ts):
   *  handed to that engine's check on the agent's page; absent: none */
  carriedOf?: (agentId: string, engineId: string) => unknown
  /** an agent's $SILOS_AGENT_STATE (never created by the look), or null */
  agentStateDir?: (agentId: string) => string | null
  /** the email a login is signed in as, when it can be asked cheaply */
  loginOf?: (providerId: string) => Promise<string | null>
  now?: () => number
  /** the engine's bound, overridden (tests) */
  timeoutMs?: number
}

/** One button: a login the folder's agents run on by default. */
export interface CheckTarget {
  /** the provider id the POST names */
  provider: string
  /** the login's name on screen («Claude · work»), and its email when known */
  label: string
  login: string | null
  engine: string
  /** the agents on it — their own tools are read too */
  agents: string[]
  /** what one check costs, said beside the button */
  cost: string
  /** the login has a Claude account that sends things, and whether this
   *  folder fetches them: «See what it sends» where it has one, off here */
  account: boolean
  sendsHere: boolean
  /** the login's connector list, from its newest reading in any folder
   *  where connectors were on */
  sends?: { at: number; connectors: string[] }
  last?: CheckRun
}
export interface CheckRun {
  at: number
  ms?: number
  withoutLocal?: true
  /** the bound came while servers were still connecting */
  incomplete?: true
  counts?: { connected: number; failed: number; needsAuth: number; other: number }
}
export interface CheckStatus {
  targets: CheckTarget[]
  running: { provider: string; withoutLocal: boolean; startedAt: number } | null
}
export interface CheckAnswer extends CheckRun {
  provider: string
  login: string | null
  /** «See what it sends»: the connectors the login sends (null: connectors are off for it everywhere) */
  connectors?: string[] | null
}

export class CheckBusy extends Error {
  constructor() {
    super('a check is already running in this project')
  }
}
export class CheckRefused extends Error {
  constructor(
    m: string,
    readonly status: number,
  ) {
    super(m)
  }
}

const DEFAULT_ID = 'default'

/** One login the folder's agents run on, with the engine that checks it. */
interface Group {
  provider: ResolvedProvider | null
  id: string
  loads: HarnessLoads
  engine: string
  engineId: string
  agents: Agent[]
}

export class LoadsChecks {
  private running = new Map<string, { provider: string; withoutLocal: boolean; startedAt: number }>()
  private lastRuns = new Map<string, CheckRun>()
  private learned = new Map<string, string>()
  constructor(private deps: LoadsChecksDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** The folder's logins, each with the engine that checks it and its agents. */
  private groups(folder: string, as?: string): Group[] {
    const all = this.deps.registry.list(false).filter((a) => (a.folder === folder || (a.folders ?? []).includes(folder)) && (as === undefined || a.id === as))
    const out = new Map<string, Group>()
    if (all.length === 0 && as === undefined) {
      const h = fallbackHarness()
      if (h.loads?.check) out.set(`${h.id}\u0000${DEFAULT_ID}`, { provider: null, id: DEFAULT_ID, loads: h.loads, engine: h.label, engineId: h.id, agents: [] })
    }
    for (const a of all) {
      let h
      try {
        h = findHarness(harnessOf(a))
      } catch {
        continue
      }
      if (!h?.loads?.check) continue
      const provider = this.deps.providers ? this.deps.providers.resolveForAgent(a.id, a.provider) : null
      const id = provider?.id ?? DEFAULT_ID
      const k = `${h.id}\u0000${id}`
      const g = out.get(k) ?? { provider, id, loads: h.loads, engine: h.label, engineId: h.id, agents: [] }
      g.agents.push(a)
      out.set(k, g)
    }
    return [...out.values()]
  }

  /** The logins the folder's agents run on, as far as they are known —
   *  whose lists of what their account sends the inventory reads. */
  async logins(folder: string): Promise<string[]> {
    const out: string[] = []
    for (const g of this.groups(folder)) {
      let login: string | null = this.learned.get(g.id) ?? null
      if (this.deps.loginOf) {
        try {
          login = (await this.deps.loginOf(g.id)) ?? login
        } catch {
          /* unknown */
        }
      }
      if (login !== null && !out.includes(login)) out.push(login)
    }
    return out
  }

  /** `as`: an agent's page — that agent's login only, and the last check
   *  taken as it. */
  async status(folder: string, opts: { as?: string } = {}): Promise<CheckStatus> {
    const targets: CheckTarget[] = []
    let readings: ReturnType<ToolHealthLedger['readings']> = []
    try {
      readings = this.deps.ledger?.readings(folder) ?? []
    } catch {
      readings = []
    }
    for (const g of this.groups(folder, opts.as)) {
      let login: string | null = this.learned.get(g.id) ?? null
      if (this.deps.loginOf) {
        try {
          login = (await this.deps.loginOf(g.id)) ?? login
        } catch {
          /* unknown */
        }
      }
      const sends = g.loads.sends?.({
        folder,
        home: this.deps.home,
        provider: g.provider,
        ...(this.deps.managedDir ? { managedDir: this.deps.managedDir } : {}),
      }) ?? { account: false, here: false }
      const kept = this.lastRuns.get(runKey(folder, g.id, opts.as))
      // after a restart: the newest check reading of this login in the
      // folder — on an agent's page, the newest taken as that agent; on the
      // project's, one taken as no agent
      const fromLedger = login !== null ? readings.find((r) => r.from === 'check' && r.login === login && r.agent === opts.as) : undefined
      const last: CheckRun | undefined =
        kept && (!fromLedger || kept.at >= fromLedger.at) ? kept : fromLedger ? { at: fromLedger.at, counts: countsOf(fromLedger.servers) } : undefined
      let list: { at: number; connectors: string[] } | null = null
      try {
        list = login !== null ? (this.deps.ledger?.connectorsOf(login) ?? null) : null
      } catch {
        list = null
      }
      targets.push({
        provider: g.id,
        label: g.provider?.label ?? 'this machine’s login',
        login,
        engine: g.engine,
        agents: g.agents.map((a) => a.name),
        cost: g.loads.checkCost ?? '',
        account: sends.account,
        sendsHere: sends.here,
        ...(list ? { sends: list } : {}),
        ...(last ? { last } : {}),
      })
    }
    return { targets, running: this.running.get(folder) ?? null }
  }

  /** One check — the login named, else the folder's only one. */
  /** `as`: «Check now» on an agent's page — started with that agent's
   *  launch entries and its role plugin only, its reading kept as that
   *  agent's (tool-health.ts `agent`: the project's health skips it where
   *  the agent holds the row). */
  async run(folder: string, opts: { provider?: string; withoutLocal?: boolean; as?: string } = {}): Promise<CheckAnswer> {
    if (this.running.has(folder)) throw new CheckBusy()
    const groups = this.groups(folder, opts.as)
    const g = opts.provider !== undefined ? groups.find((x) => x.id === opts.provider) : groups.length === 1 ? groups[0] : undefined
    if (!g)
      throw new CheckRefused(
        groups.length === 0
          ? opts.as !== undefined
            ? 'no engine of this agent can check its tools'
            : 'no engine here can check its tools'
          : opts.provider !== undefined
            ? 'no agent of this project runs on that login'
            : 'name the login to check',
        groups.length === 0 ? 409 : 400,
      )
    const withoutLocal = opts.withoutLocal === true
    if (
      withoutLocal &&
      !(
        g.loads.sends?.({ folder, home: this.deps.home, provider: g.provider, ...(this.deps.managedDir ? { managedDir: this.deps.managedDir } : {}) })
          ?.account ?? false
      )
    )
      throw new CheckRefused('this login has no account that sends anything', 400)
    const startedAt = this.now()
    this.running.set(folder, { provider: g.id, withoutLocal, startedAt })
    let reading: LoadsCheckReading
    try {
      reading = await g.loads.check!(
        {
          folder,
          home: this.deps.home,
          provider: g.provider,
          agents: g.agents.map((a) => ({ id: a.id, name: a.name, stateDir: this.stateDirOf(a.id) })),
          ...(withoutLocal ? { withoutLocal: true } : {}),
          ...(opts.as !== undefined ? { as: { agent: opts.as, payload: this.carriedOf(opts.as, g.engineId) } } : {}),
          ...(this.deps.managedDir ? { managedDir: this.deps.managedDir } : {}),
          ...(this.deps.timeoutMs !== undefined ? { timeoutMs: this.deps.timeoutMs } : {}),
        },
        { queryFn: this.deps.queryFn },
      )
    } finally {
      this.running.delete(folder)
    }
    const at = this.now()
    if (reading.login) this.learned.set(g.id, reading.login)
    let connectors: string[] | null | undefined
    try {
      if (withoutLocal) {
        connectors = reading.connectorsOn
          ? reading.servers
              .filter((s) => s.source === 'claudeai')
              .map((s) => s.name)
              .sort()
          : null
        if (reading.login && reading.connectorsOn) this.deps.ledger?.recordSends(reading.login, reading.servers, at)
      } else {
        this.deps.ledger?.record({
          folder,
          login: reading.login,
          connectorsOn: reading.connectorsOn,
          servers: reading.servers,
          from: 'check',
          at,
          started: startedAt,
          ...(opts.as !== undefined ? { agentId: opts.as } : {}),
        })
      }
    } catch (err) {
      console.warn('tool-health: a check’s reading was not kept:', err instanceof Error ? err.message : String(err))
    }
    const run: CheckRun = {
      at,
      ms: reading.ms,
      counts: countsOf(reading.servers),
      ...(withoutLocal ? { withoutLocal: true as const } : {}),
      ...(reading.complete ? {} : { incomplete: true as const }),
    }
    this.lastRuns.set(runKey(folder, g.id, opts.as), run)
    return { ...run, provider: g.id, login: reading.login, ...(connectors !== undefined ? { connectors } : {}) }
  }

  private carriedOf(agentId: string, engineId: string): unknown {
    try {
      return this.deps.carriedOf?.(agentId, engineId) ?? null
    } catch {
      return null
    }
  }

  private stateDirOf(id: string): string | null {
    try {
      return this.deps.agentStateDir?.(id) ?? null
    } catch {
      return null
    }
  }
}

const runKey = (folder: string, provider: string, as: string | undefined): string => `${folder}\u0000${provider}\u0000${as ?? ''}`

function countsOf(servers: { status: string; noAddress?: true }[]): NonNullable<CheckRun['counts']> {
  const c = { connected: 0, failed: 0, needsAuth: 0, other: 0 }
  for (const s of servers) {
    if (s.noAddress) continue // a placeholder is never a failure
    if (s.status === 'connected') c.connected++
    else if (s.status === 'failed') c.failed++
    else if (s.status === 'needs-auth') c.needsAuth++
    else c.other++
  }
  return c
}
