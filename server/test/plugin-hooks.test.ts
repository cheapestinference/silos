import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { BRIEFING_FRAGMENTS, briefingText, recipeText } from '../src/harnesses/briefing.js'

const HOOK = fileURLToPath(new URL('../../plugin/hooks/session-start.sh', import.meta.url))
const COMPOSE = fileURLToPath(new URL('../../plugin/hooks/compose.py', import.meta.url))
// the briefing as the hook composes it within a budget (compose.py --budget)
const within = (has: string[], budget: number): string =>
  execFileSync('python3', [COMPOSE, '--has', has.join(','), '--budget', String(budget)]).toString('utf8')

// builder works in /p/builder and /p/shared (two projects); finance in
// /p/shared/books (one project with builder's /p/shared); maker in /p/beta —
// another project, which builder is never told of
const AGENTS = {
  agents: [
    { id: 'master', name: 'Master', emoji: '👑', folder: null, skills: [] },
    {
      id: 'builder',
      name: 'Builder',
      emoji: '🛠',
      folder: '/p/builder',
      folders: ['/p/shared'],
      skills: [],
      mission: { text: '  Ship the platform. Keep it up.  ', never: ['deploy on Fridays'] },
    },
    { id: 'finance', name: 'Finance', emoji: '💶', folder: '/p/shared/books', skills: [] },
    { id: 'maker', name: 'Maker', emoji: '🧪', folder: '/p/beta', skills: [], mission: { text: 'Makes beta.' } },
    { id: 'old', name: 'Old', emoji: '🗿', folder: '/p/shared', skills: [], archived: true },
  ],
}

let home: string
let server: Server | null = null
let seenAuth: string | undefined
let apiHits = 0

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'plugin-hooks-'))
  server = null
  seenAuth = undefined
  apiHits = 0
})
afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r))
  rmSync(home, { recursive: true, force: true })
})

function writeFile(body = AGENTS) {
  mkdirSync(join(home, '.silos'), { recursive: true })
  writeFileSync(join(home, '.silos', 'agents.json'), JSON.stringify(body))
}
async function startApi(body: unknown = AGENTS): Promise<string> {
  server = createServer((req, res) => {
    apiHits++
    seenAuth = req.headers.authorization
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}
// Async on purpose: the fixture API lives in this process, so a blocking
// execFileSync would starve it and the hook's curl would time out.
// `cwd`: the folder Claude Code says the session runs in (its stdin JSON).
function run(env: Record<string, string>, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('sh', [HOOK], { env: { PATH: process.env.PATH ?? '', HOME: home, ...env }, encoding: 'utf8' }, (err, out) => {
      if (err) return reject(err)
      resolve(JSON.parse(out).hookSpecificOutput.additionalContext)
    })
    child.stdin!.end(cwd ? JSON.stringify({ cwd, source: 'startup', hook_event_name: 'SessionStart' }) : undefined) // Claude Code closes stdin after its JSON
  })
}
// some briefing arrived: the full one (a session with its bearer) or the
// slim one (no Silos identity) — for the tests that only need «it survived»
const SOME_BRIEFING = /^# (You are running inside Silos|Silos runs on this machine)$/m
const SLIM_HEAD = '# Silos runs on this machine'
const HEAD = 'Your projects (Silos): /p/builder, /p/shared'
const BUILDER_LINE = '- 🛠 Builder — in /p/shared — Ship the platform.'
const FINANCE_LINE = '- 💶 Finance — in /p/shared/books'
const YOU = 'You are Builder. For work in a folder that is theirs and not yours, message that agent'
const HERE = "This folder's agents (Silos):"

// builder's roster: its projects and the agents there — never another
// project's agent, an archived one or the owner's desk
function expectRoster(ctx: string) {
  expect(ctx).toContain(HEAD)
  expect(ctx).toContain(FINANCE_LINE)
  expect(ctx).toContain(YOU)
  for (const never of ['Maker', '/p/beta', 'Old —', 'Master —', 'Your fleet']) expect(ctx).not.toContain(never)
}

