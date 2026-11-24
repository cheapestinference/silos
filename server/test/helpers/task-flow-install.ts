// task-flow-install.ts — a synthetic install for the task-flow work tests and
// benchmark: plan files with tasks over project folders, conversations on
// lineage chains (a /clear rotation per link, up to 25 deep), a few of them
// live — read by the real Plans silo (kernel, surfaces) with the live facts
// wired the way the house wires them (index.ts: the thread reads kept 5 s,
// the busy rule over the index, ChatService's busy check). Seeded: the same
// install every run. Generic names only: proj-NN, writer/ops, sam.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SiloRegistry } from '../../src/silos/registry.js'
import { SiloReader } from '../../src/silos/reader.js'
import { SiloKernel } from '../../src/silos/kernel.js'
import { TransitionJournal } from '../../src/silos/journal.js'
import { OverlayStore } from '../../src/silos/overlay.js'
import { SiloSurfaces } from '../../src/silos/surfaces.js'
import { recordsPage } from '../../src/silos/views.js'
import { baseRecordOf, flowOf, holds, kindsOf, recordsOfKind, taskFlowRecords, type KindRecord } from '../../src/silos/voice.js'
import { turnOf } from '../../src/silos/turn.js'
import { taskThreads, type TaskThreads } from '../../src/task-threads.js'
import { conversationLive } from '../../src/conversation-live.js'
import { ChatService } from '../../src/chat-service.js'
import type { TaskEnv } from '../../src/silos/task-flow.js'
import type { LineageStore } from '../../src/lineage.js'
import type { SessionMeta } from '../../src/types.js'
import { plansManifest } from './plans-silo.js'

export const INSTALL_NOW = Date.parse('2026-11-21T12:00:00Z')
const NOW = INSTALL_NOW
const MIN = 60_000
const isAgent = (v: string): boolean => v === 'writer' || v === 'ops'

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

export interface InstallShape {
  projects?: number
  plansPer?: number
  tasksPer?: number
  sessions?: number
  live?: number
  strangers?: number
}
export interface Install {
  metas: SessionMeta[]
  parents: Record<string, string>
  folders: string[]
  tasks: number
}

