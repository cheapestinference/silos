import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import {
  execDu,
  MachineSampler,
  outermost,
  readSamples,
  systemView,
  takeSample,
  writeSample,
  type MachineSample,
  type MachineSources,
} from '../src/machine-sampler.js'
import { systemRoutes } from '../src/routes/system.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'machine-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const put = (path: string, bytes: number): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, Buffer.alloc(bytes))
}
const disk = (usedBytes: number) => async () => ({ capBytes: 10 * usedBytes, usedBytes })
const mem = () => ({ usedBytes: 100, totalBytes: 1000, load: 0.5 })
const localDay = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const sample = (at: string, o: { used?: number; trash?: number; mem?: number } = {}): MachineSample => ({
  at,
  disk: {
    capBytes: 1000,
    usedBytes: o.used ?? 500,
    bytes: { transcripts: 10, trash: o.trash ?? 20, worktrees: 30, agentState: 40, other: (o.used ?? 500) - 100 - (o.trash ?? 20) + 20 },
  },
  mem: { usedBytes: o.mem ?? 100, totalBytes: 1000 },
  load: 1,
})

describe('attribution', () => {
  function sources(): MachineSources {
    put(join(dir, 'projects', 'a', 's.jsonl'), 50_000)
    put(join(dir, 'other-engine', 'x.jsonl'), 7_000)
    put(join(dir, 'trash', 't1', 'f'), 20_000)
    put(join(dir, 'wt', 'one', 'f'), 30_000)
    put(join(dir, 'wt', 'one', 'nested', 'f'), 5_000)
    put(join(dir, 'agent-state', 'a1', 'f'), 3_000)
    return {
      transcripts: () => [join(dir, 'projects'), join(dir, 'other-engine')],
      trash: join(dir, 'trash'),
      // a nested worktree and a gone one: counted once, the gone one skipped
      worktrees: () => [join(dir, 'wt', 'one'), join(dir, 'wt', 'one', 'nested'), join(dir, 'wt', 'gone')],
      agentState: join(dir, 'agent-state'),
      disk: dir,
    }
  }

  it('measures each group with du and leaves the rest in other', async () => {
    const src = sources()
    const du = execDu()
    const s = await takeSample(src, { disk: disk(10_000_000), mem })
    const b = s.disk.bytes
    expect(b.transcripts).toBe(await du([join(dir, 'projects'), join(dir, 'other-engine')]))
    expect(b.transcripts).toBeGreaterThanOrEqual(57_000)
    expect(b.trash).toBeGreaterThanOrEqual(20_000)
    expect(b.worktrees).toBe(await du([join(dir, 'wt', 'one')]))
    expect(b.worktrees).toBeGreaterThanOrEqual(35_000)
    expect(b.agentState).toBeGreaterThanOrEqual(3_000)
    expect(b.transcripts + b.trash + b.worktrees + b.agentState + b.other).toBe(10_000_000)
    expect(s.mem).toEqual({ usedBytes: 100, totalBytes: 1000 })
    expect(s.load).toBe(0.5)
  })

  it('a du that cannot say leaves its group at 0 and the bytes unattributed; other never goes negative', async () => {
    const src = sources()
    const s = await takeSample(src, { disk: disk(1_000_000), mem, du: async (paths) => (paths.some((p) => p.endsWith('trash')) ? null : 100_000) })
    expect(s.disk.bytes.trash).toBe(0)
    expect(s.disk.bytes.other).toBe(1_000_000 - 300_000)
    const tiny = await takeSample(src, { disk: disk(10), mem, du: async () => 100 })
    expect(tiny.disk.bytes.other).toBe(0)
  })

  it('outermost drops duplicates and nested paths', () => {
    expect(outermost(['/a/b', '/a', '/a', '/ab', '/c/d'])).toEqual(['/a', '/ab', '/c/d'])
  })
})

describe('samples on disk', () => {
  it('appends to the month file and reads back ascending, skipping malformed lines', async () => {
    await writeSample(dir, sample('2026-11-21T10:05:00.000Z'))
    await writeSample(dir, sample('2026-10-31T23:00:00.000Z'))
    appendFileSync(join(dir, '2026-11.jsonl'), 'not json\n{"at":"x"}\n')
    expect(readdirSync(dir).sort()).toEqual(['2026-10.jsonl', '2026-11.jsonl'])
    const back = await readSamples(dir, Date.parse('2026-10-01T00:00:00Z'), Date.parse('2026-11-22T00:00:00Z'))
    expect(back.map((s) => s.at)).toEqual(['2026-10-31T23:00:00.000Z', '2026-11-21T10:05:00.000Z'])
    expect((await readSamples(dir, Date.parse('2026-11-01T00:00:00Z'), Date.parse('2026-11-22T00:00:00Z'))).length).toBe(1)
  })

  it('keeps 12 months: older month files are deleted when a sample is written', async () => {
    writeFileSync(join(dir, '2025-11.jsonl'), '')
    writeFileSync(join(dir, '2025-12.jsonl'), '')
    writeFileSync(join(dir, 'notes.txt'), '')
    await writeSample(dir, sample('2026-11-21T10:00:00.000Z'))
    expect(readdirSync(dir).sort()).toEqual(['2025-12.jsonl', '2026-11.jsonl', 'notes.txt'])
  })

  it('the sampler samples at its first sweep, then once per interval', async () => {
    let n = 0
    const m = new MachineSampler({
      dir,
      intervalMs: 3600_000,
      disk: disk(1000),
      mem,
      du: async () => {
        n++
        return 1
      },
      sources: { transcripts: () => [], trash: dir, worktrees: () => [], agentState: dir, disk: dir },
    })
    const t0 = Date.parse('2026-11-21T10:00:00Z')
    expect(await m.sweep(new Date(t0))).not.toBeNull()
    expect(await m.sweep(new Date(t0 + 1800_000))).toBeNull()
    expect(await m.sweep(new Date(t0 + 3600_000))).not.toBeNull()
    expect((await readSamples(dir, t0, t0 + 3600_000)).length).toBe(2)
    expect(n).toBeGreaterThan(0)
  })
})

