// vault-store.ts — the Vault: environment credentials agents need to do
// their job (a Stripe key for the Finance, a Railway token for a project),
// stored owner-only (~/.silos/vault.json, chmod 0600) and injected as
// ENVIRONMENT into agent processes on BOTH engines — SDK chat sessions and
// real-console spawns. Values never leave the server unmasked (every API
// response goes through maskEntry — same discipline as providers.json).
//
// Scopes, and precedence on a name collision (most specific wins):
//   agents > folder > global
// A folder scope applies to the exact folder and anything under it (path
// boundary respected — /a/foo never matches /a/foobar). An agents scope
// names the agents that SEE the entry (one vault, manageable
// visibility — never one vault per agent); the legacy single-agent form
// {type:'agent'} is still accepted as input and on disk, normalized to a
// one-element list. Two agents entries naming the same agent with the same
// name: the SHORTER list wins (more specific), then the newer entry. Two
// folder entries of one name covering the agent (nested folders): the
// DEEPEST folder wins, then the newer entry (one
// resolver, `resolve`, for envFor, viewFor and the signer).
//
// An agent's own scope (agents may have their own scope inside the
// vault): an agent may WRITE entries visible to itself
// alone — `{type:'agents', agentIds:[self]}`, `createdBy: self` — and
// replace or delete only those it wrote. Everything the owner put there
// (createdBy absent), every shared or folder entry, stays the owner's: an
// agent never edits a secret it did not write, and never pushes one into
// another agent's env. Still ONE vault — the agent's part is a scope in it.
//
// Delivered or SIGNED: an entry with a `binding` no
// longer travels in any env — Silos signs the agent's calls to the bound host
// with it (routes/egress.ts, `/api/egress/<NAME>/…`). One source per rule: a
// signed entry is out of envFor/secretsFor, and the winner per name is
// resolved FIRST — a signed winner never uncovers a delivered entry of an
// outer scope, nor the other way round.
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs'
import { sealHooks } from './seal-hooks.js'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { maskKey } from './providers-store.js'
import { backupCorruptJson } from './json-store.js'

export type VaultScope = { type: 'global' } | { type: 'folder'; folder: string } | { type: 'agents'; agentIds: string[] }

// How a signed entry reaches its service: Silos forwards the agent's call to
// `baseUrl` + the rest of the path with `header: format(value)` added. The
// host is fixed here — the agent only brings the path and the query. v1 is
// header-only (a credential that rides the query stays delivered).
export interface VaultBinding {
  baseUrl: string // scheme + host (+ an optional base path, no trailing /), no query/credentials
  inject: { header: string; format: string } // format holds %s exactly once
}

export interface VaultEntry {
  id: string
  name: string // the env var name the agent sees
  value: string
  scope: VaultScope
  createdAt: string
  // the agent that wrote it through its own scope; absent = the owner
  createdBy?: string
  // the owner judged it plain configuration (a project id, an email): it
  // still rides only into the env of its scope, but it is shown in clear,
  // never masked in logs, and an export or a template may hold it. Absent =
  // secret — only the owner says otherwise, Silos never guesses from a value.
  public?: true
  // signed by Silos instead of handed over
  binding?: VaultBinding
}

// One entry as an agent sees it — masked, plus whether it may replace/delete
// it (only what it wrote in its own scope). A signed one carries its binding.
export interface AgentVaultEntry extends VaultEntry {
  source: 'agent' | 'project' | 'global'
  mine: boolean
}

// A name an agent can count on, by class (its brief teaches both).
export interface VaultCredential {
  name: string
  signed: boolean
}

// Who sees an entry and whether they can sign — the roster's knowledge,
// handed to the store by the route when a binding is set or moved.
export interface SigningIdentity {
  /** a live agent holding its bearer: the only kind of caller /api/egress serves */
  hasIdentity(agentId: string): boolean
  /** the agents a folder/global entry reaches TODAY (its audience is open: future ones too) */
  agentsSeeing(scope: VaultScope): string[]
}

// The signer's answer for a name: the winner with its binding, or why not.
export type SignerLookup = { entry: VaultEntry & { binding: VaultBinding } } | { refused: 'not-visible' | 'not-signed' }

