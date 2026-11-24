// egress-proxy.ts — the network surface of the fence:
// ONE local HTTP proxy, started by the server on every boot, that an agent
// on egress `allowlist` reaches through its env (HTTP_PROXY/HTTPS_PROXY —
// documented by both engines) and that lets through only the hosts its
// allowlist names plus the ones its engine documents for itself.
//
// - 127.0.0.1, on a STABLE port: the API's + 1 (3210 → 3211). Never
//   ephemeral: a console lives for days with its env frozen and this server
//   restarts on every save in server/src — the proxy listens on the same
//   port each boot. No new env var: it is derived from the API's port.
// - CONNECT host:port = a TCP tunnel (TLS passes INTACT — never MITM); an
//   absolute-URI request (http://…) = a plain-HTTP forward.
// - Identity is mandatory: `Proxy-Authorization: Basic base64(agent:<bearer>)`
//   — the user is the literal `agent`, the password the agent's bearer
//   (agent-tokens.ts). None, or one that names nobody → 407.
// - Allowed host → tunnel/forward; any other → 403 with a phrase, and a row.
// - Only PUBLIC addresses (net-guard.ts): the
//   connection leaves the SERVER, so a host that is or resolves to loopback
//   would hand the agent the local read-without-token exception (or any
//   internal service). The literal is checked before connecting; a name is
//   resolved through guardedLookup, which IS the connection's lookup — the
//   socket connects to the address that was checked, never a re-resolution
//   (rebinding dies there). Refused → 502, and a row.
// - Every refusal leaves {at, agentId, host, port, reason} in
//   <dataDir>/egress/rejected.jsonl (egress-log.ts). Never a path, a query
//   or a body.
//
// `open` agents get no proxy env (agent-state.ts). One that calls the proxy
// anyway with its bearer is let through to any PUBLIC host: open means open
// (the public-address rule holds for every caller — it protects the server,
// not the agent's policy).
import http from 'node:http'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import { guardedLookup, privateAddressReason, type PrivateReason } from './net-guard.js'
import type { EgressRejectLog } from './egress-log.js'
import type { EgressPolicy } from './territory-store.js'
import type { Agent } from './types.js'
import type { EngineHosts } from './harnesses/contract.js'
import { findHarness, harnessOf } from './harnesses/registry.js'

/** The proxy's port for a server whose API listens on `apiPort`. */
export function egressProxyPort(apiPort: number): number {
  return apiPort + 1
}

/** The documented value both engines accept: loopback by name and by both
 *  literals — the Silos API (SILOS_API) is never reached through the proxy. */
export const EGRESS_NO_PROXY = 'localhost,127.0.0.1,::1'

/** What an agent's process env gains for its egress policy. `open` → nothing.
 *  `allowlist` → the proxy, in both spellings (Claude Code reads
 *  https_proxy before HTTPS_PROXY: a lower-case one from a Vault entry or the
 *  inherited env must never stand over Silos'). Without a bearer (a failed
 *  mint) the URL carries none: every call is a 407 — closed, never open. */
export function egressProxyEnv(policy: Pick<EgressPolicy, 'mode'>, bearer: string | null, port: number): Record<string, string> {
  if (policy.mode !== 'allowlist') return {}
  const url = bearer ? `http://agent:${encodeURIComponent(bearer)}@127.0.0.1:${port}` : `http://127.0.0.1:${port}`
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    NO_PROXY: EGRESS_NO_PROXY,
    http_proxy: url,
    https_proxy: url,
    no_proxy: EGRESS_NO_PROXY,
  }
}

/** Does `host` fall under `pattern`? Exact (case-insensitive); `*.d` = any
 *  subdomain of d at any depth (never d itself); `*-s` = a first label that
 *  ENDS with `-` + the rest of s (Claude Code's `*-review.googlesource.com`). */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  const p = pattern.toLowerCase()
  if (p.startsWith('*.')) {
    const suffix = p.slice(1)
    return h.length > suffix.length && h.endsWith(suffix)
  }
  if (p.startsWith('*-')) {
    const suffix = p.slice(1)
    if (h.length <= suffix.length || !h.endsWith(suffix)) return false
    return !h.slice(0, h.length - suffix.length).includes('.')
  }
  return h === p
}

/** The policy the proxy enforces for one agent: open, or the hosts that
 *  make its allowlist (the owner's + its engine's own, already merged). */
export type EffectiveEgress = { mode: 'open' } | { mode: 'allowlist'; hosts: string[] }

/** The owner's hosts plus the engine's non-optional ones, deduplicated. */
export function effectiveAllowlist(ownerHosts: readonly string[], engine: { hosts: readonly { host: string; optional?: true }[] } | undefined): string[] {
  const out = ownerHosts.map((h) => h.toLowerCase())
  for (const h of engine?.hosts ?? []) {
    if (h.optional) continue
    const n = h.host.toLowerCase()
    if (!out.includes(n)) out.push(n)
  }
  return out
}

/** The documented hosts of the engine an agent runs on (its harness's
 *  engineHosts), or undefined: an agent on an unknown engine pins nothing. */
