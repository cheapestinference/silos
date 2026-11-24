import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionIndex } from '../src/session-index.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import type { HarnessReader, SessionRef } from '../src/harnesses/contract.js'
import type { SessionMeta, SessionContext, TranscriptTurn } from '../src/types.js'

const FIX = new URL('./fixtures/basic.jsonl', import.meta.url).pathname

const fakeMeta = (id: string, title: string): SessionMeta => ({
  id,
  folder: '-tmp-x',
  title,
  skills: [],
  cwd: '/tmp/x',
  mtime: 1000,
  size: 0,
  turnCount: 1,
  harness: 'opencode',
})

class FakeReader implements HarnessReader {
  readonly harness = 'opencode' as const
  metas = new Map<string, SessionMeta>([
    ['ses_a', fakeMeta('ses_a', 'A')],
    ['ses_b', fakeMeta('ses_b', 'B')],
  ])
  inited = false
  removed: string[] = []
  refreshed: string[] = []
  listener: ((ref: SessionRef, kind: 'created' | 'updated' | 'removed') => void) | null = null
  ownsId(id: string): boolean {
    return id.startsWith('ses_')
  }
  list(): SessionMeta[] {
    return [...this.metas.values()]
  }
  async init(): Promise<void> {
    this.inited = true
  }
  getMeta(_folder: string, id: string): SessionMeta | null {
    return this.metas.get(id) ?? null
  }
  getContext(_folder: string, id: string): SessionContext | null {
    return this.metas.has(id) ? ({ fake: id } as unknown as SessionContext) : null
  }
  async readTurns(_folder: string, id: string): Promise<TranscriptTurn[]> {
    return [{ role: 'user', text: `turn of ${id}` } as unknown as TranscriptTurn]
  }
  async refresh(_folder: string, id: string): Promise<SessionMeta | null> {
    this.refreshed.push(id)
    return this.metas.get(id) ?? null
  }
  remove(_folder: string, id: string): void {
    this.removed.push(id)
    this.metas.delete(id)
  }
  watch(onChange: (ref: SessionRef, kind: 'created' | 'updated' | 'removed') => void): () => void {
    this.listener = onChange
    return () => {
      this.listener = null
    }
  }
}

let root: string, cache: string, idx: SessionIndex, fake: FakeReader

beforeEach(async () => {
  const base = mkdtempSync(join(tmpdir(), 'deck-readers-'))
  root = join(base, 'projects')
  cache = join(base, 'sessions-cache.json')
  mkdirSync(join(root, '-tmp-project-x'), { recursive: true })
  cpSync(FIX, join(root, '-tmp-project-x', 'aaa.jsonl'))
  cpSync(FIX, join(root, '-tmp-project-x', 'bbb.jsonl'))
  idx = claudeSessionIndex(root, cache)
  fake = new FakeReader()
  idx.addReader(fake)
  await idx.init()
})
afterEach(() => idx.stopHeartbeat())

