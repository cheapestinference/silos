// account-login.test.ts — signing in to an extra Claude account from the UI.
// The sign-in is a terminal running Claude's own `claude auth login` under
// the account's CLAUDE_CONFIG_DIR (here a stand-in script, never the real
// claude): it prints its link, waits for the pasted code, signs the account
// in (for the fake `claude auth status`, helpers/fake-claude-auth.ts) and
// exits. Silos only carries the bytes; the account then verifies as logged in.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import type { FastifyInstance } from 'fastify'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { ProvidersStore } from '../src/providers-store.js'
import { AccountsService } from '../src/harnesses/claude-code/accounts.js'
import { TerminalService } from '../src/terminal-service.js'
import { buildServer } from '../src/server.js'
import { asOwner, ownerHeaders } from './helpers/owner.js'
import { FAKE_AUTH_FILE, fakeIdentity, fakeSignIn } from './helpers/fake-claude-auth.js'

const TOKEN = 't0k-acctlogin'
let app: FastifyInstance | undefined
let terminals: TerminalService | undefined

afterEach(async () => {
  terminals?.killAll()
  terminals?.stopReaper()
  await app?.close()
  app = undefined
})

// stands in for `claude auth login`: the same shape of exchange
const FAKE_LOGIN = `#!/bin/sh
printf 'Opening browser to sign in\\r\\n'
printf 'config=[%s]\\r\\n' "\${CLAUDE_CONFIG_DIR-unset}"
printf 'visit: \\033]8;;https://claude.example/oauth?x=1\\007https://claude.example/oauth?x=1\\033]8;;\\007\\r\\n'
printf 'Paste code here if prompted > '
read code
if [ "$code" = "GOOD" ]; then printf '{"loggedIn":true}' > "$CLAUDE_CONFIG_DIR/${FAKE_AUTH_FILE}"; printf 'Login successful\\r\\n'; exit 0; fi
printf 'Invalid code\\r\\n'; exit 1
`

async function setup(): Promise<{ port: number; dataDir: string; agentFolder: string; base: string }> {
  const base = mkdtempSync(join(tmpdir(), 'silos-acctlogin-'))
  const root = join(base, 'projects')
  const dataDir = join(base, 'data')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(dataDir, 'trash'), { recursive: true })
  mkdirSync(join(base, 'claude'), { recursive: true })
  const agentFolder = mkdtempSync(join(tmpdir(), 'silos-acctlogin-folder-'))
  const script = join(base, 'fake-login.sh')
  writeFileSync(script, FAKE_LOGIN)
  chmodSync(script, 0o755)
  const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  await index.init()
  const registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  registry.create({ id: 'writer', name: 'Writer', folder: agentFolder })
  const native = new NativeStore(join(dataDir, 'native.json'))
  const chat = new ChatService({
    registry,
    native,
    queryFn: () => ({
      async *[Symbol.asyncIterator]() {},
      async interrupt() {
        return undefined
      },
    }),
  })
  const providers = new ProvidersStore(dataDir)
  providers.load()
  const accounts = new AccountsService({ dataDir, defaultConfigDir: join(base, 'claude'), identity: fakeIdentity(join(base, 'claude')) })
  terminals = new TerminalService(registry, index, undefined, undefined, {
    loginCommand: () => ({ file: script, args: [] }),
    tmuxSocket: 'silos-acctlogin-none',
    sessionsDir: join(base, 'claude-sessions'),
  })
  app = buildServer({
    index,
    registry,
    store: new SessionStore(root, dataDir),
    native,
    chat,
    exec: new ExecService(registry),
    complete: new CompleteService(registry, index),
    prefs: new PrefsStore(dataDir),
    memory: new MemoryService(root, dataDir, registry),
    terminals,
    providers,
    accounts,
    token: TOKEN,
    liveMs: 120_000,
    terminalPingMs: 60_000,
  })
  asOwner(app, TOKEN)
  await app.listen({ port: 0, host: '127.0.0.1' })
  return { port: (app.server.address() as { port: number }).port, dataDir, agentFolder, base }
}

async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for the condition')
    await new Promise((r) => setTimeout(r, 30))
  }
}

const post = (port: number, path: string, body: unknown = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { ...ownerHeaders(TOKEN), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('POST /api/accounts/:name/login', () => {
  it('opens Claude’s sign-in in a terminal; a late socket still gets the link; the pasted code signs the account in', async () => {
    const { port } = await setup()
    expect((await post(port, '/api/accounts', { name: 'kai' })).status).toBe(201)
    const res = await post(port, '/api/accounts/kai/login')
    expect(res.status).toBe(201)
    const { terminal } = (await res.json()) as { terminal: { id: string } }
    // the link is printed before any socket attaches — the backlog carries it
    await new Promise((r) => setTimeout(r, 300))
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal/${terminal.id}?token=${TOKEN}`)
    let out = ''
    let closed = false
    ws.on('message', (d) => {
      out += String(d)
    })
    ws.on('close', () => {
      closed = true
    })
    await until(() => out.includes('Paste code here'))
    expect(out).toContain('https://claude.example/oauth?x=1')
    ws.send(JSON.stringify({ op: 'write', data: 'GOOD\r' }))
    await until(() => closed)
    const v = (await (await post(port, '/api/accounts/kai/verify')).json()) as { account: { loggedIn: boolean } }
    expect(v.account.loggedIn).toBe(true)
  })

  it('one sign-in per account: asking again while it runs returns the same terminal', async () => {
    const { port } = await setup()
    await post(port, '/api/accounts', { name: 'kai' })
    const a = (await (await post(port, '/api/accounts/kai/login')).json()) as { terminal: { id: string } }
    const b = (await (await post(port, '/api/accounts/kai/login')).json()) as { terminal: { id: string } }
    expect(b.terminal.id).toBe(a.terminal.id)
  })

  it('refuses an unknown account', async () => {
    const { port } = await setup()
    expect((await post(port, '/api/accounts/nobody/login')).status).toBe(404)
  })

  // the first run's «Sign in to Claude ›»: the
  // machine's account signs in from the UI only while it is signed out, and
  // as the machine's own login — no CLAUDE_CONFIG_DIR, so Claude writes
  // where its operator's terminal would
  it("signs the machine's account in only while it is signed out, with Claude's own default location", async () => {
    const { port, base } = await setup()
    const res = await post(port, '/api/accounts/default/login')
    expect(res.status).toBe(201)
    const { terminal } = (await res.json()) as { terminal: { id: string } }
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal/${terminal.id}?token=${TOKEN}`)
    let out = ''
    ws.on('message', (d) => {
      out += String(d)
    })
    await until(() => out.includes('Paste code here'))
    expect(out).toContain('config=[unset]')
    ws.close()
    terminals?.killAll()
    // once the machine is signed in, a UI sign-in would replace its login: refused
    fakeSignIn(join(base, 'claude'))
    expect((await post(port, '/api/accounts/default/login')).status).toBe(409)
  })

  it('a sign-in does not take one of the four shell slots', async () => {
    const { port, agentFolder } = await setup()
    await post(port, '/api/accounts', { name: 'kai' })
    expect((await post(port, '/api/accounts/kai/login')).status).toBe(201)
    for (let i = 0; i < 4; i++) expect((await post(port, '/api/terminals', { agentId: 'writer' })).status).toBe(201)
    expect(agentFolder).toBeTruthy()
  })
})
