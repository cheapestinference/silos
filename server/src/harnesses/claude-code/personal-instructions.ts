// harnesses/claude-code/personal-instructions.ts — Harness.personal for
// Claude Code: your personal instructions (a login's CLAUDE.md and its
// rules/) switched off for ONE project, through the one writer
// (local-settings.ts) and the key the engine documents per folder
// (spec tools-origin §4 «Personal instructions», §7, §15 T16):
//
//   claudeMdExcludes: ["<config dir>/CLAUDE.md", "<config dir>/rules/**"]
//
// The engine's schema: «Glob patterns or absolute paths of CLAUDE.md files
// to exclude from loading. Patterns are matched against absolute file paths
// … Only applies to User, Project, and Local memory types». It reads the
// User file at <its config dir>/CLAUDE.md and the User rules under
// <its config dir>/rules — the config dir of the LOGIN the conversation runs
// on (~/.claude, or an extra account's own dir, where CLAUDE.md is a link
// that follows the machine's: accounts.ts FOLLOWED_FILES). The path is
// matched as the engine names the file, not through the link, so the switch
// writes the two entries for EVERY login's config dir: whichever login a
// conversation here runs on, its personal files stay out.
//
// The switch owns exactly those strings: «off» adds the missing ones, «on»
// removes them and nothing else — every other entry (a project file the
// owner excluded by hand, a glob) and every other key is kept. A second
// click in the same direction writes nothing.
//
// What decides it elsewhere is said, never fought: an entry of the switch
// already listed in a login's settings.json, the project's
// .claude/settings.json or managed settings excludes the file whatever
// this file says (the engine merges the lists) — the row is then a fact
// naming that file. A home folder and an unreadable local file are refused
// (local-settings.ts), as every switch is.
//
// For ONE agent, for ONE conversation (spec scopes §3, §6, T10): the same
// off-only kind at the launch places. Their payload keeps the CHOICE
// (launch-entries.ts `personalInstructions: "off"`), never a path; every
// launch turns it into this file's entries for every login dir known at
// that launch, so a login added after the click is covered. Off anywhere
// above is off: a narrower line with no entry of its own is locked by it.
//
// Rule 7 (the switch proves itself, T13): `entries` are the exact strings
// written — a later reading that lists one of those files as loaded after
// the file changed (the engine's InstructionsLoaded hook names each file
// with memory_type "User") marks the row «still loaded».
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  LoadsSwitchError,
  type LoadsCarriedSwitch,
  type LoadsLine,
  type LoadsScopeId,
  type LoadsSwitchAt,
  type PersonalInput,
  type PersonalState,
} from '../contract.js'
import { editLocalSettings, HOME_REFUSAL, isConfigHome, LOCAL_SETTINGS, type Json } from './local-settings.js'
import { claudeManagedSettingsDir } from '../../plugin-enablement.js'
import { personalEntries, personalEntryOf, setPersonalEntry } from './loads/launch-entries.js'

export { personalEntries }

export const EXCLUDES_KEY = 'claudeMdExcludes'

const asObject = (v: unknown): Json | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null)
const own = (o: Json | null, k: string): unknown => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined)

/** The logins' config dirs as the engine would use them: given, else the
 *  machine's ~/.claude; absolute, each once. */
export function loginDirsOf(input: Pick<PersonalInput, 'home' | 'loginDirs'>): string[] {
  const dirs = input.loginDirs && input.loginDirs.length > 0 ? input.loginDirs : [join(input.home, '.claude')]
  return [...new Set(dirs.map((d) => resolve(d)))]
}

type Read = { ok: true; json: Json | null } | { ok: false; why: string }
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
const listOf = (o: Json | null): unknown[] | null => {
  const v = own(o, EXCLUDES_KEY)
  return v === undefined ? [] : Array.isArray(v) ? v : null
}

