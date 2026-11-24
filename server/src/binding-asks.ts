// binding-asks.ts — the binding an agent proposes and the owner approves
// (t43; the design and its contrarian round, whose four pieces are part of
// it).
//
// An agent that needs the owner to SIGN a Vault entry says so where Silos
// reads it — its task's `waitingOn` on the owner — and may carry the exact
// shape its code consumes:
//
//   "waitingOn": { "owner": "owner", "action": "…", "asked": "…",
//     "binding": { "entry": "LEDGER_API_KEY", "baseUrl": "https://mcp.ledgerly.com",
//                  "inject": { "header": "authorization", "format": "Bearer %s" } } }
//
// One source per rule: the task declares the wait, the Vault only reads and
// paints it. A proposal never holds a credential value (host, header, format
// only), is shown IN CLEAR, and only PREFILLS the Vault's editor — the
// owner's save is the only write (writeOwn unchanged: an agent's ask never
// becomes an owner's write). What this module decides:
//
//   - which tasks carry a proposal, read from the file: an OPEN task whose
//     waitingOn names the owner (`owner`, the word the plans use for the
//     person running Silos) and holds `binding.entry`; the shape is checked
//     with the Vault's own validator (validateBinding) — a malformed one is a
//     problem said on the row, never a reason to refuse the file;
//   - the entry it targets: the resolver's winner for the asking agent over
//     its folders (VaultStore.winnerOf — the entry it would actually sign
//     with). A name that is not in the Vault, or not where the agent sees
//     it, or a public entry, is a BROKEN ask: a problem on the row, never a
//     prefilled editor toward an entry that would be created on the fly;
//   - «never seen on this install»: a proposed host whose registrable domain
//     no Vault binding has ever been signed for and no engine documents
//     (harnesses/*/network.ts) — the prefill reduces the owner's attention to
//     a tap, so a first-time host must be impossible not to see (contrarian
//     attack 1). The provenance line (project#tN, the task's owner) is
//     INFORMATIVE: a plan file is the project's, its authorship unsigned;
//   - resolution: ANY successful save of the target entry's binding resolves
//     every open ask on it — whatever values the owner saved (attack 4: an
//     owner's legitimate edit must not leave the task hanging). The wake is a
//     signal, not a guarantee: the woken agent verifies with a first signed
//     call. The write is the owner's answer to a wait — the house's one verb
//     (silos/actions.ts taskGesture 'answer', ONE write): an owner note —
//     which wakes a bound owner through task mode's own owner-note event —,
//     the wait cleared, `pending` when it was blocked and nothing else holds
//     it (or in review).
import { taskSnapshots } from './task-mode/engine.js'
import type { SiloReading } from './silos/reader.js'
import { recordKey } from './silos/journal.js'
import { validateBinding, validateEntryName, type VaultBinding, type VaultEntry } from './vault-store.js'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const CLOSED = new Set(['done', 'cancelled'])

// the person running Silos, as the plans name them (team-plan: «always that
// word, never their name»)
export const OWNER_WORD = 'owner'

/** A proposal as the file says it, checked. `problem` set = a broken ask. */
export interface ProposedBinding {
  entry: string
  baseUrl: string | null // normalized (validateBinding) — null: the ask names the entry only
  inject: { header: string; format: string } | null
  problem: string | null
}

/** One task of the plans as this module reads it. */
export interface AskTask {
  key: string // the plans record key: <plan key>/tasks/<id>
  planKey: string
  id: string
  ref: string // <project>#t5
  title: string
  owner: string // the task's owner — the asking agent
  state: string
  folder: string | null
  dependsOn: string[]
  nextCheckAt: string | null
  waitingOn: unknown // raw, as written
}

/** A live proposal, for the task's row and the Vault. Never a value. */
export interface BindingAsk {
  key: string
  ref: string
  title: string
  owner: string // provenance: whose task asks (informative — the file is unsigned)
  folder: string | null
  asked: string | null // the question in the file's words
  entry: string
  baseUrl: string | null
  inject: { header: string; format: string } | null
  host: string | null // the proposed hostname
  registrable: string | null // its registrable domain — the hero
  // a host no Vault binding was ever signed for and no engine documents
  neverSeen: boolean
  // the entry a save resolves this ask on (null: broken — none to sign)
  entryId: string | null
  // that entry's binding as it stands — the «before» of the editor's diff
  current: VaultBinding | null
  problem: string | null // a broken ask, in words — never a prefilled editor
}

/** The proposal carried by a task's waitingOn, or null when there is none
 *  (no binding, or a wait on someone other than the owner: only the owner
 *  signs). */