// Env var names: conventional UPPER_SNAKE, and never the ones that belong
// to other machinery — CLAUDE*/ANTHROPIC_* are the provider/auth layer's
// (cleanEnv and envForProvider own them), SILOS_* is Silos' own wiring (an
// agent's shell keeps only the agent-facing SILOS_* names and blanks the
// rest — plugin-opencode/silos.ts silosEnv — so a Vault entry there would
// reach one engine's shells and not the other's), and the shell basics
// would break the process rather than configure it.
const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/
const FORBIDDEN_EXACT = new Set(['PATH', 'HOME', 'SHELL', 'TERM', 'USER', 'LOGNAME'])
const FORBIDDEN_PREFIX = ['CLAUDE', 'ANTHROPIC_', 'SILOS_']

export function validateEntryName(name: string): string | null {
  if (!NAME_RE.test(name)) return 'name must be UPPER_SNAKE (letters, digits, _)'
  if (FORBIDDEN_EXACT.has(name)) return `${name} is reserved`
  for (const p of FORBIDDEN_PREFIX)
    if (name.startsWith(p)) return p === 'SILOS_' ? 'SILOS_* names belong to Silos itself' : `${p}* names belong to the provider layer`
  return null
}

// RFC 9110 token: what a header NAME may hold.
const HEADER_TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
// names a binding never sets: the transport's own (framing, hop-by-hop, the
// host the binding itself fixes)
const BINDING_HEADER_FORBIDDEN = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'proxy-authorization',
  'proxy-authenticate',
  'proxy-connection',
])
// a header VALUE: no control character at all (a CR/LF would split the
// request) and nothing outside latin-1 (Node refuses it at send time)
const HEADER_VALUE_BAD_RE = /[\u0000-\u001f\u007f]|[^\u0000-ÿ]/

/** The header value a binding sends for `value` — `%s` replaced once, literally. */
export function injectedValue(binding: VaultBinding, value: string): string {
  const f = binding.inject.format
  const i = f.indexOf('%s')
  return f.slice(0, i) + value + f.slice(i + 2)
}

/** A binding as stored (normalized), or the reason it is refused. `value` is
 *  the entry's secret: the RESULTING header value is checked here, at bind
 *  time — a secret with a line break never splits a request later. */
export function validateBinding(input: unknown, value: string): VaultBinding | string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return 'binding must be { baseUrl, inject: { header, format } }'
  const o = input as Record<string, unknown>
  if (typeof o.baseUrl !== 'string') return 'binding.baseUrl required'
  let u: URL
  try {
    u = new URL(o.baseUrl)
  } catch {
    return 'binding.baseUrl must be an absolute http(s) URL'
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'binding.baseUrl must be http(s)'
  if (u.username !== '' || u.password !== '') return 'binding.baseUrl must not carry credentials'
  if (u.search !== '' || u.hash !== '' || o.baseUrl.includes('?') || o.baseUrl.includes('#'))
    return 'binding.baseUrl must not carry a query or a fragment — v1 signs with a header only'
  if (u.hostname === '') return 'binding.baseUrl needs a host'
  const inj = o.inject
  if (typeof inj !== 'object' || inj === null || Array.isArray(inj)) return 'binding.inject must be { header, format }'
  const i = inj as Record<string, unknown>
  const header = typeof i.header === 'string' ? i.header.trim() : ''
  if (!HEADER_TOKEN_RE.test(header)) return 'binding.inject.header must be an HTTP header name (token characters only)'
  if (BINDING_HEADER_FORBIDDEN.has(header.toLowerCase())) return `binding.inject.header cannot be ${header} — it belongs to the transport`
  const format = i.format === undefined ? '%s' : i.format
  if (typeof format !== 'string') return 'binding.inject.format must be a string'
  if (format.split('%s').length !== 2) return 'binding.inject.format must hold %s exactly once'
  const binding: VaultBinding = { baseUrl: `${u.origin}${u.pathname.replace(/\/+$/, '')}`, inject: { header, format } }
  if (HEADER_VALUE_BAD_RE.test(injectedValue(binding, value)))
    return 'the signed header would carry a line break or a control character — this value cannot be signed as a header'
  return binding
}

