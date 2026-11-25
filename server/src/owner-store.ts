// owner-store.ts — <dataDir>/owner.json: who claimed this Silos.
//
// A deploy where nobody typed SILOS_OWNER_EMAIL (the Railway template's
// one-click path) starts UNCLAIMED: the allowlist is empty and no email may
// sign in. The first visitor who proves they deployed it — the access token
// gates the claim's start (server.ts) — signs in through Silos ID, and that
// verified email is written here, once. From then on the allowlist is this
// file's email — unless SILOS_OWNER_EMAIL is set: the environment always
// wins (index.ts). On Railway the data dir lives on the volume, so a
// redeploy keeps the owner.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson } from './json-store.js'

export const OWNER_FILE = 'owner.json'

/** Who may sign in: the environment's emails when it names any — the
 *  deployer's word always wins over a claim — else the claimed owner,
 *  else nobody (the instance is claimable). */
export function allowedEmails(envEmails: string[], store: OwnerStore): string[] {
  if (envEmails.length > 0) return envEmails
  const claimed = store.email()
  return claimed !== null ? [claimed] : []
}

export class OwnerStore {
  private readonly file: string
  private stored: string | null = null

  constructor(dataDir: string) {
    this.file = join(dataDir, OWNER_FILE)
    if (!existsSync(this.file)) return
    try {
      const o = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>
      if (typeof o.email === 'string' && o.email.includes('@')) this.stored = o.email
    } catch {
      // unreadable = unclaimed; the next claim rewrites it
    }
  }

  /** the claimed owner's email, or null while unclaimed */
  email(): string | null {
    return this.stored
  }

  /** The one write: the first claim wins. The same email claiming again
   *  (case-insensitive) is a no-op; a different one is refused — a claim
   *  never silently hands the instance to someone else. */
  claim(email: string): void {
    if (this.stored !== null) {
      if (this.stored.toLowerCase() === email.toLowerCase()) return
      throw new Error('this Silos is already claimed')
    }
    atomicWriteJson(this.file, { email, claimedAt: new Date().toISOString() }, { mode: 0o600 })
    this.stored = email
  }
}
