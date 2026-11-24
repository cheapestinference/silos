import { describe, it, expect, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { mungeTmpdir, ephemeralPrefix, isEphemeralFolder, resolveEphemeralPrefix } from '../src/ephemeral.js'

describe('mungeTmpdir', () => {
  it('munges a given tmpdir to the folder shape it would have under ~/.claude/projects', () => {
    expect(mungeTmpdir('/tmp')).toBe('-tmp')
    expect(mungeTmpdir('/var/folders/xy/T')).toBe('-var-folders-xy-T') // macOS
    expect(mungeTmpdir('/tmp/claude-1234')).toBe('-tmp-claude-1234') // a typical TMPDIR override
  })
})

describe('ephemeralPrefix', () => {
  it('derives from this process real os.tmpdir() (no hardcoded /tmp)', () => {
    expect(ephemeralPrefix()).toBe(mungeTmpdir(tmpdir()))
  })

  it("with no TMPDIR (the production server) os.tmpdir() resolves to /tmp and the prefix covers the owner's real noise", () => {
    // the test run points TMPDIR at a private dir (test/global-tmp.ts) — the
    // production server has none, which is the case this pins
    const saved = process.env.TMPDIR
    delete process.env.TMPDIR
    try {
      // Empirical check: real noise folders (smokes/scratchpads) have the
      // shape "-tmp-claude-1234-...-scratchpad-r1".
      const prefix = ephemeralPrefix()
      expect(prefix).toBe('-tmp')
      expect(isEphemeralFolder('-tmp-claude-1234--home-user-x-scratchpad-r1', prefix)).toBe(true)
    } finally {
      if (saved !== undefined) process.env.TMPDIR = saved
    }
  })
})

describe('resolveEphemeralPrefix', () => {
  afterEach(() => {
    delete process.env.SILOS_NO_EPHEMERAL
  })

  it('without SILOS_NO_EPHEMERAL, behaves like the usual ephemeralPrefix()', () => {
    expect(resolveEphemeralPrefix()).toBe(ephemeralPrefix())
  })

  it('with SILOS_NO_EPHEMERAL=1, turns the rule off (null) — test harnesses only (see web/e2e/helpers.ts)', () => {
    process.env.SILOS_NO_EPHEMERAL = '1'
    expect(resolveEphemeralPrefix()).toBeNull()
  })

  it('any other value of the env var (not exactly "1") does not turn the rule off', () => {
    process.env.SILOS_NO_EPHEMERAL = 'true'
    expect(resolveEphemeralPrefix()).toBe(ephemeralPrefix())
  })

  // End-to-end integration of the real root cause: a "-tmp-..." fixture
  // folder like the ones the E2E harness seeds (mkdtempSync under
  // os.tmpdir()) is hidden with the rule on and shows up with
  // SILOS_NO_EPHEMERAL=1 — the same SessionIndex(prefix) pairing already
  // covered by session-index.test.ts, but threaded through
  // resolveEphemeralPrefix() the way index.ts actually does.
  it('a "-tmp-..." fixture folder is indexed with the rule off and hidden with it on', async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    const root = join(base, 'projects')
    const cache = join(base, 'sessions-cache.json')
    const folder = `${ephemeralPrefix()}-e2e-project`
    mkdirSync(join(root, folder), { recursive: true })
    writeFileSync(join(root, folder, 'zzz.jsonl'), '{"type":"user","cwd":"/tmp/e2e-project","message":{"role":"user","content":"harness fixture"}}\n')

    process.env.SILOS_NO_EPHEMERAL = '1'
    const withoutRule = claudeSessionIndex(root, cache, [], resolveEphemeralPrefix())
    await withoutRule.init()
    expect(withoutRule.getMeta(folder, 'zzz')).not.toBeNull()

    delete process.env.SILOS_NO_EPHEMERAL
    const withRule = claudeSessionIndex(root, join(base, 'sessions-cache-2.json'), [], resolveEphemeralPrefix())
    await withRule.init()
    expect(withRule.getMeta(folder, 'zzz')).toBeNull()
  })
})

describe('isEphemeralFolder', () => {
  const prefix = '-tmp'

  it('matches the exact prefix (cwd == tmpdir, a rare case)', () => {
    expect(isEphemeralFolder('-tmp', prefix)).toBe(true)
  })

  it('matches any cwd hanging off the tmpdir', () => {
    expect(isEphemeralFolder('-tmp-claude-1234--home-user-x-scratchpad-r1', prefix)).toBe(true)
    expect(isEphemeralFolder('-tmp-project-x', prefix)).toBe(true)
  })

  it('does NOT match a real project whose name happens to start the same way but does not hang off /tmp', () => {
    // the real cwd would be "/tmporary/project" — not under /tmp even though the name starts the same
    expect(isEphemeralFolder('-tmporary-project', prefix)).toBe(false)
  })

  it('does not match unrelated folders', () => {
    expect(isEphemeralFolder('-home-user-project', prefix)).toBe(false)
  })
})
