// safe-file.test.ts — sixth review round: the one file-IO rule for folders
// Silos doesn't own outright (safe-file.ts). A link at the name never opens,
// a hard link never reads or writes, a FIFO never freezes, and whatever is
// swapped in between the check and the use fails — the race is driven
// deterministically through safeFileHooks.afterOpen, and a real swap loop
// (renameat2 RENAME_EXCHANGE, bounded) pins the dir-pinned mode. Both modes
// run: the /proc-pinned dir and the portable path-only checks.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendContained, ContainmentError, listContained, readContained, readContainedText, safeFileHooks, writeContained } from '../src/safe-file.js'

let T: string, dir: string, other: string
const CAP = { maxBytes: 64 * 1024 }
beforeEach(() => {
  T = realpathSync(mkdtempSync(join(tmpdir(), 'safe-file-')))
  dir = join(T, 'alice')
  other = join(T, 'bob')
  mkdirSync(dir)
  mkdirSync(other)
})
afterEach(() => {
  safeFileHooks.afterOpen = null
  safeFileHooks.noPin = false
  rmSync(T, { recursive: true, force: true })
})

for (const noPin of [false, true]) {
  describe(noPin ? 'path-only checks (no /proc)' : 'pinned dir', () => {
    beforeEach(() => {
      safeFileHooks.noPin = noPin
    })

    describe('readContained', () => {
      it('reads a plain file; a missing one (or a missing dir) is null', () => {
        writeFileSync(join(dir, 'a.json'), '{"x":1}')
        expect(readContainedText(dir, 'a.json', CAP)).toBe('{"x":1}')
        expect(readContained(dir, 'nope.json', CAP)).toBeNull()
        expect(readContained(join(T, 'gone'), 'a.json', CAP)).toBeNull()
      })

      it('a link at the name never opens — even one that stays inside', () => {
        writeFileSync(join(other, 's.json'), 'BOB')
        symlinkSync(join(other, 's.json'), join(dir, 's.json'))
        expect(() => readContained(dir, 's.json', CAP)).toThrow(ContainmentError)
        writeFileSync(join(dir, 'real.json'), 'A')
        symlinkSync('real.json', join(dir, 'in.json'))
        expect(() => readContained(dir, 'in.json', CAP)).toThrow(/is a link/)
      })

      it('a hard link (nlink > 1) is refused', () => {
        writeFileSync(join(other, 's.json'), 'BOB')
        linkSync(join(other, 's.json'), join(dir, 's.json'))
        expect(() => readContained(dir, 's.json', CAP)).toThrow(/hard link/)
      })

      it('a FIFO at the name is refused without blocking', () => {
        execFileSync('mkfifo', [join(dir, 'f.json')])
        expect(() => readContained(dir, 'f.json', CAP)).toThrow(/not a regular file/)
      })

      it('a size cap refuses', () => {
        writeFileSync(join(dir, 'big'), 'x'.repeat(5000))
        expect(() => readContained(dir, 'big', { maxBytes: 1024 })).toThrow(/larger than/)
      })

      it('race: the file swapped after the open fails the inode check', () => {
        writeFileSync(join(dir, 'a.json'), 'ALICE')
        safeFileHooks.afterOpen = () => {
          renameSync(join(dir, 'a.json'), join(dir, 'old'))
          writeFileSync(join(dir, 'a.json'), 'NEW')
        }
        expect(() => readContained(dir, 'a.json', CAP)).toThrow(/swapped/)
      })

      it('the directory a link to another agent: refused; swapped for one right after the open: refused too', () => {
        writeFileSync(join(dir, 'a.json'), 'ALICE')
        writeFileSync(join(other, 'a.json'), 'BOB')
        renameSync(dir, join(T, 'alice.real'))
        symlinkSync(other, dir)
        expect(() => readContained(dir, 'a.json', CAP)).toThrow(ContainmentError)
        rmSync(dir)
        renameSync(join(T, 'alice.real'), dir)
        safeFileHooks.afterOpen = () => {
          renameSync(dir, join(T, 'alice.real'))
          symlinkSync(other, dir)
        }
        expect(() => readContained(dir, 'a.json', CAP)).toThrow(ContainmentError)
      })
    })

    describe('writeContained', () => {
      it('writes atomically, replaces a planted link or hard link instead of writing through it', () => {
        writeContained(dir, 'w.json', 'one')
        expect(readFileSync(join(dir, 'w.json'), 'utf8')).toBe('one')
        const victim = join(T, 'territory.json')
        writeFileSync(victim, '{"enabled":["finance"]}')
        rmSync(join(dir, 'w.json'))
        symlinkSync(victim, join(dir, 'w.json'))
        writeContained(dir, 'w.json', 'two')
        expect(readFileSync(victim, 'utf8')).toBe('{"enabled":["finance"]}')
        expect(readFileSync(join(dir, 'w.json'), 'utf8')).toBe('two')
        rmSync(join(dir, 'w.json'))
        linkSync(victim, join(dir, 'w.json'))
        writeContained(dir, 'w.json', 'three')
        expect(readFileSync(victim, 'utf8')).toBe('{"enabled":["finance"]}')
        expect(readdirSync(dir)).toEqual(['w.json']) // no temp left behind
      })

      it('exclusive: an existing name is never replaced', () => {
        writeFileSync(join(dir, 'm.json'), 'KEEP')
        expect(() => writeContained(dir, 'm.json', 'x', { exclusive: true })).toThrow(/already exists/)
        expect(readFileSync(join(dir, 'm.json'), 'utf8')).toBe('KEEP')
        expect(readdirSync(dir)).toEqual(['m.json'])
        writeContained(dir, 'n.json', 'new', { exclusive: true })
        expect(readFileSync(join(dir, 'n.json'), 'utf8')).toBe('new')
      })

      it('race: the directory swapped for a link right after the temp file opens — refused, nothing lands elsewhere', () => {
        safeFileHooks.afterOpen = () => {
          renameSync(dir, join(T, 'alice.real'))
          symlinkSync(other, dir)
        }
        expect(() => writeContained(dir, 'w.json', 'X')).toThrow(ContainmentError)
        expect(readdirSync(other)).toEqual([])
        expect(existsSync(join(T, 'alice.real', 'w.json'))).toBe(false)
      })
    })

    describe('appendContained', () => {
      it('appends; a link or a hard link at the name is refused before a byte', () => {
        appendContained(dir, 'log', 'a\n')
        appendContained(dir, 'log', 'b\n')
        expect(readFileSync(join(dir, 'log'), 'utf8')).toBe('a\nb\n')
        const rc = join(T, 'bashrc')
        writeFileSync(rc, '# rc\n')
        symlinkSync(rc, join(dir, 'l2'))
        expect(() => appendContained(dir, 'l2', 'x\n')).toThrow(/is a link/)
        linkSync(rc, join(dir, 'l3'))
        expect(() => appendContained(dir, 'l3', 'x\n')).toThrow(/hard link/)
        expect(readFileSync(rc, 'utf8')).toBe('# rc\n')
      })

      it('race: the file swapped after the open — refused before a byte is appended', () => {
        writeFileSync(join(dir, 'log'), 'A\n')
        writeFileSync(join(other, 'log'), 'BOB\n')
        safeFileHooks.afterOpen = () => {
          renameSync(join(dir, 'log'), join(dir, 'log.old'))
          writeFileSync(join(dir, 'log'), '')
        }
        expect(() => appendContained(dir, 'log', 'x\n')).toThrow(ContainmentError)
        expect(readFileSync(join(dir, 'log.old'), 'utf8')).toBe('A\n')
      })
    })

    describe('listContained', () => {
      it('names of a real dir; a dir that is a link (or missing) lists empty', () => {
        writeFileSync(join(dir, 'a'), '')
        expect(listContained(dir)).toEqual(['a'])
        expect(listContained(join(T, 'gone'))).toEqual([])
        symlinkSync(other, join(T, 'linked'))
        expect(listContained(join(T, 'linked'))).toEqual([])
      })
    })
  })
}

