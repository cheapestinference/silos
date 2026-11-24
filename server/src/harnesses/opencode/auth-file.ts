// harnesses/opencode/auth-file — the operator's OpenCode logins
// (`<data>/opencode/auth.json`, 0600, `{ "<providerId>": { "type": "api",
// "key": "…" } }`), read for Settings › Providers "Import from OpenCode"
// READ ONLY: Silos never writes, moves or chmods this file.
// The ids go out to the UI; a key is read only on an explicit import (one
// id, one consent) and goes straight into the provider store — never into
// a response, a log or an error message.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PROVIDER_ID_RE } from '../../providers-store.js'
import { opencodeDataDir } from './paths.js'

export function authFilePath(home: string = homedir()): string {
  return join(opencodeDataDir(home), 'auth.json')
}

function readAuth(home: string): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(authFilePath(home), 'utf8'))
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  } catch {
    return {} // no file / unreadable / malformed: no logins to offer
  }
}

/** The provider ids OpenCode holds a login for, sorted (ids only). */
export function readAuthIds(home: string = homedir()): string[] {
  return Object.entries(readAuth(home))
    .filter(([id, v]) => PROVIDER_ID_RE.test(id) && typeof v === 'object' && v !== null)
    .map(([id]) => id)
    .sort()
}

export type AuthKeyResult = { ok: true; key: string } | { ok: false; reason: 'missing' | 'not-api' }

/** The API key OpenCode holds for one provider id. `missing`: no login for
 *  that id; `not-api`: a login that is not an API key (OAuth) — nothing a
 *  Silos harness-provider can carry. */
export function readAuthKey(home: string, providerId: string): AuthKeyResult {
  if (!PROVIDER_ID_RE.test(providerId)) return { ok: false, reason: 'missing' }
  const entry = readAuth(home)[providerId]
  if (typeof entry !== 'object' || entry === null) return { ok: false, reason: 'missing' }
  const e = entry as Record<string, unknown>
  if (e.type !== 'api' || typeof e.key !== 'string' || e.key.trim() === '') return { ok: false, reason: 'not-api' }
  return { ok: true, key: e.key.trim() }
}
