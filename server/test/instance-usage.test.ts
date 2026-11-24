// instance-usage.ts: what a Silos tells its Silos ID broker about its own
// use — the hours open, the turns by who started them — and that each
// finished day is sent once, kept until it lands, and never past its cap.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InstanceUsage, MAX_UNSENT, silosVersion, telemetryOn, type UsageReport } from '../src/instance-usage.js'
import { LiveTurns } from '../src/live-turns.js'

const H = 3_600_000
const D = 24 * H
const T0 = Date.UTC(2026, 10, 24, 9, 15) // 2026-11-24 09:15 UTC

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'instance-usage-'))
  dirs.push(d)
  return d
}

function usage(o: { file?: string; landed?: boolean } = {}): { u: InstanceUsage; sent: UsageReport[]; clock: { t: number } } {
  const clock = { t: T0 }
  const sent: UsageReport[] = []
  const u = new InstanceUsage({
    ...(o.file ? { file: o.file } : {}),
    now: () => clock.t,
    send: async (r) => {
      sent.push(r)
      return o.landed ?? true
    },
  })
  return { u, sent, clock }
}

describe('instance usage', () => {
  it('marks each UTC hour once and counts turns by who started them', () => {
    const file = join(tmp(), 'instance-usage.json')
    const { u, clock } = usage({ file })
    u.markActive()
    u.markActive()
    clock.t += 2 * H
    u.markActive()
    u.countTurn(true)
    u.countTurn(false)
    u.countTurn(false)
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { days: Record<string, unknown> }
    expect(onDisk.days).toEqual({ '2026-11-24': { hours: [9, 11], attended: 1, unattended: 2 } })
    // a restart reads it back
    const again = usage({ file })
    again.clock.t = T0 + D
    expect(again.u.pending()).toEqual([{ day: '2026-11-24', hours: [9, 11], attended: 1, unattended: 2 }])
  })

  it('sends only finished days, drops them once they land, keeps them when they don’t', async () => {
    const failing = usage({ landed: false })
    failing.u.markActive()
    await failing.u.report()
    expect(failing.sent).toHaveLength(0) // today is not finished
    failing.clock.t += D
    failing.u.countTurn(true)
    await failing.u.report()
    expect(failing.sent.map((r) => r.days.map((d) => d.day))).toEqual([['2026-11-24']])
    await failing.u.report()
    expect(failing.sent).toHaveLength(2) // not landed: tried again

    const ok = usage()
    ok.u.markActive()
    ok.clock.t += D
    ok.u.countTurn(false)
    await ok.u.report()
    await ok.u.report()
    expect(ok.sent).toHaveLength(1)
    expect(ok.u.pending()).toEqual([])
    ok.clock.t += D
    await ok.u.report()
    expect(ok.sent.map((r) => r.days.map((d) => d.day))).toEqual([['2026-11-24'], ['2026-11-25']])
  })

  it('a send that throws keeps the days; a long silence keeps only the last MAX_UNSENT', async () => {
    const clock = { t: T0 }
    let calls = 0
    const u = new InstanceUsage({
      now: () => clock.t,
      send: async () => {
        calls++
        throw new Error('offline')
      },
    })
    for (let i = 0; i < MAX_UNSENT + 5; i++) {
      u.markActive()
      clock.t += D
    }
    await u.report()
    expect(calls).toBe(1)
    const days = u.pending()
    expect(days).toHaveLength(MAX_UNSENT)
    expect(days[0]!.day).toBe(new Date(T0 + 5 * D).toISOString().slice(0, 10))
  })

  it('every minted turn and every spawned console is counted, attended as the turn records it', () => {
    const told: boolean[] = []
    const turns = new LiveTurns({ onTurn: (a) => told.push(a) })
    turns.mintTurn({ agentId: 'builder', turnId: 't1', turn: { class: 'chat' } })
    turns.mintTurn({ agentId: 'builder', turnId: 't2', turn: { class: 'chat' }, unattended: true })
    turns.mintTurn({ agentId: 'builder', turnId: 't3', turn: { class: 'heartbeat', kind: 'look' } })
    turns.mintTurn({ agentId: 'builder', turnId: 't4', turn: { class: 'run', automationId: 'a1', runId: 'r1' } })
    turns.mintConsole('builder', 'k1')
    // a staged console that never spawned is not a turn
    turns.stageConsole('builder', 'k2')
    expect(told).toEqual([true, false, false, false, true])
  })

  it('SILOS_TELEMETRY is on unless it says off; the version names the commit when the platform does', () => {
    for (const v of [undefined, '', 'on', '1', 'yes']) expect(telemetryOn(v), String(v)).toBe(true)
    for (const v of ['off', 'OFF', '0', 'false', 'no', ' off ']) expect(telemetryOn(v), v).toBe(false)
    expect(silosVersion({ RAILWAY_GIT_COMMIT_SHA: 'abcdef1234567890' })).toMatch(/^\d+\.\d+\.\d+\+abcdef1$/)
    expect(silosVersion({ RAILWAY_GIT_COMMIT_SHA: 'not a sha' })).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
