// net-guard.ts — the signer never talks to a private address: a binding an AGENT wrote could
// point its own entry at 127.0.0.1:3210 and the signed call would leave the
// SERVER over loopback — host loopback, no tunnel headers — qualifying for
// the local read-without-token exception (an authorization bypass), or
// reach any internal service (SSRF). One rule, one place: every upstream
// connection is checked here — the IP literal before connecting, and every
// DNS answer through guardedLookup (a public name that resolves to a
// private address — DNS rebinding — is refused the same way).
import { isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns'

/** Why this IP may not be an upstream, or null when it is public. */
export function privateAddressReason(ip: string): string | null {
  const kind = isIP(ip)
  if (kind === 4) return v4Reason(ip)
  if (kind === 6) return v6Reason(ip)
  return 'not an IP address'
}

function v4Reason(ip: string): string | null {
  const [a, b] = ip.split('.').map(Number) as [number, number]
  if (a === 127) return 'loopback'
  if (a === 0) return 'unspecified'
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'a private network'
  if (a === 169 && b === 254) return 'link-local'
  if (a === 100 && b >= 64 && b <= 127) return 'carrier-grade NAT'
  if (a >= 224) return 'multicast or reserved'
  if (a === 192 && b === 0) return 'reserved'
  if (a === 198 && (b === 18 || b === 19)) return 'reserved'
  return null
}

// ALLOWLIST stance (a denylist easily misses hex-form embedded
// v4 — `::ffff:7f00:1` is 127.0.0.1 with no dots in it): the address is
// expanded to its 8 hextets, an embedded v4 (v4-mapped ::ffff:0:0/96 and
// NAT64 64:ff9b::/96) is judged as the v4 it carries, and everything that
// is not global unicast (2000::/3) is refused by default — a form this
// parser does not positively recognise never connects.
function v6Reason(ip: string): string | null {
  const h = hextets(ip.toLowerCase())
  if (h === null) return 'an IPv6 form this guard does not recognise'
  const last32 = (): string => `${h[6]! >> 8}.${h[6]! & 0xff}.${h[7]! >> 8}.${h[7]! & 0xff}`
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) return v4Reason(last32()) // v4-mapped
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) return v4Reason(last32()) // NAT64
  if (h.every((x) => x === 0)) return 'unspecified'
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0 && h[6] === 0 && h[7] === 1) return 'loopback'
  const n = h[0]!
  if (n >= 0xfe80 && n <= 0xfebf) return 'link-local'
  if (n >= 0xfc00 && n <= 0xfdff) return 'a private network'
  if (n >= 0xff00) return 'multicast'
  if (n < 0x2000 || n > 0x3fff) return 'not global unicast'
  return null
}

/** The 8 hextets of an IPv6 string node's isIP accepted, or null. */
function hextets(s: string): number[] | null {
  let body = s
  // trailing dotted v4 → two hextets
  if (body.includes('.')) {
    const i = body.lastIndexOf(':')
    const v4 = body
      .slice(i + 1)
      .split('.')
      .map(Number)
    if (v4.length !== 4 || v4.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null
    body = `${body.slice(0, i + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`
  }
  const dbl = body.indexOf('::')
  if (dbl !== body.lastIndexOf('::')) return null
  const part = (t: string): number[] => (t === '' ? [] : t.split(':').map((x) => parseInt(x, 16)))
  let out: number[]
  if (dbl >= 0) {
    const left = part(body.slice(0, dbl))
    const right = part(body.slice(dbl + 2))
    if (left.length + right.length > 7) return null
    out = [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right]
  } else {
    out = part(body)
  }
  if (out.length !== 8 || out.some((x) => !Number.isInteger(x) || x < 0 || x > 0xffff)) return null
  return out
}

export type PrivateReason = (ip: string) => string | null

/** A dns.lookup for http(s).request that refuses private answers — with
 *  `all` or without, every address the name resolves to must be public. */
// The refusal carries code EPRIVATE plus `why` and `address`, so a caller
// can record it without parsing the message; `who` names the caller in it.
export function guardedLookup(reason: PrivateReason = privateAddressReason, who = 'the signer'): typeof dnsLookup {
  const guarded = (hostname: string, options: unknown, callback?: unknown): void => {
    const cb = (typeof options === 'function' ? options : callback) as (err: NodeJS.ErrnoException | null, address?: unknown, family?: unknown) => void
    const opts = typeof options === 'object' && options !== null ? (options as Record<string, unknown>) : {}
    dnsLookup(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return cb(err)
      const list = Array.isArray(addresses) ? addresses : []
      for (const a of list) {
        const why = reason(a.address)
        if (why !== null)
          return cb(
            Object.assign(new Error(`${hostname} resolves to ${why} (${a.address}) — ${who} only talks to public addresses`), {
              code: 'EPRIVATE',
              why,
              address: a.address,
            }),
          )
      }
      if (list.length === 0) return cb(Object.assign(new Error(`${hostname} did not resolve`), { code: 'ENOTFOUND' }))
      if (opts.all === true) return cb(null, list, undefined)
      const first = list[0]!
      cb(null, first.address, first.family)
    })
  }
  return guarded as typeof dnsLookup
}
