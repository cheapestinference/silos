// harnesses/claude-code/loads/heads.ts — the heads of what a Claude account
// sends, at every place (spec scopes §3, §7, T8): one key per origin, the
// same at every place, only ever in its «off» value —
//
//   · plugins     `syncClaudeAiPlugins: false`        (managed, user, local, flag — never the repository's file)
//   · skills      `syncClaudeAiSkills: false`         (managed, user, local, flag — never the repository's file)
//   · connectors  `disableClaudeAiConnectors: true`   (any source)
//
// An off-only key: off at any place that reaches the conversation is off,
// and every narrower line is locked under it (places.ts). Each place writes
// or removes ONLY its head key: the project's local file (switch.ts), the
// machine's own `~/.claude/settings.json` (here — through the one writer,
// settings.ts `editUserSettings`), an agent's payload (switch.ts, kept by
// Silos).
//
// The machine's «off» is the one that moves things (measured, T1 appendix:
// the user tier's `syncClaudeAiPlugins: false` holds; the skills key is
// read in the schema): it stops the download for every login Silos
// connects, and Claude Code moves the copies it had synced to its trash. So
// its line asks first, in its own sentence (owner 24-11), and the writer
// refuses it unless the request says the owner said yes.
//
// The account itself is a door, never written: its page where the walk
// confirmed one (the connectors' — sign-in.ts), else «claude.ai» with no
// link (plugins and skills: no page confirmed yet).
import { LoadsSwitchError, type LoadsLine, type LoadsMachineHead, type LoadsMachineInput, type LoadsOriginId } from '../../contract.js'
import { claudeManagedSettingsDir, managedFiles } from '../../../plugin-enablement.js'
import { compareVersions } from '../../../harness-run.js'
import { editUserSettings, UserSettingsError } from '../settings.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HEAD_OFF, type HeadKey } from './launch-entries.js'
import { linesOf, type RowTiers } from './places.js'
import { CONNECTORS_URL } from './sign-in.js'