export function maskEntry(e: VaultEntry): VaultEntry {
  return e.public ? { ...e } : { ...e, value: maskKey(e.value) }
}

// Accepts both wire forms and returns the normalized one: the legacy
// single-agent scope becomes a one-element agents list, so the store,
// envFor and the API speak ONE shape.
function validScope(v: unknown): VaultScope | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (o.type === 'global') return { type: 'global' }
  if (o.type === 'folder' && typeof o.folder === 'string' && o.folder.startsWith('/')) return { type: 'folder', folder: o.folder }
  if (o.type === 'agent' && typeof o.agentId === 'string' && o.agentId.trim() !== '') return { type: 'agents', agentIds: [o.agentId] }
  if (o.type === 'agents' && Array.isArray(o.agentIds)) {
    // dedup + sort = one canonical form per visibility, so the duplicate
    // check below can compare scopes by their JSON.
    const ids = [...new Set(o.agentIds.filter((x): x is string => typeof x === 'string' && x.trim() !== ''))].sort()
    if (ids.length > 0) return { type: 'agents', agentIds: ids }
  }
  return null
}

// A binding read back from disk: the shape only (it was validated when set).
function storedBinding(v: unknown): VaultBinding | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const o = v as Record<string, unknown>
  const inj = o.inject as Record<string, unknown> | null | undefined
  if (typeof o.baseUrl !== 'string' || typeof inj !== 'object' || inj === null || typeof inj.header !== 'string' || typeof inj.format !== 'string')
    return undefined
  return { baseUrl: o.baseUrl, inject: { header: inj.header, format: inj.format } }
}

export function underFolder(cwd: string, folder: string): boolean {
  return cwd === folder || cwd.startsWith(folder.endsWith('/') ? folder : `${folder}/`)
}

const folderDepth = (folder: string): number => folder.split('/').filter((s) => s !== '').length

type Winner = { entry: VaultEntry; source: AgentVaultEntry['source'] }

export class VaultStore {
  private entries: VaultEntry[] = []

  constructor(private path: string) {}

