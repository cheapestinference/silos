// territory-store.ts — the owner's territory settings, ~/.silos/territory.json
// ({ "privatePaths": [...], "enabled": [agent ids] }, 0600). The ~/.silos and
// ~/.claude groups of the fence are always generated and not configurable.
// `enabled` lists the fenced agents: every agent is born fenced
// (enableAtBirth, called by each path that creates one — POST /api/agents,
// role-pack install) and Settings › Territory keeps the explicit off.
// `egress`: per agent id, where its process may call
// through Silos' egress proxy (egress-proxy.ts) — { mode, hosts }. An agent
// absent from the map is `open` (the default: nothing changes on update).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson, backupCorruptJson } from './json-store.js'
import { endPass } from './pass.js'

// the usual homes of the operator's own credentials
export const DEFAULT_PRIVATE = ['~/secrets', '~/.ssh', '~/.npmrc', '~/.aws', '~/.config/gh', '~/.gnupg']

/** One agent's network surface. `open` = no proxy
 *  in its env, no restriction; `allowlist` = its env routes HTTP(S) through
 *  the egress proxy, which lets through only `hosts` + its engine's own. */
export interface EgressPolicy {
  mode: 'open' | 'allowlist'
  hosts: string[]
}

export const EGRESS_OPEN: Readonly<EgressPolicy> = Object.freeze({ mode: 'open', hosts: [] as string[] }) as Readonly<EgressPolicy>
export const EGRESS_MAX_HOSTS = 200

// a DNS label (RFC 1123), lowercase
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
// a host name, optionally led by one wildcard: `*.` (any subdomain, at any
// depth) or `*-` (a PREFIX inside the first label — Claude Code's documented
// `*-review.googlesource.com`). No scheme, port, path, or IPv6 literal.
const HOST_PATTERN = new RegExp(`^(?:\\*[.-])?${LABEL}(?:\\.${LABEL})*$`)

