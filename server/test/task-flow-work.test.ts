// task-flow-work.test.ts — the WORK of evaluating every task's flow, counted
// (never timed: a wall-clock assertion flakes under load). 21-11, the live
// profile: the inbox tick, Task mode's look, the escalation, the board and
// each records page evaluated every task again, and each task's liveness
// asked every one of ~1,500 conversations — the event loop the owner's
// consoles ride on froze for seconds. What holds now:
//   - one synchronous pass evaluates each task's flow ONCE, whichever readers
//     ask (pass.ts); a writer, or an await, makes the next read a new one
//   - a task's liveness asks its own thread's conversations, never every
//     conversation of the install: sessions nobody's task lists add no work
//   - the thread walk is built once and does not grow with the tasks asked
//   - the indexed membership answers exactly what `belongs` answers
// Generic fixtures only (helpers/task-flow-install.ts).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { taskFlowEvaluations } from '../src/silos/task-flow.js'
import { endPass } from '../src/pass.js'
import { threadMembership, taskThreads } from '../src/task-threads.js'
import type { LineageStore } from '../src/lineage.js'
import type { SessionMeta } from '../src/types.js'
import { houseOf, syntheticInstall } from './helpers/task-flow-install.js'

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'task-flow-work-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const SMALL = { projects: 4, plansPer: 3, tasksPer: 6, sessions: 400, live: 6 }

describe('one evaluation of every task per synchronous pass', () => {
  it('the inbox, task mode, the records pages and the board share it', () => {
    const inst = syntheticInstall(base, SMALL)
    const h = houseOf(base, inst)
    const tasks = h.taskRecords()
    // each reader builds its own base records, so a task's unreadable
    // siblings (A2.5) come in a new array per reader: compared by content
    expect(tasks.filter((t) => (t.unreadableSiblings ?? []).includes('tbad')).length).toBeGreaterThan(0)
    const before = taskFlowEvaluations()
    h.inboxPass()
    h.residentPass()
    h.recordsPages()
    h.board()
    expect(taskFlowEvaluations() - before).toBe(tasks.length)
  })

  it('a writer ends the pass: the next read evaluates again', () => {
    const inst = syntheticInstall(base, SMALL)
    const h = houseOf(base, inst)
    const before = taskFlowEvaluations()
    h.residentPass()
    endPass()
    h.residentPass()
    expect(taskFlowEvaluations() - before).toBe(2 * h.taskRecords().length)
  })

  it('a kernel refresh is a writer (new readings, new answers)', () => {
    const h = houseOf(base, syntheticInstall(base, SMALL))
    const before = taskFlowEvaluations()
    h.board()
    const one = taskFlowEvaluations() - before
    expect(one).toBeGreaterThan(0)
    h.board() // the same pass: nothing evaluated again
    expect(taskFlowEvaluations() - before).toBe(one)
    h.kernel.refresh('plans')
    const after = taskFlowEvaluations()
    h.board()
    expect(taskFlowEvaluations() - after).toBe(one)
  })

  it('nothing is kept across an await', async () => {
    const inst = syntheticInstall(base, SMALL)
    const h = houseOf(base, inst)
    const before = taskFlowEvaluations()
    h.residentPass()
    await Promise.resolve()
    h.residentPass()
    expect(taskFlowEvaluations() - before).toBe(2 * h.taskRecords().length)
  })
})

describe("a task's liveness asks its thread, not the install", () => {
  it("conversations nobody's task lists add no busy checks and no listing", async () => {
    const a = houseOf(join(base, 'a'), syntheticInstall(join(base, 'a'), SMALL))
    const b = houseOf(join(base, 'b'), syntheticInstall(join(base, 'b'), { ...SMALL, strangers: 3_000 }))
    a.residentPass()
    b.residentPass()
    expect(b.counts.isActive).toBe(a.counts.isActive)
    expect(b.counts.listings).toBe(a.counts.listings)
    expect(b.counts.listings).toBeLessThanOrEqual(2) // the busy rule's read + the thread build, once each
  })

  it('the thread walk is built once: asking every task costs what asking a few does', () => {
    const inst = syntheticInstall(base, SMALL)
    const lineageOf = (counter: { n: number }): LineageStore =>
      ({
        parentIdOf: (id: string) => {
          counter.n++
          return inst.parents[id] ?? null
        },
        continuationParentIdOf: (id: string) => {
          counter.n++
          return inst.parents[id] ?? null
        },
      }) as unknown as LineageStore
    const listedSets = Array.from({ length: 300 }, (_, i) => [inst.metas[(i * 37) % inst.metas.length]!.id])
    const walk = (asks: number): number => {
      const c = { n: 0 }
      const th = taskThreads({ metas: inst.metas, lineage: lineageOf(c), ownerOf: () => 'writer' })
      for (const l of listedSets.slice(0, asks)) th.anyLive(l, () => false)
      return c.n
    }
    expect(walk(300)).toBe(walk(3))
  })
})

describe('the indexed membership is `belongs`, read the other way round', () => {
  // random worlds: chains, a cycle, trashed (unindexed) listed ids, an
  // engine's console key that seals to a native id
  function world(seed: number) {
    let s = seed
    const r = (): number => {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 2 ** 32
    }
    const parents: Record<string, string> = {}
    const metas: SessionMeta[] = []
    for (let i = 0; i < 120; i++) {
      const id = `m${i}`
      if (i > 0 && r() < 0.7) parents[id] = `m${Math.floor(r() * i)}`
      if (r() < 0.1) parents[id] = `gone${Math.floor(r() * 5)}` // through the trash
      if (r() < 0.9) metas.push({ id, folder: 'proj', title: 'T', skills: [], cwd: null, mtime: i, size: 1, turnCount: 1 })
    }
    parents.gone1 = 'gone2'
    parents.gone2 = 'gone1' // a cycle in the trash
    const lineage = { parentIdOf: (id: string) => parents[id] ?? null, continuationParentIdOf: (id: string) => parents[id] ?? null } as unknown as LineageStore
    const nativeIdOf = (id: string): string | null => (id.startsWith('key-') ? id.slice(4) : null)
    return { metas, lineage, nativeIdOf, r }
  }
  it("sessionsOf(listed) is the metas `belongs` admits, in the index's order", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const w = world(seed)
      const member = threadMembership(w.metas, w.lineage, { nativeIdOf: w.nativeIdOf })
      for (let k = 0; k < 40; k++) {
        const listed = Array.from({ length: 1 + Math.floor(w.r() * 3) }, () => {
          const x = w.r()
          const n = Math.floor(w.r() * 120)
          return x < 0.15 ? `gone${n % 5}` : x < 0.3 ? `key-m${n}` : `m${n}`
        })
        expect(member.sessionsOf(listed).map((m) => m.id)).toEqual(w.metas.filter((m) => member.belongs(m, listed)).map((m) => m.id))
      }
      expect(member.sessionsOf([])).toEqual([])
    }
  })
})
