// `opencode --version`, run once and cached (the version row).
import { describe, expect, it, vi } from 'vitest'
import { OpencodeVersionProbe } from '../src/harnesses/opencode/tui-auth.js'

describe('OpencodeVersionProbe', () => {
  it('runs `<bin> --version` once and caches the parsed version', async () => {
    const run = vi.fn(async () => ({ stdout: '1.14.22\n', stderr: '' }))
    const probe = new OpencodeVersionProbe({ run, bin: () => '/x/opencode' })
    expect(await probe.version()).toBe('1.14.22')
    expect(await probe.version()).toBe('1.14.22')
    expect(run).toHaveBeenCalledTimes(1)
    expect((run.mock.calls[0] as unknown[]).slice(0, 2)).toEqual(['/x/opencode', ['--version']])
  })
  it('concurrent callers share one run', async () => {
    const run = vi.fn(async () => ({ stdout: '1.15.0', stderr: '' }))
    const probe = new OpencodeVersionProbe({ run, bin: () => 'opencode' })
    expect(await Promise.all([probe.version(), probe.version()])).toEqual(['1.15.0', '1.15.0'])
    expect(run).toHaveBeenCalledTimes(1)
  })
  it('a failing or unparseable run is null — and is retried on the next call, not cached', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('ENOENT'))
      .mockResolvedValueOnce({ stdout: 'no version here', stderr: '' })
      .mockResolvedValueOnce({ stdout: '1.15.2', stderr: '' })
    const probe = new OpencodeVersionProbe({ run, bin: () => 'opencode' })
    expect(await probe.version()).toBeNull()
    expect(await probe.version()).toBeNull()
    expect(await probe.version()).toBe('1.15.2')
    expect(await probe.version()).toBe('1.15.2')
    expect(run).toHaveBeenCalledTimes(3)
  })
  it('invalidate() drops an in-flight probe too: a run started before an upgrade never becomes the answer after it', async () => {
    let releaseOld!: (v: { stdout: string; stderr: string }) => void
    const run = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            releaseOld = res
          }),
      )
      .mockResolvedValueOnce({ stdout: '1.15.0', stderr: '' })
    const probe = new OpencodeVersionProbe({ run, bin: () => 'opencode' })
    const before = probe.version() // pre-upgrade probe, still running
    probe.invalidate() // `opencode upgrade` finished
    const after = probe.version()
    releaseOld({ stdout: '1.14.22', stderr: '' })
    expect(await before).toBe('1.14.22') // its own caller gets what it asked
    expect(await after).toBe('1.15.0')
    expect(await probe.version()).toBe('1.15.0') // and the stale answer was never cached
    expect(run).toHaveBeenCalledTimes(2)
  })
})
