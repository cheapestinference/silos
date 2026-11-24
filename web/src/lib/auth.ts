// Remote sign-in (server opt-in) — client side. The truth lives on the
// server: GET /api/auth/config (public) says whether Silos ID login is on;
// the sign-in itself is a round trip through the Silos ID broker (a
// redirect, no identity SDK in this origin) that lands back here with a
// session. Without Silos ID on the server, enabled is false and NONE of
// this gets touched: the ?token= flow remains the only one.
import { clearToken, getToken, storeToken } from './api'

export interface AuthConfig {
  enabled: boolean
  // the one way in when enabled: the Silos ID broker
  mode?: 'silos-id'
}

// a direct fetch (no x-token header): this route is public by design —
// it's the only thing the login screen can ask before being inside.
export async function fetchAuthConfig(): Promise<AuthConfig> {
  const res = await fetch('/api/auth/config')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as AuthConfig
}

// the Google identity shown in the Sidebar's footer and in Settings › Access.
// Only written after a login the server verified (the fields come from the
// Silos ID landing the server's callback wrote, never from the browser).
const IDENTITY_KEY = 'silos-google-identity'

export interface GoogleIdentity {
  email: string
  name: string | null
  photo: string | null
}

export function getGoogleIdentity(): GoogleIdentity | null {
  const raw = localStorage.getItem(IDENTITY_KEY)
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const o = parsed as Record<string, unknown>
    if (typeof o.email !== 'string') return null
    return {
      email: o.email,
      name: typeof o.name === 'string' ? o.name : null,
      photo: typeof o.photo === 'string' ? o.photo : null,
    }
  } catch {
    return null
  }
}

export function setGoogleIdentity(identity: GoogleIdentity): void {
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity))
}

export function clearGoogleIdentity(): void {
  localStorage.removeItem(IDENTITY_KEY)
}

// The Silos ID landing: the server's callback sends the browser to
// `/#silos-id=<session>&email=…` (or `/#silos-id-error=…`). The fragment
// never reaches a server or a log; it is consumed here — the session stored
// like ?token=, the identity for the sidebar — and wiped from the address
// bar. Returns the error to show on the login screen, if any.
export function consumeSilosIdLanding(): string | null {
  const hash = window.location.hash
  if (!hash.startsWith('#')) return null
  const p = new URLSearchParams(hash.slice(1))
  const session = p.get('silos-id')
  const error = p.get('silos-id-error')
  if (session === null && error === null) return null
  if (session) {
    storeToken(session)
    const email = p.get('email')
    if (email) setGoogleIdentity({ email, name: p.get('name'), photo: p.get('picture') })
  }
  window.history.replaceState(null, '', window.location.pathname + window.location.search)
  return error
}

// the broker flow starts on THIS server (it mints the single-use state)
// the way in is picked on this page: Google, or a link to an email — the
// broker carries it out with no second choice
export function startSilosIdLogin(pick: { method: 'google' } | { method: 'email'; email: string } = { method: 'google' }): void {
  const q = new URLSearchParams(pick.method === 'email' ? { method: 'email', email: pick.email } : { method: 'google' })
  window.location.assign(`/api/auth/silos-id/start?${q.toString()}`)
}

// who a credential is, by the server's own word: GET /api/auth/me (public)
// answers { who: 'owner' | 'agent:<id>' | 'unknown' } for THAT request's
// credential. Nobody is the owner by default — a
// local browser with no token is 'unknown' too. Throws when the server
// does not answer.
export async function fetchWho(token: string): Promise<string> {
  const res = await fetch('/api/auth/me', token === '' ? undefined : { headers: { 'x-token': token } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = (await res.json().catch(() => ({}))) as { who?: unknown }
  return typeof body.who === 'string' ? body.who : 'unknown'
}

// sign out (Settings › Access): revokes the session ON THE SERVER (the
// session token stops working instantly, not only in this browser),
// clears the local token and identity, and reloads.
export async function signOutEverywhere(): Promise<void> {
  const t = getToken()
  if (t !== '') {
    try {
      await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-token': t } })
    } catch {
      // best-effort: if the server doesn't respond, the token expires on its own (7 days)
    }
  }
  clearToken()
  clearGoogleIdentity()
  window.location.reload()
}
