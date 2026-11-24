// harnesses/claude-code/loads/machine.ts — the «This machine» line of a
// Tools row switched (spec scopes §3, §6, §8): ONE entry in the user's own
// `~/.claude/settings.json`, on the owner's click that names the machine and
// never otherwise, through the one writer of that file (settings.ts
// `editUserSettings`: refuses a file it can't read as an object, keeps every
// other key and entry, atomic through a symlink, re-applied if the file
// moved before the rename). Every extra login under Silos' accounts follows
// that file (accounts.ts) — the route asks the follow who did.
//
// The keys, the same as the project's, at the user tier (measured, T1):
//  · a plugin you installed — `enabledPlugins: {"<name>@<marketplace>": false | true}`,
//    explicit both ways: the bytes `claude plugin disable|enable --scope
//    user` writes (its entry there is its installed state);
//  · an account plugin       — `enabledPlugins: {"<name>@synced": false}`; «on»
//    removes it (the account's plugins load by default — rule 12);
//  · a plugin's server, a server of yours, one the organization provides,
//    a connector — `deniedMcpServers: [{"serverName": "<exact name>"}]`; «on»
//    removes exactly the entries naming it and nothing else.
//
// Never `~/.claude.json`, never an extra login's file by hand, never a CLI
// call. A key of another shape than its switch expects is refused, named;
// a hand-written entry of another shape is kept (and said when it is what
// keeps the thing off). A second click in the same direction writes nothing.
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { LoadsSwitchError, type LoadsInput, type LoadsLine, type LoadsRow } from '../../contract.js'
import { editUserSettings, UserSettingsError } from '../settings.js'
import { claudeLoadsState } from './inventory.js'
import { HEAD_OF } from './heads.js'

const USER_FILE = '~/.claude/settings.json'
type Json = Record<string, unknown>
const own = (o: object | null | undefined, k: string): boolean => o != null && Object.prototype.hasOwnProperty.call(o, k)
const asObject = (v: unknown): Json | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null)

/** The user's settings file (the machine's own login). */
export const userSettingsPath = (home: string): string => join(home, '.claude', 'settings.json')
/** When the user file last changed (its target's mtime, ms — the writer
 *  writes through a link) — any key, by anyone; null when there is none. */
export function userSettingsChangedAt(home: string): number | null {
  try {
    return statSync(userSettingsPath(home)).mtimeMs
  } catch {
    return null
  }
}

/** What keeps a machine line from switching — the words of the 409. */
function lineRefusal(r: LoadsRow, line: LoadsLine | undefined): string {
  if (!line) return `"${r.label}" has no line for this machine — it exists in one project; switch it there`
  if (line.locked?.why === 'organization') return `your organization decides "${r.label}" (managed settings) — nothing here changes it`
  if (line.refused?.why === 'engine')
    return `"${r.label}" is switched for this machine with Claude Code ${line.refused.needs} or later — update Claude Code (Settings › Engines)`
  if (r.parent && !r.placeholder) return `"${r.label}" comes and goes with its plugin — switch the plugin`
  if (r.placeholder) return `"${r.label}" is a placeholder — nothing loads, nothing to switch`
  if (!r.exact) return `only the name "${r.label}"'s tools carry is known — no switch until a reading gives its exact name`
  return `"${r.label}" has no switch for this machine`
}

const refusedShape = (what: string): never => {
  throw new LoadsSwitchError(`${what} in ${USER_FILE} is not the shape Silos writes — kept as it is; change it in that file`, 409)
}

/** The row `key` on or off for this whole machine — every project and every
 *  `claude` started here, on every login Silos connects. */