export function engineHostsOf(agent: Pick<Agent, 'framework'>): EngineHosts | undefined {
  try {
    return findHarness(harnessOf(agent))?.engineHosts
  } catch {
    return undefined
  }
}

/** What the proxy enforces for `agentId`: its territory policy, the engine's
 *  own hosts merged into an allowlist. An agent the registry does not know
 *  is held to its owner-given list alone. */
export function effectiveEgressOf(
  deps: { egressOf(agentId: string): EgressPolicy; agent(agentId: string): Pick<Agent, 'framework'> | null },
  agentId: string,
): EffectiveEgress {
  const p = deps.egressOf(agentId)
  if (p.mode !== 'allowlist') return { mode: 'open' }
  const agent = deps.agent(agentId)
  return { mode: 'allowlist', hosts: effectiveAllowlist(p.hosts, agent ? engineHostsOf(agent) : undefined) }
}

export interface EgressProxyDeps {
  /** The agent a bearer names; null = nobody (unknown, archived, gone). */
  agentOf(bearer: string): string | null
  policyFor(agentId: string): EffectiveEgress
  log: Pick<EgressRejectLog, 'append'> | null
  /** why an upstream IP is off limits (default: net-guard's). Tests with a
   *  127.0.0.1 upstream inject a permissive one; production never does. */
  privateReason?: PrivateReason
}

export interface EgressProxyOptions {
  port: number
  host?: string
  /** EADDRINUSE retries (the previous server may still be letting go of the
   *  port after a restart): attempts and the pause between them. */
  retries?: number
  retryMs?: number
}

export interface EgressProxy {
  readonly port: number
  close(): Promise<void>
}

// request headers never forwarded upstream (lowercase), plus those the
// Connection header lists
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const CHALLENGE = 'Basic realm="silos-egress", charset="UTF-8"'

/** The agent id a Proxy-Authorization header proves, or null. */
export function proxyIdentity(header: string | string[] | undefined, agentOf: (bearer: string) => string | null): string | null {
  if (typeof header !== 'string') return null
  const m = /^\s*basic\s+([A-Za-z0-9+/=_-]+)\s*$/i.exec(header)
  if (!m) return null
  let decoded: string
  try {
    decoded = Buffer.from(m[1]!, 'base64').toString('utf8')
  } catch {
    return null
  }
  const i = decoded.indexOf(':')
  if (i === -1 || decoded.slice(0, i) !== 'agent') return null
  const bearer = decoded.slice(i + 1)
  return bearer === '' ? null : agentOf(bearer)
}

/** host + port of a CONNECT target (`host:port`, `[v6]:port`), or null. */
export function parseConnectTarget(target: string | undefined): { host: string; port: number } | null {
  if (!target) return null
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([^:[\]/@\s]+)):(\d{1,5})$/.exec(target)
  if (!m) return null
  const port = Number(m[3])
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host: (m[1] ?? m[2]!).toLowerCase().replace(/\.$/, ''), port }
}

