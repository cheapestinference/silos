// harnesses/claude-code/instruction-places.ts — Harness.instructions.places
// and .switch for Claude Code: «Where it loads» for each instruction file
// Memory lists (spec memory-places §4, T4), on the scopes spec's model.
//
// Two families, by the engine's own keys (schema; measured by T1 on 2.1.331):
//
//  · an instruction FILE — `claudeMdExcludes`, a list of patterns «to
//    exclude from loading», joined across settings files: OFF-ONLY. Off at
//    any place that reaches a conversation is off; a narrower line with no
//    entry of its own is locked by it; «on» removes the place's own entry
//    and nothing else (rule 12). Its places:
//      – This project: `<folder>/.claude/settings.local.json` through its one
//        writer (local-settings.ts). The row's OWN strings, added and removed
//        again, every other entry kept: a personal file once per login dir;
//        a folder's file as its path AND the same path under the engine's
//        worktree folder (`<folder>/.claude/worktrees/*/<rel>` — a session
//        of the folder working inside a worktree reads that copy); a folder
//        above, or an import outside the folder, its path.
//      – Only <agent>, This conversation: the CHOICE in the payload Silos
//        keeps (launch-entries.ts `instructionsOff`) — `{personal: rel}`,
//        `{in: folder, file: rel}` or, a file in a folder above, `{in:
//        folder, above: <its path>}` (judged again at every launch against
//        the folder it starts in); never a login path. An import from
//        outside the folder and every login dir has none: what makes it
//        load is another file's text, which a launch can't judge again
//        (`inert` says so).
//      – Facts (no switch, the lines below locked): a pattern that matches
//        the row in a file Silos never writes — managed settings, a login's
//        settings.json, the repository's `.claude/settings.json` — or one in
//        the local file Silos did not write (a glob typed by hand: the
//        project line is refused, naming it). Matched with the engine's own
//        matcher, picomatch with dot files on; a `!` pattern matches every
//        file (measured: it re-includes nothing) — a hand-written one locks
//        every row.
//    An import follows its parent: where the importing file is off, it is
//    off too (`locked.parent`).
//
//  · auto memory (its index row — the head; a note has no line) —
//    `autoMemoryEnabled`, a boolean read from the merged settings: an
//    OVERRIDE kind. The narrowest place with an entry decides; an entry is
//    written only where the place differs from what it follows (rule 12).
//    Places: This machine (the user's settings.json — its «off» says the
//    machine sentence first and waits for a yes), This project (the local
//    file), Only <agent>, This conversation (the payload). Managed settings
//    decide over all; the repository's file is a fact between machine and
//    project. A heartbeat carries only «off» (launch-entries.ts removalsOf,
//    local-holds.ts).
//
// The organization's files, the agent's own memory, an auto-memory note
// and an OpenCode launch file have no place: `inert` says why.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import picomatch from 'picomatch'
import {
  LoadsSwitchError,
  type InstructionPlacesInput,
  type InstructionPlacesRow,
  type InstructionRow,
  type LoadsCarriedSwitch,
  type LoadsLine,
  type LoadsScopeId,
  type LoadsSwitchAt,
} from '../contract.js'
import { claudeManagedSettingsDir } from '../../plugin-enablement.js'
import { editLocalSettings, HOME_REFUSAL, isConfigHome, LOCAL_SETTINGS, type Json } from './local-settings.js'
import { writeUser, userSettingsPath } from './loads/machine.js'
import {
  aboveFileOk,
  autoMemoryEntryOf,
  folderFileOk,
  instructionEntryOf,
  personalFileOk,
  setAutoMemoryEntry,
  setInstructionEntry,
  type EntryContext,
  type InstructionEntry,
} from './loads/launch-entries.js'

export const EXCLUDES_KEY = 'claudeMdExcludes'
export const AUTO_KEY = 'autoMemoryEnabled'
/** The row key auto memory's entries are timed by. */
export const AUTO_ROW = 'instruction:auto-memory'

/** The machine sentence (spec memory-places §4): auto memory off for the whole machine. */
export const AUTO_MACHINE_OFF = 'No project on this machine reads these notes or writes new ones — the claude you start by hand included.'

const FILE_KINDS = new Set<InstructionRow['kind']>([
  'personal',
  'personal-rule',
  'above',
  'project',
  'project-rule',
  'private',
  'subfolder',
  'import',
  'agents',
])