export function proposedBindingOf(waitingOn: unknown): ProposedBinding | null {
  if (!isObj(waitingOn)) return null
  if (typeof waitingOn.owner !== 'string' || waitingOn.owner.trim() !== OWNER_WORD) return null
  const b = waitingOn.binding
  if (b === undefined || b === null) return null
  const broken = (entry: string, problem: string): ProposedBinding => ({ entry, baseUrl: null, inject: null, problem })
  if (!isObj(b)) return broken('', 'waitingOn.binding must be { entry, baseUrl?, inject? }')
  const entry = typeof b.entry === 'string' ? b.entry.trim() : ''
  if (entry === '') return broken('', 'waitingOn.binding.entry is missing — the ask names no Vault entry')
  const nameError = validateEntryName(entry)
  if (nameError) return broken(entry, `waitingOn.binding.entry: ${nameError}`)
  if (b.baseUrl === undefined || b.baseUrl === null) {
    if (b.inject !== undefined && b.inject !== null) return broken(entry, 'waitingOn.binding.inject without a baseUrl — a signing needs the host it signs for')
    return { entry, baseUrl: null, inject: null, problem: null }
  }
  // the Vault's own rules (no credentials or query in the URL, a header
  // token, %s exactly once, no control character) — a placeholder value:
  // the proposal never carries the real one
  const hasInject = b.inject !== undefined && b.inject !== null
  const v = validateBinding({ baseUrl: b.baseUrl, inject: hasInject ? b.inject : { header: 'Authorization', format: 'Bearer %s' } }, 'x')
  if (typeof v === 'string') return broken(entry, v.replace(/^binding\./, 'waitingOn.binding.'))
  return { entry, baseUrl: v.baseUrl, inject: hasInject ? v.inject : null, problem: null }
}

// ---- registrable domains ---------------------------------------------------
// Two-label public suffixes common enough to matter for «never seen» — a
// short list, not the Public Suffix List: a miss here only makes the
// registrable domain one label SHORTER (example.co.uk read as co.uk), which
// can only make a host look seen when a sibling under the same suffix was
// signed. Kept small on purpose; the host itself is always shown whole.
const TWO_LABEL_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'me.uk',
  'ltd.uk',
  'plc.uk',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'org.nz',
  'co.jp',
  'ne.jp',
  'or.jp',
  'com.br',
  'com.mx',
  'com.ar',
  'com.co',
  'co.za',
  'com.cn',
  'com.tr',
  'co.in',
  'co.kr',
  'com.sg',
  'com.hk',
  'com.tw',
  'com.es',
  'org.es',
  'nom.es',
  'gob.es',
  'edu.es',
  'com.pt',
  'co.il',
  'com.pl',
])

/** The registrable domain of a hostname (example.com for api.example.com;
 *  example.co.uk for a.example.co.uk); an IP literal or a one-label name is
 *  itself. Lower-cased, a trailing dot dropped. */
export function registrableDomain(hostname: string): string {
  const h = hostname
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '')
  if (h === '' || h.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return h
  const labels = h.split('.').filter((l) => l !== '')
  if (labels.length <= 2) return labels.join('.')
  const lastTwo = labels.slice(-2).join('.')
  return TWO_LABEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo
}

/** An engine's documented host (may be a wildcard: `*.opencode.ai`,
 *  `*-review.googlesource.com`) as a hostname to take the domain of. */
function engineHostName(host: string): string {
  const h = host.trim().toLowerCase()
  if (!h.startsWith('*')) return h
  const dot = h.indexOf('.')
  return dot < 0 ? h.replace(/^\*+/, '') : h.slice(dot + 1)
}

