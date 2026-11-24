// board-tools-api.test.ts — integration coverage for the Board/Tools/Skills
// dimension's 3 routes — GET /api/board, GET /api/tools, GET /api/skills/:name
// — against real sessions (same fixture as context-api).
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { AgentStateStore } from '../src/agent-state.js'
import { MessageStore } from '../src/messages.js'
import { buildServer } from '../src/server.js'
import { installSilosHooks } from '../src/harnesses/claude-code/settings.js'
import { PLUGIN_HOOKS_DIR } from '../src/repo-paths.js'

// a genuinely LOCAL request (loopback Host, no forwarding/tunnel headers)
// no longer requires a token — see isLocalRequest in server.ts. These 401
// assertions must look REMOTE (public host) so they keep exercising the
// guard without weakening it.
const REMOTE = { host: 'silos.example.com' }

const FIX = new URL('./fixtures/basic.jsonl', import.meta.url).pathname
let app: FastifyInstance
let base: string, root: string, dataDir: string, skillsDir: string
let registry: AgentRegistry, messages: MessageStore
const TOKEN = 'testtoken'
const LIVE_MS = 120_000

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'deck-board-'))
  root = join(base, 'projects')
  dataDir = join(base, 'data')
  skillsDir = join(base, 'skills')
  mkdirSync(join(root, '-tmp-project-x'), { recursive: true })
  mkdirSync(join(dataDir, 'trash'), { recursive: true })
  mkdirSync(join(skillsDir, 'finance-acme'), { recursive: true })
  writeFileSync(join(skillsDir, 'finance-acme', 'SKILL.md'), '---\ndescription: Acts as acme’s FINANCE\n---\n\n# FINANCE\n\nReadme body.\n')
  // a "live" session — recent CONTENT activity (mtime is derived from the
  // transcript's last timestamp, not the file's mtime). A tool_result entry
  // with the current timestamp is appended: it creates no turn or tool
  // call, it just marks the session as freshly active (Working on the Board).
  cpSync(FIX, join(root, '-tmp-project-x', 'aaa.jsonl'))
  appendFileSync(
    join(root, '-tmp-project-x', 'aaa.jsonl'),
    JSON.stringify({
      type: 'user',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tick', content: 'ok' }] },
    }) + '\n',
  )

  const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  await index.init()
  registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  registry.create({ id: 'finance', name: 'FINANCE', folder: '/tmp/project-x', skills: ['finance-acme'] })
  const store = new SessionStore(root, dataDir)
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
  const exec = new ExecService(registry)
  const complete = new CompleteService(registry, index, skillsDir)
  const prefs = new PrefsStore(dataDir)
  const memory = new MemoryService(root, dataDir, registry)
  const agentState = new AgentStateStore(join(dataDir, 'agent-state'))
  messages = new MessageStore(dataDir)
  // the fixture's engine is WIRED (the real installer), or every claude
  // agent here would earn the engineUnwired row (inbox.ts)
  const settingsPath = join(dataDir, 'claude-settings.json')
  installSilosHooks(settingsPath, join(dataDir, 'backups'), PLUGIN_HOOKS_DIR)
  app = buildServer({
    claudeSettingsPath: settingsPath,
    index,
    registry,
    store,
    native,
    chat,
    exec,
    complete,
    prefs,
    memory,
    token: TOKEN,
    liveMs: LIVE_MS,
    agentState,
    messages,
  })
})

const get = (url: string) => app.inject({ url, headers: { 'x-token': TOKEN } })