function rawReply(socket: Duplex, status: number, text: string, headers: Record<string, string> = {}): void {
  if (socket.destroyed) return
  const body = Buffer.from(`${text}\n`, 'utf8')
  const lines = [
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Error'}`,
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${body.length}`,
    'Connection: close',
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
  ]
  socket.end(Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'utf8'), body]))
}

export function startEgressProxy(deps: EgressProxyDeps, opts: EgressProxyOptions): Promise<EgressProxy> {
  const privateReason = deps.privateReason ?? privateAddressReason
  const lookup = guardedLookup(privateReason, 'the egress proxy')
  const sockets = new Set<Duplex>()

  const reject = (agentId: string, host: string, port: number, reason: string): void => {
    deps.log?.append({ at: new Date().toISOString(), agentId, host, port, reason })
  }

  // The decision every request goes through: who, may it, is it public.
  // Answers the refusal, or null to go ahead.
  const judge = (agentId: string, host: string, port: number): { status: number; text: string } | null => {
    const policy = deps.policyFor(agentId)
    if (policy.mode === 'allowlist' && !policy.hosts.some((p) => hostMatches(host, p))) {
      reject(agentId, host, port, 'not in its allowlist')
      return { status: 403, text: `${host} is not in ${agentId}'s egress allowlist — the owner adds hosts in Settings › Territory` }
    }
    if (net.isIP(host) !== 0) {
      const why = privateReason(host)
      if (why !== null) {
        reject(agentId, host, port, `${why} (${host})`)
        return { status: 502, text: `${host} is ${why} — the egress proxy only connects to public addresses (reach local services directly: NO_PROXY)` }
      }
    }
    return null
  }

  const failed = (
    agentId: string,
    host: string,
    port: number,
    err: NodeJS.ErrnoException & { why?: string; address?: string },
  ): { status: number; text: string } => {
    if (err.code === 'EPRIVATE') {
      reject(agentId, host, port, `resolves to ${err.why ?? 'a private address'} (${err.address ?? '?'})`)
      return { status: 502, text: err.message }
    }
    return { status: 502, text: `${host}:${port} could not be reached` }
  }

  const server = http.createServer((req, res) => {
    // a plain-HTTP forward: the request line carries an absolute http:// URI
    const raw = req.url ?? ''
    if (!/^http:\/\//i.test(raw)) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
      res.end(
        /^https:\/\//i.test(raw)
          ? 'https goes through CONNECT, never a forward\n'
          : "this is Silos' egress proxy: it forwards absolute http:// URIs and tunnels CONNECT\n",
      )
      return
    }
    const agentId = proxyIdentity(req.headers['proxy-authorization'], deps.agentOf)
    if (agentId === null) {
      res.writeHead(407, { 'proxy-authenticate': CHALLENGE, 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
      res.end("the egress proxy needs the agent's identity: Proxy-Authorization Basic agent:<its bearer>\n")
      return
    }
    if (req.headers.upgrade !== undefined) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
      res.end('no upgrade through a plain forward — use CONNECT\n')
      return
    }
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('malformed URI\n')
      return
    }
    if (url.username !== '' || url.password !== '') {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('credentials in the URI are not forwarded\n')
      return
    }
    const host = url.hostname
      .replace(/^\[|\]$/g, '')
      .toLowerCase()
      .replace(/\.$/, '')
    const port = url.port === '' ? 80 : Number(url.port)
    const no = judge(agentId, host, port)
    if (no) {
      res.writeHead(no.status, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`${no.text}\n`)
      return
    }
    const listed = new Set(
      String(req.headers.connection ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s !== ''),
    )
    const headers: Record<string, string | string[]> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k) || listed.has(k)) continue
      headers[k] = v
    }
    headers.host = url.host
    const up = http.request({ hostname: host, port, method: req.method, path: `${url.pathname}${url.search}`, headers, agent: false, lookup })
    up.on('response', (ures) => {
      const out: Record<string, string | string[]> = {}
      const ulisted = new Set(
        String(ures.headers.connection ?? '')
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter((s) => s !== ''),
      )
      for (const [k, v] of Object.entries(ures.headers)) {
        if (v === undefined || HOP_BY_HOP.has(k) || ulisted.has(k)) continue
        out[k] = v
      }
      res.writeHead(ures.statusCode ?? 502, out)
      ures.pipe(res)
    })
    up.on('error', (err: NodeJS.ErrnoException) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      const f = failed(agentId, host, port, err)
      res.writeHead(f.status, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`${f.text}\n`)
    })
    res.on('close', () => {
      if (!res.writableFinished) up.destroy()
    })
    req.pipe(up)
  })

  server.on('connect', (req: http.IncomingMessage, client: Duplex, head: Buffer) => {
    sockets.add(client)
    client.on('close', () => sockets.delete(client))
    client.on('error', () => client.destroy())
    const agentId = proxyIdentity(req.headers['proxy-authorization'], deps.agentOf)
    if (agentId === null) {
      rawReply(client, 407, "the egress proxy needs the agent's identity: Proxy-Authorization Basic agent:<its bearer>", { 'Proxy-Authenticate': CHALLENGE })
      return
    }
    const target = parseConnectTarget(req.url)
    if (target === null) {
      rawReply(client, 400, 'CONNECT needs host:port')
      return
    }
    const no = judge(agentId, target.host, target.port)
    if (no) {
      rawReply(client, no.status, no.text)
      return
    }
    // the connection's own lookup is the guard: the socket connects to the
    // address guardedLookup checked (a literal skips it — judged above)
    const upstream = net.connect({ host: target.host, port: target.port, lookup })
    sockets.add(upstream)
    upstream.on('close', () => sockets.delete(upstream))
    let open = false
    upstream.once('connect', () => {
      open = true
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.on('error', (err: NodeJS.ErrnoException) => {
      if (open) {
        client.destroy()
        return
      }
      const f = failed(agentId, target.host, target.port, err)
      rawReply(client, f.status, f.text)
    })
    client.on('close', () => upstream.destroy())
  })

  // an upgrade request through a plain forward is refused (the request
  // handler never sees it: node routes it here)
  server.on('upgrade', (_req: http.IncomingMessage, socket: Duplex) => {
    rawReply(socket, 400, 'no upgrade through a plain forward — use CONNECT')
  })
  server.on('clientError', (_err, socket: Duplex) => {
    socket.destroy()
  })
  server.on('connection', (s: net.Socket) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })

  const host = opts.host ?? '127.0.0.1'
  const retries = opts.retries ?? 30
  const retryMs = opts.retryMs ?? 1000
  return new Promise<EgressProxy>((resolve, reject) => {
    let attempt = 0
    const tryListen = (): void => {
      const onError = (err: NodeJS.ErrnoException): void => {
        if (err.code === 'EADDRINUSE' && attempt < retries) {
          attempt += 1
          setTimeout(tryListen, retryMs).unref()
          return
        }
        reject(err)
      }
      server.once('error', onError)
      server.listen(opts.port, host, () => {
        server.off('error', onError)
        const addr = server.address() as net.AddressInfo
        resolve({
          port: addr.port,
          close: () =>
            new Promise<void>((done) => {
              for (const s of sockets) s.destroy()
              server.close(() => done())
            }),
        })
      })
    }
    tryListen()
  })
}
