// A buried conversation's transcript is read from the trash at most ONCE per
// process (session-owner.ts readBuried): the owner rule is synchronous, so
// that read is a whole-file synchronous parse (trash.ts buriedFacts) — kept
// bounded by count, never repeated per request or per descendant.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const reads = vi.hoisted(() => new Map<string, number>())
vi.mock('../src/harnesses/claude-code/trash.js', async (orig) => {
  const actual = await orig<typeof import('../src/harnesses/claude-code/trash.js')>()
  return {
    ...actual,
    buriedFacts: (trashDir: string, folder: string, id: string) => {
      reads.set(id, (reads.get(id) ?? 0) + 1)
      return actual.buriedFacts(trashDir, folder, id)
    },
  }
})

const { claudeSessionIndex } = await import('../src/harnesses/claude-code/reader.js')
const { AgentRegistry } = await import('../src/agent-registry.js')
const { NativeStore } = await import('../src/native-store.js')
const { LineageStore } = await import('../src/lineage.js')
const { SessionOwners } = await import('../src/session-owner.js')

const user = (text: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'user', cwd: '/tmp/p', timestamp: '2026-10-21T10:00:00Z', message: { role: 'user', content: text }, ...extra }) + '\n'
const skillCall = (skill: string): string =>
  JSON.stringify({
    type: 'assistant',
    cwd: '/tmp/p',
    timestamp: '2026-10-21T10:00:01Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Skill', input: { skill } }] },
  }) + '\n'

describe('buried transcripts — read once per process', () => {
  it('many descendants of a buried chain, resolved over and over, read each buried transcript once', async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-buried-'))
    const root = join(base, 'projects')
    const data = join(base, 'data')
    mkdirSync(join(root, '-tmp-p'), { recursive: true })
    mkdirSync(join(data, 'trash', '-tmp-p'), { recursive: true })
    const registry = new AgentRegistry(join(data, 'agents.json'))
    registry.load()
    registry.create({ id: 'writer', name: 'Writer', folder: '/tmp/p', default: true })
    registry.create({ id: 'builder', name: 'Builder', folder: '/tmp/p', skills: ['builder-skill'] })
    // buried: the root r and a --resume twin m of it (m names r as its origin
    // and, like every twin, carries its history: m decides)
    writeFileSync(join(data, 'trash', '-tmp-p', 'r.jsonl'), user('you are my builder') + skillCall('builder-skill'))
    writeFileSync(join(data, 'trash', '-tmp-p', 'm.jsonl'), user('resumed', { sessionId: 'm', session_id: 'r' }) + skillCall('builder-skill'))
    for (let i = 0; i < 20; i++) writeFileSync(join(root, '-tmp-p', `c${i}.jsonl`), user(`child ${i}`))
    const index = claudeSessionIndex(root, join(data, 'cache.json'))
    await index.init()
    const lineage = new LineageStore(join(data, 'lineage.json'))
    for (let i = 0; i < 20; i++) lineage.record(`-tmp-p/c${i}`, '-tmp-p/m')
    const owners = new SessionOwners({ registry, native: new NativeStore(join(data, 'native.json')), lineage, index, trashDir: join(data, 'trash') })
    for (let round = 0; round < 5; round++) {
      for (const m of index.allSessions()) expect(owners.agentIdOf(m)).toBe('builder')
    }
    expect(reads.get('m')).toBe(1)
    expect(reads.get('r')).toBe(1)
    index.stopHeartbeat()
  })
})
