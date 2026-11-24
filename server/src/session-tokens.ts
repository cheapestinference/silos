// Per-login sessions (addressing a security-review finding, "a single god
// token"): logging in with Google no longer hands out the static token from
// the ~/.silos/token file — it mints a per-login SESSION token (32 random
// bytes in hex) stored on the server as {token → email, issuedAt,
// expiresAt}. Consequences the previous model didn't have:
//   - Sign out REALLY revokes (deletes the session on the server).
//   - Removing an email from allowedEmails cuts off access on the next
//     request (the guard re-checks the allowlist per request, see server.ts).
//   - FIXED 7-day expiry from login, no sliding window: a stolen token can't
//     be kept alive by replaying it — it dies at 7 days no matter what, and
//     logging back in is a one-click Google popup. A 30-day sliding window
//     would be more convenient and worse: the popup already provides the
//     convenience, and nothing else provides the bounded window.
// The static file token still exists as a manual escape hatch (?token=),
// local or remote — that doesn't change.
//
// Persisted in ~/.silos/sessions.json (0600, like token/providers.json):
// necessary, not optional — the dev server runs under tsx watch and
// restarts on every code change; in-memory-only would mean logging
// everyone out on every file save.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

/** The seal over sessions.json (seals.ts): the
 *  file is a credential — written in the seal's order, rewritten from memory
 *  on a delta, and ALL sessions revoked when it changed while Silos was off. */
export interface SessionsSeal {
  bootSessions(): 'ok' | 'reset'
  writeCredential(rel: string, value: string, mode?: number): void
  bindSessions(rewrite: () => void): void
}

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days, fixed

interface SessionEntry {
  email: string
  issuedAt: number
  expiresAt: number
}

export class SessionTokenStore {
  private sessions = new Map<string, SessionEntry>()
  private readonly file: string | null
  private readonly ttlMs: number
  private readonly now: () => number

  private readonly seal: SessionsSeal | null

  constructor(opts?: { file?: string; ttlMs?: number; now?: () => number; seal?: SessionsSeal }) {
    this.file = opts?.file ?? null
    this.ttlMs = opts?.ttlMs ?? SESSION_TTL_MS
    this.now = opts?.now ?? Date.now
    this.seal = opts?.seal ?? null
    this.load()
    this.seal?.bindSessions(() => this.save())
  }

  private load(): void {
    if (this.file === null) return
    // changed while Silos was off: no session it holds is Silos' word
    if (this.seal && this.seal.bootSessions() === 'reset') {
      this.sessions.clear()
      this.save()
      return
    }
    if (!existsSync(this.file)) return
    try {
      const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { sessions?: unknown }).sessions)) return
      for (const s of (raw as { sessions: unknown[] }).sessions) {
        if (typeof s !== 'object' || s === null) continue
        const o = s as Record<string, unknown>
        if (typeof o.token === 'string' && typeof o.email === 'string' && typeof o.issuedAt === 'number' && typeof o.expiresAt === 'number') {
          this.sessions.set(o.token, { email: o.email, issuedAt: o.issuedAt, expiresAt: o.expiresAt })
        }
      }
      this.prune()
    } catch {
      // a corrupt file must not break startup: we start from scratch
      // (remote users just log back in with a popup)
    }
  }

  private save(): void {
    if (this.file === null) return
    const sessions = [...this.sessions.entries()].map(([token, s]) => ({ token, ...s }))
    const text = JSON.stringify({ sessions }, null, 2) + '\n'
    if (this.seal) this.seal.writeCredential('sessions.json', text, 0o600)
    else writeFileSync(this.file, text, { mode: 0o600 })
  }

  private prune(): void {
    const t = this.now()
    for (const [token, s] of this.sessions) {
      if (s.expiresAt <= t) this.sessions.delete(token)
    }
  }

  issue(email: string): string {
    this.prune()
    const token = randomBytes(32).toString('hex')
    const t = this.now()
    this.sessions.set(token, { email, issuedAt: t, expiresAt: t + this.ttlMs })
    this.save()
    return token
  }

  // null = unknown or expired token. The allowlist check does NOT live here
  // on purpose: it's the guard's policy (server.ts), which re-reads it per
  // request — this store only knows about tokens and expiry.
  validate(token: string): { email: string } | null {
    const s = this.sessions.get(token)
    if (s === undefined) return null
    if (s.expiresAt <= this.now()) {
      this.sessions.delete(token)
      this.save()
      return null
    }
    return { email: s.email }
  }

  revoke(token: string): boolean {
    const deleted = this.sessions.delete(token)
    if (deleted) this.save()
    return deleted
  }
}
