// routes/egress.ts — the signer: a credential the
// agent USES without holding it. `/api/egress/<NAME>/<rest>` (every verb)
// forwards the agent's call to the binding's `baseUrl` + `<rest>` with the
// Vault entry injected as the header the binding names. The value never
// enters the agent's process; every call leaves a row (egress-log.ts).
//
// Who: ALWAYS an identity — an agent's bearer or the owner's credential. The
// route is write-class whatever the verb (agent-authz.ts isWriteClass): a
// local request without a token never reaches it, and an agent's call names
// its turn in the x-silos-turn header (its body is the service's).
// What: the winner of NAME over every folder of the agent (the same resolver
// as its env and its Vault view — VaultStore.signerFor); a winner without a
// binding is a 404, never a fallback to an outer scope. The owner signs as no
// agent (global entries only) unless it names one in `x-silos-agent`.
// How: the host is the binding's — the agent brings only the path and the
// query (no `.`/`..` segment; `//` collapses at the join). The body is RAW,
// byte for byte (the API's parsers are set aside in this scope) and streams
// both ways; an upstream silent for `idleMs` (30 s) is cut — a long sync that
// keeps sending is not; redirects come back as they are, never followed; an
// upgrade (WebSocket) is refused. Hop-by-hop headers, Host, Cookie, any
// Authorization, Silos' own credentials (x-token, x-silos-*) and the header
// the binding injects are dropped from the agent's request — the agent's
// never stands over the signed one. Upstream errors pass as they are.
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { guardedLookup, privateAddressReason, type PrivateReason } from '../net-guard.js'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { injectedValue, type VaultStore } from '../vault-store.js'
import type { AgentRegistry } from '../agent-registry.js'
import type { EgressLog } from '../egress-log.js'

export const EGRESS_IDLE_MS = 30_000

export interface EgressRoutesCtx {
  vault: VaultStore
  registry: AgentRegistry
  log: EgressLog | null
  /** upstream inactivity cut, ms (default EGRESS_IDLE_MS) — tests shorten it */
  idleMs?: number
  /** why an upstream IP is off limits (default: every private/loopback/
   *  link-local range — net-guard.ts). Tests with a 127.0.0.1 upstream
   *  inject `() => null`; production never overrides it. */
  privateReason?: PrivateReason
}

// request headers that never travel to the service (lowercase). Plus the
// names the agent's own Connection header lists, and the injected one.
const DROP_REQUEST = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'expect',
  'host',
  'cookie',
  'authorization',
  'x-token',
  'x-silos-turn',
  'x-silos-agent',
  'forwarded',
  'x-real-ip',
  'cdn-loop',
  'true-client-ip',
])
const DROP_REQUEST_PREFIX = ['x-forwarded-', 'cf-']
// response headers that never come back: hop-by-hop, and cookies — a
// service's cookie has no place on Silos' origin
const DROP_RESPONSE = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'set-cookie',
])

const NOT_FOUND = (name: string): string => `${name}: no signed Vault entry by that name reaches you (a delivered one is read from your environment)`

interface EgressTarget {
  name: string
  rest: string
  query: string
}

// The raw request target split into the entry's name, the rest of the path
// (as the agent encoded it) and the query — or why it is refused. Only
// visible ASCII travels (a request line never carries more); no segment, raw
// or decoded, may be `.`/`..` (a decoded one may hide a `/`: each piece of it
// is checked too).
export function parseEgressTarget(raw: string): EgressTarget | string {
  const q = raw.indexOf('?')
  const path = q === -1 ? raw : raw.slice(0, q)
  const query = q === -1 ? '' : raw.slice(q + 1)
  if (/[^\x21-\x7e]/.test(path) || /[^\x21-\x7e]/.test(query)) return 'the path holds characters a request line cannot carry'
  const parts = path.split('/') // ['', 'api', 'egress', NAME, ...rest]
  if (parts.length < 4) return 'malformed path'
  let name: string
  try {
    name = decodeURIComponent(parts[3]!)
  } catch {
    return 'malformed path'
  }
  const restParts = parts.slice(4)
  for (const p of restParts) {
    let d: string
    try {
      d = decodeURIComponent(p)
    } catch {
      return 'a path segment does not decode'
    }
    if (d.split(/[/\\]/).some((x) => x === '.' || x === '..')) return 'the path may not climb (. or .. segments)'
  }
  const rest = restParts.length === 0 ? '' : `/${restParts.join('/')}`.replace(/^\/+/, '/')
  return { name, rest, query }
}

