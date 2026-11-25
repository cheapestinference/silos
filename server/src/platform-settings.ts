// platform-settings.ts — the install's own settings (~/.silos/settings.json,
// 0600): the UNATTENDED PROVIDER —
// what every turn with nobody in front (heartbeats, task wakes, automations)
// runs on unless the turn names its own. `null` = each agent's own
// account. The server is its only writer (seal regime `restore`,
// seal-regimes.ts): it is written through atomicWriteJson, so the seal
// writes it in its contract order.
//
// The switch applies PER ENGINE: an agent whose engine cannot
// run the chosen provider (providerIdError) keeps its own cascade, and
// Settings says so beside the switch. A provider id that stops existing
// (an account removed, a key deleted) is skipped the same way at read time
// — a turn never breaks over the setting.
//
// And the user's STARTING SET (spec tools-origin §8): per engine, per class
// the engine declares (Harness.loads.startingSet), whether a NEW project
// loads it — `startingSet: { <engine id>: { <class id>: boolean } }`. An
// absent class follows Silos' recommendation. Read at a birth by the one
// seam (starting-set.ts); its house is Settings › Accounts & providers.
//
// And the PROJECTS FOLDER (`projectsDir`): where the next new project is
// born, as a real path; absent = `<home>/Silos`. Read per use through
// projectsFolderOf (project-folder.ts, the one source), judged before it is
// stored by checkProjectsDir. Changing it moves nothing: every existing
// project stays where its agents' records say. Its house is Settings ›
// Territory. Never an env var.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson, backupCorruptJson } from './json-store.js'
import { providerPrices, type ProvidersStore } from './providers-store.js'
import { providerIdError } from './providers-validate.js'
import type { HarnessId, StartingSetClass } from './harnesses/contract.js'
import { findHarness, harnessById, harnessOf } from './harnesses/registry.js'
import type { Agent } from './types.js'

/** per engine, per class: loaded in a new project (true) or not */
export type StartingSetChoice = Record<string, Record<string, boolean>>

export interface PlatformSettings {
  unattendedProvider: string | null
  startingSet: StartingSetChoice
  projectsDir: string | null
}

export const NO_SUCH_PROVIDER = 'no such provider'
export const runsOnNoEngine = (label: string): string => `${label} runs on none of your agents' engines — pick one that does`

export class PlatformSettingsStore {
  private file: string
  private value: PlatformSettings = { unattendedProvider: null, startingSet: {}, projectsDir: null }

  constructor(dataDir: string) {
    this.file = join(dataDir, 'settings.json')
  }

  load(): void {
    this.value = { unattendedProvider: null, startingSet: {}, projectsDir: null }
    if (!existsSync(this.file)) return
    const text = readFileSync(this.file, 'utf8')
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      backupCorruptJson(this.file, text, 'platform-settings', { mode: 0o600 })
      return
    }
    const u = (raw as { unattendedProvider?: unknown } | null)?.unattendedProvider
    if (typeof u === 'string' && u.trim() !== '') this.value.unattendedProvider = u.trim()
    this.value.startingSet = readStartingSet((raw as { startingSet?: unknown } | null)?.startingSet)
    // a hand edit's stray value (not an absolute path) is dropped: the default stands
    const d = (raw as { projectsDir?: unknown } | null)?.projectsDir
    if (typeof d === 'string' && d.trim().startsWith('/')) this.value.projectsDir = d.trim().replace(/(.)\/+$/, '$1')
  }

  get(): PlatformSettings {
    return { unattendedProvider: this.value.unattendedProvider, startingSet: copySet(this.value.startingSet), projectsDir: this.value.projectsDir }
  }

  /** the chosen Projects folder, or null (the default, `<home>/Silos`) —
   *  read through projectsFolderOf, never on its own */
  projectsDir(): string | null {
    return this.value.projectsDir
  }

  /** Stores an already-judged real path (checkProjectsDir), or null back to
   *  the default. Moves nothing. */
  setProjectsDir(path: string | null): void {
    this.value = { ...this.value, projectsDir: path }
    this.save()
  }

  /** the user's choices for one engine (absent classes follow Recommended) */
  startingSet(engine: string): Record<string, boolean> {
    return { ...(this.value.startingSet[engine] ?? {}) }
  }

  /** Merges an already-validated patch (startingSetError): a boolean sets
   *  a class, null takes it back to Recommended. */
  setStartingSet(patch: Record<string, Record<string, boolean | null>>): void {
    const next = copySet(this.value.startingSet)
    for (const [engine, classes] of Object.entries(patch)) {
      const e = { ...(next[engine] ?? {}) }
      for (const [id, v] of Object.entries(classes)) {
        if (v === null) delete e[id]
        else e[id] = v
      }
      if (Object.keys(e).length > 0) next[engine] = e
      else delete next[engine]
    }
    this.value = { ...this.value, startingSet: next }
    this.save()
  }

  unattendedProvider(): string | null {
    return this.value.unattendedProvider
  }

  setUnattendedProvider(id: string | null): void {
    this.value = { ...this.value, unattendedProvider: id }
    this.save()
  }

  private save(): void {
    atomicWriteJson(
      this.file,
      {
        unattendedProvider: this.value.unattendedProvider,
        ...(Object.keys(this.value.startingSet).length > 0 ? { startingSet: this.value.startingSet } : {}),
        ...(this.value.projectsDir !== null ? { projectsDir: this.value.projectsDir } : {}),
      },
      { mode: 0o600 },
    )
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const copySet = (s: StartingSetChoice): StartingSetChoice => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, { ...v }]))

