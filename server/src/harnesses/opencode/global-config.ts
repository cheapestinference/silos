// harnesses/opencode/global-config — the writer of «This machine» for
// OpenCode (spec scopes §8, §9): ONE entry, `mcp.<name>.enabled`, in the
// operator's global `~/.config/opencode/opencode.json(c)`, only on the
// owner's click that names the machine.
//
// - The file written is the one OpenCode reads LAST of the two names
//   (loads.ts reads `opencode.json`, then `opencode.jsonc`): the one whose
//   say wins. None there → `opencode.json` is created.
// - Only while it parses as STRICT JSON: one with comments (or anything else
//   `JSON.parse` refuses), or that is not an object, is refused — 409, the
//   file named, untouched. Rewriting it would lose its comments.
// - Only its entry: `enabled` of that one server. Every other key, every
//   other server and the server's own definition are kept; an `mcp` or a
//   server entry of another shape is refused, named. «on» removes the entry
//   (the machine then follows OpenCode's default, which loads it) and a bare
//   `{enabled}` entry left empty goes with it.
// - Atomic: tmp + rename beside the REAL file (a symlinked file is written
//   through), the file re-read right before the rename and the change
//   re-applied once if it moved meanwhile.
// - The seal watches this file (the engine's `configFiles`:
//   `~/.config/opencode/**`): the write is its own edit — beforeOwnEdit
//   notices any foreign change first, afterOwnEdit re-seals the read hash —
//   never a «changed» row of Needs you.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { LoadsSwitchError } from '../contract.js'
import { sealHooks } from '../../seal-hooks.js'

type Json = Record<string, unknown>
const isMap = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)
const put = (o: Json, k: string, v: unknown): void => {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true })
}

export const GLOBAL_DIR_SHOWN = '~/.config/opencode/'
const NAMES = ['opencode.json', 'opencode.jsonc'] as const

/** The global file a machine entry is written in: the last of the two that
 *  exists (its say wins), else `opencode.json`. `shown` is how the owner
 *  knows it. */
export function globalConfigFile(home: string): { file: string; shown: string } {
  const dir = join(home, '.config', 'opencode')
  const name = [...NAMES].reverse().find((n) => existsSync(join(dir, n))) ?? 'opencode.json'
  return { file: join(dir, name), shown: `${GLOBAL_DIR_SHOWN}${name}` }
}

/** Why the global file can't take a machine entry — null when it can (it is
 *  absent, or strict JSON holding an object). Read-only. */
export function globalConfigRefusal(home: string): string | null {
  const { file, shown } = globalConfigFile(home)
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : `${shown} could not be read — Silos won't write it`
  }
  return parseRefusal(raw, shown).refusal
}

function parseRefusal(raw: string, shown: string): { cfg: Json | null; refusal: string | null } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { cfg: null, refusal: `${shown} is not plain JSON (comments?) — Silos won't rewrite it: they would be lost. Change it there` }
  }
  if (!isMap(parsed)) return { cfg: null, refusal: `${shown} is not a JSON object — Silos won't write it` }
  return { cfg: parsed, refusal: null }
}

/** Sets (`off`) or removes (`on`) `mcp.<name>.enabled` in the global file.
 *  Returns whether it wrote. LoadsSwitchError 409, the file named, for a
 *  file it can't read, that isn't strict JSON or an object, or an entry of
 *  another shape. */
export function switchGlobalMcp(home: string, name: string, to: 'on' | 'off'): boolean {
  const { file, shown } = globalConfigFile(home)
  sealHooks().beforeOwnEdit?.(file)
  const read = (): string | null => {
    try {
      return readFileSync(file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new LoadsSwitchError(`${shown} could not be read — Silos won't write it`, 409)
    }
  }
  const apply = (raw: string | null): string | null => {
    let cfg: Json = {}
    if (raw !== null) {
      const p = parseRefusal(raw, shown)
      if (p.refusal) throw new LoadsSwitchError(p.refusal, 409)
      cfg = p.cfg!
    }
    if (own(cfg, 'mcp') && !isMap(cfg.mcp)) throw new LoadsSwitchError(`${shown}: "mcp" is not an object — Silos won't write it`, 409)
    const mcp = (own(cfg, 'mcp') ? cfg.mcp : {}) as Json
    const has = own(mcp, name)
    if (has && !isMap(mcp[name])) throw new LoadsSwitchError(`${shown}: mcp."${name}" is not an object — Silos won't write it`, 409)
    const entry = has ? (mcp[name] as Json) : null
    if (to === 'off') {
      if (entry && entry.enabled === false) return null
      put(mcp, name, entry ? { ...entry, enabled: false } : { enabled: false })
    } else {
      if (!entry || !own(entry, 'enabled')) return null
      const { enabled: _e, ...rest } = entry
      void _e
      // a bare entry Silos (or anyone) left with nothing else in it goes
      if (Object.keys(rest).length === 0) delete mcp[name]
      else put(mcp, name, rest)
    }
    if (!own(cfg, 'mcp')) put(cfg, 'mcp', mcp)
    return JSON.stringify(cfg, null, 2) + '\n'
  }
  const first = read()
  let text = apply(first)
  if (text === null) return false
  // written through a symlinked file: the tmp goes beside the real one
  let real = file
  try {
    real = realpathSync(file)
  } catch {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  }
  const tmp = `${real}.${process.pid}.tmp`
  // the engine writes this file too: re-read right before the rename, and
  // re-apply once if it moved
  const again = read()
  if (again !== first) {
    text = apply(again)
    if (text === null) {
      sealHooks().afterOwnEdit?.(file)
      return false
    }
  }
  // an existing file keeps its mode; a new one is the owner's alone
  let mode = 0o600
  try {
    mode = statSync(real).mode & 0o777
  } catch {
    /* new */
  }
  writeFileSync(tmp, text, { mode })
  renameSync(tmp, real)
  sealHooks().afterOwnEdit?.(file)
  return true
}
