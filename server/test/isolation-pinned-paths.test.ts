// isolation-pinned-paths.test.ts — agent-state isolation against path swaps.
// The rule for the whole class: a path already verified is never resolved
// again by path. Every race below is driven deterministically (the swap
// happens between the check and the use, by hand or through safeFileHooks),
// never by a loop.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentStateStore } from '../src/agent-state.js'
import { BirthsStore } from '../src/births-store.js'
import { ContextService } from '../src/context-service.js'
import { writeContextFile, writeRoleFile } from '../src/harnesses/opencode/launch.js'
import { recordPlace, scanSource } from '../src/silos/files-source.js'
import { appendContained, ContainmentError, readContained, removeContained, safeFileHooks, subdirContained } from '../src/safe-file.js'

let T: string, base: string
beforeEach(() => {
  T = realpathSync(mkdtempSync(join(tmpdir(), 'iso-r7-')))
  base = join(T, 'agent-state')
  mkdirSync(join(base, 'alice'), { recursive: true })
  mkdirSync(join(base, 'bob'), { recursive: true })
})
afterEach(() => {
  safeFileHooks.afterOpen = null
  safeFileHooks.afterVerify = null
  safeFileHooks.noPin = false
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  rmSync(T, { recursive: true, force: true })
})

// alice's state dir becomes a link to bob's (what the agent's Bash can do)
const swapAliceForBob = (): void => {
  renameSync(join(base, 'alice'), join(base, 'alice.real'))
  symlinkSync(join(base, 'bob'), join(base, 'alice'))
}

