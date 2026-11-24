// same underlying issue as watcher-error.test.ts, but for the chokidar
// watcher behind a `files` automation trigger (resident.ts watchFiles):
// without an 'error' listener, a real ENOSPC/EMFILE/EACCES (a large folder
// with depth:10, exhausting inotify watches) used to take down the ENTIRE
// resident (automations, chat, PTYs, WS). This is simulated against a FAKE
// chokidar: without the fix, emitting 'error' would throw synchronously.
// With the fix: it gets logged, lastRunError is set on the automation, and
// the resident stays alive.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRegistry } from '../src/agent-registry.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AutomationsStore } from '../src/automations-store.js'
import { Resident } from '../src/resident.js'
import type { Automation } from '../src/automations-types.js'

const watchMock = vi.fn()
vi.mock('chokidar', () => ({
  watch: (...args: unknown[]) => watchMock(...args),
}))

class FakeChokidarWatcher extends EventEmitter {
  async close(): Promise<void> {
    /* no-op */
  }
}

let resident: Resident | null = null
afterEach(() => {
  resident?.stop()
  resident = null
  vi.restoreAllMocks()
})

describe('Resident.watchFiles — error handling', () => {
  it('a watcher error from a files automation is logged, sets lastRunError, and does NOT take down the resident', () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-resident-watch-err-'))
    const root = join(base, 'projects')
    const dataDir = join(base, 'data')
    const agentFolder = join(base, 'project')
    mkdirSync(root, { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(agentFolder, { recursive: true })

    const registry = new AgentRegistry(join(dataDir, 'agents.json'))
    registry.load()
    registry.create({ id: 'finance', name: 'FINANCE', folder: agentFolder })
    const native = new NativeStore(join(dataDir, 'native.json'))
    const index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
    const store = new AutomationsStore(dataDir)
    store.load()
    const chat = new ChatService({
      registry,
      native,
      dataDir,
      queryFn: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }), interrupt: async () => {} }),
    })

    const automation: Automation = {
      id: 'wf1',
      name: 'auto files',
      agentId: 'finance',
      prompt: 'review',
      trigger: { kind: 'files', folder: join(base, 'watched'), glob: '*.md' },
      thread: { mode: 'new' },
      approval: false,
      keepAlive: false,
      paused: false,
      createdAt: new Date().toISOString(),
    }
    store.create(automation)

    const fake = new FakeChokidarWatcher()
    watchMock.mockReturnValue(fake)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    resident = new Resident({ store, registry, chat, native, index, root, dataDir, broadcast: () => {}, tickIntervalMs: 999_999_999 })
    resident.start()
    expect(resident.fileWatcherCount).toBe(1)

    expect(() => fake.emit('error', new Error('ENOSPC: inotify watches exhausted'))).not.toThrow()
    expect(warnSpy).toHaveBeenCalled()
    expect(store.get('wf1')?.lastRunError).toContain('file watcher')
    // the resident is still operational — the getter doesn't throw, the watcher is still counted
    expect(resident.fileWatcherCount).toBe(1)
  })
})