// `strangers`: extra sessions on chains of their own that no task lists
export function syntheticInstall(base: string, o: InstallShape = {}): Install {
  const r = rng(7)
  const P = o.projects ?? 8,
    PL = o.plansPer ?? 5,
    T = o.tasksPer ?? 8,
    S = o.sessions ?? 1500,
    LIVE = o.live ?? 12
  const metas: SessionMeta[] = []
  const parents: Record<string, string> = {}
  const roots: string[] = []
  const chains = (count: number, prefix: string, keepRoots: boolean): void => {
    let n = 0
    while (n < count) {
      const len = 1 + Math.floor(r() * 25)
      let prev: string | null = null
      for (let i = 0; i < len && n < count; i++, n++) {
        const id = `${prefix}${String(n).padStart(5, '0')}`
        if (prev) parents[id] = prev
        else if (keepRoots) roots.push(id)
        metas.push({
          id,
          folder: `proj-${n % P}`,
          title: `Conversation ${n}`,
          skills: [],
          cwd: null,
          mtime: NOW - 3 * 3600_000 - Math.floor(r() * 30 * 86_400_000),
          size: 10,
          turnCount: 1,
        })
        prev = id
      }
    }
  }
  chains(S, 's', true)
  const listedPool = metas.length
  // a few live ones (moved a minute ago), anywhere on their chains
  for (let i = 0; i < LIVE; i++) metas[Math.floor(r() * listedPool)]!.mtime = NOW - MIN
  const states = ['pending', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled', 'pending', 'in_progress']
  const owners = ['writer', 'ops', 'owner', 'sam', 'writer', 'ops']
  const folders: string[] = []
  let tasks = 0
  for (let p = 0; p < P; p++) {
    const dir = join(base, `proj-${String(p).padStart(2, '0')}`)
    folders.push(dir)
    mkdirSync(join(dir, 'plans'), { recursive: true })
    for (let q = 0; q < PL; q++) {
      const list = []
      for (let t = 0; t < T; t++, tasks++) {
        const conv = r() < 0.7 ? [{ session: roots[Math.floor(r() * roots.length)]!, at: '2026-11-01T00:00:00Z' }] : []
        if (r() < 0.3) conv.push({ session: metas[Math.floor(r() * listedPool)]!.id, at: '2026-11-02T00:00:00Z' })
        list.push({
          id: `t${t + 1}`,
          title: `Task ${t + 1} of plan ${q}`,
          owner: owners[Math.floor(r() * owners.length)]!,
          status: states[Math.floor(r() * states.length)]!,
          dependsOn: t > 0 && r() < 0.5 ? [`t${t}`] : [],
          conversations: conv,
          ...(r() < 0.15 ? { releases: [{ session: conv[0]?.session ?? 'none', released: true, at: '2026-11-03T00:00:00Z' }] } : {}),
          ...(r() < 0.1 ? { waitingOn: { owner: 'owner', action: 'decide' } } : {}),
          ...(r() < 0.1 ? { nextCheckAt: '2026-11-20T00:00:00Z' } : {}),
        })
      }
      // one plan in four holds a task the reader can't build (no owner) and
      // one that depends on it (A2.5/E6: unreadable siblings reach the flow)
      if (q % 4 === 0)
        list.push(
          { id: 'tbad', title: 'Unreadable', status: 'pending', dependsOn: [] },
          { id: 'tdep', title: 'Waits on it', owner: 'writer', status: 'blocked', dependsOn: ['tbad'], conversations: [] },
        )
      writeFileSync(join(dir, 'plans', `plan-${q}.plan.json`), JSON.stringify({ title: `Plan ${q}`, tasks: list }))
    }
  }
  // sessions no task lists, on chains of their own (after the plans: the
  // same plans with or without them)
  if (o.strangers) chains(o.strangers, 'x', false)
  return { metas, parents, folders, tasks }
}

// The house over an install: `counts` says how often the session listing,
// the thread build, a lineage step and the busy check were reached.
export function houseOf(base: string, inst: Install) {
  const counts = { listings: 0, threadBuilds: 0, lineageSteps: 0, isActive: 0 }
  const lineage = {
    parentIdOf: (id: string) => {
      counts.lineageSteps++
      return inst.parents[id] ?? null
    },
    continuationParentIdOf: (id: string) => {
      counts.lineageSteps++
      return inst.parents[id] ?? null
    },
  } as unknown as LineageStore
  const listing = (): SessionMeta[] => {
    counts.listings++
    return inst.metas
  }
  let cache: { at: number; v: TaskThreads } | null = null
  const threadsOf = (ttl: number): TaskThreads => {
    if (!cache || NOW - cache.at > ttl || ttl === 0) {
      counts.threadBuilds++
      cache = { at: NOW, v: taskThreads({ metas: listing(), lineage, ownerOf: () => 'writer' }) }
    }
    return cache.v
  }
  // the real busy check (index.ts: chat.isSessionActive) — every engine asked
  const chat = new ChatService({
    registry: {} as never,
    native: {} as never,
    queryFn: (() => {
      throw new Error('no turns here')
    }) as never,
  })
  const live = conversationLive({
    isActive: (id) => {
      counts.isActive++
      return chat.isSessionActive(id)
    },
    sessions: listing,
    now: () => NOW,
  })
  const taskEnv: TaskEnv = {
    isLive: live,
    threadLive: (ids) => threadsOf(5_000).anyLive(ids, live),
    currentOf: (l, rel) => threadsOf(5_000).currentOf(l, rel),
    wakes: (a) => (a === 'writer' ? 'task' : 'never'),
    startable: () => true,
    wakeOnTheWay: () => false,
    titleOf: () => ({ title: 'T', at: NOW - MIN }),
  }
  const dataDir = join(base, 'data')
  mkdirSync(join(dataDir, 'silos', 'registry', 'plans'), { recursive: true })
  writeFileSync(join(dataDir, 'silos', 'registry', 'plans', 'silo.json'), JSON.stringify(plansManifest()))
  const registry = new SiloRegistry({ dataDir, operator: { decisionFor: () => 'approved', slotsOff: () => [] } })
  registry.load()
  const journal = new TransitionJournal(registry.conventionsDir)
  const kernel = new SiloKernel({
    registry,
    journal,
    overlay: new OverlayStore(registry.conventionsDir),
    isAgent,
    now: () => NOW,
    reader: new SiloReader({ agentStates: () => [], projects: () => inst.folders }),
  })
  kernel.refresh()
  const surfaces = new SiloSurfaces({ registry, kernel, journal, isAgent, taskEnv, nameOf: (id) => id.toUpperCase() })
  const entry = registry.get('plans')!
  const reading = (): NonNullable<ReturnType<typeof kernel.reading>> => kernel.reading('plans')!
  // every reader builds its own base records (voice.ts baseRecordOf — the house's one builder)
  const baseRecs = (): KindRecord[] => reading().records.map((x) => baseRecordOf(x))
  // index.ts taskFlowsNow: every task's flow, its turn, `ready`
  const inboxPass = (): number => {
    const v = surfaces.voice('plans', NOW)
    const kinds = kindsOf(entry.manifest!)
    let k = 0
    for (const info of kinds.values()) {
      if (!info.dict.task || !info.parent) continue
      for (const x of recordsOfKind(kinds, baseRecs(), info.name)) {
        if (!flowOf(info, x, v)) continue
        turnOf(x.rec, x.siblings ?? [], info.dict, (id) => id, {
          now: NOW,
          key: x.key,
          ...(x.location !== undefined ? { location: x.location } : {}),
          isAgent,
          taskEnv,
          nameOf: (id) => id,
          ...(x.unreadableSiblings ? { unreadableSiblings: x.unreadableSiblings } : {}),
        })
        holds('ready', info, x, v)
        k++
      }
    }
    return k
  }
  // task mode's snapshots (index.ts `stalled`)
  const residentPass = (): number => taskFlowRecords(entry.manifest!, baseRecs(), surfaces.voice('plans', NOW)).size
  // the records route: the board's tasks and the plans list
  const recordsPages = (): number => {
    const extras = { voice: surfaces.voice('plans', NOW), overlayKeys: new Set<string>(), conflictKeys: new Set<string>() }
    const a = recordsPage(entry, reading(), extras, { kind: 'plan/task' })
    const b = recordsPage(entry, reading(), extras, { kind: 'plan' })
    return ('error' in a ? 0 : a.total) + ('error' in b ? 0 : b.total)
  }
  const board = (): number => surfaces.board(NOW).needsYou.length
  // the plan tasks the readers evaluate, and those that carry unreadable siblings
  const taskRecords = (): KindRecord[] => recordsOfKind(kindsOf(entry.manifest!), baseRecs(), 'plan/task')
  return { counts, inboxPass, residentPass, recordsPages, board, reading, kernel, threadsOf, live, taskRecords }
}
