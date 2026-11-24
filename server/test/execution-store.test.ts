// server/test/execution-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, utimesSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { ExecutionStore, MAX_RECORD_FILE_BYTES, ledgerPathsOf } from '../src/execution-store.js'

let data: string, repo: string
beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'silos-exec-'))
  repo = mkdtempSync(join(tmpdir(), 'silos-repo-'))
})
afterEach(() => {
  rmSync(data, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

function seed(ledgerText = '# SDD ledger — plan: docs/plans/x.md\nTask 1: complete (a)\n'): string {
  mkdirSync(join(repo, '.superpowers', 'sdd', 'x'), { recursive: true })
  mkdirSync(join(repo, 'docs', 'plans'), { recursive: true })
  writeFileSync(join(repo, 'docs', 'plans', 'x.md'), '# X\n### Task 1: a\n### Task 2: b\n')
  const ledger = join(repo, '.superpowers', 'sdd', 'x', 'progress.md')
  writeFileSync(ledger, ledgerText)
  return ledger
}

describe('ledgerPathsOf', () => {
  it('keeps only ledger paths the session wrote or named', () => {
    expect(
      ledgerPathsOf([
        { path: '/r/.superpowers/sdd/x/progress.md', edits: 0, writes: 0, disk: 1 },
        { path: '/r/.superpowers/sdd/y/progress.md', edits: 0, writes: 0 },
        { path: '/r/plans/a.plan.json', edits: 1, writes: 0 },
      ]),
    ).toEqual(['/r/.superpowers/sdd/x/progress.md'])
  })
})

describe('ExecutionStore', () => {
  it('captures ledger and document, serves a record, and survives the ledger being deleted', () => {
    const ledger = seed()
    const store = new ExecutionStore(data)
    const snap = store.capture('f', 's1', [ledger])!
    expect(snap.planPath).toBe(realpathSync(join(repo, 'docs', 'plans', 'x.md')))
    expect(snap.plan).toContain('### Task 2: b')
    expect(existsSync(join(data, 'executions', 'f', 's1.json'))).toBe(true)
    expect(store.record('f', 's1', [ledger])).toMatchObject({ done: 1, total: 2, gone: false })
    rmSync(join(repo, '.superpowers'), { recursive: true })
    const fresh = new ExecutionStore(data) // a restart: memory empty, disk copy remains
    expect(fresh.record('f', 's1', [ledger])).toMatchObject({ done: 1, total: 2, gone: true })
  })
  it('re-reads only when the ledger moved on, and picks the newest of several', () => {
    const ledger = seed()
    const store = new ExecutionStore(data)
    const first = store.capture('f', 's1', [ledger])!
    expect(store.capture('f', 's1', [ledger])!.savedAt).toBe(first.savedAt) // unchanged ledger: not re-saved
    writeFileSync(ledger, '# SDD ledger — plan: docs/plans/x.md\nTask 1: complete (a)\nTask 2: complete (b)\n')
    utimesSync(ledger, new Date(Date.now() + 5000), new Date(Date.now() + 5000))
    expect(store.record('f', 's1', [ledger])?.done).toBe(2)
    const older = join(repo, '.superpowers', 'sdd', 'old', 'progress.md')
    mkdirSync(dirname(older), { recursive: true })
    writeFileSync(older, '# SDD ledger — plan: docs/plans/old.md\nTask 9: complete (z)\n')
    utimesSync(older, new Date(Date.now() - 1e7), new Date(Date.now() - 1e7))
    expect(store.record('f', 's1', [older, ledger])?.done).toBe(2) // the newer ledger speaks
  })
  it('nothing captured when no ledger path exists; a corrupt copy is backed up and ignored', () => {
    const store = new ExecutionStore(data)
    expect(store.capture('f', 's1', [join(repo, '.superpowers', 'sdd', 'x', 'progress.md')])).toBeNull()
    expect(store.record('f', 's1', [])).toBeNull()
    mkdirSync(join(data, 'executions', 'f'), { recursive: true })
    writeFileSync(join(data, 'executions', 'f', 's2.json'), '{not json')
    expect(store.get('f', 's2')).toBeNull()
    expect(readdirSync(join(data, 'executions', 'f')).some((n) => n.startsWith('s2.json.corrupt-'))).toBe(true)
    const ledger = seed()
    const snap = store.capture('f', 's2', [ledger])
    expect(snap?.ledger).toContain('Task 1: complete')
    expect(new ExecutionStore(data).get('f', 's2')?.ledgerPath).toBe(ledger)
    expect(store.capture('f/../x', 's1', [])).toBeNull()
  })
  it('resolves a document the ledger names relative to the repo root, falling back to the session cwd', () => {
    const ledger = seed('# SDD ledger — plan: elsewhere/x.md\nTask 1: complete (a)\n')
    mkdirSync(join(data, 'cwd', 'elsewhere'), { recursive: true })
    writeFileSync(join(data, 'cwd', 'elsewhere', 'x.md'), '# From cwd\n### Task 1: a\n')
    const store = new ExecutionStore(data)
    expect(store.capture('f', 's1', [ledger], [join(data, 'cwd')])?.plan).toContain('From cwd')
  })
  it('never reads a document outside the repo or the session cwd, nor a non-markdown one', () => {
    const outside = mkdtempSync(join(tmpdir(), 'silos-outside-'))
    try {
      writeFileSync(join(outside, 'outside.md'), '# Secret\n### Task 1: a\n')
      const store = new ExecutionStore(data)
      const abs = seed('# SDD ledger — plan: /etc/hostname\nTask 1: complete (a)\n')
      expect(store.capture('f', 'a', [abs])).toMatchObject({ planPath: null, plan: null })
      const rel = seed(`# SDD ledger — plan: ../${outside.split('/').pop()}/outside.md\nTask 1: complete (a)\n`)
      expect(store.capture('f', 'b', [rel])).toMatchObject({ planPath: null, plan: null })
      const absMd = seed(`# SDD ledger — plan: ${join(outside, 'outside.md')}\nTask 1: complete (a)\n`)
      expect(store.capture('f', 'c', [absMd])).toMatchObject({ planPath: null, plan: null })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
  it('does not follow a symlink inside the repo to a document outside it', () => {
    const outside = mkdtempSync(join(tmpdir(), 'silos-outside-'))
    try {
      writeFileSync(join(outside, 'real.md'), '# Secret\n### Task 1: a\n')
      const ledger = seed('# SDD ledger — plan: docs/plans/link.md\nTask 1: complete (a)\n')
      symlinkSync(join(outside, 'real.md'), join(repo, 'docs', 'plans', 'link.md'))
      expect(new ExecutionStore(data).capture('f', 'l', [ledger])).toMatchObject({ planPath: null, plan: null })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('never reads a FIFO named like a ledger (it would hang the server)', () => {
    const ledger = join(repo, '.superpowers', 'sdd', 'x', 'progress.md')
    mkdirSync(dirname(ledger), { recursive: true })
    try {
      execFileSync('mkfifo', [ledger])
    } catch {
      return
    } // no mkfifo here: nothing to prove
    const store = new ExecutionStore(data)
    expect(store.capture('f', 'fifo', [ledger])).toBeNull()
    expect(store.record('f', 'fifo', [ledger])).toBeNull()
  })
  it('does not follow a ledger symlink to a file that is not a ledger', () => {
    const outside = mkdtempSync(join(tmpdir(), 'silos-outside-'))
    try {
      writeFileSync(join(outside, 'outside.txt'), 'Task 1: complete (secret)\n')
      const ledger = join(repo, '.superpowers', 'sdd', 'x', 'progress.md')
      mkdirSync(dirname(ledger), { recursive: true })
      symlinkSync(join(outside, 'outside.txt'), ledger)
      expect(new ExecutionStore(data).capture('f', 'sym', [ledger])).toBeNull()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
  it('an oversize ledger is not read; the saved copy stays', () => {
    const ledger = seed()
    const store = new ExecutionStore(data)
    const first = store.capture('f', 'big', [ledger])!
    writeFileSync(ledger, 'Task 1: complete (a)\n' + 'x'.repeat(MAX_RECORD_FILE_BYTES))
    utimesSync(ledger, new Date(Date.now() + 5000), new Date(Date.now() + 5000))
    expect(store.capture('f', 'big', [ledger])).toBe(first)
    expect(new ExecutionStore(data).capture('f', 'other', [ledger])).toBeNull()
  })
  it('an oversize plan document is not read', () => {
    const ledger = seed()
    writeFileSync(join(repo, 'docs', 'plans', 'x.md'), '# X\n### Task 1: a\n' + 'x'.repeat(MAX_RECORD_FILE_BYTES))
    expect(new ExecutionStore(data).capture('f', 'bigdoc', [ledger])).toMatchObject({ planPath: null, plan: null })
  })
})
