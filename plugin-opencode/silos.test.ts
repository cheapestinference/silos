import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin, { AGENT_SHELL_SILOS_ENV, SilosPlugin, askRecord, birthRecord, questionRecord, silosEnv, writeAtomic } from './silos.ts'

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const SILOS_KEYS = [
  'SILOS_AGENT_STATE',
  'SILOS_AGENT_ID',
  'SILOS_SESSION_ID',
  'SILOS_CONSOLE_KEY',
  'SILOS_ASK_TIMEOUT_MS',
  'SILOS_AGENT_TOKEN',
  'SILOS_PLUGIN_DEBUG',
  'SILOS_ASKS_REPLIES',
]

let state: string
// the Silos-owned reply dir (<dataDir>/asks-replies/<agent>): never under the
// agent's own state dir, which the agent can write
let replies: string
let saved: Record<string, string | undefined>

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), 'silos-oc-'))
  replies = mkdtempSync(join(tmpdir(), 'silos-oc-replies-'))
  saved = Object.fromEntries(SILOS_KEYS.map((k) => [k, process.env[k]]))
  for (const k of SILOS_KEYS) delete process.env[k]
  process.env.SILOS_AGENT_STATE = state
  process.env.SILOS_AGENT_ID = 'writer'
  process.env.SILOS_ASKS_REPLIES = replies
})

afterEach(() => {
  for (const k of SILOS_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  rmSync(state, { recursive: true, force: true })
  rmSync(replies, { recursive: true, force: true })
})

/** Silos' answer, where AsksStore.reply writes it. */
const answer = (id: string, status: string, sessionID = 'ses_x'): void => {
  mkdirSync(join(replies, sessionID), { recursive: true })
  writeFileSync(join(replies, sessionID, `${id}.reply.json`), JSON.stringify({ status }))
}
const replyPath = (id: string, sessionID = 'ses_x'): string => join(replies, sessionID, `${id}.reply.json`)
const empty = (d: string): boolean => !existsSync(d) || readdirSync(d).length === 0

const hooks = (client: unknown = {}) => SilosPlugin({ directory: '/plugin-dir', client } as never)
const created = (id: string, directory?: string) =>
  ({
    event: { type: 'session.created', properties: { sessionID: id, info: { id, ...(directory ? { directory } : {}) } } },
  }) as never
const permission = (over: Record<string, unknown> = {}) =>
  ({
    id: 'per_1',
    type: 'bash',
    pattern: 'rm *',
    sessionID: 'ses_x',
    messageID: 'msg_1',
    title: 'Run rm',
    metadata: { command: 'rm -rf build' },
    time: { created: 1 },
    ...over,
  }) as never
const mode = (p: string) => statSync(p).mode & 0o777

describe('module shape', () => {
  it('default-exports { id, server } so OpenCode never calls the helpers as plugins', () => {
    expect(plugin).toEqual({ id: 'silos', server: SilosPlugin })
  })
})

describe('birthRecord', () => {
  it('builds the marker from env and the session info', () => {
    const r = birthRecord({ SILOS_AGENT_ID: 'writer', SILOS_SESSION_ID: 'ses_parent', SILOS_CONSOLE_KEY: 'k1' }, { id: 'ses_x', directory: '/p' })
    expect(r).toEqual({
      sessionId: 'ses_x',
      agentId: 'writer',
      parent: 'ses_parent',
      cwd: '/p',
      source: 'startup',
      harness: 'opencode',
      consoleKey: 'k1',
      at: expect.stringMatching(ISO),
    })
  })

  it('has no parent when SILOS_SESSION_ID names the session itself', () => {
    expect(birthRecord({ SILOS_AGENT_ID: 'writer', SILOS_SESSION_ID: 'ses_x' }, { id: 'ses_x', directory: '/p' }).parent).toBeNull()
  })

  it("prefers OpenCode's own parentID (a subagent session) over SILOS_SESSION_ID", () => {
    expect(birthRecord({ SILOS_AGENT_ID: 'writer', SILOS_SESSION_ID: 'ses_parent' }, { id: 'ses_child', directory: '/p', parentID: 'ses_main' }).parent).toBe(
      'ses_main',
    )
  })

  it('an empty SILOS_CONSOLE_KEY is null, like an empty SILOS_AGENT_ID', () => {
    expect(birthRecord({ SILOS_AGENT_ID: '', SILOS_CONSOLE_KEY: '' }, { id: 'ses_x', directory: '/p' })).toMatchObject({ agentId: null, consoleKey: null })
  })

  it("a child session (parentID) never advertises the console key — it is the parent's", () => {
    expect(birthRecord({ SILOS_AGENT_ID: 'writer', SILOS_CONSOLE_KEY: 'k1' }, { id: 'ses_child', directory: '/p', parentID: 'ses_main' }).consoleKey).toBeNull()
  })

  it('has null parent and consoleKey when the env does not carry them', () => {
    const r = birthRecord({ SILOS_AGENT_ID: 'writer' }, { id: 'ses_x', directory: '/p' })
    expect(r.parent).toBeNull()
    expect(r.consoleKey).toBeNull()
  })
})

describe('askRecord', () => {
  it('keeps the permission fields Silos shows', () => {
    expect(askRecord(permission())).toEqual({
      id: 'per_1',
      sessionId: 'ses_x',
      type: 'bash',
      pattern: 'rm *',
      title: 'Run rm',
      metadata: { command: 'rm -rf build' },
      askedAt: expect.stringMatching(ISO),
    })
  })

  it('fills missing optional fields with null / {}', () => {
    const r = askRecord(permission({ pattern: undefined, title: undefined, metadata: undefined }))
    expect(r.pattern).toBeNull()
    expect(r.title).toBeNull()
    expect(r.metadata).toEqual({})
  })
})

describe('writeAtomic', () => {
  it('writes 0600 JSON and never overwrites an existing file', () => {
    const p = join(state, 'a.json')
    expect(writeAtomic(p, { n: 1 })).toBe(true)
    expect(writeAtomic(p, { n: 2 })).toBe(false)
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ n: 1 })
    expect(mode(p)).toBe(0o600)
    expect(readdirSync(state)).toEqual(['a.json'])
  })

  it('the file never has two names — renamed into place, never hard-linked (Silos refuses a file with more than one name)', () => {
    const linkSpy = vi.spyOn(fs, 'linkSync')
    syncBuiltinESMExports()
    try {
      const p = join(state, 'b.json')
      expect(writeAtomic(p, { n: 1 })).toBe(true)
      expect(linkSpy).not.toHaveBeenCalled()
      expect(statSync(p).nlink).toBe(1)
      expect(readdirSync(state)).toEqual(['b.json'])
      expect(writeAtomic(p, { n: 2 })).toBe(false)
      expect(readdirSync(state)).toEqual(['b.json']) // the losing temp file is gone too
    } finally {
      linkSpy.mockRestore()
      syncBuiltinESMExports()
    }
  })
})