/** Why `raw` is not an allowlist host, or null. Expects it trimmed + lowercased. */
export function egressHostProblem(raw: string): string | null {
  if (raw === '') return 'an empty host'
  if (raw.length > 253) return `${raw.slice(0, 40)}…: longer than a host name can be`
  if (/[:/?#@\s]/.test(raw)) return `${raw}: a host name only — no scheme, port, path or credentials`
  if (!HOST_PATTERN.test(raw)) return `${raw}: not a host name (a leading *. or *- is the only wildcard)`
  return null
}

/** The canonical form of an owner-given host list, or the first problem. */
export function normalizeEgressHosts(hosts: unknown): string[] | string {
  if (!Array.isArray(hosts)) return 'hosts must be an array of host names'
  if (hosts.length > EGRESS_MAX_HOSTS) return `at most ${EGRESS_MAX_HOSTS} hosts`
  const out: string[] = []
  for (const h of hosts) {
    if (typeof h !== 'string') return `hosts must be strings: ${String(h)}`
    const n = h.trim().toLowerCase().replace(/\.$/, '')
    const why = egressHostProblem(n)
    if (why !== null) return why
    if (!out.includes(n)) out.push(n)
  }
  return out
}

export class TerritoryStore {
  private paths: string[] = [...DEFAULT_PRIVATE]
  private enabledIds: string[] = []
  private egressMap: Record<string, EgressPolicy> = {}
  private file: string
  private warnedInvalid = false

  constructor(dataDir: string) {
    this.file = join(dataDir, 'territory.json')
  }

  load(): void {
    this.paths = [...DEFAULT_PRIVATE]
    this.enabledIds = []
    this.egressMap = {}
    if (!existsSync(this.file)) return
    const text = readFileSync(this.file, 'utf8')
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      backupCorruptJson(this.file, text, 'territory', { mode: 0o600 })
      return
    }
    const en = (raw as { enabled?: unknown } | null)?.enabled
    if (Array.isArray(en)) this.enabledIds = [...new Set(en.filter((x): x is string => typeof x === 'string' && x !== ''))]
    const eg = (raw as { egress?: unknown } | null)?.egress
    if (eg !== null && typeof eg === 'object' && !Array.isArray(eg)) {
      for (const [id, v] of Object.entries(eg as Record<string, unknown>)) {
        if (id === '' || v === null || typeof v !== 'object') continue
        const o = v as { mode?: unknown; hosts?: unknown }
        // a hand-edited list keeps its valid hosts; the mode is never
        // loosened by a bad host (allowlist stays allowlist)
        const hosts = Array.isArray(o.hosts)
          ? [
              ...new Set(
                o.hosts
                  .filter((h): h is string => typeof h === 'string')
                  .map((h) => h.trim().toLowerCase())
                  .filter((h) => egressHostProblem(h) === null),
              ),
            ]
          : []
        this.egressMap[id] = { mode: o.mode === 'allowlist' ? 'allowlist' : 'open', hosts }
      }
    }
    const pp = (raw as { privatePaths?: unknown } | null)?.privatePaths
    if (Array.isArray(pp)) {
      const valid = pp.filter((p): p is string => typeof p === 'string' && (p.startsWith('/') || p === '~' || p.startsWith('~/')))
      // An explicit [] is the owner's choice; a list whose entries are ALL
      // invalid is a mistake — keep the defaults rather than fence nothing.
      if (valid.length > 0 || pp.length === 0) this.paths = valid
      else if (!this.warnedInvalid) {
        this.warnedInvalid = true
        console.warn(`territory: every privatePaths entry in ${this.file} is invalid (absolute or ~-prefixed expected); using the defaults`)
      }
    }
  }

  privatePaths(): string[] {
    return [...this.paths]
  }

  setPrivatePaths(paths: string[]): void {
    for (const p of paths) {
      if (typeof p !== 'string' || !(p.startsWith('/') || p === '~' || p.startsWith('~/'))) {
        throw new Error(`private path must be absolute or ~-prefixed: ${String(p)}`)
      }
    }
    this.paths = [...new Set(paths)]
    this.save()
  }

  enabled(): string[] {
    return [...this.enabledIds]
  }

  isEnabled(agentId: string): boolean {
    return this.enabledIds.includes(agentId)
  }

  setEnabled(ids: string[]): void {
    for (const id of ids) {
      if (typeof id !== 'string' || id === '') throw new Error(`enabled entries must be agent ids: ${String(id)}`)
    }
    // written first, then held: a failed write never leaves memory saying
    // «fenced» while the disk says otherwise (review A4)
    const next = [...new Set(ids)]
    this.save({ enabled: next })
    this.enabledIds = next
  }

  /** The agent's egress policy; absent = open (the default). A copy. */
  egressOf(agentId: string): EgressPolicy {
    const p = this.egressMap[agentId]
    return p ? { mode: p.mode, hosts: [...p.hosts] } : { mode: 'open', hosts: [] }
  }

  /** Set one agent's egress (hosts already normalised — normalizeEgressHosts).
   *  Written first, then held (the same rule as setEnabled). An open policy
   *  with no hosts is the default and leaves the map. */
  setEgress(agentId: string, policy: EgressPolicy): void {
    if (typeof agentId !== 'string' || agentId === '') throw new Error(`egress needs an agent id: ${String(agentId)}`)
    if (policy.mode !== 'open' && policy.mode !== 'allowlist') throw new Error(`egress mode must be open or allowlist: ${String(policy.mode)}`)
    const hosts = normalizeEgressHosts(policy.hosts)
    if (typeof hosts === 'string') throw new Error(hosts)
    const next = { ...this.egressMap }
    if (policy.mode === 'open' && hosts.length === 0) delete next[agentId]
    else next[agentId] = { mode: policy.mode, hosts }
    this.save({ egress: next })
    this.egressMap = next
  }

  /** Fence at birth — a rule of AGENT CREATION: every
   *  path that creates an agent calls this right after registry.create, before
   *  anything else that could fail. Never throws: the agent already exists,
   *  and an unfenced agent is a legal state — said, never silent. Returns
   *  the owner-facing warn when the fence could not be turned on. */
  enableAtBirth(agent: { id: string; name: string }): string | undefined {
    try {
      if (!this.isEnabled(agent.id)) this.setEnabled([...this.enabledIds, agent.id])
      return undefined
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err)
      console.warn(`territory: could not turn on the fence of the new agent ${agent.id}:`, err)
      return `${agent.name}'s territory is off — ${cause}. It stays Only when told, but the automations you set still run unattended. Turn it on in its Settings ›`
    }
  }

  private save(next: { enabled?: string[]; egress?: Record<string, EgressPolicy> } = {}): void {
    // an agent's control (and so its wakes) follows its territory (pass.ts)
    endPass()
    const egress = next.egress ?? this.egressMap
    atomicWriteJson(
      this.file,
      {
        privatePaths: this.paths,
        enabled: next.enabled ?? this.enabledIds,
        ...(Object.keys(egress).length > 0 ? { egress } : {}),
      },
      { mode: 0o600 },
    )
  }
}
