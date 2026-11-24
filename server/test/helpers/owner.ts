// THE owner-auth helper of the server tests:
// nobody is the owner by default any more — a local write with no
// credential is a 401 — so a test that acts as the owner says so, with the
// server's own static token. `asOwner(app, token)` makes every `app.inject`
// carry `x-token: <token>` unless the request already names a credential
// (an x-token, an `Authorization` — an agent bearer stays an agent — or a
// `?token=` in the url) or simulates the network (public Host, tunnel
// headers). Tests of the unknown/401 path use a server NOT wrapped, or pass
// their own headers. Real sockets (fetch, ws) use `ownerHeaders(token)` or
// `?token=` themselves.
export const ownerHeaders = (token: string): Record<string, string> => ({ 'x-token': token })
import type { FastifyInstance } from 'fastify'

type InjectArg = Parameters<FastifyInstance['inject']>[0]

// a request that simulates the network (a public Host, tunnel headers)
// tells its own credential story: the helper leaves it alone
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i
const TUNNEL = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'cf-connecting-ip', 'cf-ray', 'forwarded']

function hasCredential(o: { url?: unknown; path?: unknown; query?: unknown; headers?: Record<string, unknown> }): boolean {
  const entries = Object.entries(o.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v] as const)
  const headers = entries.map(([k]) => k)
  if (headers.includes('x-token') || headers.includes('authorization')) return true
  if (headers.some((h) => TUNNEL.includes(h))) return true
  const host = entries.find(([k]) => k === 'host')?.[1]
  if (typeof host === 'string' && !LOOPBACK_HOST.test(host)) return true
  const url = typeof o.url === 'string' ? o.url : typeof o.path === 'string' ? o.path : ''
  if (/[?&]token=/.test(url)) return true
  const q = o.query
  return typeof q === 'object' && q !== null && 'token' in q
}

export function withOwner<T extends object>(opts: T, token: string): T {
  const o = opts as { headers?: Record<string, unknown> }
  if (hasCredential(o as Parameters<typeof hasCredential>[0])) return opts
  return { ...opts, headers: { ...(o.headers ?? {}), 'x-token': token } }
}

export function asOwner<T extends FastifyInstance>(app: T, token: string): T {
  const inject = app.inject.bind(app) as (...args: unknown[]) => unknown
  const wrapped = (opts?: InjectArg, cb?: unknown): unknown => {
    if (opts === undefined) return inject()
    const o = typeof opts === 'string' ? { url: opts } : opts
    return cb === undefined ? inject(withOwner(o, token)) : inject(withOwner(o, token), cb)
  }
  ;(app as { inject: unknown }).inject = wrapped
  return app
}