/** The other layers that can carry the key — what decides beside the local file. */
function otherLayers(input: PersonalInput, loginDirs: string[]): string[] {
  const managedDir = input.managedDir ?? claudeManagedSettingsDir()
  return [...loginDirs.map((d) => join(d, 'settings.json')), join(input.folder, '.claude', 'settings.json'), join(managedDir, 'managed-settings.json')]
}

export function claudePersonalState(input: PersonalInput): PersonalState {
  const loginDirs = loginDirsOf(input)
  const entries = personalEntries(loginDirs)
  const rules = loginDirs.some((d) => existsSync(join(d, 'rules')))
  const base = { entries, logins: loginDirs.length, rules }
  if (isConfigHome(input.folder, input.home, loginDirs)) return { ...base, state: 'on', refused: HOME_REFUSAL }
  for (const file of otherLayers(input, loginDirs)) {
    const r = readSettings(file)
    if (!r.ok) continue // another file's state is not ours to judge
    const list = listOf(r.json) ?? []
    if (entries.some((e) => list.includes(e))) return { ...base, state: 'off', decidedBy: { file, key: EXCLUDES_KEY } }
  }
  const local = readSettings(join(input.folder, LOCAL_SETTINGS))
  if (!local.ok) return { ...base, state: 'on', refused: local.why }
  const list = listOf(local.json)
  if (list === null)
    return {
      ...base,
      state: 'on',
      refused: `${EXCLUDES_KEY} in ${join(input.folder, LOCAL_SETTINGS)} is not a list — fix it by hand; Silos won't overwrite it`,
    }
  const written = entries.filter((e) => list.includes(e)).length
  return { ...base, state: written === 0 ? 'on' : written === entries.length ? 'off' : 'partly' }
}

/** «Where it loads» for your personal instructions (spec scopes §3, §4,
 *  T10), broadest first: the organization's and the repository's files as
 *  facts where they list an entry; the machine — no switch of Silos', the
 *  file itself is the switch (its door); the project's local file; each
 *  agent's launch place and, asked, one conversation's. Off-only: off at a
 *  line makes every line below it off, and a line below with no entry of
 *  its own is locked by it. */
export function claudePersonalPlaces(input: PersonalInput): LoadsLine[] {
  const loginDirs = loginDirsOf(input)
  const entries = personalEntries(loginDirs)
  const lists = (file: string): boolean => {
    const r = readSettings(file)
    return r.ok && entries.some((e) => (listOf(r.json) ?? []).includes(e))
  }
  const managed = join(input.managedDir ?? claudeManagedSettingsDir(), 'managed-settings.json')
  const repo = join(input.folder, '.claude', 'settings.json')
  const lines: LoadsLine[] = []
  let offAt: LoadsScopeId | 'fact' | undefined
  const below = (own: 'off' | undefined): Pick<LoadsLine, 'entry' | 'result' | 'locked'> =>
    own ? { entry: own, result: 'off' } : offAt ? { result: 'off', locked: { why: 'wider', at: offAt } } : { result: 'on' }
  if (lists(managed)) {
    lines.push({ place: 'fact', fact: { who: 'organization', file: managed, key: EXCLUDES_KEY }, entry: 'off', result: 'off' })
    offAt = 'fact'
  }
  // your machine: the file itself is its switch — Silos only says where
  const userFile = loginDirs.map((d) => join(d, 'settings.json')).find(lists)
  lines.push({
    place: 'machine',
    ...(userFile ? { entry: 'off' as const, result: 'off' as const, keptIn: userFile } : below(undefined)),
    door: { word: 'Settings', where: 'Settings › Memories' },
  })
  if (userFile) offAt ??= 'machine'
  if (lists(repo)) {
    lines.push({ place: 'fact', fact: { who: 'repository', file: '.claude/settings.json', key: EXCLUDES_KEY }, entry: 'off', result: 'off' })
    offAt ??= 'fact'
  }
  const st = claudePersonalState(input)
  const projectOwn = !st.decidedBy && st.state !== 'on' ? 'off' : undefined
  const project: LoadsLine = { place: 'project', keptIn: LOCAL_SETTINGS, ...below(projectOwn) }
  // «partly»: off for some logins only — it still loads on the others
  if (projectOwn && st.state === 'partly' && !offAt) project.result = 'on'
  if (st.refused) project.refused = { why: 'file', reason: st.refused }
  else if (!project.locked && !st.decidedBy) project.switch = { names: entries }
  lines.push(project)
  if (project.result === 'off') offAt ??= 'project'
  for (const a of input.carried?.agents ?? []) {
    const own = personalEntryOf(a.payload)
    const line: LoadsLine = { place: 'agent', agent: a.id, ...below(own) }
    if (!line.locked) line.switch = { names: entries }
    lines.push(line)
  }
  const c = input.carried?.conversation
  if (c) {
    const agentOwn = c.agent !== undefined ? personalEntryOf(input.carried?.agents.find((a) => a.id === c.agent)?.payload) : undefined
    if (agentOwn) offAt ??= 'agent'
    const own = personalEntryOf(c.payload)
    const line: LoadsLine = { place: 'conversation', conversation: c.id, ...(c.agent !== undefined ? { agent: c.agent } : {}), ...below(own) }
    if (!line.locked) line.switch = { names: entries }
    lines.push(line)
  }
  return lines
}