for (const noPin of [false, true]) {
  describe(noPin ? 'path-only checks (no /proc)' : 'pinned dir', () => {
    beforeEach(() => {
      safeFileHooks.noPin = noPin
    })

    // 1. launch.ts wrote <verified state dir>/opencode/* through a fresh
    //    containedDir that re-resolved the verified dir
    describe('OpenCode briefing and role files', () => {
      it("the state dir swapped after it was verified: refused, nothing lands in another agent's opencode/", () => {
        const st = new AgentStateStore(base)
        const stateDir = st.containedDirFor('alice', [], true)!
        swapAliceForBob()
        expect(() => writeContextFile(stateDir, 'ALICE BRIEFING')).toThrow(ContainmentError)
        expect(() => writeRoleFile(stateDir, 'ALICE MEMORY')).toThrow(ContainmentError)
        expect(existsSync(join(base, 'bob', 'opencode'))).toBe(false)
        // and with bob's opencode/ already there, nothing is written in it
        mkdirSync(join(base, 'bob', 'opencode'))
        expect(() => writeContextFile(stateDir, 'ALICE BRIEFING')).toThrow(ContainmentError)
        expect(readdirSync(join(base, 'bob', 'opencode'))).toEqual([])
      })

      it('a link at opencode/ (even one that stays inside the state dir) is never written through', () => {
        const st = new AgentStateStore(base)
        const stateDir = st.containedDirFor('alice', [], true)!
        mkdirSync(join(stateDir, 'elsewhere'))
        symlinkSync(join(stateDir, 'elsewhere'), join(stateDir, 'opencode'))
        expect(() => writeContextFile(stateDir, 'x')).toThrow(/is a link/)
        expect(readdirSync(join(stateDir, 'elsewhere'))).toEqual([])
      })

      it('the plain case still writes <state>/opencode/context.md and role.md', () => {
        const st = new AgentStateStore(base)
        const stateDir = st.containedDirFor('alice', [], true)!
        expect(writeContextFile(stateDir, 'B')).toBe(join(stateDir, 'opencode', 'context.md'))
        expect(writeRoleFile(stateDir, 'R')).toBe(join(stateDir, 'opencode', 'role.md'))
        expect(readFileSync(join(stateDir, 'opencode', 'role.md'), 'utf8')).toBe('R')
      })
    })

    // the same class: produced() re-resolved the verified state dir
    describe('what an agent produced', () => {
      it("the state dir swapped after it was verified lists nothing of the other agent's", () => {
        const st = new AgentStateStore(base)
        writeFileSync(join(base, 'alice', 'report.md'), 'A')
        writeFileSync(join(base, 'bob', 'secret-plan.md'), 'B')
        const ctx = new ContextService()
        const verified = st.verifiedDir('alice')
        expect(ctx.produced(verified).map((f) => f.name)).toEqual(['report.md'])
        swapAliceForBob()
        expect(ctx.produced(verified).map((f) => f.name)).toEqual([])
      })
    })

    describe('subdirContained', () => {
      it('creates the name inside the verified dir only; a dir swapped meanwhile refuses before anything is created', () => {
        const d = join(base, 'alice')
        expect(subdirContained(d, 'x', { create: true })).toBe(join(d, 'x'))
        expect(subdirContained(d, 'missing', { create: false })).toBeNull()
        swapAliceForBob()
        expect(() => subdirContained(d, 'y', { create: true })).toThrow(ContainmentError)
        expect(readdirSync(join(base, 'bob'))).toEqual([])
      })
      it('a file at the name refuses in plain words', () => {
        writeFileSync(join(base, 'alice', 'f'), '')
        expect(() => subdirContained(join(base, 'alice'), 'f', { create: true })).toThrow(/not a directory/)
      })
    })

    // 2. recordPlace followed a record-name link by realpath on the LEXICAL path
    describe('silo records', () => {
      const invoices = (a: string): string => join(base, a, 'silos', 'invoices')
      beforeEach(() => {
        for (const a of ['alice', 'bob']) mkdirSync(invoices(a), { recursive: true })
        writeFileSync(join(invoices('alice'), 'real.json'), '{"who":"alice"}')
        symlinkSync('real.json', join(invoices('alice'), 'x.json')) // a link that stays inside
        writeFileSync(join(invoices('bob'), 'x.json'), '{"who":"BOB SECRET"}')
        writeFileSync(join(invoices('bob'), 'real.json'), '{"who":"BOB SECRET"}')
      })
      const file = (): string => join(invoices('alice'), 'x.json')

      it('a record name that is a link is answered as its own place, never its target — and never read', () => {
        const p = recordPlace(file(), 'silos/invoices/x.json', 'agent:alice')!
        expect(p).toEqual({ dir: invoices('alice'), name: 'x.json' })
        expect(() => readContained(p.dir, p.name, { maxBytes: 1024 })).toThrow(/is a link/)
      })

      it('the scan refuses a record that is a link, in plain words (one rule for scan, read, write and version)', () => {
        const s = scanSource(
          { id: 's', root: 'agent-state', glob: 'silos/invoices/*.json', parser: 'json' },
          { agentStates: () => [{ agentId: 'alice', dir: join(base, 'alice') }], projects: () => [] },
        )
        expect(s.files.map((f) => f.stem)).toEqual(['real'])
        expect(s.unreadable.map((u) => [u.stem, u.reason])).toEqual([['x', 'a link — a record is read only from a regular file, never through a link']])
      })

      it("race: the agent dir swapped between the place and the read never reads bob's record as alice's", () => {
        const p = recordPlace(join(invoices('alice'), 'real.json'), 'silos/invoices/real.json', 'agent:alice')!
        safeFileHooks.afterOpen = () => {
          if (!existsSync(join(base, 'alice.real'))) swapAliceForBob()
        }
        expect(() => readContained(p.dir, p.name, { maxBytes: 1024 })).toThrow(ContainmentError)
      })
    })

    // 3. readAll read to EOF and checked the cap after
    describe('read caps', () => {
      it('a file that grows after the size check is read no further than the cap', () => {
        const d = join(base, 'alice')
        writeFileSync(join(d, 'status.json'), '{}')
        safeFileHooks.afterVerify = () => {
          truncateSync(join(d, 'status.json'), 256 * 1024 * 1024)
        } // sparse: 256 MB of nothing
        let bytes = 0
        const real = fs.readSync
        vi.spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
          const n = (real as (...a: unknown[]) => number)(...args)
          bytes += n
          return n
        }) as typeof fs.readSync)
        syncBuiltinESMExports()
        expect(() => readContained(d, 'status.json', { maxBytes: 64 * 1024 })).toThrow(/larger than 64 KB/)
        expect(bytes).toBeLessThanOrEqual(64 * 1024 + 1)
      })

      it('tail: only the last maxBytes of a long file are read', () => {
        const d = join(base, 'alice')
        writeFileSync(join(d, 'log'), 'a'.repeat(10_000) + 'END\n')
        const r = readContained(d, 'log', { maxBytes: 100, tail: true })!
        expect(r.data.length).toBe(100)
        expect(r.data.toString().endsWith('END\n')).toBe(true)
        expect(r.truncated).toBe(true)
        expect(readContained(d, 'log', { maxBytes: 20_000, tail: true })!.truncated).toBe(false)
      })
    })

    // 5. raw EISDIR with a /proc/self/fd path
    describe('a directory at the name', () => {
      it('append and remove refuse in plain words, never a /proc path', () => {
        const d = join(base, 'alice')
        mkdirSync(join(d, 'log'))
        for (const f of [() => appendContained(d, 'log', 'x'), () => removeContained(d, 'log')]) {
          let err: unknown
          try {
            f()
          } catch (e) {
            err = e
          }
          expect(err).toBeInstanceOf(ContainmentError)
          expect((err as Error).message).toContain(join(d, 'log'))
          expect((err as Error).message).toMatch(/is a directory/)
          expect((err as Error).message).not.toContain('/proc/')
        }
      })
    })
  })
}