// A real concurrent swapper: alice/inbox and alice/inbox-link (→ bob's) are
// exchanged atomically in a loop while Silos reads alice's names and files.
// With the dir pinned, nothing of bob's is ever read as alice's.
const hasRenameat2 = (() => {
  try {
    execFileSync('python3', ['-c', 'import ctypes; ctypes.CDLL(None).renameat2'], { stdio: 'ignore' })
    return process.platform === 'linux' && existsSync('/proc/self/fd')
  } catch {
    return false
  }
})()
describe.runIf(hasRenameat2)('pinned dir under a real swap loop', () => {
  it("never reads another agent's file through a swapped directory", async () => {
    const inbox = join(dir, 'inbox'),
      bobInbox = join(other, 'inbox')
    mkdirSync(inbox)
    mkdirSync(bobInbox)
    writeFileSync(join(inbox, 'm.json'), 'ALICE')
    writeFileSync(join(bobInbox, 'm.json'), 'BOB SECRET')
    writeFileSync(join(bobInbox, 'b.json'), 'BOB SECRET')
    symlinkSync(bobInbox, join(dir, 'inbox-link'))
    const py =
      'import ctypes,sys,time\nl=ctypes.CDLL(None,use_errno=True)\na,b=sys.argv[1].encode(),sys.argv[2].encode()\nend=time.time()+float(sys.argv[3])\nwhile time.time()<end: l.renameat2(-100,a,-100,b,2)\n'
    const child = spawn('python3', ['-c', py, inbox, join(dir, 'inbox-link'), '1.2'], { stdio: 'ignore' })
    const exited = new Promise((r) => child.on('exit', r))
    let leaked = 0,
      reads = 0
    const t0 = Date.now()
    while (Date.now() - t0 < 1000) {
      for (const n of listContained(inbox)) {
        if (n !== 'm.json') leaked++ // b.json only exists in bob's
        try {
          const t = readContainedText(inbox, n, CAP)
          reads++
          if (t !== null && t !== 'ALICE') leaked++
        } catch {
          /* refused: fine */
        }
      }
    }
    await exited
    expect(leaked).toBe(0)
    expect(reads).toBeGreaterThan(0)
  }, 10_000)
})