type Read = { ok: true; json: Json | null } | { ok: false; why: string }
const asObject = (v: unknown): Json | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null)
const own = (o: Json | null, k: string): unknown => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined)
function readSettings(path: string): Read {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, json: null }
    return { ok: false, why: `${path} exists but could not be read — fix or remove it; Silos won't overwrite it` }
  }
  try {
    const o = asObject(JSON.parse(raw))
    return o ? { ok: true, json: o } : { ok: false, why: `${path} exists but is not a JSON object — fix or remove it; Silos won't overwrite it` }
  } catch {
    return { ok: false, why: `${path} exists but is not valid JSON — fix or remove it; Silos won't overwrite it` }
  }
}
const patternsIn = (o: Json | null): string[] => {
  const v = own(o, EXCLUDES_KEY)
  return Array.isArray(v) ? v.filter((e): e is string => typeof e === 'string' && e.trim() !== '') : []
}

/** The engine's matcher: picomatch, dot files on. A `!` pattern keeps out
 *  every file (measured, T1) — so it matches any row. */
export function patternMatches(pattern: string, path: string): boolean {
  if (pattern.startsWith('!')) return true
  try {
    return picomatch(pattern, { dot: true })(path)
  } catch {
    return false
  }
}

const loginDirsOf = (input: InstructionPlacesInput): string[] => [
  ...new Set((input.loginDirs.length > 0 ? input.loginDirs : [join(input.home, '.claude')]).map((d) => resolve(d))),
]
const managedFile = (input: InstructionPlacesInput): string => join(input.managedDir ?? claudeManagedSettingsDir(), 'managed-settings.json')
const under = (p: string, dir: string): string | null => (p.startsWith(dir + '/') ? p.slice(dir.length + 1) : null)

/** What a file row is at each place: its own strings at the project's
 *  file, and the entry a launch place keeps (none: no launch place can
 *  name it). */
interface FileSubject {
  strings: string[]
  entry?: InstructionEntry
}
function fileSubject(row: InstructionRow, input: InstructionPlacesInput): FileSubject | null {
  if (!FILE_KINDS.has(row.kind)) return null
  const path = resolve(row.path)
  const dirs = loginDirsOf(input)
  for (const d of dirs) {
    const rel = under(path, d)
    if (rel !== null && personalFileOk(rel)) return { strings: dirs.map((x) => join(x, rel)), entry: { personal: rel } }
  }
  const folder = input.folder
  const rel = folder !== null ? under(path, folder) : null
  if (folder !== null && rel !== null && folderFileOk(rel)) {
    return { strings: [join(folder, rel), `${folder}/.claude/worktrees/*/${rel}`], entry: { in: folder, file: rel } }
  }
  // a folder above: its absolute path, re-judged at every launch
  if (folder !== null && row.kind === 'above' && aboveFileOk(path, folder, dirs)) return { strings: [path], entry: { in: folder, above: path } }
  return { strings: [path] }
}

const ctxOf = (input: InstructionPlacesInput): EntryContext => ({ loginDirs: loginDirsOf(input), folders: input.folder !== null ? [input.folder] : [] })

/** A pattern Silos never wrote that keeps the row out, in the first file
 *  that has one. */
function factIn(file: string, row: InstructionRow, ownStrings: readonly string[]): string | null {
  const r = readSettings(file)
  if (!r.ok) return null
  return patternsIn(r.json).find((p) => !ownStrings.includes(p) && (patternMatches(p, row.path) || patternMatches(p, row.real))) ?? null
}