describe('the disk window', () => {
  // 30 CALENDAR days, also across a change of daylight saving time (a window
  // counted as 29 × 24 h lost a day late in the evening after the change)
  it('keeps 30 local days when the window crosses a DST change', () => {
    const tz = process.env.TZ
    process.env.TZ = 'Europe/Madrid'
    try {
      const nowMs = Date.parse('2026-11-21T22:50:00Z') // 23:50 local; DST ended 2026-10-25
      const samples: MachineSample[] = []
      for (let d = 29; d >= 0; d--) {
        const noon = new Date(nowMs)
        noon.setDate(noon.getDate() - d)
        noon.setHours(12, 0, 0, 0)
        samples.push({
          at: noon.toISOString(),
          disk: { capBytes: 100, usedBytes: 10, bytes: {} },
          mem: { usedBytes: 1, totalBytes: 2 },
          load: 0,
        } as MachineSample)
      }
      const view = systemView(samples, { nowMs, since: new Date(nowMs).toISOString(), disk: null, mem: { usedBytes: 1, totalBytes: 2, load: 0 } } as never)
      expect(view.disk.days).toHaveLength(30)
    } finally {
      if (tz === undefined) delete process.env.TZ
      else process.env.TZ = tz
    }
  })
})

describe('GET /api/system', () => {
  async function get(nowMs: number) {
    const app = Fastify()
    systemRoutes(app, { machineDir: dir, diskPath: dir, since: '2026-11-18T09:00:00Z', now: () => nowMs, mem, disk: disk(777) })
    const res = await app.inject({ method: 'GET', url: '/api/system' })
    await app.close()
    expect(res.statusCode).toBe(200)
    return res.json()
  }

  it('serves the series: last sample per day, hourly memory with gaps left as gaps', async () => {
    const now = Date.parse('2026-11-21T12:30:00Z')
    const h = 3600_000
    // 40 days ago: outside both windows
    await writeSample(dir, sample(new Date(now - 40 * 86_400_000).toISOString(), { used: 100 }))
    // 3 days ago at noon, twice in one hour (a restart): the later wins
    await writeSample(dir, sample(new Date(now - 3 * 86_400_000).toISOString(), { mem: 1 }))
    await writeSample(dir, sample(new Date(now - 3 * 86_400_000 + 60_000).toISOString(), { mem: 2, used: 600 }))
    // two hours ago and now — the hour between has no sample
    await writeSample(dir, sample(new Date(now - 2 * h).toISOString(), { mem: 3 }))
    await writeSample(dir, sample(new Date(now).toISOString(), { mem: 4, used: 900, trash: 55 }))
    const v = await get(now)
    expect(v.disk.capBytes).toBe(1000)
    expect(v.disk.days.map((d: { date: string }) => d.date)).toEqual([...new Set([localDay(now - 3 * 86_400_000), localDay(now - 2 * h), localDay(now)])])
    expect(v.disk.now.usedBytes).toBe(900)
    expect(v.disk.now.bytes.trash).toBe(55)
    expect(v.trash.bytes).toBe(55)
    expect(v.memory.totalBytes).toBe(1000)
    expect(v.memory.points).toEqual([
      { at: '2026-11-18T12:00:00Z', usedBytes: 2 },
      { at: '2026-11-21T10:00:00Z', usedBytes: 3 },
      { at: '2026-11-21T12:00:00Z', usedBytes: 4 },
    ])
    expect(v.load).toBe(0.5)
    expect(v.server.since).toBe('2026-11-18T09:00:00Z')
  })

  it('before the first sample: the live disk, all of it unattributed', async () => {
    const v = await get(Date.parse('2026-11-21T12:00:00Z'))
    expect(v.disk.days).toEqual([])
    expect(v.disk.now).toEqual({ usedBytes: 777, bytes: { transcripts: 0, trash: 0, worktrees: 0, agentState: 0, other: 777 } })
    expect(v.disk.capBytes).toBe(7770)
    expect(v.memory.points).toEqual([])
    expect(v.trash.bytes).toBe(0)
  })
})
