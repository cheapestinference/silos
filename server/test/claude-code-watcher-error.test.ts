// R1 fix C-1 (CRITICAL): chokidar emits 'error' for any failure that isn't
// ENOENT/ENOTDIR (ENOSPC/EMFILE from exhausting inotify watches, transient
// EACCES...). An EventEmitter 'error' with NO listener throws and takes
// down the whole Node process — startWatcher() (the main
// ~/.claude/projects watcher) had none. This test simulates that error
// against a FAKE chokidar (a hand-controlled EventEmitter) and checks that
// emitting it no longer throws — with the fix, there's a listener; without
// it, `fake.emit('error', ...)` would throw synchronously and the test
// would fail with an uncaught throw.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { startWatcher } from '../src/harnesses/claude-code/watcher.js'

const watchMock = vi.fn()
// vitest "hoisted" (like jest.mock): this call is hoisted above the
// imports above, so startWatcher() already uses this mocked 'watch'.
vi.mock('chokidar', () => ({
  watch: (...args: unknown[]) => watchMock(...args),
}))

class FakeChokidarWatcher extends EventEmitter {
  async close(): Promise<void> {
    /* no-op */
  }
}

let closer: { close(): Promise<void> } | null = null
afterEach(async () => {
  await closer?.close()
  closer = null
  vi.restoreAllMocks()
})

describe('startWatcher — C-1 (fix round 1)', () => {
  it('a watcher error is logged with a warning and the process stays alive (no throw)', async () => {
    const fake = new FakeChokidarWatcher()
    watchMock.mockReturnValue(fake)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const idx = claudeSessionIndex('/tmp/deck-watcher-error-noop', '/tmp/deck-watcher-error-noop-cache.json')
    closer = startWatcher('/tmp/deck-watcher-error-noop', idx)

    expect(() => fake.emit('error', new Error('EMFILE: too many inotify watches'))).not.toThrow()
    expect(warnSpy).toHaveBeenCalled()
    expect(String(warnSpy.mock.calls[0]?.[0])).toMatch(/watcher/i)
  })
})