describe('SessionIndex with an extra reader', () => {
  it("init() initialises the reader; allSessions() = own + the reader's", () => {
    expect(fake.inited).toBe(true)
    const keys = idx
      .allSessions()
      .map((m) => `${m.folder}/${m.id}`)
      .sort()
    expect(keys).toEqual(['-tmp-project-x/aaa', '-tmp-project-x/bbb', '-tmp-x/ses_a', '-tmp-x/ses_b'])
  })

  it("own metas carry harness claude-code; the reader's keep theirs", () => {
    expect(idx.getMeta('-tmp-project-x', 'aaa')!.harness).toBe('claude-code')
    expect(idx.allSessions().find((m) => m.id === 'bbb')!.harness).toBe('claude-code')
    expect(idx.allSessions().find((m) => m.id === 'ses_b')!.harness).toBe('opencode')
  })

  it('getMeta / getContext dispatch to the owning reader', () => {
    expect(idx.getMeta('-tmp-x', 'ses_a')).toEqual(fakeMeta('ses_a', 'A'))
    expect(idx.getContext('-tmp-x', 'ses_a')).toEqual({ fake: 'ses_a' })
    expect(idx.getMeta('-tmp-x', 'ses_zzz')).toBeNull()
  })

  it('readTurns dispatches; own sessions still read their JSONL', async () => {
    expect(await idx.readTurns('-tmp-x', 'ses_a')).toEqual([{ role: 'user', text: 'turn of ses_a' }])
    expect((await idx.readTurns('-tmp-project-x', 'aaa')).length).toBeGreaterThan(0)
  })

  it('refresh dispatches to the reader and emits its meta', async () => {
    const seen: SessionMeta[] = []
    idx.on('session', (m: SessionMeta) => seen.push(m))
    const m = await idx.refresh('-tmp-x', 'ses_b')
    expect(fake.refreshed).toEqual(['ses_b'])
    expect(m).toEqual(fakeMeta('ses_b', 'B'))
    expect(seen).toEqual([fakeMeta('ses_b', 'B')])
  })

  it('remove calls the reader and emits removed', () => {
    const removed: string[] = []
    idx.on('removed', (folder: string, id: string) => removed.push(`${folder}/${id}`))
    idx.remove('-tmp-x', 'ses_a')
    expect(fake.removed).toEqual(['ses_a'])
    expect(removed).toEqual(['-tmp-x/ses_a'])
    expect(idx.allSessions().some((m) => m.id === 'ses_a')).toBe(false)
  })

  it("the reader's watch re-emits session (created/updated) and removed", () => {
    const sessions: SessionMeta[] = []
    const removed: string[] = []
    idx.on('session', (m: SessionMeta) => sessions.push(m))
    idx.on('removed', (folder: string, id: string) => removed.push(`${folder}/${id}`))
    fake.metas.set('ses_a', { ...fakeMeta('ses_a', 'A2') })
    fake.listener!({ harness: 'opencode', folder: '-tmp-x', id: 'ses_a' }, 'updated')
    fake.listener!({ harness: 'opencode', folder: '-tmp-x', id: 'ses_gone' }, 'created') // no meta → nothing
    fake.listener!({ harness: 'opencode', folder: '-tmp-x', id: 'ses_b' }, 'removed')
    expect(sessions.map((m) => m.title)).toEqual(['A2'])
    expect(removed).toEqual(['-tmp-x/ses_b'])
  })

  it('pathOf / sessionDir throw for a reader-owned id; listSubagents is empty', async () => {
    expect(() => idx.pathOf('-tmp-x', 'ses_a')).toThrow('no transcript file: opencode session')
    expect(() => idx.sessionDir('-tmp-x', 'ses_a')).toThrow('no transcript file: opencode session')
    expect(await idx.listSubagents('-tmp-x', 'ses_a')).toEqual([])
    expect(idx.pathOf('-tmp-project-x', 'aaa')).toBe(join(root, '-tmp-project-x', 'aaa.jsonl'))
  })
})

// Optional reader capabilities (contract.ts): a reader that says an id was
// unknown, hides ids that are not conversations, and owns a flush/stop.
class CapableReader extends FakeReader {
  hiddenIds = new Set<string>(['ses_b'])
  flushes = 0
  stops = 0
  override remove(_folder: string, id: string): boolean {
    this.removed.push(id)
    return this.metas.delete(id)
  }
  hidden(_folder: string, id: string): boolean {
    return this.hiddenIds.has(id)
  }
  async flush(): Promise<void> {
    this.flushes++
  }
  stop(): void {
    this.stops++
  }
}

describe('SessionIndex honours optional reader capabilities', () => {
  let capable: CapableReader
  beforeEach(async () => {
    idx.stopHeartbeat()
    idx = claudeSessionIndex(root, cache)
    capable = new CapableReader()
    idx.addReader(capable)
    await idx.init()
  })

  it('remove: false (unknown id) emits no removed; true emits it', () => {
    const removed: string[] = []
    idx.on('removed', (folder: string, id: string) => removed.push(`${folder}/${id}`))
    idx.remove('-tmp-x', 'ses_never')
    expect(capable.removed).toEqual(['ses_never'])
    expect(removed).toEqual([])
    idx.remove('-tmp-x', 'ses_a')
    expect(removed).toEqual(['-tmp-x/ses_a'])
  })

  it('a void remove (OpenCode) still always emits', () => {
    const plain = new FakeReader()
    const other = claudeSessionIndex(root, cache)
    other.addReader(plain)
    const removed: string[] = []
    other.on('removed', (folder: string, id: string) => removed.push(`${folder}/${id}`))
    other.remove('-tmp-x', 'ses_never')
    expect(removed).toEqual(['-tmp-x/ses_never'])
  })

  it('refresh of a hidden id returns its meta but emits nothing; getMeta still answers', async () => {
    const seen: SessionMeta[] = []
    idx.on('session', (m: SessionMeta) => seen.push(m))
    const m = await idx.refresh('-tmp-x', 'ses_b')
    expect(m).toEqual(fakeMeta('ses_b', 'B'))
    expect(seen).toEqual([])
    expect(idx.getMeta('-tmp-x', 'ses_b')).toEqual(fakeMeta('ses_b', 'B'))
    await idx.refresh('-tmp-x', 'ses_a')
    expect(seen.map((s) => s.id)).toEqual(['ses_a'])
  })

  it('flushCache flushes the readers; stopHeartbeat stops them', async () => {
    const before = capable.flushes // init() flushes once
    await idx.flushCache()
    expect(capable.flushes).toBe(before + 1)
    idx.stopHeartbeat()
    expect(capable.stops).toBe(1)
  })
})