/** One launch place's choice (an agent's, a conversation's): handed the
 *  payload Silos keeps, it returns the new one and writes NOTHING. «off»
 *  where a wider place already keeps them out is refused (the line is
 *  locked); «on» removes the place's own entry. */
function switchAtLaunch(input: PersonalInput, to: 'on' | 'off', at: LoadsSwitchAt): LoadsCarriedSwitch {
  if (to === 'off') {
    const line = claudePersonalPlaces(input).find((l) => l.place === at.scope && (at.scope === 'conversation' || l.agent === at.agent))
    if (line?.locked)
      throw new LoadsSwitchError(
        `your personal instructions are already off ${line.locked.at === 'agent' ? `for ${at.agent ?? 'its agent'}` : line.locked.at === 'project' ? 'in this project' : line.locked.at === 'machine' ? 'on this machine' : 'by a settings file above'} — nothing to turn off here`,
        409,
      )
  }
  const r = setPersonalEntry(at.payload ?? null, to === 'off' ? 'off' : null)
  return { payload: r.payload, changed: r.changed, held: personalEntryOf(r.payload) !== undefined }
}

export function claudePersonalSwitch(input: PersonalInput, to: 'on' | 'off', at?: LoadsSwitchAt): LoadsCarriedSwitch | void {
  if (at && (at.scope === 'agent' || at.scope === 'conversation')) return switchAtLaunch(input, to, at)
  if (at && at.scope === 'machine') throw new LoadsSwitchError('your personal instructions switch on this machine by their own file — Settings › Memories', 409)
  const st = claudePersonalState(input)
  if (st.refused) throw new LoadsSwitchError(st.refused, 409)
  if (st.decidedBy)
    throw new LoadsSwitchError(
      `your personal instructions are kept out by ${st.decidedBy.key} in ${st.decidedBy.file} — change it in that file; Silos only writes this project's local settings`,
      409,
    )
  const entries = st.entries
  editLocalSettings(
    input.folder,
    input.home,
    (s) => {
      const list = listOf(s)
      if (list === null)
        throw new LoadsSwitchError(`${EXCLUDES_KEY} in ${join(input.folder, LOCAL_SETTINGS)} is not a list — fix it by hand; Silos won't overwrite it`, 409)
      if (to === 'off') {
        const missing = entries.filter((e) => !list.includes(e))
        if (missing.length === 0) return false
        s[EXCLUDES_KEY] = [...list, ...missing]
        return true
      }
      const kept = list.filter((e) => !(typeof e === 'string' && entries.includes(e)))
      if (kept.length === list.length) return false
      if (kept.length > 0) s[EXCLUDES_KEY] = kept
      else delete s[EXCLUDES_KEY]
      return true
    },
    loginDirsOf(input),
  )
}
