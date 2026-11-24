import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
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
import { buildServer } from '../src/server.js'
import { LineageStore } from '../src/lineage.js'
import { TerminalService } from '../src/terminal-service.js'

// Deleting a conversation from the sidebar buries its WHOLE thread (else
// deleted conversations seem to come back as new ones). A sidebar
// row is a chain — the tip plus the rotations folded under it as "earlier",
// plus the chain a `/clear` left archived — but the trash route moved ONE
// JSONL, the tip's. The ancestors stayed in ~/.claude/projects, and with
// the tip gone each one surfaced as a row of its own: the pre-rotation
// transcript as a "new" conversation, the archived pre-/clear chain back in
// the list (its archived mark is derived from the cleared child, now gone).
// `{ thread: true }` buries the tip AND its indexed continuation ancestors,
// nearest first — except an ancestor another surviving session still
// descends from (its history too) and one the owner detached by drag into a
// row of its own (prefs.detachedChains), which keeps everything above it.
// Without the flag, nothing changes: Settings › Maintenance buries history
// one session at a time, on purpose.
describe('trash with { thread: true } buries the whole thread', () => {
  let app: FastifyInstance
  afterEach(async () => {
    await app?.close()
  })

  interface Boot {
    base: string
    index: SessionIndex
    holders: Set<string>
  }

  async function boot(
    ids: string[],
    links: Array<[child: string, parent: string]>,
    opts: { cleared?: string[]; detached?: string[]; holders?: string[] } = {},
  ): Promise<Boot> {
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    const root = join(base, 'projects')
    mkdirSync(join(root, '-tmp-p'), { recursive: true })
    mkdirSync(join(base, 'data', 'trash'), { recursive: true })
    for (const id of ids) writeFileSync(join(root, '-tmp-p', `${id}.jsonl`), `{"type":"user","cwd":"/tmp/p","message":{"role":"user","content":"${id}"}}\n`)
    const index = claudeSessionIndex(root, join(base, 'data', 'cache.json'))
    await index.init()
    const registry = new AgentRegistry(join(base, 'data', 'agents.json'))
    registry.load()
    const lineage = new LineageStore(join(base, 'data', 'lineage.json'))
    for (const [child, parent] of links) lineage.record(`-tmp-p/${child}`, `-tmp-p/${parent}`)
    if (opts.cleared) {
      // the same shape absorbRotations writes: `cleared` lists the ids born from a /clear
      writeFileSync(
        join(base, 'data', 'lineage.json'),
        JSON.stringify({ parents: Object.fromEntries(links.map(([c, p]) => [`-tmp-p/${c}`, `-tmp-p/${p}`])), cleared: opts.cleared }),
      )
    }
    const lineageFresh = new LineageStore(join(base, 'data', 'lineage.json'))
    const prefs = new PrefsStore(join(base, 'data'))
    if (opts.detached) prefs.patchDetachedChains(opts.detached.map((id) => `-tmp-p/${id}`))
    const terminals = new TerminalService(registry, index, undefined, undefined, { tmuxSocket: join(base, 'tmux.sock') })
    terminals.hasConsole = () => false
    terminals.killConsoleAndWait = async () => {}
    const holders = new Set(opts.holders ?? [])
    terminals.holdersOf = (id: string) => (holders.has(id) ? [4242] : [])
    const chat = new ChatService({
      registry,
      native: new NativeStore(join(base, 'data', 'native.json')),
      queryFn: () => ({
        async *[Symbol.asyncIterator]() {},
        async interrupt() {
          return undefined
        },
      }),
    })
    app = buildServer({
      index,
      registry,
      store: new SessionStore(root, join(base, 'data')),
      native: new NativeStore(join(base, 'data', 'native.json')),
      chat,
      exec: new ExecService(registry),
      complete: new CompleteService(registry, index),
      prefs,
      memory: new MemoryService(root, join(base, 'data'), registry),
      lineage: lineageFresh,
      terminals,
      token: 't0k',
      liveMs: 120_000,
    })
    return { base, index, holders }
  }

  const trash = (id: string, body?: object) =>
    app.inject({
      method: 'POST',
      url: `/api/sessions/-tmp-p/${id}/trash`,
      headers: { 'x-token': 't0k', ...(body ? { 'content-type': 'application/json' } : {}) },
      payload: body ? JSON.stringify(body) : undefined,
    })
  const inProjects = (b: Boot, id: string) => existsSync(join(b.base, 'projects', '-tmp-p', `${id}.jsonl`))
  const inTrash = (b: Boot, id: string) => existsSync(join(b.base, 'data', 'trash', '-tmp-p', `${id}.jsonl`))
  const indexed = (b: Boot, id: string) => b.index.allSessions().some((m) => m.id === id)

  it('a rotation chain: trashing the tip buries the rotation it was folded over', async () => {
    const b = await boot(['root', 'tip'], [['tip', 'root']])
    const res = await trash('tip', { thread: true })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, buried: ['-tmp-p/root'] })
    for (const id of ['tip', 'root']) {
      expect(inProjects(b, id)).toBe(false)
      expect(inTrash(b, id)).toBe(true)
      expect(indexed(b, id)).toBe(false)
    }
  })

  it('a /clear child: trashing it buries the chain the /clear left archived, so it never resurfaces', async () => {
    const b = await boot(['old', 'cleared'], [['cleared', 'old']], { cleared: ['cleared'] })
    const res = await trash('cleared', { thread: true })
    expect(res.statusCode).toBe(200)
    expect(inTrash(b, 'old')).toBe(true)
    expect(indexed(b, 'old')).toBe(false)
  })

  it('nested: /clear child of a rotation chain buries every ancestor, nearest first', async () => {
    const b = await boot(
      ['a', 'b', 'c', 'd'],
      [
        ['d', 'c'],
        ['c', 'b'],
        ['b', 'a'],
      ],
      { cleared: ['d'] },
    )
    const res = await trash('d', { thread: true })
    expect(res.statusCode).toBe(200)
    expect(res.json().buried).toEqual(['-tmp-p/c', '-tmp-p/b', '-tmp-p/a'])
    for (const id of ['a', 'b', 'c', 'd']) expect(inTrash(b, id)).toBe(true)
  })

  it('a shared ancestor stays: another surviving conversation still descends from it', async () => {
    // tip and other both continue root (a fork): burying tip must not cut other's history
    const b = await boot(
      ['root', 'tip', 'other'],
      [
        ['tip', 'root'],
        ['other', 'root'],
      ],
    )
    const res = await trash('tip', { thread: true })
    expect(res.statusCode).toBe(200)
    expect(res.json().buried).toEqual([])
    expect(inTrash(b, 'tip')).toBe(true)
    expect(inProjects(b, 'root')).toBe(true)
    expect(inProjects(b, 'other')).toBe(true)
  })

  it('a detached ancestor is its own row: it and everything above it stay', async () => {
    const b = await boot(
      ['a', 'b', 'c'],
      [
        ['c', 'b'],
        ['b', 'a'],
      ],
      { detached: ['b'] },
    )
    const res = await trash('c', { thread: true })
    expect(res.statusCode).toBe(200)
    expect(res.json().buried).toEqual([])
    expect(inTrash(b, 'c')).toBe(true)
    expect(inProjects(b, 'b')).toBe(true)
    expect(inProjects(b, 'a')).toBe(true)
  })

  it('an ancestor a live claude still holds is skipped (never trash a file that comes right back), the rest is buried', async () => {
    const b = await boot(
      ['a', 'b', 'c'],
      [
        ['c', 'b'],
        ['b', 'a'],
      ],
      { holders: ['b'] },
    )
    const res = await trash('c', { thread: true })
    expect(res.statusCode).toBe(200)
    expect(res.json().buried).toEqual(['-tmp-p/a'])
    expect(inProjects(b, 'b')).toBe(true)
    expect(inTrash(b, 'a')).toBe(true)
  })

  it('without the flag only the one session moves — Maintenance buries history one row at a time', async () => {
    const b = await boot(['root', 'tip'], [['tip', 'root']])
    const res = await trash('tip')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true })
    expect(inTrash(b, 'tip')).toBe(true)
    expect(inProjects(b, 'root')).toBe(true)
    expect(indexed(b, 'root')).toBe(true)
  })
})