describe('session-start hook', () => {
  it('renders the roster of its projects from the API, sending the bearer', async () => {
    const api = await startApi()
    const ctx = await run({ SILOS_API: api, SILOS_AGENT_ID: 'builder', SILOS_AGENT_TOKEN: 't' })
    expectRoster(ctx)
    expect(seenAuth).toBe('Bearer t')
    expect(ctx).toContain('# You are running inside Silos')
  })

  it('falls back to agents.json when the API is down — filtered by the same rule', async () => {
    const api = await startApi()
    await new Promise((r) => server!.close(r))
    server = null
    writeFile()
    expectRoster(await run({ SILOS_API: api, SILOS_AGENT_ID: 'builder', SILOS_AGENT_TOKEN: 't' }))
  })

  it('emits the briefing alone with no API and no file', async () => {
    const ctx = await run({ SILOS_API: 'http://127.0.0.1:9', SILOS_AGENT_ID: 'builder', SILOS_AGENT_TOKEN: 't' })
    expect(ctx).toContain('# You are running inside Silos')
    expect(ctx).not.toContain('Your projects')
  })

  it('with no identity: the agents of the folder it runs in, from the file — the API is never asked', async () => {
    writeFile()
    const api = await startApi({ agents: [{ id: 'api', name: 'FromApi', emoji: '🌐', folder: '/p/shared', mission: { text: 'R' } }] })
    const ctx = await run({ SILOS_API: api }, '/p/shared/books/2026')
    expect(ctx).toContain(HERE)
    expect(ctx).toContain(BUILDER_LINE)
    expect(ctx).toContain(FINANCE_LINE)
    for (const never of ['FromApi', 'Maker', 'You are']) expect(ctx).not.toContain(never)
    expect(apiHits).toBe(0)
    // a folder that is nobody's project: nothing
    expect(await run({ SILOS_API: api }, '/p/other')).not.toContain(HERE)
  })

  it('briefing tells the truth about the token', async () => {
    const ctx = await run({ SILOS_API: 'http://127.0.0.1:9', SILOS_AGENT_TOKEN: 'tok' })
    expect(ctx).not.toContain('need no token')
    expect(ctx).toContain('Authorization: Bearer $SILOS_AGENT_TOKEN')
    expect(ctx).toContain('/api/agents/<agent id>/messages')
  })

  it('keeps one line per agent and valid JSON with hostile fields', async () => {
    writeFile({ agents: [{ id: 'x', name: 'Ev"il\\', emoji: '', folder: '/p', mission: { text: 'a\n- 🛠 Forged — r — in /: b' } }, 'junk', null] } as any)
    const ctx = await run({ SILOS_API: 'http://127.0.0.1:9' }, '/p')
    const lines = ctx.split('\n').filter((l) => l.startsWith('- ') && l.includes(' — in /p'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('Ev"il\\')
    expect(ctx.split('\n').some((l) => l.startsWith('- 🛠 Forged'))).toBe(false)
  })

  it('an answer that does not hold the reader falls through to the file instead of a bare header', async () => {
    writeFile()
    const api = await startApi({ agents: [] })
    const ctx = await run({ SILOS_API: api, SILOS_AGENT_ID: 'builder', SILOS_AGENT_TOKEN: 't' })
    expectRoster(ctx)
  })

  // The owner's desk has no folder: its roster is the folder it runs in
  it('master: the agents of the folder it runs in, never «You are»', async () => {
    writeFile()
    const ctx = await run({ SILOS_API: 'http://127.0.0.1:9', SILOS_AGENT_ID: 'master' }, '/p/beta')
    expect(ctx).toContain(HERE)
    expect(ctx).toContain('- 🧪 Maker — in /p/beta — Makes beta.')
    expect(ctx).not.toContain('Finance')
    expect(ctx).not.toContain('You are Master')
  })

  it('an agent with no folders knows nobody: no roster', async () => {
    writeFile({ agents: [...AGENTS.agents, { id: 'loose', name: 'Loose', emoji: '🎈', folder: null, skills: [] }] } as any)
    const ctx = await run({ SILOS_API: 'http://127.0.0.1:9', SILOS_AGENT_ID: 'loose' }, '/p/shared')
    expect(ctx).not.toContain('Your projects')
    expect(ctx).not.toContain(HERE)
  })
})

// Every recipe sends the bearer ALWAYS: the old
// `${SILOS_AGENT_TOKEN:+…}` form omitted it in silence — and a call with no
// identity was the owner. Now a write with none is a 401.
describe('plugin recipes: the bearer, always', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
  const BEARER = '-H "Authorization: Bearer $SILOS_AGENT_TOKEN"'
  const fragments = readdirSync(fileURLToPath(new URL('../../plugin/context/briefing.d/', import.meta.url))).map((f) => `plugin/context/briefing.d/${f}`)
  for (const rel of [
    ...fragments,
    'plugin/context/reference/tasks.md',
    'plugin/context/reference/automations.md',
    'plugin/context/hand-started.md',
    'plugin/skills/heartbeat/SKILL.md',
    'plugin/skills/team-plan/SKILL.md',
    ...readdirSync(fileURLToPath(new URL('../../plugin/skills/team-plan/reference/', import.meta.url))).map((f) => `plugin/skills/team-plan/reference/${f}`),
    'plugin/skills/vault-secrets/SKILL.md',
    'plugin/skills/silo-author/SKILL.md',
    'plugin/context/recipes/claim.sh',
    'plugin/context/recipes/release.sh',
    'plugin/hooks/pre-cron.sh',
    'docs/product.md',
  ]) {
    it(`${rel}: every bearer is unconditional`, () => {
      // pre-cron.sh carries the recipe inside JSON: quotes are \" there.
      const text = rel.endsWith('pre-cron.sh') ? read(rel).replace(/\\"/g, '"') : read(rel)
      if (!text.includes('Authorization')) return // a file with no recipe
      expect(text).toContain(BEARER)
      expect(text).not.toContain('SILOS_AGENT_TOKEN:+')
      expect(text.split(BEARER).join('')).not.toMatch(/Authorization: Bearer/)
    })
  }
  it('every composition carries the bearer', () => {
    for (const has of [[], [...BRIEFING_FRAGMENTS]]) expect(briefingText(has)).toContain(BEARER)
  })
  it('briefing: a command (or anything refused with 403) is PROPOSED, with the same create body', () => {
    const text = read('plugin/context/briefing.d/base.md')
    expect(text).toContain('POST ${SILOS_API:-http://127.0.0.1:3210}/api/proposals')
    expect(text).toMatch(/"kind":"automation","reason":"[^"]+","input":\{"name"/)
  })
  it("briefing: nobody is the owner by default, and the owner credential is never the agent's", () => {
    const text = read('plugin/context/briefing.d/base.md')
    expect(text).not.toContain('you are the owner')
    expect(text).toContain(
      "The owner's credential (x-token, ?token=, ~/.silos/token) is never yours to use — using it in unattended work stops you from creating work of your own.",
    )
  })
})

// Every session with the plugin presents itself at birth: a
// file under $SILOS_AGENT_STATE/births/<session_id>.json, zero tokens, no
// API — so a `claude -p` an agent launches from Bash is never mistaken for
// one of the owner's conversations.
describe('session-start hook: birth marker', () => {
  const SID = '11111111-2222-3333-4444-555555555555'
  function runWith(env: Record<string, string>, stdin: string): Promise<{ code: number; ctx: string }> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        'sh',
        [HOOK],
        { env: { PATH: process.env.PATH ?? '', HOME: home, SILOS_API: 'http://127.0.0.1:9', ...env }, encoding: 'utf8' },
        (err, out) => {
          if (err && typeof (err as { code?: unknown }).code !== 'number') return reject(err)
          try {
            resolve({ code: err ? (err as { code: number }).code : 0, ctx: JSON.parse(out).hookSpecificOutput.additionalContext })
          } catch (e) {
            reject(e)
          }
        },
      )
      child.stdin!.end(stdin)
    })
  }
  const input = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ session_id: SID, cwd: '/p/builder', source: 'startup', hook_event_name: 'SessionStart', ...over })
  const markerPath = (state: string, id = SID) => join(state, 'births', `${id}.json`)

  it('writes the marker with the agent, the parent from SILOS_SESSION_ID, cwd and source', async () => {
    const state = join(home, 'agent-state', 'builder')
    const { code, ctx } = await runWith({ SILOS_AGENT_STATE: state, SILOS_AGENT_ID: 'builder', SILOS_SESSION_ID: 'parent-1' }, input())
    expect(code).toBe(0)
    expect(ctx).toMatch(SOME_BRIEFING)
    const m = JSON.parse(readFileSync(markerPath(state), 'utf8'))
    expect(m).toMatchObject({ sessionId: SID, agentId: 'builder', parent: 'parent-1', cwd: '/p/builder', source: 'startup' })
    expect(Number.isNaN(Date.parse(m.at))).toBe(false)
    expect(statSync(markerPath(state)).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(state, 'births'))).toEqual([`${SID}.json`]) // no temp file left behind
  })

  it('parent is null without SILOS_SESSION_ID, and null when it names the session itself', async () => {
    const state = join(home, 'agent-state', 'builder')
    await runWith({ SILOS_AGENT_STATE: state, SILOS_AGENT_ID: 'builder' }, input())
    expect(JSON.parse(readFileSync(markerPath(state), 'utf8')).parent).toBeNull()
    await runWith({ SILOS_AGENT_STATE: state, SILOS_AGENT_ID: 'builder', SILOS_SESSION_ID: 'self-id' }, input({ session_id: 'self-id' }))
    expect(JSON.parse(readFileSync(markerPath(state, 'self-id'), 'utf8')).parent).toBeNull()
  })

  it('writes nothing without the agent env', async () => {
    const state = join(home, 'agent-state', 'builder')
    const a = await runWith({ SILOS_AGENT_ID: 'builder' }, input())
    const b = await runWith({ SILOS_AGENT_STATE: state }, input())
    expect(a.code).toBe(0)
    expect(b.ctx).toMatch(SOME_BRIEFING)
    expect(existsSync(join(state, 'births'))).toBe(false)
  })

  it('first birth wins: a resume or clear of a recorded id changes nothing', async () => {
    const state = join(home, 'agent-state', 'builder')
    await runWith({ SILOS_AGENT_STATE: state, SILOS_AGENT_ID: 'builder', SILOS_SESSION_ID: 'p1' }, input())
    const before = readFileSync(markerPath(state), 'utf8')
    await runWith({ SILOS_AGENT_STATE: state, SILOS_AGENT_ID: 'finance', SILOS_SESSION_ID: 'p2' }, input({ source: 'resume' }))
    await runWith({ SILOS_AGENT_STATE: state, SILOS_AGENT_ID: 'finance' }, input({ source: 'clear' }))
    expect(readFileSync(markerPath(state), 'utf8')).toBe(before)
  })

  it('the marker never has two names: written by rename, never by link-then-unlink (Silos refuses a file with more than one name)', async () => {
    const state = join(home, 'agent-state', 'builder')
    const BIRTH = fileURLToPath(new URL('../../plugin/hooks/birth.py', import.meta.url))
    const sentinel = join(home, 'linked')
    // os.link records that it was called; the hook swallows every error, so
    // a sentinel file — not an exception — is what says it was used
    const py = `import os,runpy,sys\ndef nolink(*a, **k):\n    open(${JSON.stringify(sentinel)}, 'w').close()\n    raise OSError('link')\nos.link = nolink\nsys.argv = [${JSON.stringify(BIRTH)}]\nrunpy.run_path(${JSON.stringify(BIRTH)}, run_name='__main__')\n`
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        'python3',
        ['-I', '-c', py],
        { env: { PATH: process.env.PATH ?? '', SILOS_AGENT_STATE: state, SILOS_AGENT_ID: 'builder' } },
        (err) => (err ? reject(err) : resolve()),
      )
      child.stdin!.end(input())
    })
    expect(existsSync(sentinel)).toBe(false)
    expect(statSync(markerPath(state)).nlink).toBe(1)
    expect(readdirSync(join(state, 'births'))).toEqual([`${SID}.json`])
  })

  it('a hostile session id never escapes the births dir', async () => {
    const state = join(home, 'agent-state', 'builder')
    const { code } = await runWith({ SILOS_AGENT_STATE: state, SILOS_AGENT_ID: 'builder' }, input({ session_id: '../../evil' }))
    expect(code).toBe(0)
    expect(existsSync(join(home, 'evil.json'))).toBe(false)
    expect(existsSync(join(state, 'births')) ? readdirSync(join(state, 'births')) : []).toEqual([])
  })

  it('an unwritable state dir or garbage stdin still prints the briefing and exits 0', async () => {
    const blocker = join(home, 'not-a-dir')
    writeFileSync(blocker, 'x')
    const a = await runWith({ SILOS_AGENT_STATE: blocker, SILOS_AGENT_ID: 'builder' }, input())
    expect(a.code).toBe(0)
    expect(a.ctx).toMatch(SOME_BRIEFING)
    const b = await runWith({ SILOS_AGENT_STATE: join(home, 's'), SILOS_AGENT_ID: 'builder' }, 'not json {')
    expect(b.code).toBe(0)
    expect(b.ctx).toMatch(SOME_BRIEFING)
  })

  it('keeps the roster', async () => {
    writeFile()
    const { ctx } = await runWith({ SILOS_AGENT_STATE: join(home, 's'), SILOS_AGENT_ID: 'builder' }, input())
    expectRoster(ctx)
  })
})

