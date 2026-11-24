// harnesses/opencode/sign-in — signing in to a provider with OpenCode's OWN
// login, from Silos (a ChatGPT Plus/Pro subscription today). OpenCode's
// documented server API does it: a short-lived `opencode serve` (loopback,
// a random password, the machine's own OpenCode data dir — where the
// agents' OpenCode reads its logins), GET /provider/auth for the methods a
// provider offers, POST /provider/:id/oauth/authorize with the HEADLESS one
// (a device link + a one-time code — it works on a remote Silos, no
// localhost callback), then POST …/oauth/callback, which returns once the
// person finished at the provider. OpenCode writes its own auth.json; Silos
// never reads the token and never writes that file. The server is stopped
// when the attempt ends, whatever the outcome.
//
// What is offered is OpenCode's answer, never a list here: every provider
// whose methods include an OAuth «headless» one.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { cleanEnv } from '../../env.js'
import { opencodeBin } from './bin.js'
import { allocatePort } from './ports.js'

export interface SignInOption {
  providerId: string
  name: string
  label: string
}
export type SignInState =
  | { state: 'waiting'; providerId: string; url: string; instructions: string }
  | { state: 'done'; providerId: string }
  | { state: 'failed'; providerId: string; error: string }

interface Served {
  child: ChildProcess
  base: string
  auth: string
}
type Method = { type: string; label: string }

// a fresh install's first `opencode serve` fetches its catalogue first
const READY_MS = 45_000
const ATTEMPT_MS = 15 * 60_000
const OPTIONS_TTL_MS = 10 * 60_000
const headless = (m: Method): boolean => m.type === 'oauth' && /headless/i.test(m.label)

// every server started here, stopped with Silos too (a restart mid-way
// never leaves one behind)
const live = new Set<ChildProcess>()
process.once('exit', () => {
  for (const c of live) {
    try {
      c.kill('SIGKILL')
    } catch {
      /* gone */
    }
  }
})