describe('event: session.created', () => {
  it('writes births/<id>.json 0600 in a 0700 dir', async () => {
    process.env.SILOS_SESSION_ID = 'ses_parent'
    await (
      await hooks()
    ).event!(created('ses_x', '/p'))
    const file = join(state, 'births', 'ses_x.json')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      sessionId: 'ses_x',
      agentId: 'writer',
      parent: 'ses_parent',
      cwd: '/p',
      source: 'startup',
      harness: 'opencode',
    })
    expect(mode(file)).toBe(0o600)
    expect(mode(join(state, 'births'))).toBe(0o700)
  })

  it('falls back to the plugin directory for cwd', async () => {
    await (
      await hooks()
    ).event!(created('ses_x'))
    expect(JSON.parse(readFileSync(join(state, 'births', 'ses_x.json'), 'utf8')).cwd).toBe('/plugin-dir')
  })

  it('first birth wins, across processes', async () => {
    await (
      await hooks()
    ).event!(created('ses_x', '/first'))
    await (
      await hooks()
    ).event!(created('ses_x', '/second'))
    expect(JSON.parse(readFileSync(join(state, 'births', 'ses_x.json'), 'utf8')).cwd).toBe('/first')
  })

  it('ignores a session id that is not a safe path segment', async () => {
    await (
      await hooks()
    ).event!(created('../evil', '/p'))
    expect(existsSync(join(state, 'evil.json'))).toBe(false)
    expect(existsSync(join(state, 'births')) ? readdirSync(join(state, 'births')) : []).toEqual([])
  })

  // `opencode run` creates its session in the same request that loads the
  // plugin, and the plugin never sees that session.created (1.14.22).
  it('records a session first seen in session.updated when it was created after this process started', async () => {
    const h = await hooks()
    const info = { id: 'ses_run', directory: '/p', time: { created: Date.now() } }
    await h.event!({ event: { type: 'session.updated', properties: { sessionID: 'ses_run', info } } } as never)
    expect(JSON.parse(readFileSync(join(state, 'births', 'ses_run.json'), 'utf8'))).toMatchObject({ sessionId: 'ses_run', cwd: '/p', source: 'startup' })
  })

  it('never records a resumed session (created before this process started)', async () => {
    const info = { id: 'ses_old', directory: '/p', time: { created: Date.now() - 3_600_000 * 24 * 365 * 30 } }
    await (
      await hooks()
    ).event!({ event: { type: 'session.updated', properties: { sessionID: 'ses_old', info } } } as never)
    expect(existsSync(join(state, 'births', 'ses_old.json'))).toBe(false)
  })

  it('ignores other events', async () => {
    await (
      await hooks()
    ).event!({ event: { type: 'session.updated', properties: { info: { id: 'ses_x' } } } } as never)
    expect(existsSync(join(state, 'births'))).toBe(false)
  })
})

