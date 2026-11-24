import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { SessionIndex } from '../src/session-index.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { SessionStore } from '../src/session-store.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { ExecService } from '../src/exec-service.js'
import { CompleteService } from '../src/complete-service.js'
import { PrefsStore } from '../src/prefs-store.js'
import { MemoryService } from '../src/memory-service.js'
import { SeenStore } from '../src/seen-store.js'
import { buildServer } from '../src/server.js'

const REMOTE = { host: 'silos.example.com' }
const TOKEN = 'testtoken'
const FOLDER = '-tmp-project-x'

// a session's activity = the last timestamp in its CONTENT, not the file's
// mtime. To keep unread deterministic, that timestamp is controlled inside
// the JSONL itself (no utimes, no real clock).
const MTIME_MS = 2_000_000 // the last timestamp in the default seeded transcript
const CLOCK = 3_000_000 // the SeenStore's injected clock: AFTER the activity

let app: FastifyInstance
let index: SessionIndex
let seen: SeenStore
let root: string

// a JSONL whose LAST conversational turn belongs to the given role, with a
// controlled timestamp on the last entry (-> a deterministic acc.lastTs).
function jsonlEndingWith(role: 'assistant' | 'user', tsMs: number): string {
  const iso = new Date(tsMs).toISOString()
  const user = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, timestamp: new Date(tsMs - 1000).toISOString() })
  const asst = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }, timestamp: iso })
  if (role === 'assistant') return user + '\n' + asst + '\n'
  return user + '\n' + asst + '\n' + JSON.stringify({ type: 'user', message: { role: 'user', content: 'another' }, timestamp: iso }) + '\n'
}

async function seedSession(id: string, content?: string): Promise<void> {
  writeFileSync(join(root, FOLDER, `${id}.jsonl`), content ?? jsonlEndingWith('assistant', MTIME_MS))
  await index.refresh(FOLDER, id, false)
}

beforeEach(async () => {
  const base = mkdtempSync(join(tmpdir(), 'deck-seen-api-'))
  root = join(base, 'projects')
  const dataDir = join(base, 'data')
  mkdirSync(join(root, FOLDER), { recursive: true })
  mkdirSync(join(dataDir, 'trash'), { recursive: true })
  index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  await index.init()
  const registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
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
  const complete = new CompleteService(registry, index)
  const prefs = new PrefsStore(dataDir)
  const memory = new MemoryService(root, dataDir, registry)
  seen = new SeenStore(dataDir, () => CLOCK)
  seen.load()
  app = buildServer({ index, registry, store, native, chat, exec, complete, prefs, memory, seen, token: TOKEN, liveMs: 120_000 })
})

const get = (url: string) => app.inject({ url, headers: { 'x-token': TOKEN } })
const patchSeen = (payload: unknown, headers: Record<string, string> = { 'x-token': TOKEN }) =>
  app.inject({ method: 'PATCH', url: '/api/seen', headers, payload })

// looks up a specific session in the overview (falls under the 'master'
// agent by default: with no agents seeded, everything is orphaned to master).
async function sessionView(id: string): Promise<{ unread: boolean; lastRole?: string } | undefined> {
  const body = (await get('/api/overview')).json()
  for (const a of body.agents) {
    const s = a.sessions.find((x: { id: string }) => x.id === id)
    if (s) return s
  }
  return undefined
}

describe('PATCH /api/seen — auth and validation', () => {
  it('no token (remote) -> 401', async () => {
    await seedSession('aaa')
    expect((await patchSeen({ folder: FOLDER, id: 'aaa' }, REMOTE)).statusCode).toBe(401)
  })

  it('with a token -> 200 and returns the marked instant', async () => {
    await seedSession('aaa')
    const res = await patchSeen({ folder: FOLDER, id: 'aaa' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, seen: CLOCK })
  })

  it('invalid folder/id (path traversal, pure dots, non-string) -> 400', async () => {
    expect((await patchSeen({ folder: '..', id: 'aaa' })).statusCode).toBe(400)
    expect((await patchSeen({ folder: FOLDER, id: '..' })).statusCode).toBe(400)
    expect((await patchSeen({ folder: 'a/b', id: 'aaa' })).statusCode).toBe(400)
    expect((await patchSeen({ id: 'aaa' })).statusCode).toBe(400)
  })
})

describe('overview.unread — derived from mtime + lastRole + seen', () => {
  it("a never-seen session whose last turn is the agent's = unread", async () => {
    await seedSession('aaa') // basic.jsonl ends on an assistant turn ("Done.")
    const s = await sessionView('aaa')
    expect(s?.lastRole).toBe('assistant')
    expect(s?.unread).toBe(true)
  })

  it('marking it seen (PATCH /api/seen) clears it in the next overview', async () => {
    await seedSession('aaa')
    expect((await sessionView('aaa'))?.unread).toBe(true)
    await patchSeen({ folder: FOLDER, id: 'aaa' }) // lastSeen = CLOCK > mtime
    expect((await sessionView('aaa'))?.unread).toBe(false)
  })

  it('new agent activity AFTER it was seen marks it unread again', async () => {
    await seedSession('aaa')
    await patchSeen({ folder: FOLDER, id: 'aaa' }) // seen at CLOCK (3_000_000)
    expect((await sessionView('aaa'))?.unread).toBe(false)
    // REAL new activity (content, not just touching the file): an agent
    // reply with a timestamp AFTER lastSeen -> unread without replying again.
    appendFileSync(
      join(root, FOLDER, 'aaa.jsonl'),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'And this.' }] },
        timestamp: new Date(4_000_000).toISOString(),
      }) + '\n',
    )
    await index.refresh(FOLDER, 'aaa', false)
    expect((await sessionView('aaa'))?.unread).toBe(true)
  })

  it('a conversation whose last turn belongs to the OWNER (user) is NOT unread even if never seen', async () => {
    // a minimal JSONL whose last conversational turn belongs to the owner.
    const jsonl =
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'fix this please' } }) +
      '\n' +
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] } }) +
      '\n' +
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'one more thing' } }) +
      '\n'
    await seedSession('bbb', jsonl)
    const s = await sessionView('bbb')
    expect(s?.lastRole).toBe('user')
    expect(s?.unread).toBe(false)
  })
})
