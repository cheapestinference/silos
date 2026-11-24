// perf-taskflow.bench.test.ts — a BENCHMARK, not a test: it times the readers
// that evaluate every task's flow on a synthetic install (~300 tasks in ~40
// plans, ~1,500 conversations on lineage chains, a few of them live —
// helpers/task-flow-install.ts) and prints the numbers. It asserts nothing
// about time (a wall-clock assertion flakes under load; the work itself is
// counted in task-flow-work.test.ts); it runs only with SILOS_BENCH=1:
//
//   SILOS_BENCH=1 npx vitest run test/perf-taskflow.bench.test.ts --reporter=verbose
//
// (a) one inbox pass       — every task's flow + turn + `ready` (index.ts taskFlowsNow)
// (b) one resident pass    — voice.taskFlowRecords (task mode's snapshots' stalls)
// (c) one records page     — views.recordsPage of the Plans silo's tasks and plans
// (d) one board compose    — SiloSurfaces.board
// (e) the four in ONE synchronous pass (what a busy tick does)
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { houseOf, syntheticInstall } from './helpers/task-flow-install.js'

const RUN = process.env.SILOS_BENCH === '1'

describe.skipIf(!RUN)('task-flow evaluation on a synthetic install (benchmark)', () => {
  let base: string
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'perf-taskflow-'))
  })
  afterAll(() => rmSync(base, { recursive: true, force: true }))

  it('times (a) inbox, (b) resident, (c) records pages, (d) board, (e) all in one pass', async () => {
    const inst = syntheticInstall(base)
    const h = houseOf(base, inst)
    expect(h.reading().records.length).toBe(40)
    const time = async (name: string, f: () => number): Promise<void> => {
      const ms: number[] = []
      let out = 0
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setImmediate(r)) // a new synchronous pass each time
        const t = performance.now()
        out = f()
        ms.push(performance.now() - t)
      }
      ms.sort((a, b) => a - b)
      console.log(`${name.padEnd(22)} median ${ms[2]!.toFixed(1)} ms · min ${ms[0]!.toFixed(1)} · max ${ms[4]!.toFixed(1)} · (${out})`)
    }
    console.log(`install: ${inst.tasks} tasks, ${inst.metas.length} sessions`)
    await time('(a) inbox pass', h.inboxPass)
    await time('(b) resident pass', h.residentPass)
    await time('(c) records pages', h.recordsPages)
    await time('(d) board compose', h.board)
    await time('(e) all four, one pass', () => h.inboxPass() + h.residentPass() + h.recordsPages() + h.board())
    console.log('counts', h.counts)
  }, 600_000)
})