describe('event: permission.replied', () => {
  it('removes the ask and reply files (v1 and v2 id field)', async () => {
    const dir = join(state, 'asks', 'ses_x')
    mkdirSync(dir, { recursive: true })
    for (const f of ['per_1.json', 'per_2.json']) writeFileSync(join(dir, f), '{}')
    answer('per_1', 'allow')
    const h = await hooks()
    await h.event!({ event: { type: 'permission.replied', properties: { sessionID: 'ses_x', permissionID: 'per_1', response: 'once' } } } as never)
    await h.event!({ event: { type: 'permission.replied', properties: { sessionID: 'ses_x', requestID: 'per_2', reply: 'once' } } } as never)
    expect(readdirSync(dir)).toEqual([])
    expect(readdirSync(join(replies, 'ses_x'))).toEqual([])
  })
})

describe('event: permission.asked (the live bridge)', () => {
  const asked = (id: string, sessionID = 'ses_x') =>
    ({
      event: {
        type: 'permission.asked',
        properties: { id, sessionID, permission: 'bash', patterns: ['rm *'], metadata: { command: 'rm -rf build' }, always: ['rm *'] },
      },
    }) as never
  const replied = (id: string, sessionID = 'ses_x') =>
    ({
      event: { type: 'permission.replied', properties: { sessionID, requestID: id, reply: 'once' } },
    }) as never
  const fakeClient = () => ({ permission: { reply: vi.fn(async () => ({})) } })
  const until = async (cond: () => boolean, ms = 2000) => {
    const end = Date.now() + ms
    while (!cond()) {
      if (Date.now() > end) throw new Error('condition not met in time')
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  const dir = () => join(state, 'asks', 'ses_x')

  it('writes the ask file from the PermissionRequest without blocking the event', async () => {
    process.env.SILOS_ASK_TIMEOUT_MS = '300'
    await (
      await hooks(fakeClient())
    ).event!(asked('per_a'))
    // the ask file is still there: had the event waited for the 300 ms
    // deadline, the poller would already have removed it
    const file = join(dir(), 'per_a.json')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      id: 'per_a',
      sessionId: 'ses_x',
      type: 'bash',
      pattern: ['rm *'],
      title: null,
      metadata: { command: 'rm -rf build' },
      askedAt: expect.stringMatching(ISO),
    })
    expect(mode(file)).toBe(0o600)
  })

  it("an allow reply answers OpenCode with 'once' and removes both files", async () => {
    const client = fakeClient()
    await (
      await hooks(client)
    ).event!(asked('per_a'))
    await new Promise((r) => setTimeout(r, 100))
    answer('per_a', 'allow')
    await until(() => client.permission.reply.mock.calls.length > 0 && empty(dir()) && empty(join(replies, 'ses_x')))
    expect(client.permission.reply).toHaveBeenCalledWith({ requestID: 'per_a', reply: 'once' })
  })

  it("a deny reply answers 'reject'", async () => {
    const client = fakeClient()
    await (
      await hooks(client)
    ).event!(asked('per_a'))
    answer('per_a', 'deny')
    await until(() => empty(dir()) && empty(join(replies, 'ses_x')))
    expect(client.permission.reply).toHaveBeenCalledWith({ requestID: 'per_a', reply: 'reject' })
  })

  it('a client without a permission.reply method never answers: the ask stays for the owner', async () => {
    const client = { postSessionIdPermissionsPermissionId: vi.fn(async () => ({})) }
    await (
      await hooks(client)
    ).event!(asked('per_a'))
    answer('per_a', 'allow')
    await until(() => !existsSync(replyPath('per_a')))
    expect(existsSync(join(dir(), 'per_a.json'))).toBe(true)
    expect(client.postSessionIdPermissionsPermissionId).not.toHaveBeenCalled()
  })

  it('a reply given in the TUI stops the poller and removes the ask file', async () => {
    const client = fakeClient()
    const h = await hooks(client)
    await h.event!(asked('per_a'))
    await h.event!(replied('per_a'))
    expect(existsSync(join(dir(), 'per_a.json'))).toBe(false)
    answer('per_a', 'allow')
    await new Promise((r) => setTimeout(r, 700))
    expect(client.permission.reply).not.toHaveBeenCalled()
  })

  it('on timeout removes the ask file and never replies', async () => {
    process.env.SILOS_ASK_TIMEOUT_MS = '300'
    const client = fakeClient()
    await (
      await hooks(client)
    ).event!(asked('per_a'))
    await until(() => !existsSync(join(dir(), 'per_a.json')), 1000)
    answer('per_a', 'allow')
    await new Promise((r) => setTimeout(r, 600))
    expect(client.permission.reply).not.toHaveBeenCalled()
  })

  it('two concurrent asks in one session are independent', async () => {
    const client = fakeClient()
    const h = await hooks(client)
    await h.event!(asked('per_a'))
    await h.event!(asked('per_b'))
    answer('per_b', 'deny')
    await until(() => client.permission.reply.mock.calls.length === 1)
    expect(client.permission.reply).toHaveBeenCalledWith({ requestID: 'per_b', reply: 'reject' })
    expect(existsSync(join(dir(), 'per_a.json'))).toBe(true)
    answer('per_a', 'allow')
    await until(() => client.permission.reply.mock.calls.length === 2 && empty(dir()) && empty(join(replies, 'ses_x')))
    expect(client.permission.reply).toHaveBeenCalledWith({ requestID: 'per_a', reply: 'once' })
  })

  it('a failing client is swallowed (quiet unless SILOS_PLUGIN_DEBUG): only the reply goes, the ask stays to be answered again', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    let fail = true
    const client = {
      permission: {
        reply: vi.fn(async () => {
          if (fail) throw new Error('boom')
        }),
      },
    }
    await (
      await hooks(client)
    ).event!(asked('per_a'))
    answer('per_a', 'allow')
    await until(() => client.permission.reply.mock.calls.length > 0 && !existsSync(replyPath('per_a')))
    expect(existsSync(join(dir(), 'per_a.json'))).toBe(true)
    expect(err).not.toHaveBeenCalled()
    // the owner answers again from Needs you: the same poller picks it up
    fail = false
    answer('per_a', 'deny')
    await until(() => client.permission.reply.mock.calls.length === 2 && empty(dir()) && empty(join(replies, 'ses_x')))
    expect(client.permission.reply).toHaveBeenLastCalledWith({ requestID: 'per_a', reply: 'reject' })
    process.env.SILOS_PLUGIN_DEBUG = '1'
    fail = true
    await (
      await hooks(client)
    ).event!(asked('per_b'))
    answer('per_b', 'allow')
    await until(() => err.mock.calls.length > 0)
    expect(String(err.mock.calls[0]?.[0])).toMatch(/^silos: permission reply failed/)
    err.mockRestore()
  })

  it('a client error that the request is already answered (404) removes both files', async () => {
    const thrown = {
      permission: {
        reply: vi.fn(async () => {
          throw Object.assign(new Error('Not Found'), { status: 404 })
        }),
      },
    }
    await (
      await hooks(thrown)
    ).event!(asked('per_a'))
    answer('per_a', 'allow')
    await until(() => thrown.permission.reply.mock.calls.length > 0 && empty(dir()) && empty(join(replies, 'ses_x')))
    // the generated client does not throw: it resolves { error, response }
    const resolved = { permission: { reply: vi.fn(async () => ({ error: { name: 'NotFoundError' }, response: { status: 404 } })) } }
    await (
      await hooks(resolved)
    ).event!(asked('per_b'))
    answer('per_b', 'allow')
    await until(() => resolved.permission.reply.mock.calls.length > 0 && empty(dir()) && empty(join(replies, 'ses_x')))
  })

  it('a client that resolves an error (not 404) counts as a failure: the ask stays', async () => {
    const client = { permission: { reply: vi.fn(async () => ({ error: { message: 'boom' }, response: { status: 500 } })) } }
    await (
      await hooks(client)
    ).event!(asked('per_a'))
    answer('per_a', 'allow')
    await until(() => client.permission.reply.mock.calls.length > 0 && !existsSync(replyPath('per_a')))
    expect(existsSync(join(dir(), 'per_a.json'))).toBe(true)
  })

  it("the poller's timers never hold a headless process open (unref)", async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout')
    process.env.SILOS_ASK_TIMEOUT_MS = '2000'
    await (
      await hooks(fakeClient())
    ).event!(asked('per_a'))
    await new Promise((r) => setTimeout(r, 50))
    // the poller's own: the first tick (0 ms) and the next poll (500 ms) — not this test's 50 ms sleep
    const pollerTimers = spy.mock.calls.flatMap((c, i) => (c[1] === 0 || c[1] === 500 ? [spy.mock.results[i]!.value as { hasRef: () => boolean }] : []))
    spy.mockRestore()
    expect(pollerTimers.length).toBe(2)
    for (const h of pollerTimers) expect(h.hasRef()).toBe(false)
  })

  // M2 (final review 26-10): the agent's own state dir is writable by the
  // agent; a reply there would approve its own ask. Only SILOS_ASKS_REPLIES counts.
  it("a reply file planted beside the ask in the agent's own state dir is never read", async () => {
    process.env.SILOS_ASK_TIMEOUT_MS = '1500'
    const client = fakeClient()
    await (
      await hooks(client)
    ).event!(asked('per_a'))
    writeFileSync(join(dir(), 'per_a.reply.json'), JSON.stringify({ status: 'allow' }))
    await new Promise((r) => setTimeout(r, 700))
    expect(client.permission.reply).not.toHaveBeenCalled()
    expect(existsSync(join(dir(), 'per_a.json'))).toBe(true)
  })

  it('without SILOS_ASKS_REPLIES the ask is still shown but no reply is ever read (fails closed)', async () => {
    delete process.env.SILOS_ASKS_REPLIES
    process.env.SILOS_ASK_TIMEOUT_MS = '1500'
    const client = fakeClient()
    await (
      await hooks(client)
    ).event!(asked('per_a'))
    expect(existsSync(join(dir(), 'per_a.json'))).toBe(true)
    writeFileSync(join(dir(), 'per_a.reply.json'), JSON.stringify({ status: 'allow' }))
    await new Promise((r) => setTimeout(r, 700))
    expect(client.permission.reply).not.toHaveBeenCalled()
  })

  it('refuses ids that are not safe path segments', async () => {
    const client = fakeClient()
    await (
      await hooks(client)
    ).event!(asked('../x'))
    await (
      await hooks(client)
    ).event!(asked('per_a', '..'))
    expect(existsSync(join(state, 'asks'))).toBe(false)
  })
})