/** One short-lived `opencode serve` — always stopped by the caller. */
async function serve(cwd: string): Promise<Served> {
  const port = await allocatePort()
  const password = randomBytes(24).toString('base64url')
  const child = spawn(opencodeBin(), ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd,
    env: { ...cleanEnv(), OPENCODE_SERVER_USERNAME: 'silos', OPENCODE_SERVER_PASSWORD: password, OPENCODE_DISABLE_AUTOUPDATE: '1' },
    stdio: 'ignore',
  })
  live.add(child)
  child.once('exit', () => live.delete(child))
  const served = { child, base: `http://127.0.0.1:${port}`, auth: `Basic ${Buffer.from(`silos:${password}`).toString('base64')}` }
  const until = Date.now() + READY_MS
  while (Date.now() < until) {
    if (child.exitCode !== null) break
    try {
      const r = await fetch(`${served.base}/provider/auth`, { headers: { authorization: served.auth } })
      if (r.ok) return served
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  stop(served)
  throw new Error('OpenCode did not start its sign-in')
}

// stopped for sure: a server still starting may not heed SIGTERM — never
// leave one behind
function stop(s: Served): void {
  try {
    s.child.kill('SIGTERM')
  } catch {
    /* gone */
  }
  const t = setTimeout(() => {
    if (s.child.exitCode === null && s.child.signalCode === null) {
      try {
        s.child.kill('SIGKILL')
      } catch {
        /* gone */
      }
    }
  }, 3000)
  t.unref()
}

// every call is bounded (OpenCode may fetch its catalogue over the network)
// — except the callback, which waits for the person by design
const CALL_MS = 15_000
async function call<T>(s: Served, path: string, body?: unknown, timeoutMs: number | null = CALL_MS): Promise<T> {
  const r = await fetch(`${s.base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: s.auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(timeoutMs === null ? {} : { signal: AbortSignal.timeout(timeoutMs) }),
  })
  if (!r.ok) throw new Error(`OpenCode answered ${r.status}`)
  return (await r.json()) as T
}

// the providers' display names — a nicety: short, and the id when it lags
function providerNames(s: Served): Promise<{ all?: Array<{ id: string; name?: string }> }> {
  return call<{ all?: Array<{ id: string; name?: string }> }>(s, '/provider', undefined, 4_000).catch(() => ({ all: [] }))
}

export class OpencodeSignIns {
  private attempts = new Map<string, SignInState & { stop: () => void }>()
  private options: { at: number; list: SignInOption[] } | null = null

  constructor(
    private readonly cwd: string,
    private readonly onDone: (providerId: string, name: string) => void,
  ) {}

  /** The providers OpenCode can sign in to headlessly (cached a while). */
  async list(): Promise<SignInOption[]> {
    if (this.options && Date.now() - this.options.at < OPTIONS_TTL_MS) return this.options.list
    const s = await serve(this.cwd)
    try {
      const methods = await call<Record<string, Method[]>>(s, '/provider/auth')
      const names = await providerNames(s)
      const nameOf = (id: string): string => names.all?.find((p) => p.id === id)?.name ?? id
      const list = Object.entries(methods).flatMap(([providerId, ms]) =>
        ms.filter(headless).map((m) => ({ providerId, name: nameOf(providerId), label: m.label.replace(/\s*\(headless\)\s*$/i, '') })),
      )
      this.options = { at: Date.now(), list }
      return list
    } finally {
      stop(s)
    }
  }

  /** Starts a sign-in: the link and the code to show; the wait runs on. */
  async start(providerId: string): Promise<{ id: string; url: string; instructions: string }> {
    const s = await serve(this.cwd)
    try {
      const methods = (await call<Record<string, Method[]>>(s, '/provider/auth'))[providerId] ?? []
      const method = methods.findIndex(headless)
      if (method < 0) throw new Error(`OpenCode offers no sign-in by link for ${providerId}`)
      const name = (await providerNames(s)).all?.find((p) => p.id === providerId)?.name ?? providerId
      const a = await call<{ url: string; instructions?: string }>(s, `/provider/${encodeURIComponent(providerId)}/oauth/authorize`, { method })
      const id = randomUUID()
      const timer = setTimeout(() => this.settle(id, { state: 'failed', providerId, error: 'The sign-in expired — start again.' }), ATTEMPT_MS)
      const end = (): void => {
        clearTimeout(timer)
        stop(s)
      }
      this.attempts.set(id, { state: 'waiting', providerId, url: a.url, instructions: a.instructions ?? '', stop: end })
      // returns once the person finished at the provider (or it failed)
      void call<boolean>(s, `/provider/${encodeURIComponent(providerId)}/oauth/callback`, { method }, null)
        .then((ok) => {
          if (ok) {
            this.onDone(providerId, name)
            this.settle(id, { state: 'done', providerId })
          } else this.settle(id, { state: 'failed', providerId, error: 'The provider did not confirm the sign-in — start again.' })
        })
        .catch(() => this.settle(id, { state: 'failed', providerId, error: 'The sign-in did not finish — start again.' }))
      return { id, url: a.url, instructions: a.instructions ?? '' }
    } catch (err) {
      stop(s)
      throw err
    }
  }

  status(id: string): SignInState | null {
    const a = this.attempts.get(id)
    if (!a) return null
    const { stop: _s, ...view } = a
    return view
  }

  cancel(id: string): void {
    this.settle(id, null)
  }

  private settle(id: string, next: SignInState | null): void {
    const a = this.attempts.get(id)
    if (!a) return
    a.stop()
    if (next === null || a.state !== 'waiting') {
      if (next === null) this.attempts.delete(id)
      return
    }
    this.attempts.set(id, { ...next, stop: () => {} })
    // a finished attempt is read once by the page, then forgotten
    setTimeout(() => this.attempts.delete(id), 10 * 60_000).unref()
  }
}
