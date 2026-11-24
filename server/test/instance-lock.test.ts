import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOCK_FILE, acquireInstanceLock, isLiveNode } from '../src/instance-lock.js'

const dir = (): string => mkdtempSync(join(tmpdir(), 'silos-lock-'))

describe('instance lock — one server per data directory', () => {
  it('the first server takes it and writes its pid; release removes it', () => {
    const d = dir()
    const r = acquireInstanceLock(d, { pid: 111, isLiveServer: () => true })
    expect(r.ok).toBe(true)
    expect(readFileSync(join(d, LOCK_FILE), 'utf8').trim()).toBe('111')
    if (r.ok) r.release()
    expect(existsSync(join(d, LOCK_FILE))).toBe(false)
    expect(readdirSync(d)).toEqual([]) // no temp file left behind
  })

  it('a second server over the same data finds the live holder and is refused', () => {
    const d = dir()
    const a = acquireInstanceLock(d, { pid: 111, isLiveServer: () => true })
    const b = acquireInstanceLock(d, { pid: 222, isLiveServer: (p) => p === 111 })
    expect(a.ok).toBe(true)
    expect(b).toEqual({ ok: false, holder: 111 })
    expect(readFileSync(join(d, LOCK_FILE), 'utf8').trim()).toBe('111')
  })

  it('a dead holder is stale and taken over', () => {
    const d = dir()
    writeFileSync(join(d, LOCK_FILE), '999\n')
    const r = acquireInstanceLock(d, { pid: 222, isLiveServer: () => false })
    expect(r.ok).toBe(true)
    expect(readFileSync(join(d, LOCK_FILE), 'utf8').trim()).toBe('222')
  })

  it('an unreadable lock and a lock holding our own pid number are stale', () => {
    const d = dir()
    writeFileSync(join(d, LOCK_FILE), 'garbage')
    expect(acquireInstanceLock(d, { pid: 222, isLiveServer: () => true }).ok).toBe(true)
    const e = dir()
    writeFileSync(join(e, LOCK_FILE), '222\n')
    expect(acquireInstanceLock(e, { pid: 222, isLiveServer: () => true }).ok).toBe(true)
  })

  it('release never removes a lock another server took over', () => {
    const d = dir()
    const a = acquireInstanceLock(d, { pid: 111, isLiveServer: () => true })
    writeFileSync(join(d, LOCK_FILE), '333\n') // taken over after a was judged stale
    if (a.ok) a.release()
    expect(readFileSync(join(d, LOCK_FILE), 'utf8').trim()).toBe('333')
  })

  it('isLiveNode: this test process is live; a pid that does not exist is not', () => {
    expect(isLiveNode(process.pid)).toBe(true)
    expect(isLiveNode(2 ** 22 + 12345)).toBe(false)
  })
})