describe("'shell.env'", () => {
  it('copies the agent-facing SILOS_* keys; non-Silos variables are left to OpenCode', async () => {
    process.env.SILOS_AGENT_TOKEN = 'tok'
    const output = { env: {} as Record<string, string> }
    await (
      await hooks()
    )['shell.env']!({ cwd: '/p' }, output)
    expect(output.env).toMatchObject({ SILOS_AGENT_TOKEN: 'tok', SILOS_AGENT_ID: 'writer', SILOS_AGENT_STATE: state })
    expect(output.env.HOME).toBeUndefined()
    expect(Object.keys(output.env).every((k) => k.startsWith('SILOS_'))).toBe(true)
  })

  // The rule (security, 21-11): no credential the launcher hands the
  // OpenCode PROCESS reaches the agent's shell non-empty. The shell's env is
  // what OpenCode builds — its own process env with this hook's output over
  // it — so the check runs on that merge, for every variant the launcher
  // sets (launch.ts envFor) and for a SILOS_* name nobody listed yet.
  describe('no provider or owner credential reaches a shell non-empty', () => {
    const CREDENTIALS: Record<string, string> = {
      SILOS_PROVIDER_KEY: 'sk-provider-secret', // the provider's API key (launch.ts PROVIDER_KEY_ENV)
      OPENCODE_SERVER_PASSWORD: 'tui-password', // the TUI server's basic auth (launch.ts envFor)
      SILOS_CONSOLE_KEY: 'console-key', // seals a conversation as this console's
      SILOS_TOKEN: 'owner-token', // the owner's static token, should a server ever leak it
      SILOS_FUTURE_SECRET: 'unlisted', // a SILOS_* variable added later, never decided
    }
    const keys = [...Object.keys(CREDENTIALS), 'SILOS_API', 'SILOS_TURN', 'OPENCODE_DB']
    let before: Record<string, string | undefined>
    beforeEach(() => {
      before = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
    })
    afterEach(() => {
      for (const k of keys) {
        if (before[k] === undefined) delete process.env[k]
        else process.env[k] = before[k]
      }
    })

    it('each one is blanked over the process env, the agent-facing ones pass', async () => {
      Object.assign(process.env, CREDENTIALS, {
        SILOS_API: 'http://127.0.0.1:3210',
        SILOS_TURN: 'turn-1',
        OPENCODE_DB: '/db',
        SILOS_AGENT_TOKEN: 'agent-bearer',
      })
      const output = { env: {} as Record<string, string> }
      await (
        await hooks()
      )['shell.env']!({ cwd: '/p', sessionID: 'ses_tui' }, output)
      const shell = { ...process.env, ...output.env } // what OpenCode hands the shell
      for (const name of Object.keys(CREDENTIALS)) expect(shell[name], name).toBe('')
      for (const value of Object.values(CREDENTIALS)) expect(Object.values(shell)).not.toContain(value)
      expect(shell).toMatchObject({
        SILOS_API: 'http://127.0.0.1:3210',
        SILOS_TURN: 'turn-1',
        SILOS_AGENT_TOKEN: 'agent-bearer',
        SILOS_SESSION_ID: 'ses_tui',
        SILOS_AGENT_ID: 'writer',
        SILOS_AGENT_STATE: state,
      })
      // OpenCode's own non-secret wiring stays for a nested `opencode run`
      expect(shell.OPENCODE_DB).toBe('/db')
    })

    it('the allowlist is exactly what agents read', () => {
      expect([...AGENT_SHELL_SILOS_ENV].sort()).toEqual([
        'SILOS_AGENT_ID',
        'SILOS_AGENT_STATE',
        'SILOS_AGENT_TOKEN',
        'SILOS_API',
        'SILOS_SESSION_ID',
        'SILOS_TURN',
      ])
      expect(silosEnv({ SILOS_PROVIDER_KEY: 'k', OPENCODE_SERVER_PASSWORD: 'p', SILOS_API: 'a' })).toEqual({
        SILOS_PROVIDER_KEY: '',
        OPENCODE_SERVER_PASSWORD: '',
        SILOS_API: 'a',
      })
    })
  })

  // re-review 26-10: a nested `opencode run` from the console's shell must
  // present itself as the TUI session's CHILD, never as a new conversation
  // on the console's key (it would take over the console binding).
  it('SILOS_SESSION_ID is the calling session (input.sessionID); SILOS_CONSOLE_KEY never reaches a shell', async () => {
    process.env.SILOS_CONSOLE_KEY = 'k1'
    const output = { env: {} as Record<string, string> }
    await (
      await hooks()
    )['shell.env']!({ cwd: '/p', sessionID: 'ses_tui' }, output)
    expect(output.env.SILOS_SESSION_ID).toBe('ses_tui')
    // blanked, not omitted: OpenCode spreads its own process env under it
    expect(output.env.SILOS_CONSOLE_KEY).toBe('')
    expect(birthRecord({ ...process.env, ...output.env }, { id: 'ses_nested' }).consoleKey).toBeNull()
    expect(output.env.SILOS_AGENT_ID).toBe('writer')
  })

  it('without input.sessionID (or an unsafe one) SILOS_SESSION_ID falls back to the process env', async () => {
    process.env.SILOS_CONSOLE_KEY = 'k1'
    process.env.SILOS_SESSION_ID = 'ses_resumed'
    const output = { env: {} as Record<string, string> }
    await (
      await hooks()
    )['shell.env']!({ cwd: '/p' }, output)
    expect(output.env.SILOS_SESSION_ID).toBe('ses_resumed')
    expect(output.env.SILOS_CONSOLE_KEY).toBe('')
    const bad = { env: {} as Record<string, string> }
    await (
      await hooks()
    )['shell.env']!({ cwd: '/p', sessionID: '../x' }, bad)
    expect(bad.env.SILOS_SESSION_ID).toBe('ses_resumed')
    delete process.env.SILOS_SESSION_ID
    const none = { env: {} as Record<string, string> }
    await (
      await hooks()
    )['shell.env']!({ cwd: '/p' }, none)
    expect(none.env).not.toHaveProperty('SILOS_SESSION_ID')
  })
})