describe("session-start hook: the agent's unread messages (inbox.py, the server's store)", () => {
  // the fake Silos: the roster on /api/agents, the inbox on …/messages
  let inboxAsks: Array<{ url: string; auth?: string; turn?: string }>
  async function startSilos(messages: unknown[]): Promise<string> {
    inboxAsks = []
    server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url?.startsWith('/api/agents/')) {
        inboxAsks.push({
          url: req.url,
          ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
          ...(typeof req.headers['x-silos-turn'] === 'string' ? { turn: req.headers['x-silos-turn'] } : {}),
        })
        res.end(JSON.stringify({ messages }))
        return
      }
      res.end(JSON.stringify(AGENTS))
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  }
  const m = (o: Record<string, unknown>) => ({ from: 'finance', to: 'builder', text: 't', state: 'new', ...o })

  it('lists the unread ones, oldest first, fetched with the bearer and the turn token', async () => {
    const api = await startSilos([
      m({ id: 'a1', at: '2026-10-27T09:00:00.000Z', text: 'old one' }),
      m({ id: 'a2', at: '2026-10-28T09:00:00.000Z', text: 'the fire', readOutside: ['WebFetch'] }),
      m({ id: 'a3', at: '2026-10-26T09:00:00.000Z', text: 'done already', state: 'answered' }),
    ])
    const ctx = await run({ SILOS_AGENT_ID: 'builder', SILOS_AGENT_TOKEN: 'tok', SILOS_TURN: 'f'.repeat(32), SILOS_API: api })
    expect(ctx).toContain('Your Silos inbox: 2 unread messages.')
    expect(ctx.indexOf('(a2)')).toBeGreaterThan(ctx.indexOf('(a1)'))
    expect(ctx).toContain('- 2026-10-28T09:00 from finance (a2): the fire — sent after reading the web (WebFetch)')
    expect(ctx).not.toContain('a3')
    expect(ctx).not.toMatch(/URGENT|urgent\)/)
    // changed on purpose: the asks other agents left it are a second GET, same credentials
    expect(inboxAsks).toEqual([
      { url: '/api/agents/builder/messages?state=new', auth: 'Bearer tok', turn: 'f'.repeat(32) },
      { url: '/api/agents/builder/asks', auth: 'Bearer tok', turn: 'f'.repeat(32) },
    ])
  })

  it('caps the list at 5 and trims long texts', async () => {
    const api = await startSilos(Array.from({ length: 7 }, (_, i) => m({ id: `m${i}`, at: `2026-10-2${i}T09:00:00.000Z`, text: 'x'.repeat(300) })))
    const ctx = await run({ SILOS_AGENT_ID: 'builder', SILOS_API: api })
    expect(ctx).toContain('Your Silos inbox: 7 unread messages.')
    expect(ctx).toContain('- … and 2 more')
    expect(ctx).toContain('x'.repeat(139) + '…')
    expect(ctx).not.toContain('x'.repeat(141))
  })

  it('a readOutside that is not a short list of strings never drops the inbox: strings only, three at most', async () => {
    const api = await startSilos([
      m({ id: 'b1', at: '2026-10-27T09:00:00.000Z', text: 'first', readOutside: [1, null, { a: 1 }, 'WebFetch'] }),
      m({ id: 'b2', at: '2026-10-28T09:00:00.000Z', text: 'second', readOutside: ['A', 'B\nC', 'D', 'E', 'F'] }),
      m({ id: 'b3', at: '2026-10-29T09:00:00.000Z', text: 'third', readOutside: [7] }),
    ])
    const ctx = await run({ SILOS_AGENT_ID: 'builder', SILOS_API: api })
    expect(ctx).toContain('(b1): first — sent after reading the web (WebFetch)')
    expect(ctx).toContain('(b2): second — sent after reading the web (A, B C, D, …)')
    expect(ctx.split('\n').find((l) => l.includes('(b3)'))).toBe('- 2026-10-29T09:00 from finance (b3): third')
  })

  // a proxy in the environment must never sit between the hook and a
  // loopback Silos: the roster would be lost and the bearer handed to it
  it('a loopback Silos is asked directly, whatever proxy the environment names', async () => {
    const api = await startSilos([m({ id: 'p1', at: '2026-10-27T09:00:00.000Z', text: 'through' })])
    const proxy = 'http://127.0.0.1:9' // nothing listens: a request sent there fails
    const ctx = await run({
      SILOS_AGENT_ID: 'builder',
      SILOS_AGENT_TOKEN: 'tok',
      SILOS_API: api,
      http_proxy: proxy,
      HTTP_PROXY: proxy,
      https_proxy: proxy,
      ALL_PROXY: proxy,
    })
    expect(ctx).toContain(HEAD)
    expect(ctx).toContain('(p1): through')
  })

  it('says nothing with nothing unread, without an agent, for master, or with a hostile id', async () => {
    const api = await startSilos([m({ id: 'r1', at: '2026-10-27T09:00:00.000Z', state: 'read' })])
    // independent runs against one read-only fake: side by side, not in turn
    const envs = [{ SILOS_AGENT_ID: 'builder' }, {}, { SILOS_AGENT_ID: 'master' }, { SILOS_AGENT_ID: '../builder' }, { SILOS_AGENT_ID: '..' }]
    for (const ctx of await Promise.all(envs.map((env) => run({ ...env, SILOS_API: api })))) {
      expect(ctx).not.toContain('Your Silos inbox')
    }
  })

  it('Silos down: one line says the inbox could not be fetched — the briefing survives', async () => {
    writeFile()
    const ctx = await run({ SILOS_AGENT_ID: 'builder', SILOS_API: 'http://127.0.0.1:9' })
    expect(ctx).toContain('Your Silos inbox could not be fetched this start')
    expect(ctx).toMatch(SOME_BRIEFING)
  })
})