function fileLines(row: InstructionRow, sub: FileSubject, input: InstructionPlacesInput): LoadsLine[] {
  const lines: LoadsLine[] = []
  let offAt: LoadsScopeId | 'fact' | undefined
  const below = (mine: 'off' | undefined): Pick<LoadsLine, 'entry' | 'result' | 'locked'> =>
    mine ? { entry: mine, result: 'off' } : offAt ? { result: 'off', locked: { why: 'wider', at: offAt } } : { result: 'on' }
  if (factIn(managedFile(input), row, [])) {
    lines.push({ place: 'fact', fact: { who: 'organization', file: managedFile(input), key: EXCLUDES_KEY }, entry: 'off', result: 'off' })
    offAt = 'fact'
  }
  // a login's own settings.json: Silos never writes this key there — a fact on the machine's line
  const userFile = loginDirsOf(input)
    .map((d) => join(d, 'settings.json'))
    .find((f) => factIn(f, row, []) !== null)
  if (userFile) {
    lines.push({ place: 'machine', entry: 'off', result: 'off', keptIn: userFile })
    offAt ??= 'machine'
  }
  if (input.folder !== null && factIn(join(input.folder, '.claude', 'settings.json'), row, [])) {
    lines.push({ place: 'fact', fact: { who: 'repository', file: '.claude/settings.json', key: EXCLUDES_KEY }, entry: 'off', result: 'off' })
    offAt ??= 'fact'
  }
  if (input.folder !== null) {
    const local = readSettings(join(input.folder, LOCAL_SETTINGS))
    const list = local.ok ? patternsIn(local.json) : []
    const mine = sub.strings.some((s) => list.includes(s)) ? ('off' as const) : undefined
    const hand = local.ok ? factIn(join(input.folder, LOCAL_SETTINGS), row, sub.strings) : null
    const project: LoadsLine = { place: 'project', keptIn: LOCAL_SETTINGS, ...below(mine ?? (hand ? 'off' : undefined)) }
    if (isConfigHome(input.folder, input.home, loginDirsOf(input))) project.refused = { why: 'file', reason: HOME_REFUSAL }
    else if (!local.ok) project.refused = { why: 'file', reason: local.why }
    else if (hand !== null)
      project.refused = { why: 'file', reason: `kept out by "${hand}" in ${LOCAL_SETTINGS} — a pattern Silos didn't write; change it in that file` }
    else if (!project.locked) project.switch = { names: sub.strings }
    lines.push(project)
    if (project.result === 'off') offAt ??= 'project'
  }
  if (!sub.entry) return lines
  const ctx = ctxOf(input)
  for (const a of input.carried?.agents ?? []) {
    const line: LoadsLine = { place: 'agent', agent: a.id, ...below(instructionEntryOf(a.payload, sub.entry, ctx)) }
    if (!line.locked) line.switch = { names: sub.strings }
    lines.push(line)
  }
  const c = input.carried?.conversation
  if (c) {
    const agentOwn = c.agent !== undefined ? instructionEntryOf(input.carried?.agents.find((a) => a.id === c.agent)?.payload, sub.entry, ctx) : undefined
    if (agentOwn) offAt ??= 'agent'
    const line: LoadsLine = {
      place: 'conversation',
      conversation: c.id,
      ...(c.agent !== undefined ? { agent: c.agent } : {}),
      ...below(instructionEntryOf(c.payload, sub.entry, ctx)),
    }
    if (!line.locked) line.switch = { names: sub.strings }
    lines.push(line)
  }
  return lines
}

/** Auto memory's lines: an override kind, broadest first. */
function autoLines(input: InstructionPlacesInput): LoadsLine[] {
  const lines: LoadsLine[] = []
  const word = (v: unknown): 'on' | 'off' | undefined => (v === true ? 'on' : v === false ? 'off' : undefined)
  const managed = readSettings(managedFile(input))
  const org = managed.ok ? word(own(managed.json, AUTO_KEY)) : undefined
  let result: 'on' | 'off' = 'on'
  const at = (mine: 'on' | 'off' | undefined): Pick<LoadsLine, 'entry' | 'result' | 'locked'> => {
    if (org) return { result: org, locked: { why: 'organization' } }
    if (mine) result = mine
    return mine ? { entry: mine, result } : { result }
  }
  if (org) {
    lines.push({ place: 'fact', fact: { who: 'organization', file: managedFile(input), key: AUTO_KEY }, entry: org, result: org })
    result = org
  }
  const user = readSettings(userSettingsPath(input.home))
  const machine: LoadsLine = { place: 'machine', keptIn: '~/.claude/settings.json', ...at(user.ok ? word(own(user.json, AUTO_KEY)) : undefined) }
  if (!user.ok) machine.refused = { why: 'file', reason: user.why }
  else if (!machine.locked) {
    machine.switch = { names: [AUTO_KEY] }
    if (machine.result === 'on') machine.asks = AUTO_MACHINE_OFF
  }
  lines.push(machine)
  if (input.folder !== null) {
    const repo = readSettings(join(input.folder, '.claude', 'settings.json'))
    const r = repo.ok ? word(own(repo.json, AUTO_KEY)) : undefined
    if (r) lines.push({ place: 'fact', fact: { who: 'repository', file: '.claude/settings.json', key: AUTO_KEY }, ...at(r), entry: r })
    const local = readSettings(join(input.folder, LOCAL_SETTINGS))
    const project: LoadsLine = { place: 'project', keptIn: LOCAL_SETTINGS, ...at(local.ok ? word(own(local.json, AUTO_KEY)) : undefined) }
    if (isConfigHome(input.folder, input.home, loginDirsOf(input))) project.refused = { why: 'file', reason: HOME_REFUSAL }
    else if (!local.ok) project.refused = { why: 'file', reason: local.why }
    else if (!project.locked) project.switch = { names: [AUTO_KEY] }
    lines.push(project)
  }
  const projectResult = result
  const agentResult = new Map<string, 'on' | 'off'>()
  for (const a of input.carried?.agents ?? []) {
    result = projectResult
    const line: LoadsLine = { place: 'agent', agent: a.id, ...at(autoMemoryEntryOf(a.payload)) }
    if (!line.locked) line.switch = { names: [AUTO_KEY] }
    agentResult.set(a.id, line.result)
    lines.push(line)
  }
  const c = input.carried?.conversation
  if (c) {
    result = (c.agent !== undefined ? agentResult.get(c.agent) : undefined) ?? projectResult
    const line: LoadsLine = {
      place: 'conversation',
      conversation: c.id,
      ...(c.agent !== undefined ? { agent: c.agent } : {}),
      ...at(autoMemoryEntryOf(c.payload)),
    }
    if (!line.locked) line.switch = { names: [AUTO_KEY] }
    lines.push(line)
  }
  return lines
}