describe('outside Silos (no SILOS_AGENT_STATE / SILOS_AGENT_ID)', () => {
  for (const missing of ['SILOS_AGENT_STATE', 'SILOS_AGENT_ID']) {
    it(`every hook is a silent no-op without ${missing}`, async () => {
      delete process.env[missing]
      const h = await hooks()
      await expect(h.event!(created('ses_x', '/p'))).resolves.toBeUndefined()
      await expect(h.event!({ event: { type: 'permission.replied', properties: {} } } as never)).resolves.toBeUndefined()
      const env = { env: {} as Record<string, string> }
      await expect(h['shell.env']!({ cwd: '/p' }, env)).resolves.toBeUndefined()
      expect(env.env).toEqual({})
      expect(readdirSync(state)).toEqual([])
    })
  }

  it('never throws on malformed events or an unwritable state dir', async () => {
    const notADir = join(state, 'file')
    writeFileSync(notADir, 'x')
    process.env.SILOS_AGENT_STATE = notADir
    const h = await hooks()
    await expect(h.event!({ event: { type: 'session.created', properties: {} } } as never)).resolves.toBeUndefined()
    await expect(h.event!({ event: null } as never)).resolves.toBeUndefined()
    await expect(h.event!(created('ses_x', '/p'))).resolves.toBeUndefined()
  })
})