describe('GET /api/board', () => {
  it('a session just touched (fixture, no utimes) shows up as Working, with the agent classified', async () => {
    const body = (await get('/api/board')).json()
    expect(body.cards).toHaveLength(1)
    expect(body.cards[0]).toMatchObject({ folder: '-tmp-project-x', id: 'aaa', agentId: 'finance', cwd: '/tmp/project-x', state: 'working' })
  })

  it('carries the plan (done/total) when the session has TaskCreate/TaskUpdate — see board.test.ts for state transitions (unit, boardStateOf)', async () => {
    const body = (await get('/api/board')).json()
    // basic.jsonl creates no tasks — the field simply doesn't travel (undefined, not 0/0).
    expect(body.cards[0].planDone).toBeUndefined()
    expect(body.cards[0].planTotal).toBeUndefined()
  })

  it('401 with no token', async () => {
    expect((await app.inject({ url: '/api/board', headers: REMOTE })).statusCode).toBe(401)
  })

  // needsYou: the SECOND, file-borne source (see server/src/needs-you.ts)
  // alongside each card's own context.pending — a plan task ready on a
  // human, and an agent whose latest status.json escalated.
  it('with no plan files and no escalation, needsYou is empty', async () => {
    const body = (await get('/api/board')).json()
    expect(body.needsYou).toEqual([])
  })

  // the plans kernelectomy (03-11): a plan task of the owner's reaches
  // Needs you only through the built-in Plans silo (silos/surfaces.ts — a
  // silo row with its parent plan); with no silo kernel there is no reader
  // of plan files left to make a row (silo-surfaces / silo-route cover it)
  it('a plan file on disk makes no native needsYou item — the Plans silo is its only reader', async () => {
    const planFolder = mkdtempSync(join(tmpdir(), 'deck-board-plans-'))
    mkdirSync(join(planFolder, 'plans'), { recursive: true })
    writeFileSync(
      join(planFolder, 'plans', 'sprint.plan.json'),
      JSON.stringify({ title: 'Sprint', tasks: [{ id: 't1', title: 'approve the budget', owner: 'sam', status: 'pending', dependsOn: [] }] }),
    )
    registry.create({ id: 'planner', name: 'Planner', folder: planFolder, skills: [] })
    const body = (await get('/api/board')).json()
    expect(body.needsYou).toEqual([])
    expect(body.inbox).toEqual([])
  })

  // third review round, defect 3: an archived agent is out of play — its
  // escalated status.json and the messages it handed to the owner once
  // became Needs you rows whose door opened an agent the web doesn't list
  // (and, from there, a real console for it)
  it('an archived agent raises no Needs you row: not its needs_owner messages', async () => {
    registry.create({ id: 'retired', name: 'Retired', folder: '/tmp/retired', skills: [] })
    const m = messages.send({ from: 'finance', to: 'retired', urgent: false, text: 'over to the owner' })
    messages.setState('retired', m.id, 'needs_owner')
    // while it is in play, both are rows
    const before = (await get('/api/board')).json() as { needsYou: { kind: string; agentId?: string }[]; inbox: { kind: string; agentId?: string | null }[] }
    expect(
      before.needsYou
        .filter((n) => n.agentId === 'retired')
        .map((n) => n.kind)
        .sort(),
    ).toEqual(['message'])
    registry.archive('retired')
    const after = (await get('/api/board')).json() as typeof before
    expect(after.needsYou.some((n) => n.agentId === 'retired')).toBe(false)
    expect(after.inbox.some((r) => r.agentId === 'retired')).toBe(false)
  })
})

describe('GET /api/tools', () => {
  it('aggregates the tools seen (basic.jsonl carries Skill and Bash) with the agent that used them', async () => {
    const body = (await get('/api/tools')).json()
    const byName = new Map(body.tools.map((t: { name: string }) => [t.name, t]))
    expect(byName.get('Skill')).toMatchObject({ server: null, count: 1, agentIds: ['finance'] })
    expect(byName.get('Bash')).toMatchObject({ server: null, count: 1, agentIds: ['finance'] })
  })

  it('401 with no token', async () => {
    expect((await app.inject({ url: '/api/tools', headers: REMOTE })).statusCode).toBe(401)
  })
})

describe('GET /api/skills/:name', () => {
  it('200 with description + body, frontmatter stripped', async () => {
    const res = await get('/api/skills/finance-acme')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      name: 'finance-acme',
      description: 'Acts as acme’s FINANCE',
      body: '# FINANCE\n\nReadme body.',
    })
  })

  it('404 when the skill is not in the catalog', async () => {
    expect((await get('/api/skills/missing')).statusCode).toBe(404)
  })

  it('400 for an invalid name (traversal)', async () => {
    expect((await get('/api/skills/..%2F..%2Fetc')).statusCode).toBe(400)
  })

  // the base regex (\w.:-) already let through a slash-less segment made
  // ONLY of dots (every character of '..' is valid under \w.:-) — it's
  // PURE_DOTS that closes that gap (server.ts). The case above (with '/')
  // already failed on the base regex before that fix and doesn't exercise it.
  it('400 for a dots-only name with no slash ("...")', async () => {
    // a segment of EXACTLY '..' (encoded or not) gets normalized by
    // Fastify's router BEFORE reaching the route (it resolves
    // /api/skills/.. to /api/, never invoking the handler with
    // name==='..') — verified with a direct app.inject. '...' (3+ dots) is
    // NOT a standard dot-segment, so it DOES reach the handler intact —
    // still the case that motivated the fix (PURE_DOTS, server.ts): a
    // dots-only name that the base regex (\w.:-) alone would let through.
    expect((await get('/api/skills/...')).statusCode).toBe(400)
  })

  it('401 with no token', async () => {
    expect((await app.inject({ url: '/api/skills/finance-acme', headers: REMOTE })).statusCode).toBe(401)
  })
})