// the hook composes the briefing for the skills THIS session surely has —
// the plugin root's when it is loaded as one (no setting turns a plugin's
// skill off) — never an order to use a skill it may lack: a folder copy or a
// personal skill loads or not by settings tiers the hook cannot see (the
// launch's own --settings among them), so it is not counted.
describe("session-start hook: the briefing follows the session's skills", () => {
  const skill = (root: string, name: string) => {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\n---\n`)
  }
  // a session with its bearer (the slim briefing of one without is below).
  // Whatever the composition, it is the server's text within the hook's
  // budget (compose.py --budget — session-start-cap.test.ts holds the cap
  // for every case)
  const TOKEN = { SILOS_AGENT_TOKEN: 'tok' }
  it("no skills anywhere → every .without, composed within the hook's budget", async () => {
    const project = join(home, 'proj')
    mkdirSync(project, { recursive: true })
    const ctx = await run({ ...TOKEN, SILOS_API: 'http://127.0.0.1:9', CLAUDE_PROJECT_DIR: project })
    expect(ctx).toBe(within([], 9500))
    expect(ctx).toBe(briefingText([])) // since the trim it fits whole
  })
  it('only the plugin root counts: a project copy or a personal skill — even one its settings turn off — is never named', async () => {
    const project = join(home, 'proj')
    skill(join(project, '.claude', 'skills'), 'team-plan')
    // turned off for this folder: the engine refuses it, the file is still there
    mkdirSync(join(project, '.claude'), { recursive: true })
    writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify({ skillOverrides: { 'team-plan': 'off' } }))
    const account = join(home, 'account')
    skill(join(account, 'skills'), 'heartbeat')
    skill(join(home, '.claude', 'skills'), 'vault-secrets')
    const plugin = join(home, 'plugin')
    skill(join(plugin, 'skills'), 'vault-secrets')
    const ctx = await run({ ...TOKEN, SILOS_API: 'http://127.0.0.1:9', CLAUDE_PROJECT_DIR: project, CLAUDE_CONFIG_DIR: account })
    expect(ctx).toBe(briefingText([]))
    const withPlugin = await run({
      ...TOKEN,
      SILOS_API: 'http://127.0.0.1:9',
      CLAUDE_PROJECT_DIR: project,
      CLAUDE_CONFIG_DIR: account,
      CLAUDE_PLUGIN_ROOT: plugin,
    })
    expect(withPlugin).toBe(briefingText(['vault-secrets']))
  })
  it('a skill dir without SKILL.md does not count', async () => {
    const project = join(home, 'proj')
    mkdirSync(join(project, '.claude', 'skills', 'team-plan'), { recursive: true })
    expect(await run({ ...TOKEN, SILOS_API: 'http://127.0.0.1:9', CLAUDE_PROJECT_DIR: project })).toBe(within([], 9500))
  })
})

// A session with no Silos identity (no bearer: a claude a person started by
// hand) cannot act on the API recipes — a write without identity is a 401 —
// so it is never handed them: it gets the slim briefing, whatever skills
// its folder has.
describe('session-start hook: a session without a bearer gets the slim briefing', () => {
  it('no write recipe, no bearer, no turn — and the file it points at exists and holds the format', async () => {
    const project = join(home, 'proj')
    mkdirSync(join(project, '.claude', 'skills', 'team-plan'), { recursive: true })
    writeFileSync(join(project, '.claude', 'skills', 'team-plan', 'SKILL.md'), '---\nname: team-plan\n---\n')
    for (const env of [{}, { SILOS_AGENT_ID: 'builder' }] as Array<Record<string, string>>) {
      const ctx = await run({ ...env, SILOS_API: 'http://127.0.0.1:9', CLAUDE_PROJECT_DIR: project })
      const slim = ctx.split('\n\nYour Silos inbox')[0]!
      expect(slim.startsWith(SLIM_HEAD)).toBe(true)
      expect(slim).not.toContain('# You are running inside Silos')
      expect(slim).not.toMatch(/curl|Authorization: Bearer|SILOS_TURN/)
      expect(slim.length).toBeLessThan(2000)
      const ref = /`([^`]+\/reference\/tasks\.md)`/.exec(slim)?.[1]
      expect(ref && existsSync(ref)).toBe(true)
      expect(readFileSync(ref!, 'utf8')).toContain('"tasks": [')
    }
  })
  it('the same session with its bearer gets the briefing, recipes and all', async () => {
    const ctx = await run({ SILOS_AGENT_TOKEN: 'tok', SILOS_API: 'http://127.0.0.1:9' })
    expect(ctx.startsWith('# You are running inside Silos')).toBe(true)
    expect(ctx).not.toContain(SLIM_HEAD)
  })
  it('compose.py --slim is that text, and --budget cuts it at a line', () => {
    const slim = execFileSync('python3', ['-B', COMPOSE, '--slim'], { encoding: 'utf8' })
    expect(slim.startsWith(SLIM_HEAD)).toBe(true)
    expect(slim).not.toContain('{{context}}')
    const cut = execFileSync('python3', ['-B', COMPOSE, '--slim', '--budget', '600'], { encoding: 'utf8' })
    expect(cut.length).toBeLessThanOrEqual(600)
    expect(cut.startsWith(SLIM_HEAD)).toBe(true)
  })
})