describe("event: question.asked (OpenCode's question tool → Needs you)", () => {
  const questions = [
    {
      question: 'Deploy now or wait?',
      header: 'Deploy',
      options: [
        { label: 'Now', description: 'ship it' },
        { label: 'Wait', description: '' },
      ],
    },
    { question: 'Which regions?', header: 'Regions', options: [{ label: 'eu' }, { label: 'us' }], multiple: true },
  ]
  const asked = (id: string, sessionID = 'ses_x') =>
    ({ event: { type: 'question.asked', properties: { id, sessionID, questions, tool: { messageID: 'm', callID: 'c' } } } }) as never
  const until = async (cond: () => boolean, ms = 2000) => {
    const end = Date.now() + ms
    while (!cond()) {
      if (Date.now() > end) throw new Error('condition not met in time')
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  const dir = () => join(state, 'asks', 'ses_x')
  const reply = (id: string, body: unknown) => {
    mkdirSync(join(replies, 'ses_x'), { recursive: true })
    writeFileSync(replyPath(id), JSON.stringify(body))
  }

  it('questionRecord keeps the questions and titles the ask with the first one', () => {
    const r = questionRecord({ id: 'que_1', sessionID: 'ses_x', questions: [...questions, { nope: 1 }], tool: { callID: 'call_9' } })
    expect(r).toEqual({
      id: 'que_1',
      sessionId: 'ses_x',
      type: 'question',
      pattern: null,
      title: 'Deploy now or wait?',
      questions: [
        {
          question: 'Deploy now or wait?',
          header: 'Deploy',
          options: [
            { label: 'Now', description: 'ship it' },
            { label: 'Wait', description: '' },
          ],
        },
        {
          question: 'Which regions?',
          header: 'Regions',
          options: [
            { label: 'eu', description: '' },
            { label: 'us', description: '' },
          ],
          multiple: true,
        },
      ],
      callId: 'call_9',
      askedAt: expect.stringMatching(ISO),
    })
  })

  it('writes a question ask file 0600', async () => {
    await (
      await hooks({ question: { reply: vi.fn(), reject: vi.fn() } })
    ).event!(asked('que_a'))
    const file = join(dir(), 'que_a.json')
    expect(JSON.parse(readFileSync(file, 'utf8')).type).toBe('question')
    expect(mode(file)).toBe(0o600)
  })

  it("an answer reply goes to question.reply with Silos' label lists and both files go", async () => {
    const client = { question: { reply: vi.fn(async () => ({})), reject: vi.fn(async () => ({})) } }
    await (
      await hooks(client)
    ).event!(asked('que_a'))
    reply('que_a', { status: 'answer', answers: [['Now'], ['eu', 'us']] })
    await until(() => client.question.reply.mock.calls.length > 0 && empty(dir()) && empty(join(replies, 'ses_x')))
    expect(client.question.reply).toHaveBeenCalledWith({ requestID: 'que_a', answers: [['Now'], ['eu', 'us']] })
    expect(client.question.reject).not.toHaveBeenCalled()
  })

  it('a deny reply rejects the question', async () => {
    const client = { question: { reply: vi.fn(async () => ({})), reject: vi.fn(async () => ({})) } }
    await (
      await hooks(client)
    ).event!(asked('que_a'))
    reply('que_a', { status: 'deny' })
    await until(() => client.question.reject.mock.calls.length > 0 && empty(dir()))
    expect(client.question.reject).toHaveBeenCalledWith({ requestID: 'que_a' })
  })

  it('a malformed reply (an allow, answers that are not label lists) is never sent', async () => {
    const client = { question: { reply: vi.fn(async () => ({})), reject: vi.fn(async () => ({})) } }
    await (
      await hooks(client)
    ).event!(asked('que_a'))
    reply('que_a', { status: 'allow' })
    await new Promise((r) => setTimeout(r, 700))
    reply('que_b', { status: 'answer', answers: 'Now' })
    await new Promise((r) => setTimeout(r, 300))
    expect(client.question.reply).not.toHaveBeenCalled()
    expect(client.question.reject).not.toHaveBeenCalled()
    expect(existsSync(join(dir(), 'que_a.json'))).toBe(true)
  })

  it('never times out: a question still waits after the permission deadline', async () => {
    process.env.SILOS_ASK_TIMEOUT_MS = '200'
    const client = { question: { reply: vi.fn(async () => ({})), reject: vi.fn(async () => ({})) } }
    await (
      await hooks(client)
    ).event!(asked('que_a'))
    await new Promise((r) => setTimeout(r, 700))
    expect(existsSync(join(dir(), 'que_a.json'))).toBe(true)
    reply('que_a', { status: 'answer', answers: [['Now'], ['eu']] })
    await until(() => client.question.reply.mock.calls.length > 0)
  })

  it('answered in the TUI (question.replied / question.rejected) stops the poller and removes the ask', async () => {
    for (const type of ['question.replied', 'question.rejected']) {
      const client = { question: { reply: vi.fn(async () => ({})), reject: vi.fn(async () => ({})) } }
      const h = await hooks(client)
      await h.event!(asked('que_t'))
      await h.event!({ event: { type, properties: { sessionID: 'ses_x', requestID: 'que_t', answers: [] } } } as never)
      expect(existsSync(join(dir(), 'que_t.json'))).toBe(false)
      reply('que_t', { status: 'answer', answers: [['Now'], ['eu']] })
      await new Promise((r) => setTimeout(r, 700))
      expect(client.question.reply).not.toHaveBeenCalled()
      rmSync(replyPath('que_t'), { force: true })
    }
  })
})