const INERT: Partial<Record<InstructionRow['kind'], string>> = {
  managed: 'set by your organization — no place here changes it',
  agent: 'Silos adds it to every conversation it starts for this agent — it has no switch',
  'auto-note': 'loads when Claude opens it — switch auto memory as a whole on its index',
  launch: 'its engine passes it at launch — no switch on this engine',
}
const NO_LAUNCH_PLACE =
  'it loads through an import from outside this project — only this project’s line can keep it out: a launch can’t judge again what another file imports'

const sameLine = (a: LoadsLine, b: LoadsLine): boolean =>
  a.place === b.place && a.agent === b.agent && a.conversation === b.conversation && a.fact?.who === b.fact?.who

/** Harness.instructions.places for Claude Code. */
export function claudeInstructionPlaces(input: InstructionPlacesInput, rows: readonly InstructionRow[]): InstructionPlacesRow[] {
  const memo = new Map<string, InstructionPlacesRow>()
  const byShown = new Map(rows.map((r) => [r.rel, r]))
  const of = (row: InstructionRow, depth = 0): InstructionPlacesRow => {
    const hit = memo.get(row.path)
    if (hit) return hit
    let answer: InstructionPlacesRow
    if (row.kind === 'auto-index') {
      answer = { path: row.path, key: AUTO_ROW, family: 'override', at: autoLines(input) }
    } else {
      const sub = fileSubject(row, input)
      if (!sub) {
        answer = { path: row.path, key: `instruction:${row.path}`, family: 'off-only', at: [], inert: INERT[row.kind] ?? 'no place switches it' }
      } else {
        const at = fileLines(row, sub, input)
        // an import goes with the file that imports it
        const parent = row.kind === 'import' && row.importedBy !== undefined && depth < 6 ? byShown.get(row.importedBy) : undefined
        if (parent) {
          const p = of(parent, depth + 1)
          for (const l of at) {
            const pl = p.at.find((x) => sameLine(x, l))
            if (pl?.result === 'off' && l.result === 'on') {
              l.result = 'off'
              l.locked = { why: 'wider', at: l.place, parent: parent.rel }
              delete l.switch
            }
          }
        }
        answer = { path: row.path, key: `instruction:${row.path}`, family: 'off-only', at, ...(sub.entry ? {} : { inert: NO_LAUNCH_PLACE }) }
      }
    }
    memo.set(row.path, answer)
    return answer
  }
  return rows.map((r) => of(r))
}