export function claudeMachineSwitch(input: LoadsInput, key: string, to: 'on' | 'off', editWith?: (mutate: (s: Json) => boolean) => void): void {
  const write = (_i: LoadsInput, m: (s: Json) => boolean): void => {
    if (editWith) editWith(m)
    else writeUser(input, m)
  }
  const { inventory } = claudeLoadsState(input)
  const row = inventory.rows.find((r) => r.key === key)
  if (!row) throw new LoadsSwitchError(`unknown row "${key}" — not among what this folder loads`, 404)
  const line = row.at?.find((l) => l.place === 'machine')
  if (!line?.switch) throw new LoadsSwitchError(lineRefusal(row, line), 409)
  const names = line.switch.names
  const off = to === 'off'

  // rule 4 at the machine: «on» for one account thing while the machine
  // keeps its whole origin off removes the machine's head key and writes
  // the item-level «off» for every OTHER known item of that origin in the
  // same file — adding one never turns on another; what the account sends
  // later loads
  if (!off && line.headOff && (row.kind === 'plugin' || row.kind === 'connector')) {
    const head = row.kind === 'plugin' ? HEAD_OF.plugins : HEAD_OF.connectors
    const others = [
      ...new Set(
        inventory.rows
          .filter((r) => r.kind === row.kind && r.origin.owner === 'account' && !r.parent && r.exact && r.key !== row.key)
          .flatMap((r) => r.at?.find((l) => l.place === 'machine')?.switch?.names ?? []),
      ),
    ]
      .filter((n) => !names.includes(n))
      .sort()
    const plugin = row.kind === 'plugin'
    write(input, (s) => {
      if (own(s, head) && typeof s[head] !== 'boolean') refusedShape(head)
      if (plugin) {
        if (own(s, 'enabledPlugins') && asObject(s.enabledPlugins) === null) refusedShape('enabledPlugins')
        const plugins: Json = { ...(asObject(own(s, 'enabledPlugins') ? s.enabledPlugins : null) ?? {}) }
        for (const o of others) plugins[o] = false
        // an account plugin loads by default: its own entry goes
        for (const n of names) delete plugins[n]
        if (Object.keys(plugins).length > 0) s.enabledPlugins = plugins
        else delete s.enabledPlugins
      } else {
        if (own(s, 'deniedMcpServers') && !Array.isArray(s.deniedMcpServers)) refusedShape('deniedMcpServers')
        const exactly = (e: unknown, n: string): boolean => {
          const o = asObject(e)
          return o !== null && Object.keys(o).length === 1 && o.serverName === n
        }
        const naming = (e: unknown, n: string): boolean => asObject(e)?.serverName === n
        const list = (own(s, 'deniedMcpServers') ? [...(s.deniedMcpServers as unknown[])] : []).filter((e) => !names.some((n) => exactly(e, n)))
        const next = [...list, ...others.filter((n) => !list.some((e) => naming(e, n))).map((serverName) => ({ serverName }))]
        if (next.length > 0) s.deniedMcpServers = next
        else delete s.deniedMcpServers
      }
      delete s[head]
      return true
    })
    return
  }

  let mutate: (s: Json) => boolean
  if (row.kind === 'plugin') {
    const id = names[0]!
    // an account plugin loads by default: «on» removes its entry; one you
    // installed keeps an explicit entry both ways (as the engine's command)
    const synced = row.origin.owner === 'account'
    mutate = (s) => {
      if (own(s, 'enabledPlugins') && asObject(s.enabledPlugins) === null) refusedShape('enabledPlugins')
      const plugins: Json = { ...(asObject(own(s, 'enabledPlugins') ? s.enabledPlugins : null) ?? {}) }
      if (own(plugins, id) && typeof plugins[id] !== 'boolean') refusedShape(`enabledPlugins["${id}"]`)
      if (synced && !off) {
        if (!own(plugins, id)) return false
        delete plugins[id]
      } else {
        if (own(plugins, id) && plugins[id] === !off) return false
        plugins[id] = !off
      }
      if (Object.keys(plugins).length > 0) s.enabledPlugins = plugins
      else delete s.enabledPlugins
      return true
    }
  } else {
    // denied by name: a server, a plugin's (every copy's name), a connector
    const exactly = (e: unknown, n: string): boolean => {
      const o = asObject(e)
      return o !== null && Object.keys(o).length === 1 && o.serverName === n
    }
    const naming = (e: unknown, n: string): boolean => asObject(e)?.serverName === n
    mutate = (s) => {
      if (own(s, 'deniedMcpServers') && !Array.isArray(s.deniedMcpServers)) refusedShape('deniedMcpServers')
      const list = own(s, 'deniedMcpServers') ? [...(s.deniedMcpServers as unknown[])] : []
      let next: unknown[]
      if (off) {
        const add = names.filter((n) => !list.some((e) => naming(e, n)))
        if (add.length === 0) return false
        next = [...list, ...add.map((serverName) => ({ serverName }))]
      } else {
        next = list.filter((e) => !names.some((n) => exactly(e, n)))
        const kept = next.find((e) => names.some((n) => naming(e, n)))
        if (kept !== undefined)
          throw new LoadsSwitchError(
            `"${row.label}" is kept off by an entry of another shape in ${USER_FILE} (${JSON.stringify(kept)}) — Silos doesn't rewrite it; change it in that file`,
            409,
          )
        if (next.length === list.length) return false
      }
      if (next.length > 0) s.deniedMcpServers = next
      else delete s.deniedMcpServers
      return true
    }
  }
  write(input, mutate)
}

/** The user file's one writer, its refusals as 409s. */
export function writeUser(input: { home: string }, mutate: (s: Json) => boolean): void {
  try {
    editUserSettings(userSettingsPath(input.home), mutate)
  } catch (err) {
    if (err instanceof UserSettingsError) throw new LoadsSwitchError(err.message, 409)
    throw err
  }
}