// The owner's static token may ride `?token=`: it is Silos' credential, never
// the service's — dropped from the query when that is how the owner came in.
function queryForUpstream(query: string, req: FastifyRequest): string {
  if (query === '' || req.ownerCredential !== true || typeof req.headers['x-token'] === 'string') return query
  return query
    .split('&')
    .filter((kv) => {
      const k = kv.split('=')[0] ?? ''
      try {
        return decodeURIComponent(k) !== 'token'
      } catch {
        return true
      }
    })
    .join('&')
}

function requestHeaders(req: FastifyRequest, injected: string): Record<string, string | string[]> {
  const listed = new Set(
    String(req.headers.connection ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s !== ''),
  )
  const out: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    const n = k.toLowerCase()
    if (v === undefined || DROP_REQUEST.has(n) || listed.has(n) || n === injected || DROP_REQUEST_PREFIX.some((p) => n.startsWith(p))) continue
    out[n] = v
  }
  return out
}

function responseHeaders(res: http.IncomingMessage): Record<string, string | string[]> {
  const listed = new Set(
    String(res.headers.connection ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s !== ''),
  )
  const out: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(res.headers)) {
    if (v === undefined || DROP_RESPONSE.has(k) || listed.has(k)) continue
    out[k] = v
  }
  return out
}

