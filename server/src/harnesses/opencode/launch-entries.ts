// harnesses/opencode/launch-entries — what Silos keeps for OpenCode's LAUNCH
// places (this project, an agent, a conversation) and how it rides a launch
// (spec scopes §6, §9).
//
// Every OpenCode layer is a deep merge where the later wins, both ways
// (measured on 1.19.6: global file ‹ the folder's opencode.json(c) ‹
// OPENCODE_CONFIG_CONTENT). The project's, the agent's and the
// conversation's choices are all carried in the ONE config content Silos
// generates for every launch (launch.ts configContent) — the same object the
// territory fence's `permission` rides. So a payload is never trusted whole:
// `cleanOpencodeEntries` is the allowlist, applied at a switch (on the way in)
// AND at every launch (on the way out); everything else is dropped:
//
//   · `mcp.<name>.enabled`        — `true | false`, an entry of that one key
//   · `permission.skill.<name>`   — `"deny"` only
//
// A server's definition, any other `permission` key (bash, edit, read…),
// `plugin`, `instructions`, `provider`, env substitutions — none rides. A
// name carrying `{` is dropped: OpenCode substitutes `{env:…}` over the
// whole text.
//
// The overlay (`withOpencodeEntries`), in order, later wins: the folder's
// entries, then the agent's, then the thread's. A skill's deny is merged
// INTO the permission the launch already carries (the fence's, the held
// skills' denies) — appended last, replacing none of its keys; a deny never
// lifts anything. `onlyRemoves` (a heartbeat's sealed regime, rule 14): an
// `enabled: true` does not ride.
//
// Names are data: `__proto__` and `constructor` are entries like any other.
import type { PermissionAction, PermissionConfig } from './fence.js'

type Json = Record<string, unknown>

const isMap = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)
/** An own data property even for `__proto__` (plain assignment would set the prototype). */
const put = (o: Json, k: string, v: unknown): void => {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true })
}
/** a name OpenCode takes as written: not empty, bounded, no substitution */
const nameOk = (k: string): boolean => k !== '' && k.length <= 256 && !k.includes('{')

/** The fragment a launch place keeps: the two shapes of the allowlist. */
export interface OpencodeLaunchEntries {
  mcp?: Record<string, { enabled: boolean }>
  permission?: { skill: Record<string, 'deny'> }
}

/** The allowlist: what of `payload` may ride a launch, every other key and
 *  shape dropped; null when nothing is left. */
export function cleanOpencodeEntries(payload: unknown): OpencodeLaunchEntries | null {
  if (!isMap(payload)) return null
  const out: OpencodeLaunchEntries = {}
  if (own(payload, 'mcp') && isMap(payload.mcp)) {
    const m: Json = {}
    for (const [name, v] of Object.entries(payload.mcp)) {
      if (!nameOk(name) || !isMap(v) || Object.keys(v).length !== 1 || typeof v.enabled !== 'boolean') continue
      put(m, name, { enabled: v.enabled })
    }
    if (Object.keys(m).length > 0) out.mcp = m as Record<string, { enabled: boolean }>
  }
  if (own(payload, 'permission') && isMap(payload.permission) && own(payload.permission, 'skill') && isMap(payload.permission.skill)) {
    const s: Json = {}
    for (const [name, v] of Object.entries(payload.permission.skill)) if (nameOk(name) && v === 'deny') put(s, name, 'deny')
    if (Object.keys(s).length > 0) out.permission = { skill: s as Record<string, 'deny'> }
  }
  return out.mcp || out.permission ? out : null
}

/** The config content's object with each payload merged in, in order. Every
 *  key the launch carried is kept — the fence's `permission` keys, the held
 *  skills' denies, the agent's own servers' definitions; a payload with
 *  nothing allowed — or none at all — leaves `cfg` exactly as it was. */
export function withOpencodeEntries(cfg: Json, payloads: readonly unknown[] | undefined, opts: { onlyRemoves?: boolean } = {}): Json {
  let out = cfg
  for (const p of payloads ?? []) {
    const e = cleanOpencodeEntries(p)
    if (!e) continue
    const servers = Object.entries(e.mcp ?? {}).filter(([, v]) => !(opts.onlyRemoves && v.enabled))
    const denies = Object.keys(e.permission?.skill ?? {})
    if (servers.length === 0 && denies.length === 0) continue
    if (out === cfg) out = { ...cfg }
    if (servers.length > 0) {
      const m: Json = {}
      if (isMap(out.mcp)) for (const [k, v] of Object.entries(out.mcp)) put(m, k, v)
      // an entry already there (the agent's own server) keeps its definition:
      // only its `enabled` is the payload's
      for (const [name, v] of servers) put(m, name, own(m, name) && isMap(m[name]) ? { ...(m[name] as Json), enabled: v.enabled } : { enabled: v.enabled })
      out.mcp = m
    }
    if (denies.length > 0) out.permission = withSkillDenies(isMap(out.permission) ? (out.permission as PermissionConfig) : null, denies)
  }
  return out
}

/** The skill names the payloads deny (`permission.skill.<name> = "deny"`,
 *  through the allowlist) — what the launch's briefing must not name. A
 *  deny rides every launch, a heartbeat's too (it only removes). */
export function deniedSkillNames(payloads: readonly unknown[] | undefined): string[] {
  const out = new Set<string>()
  for (const p of payloads ?? []) for (const n of Object.keys(cleanOpencodeEntries(p)?.permission?.skill ?? {})) out.add(n)
  return [...out]
}

/** `permission` with `permission.skill.<name> = "deny"` for each name, every
 *  other key of `permission` as it was and in its order; a skill rule
 *  already there keeps its place unless it is one of these names, which go
 *  last (last match wins) — so nothing earlier lets them back in. */
export function withSkillDenies(permission: PermissionConfig | null, names: readonly string[]): PermissionConfig {
  const base: PermissionConfig = {}
  for (const [k, v] of Object.entries(permission ?? {})) put(base as Json, k, v)
  const prior = base.skill
  const rules: Record<string, PermissionAction> = {}
  if (typeof prior === 'string') put(rules, '*', prior)
  else if (isMap(prior)) for (const [k, v] of Object.entries(prior)) put(rules, k, v)
  for (const name of names) {
    delete rules[name] // re-inserted last: key order is rule order
    put(rules, name, 'deny')
  }
  put(base as Json, 'skill', rules)
  return base
}

/** A row's own entry in a payload: on/off for a server — absent: none. */
export function mcpEntryOf(payload: unknown, name: string): 'on' | 'off' | undefined {
  const m = cleanOpencodeEntries(payload)?.mcp
  return m && own(m, name) ? (m[name]!.enabled ? 'on' : 'off') : undefined
}

/** The payload with the server's entry set (`to`) or removed (null), every
 *  other entry kept; the cleaned payload (null: nothing left) and whether
 *  anything changed. Only the switch's own entry is touched. */
export function setMcpEntry(payload: unknown, name: string, to: 'on' | 'off' | null): { payload: OpencodeLaunchEntries | null; changed: boolean } {
  const prior = cleanOpencodeEntries(payload)
  const before = mcpEntryOf(prior, name)
  if ((to ?? undefined) === before) return { payload: prior, changed: false }
  const m: Json = {}
  for (const [k, v] of Object.entries(prior?.mcp ?? {})) if (k !== name) put(m, k, v)
  if (to !== null) put(m, name, { enabled: to === 'on' })
  const next: Json = {}
  if (Object.keys(m).length > 0) next.mcp = m
  if (prior?.permission) next.permission = prior.permission
  return { payload: cleanOpencodeEntries(next), changed: true }
}