// 4. a transient refusal (a marker mid-write: two names for a moment, or
//    half its bytes) was cached forever
describe('birth markers: a transient refusal is never cached', () => {
  const SID = 'sess-1'
  const marker = (o: Record<string, unknown> = {}): string =>
    JSON.stringify({ sessionId: SID, agentId: 'alice', parent: null, cwd: '/p', source: 'startup', at: '2026-11-03T00:00:00Z', ...o })

  it('a marker with a second name (an old hook between link and unlink) is read once the temp name is gone', () => {
    const births = join(base, 'alice', 'births')
    mkdirSync(births)
    writeFileSync(join(births, `.${SID}.abc.tmp`), marker())
    linkSync(join(births, `.${SID}.abc.tmp`), join(births, `${SID}.json`))
    const store = new BirthsStore(new AgentStateStore(base), { ttlMs: 0 })
    expect(store.get(SID)).toBeNull() // refused while it has two names
    unlinkSync(join(births, `.${SID}.abc.tmp`))
    expect(store.get(SID)?.agentId).toBe('alice')
  })

  it('a half-written marker is read again once its bytes change', () => {
    const births = join(base, 'alice', 'births')
    mkdirSync(births)
    writeFileSync(join(births, `${SID}.json`), marker().slice(0, 20))
    const store = new BirthsStore(new AgentStateStore(base), { ttlMs: 0 })
    expect(store.get(SID)).toBeNull()
    writeFileSync(join(births, `${SID}.json`), marker())
    expect(store.get(SID)?.cwd).toBe('/p')
  })

  it('an unchanged unreadable marker is not re-read on every scan', () => {
    const births = join(base, 'alice', 'births')
    mkdirSync(births)
    writeFileSync(join(births, `${SID}.json`), 'not json')
    const store = new BirthsStore(new AgentStateStore(base), { ttlMs: 0 })
    expect(store.get(SID)).toBeNull()
    let opens = 0
    const real = fs.openSync
    vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p).endsWith(`${SID}.json`)) opens++
      return (real as (...a: unknown[]) => number)(p, ...rest)
    }) as typeof fs.openSync)
    syncBuiltinESMExports()
    store.get(SID)
    store.get(SID)
    expect(opens).toBe(0)
  })
})