const hostnameOf = (baseUrl: string): string | null => {
  try {
    return new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** The registrable domains this install has seen: every Vault binding's host
 *  and every engine's documented host. */
export function seenDomains(entries: readonly VaultEntry[], engineHosts: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const e of entries) {
    if (!e.binding) continue
    const h = hostnameOf(e.binding.baseUrl)
    if (h) out.add(registrableDomain(h))
  }
  for (const h of engineHosts) {
    const name = engineHostName(h)
    if (name !== '') out.add(registrableDomain(name))
  }
  return out
}

// ---- reading the plans -----------------------------------------------------

/** Every plan task of the Plans silo's reading, with its raw waitingOn and
 *  the ref people say (`<project>#t5` — taskSnapshots' refs). */
export function askTasksOf(reading: SiloReading, standing?: ReadonlySet<string>): AskTask[] {
  const raw = new Map<string, unknown>()
  for (const r of reading.records) {
    if (r.kind !== 'plan') continue
    const planKey = recordKey(r)
    for (const t of (Array.isArray(r.record.tasks) ? r.record.tasks : []).filter(isObj)) {
      if (typeof t.id === 'string' && t.id !== '') raw.set(`${planKey}/tasks/${t.id}`, t.waitingOn)
    }
  }
  return taskSnapshots(reading, undefined, undefined, standing).map((s) => ({
    key: s.key,
    planKey: s.planKey,
    id: s.id,
    ref: s.ref,
    title: s.title,
    owner: s.owner,
    state: s.state,
    folder: s.folder,
    dependsOn: s.dependsOn,
    nextCheckAt: s.nextCheckAt,
    waitingOn: raw.get(s.key),
  }))
}

export interface AskContext {
  entries: readonly VaultEntry[]
  // the resolver's winner for a caller (VaultStore.winnerOf)
  winnerOf: (name: string, agentId: string | null, folders: string[]) => VaultEntry | null
  // a live agent's folders (its territories), null for anyone else
  foldersOf: (agentId: string) => string[] | null
  // every engine's documented hosts (harnesses/*/network.ts)
  engineHosts: readonly string[]
}

/** The live proposals: the OPEN tasks whose waitingOn on the owner carries a
 *  binding, each with its target entry, its problem when broken, and the
 *  «never seen» mark. In the plans' order. */
export function bindingAsksOf(tasks: readonly AskTask[], ctx: AskContext): BindingAsk[] {
  const seen = seenDomains(ctx.entries, ctx.engineHosts)
  const out: BindingAsk[] = []
  for (const t of tasks) {
    if (CLOSED.has(t.state)) continue
    const p = proposedBindingOf(t.waitingOn)
    if (!p) continue
    const w = t.waitingOn as Json
    const asked = typeof w.asked === 'string' && w.asked.trim() !== '' ? w.asked.trim() : null
    // the entry it targets: what the asking agent would sign with
    const agentFolders = ctx.foldersOf(t.owner)
    const folders = [...new Set([...(agentFolders ?? []), ...(t.folder ? [t.folder] : [])])]
    let target: VaultEntry | null = null
    let problem = p.problem
    if (p.entry !== '' && validateEntryName(p.entry) === null) {
      target = ctx.winnerOf(p.entry, agentFolders ? t.owner : null, folders)
      if (!target) {
        const anywhere = ctx.entries.some((e) => e.name === p.entry)
        problem = anywhere
          ? `${p.entry} is in the Vault, but not where ${t.owner} sees it — signing that one would never reach this task.`
          : `${p.entry} is not in the Vault. This ask names an entry that does not exist — add it first, then sign it.`
      } else if (target.public) {
        problem = `${p.entry} is marked «Not a secret» — configuration is never signed.`
        target = null
      }
    }
    const host = p.baseUrl ? hostnameOf(p.baseUrl) : null
    const registrable = host ? registrableDomain(host) : null
    out.push({
      key: t.key,
      ref: t.ref,
      title: t.title,
      owner: t.owner,
      folder: t.folder,
      asked,
      entry: p.entry,
      baseUrl: p.baseUrl,
      inject: p.inject,
      host,
      registrable,
      neverSeen: registrable !== null && !seen.has(registrable),
      entryId: target?.id ?? null,
      current: target?.binding ?? null,
      problem,
    })
  }
  return out
}

// ---- resolution on save ----------------------------------------------------

export type WriteResult = { ok: true } | { ok: false; reason: string }
export interface WaitWriter {
  // the owner's answer to the task's wait (taskGesture 'answer'): the note,
  // the wait cleared and the state — in ONE write. `state` is the task's
  // state as written after it (what «unblocked» is read from, M18)
  answer: (key: string, text: string) => { ok: true; state: string } | { ok: false; reason: string }
}

export interface Resolution {
  resolved: Array<{ key: string; ref: string; owner: string; unblocked: boolean }>
  failed: Array<{ key: string; ref: string; reason: string }>
}

/** The note the save leaves on each task it resolves — the agent's channel.
 *  It says what was SAVED (which may not be what was proposed) and that the
 *  agent verifies; never a value. */
export function savedNoteOf(saved: Pick<VaultEntry, 'name'> & { binding: VaultBinding }): string {
  return `Signed in the Vault: ${saved.name} → ${saved.binding.baseUrl} · ${saved.binding.inject.header}: ${saved.binding.inject.format}. This wait is cleared. What was saved may differ from what you proposed — check that a first signed call works before going on.`
}

/** After a SUCCESSFUL save of `saved`'s binding: every open ask targeting it
 *  is answered — note, wait cleared, pending when nothing else holds it.
 *  `asks` are read AFTER the save (an entry created by the save is a target
 *  too); `tasks` give the siblings' states for the recompute. A failed step
 *  is said per task and the rest go on. */
export function resolveBindingWaits(saved: VaultEntry, asks: readonly BindingAsk[], tasks: readonly AskTask[], w: WaitWriter): Resolution {
  const out: Resolution = { resolved: [], failed: [] }
  if (!saved.binding) return out
  const binding = saved.binding
  const byKey = new Map(tasks.map((t) => [t.key, t]))
  for (const a of asks) {
    if (a.entryId !== saved.id) continue
    const t = byKey.get(a.key)
    if (!t || CLOSED.has(t.state)) continue
    const r = w.answer(a.key, savedNoteOf({ name: saved.name, binding }))
    if (!r.ok) {
      out.failed.push({ key: a.key, ref: a.ref, reason: r.reason })
      continue
    }
    const unblocked = t.state === 'blocked' && r.state !== 'blocked'
    out.resolved.push({ key: a.key, ref: a.ref, owner: a.owner, unblocked })
  }
  return out
}
