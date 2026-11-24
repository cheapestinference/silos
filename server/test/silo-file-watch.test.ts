// A record an agent writes reaches the kernel within a second, for EVERY
// silo (without it, a new case of a silo with no native code waited up to
// the kernel's 5-minute timer before Home's Needs you, the doorbell, the
// silo page or the record page saw it).
// The house's one watcher (knows-watcher.ts) covers every installed silo's
// convention folders and tells the kernel (noteFileChange), which re-reads
// that silo, coalesced.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloReader } from '../src/silos/reader.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { startKnowsWatcher } from '../src/knows-watcher.js'
import { siloManifest } from './helpers/silo-manifests.js'

type Json = Record<string, any>
const ref = (id: string): Json => siloManifest(id) as Json
const AGENTS = ['support', 'writer']

let base: string
let closer: { close(): Promise<void>; anchors(): string[] } | null = null
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'silo-watch-'))
})
afterEach(async () => {
  vi.useRealTimers()
  await closer?.close()
  closer = null
  rmSync(base, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 2500): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout')
    await sleep(25)
  }
}

function setup() {
  const dataDir = join(base, 'data')
  const as = join(dataDir, 'agent-state')
  for (const a of AGENTS) mkdirSync(join(as, a), { recursive: true })
  for (const id of ['support', 'invoices']) {
    mkdirSync(join(dataDir, 'silos', 'registry', id), { recursive: true })
    writeFileSync(join(dataDir, 'silos', 'registry', id, 'silo.json'), JSON.stringify(ref(id)))
  }
  const registry = new SiloRegistry({ dataDir, operator: { decisionFor: () => 'approved', slotsOff: () => [] } })
  registry.load()
  const kernel = new SiloKernel({
    registry,
    isAgent: (v) => AGENTS.includes(v),
    reader: new SiloReader({ agentStates: () => AGENTS.map((a) => ({ agentId: a, dir: join(as, a) })), projects: () => [] }),
  })
  kernel.refresh()
  const caseFile = (agent: string, id: string): string => join(as, agent, 'support', 'cases', `${id}.json`)
  const canon = (id: string): Json => ({ ...ref('support').spec.kinds.case.examples[0], id })
  return { dataDir, as, registry, kernel, caseFile, canon }
}

describe('the kernel re-reads a silo when a file under its conventions changes', () => {
  it("contentStamp moves when a record's file is rewritten or a record arrives, not on a re-read of the same files", async () => {
    const { kernel, caseFile, canon, as } = setup()
    mkdirSync(join(as, 'support', 'support', 'cases'), { recursive: true })
    writeFileSync(caseFile('support', 'c1'), JSON.stringify(canon('c1')))
    kernel.refresh()
    const first = kernel.contentStamp()
    kernel.refresh()
    expect(kernel.contentStamp()).toBe(first)
    await sleep(15)
    writeFileSync(caseFile('support', 'c1'), JSON.stringify({ ...canon('c1'), summary: 'said again' }))
    kernel.refresh()
    const second = kernel.contentStamp()
    expect(second).not.toBe(first)
    writeFileSync(caseFile('support', 'c2'), JSON.stringify(canon('c2')))
    kernel.refresh()
    expect(kernel.contentStamp()).not.toBe(second)
  })

  it('watchedFolders: every convention of every installed silo, at every location', () => {
    const { kernel, as } = setup()
    const dirs = kernel.watchedFolders()
    expect(dirs).toContainEqual({ silo: 'support', dir: join(as, 'support', 'support', 'cases') })
    expect(dirs).toContainEqual({ silo: 'support', dir: join(as, 'writer', 'support', 'cases') })
    expect(dirs.some((d) => d.silo === 'invoices')).toBe(true)
  })

  it('noteFileChange schedules ONE coalesced read of the silo that holds the path — never another silo, never a path outside', () => {
    vi.useFakeTimers()
    const { kernel, caseFile, canon } = setup()
    const reads: string[] = []
    const orig = kernel.refresh.bind(kernel)
    kernel.refresh = (id?: string) => {
      reads.push(id ?? '*')
      orig(id)
    }
    mkdirSync(join(caseFile('support', 'x'), '..'), { recursive: true })
    writeFileSync(caseFile('support', 'n1'), JSON.stringify(canon('n1')))
    expect(kernel.noteFileChange(caseFile('support', 'n1'))).toEqual(['support'])
    for (let i = 0; i < 50; i++) kernel.noteFileChange(caseFile('support', `burst${i}`)) // a burst
    expect(kernel.noteFileChange(join(base, 'elsewhere', 'n1.json'))).toEqual([])
    expect(reads).toEqual([]) // not yet: coalesced
    vi.advanceTimersByTime(600)
    expect(reads).toEqual(['support']) // one read for the burst
    expect(kernel.reading('support')!.records.some((r) => r.record.id === 'n1')).toBe(true)
  })

  it('end to end through the house watcher: a new case file is in the reading (and the status count) within a couple of seconds', async () => {
    const { kernel, registry, caseFile, canon, dataDir } = setup()
    const agents = new AgentRegistry(join(dataDir, 'agents.json'))
    agents.load()
    let refreshed = 0
    const orig = kernel.refresh.bind(kernel)
    kernel.refresh = (id?: string) => {
      refreshed++
      orig(id)
    }
    closer = startKnowsWatcher({
      registry: agents,
      broadcast: () => {},
      home: join(base, 'home'),
      projectsRoot: join(base, 'home', '.claude', 'projects'),
      dataDir,
      debounceMs: 50,
      siloFolders: () => kernel.watchedFolders().map((w) => w.dir),
      onSiloFile: (p) => {
        kernel.noteFileChange(p)
      },
    })
    await sleep(300) // the watcher is ready
    expect(registry.get('support')!.status.records.parsed).toBe(0)
    // the cases folder is missing, yet nothing is watched above Silos' data
    // dir (a root under /tmp once walked all of /tmp)
    for (const a of closer!.anchors()) expect(a === base || a.startsWith(base + '/')).toBe(true)
    expect(closer!.anchors().some((a) => a === dataDir || a.startsWith(dataDir + '/'))).toBe(true)
    // the cases folder does not exist yet: the watch anchors at its ancestor
    mkdirSync(join(caseFile('support', 'x'), '..'), { recursive: true })
    writeFileSync(caseFile('support', 'fresh'), JSON.stringify(canon('fresh')))
    await until(() => (kernel.reading('support')?.records ?? []).some((r) => r.record.id === 'fresh'))
    expect(registry.get('support')!.status.records.parsed).toBe(1)
    expect(refreshed).toBeGreaterThan(0)
  })
})
