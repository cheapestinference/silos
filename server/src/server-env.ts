// server-env.ts — <dataDir>/server.env: the server's own deploy settings on
// an install with no service manager to hold them (a hand-started or
// `npm run dev` server would otherwise lose them on every restart).
//
// Narrow on purpose: only the keys in SERVER_ENV_KEYS — the Silos ID
// settings, read after the data dir is known. Never SILOS_DATA_DIR,
// SILOS_ROOT, SILOS_PORT, SILOS_HOST (needed before the data dir exists) nor
// SILOS_TOKEN (a secret). One rule: the real environment wins over the file
// (a non-empty value there), and the file's values are NEVER copied into
// process.env — agents and child processes inherit process.env, and these
// settings are not theirs. Callers read the merged view (serverSettings).
//
// Format: one KEY=VALUE per line; blank lines and lines starting with `#`
// are skipped; the value is trimmed and may be wrapped in matching single
// or double quotes (taken literally, no escapes, no inline comments).
// A malformed line is ignored; an unknown key is ignored and named in one
// boot log line. Values are never logged.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const SERVER_ENV_FILE = 'server.env'

/** The settings server.env may hold. */
export const SERVER_ENV_KEYS = ['SILOS_ID_URL', 'SILOS_PUBLIC_URL', 'SILOS_OWNER_EMAIL', 'SILOS_TELEMETRY'] as const
export type ServerEnvKey = (typeof SERVER_ENV_KEYS)[number]
export type ServerSettings = Partial<Record<ServerEnvKey, string>>

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface ParsedServerEnv {
  values: ServerSettings
  /** keys the file sets that server.env does not hold */
  unknown: string[]
  /** 1-based numbers of lines that are not KEY=VALUE */
  malformed: number[]
}

export function parseServerEnv(text: string): ParsedServerEnv {
  const values: ServerSettings = {}
  const unknown: string[] = []
  const malformed: number[] = []
  const known = new Set<string>(SERVER_ENV_KEYS)
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) return
    const eq = line.indexOf('=')
    const key = eq > 0 ? line.slice(0, eq).trim() : ''
    if (!KEY.test(key)) {
      malformed.push(i + 1)
      return
    }
    let value = line.slice(eq + 1).trim()
    const q = value[0]
    if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) value = value.slice(1, -1)
    else if (q === '"' || q === "'") {
      malformed.push(i + 1)
      return
    }
    if (!known.has(key)) {
      if (!unknown.includes(key)) unknown.push(key)
      return
    }
    values[key as ServerEnvKey] = value
  })
  return { values, unknown, malformed }
}

/** The file's settings (empty when it is absent or unreadable). */
export function readServerEnv(dataDir: string): ParsedServerEnv {
  let text: string
  try {
    text = readFileSync(join(dataDir, 'server.env'), 'utf8')
  } catch {
    return { values: {}, unknown: [], malformed: [] }
  }
  return parseServerEnv(text)
}

/** The merged view: each key from the environment when it is set there
 *  (non-empty), else from the file. Nothing is written to `env`. */
export function serverSettings(env: NodeJS.ProcessEnv, file: ServerSettings): ServerSettings {
  const out: ServerSettings = {}
  for (const k of SERVER_ENV_KEYS) {
    const fromEnv = env[k]
    const v = fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : file[k]
    if (v !== undefined) out[k] = v
  }
  return out
}

/** The boot's one line about what the file held that Silos ignored, or null. */
export function serverEnvWarning(parsed: ParsedServerEnv): string | null {
  const parts: string[] = []
  if (parsed.unknown.length > 0) parts.push(`unknown keys ignored: ${parsed.unknown.join(', ')} (it holds only ${SERVER_ENV_KEYS.join(', ')})`)
  if (parsed.malformed.length > 0) parts.push(`malformed line${parsed.malformed.length === 1 ? '' : 's'} ignored: ${parsed.malformed.join(', ')}`)
  return parts.length === 0 ? null : `${SERVER_ENV_FILE}: ${parts.join('; ')}`
}