export function egressRoutes(app: FastifyInstance, ctx: EgressRoutesCtx): void {
  const { vault, registry, log } = ctx
  const idleMs = ctx.idleMs ?? EGRESS_IDLE_MS
  // The signer only talks to PUBLIC addresses: a
  // binding to loopback would make the server call itself — from loopback,
  // without tunnel headers — and pass for a local read without a token; any
  // private range is the same SSRF class. Checked twice: the literal here,
  // every DNS answer in guardedLookup (rebinding dies there).
  const privateReason = ctx.privateReason ?? privateAddressReason
  const lookup = guardedLookup(privateReason)

  const handler = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    if (req.headers.upgrade !== undefined)
      return reply.code(400).header('connection', 'close').send({ error: 'a signed call never upgrades its connection — no WebSocket through the signer' })
    const target = parseEgressTarget(req.raw.url ?? req.url)
    if (typeof target === 'string') return reply.code(400).send({ error: target })

    // who signs, and over which folders (the semantics of its Vault view)
    let agentId: string | null = null
    let by: 'agent' | 'owner'
    if (req.agentId !== undefined) {
      agentId = req.agentId
      by = 'agent'
    } else if (req.ownerCredential === true) {
      by = 'owner'
      const as = req.headers['x-silos-agent']
      if (typeof as === 'string' && as.trim() !== '') agentId = as.trim()
    } else {
      // the auth hook already answered this; never sign for nobody
      return reply.code(401).send({ error: 'a signed call needs an identity' })
    }
    let folders: string[] = []
    if (agentId !== null) {
      const agent = registry.get(agentId)
      if (!agent || agent.archived) return reply.code(404).send({ error: 'agent not found' })
      folders = [agent.folder, ...(agent.folders ?? [])].filter((f): f is string => typeof f === 'string')
    }
    const look = vault.signerFor(agentId, folders, target.name)
    if ('refused' in look) return reply.code(404).send({ error: NOT_FOUND(target.name) })
    const { entry } = look
    const base = new URL(entry.binding.baseUrl)
    const literal = base.hostname.replace(/^\[|\]$/g, '')
    if (isIP(literal) !== 0) {
      const why = privateReason(literal)
      if (why !== null) {
        log?.append({
          at: new Date().toISOString(),
          agent: agentId,
          by,
          entry: entry.name,
          entryId: entry.id,
          method: req.method,
          host: base.origin,
          path: '/',
          status: 502,
          ms: 0,
          error: 'private-upstream',
        })
        return reply.code(502).send({ error: `the binding points at ${why} — the signer only talks to public addresses` })
      }
    }
    const basePath = base.pathname.replace(/\/+$/, '')
    const upstreamPath = `${basePath}${target.rest}` || '/'
    const query = queryForUpstream(target.query, req)
    const injectName = entry.binding.inject.header.toLowerCase()
    const headers = requestHeaders(req, injectName)
    headers[injectName] = injectedValue(entry.binding, entry.value)

    const t0 = Date.now()
    const at = new Date(t0).toISOString()
    let logged = false
    const row = (status: number, error?: string): void => {
      if (logged) return
      logged = true
      log?.append({
        at,
        agent: agentId,
        by,
        entry: entry.name,
        entryId: entry.id,
        method: req.method,
        host: base.origin,
        path: upstreamPath,
        status,
        ms: Date.now() - t0,
        ...(error ? { error } : {}),
      })
    }

    return new Promise<FastifyReply>((resolve) => {
      const lib = base.protocol === 'https:' ? https : http
      let answered = false
      const up = lib.request({
        protocol: base.protocol,
        hostname: base.hostname.replace(/^\[|\]$/g, ''),
        port: base.port === '' ? undefined : Number(base.port),
        method: req.method,
        path: query === '' ? upstreamPath : `${upstreamPath}?${query}`,
        headers,
        // a fresh connection per call: nothing of one agent's call rides another's socket
        agent: false,
        lookup,
      })
      // INACTIVITY, not duration: the socket timer resets on every byte
      up.setTimeout(idleMs, () => {
        up.destroy(new Error('idle'))
      })
      up.on('response', (res) => {
        answered = true
        const status = res.statusCode ?? 502
        res.on('end', () => row(status))
        res.on('error', () => row(status, 'cut'))
        res.on('close', () => {
          if (!res.complete) row(status, 'cut')
        })
        resolve(reply.code(status).headers(responseHeaders(res)).send(res))
      })
      up.on('error', (err) => {
        if (answered) return // the response stream carries it (cut above)
        const idle = err.message === 'idle'
        const priv = (err as { code?: string }).code === 'EPRIVATE'
        const status = idle ? 504 : 502
        row(status, idle ? 'idle' : priv ? 'private-upstream' : 'unreachable')
        resolve(
          reply
            .code(status)
            .send({
              error: idle ? `the service sent nothing for ${Math.round(idleMs / 1000)} s — cut` : priv ? err.message : 'the service could not be reached',
            }),
        )
      })
      // the caller went away: the upstream call goes with it
      reply.raw.on('close', () => {
        if (!reply.raw.writableFinished) up.destroy(new Error('caller gone'))
      })
      req.raw.on('error', () => up.destroy(new Error('caller gone')))
      req.raw.pipe(up)
    })
  }

  void app.register(async (scope) => {
    // RAW bodies here: no parser reads them — the request stream is piped
    // to the service untouched (and no body limit applies: streaming)
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser('*', (_req, _payload, done) => {
      done(null, undefined)
    })
    const methods: Array<'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS'> = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
    scope.route({ method: methods, url: '/api/egress/:name', exposeHeadRoute: false, handler })
    scope.route({ method: methods, url: '/api/egress/:name/*', exposeHeadRoute: false, handler })
  })

  // The rows, the OWNER's alone (the path may be sensitive): an agent's
  // bearer never reads /api/vault/** (agent-authz.ts agentMayRead) and a
  // request without the owner's credential is refused here, local or not.
  app.get<{ Querystring: { agent?: string; entry?: string; limit?: string } }>('/api/vault/signed-calls', async (req, reply) => {
    if (req.ownerCredential !== true) return reply.code(401).send({ error: "the signed calls' log is the owner's to read" })
    const limit = Number(req.query.limit)
    return {
      rows:
        log?.read({
          ...(typeof req.query.agent === 'string' && req.query.agent !== '' ? { agent: req.query.agent } : {}),
          ...(typeof req.query.entry === 'string' && req.query.entry !== '' ? { entryId: req.query.entry } : {}),
          ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
        }) ?? [],
    }
  })
}