type Json = Record<string, unknown>
const own = (o: object | null | undefined, k: string): boolean => o != null && Object.prototype.hasOwnProperty.call(o, k)
const asObject = (v: unknown): Json | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null)
const readJson = (path: string): Json | null => {
  try {
    return asObject(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

/** Each origin's head key. */
export const HEAD_OF: Readonly<Record<LoadsOriginId, HeadKey>> = {
  plugins: 'syncClaudeAiPlugins',
  skills: 'syncClaudeAiSkills',
  connectors: 'disableClaudeAiConnectors',
}

/** What each head turns on or off, in the words of a refusal. */
export const HEAD_WORDS: Readonly<Record<LoadsOriginId, string>> = {
  plugins: 'the plugins your Claude account sends',
  skills: 'the skills your Claude account sends',
  connectors: 'the connectors of your Claude account',
}

/** The machine line's sentence before its «off» (spec scopes §3, the
 *  schema's words; owner 24-11). Nothing is moved at a narrower place. */
export const MACHINE_HEAD_SENTENCE: Readonly<Record<LoadsOriginId, string>> = {
  plugins:
    'Stops the download for this machine’s Claude and every account Silos connects. Claude Code moves the copies it had synced to its trash (deleted after its retention period) and downloads them again when you turn this back on.',
  skills:
    'Stops the download for this machine’s Claude and every account Silos connects. Claude Code moves the copies it had synced to its trash (deleted after its retention period) and downloads them again when you turn this back on.',
  connectors: 'Neither this machine’s Claude nor any account Silos connects fetches or connects them.',
}

/** The account's page per origin where a walk confirmed it — absent: the
 *  door names claude.ai with no link. */
export const ACCOUNT_DOOR_URL: Readonly<Partial<Record<LoadsOriginId, string>>> = { connectors: CONNECTORS_URL }

/** The engine version a head at the machine was confirmed on (T1, CLI
 *  2.1.331: the user tier's plugins and connectors heads measured). */
export const MACHINE_HEAD_CONFIRMED_ON = '2.1.331'

/** Whether a settings object turns the head off. */
export const headOffIn = (j: Json | null | undefined, key: HeadKey): boolean => !!j && own(j, key) && j[key] === HEAD_OFF[key]

/** The repository's file is read for the connectors' head only (schema). */
export const READS_REPOSITORY: Readonly<Record<LoadsOriginId, boolean>> = { plugins: false, skills: false, connectors: true }

/** The tiers of one head, from the files' says. */
export function headTiers(
  origin: LoadsOriginId,
  says: { managed: boolean; user: boolean; repository: boolean; local: boolean },
  opts: { machineSwitch?: RowTiers['machineSwitch']; launchSwitchable: boolean },
): RowTiers {
  const key = HEAD_OF[origin]
  const at = (b: boolean) => (b ? { removes: key } : undefined)
  const url = ACCOUNT_DOOR_URL[origin]
  return {
    family: 'off-only',
    key,
    managed: at(says.managed),
    user: at(says.user),
    repository: READS_REPOSITORY[origin] ? at(says.repository) : undefined,
    local: at(says.local),
    machine: true,
    account: { login: null, ...(url ? { url } : {}) },
    ...(opts.machineSwitch ? { machineSwitch: opts.machineSwitch } : {}),
    machineAsks: MACHINE_HEAD_SENTENCE[origin],
    launch: { key: { key: 'head', name: key }, own: key, switchable: opts.launchSwitchable },
  }
}

const userFile = (home: string): string => join(home, '.claude', 'settings.json')

function machineState(input: LoadsMachineInput): { managed: Json[]; user: Json | null } {
  const managed = managedFiles(input.managedDir ?? claudeManagedSettingsDir())
    .map(asObject)
    .filter((j): j is Json => j !== null)
  return { managed, user: readJson(userFile(input.home)) }
}

const versionOk = (v: string | null | undefined): boolean => !(typeof v === 'string' && compareVersions(v, MACHINE_HEAD_CONFIRMED_ON) < 0)

/** Every head for this whole machine: the account door, the organization's
 *  fact, the machine line (no project, no agent: outside any folder). */
export function claudeMachineHeads(input: LoadsMachineInput): LoadsMachineHead[] {
  const { managed, user } = machineState(input)
  return (Object.keys(HEAD_OF) as LoadsOriginId[]).map((id) => {
    const key = HEAD_OF[id]
    const t = headTiers(
      id,
      { managed: managed.some((j) => headOffIn(j, key)), user: headOffIn(user, key), repository: false, local: false },
      {
        machineSwitch: versionOk(input.engineVersion) ? { names: [key] } : { refused: { why: 'engine', needs: MACHINE_HEAD_CONFIRMED_ON } },
        launchSwitchable: false,
      },
    )
    const at: LoadsLine[] = linesOf(t, undefined).filter((l) => l.place !== 'project')
    return { id, off: at.find((l) => l.place === 'machine')?.result === 'off', at }
  })
}

/** One head on or off for this whole machine — only its key in the user's
 *  own file, every other key and entry kept. «off» is refused unless
 *  `confirmed`; a value of another shape is refused, named; managed
 *  settings that decide it, and an engine older than the key's confirmed
 *  version, refuse it. A second click in the same direction writes nothing. */
export function claudeMachineHeadSwitch(
  input: LoadsMachineInput,
  origin: LoadsOriginId,
  to: 'on' | 'off',
  confirmed: boolean,
  editWith?: (mutate: (s: Json) => boolean) => void,
): void {
  if (!own(HEAD_OF, origin)) throw new LoadsSwitchError(`unknown origin "${origin}"`, 404)
  const key = HEAD_OF[origin]
  const off = HEAD_OFF[key]
  const { managed } = machineState(input)
  if (managed.some((j) => own(j, key)))
    throw new LoadsSwitchError(`your organization decides ${HEAD_WORDS[origin]} (${key} in managed settings) — nothing here changes it`, 409)
  if (!versionOk(input.engineVersion))
    throw new LoadsSwitchError(
      `${HEAD_WORDS[origin]} are switched for this machine with Claude Code ${MACHINE_HEAD_CONFIRMED_ON} or later — update Claude Code (Settings › Engines)`,
      409,
    )
  if (to === 'off' && !confirmed)
    throw new LoadsSwitchError(
      `turning off ${HEAD_WORDS[origin]} for this whole machine asks first — ${MACHINE_HEAD_SENTENCE[origin]} Confirm it to go on.`,
      409,
    )
  const mutate = (s: Json): boolean => {
    if (own(s, key) && typeof s[key] !== 'boolean') {
      throw new LoadsSwitchError(`${key} in ~/.claude/settings.json is not the shape Silos writes — kept as it is; change it in that file`, 409)
    }
    const isOff = own(s, key) && s[key] === off
    if (to === 'off') {
      if (isOff) return false
      s[key] = off
      return true
    }
    if (!isOff) return false
    delete s[key]
    return true
  }
  if (editWith) {
    editWith(mutate)
    return
  }
  try {
    editUserSettings(userFile(input.home), mutate)
  } catch (err) {
    if (err instanceof UserSettingsError) throw new LoadsSwitchError(err.message, 409)
    throw err
  }
}