  load(): void {
    if (!existsSync(this.path)) return
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch {
      this.entries = [] // an unreadable vault is an empty vault, never a crash
      return
    }
    try {
      const raw = JSON.parse(text) as { entries?: unknown }
      if (Array.isArray(raw.entries)) {
        // normalize on the way in: a legacy {type:'agent'} on disk becomes a
        // one-element agents list in memory (and on the next save).
        this.entries = raw.entries.flatMap((e): VaultEntry[] => {
          const o = e as Partial<VaultEntry>
          if (typeof o.id !== 'string' || typeof o.name !== 'string' || typeof o.value !== 'string') return []
          const scope = validScope(o.scope)
          if (!scope) return []
          const binding = storedBinding(o.binding)
          return [
            {
              id: o.id,
              name: o.name,
              value: o.value,
              scope,
              createdAt: typeof o.createdAt === 'string' ? o.createdAt : '',
              ...(typeof o.createdBy === 'string' && o.createdBy !== '' ? { createdBy: o.createdBy } : {}),
              ...(o.public === true ? { public: true as const } : {}),
              ...(binding ? { binding } : {}),
            },
          ]
        })
      }
      // the file may have been created by hand with lax permissions — reassert.
      try {
        chmodSync(this.path, 0o600)
      } catch {
        /* best effort */
      }
    } catch {
      // corrupt: keep the only copy (0600 — it holds secrets) before reading
      // as empty; the next save replaces the file.
      backupCorruptJson(this.path, text, 'vault', { mode: 0o600 })
      this.entries = []
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    // under the seal (seals.ts): the seal writes it, in its order
    if (sealHooks().write?.(this.path, JSON.stringify({ entries: this.entries }, null, 2), 0o600)) return
    const tmp = join(dirname(this.path), `.vault-${randomUUID()}.tmp`)
    writeFileSync(tmp, JSON.stringify({ entries: this.entries }, null, 2), { mode: 0o600 })
    renameSync(tmp, this.path)
    try {
      chmodSync(this.path, 0o600)
    } catch {
      /* best effort */
    }
  }

  list(): VaultEntry[] {
    return [...this.entries]
  }

  // `binding` signs the entry from birth (rules: checkBinding); `warnings`,
  // when given, receives the agents that would see it without being able to
  // sign (folder/global scopes — never a silent lockout).
  create(
    input: { name?: unknown; value?: unknown; scope?: unknown; public?: unknown; binding?: unknown },
    identity?: SigningIdentity,
    warnings?: string[],
  ): VaultEntry {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    const nameError = validateEntryName(name)
    if (nameError) throw new Error(nameError)
    if (typeof input.value !== 'string' || input.value === '') throw new Error('value required')
    const scope = validScope(input.scope)
    if (!scope) throw new Error('invalid scope')
    // one value per name per exact scope — replacing is an explicit delete+create.
    if (this.entries.some((e) => e.name === name && JSON.stringify(e.scope) === JSON.stringify(scope))) {
      throw new Error('an entry with this name already exists in that scope')
    }
    const entry: VaultEntry = {
      id: randomUUID(),
      name,
      value: input.value,
      scope,
      createdAt: new Date().toISOString(),
      ...(input.public === true ? { public: true as const } : {}),
    }
    if (input.binding !== undefined && input.binding !== null) entry.binding = this.checkBinding(entry, input.binding, identity, warnings)
    this.entries.push(entry)
    this.save()
    return entry
  }

  // The binding rules for `entry` as it stands: never
  // on a public entry; the value checked as the header it would become; and
  // the identity rule for its scope (identityCheck). Throws the refusal.
  private checkBinding(entry: VaultEntry, input: unknown, identity: SigningIdentity | undefined, warnings: string[] | undefined): VaultBinding {
    if (entry.public) throw new Error('a public entry is configuration, not a secret — it is not signed')
    const b = validateBinding(input, entry.value)
    if (typeof b === 'string') throw new Error(b)
    // evaluated first: `warnings?.push(...check())` would skip the check itself
    const w = this.identityCheck(entry.scope, identity)
    warnings?.push(...w)
    return b
  }

  // Only an agent with its identity can sign. In an agents scope the list is
  // closed: an agent there without one is REFUSED, by name. A folder/global
  // audience is open (agents present and future): the ones that see it today
  // without being able to sign come back as warnings, and the bind goes on.
  private identityCheck(scope: VaultScope, identity: SigningIdentity | undefined): string[] {
    if (!identity) return []
    if (scope.type === 'agents') {
      const without = scope.agentIds.filter((id) => !identity.hasIdentity(id))
      if (without.length > 0)
        throw new Error(
          `signing needs the agent's identity — ${without.join(', ')} ${without.length === 1 ? 'has' : 'have'} none (an archived or unknown agent never signs)`,
        )
      return []
    }
    return identity
      .agentsSeeing(scope)
      .filter((id) => !identity.hasIdentity(id))
      .map((id) => `${id} sees this entry but cannot sign with it — signing needs the agent's identity`)
  }

  // Delivered ⇄ signed, in place (changing the mode is editing the
  // binding). null removes it — delivered again. The value never changes here.
  setBinding(id: string, input: unknown, identity?: SigningIdentity, warnings?: string[]): VaultEntry {
    const entry = this.entries.find((e) => e.id === id)
    if (!entry) throw new Error('entry not found')
    if (input === null) delete entry.binding
    else entry.binding = this.checkBinding(entry, input, identity, warnings)
    this.save()
    return entry
  }

  // The owner's judgement, in place: plain configuration or a secret. The
  // value never changes here.
  setPublic(id: string, isPublic: unknown): VaultEntry {
    const entry = this.entries.find((e) => e.id === id)
    if (!entry) throw new Error('entry not found')
    if (typeof isPublic !== 'boolean') throw new Error('public must be true or false')
    if (isPublic && entry.binding) throw new Error('a signed entry is a secret — remove its binding before calling it configuration')
    if (isPublic) entry.public = true
    else delete entry.public
    this.save()
    return entry
  }

  // The values a log, a template or a pack must never hold: every entry
  // the owner has not judged public.
  secretValues(): Array<{ id: string; name: string; value: string }> {
    return this.entries.filter((e) => !e.public).map((e) => ({ id: e.id, name: e.name, value: e.value }))
  }

  // Change an entry's visibility in place (visibility is
  // manageable, never delete + re-paste the value). The VALUE never changes
  // here — replacing it stays an explicit delete + create. A signed entry
  // moving keeps the identity rule (refused / warnings, as when binding).
  setScope(id: string, input: unknown, identity?: SigningIdentity, warnings?: string[]): VaultEntry {
    const entry = this.entries.find((e) => e.id === id)
    if (!entry) throw new Error('entry not found')
    const scope = validScope(input)
    if (!scope) throw new Error('invalid scope')
    if (this.entries.some((e) => e.id !== id && e.name === entry.name && JSON.stringify(e.scope) === JSON.stringify(scope))) {
      throw new Error('an entry with this name already exists in that scope')
    }
    if (entry.binding) {
      const w = this.identityCheck(scope, identity)
      warnings?.push(...w)
    }
    entry.scope = scope
    this.save()
    return entry
  }

  private isOwnOf(e: VaultEntry, agentId: string): boolean {
    return e.createdBy === agentId && e.scope.type === 'agents' && e.scope.agentIds.length === 1 && e.scope.agentIds[0] === agentId
  }

  // An agent writes into its own scope: a new name is created; a name it
  // already wrote there gets its value replaced in place (cookies and keys
  // rotate — the id stays); a name the OWNER put in that scope is refused
  // (the owner's value is never lost to an agent's write).
  // `binding`: an agent may sign what it wrote — it
  // already held the value; signing only takes it out of its hands. Absent =
  // the binding it had stays (a rotated cookie stays signed, re-checked
  // against the new value); null = delivered again.
  writeOwn(agentId: string, input: { name?: unknown; value?: unknown; binding?: unknown }): { entry: VaultEntry; replaced: boolean } {
    if (agentId.trim() === '') throw new Error('agent required')
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    const nameError = validateEntryName(name)
    if (nameError) throw new Error(nameError)
    if (typeof input.value !== 'string' || input.value === '') throw new Error('value required')
    const existing = this.entries.find((e) => e.name === name && e.scope.type === 'agents' && e.scope.agentIds.length === 1 && e.scope.agentIds[0] === agentId)
    if (existing) {
      if (!this.isOwnOf(existing, agentId)) throw new Error(`${name} was set by the owner — only the owner can change it`)
      const binding = ownBinding(input.binding, existing.binding, input.value)
      existing.value = input.value
      if (binding) existing.binding = binding
      else delete existing.binding
      this.save()
      return { entry: existing, replaced: true }
    }
    const binding = ownBinding(input.binding, undefined, input.value)
    const entry: VaultEntry = {
      id: randomUUID(),
      name,
      value: input.value,
      scope: { type: 'agents', agentIds: [agentId] },
      createdAt: new Date().toISOString(),
      createdBy: agentId,
      ...(binding ? { binding } : {}),
    }
    this.entries.push(entry)
    this.save()
    return { entry, replaced: false }
  }

  // 'not-found' | 'not-yours' | 'removed' — the route maps them to 404/403/200.
  removeOwn(agentId: string, id: string): 'not-found' | 'not-yours' | 'removed' {
    const e = this.entries.find((x) => x.id === id)
    if (!e) return 'not-found'
    if (!this.isOwnOf(e, agentId)) return 'not-yours'
    this.remove(id)
    return 'removed'
  }

  // What this agent holds from the Vault, entry by entry, MASKED — the
  // winner per name over every folder the agent works in. A signed entry is
  // listed too, with its binding (the host, never the value): the agent's to
  // USE through Silos, not to hold.
  viewFor(agentId: string, folders: string[]): AgentVaultEntry[] {
    return [...this.resolve(agentId, folders).values()]
      .map(({ entry, source }) => ({ ...maskEntry(entry), source, mine: this.isOwnOf(entry, agentId) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  // The names an agent can count on, by class — delivered in its env or
  // signed by Silos (a signed entry the agent never
  // learns is an entry that does not exist for it). viewFor's semantics.
  credentialsFor(agentId: string, folders: string[]): VaultCredential[] {
    return [...this.resolve(agentId, folders).values()]
      .map(({ entry }) => ({ name: entry.name, signed: entry.binding !== undefined }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  // The signer's lookup: the winner over ALL the caller's folders first, its
  // binding after — a winner without one is refused, never a fallback to an
  // outer scope. agentId null with no folders = the owner naming no agent:
  // only global entries reach it.
  signerFor(agentId: string | null, folders: string[], name: string): SignerLookup {
    const w = this.resolve(agentId, folders).get(name)
    if (!w) return { refused: 'not-visible' }
    const binding = w.entry.binding
    if (!binding) return { refused: 'not-signed' }
    return { entry: { ...w.entry, binding } }
  }

  // The entry `name` resolves to for this caller — the resolver's winner, as
  // stored (never masked: callers of this read the scope and the binding,
  // the value never leaves the server). A binding ask targets this entry
  // (binding-asks.ts): the one the asking agent would actually sign with.
  winnerOf(name: string, agentId: string | null, folders: string[]): VaultEntry | null {
    return this.resolve(agentId, folders).get(name)?.entry ?? null
  }

  remove(id: string): boolean {
    const before = this.entries.length
    this.entries = this.entries.filter((e) => e.id !== id)
    if (this.entries.length === before) return false
    this.save()
    return true
  }

  // The env an agent process gets: the winner per name, minus the SIGNED
  // winners — those never travel in an env, and their name is not filled
  // from an outer scope either (one source per rule).
  envFor(agentId: string | null, cwd: string | null): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [name, e] of this.winnersFor(agentId, cwd)) out[name] = e.value
    return out
  }

  // The values of envFor that are secrets — what a command's log is
  // redacted of (a public entry shows in clear).
  secretsFor(agentId: string | null, cwd: string | null): string[] {
    return [...this.winnersFor(agentId, cwd).values()].filter((e) => !e.public).map((e) => e.value)
  }

  private winnersFor(agentId: string | null, cwd: string | null): Map<string, VaultEntry> {
    const out = new Map<string, VaultEntry>()
    for (const [name, w] of this.resolve(agentId, cwd === null ? [] : [cwd])) if (!w.entry.binding) out.set(name, w.entry)
    return out
  }

  // THE resolver — one rule, three consumers (envFor, viewFor, the signer).
  // Per name, least → most specific, the last write wins:
  //   global; then folder entries covering one of `folders` (an entry's
  //   folder at or above it), shallowest first — the DEEPEST folder wins, the
  //   newer at equal depth; then the agents tier, longest list first — the
  //   SHORTEST list naming this agent wins, the newer at equal length.
  private resolve(agentId: string | null, folders: string[]): Map<string, Winner> {
    const out = new Map<string, Winner>()
    for (const e of this.entries) if (e.scope.type === 'global') out.set(e.name, { entry: e, source: 'global' })
    const depth = (e: VaultEntry): number => (e.scope.type === 'folder' ? folderDepth(e.scope.folder) : 0)
    const inFolders = this.entries.filter((e) => e.scope.type === 'folder' && folders.some((f) => underFolder(f, (e.scope as { folder: string }).folder)))
    inFolders.sort((a, b) => depth(a) - depth(b) || a.createdAt.localeCompare(b.createdAt))
    for (const e of inFolders) out.set(e.name, { entry: e, source: 'project' })
    if (agentId !== null) {
      const len = (e: VaultEntry): number => (e.scope.type === 'agents' ? e.scope.agentIds.length : 0)
      const mine = this.entries.filter((e) => e.scope.type === 'agents' && e.scope.agentIds.includes(agentId))
      mine.sort((a, b) => len(b) - len(a) || a.createdAt.localeCompare(b.createdAt))
      for (const e of mine) out.set(e.name, { entry: e, source: 'agent' })
    }
    return out
  }
}

// The binding of an agent's own write: the agent writing is the one that
// signs, so the identity rule holds by construction; the value rule is
// re-checked against the NEW value.
function ownBinding(input: unknown, current: VaultBinding | undefined, value: string): VaultBinding | undefined {
  if (input === null) return undefined
  const wanted = input === undefined ? current : input
  if (wanted === undefined) return undefined
  const b = validateBinding(wanted, value)
  if (typeof b === 'string') throw new Error(b)
  return b
}