/** Harness.instructions.switch for Claude Code. */
export function claudeInstructionSwitch(
  input: InstructionPlacesInput,
  rows: readonly InstructionRow[],
  path: string,
  to: 'on' | 'off',
  at?: LoadsSwitchAt,
): LoadsCarriedSwitch | void {
  const real = resolve(path)
  const row = rows.find((r) => r.path === path || r.real === real || r.path === real)
  if (!row) throw new LoadsSwitchError('not an instruction file this folder lists', 404)
  const places = claudeInstructionPlaces(input, rows).find((p) => p.path === row.path)!
  const scope = at?.scope ?? 'project'
  const line = places.at.find((l) => l.place === scope && (scope !== 'agent' || l.agent === at?.agent))
  const where =
    scope === 'machine'
      ? 'on this machine'
      : scope === 'project'
        ? 'in this project'
        : scope === 'agent'
          ? `for ${at?.agent ?? 'this agent'}`
          : 'for this conversation'
  if (!line) throw new LoadsSwitchError(`${row.rel} has no switch ${where}${places.inert ? ` — ${places.inert}` : ''}`, 409)
  if (line.refused?.why === 'file') throw new LoadsSwitchError(line.refused.reason, 409)
  if (line.locked) {
    const why =
      line.locked.why === 'organization'
        ? 'your organization decides it (managed settings)'
        : line.locked.parent
          ? `it goes with ${line.locked.parent}, which is off ${where}`
          : `it is kept out wider (${line.locked.at === 'fact' ? 'a settings file above' : line.locked.at === 'machine' ? 'on this machine' : line.locked.at === 'agent' ? `for ${at?.agent ?? 'its agent'}` : 'in this project'}) — it can’t be turned back on below it`
    // an «on» of an off-only line with an entry of its own is still a removal
    if (!(places.family === 'off-only' && to === 'on' && line.entry === 'off')) throw new LoadsSwitchError(`${row.rel}: ${why}`, 409)
  }
  if (places.family === 'override') return autoSwitch(input, places.at, line, to, at)
  if (scope === 'machine') throw new LoadsSwitchError(`${row.rel} has no switch on this machine — keep it out per project`, 409)
  const sub = fileSubject(row, input)!
  if (scope === 'project') {
    editLocalSettings(
      input.folder!,
      input.home,
      (s) => {
        const v = own(s, EXCLUDES_KEY)
        if (v !== undefined && !Array.isArray(v))
          throw new LoadsSwitchError(`${EXCLUDES_KEY} in ${join(input.folder!, LOCAL_SETTINGS)} is not a list — fix it by hand; Silos won't overwrite it`, 409)
        const list = (v as unknown[] | undefined) ?? []
        if (to === 'off') {
          const missing = sub.strings.filter((e) => !list.includes(e))
          if (missing.length === 0) return false
          s[EXCLUDES_KEY] = [...list, ...missing]
          return true
        }
        const kept = list.filter((e) => !(typeof e === 'string' && sub.strings.includes(e)))
        if (kept.length === list.length) return false
        if (kept.length > 0) s[EXCLUDES_KEY] = kept
        else delete s[EXCLUDES_KEY]
        return true
      },
      loginDirsOf(input),
    )
    return
  }
  if (!sub.entry) throw new LoadsSwitchError(`${row.rel}: ${NO_LAUNCH_PLACE}`, 409)
  const r = setInstructionEntry(at?.payload ?? null, sub.entry, to === 'off' ? 'off' : null, ctxOf(input))
  return { payload: r.payload, changed: r.changed, held: instructionEntryOf(r.payload, sub.entry, ctxOf(input)) !== undefined }
}

/** Auto memory at one place: an entry only where the place differs from
 *  what it follows (rule 12) — the machine follows the default (on). */
function autoSwitch(input: InstructionPlacesInput, lines: LoadsLine[], line: LoadsLine, to: 'on' | 'off', at?: LoadsSwitchAt): LoadsCarriedSwitch | void {
  const scope = at?.scope ?? 'project'
  const idx = lines.indexOf(line)
  // what this place follows: the line above it in the chain (an agent's
  // and a conversation's: the project's, a conversation's its agent's)
  const above =
    scope === 'machine'
      ? undefined
      : scope === 'conversation'
        ? (lines.find((l) => l.place === 'agent' && l.agent !== undefined && l.agent === line.agent) ?? lines.find((l) => l.place === 'project'))
        : scope === 'agent'
          ? lines.find((l) => l.place === 'project')
          : lines
              .slice(0, idx)
              .reverse()
              .find((l) => l.place === 'machine' || l.place === 'fact')
  const follows: 'on' | 'off' = above?.result ?? 'on'
  const entry: 'on' | 'off' | null = follows === to ? null : to
  if (scope === 'machine') {
    if (to === 'off' && at?.confirmed !== true) throw new LoadsSwitchError(`${AUTO_MACHINE_OFF} Confirm to turn it off on this machine`, 409)
    writeUser({ home: input.home }, (s) => {
      if (entry === null) {
        if (!Object.prototype.hasOwnProperty.call(s, AUTO_KEY)) return false
        delete s[AUTO_KEY]
        return true
      }
      if (s[AUTO_KEY] === (entry === 'on')) return false
      s[AUTO_KEY] = entry === 'on'
      return true
    })
    return
  }
  if (scope === 'project') {
    editLocalSettings(
      input.folder!,
      input.home,
      (s) => {
        if (entry === null) {
          if (!Object.prototype.hasOwnProperty.call(s, AUTO_KEY)) return false
          delete s[AUTO_KEY]
          return true
        }
        if (s[AUTO_KEY] === (entry === 'on')) return false
        s[AUTO_KEY] = entry === 'on'
        return true
      },
      loginDirsOf(input),
    )
    return
  }
  const r = setAutoMemoryEntry(at?.payload ?? null, entry)
  return { payload: r.payload, changed: r.changed, held: autoMemoryEntryOf(r.payload) !== undefined }
}