// after /clear the console is still ONE conversation
// for its tasks — the hook says which (GET /api/tasks/by-session) and how to
// release them. Fails silent.
describe('session-start hook: /clear proof of life', () => {
  const SID = 'console-key-1'
  let seen: { url?: string; auth?: string }[] = []
  async function byApi(body: unknown, status = 200): Promise<string> {
    seen = []
    server = createServer((req, res) => {
      const bySession = (req.url ?? '').startsWith('/api/tasks/by-session')
      seen.push({ url: req.url, auth: req.headers.authorization })
      res.statusCode = bySession ? status : 200
      res.setHeader('content-type', 'application/json')
      res.end(typeof body === 'string' && bySession ? body : JSON.stringify(bySession ? body : AGENTS))
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  }
  function runClear(env: Record<string, string>, source = 'clear'): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile('sh', [HOOK], { env: { PATH: process.env.PATH ?? '', HOME: home, ...env }, encoding: 'utf8' }, (err, out) => {
        if (err) return reject(err)
        resolve(JSON.parse(out).hookSpecificOutput.additionalContext)
      })
      child.stdin!.end(JSON.stringify({ session_id: 'rotated-native-id', cwd: '/p/builder', source, hook_event_name: 'SessionStart' }))
    })
  }
  const rows = {
    [SID]: [
      { key: 'folder:/p/builder/ship/t3', ref: 'ship#t3', title: 'Ship the thing', state: 'in_progress', current: true },
      { key: 'folder:/p/builder/phase/t1', ref: 'phase#t1', title: 'Old work', state: 'in_progress', current: false },
      { key: 'folder:/p/builder/phase/t2', ref: 'phase#t2', title: 'Finished', state: 'done', current: true },
    ],
    'another-session': [{ key: 'k', ref: 'other#t9', title: 'Not this console', state: 'pending', current: true }],
  }
  it('names each current open task and the release recipe, asking with the bearer', async () => {
    const api = await byApi(rows)
    const ctx = await runClear({ SILOS_API: api, SILOS_SESSION_ID: SID, SILOS_AGENT_ID: 'builder', SILOS_AGENT_TOKEN: 'tk' })
    const ask = seen.find((s) => s.url?.startsWith('/api/tasks/by-session'))
    expect(ask?.url).toBe(`/api/tasks/by-session?session=${SID}`)
    expect(ask?.auth).toBe('Bearer tk')
    // release without a state = back to pending; the
    // recipe is plugin/context/recipes/release.sh, filled, as a fenced block
    expect(ctx).toContain(
      'This console was working on «Ship the thing» (ship#t3). Continue it — or, if you are switching to something else, release it (it goes back to pending; add "state" to say done/blocked/in_review — in_review only with waitingOn naming who reviews it):\n```\n' +
        recipeText('release', { slug: 'ship', id: 't3' }) +
        '\n```',
    )
    expect(ctx).not.toContain('Old work')
    expect(ctx).not.toContain('Finished')
    expect(ctx).not.toContain('Not this console')
    expect(ctx).toContain('# You are running inside Silos')
    expect(ctx).toContain(HEAD)
  })
  // plan and task ids are filled into a command the model is told to run
  it('an id from the API that is not a plain id never reaches the recipe', async () => {
    const hostile = {
      [SID]: [
        { key: 'folder:/p/builder/a$(touch pwned)/tasks/t1', ref: 'builder#t1', title: 'Shell in the plan', state: 'in_progress', current: true },
        { key: 'k', ref: "ship#t1'; rm -rf x; '", title: 'Quote in the task', state: 'in_progress', current: true },
        { key: 'k', ref: 'ship#`id`', title: 'Backticks', state: 'in_progress', current: true },
        { key: 'folder:/p/builder/ship/t4', ref: 'ship#t4', title: 'A plain one', state: 'in_progress', current: true },
      ],
    }
    const api = await byApi(hostile)
    const ctx = await runClear({ SILOS_API: api, SILOS_SESSION_ID: SID })
    expect(ctx).toContain('This console was working on «A plain one» (ship#t4)')
    expect(ctx.split('This console was working on').length - 1).toBe(1)
    for (const bad of ['touch pwned', 'rm -rf', '`id`']) expect(ctx).not.toContain(bad)
  })
  it('without a token: no Authorization header', async () => {
    const api = await byApi(rows)
    const ctx = await runClear({ SILOS_API: api, SILOS_SESSION_ID: SID })
    expect(ctx).toContain('This console was working on «Ship the thing»')
    expect(seen.find((s) => s.url?.startsWith('/api/tasks/by-session'))?.auth).toBeUndefined()
  })
  it('only on clear, only with SILOS_SESSION_ID', async () => {
    const api = await byApi(rows)
    const startup = await runClear({ SILOS_API: api, SILOS_SESSION_ID: SID }, 'startup')
    expect(startup).not.toContain('This console was working on')
    const noSid = await runClear({ SILOS_API: api })
    expect(noSid).not.toContain('This console was working on')
    expect(seen.some((s) => s.url?.startsWith('/api/tasks/by-session'))).toBe(false)
  })
  it('fails silent: an error status, garbage, {} or no server say nothing', async () => {
    // one fake per answer, all four runs side by side
    const fakes: Server[] = []
    try {
      const apis: string[] = []
      for (const [body, status] of [
        [rows, 500],
        ['garbage', 200],
        [{}, 200],
      ] as const) {
        apis.push(await byApi(body, status))
        fakes.push(server!)
        server = null
      }
      const ctxs = await Promise.all([...apis, 'http://127.0.0.1:9'].map((api) => runClear({ SILOS_API: api, SILOS_SESSION_ID: SID })))
      for (const ctx of ctxs) expect(ctx).not.toContain('This console was working on')
      for (const ctx of ctxs.slice(0, 3)) expect(ctx).toMatch(SOME_BRIEFING)
    } finally {
      await Promise.all(fakes.map((f) => new Promise((r) => f.close(r))))
    }
  })
})