/** The file's starting set, tolerantly: only booleans under plain names
 *  (a hand edit's stray value is dropped, never a crash). */
function readStartingSet(raw: unknown): StartingSetChoice {
  const out: StartingSetChoice = Object.create(null) as StartingSetChoice
  if (!isRecord(raw)) return {}
  for (const [engine, classes] of Object.entries(raw)) {
    if (!isRecord(classes)) continue
    const e: Record<string, boolean> = {}
    for (const [id, v] of Object.entries(classes)) if (typeof v === 'boolean') e[id] = v
    if (Object.keys(e).length > 0) out[engine] = e
  }
  return { ...out }
}

/** The classes an engine declares for the starting set ([] = none). */
export function startingClassesOf(engine: string): readonly StartingSetClass[] {
  return findHarness(engine)?.loads?.startingSet?.classes ?? []
}

/** PATCH /api/settings `startingSet`: `{ <engine>: { <class>: boolean |
 *  null } }` — each engine registered, each class one that engine
 *  declares. Returns the error (400) or null. */
export function startingSetError(raw: unknown): string | null {
  if (!isRecord(raw)) return 'startingSet must be an object: { <engine>: { <class>: true | false | null } }'
  for (const [engine, classes] of Object.entries(raw)) {
    const h = findHarness(engine)
    if (!h) return `unknown engine: ${engine}`
    const declared = startingClassesOf(engine)
    if (declared.length === 0) return `${h.label} declares nothing a new project starts with`
    if (!isRecord(classes)) return `startingSet.${engine} must be an object of classes`
    for (const [id, v] of Object.entries(classes)) {
      if (!declared.some((c) => c.id === id)) return `${h.label} has no class "${id}" (it has ${declared.map((c) => c.id).join(', ')})`
      if (v !== null && typeof v !== 'boolean') return `startingSet.${engine}.${id} must be true, false or null (back to recommended)`
    }
  }
  return null
}

/** The provider the install's switch puts an agent's unattended turn on, or
 *  null (no switch, a provider that no longer exists, or one this agent's
 *  engine cannot run — its own cascade stands). */
export function switchFor(id: string | null, harness: HarnessId, providers: Pick<ProvidersStore, 'resolve'> | undefined): string | null {
  if (id === null || !providers) return null
  return providerIdError(id, harness, providers) === null ? id : null
}

/** Whether an agent's unattended turns PRICE (providerPrices) — by the same
 *  resolution ChatService.send makes: a turn's own `runsOn.provider`,
 *  else the install's switch when the agent's engine can run it, else the
 *  agent's own provider. The fallback chain is not looked ahead: the brake's
 *  words follow the primary, and each turn records what it really ran on. */
export function unattendedPrices(
  agent: Pick<Agent, 'provider' | 'framework'>,
  o: { runsOnProvider?: string; switchId: string | null; providers: Pick<ProvidersStore, 'resolve'> | undefined },
): boolean {
  if (!o.providers) return false
  let h: HarnessId | null = null
  try {
    h = harnessOf(agent)
  } catch {
    h = null
  }
  const id = o.runsOnProvider ?? (h !== null ? switchFor(o.switchId, h, o.providers) : null) ?? agent.provider
  return providerPrices(o.providers.resolve(id))
}

/** The engines (labels) that keep their own account under the switch — the
 *  line beside it in Settings: «agents on <engine> keep their own account». */
export function enginesKeepingOwn(id: string | null, inUse: readonly HarnessId[], providers: Pick<ProvidersStore, 'resolve'> | undefined): string[] {
  if (id === null || !providers || providers.resolve(id) === null) return []
  return inUse.filter((h) => switchFor(id, h, providers) === null).map((h) => harnessById(h).label)
}

/** PATCH /api/settings `unattendedProvider`: null, or a provider that
 *  exists and runs on at least ONE engine in use. Returns the error (400) or
 *  null. */
export function unattendedProviderError(raw: unknown, inUse: readonly HarnessId[], providers: Pick<ProvidersStore, 'resolve'> | undefined): string | null {
  if (raw === null) return null
  if (typeof raw !== 'string' || raw.trim() === '' || !providers) return NO_SUCH_PROVIDER
  const p = providers.resolve(raw.trim())
  if (p === null) return NO_SUCH_PROVIDER
  if (inUse.length > 0 && inUse.every((h) => switchFor(raw.trim(), h, providers) === null)) return runsOnNoEngine(p.label)
  return null
}
