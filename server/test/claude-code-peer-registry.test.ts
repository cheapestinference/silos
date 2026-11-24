import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PeerRegistry } from '../src/harnesses/claude-code/peer-registry.js'

const reg = (o: object, name: string, dir: string) => writeFileSync(join(dir, name), JSON.stringify(o))

describe('PeerRegistry — ~/.claude/sessions/<pid>.json → cross-session address', () => {
  it('maps sessionId → name/status for live pids only; dead files, bad JSON and nameless entries are skipped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'peers-'))
    reg({ pid: 1, sessionId: 's-live', name: 'silos-1f', status: 'busy', updatedAt: 10 }, '1.json', dir)
    reg({ pid: 2, sessionId: 's-dead', name: 'silos-aa', updatedAt: 10 }, '2.json', dir)
    reg({ pid: 3, sessionId: 's-noname', updatedAt: 10 }, '3.json', dir)
    writeFileSync(join(dir, '4.json'), '{not json')
    writeFileSync(join(dir, 'README'), 'x')
    const r = new PeerRegistry(
      dir,
      (pid) => pid !== 2,
      () => 0,
    )
    expect([...r.bySession().entries()]).toEqual([['s-live', { name: 'silos-1f', sessionId: 's-live', status: 'busy' }]])
  })

  it('a session re-registered by a newer process wins by updatedAt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'peers-'))
    reg({ pid: 1, sessionId: 's', name: 'old-name', updatedAt: 5 }, '1.json', dir)
    reg({ pid: 2, sessionId: 's', name: 'new-name', updatedAt: 9 }, '2.json', dir)
    const r = new PeerRegistry(
      dir,
      () => true,
      () => 0,
    )
    expect(r.bySession().get('s')?.name).toBe('new-name')
  })

  it('caches for a few seconds, then re-reads; a missing dir yields an empty map', () => {
    const dir = mkdtempSync(join(tmpdir(), 'peers-'))
    let t = 0
    const r = new PeerRegistry(
      dir,
      () => true,
      () => t,
    )
    expect(r.bySession().size).toBe(0)
    reg({ pid: 1, sessionId: 's', name: 'n', updatedAt: 1 }, '1.json', dir)
    expect(r.bySession().size).toBe(0) // still cached
    t = 6_000
    expect(r.bySession().size).toBe(1)
    expect(
      new PeerRegistry(
        join(dir, 'nope'),
        () => true,
        () => 0,
      ).bySession().size,
    ).toBe(0)
  })
})