// eighth review round: a crash between the exclusive write's link and its
// unlink leaves <name> with a second name — Silos' own temp beside it. That
// leftover is repaired on read; any other second name stays refused.
describe('a crash-left own temp twin is repaired; a foreign hard link is not', () => {
  let base8: string
  beforeEach(() => {
    base8 = mkdtempSync(join(tmpdir(), 'sf-twin-'))
  })
  afterEach(() => {
    rmSync(base8, { recursive: true, force: true })
  })

  it('<name> + .<name>.<12hex>.tmp on the same inode → the temp goes, the file reads', () => {
    writeFileSync(join(base8, 'm1.json'), '{"x":1}')
    linkSync(join(base8, 'm1.json'), join(base8, '.m1.json.0123456789ab.tmp'))
    expect(readContainedText(base8, 'm1.json', { maxBytes: 1024 })).toBe('{"x":1}')
    expect(existsSync(join(base8, '.m1.json.0123456789ab.tmp'))).toBe(false)
  })

  it('a second name that is not our temp pattern (another file, another dir) stays refused and untouched', () => {
    writeFileSync(join(base8, 'm2.json'), '{"x":2}')
    linkSync(join(base8, 'm2.json'), join(base8, 'stolen.json'))
    expect(() => readContainedText(base8, 'm2.json', { maxBytes: 1024 })).toThrow(ContainmentError)
    expect(existsSync(join(base8, 'stolen.json'))).toBe(true)
    mkdirSync(join(base8, 'other'))
    writeFileSync(join(base8, 'other', 'x.json'), 'X')
    linkSync(join(base8, 'other', 'x.json'), join(base8, '.x.json.0123456789ab.tmp'))
    writeFileSync(join(base8, 'x.json'), 'mine')
    expect(readContainedText(base8, 'x.json', { maxBytes: 1024 })).toBe('mine') // single-named: nothing removed
    expect(existsSync(join(base8, '.x.json.0123456789ab.tmp'))).toBe(true)
  })
})
