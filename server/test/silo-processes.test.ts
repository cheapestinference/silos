// silo-processes.test.ts — the kernel kind `process` (the built-in System
// silo, silos/processes.ts) over a FAKE process table: attribution by the
// session variables, the engine never a record, wrapper-shell descent, tree
// folding, the 60 s threshold vs immediate listeners, running → left (the
// conversation stops, or is deleted), exited and its 24 h prune, pid reuse,
// an unreadable listener, redaction, no churn on a cpu-only change; the
// /proc parsers over fixture text, and the manifest. Fixtures are generic.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KERNEL_KINDS } from '../src/silos/kernel-kinds.js'
import { validateSilo } from '../src/silos/validator.js'
import { SiloReader } from '../src/silos/reader.js'
import { TransitionJournal, observationsOf } from '../src/silos/journal.js'
import { deriveConvention, type SourceConvention } from '../src/silos/manifest.js'
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { SiloOperatorStore } from '../src/silos/operator.js'
import { SiloInstaller } from '../src/silos/installer.js'
import { SiloEvents, SiloAcks } from '../src/silos/actions.js'
import { SiloSurfaces } from '../src/silos/surfaces.js'
import { linuxProcTable, parseNetTcp, parseStat, pickEnv, type ProcEntry, type ProcTable } from '../src/silos/proc-table.js'
import {
  MIN_ALIVE_MS,
  PROCESS_RETENTION_MS,
  ProcessRecords,
  REDACTED,
  SILOS_SESSION_KEY,
  evalTarget,
  isShellWrapper,
  redactCommand,
  type ConversationFacts,
} from '../src/silos/processes.js'
import { siloFile } from './helpers/silo-manifests.js'

const ENGINE_KEY = 'ENGINE_SESSION_ID' // an engine's declared key (Harness.traits.sessionEnvKeys)
const T0 = Date.parse('2026-11-21T10:00:00Z')
const SELF = 900

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'silos-proc-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const proc = (pid: number, ppid: number, argv: string[], o: Partial<ProcEntry> = {}): ProcEntry => ({
  pid,
  ppid,
  startTicks: pid * 10,
  startedAt: T0 - 3600_000,
  comm: argv[0]!.split('/').pop()!.slice(0, 15),
  argv,
  cwd: '/home/op/shop',
  cpuSeconds: 0,
  rssBytes: 10 * 1024 * 1024,
  env: {},
  ...o,
})
const table = (at: number, procs: ProcEntry[], listeners: ProcTable['listeners'] = [], complete = true): ProcTable => ({
  at,
  uid: 1000,
  procs,
  listeners,
  complete,
})

interface World {
  src: ProcessRecords
  facts: Map<string, ConversationFacts | null>
  changes: number
}
function world(o: { facts?: Record<string, ConversationFacts | null>; file?: string } = {}): World {
  const w: World = { src: null as unknown as ProcessRecords, facts: new Map(Object.entries(o.facts ?? {})), changes: 0 }
  w.src = new ProcessRecords({
    file: o.file ?? join(dir, 'processes.json'),
    sessionKeys: () => [SILOS_SESSION_KEY, ENGINE_KEY],
    engineCommands: () => new Set(['engine']),
    selfPid: SELF,
    conversations: (ids) => new Map(ids.map((id) => [id, w.facts.get(id) ?? null])),
    onChange: () => {
      w.changes++
    },
  })
  return w
}
const conv = (session: string, running: boolean, title: string | null = 'Checkout with Stripe'): ConversationFacts => ({
  session,
  folder: '-home-op-shop',
  agent: 'writer',
  title,
  running,
})
const recs = (w: World) => new Map(w.src.records().map((r) => [r.id, r.value]))

// a conversation's engine (pid 10) running a shell wrapper around a dev server
// with two workers; the engine itself carries Silos' key (a console launch)
const convTree = (o: { engineAlive?: boolean } = {}): ProcEntry[] => [
  ...(o.engineAlive === false ? [] : [proc(10, 1, ['engine', '--resume', 's-1'], { env: { [SILOS_SESSION_KEY]: 's-1' } })]),
  proc(20, o.engineAlive === false ? 1 : 10, ['/bin/bash', '-c', '-l', 'npm run dev'], { env: { [SILOS_SESSION_KEY]: 's-1', [ENGINE_KEY]: 's-1' } }),
  proc(21, 20, ['npm', 'run', 'dev'], { env: { [SILOS_SESSION_KEY]: 's-1', [ENGINE_KEY]: 's-1' }, cpuSeconds: 10 }),
  proc(22, 21, ['node', 'vite'], { env: { [SILOS_SESSION_KEY]: 's-1', [ENGINE_KEY]: 's-1' }, cpuSeconds: 20 }),
  proc(23, 21, ['node', 'esbuild'], { env: { [SILOS_SESSION_KEY]: 's-1', [ENGINE_KEY]: 's-1' }, cpuSeconds: 5 }),
]

describe('the kernel kind `process` — what a record is', () => {
  it('attributes by the session variables, never makes the engine a record, descends the wrapper and folds the tree', () => {
    const w = world({ facts: { 's-1': conv('s-1', true) } })
    w.src.observe(table(T0, convTree()), T0)
    expect(w.src.records()).toEqual([]) // below 60 s: pending, not a record
    w.src.observe(table(T0 + MIN_ALIVE_MS, convTree()), T0 + MIN_ALIVE_MS)
    const all = w.src.records()
    expect(all.map((r) => r.id)).toEqual(['21-210']) // the bash -c wrapper is not the thing: npm is
    expect(all[0]!.value).toMatchObject({
      state: 'running',
      origin: 'conversation',
      command: 'npm run dev',
      pid: 21,
      processes: 3,
      memoryMb: 30,
      session: 's-1',
      folder: '-home-op-shop',
      agent: 'writer',
      conversation: 'Checkout with Stripe',
      updatedBy: 'kernel',
    })
    expect(all[0]!.value.why).toBeUndefined()
  })

  it('a process seen less than 60 s is no record (a 2 s test worker); a listener is recorded at once', () => {
    const w = world({ facts: { 's-1': conv('s-1', true) } })
    const worker = proc(30, 10, ['node', 'worker.js'], { env: { [ENGINE_KEY]: 's-1' } })
    w.src.observe(table(T0, [proc(10, 1, ['engine']), worker]), T0)
    w.src.observe(table(T0 + 30_000, [proc(10, 1, ['engine'])]), T0 + 30_000)
    expect(w.src.records()).toEqual([])
    const dev = proc(40, 10, ['node', 'server.js'], { env: { [ENGINE_KEY]: 's-1' } })
    w.src.observe(table(T0 + 60_000, [proc(10, 1, ['engine']), dev], [{ port: 4391, uid: 1000, user: 'op', pids: [40] }]), T0 + 60_000)
    expect(recs(w).get('40-400')).toMatchObject({ state: 'running', ports: '4391' })
    expect(w.changes).toBe(0) // observe itself never calls onChange — tick does
  })

  it("a conversation's shell that starts a server with a cleared environment still hands it the session; its listener folds in", () => {
    const w = world({ facts: { 's-1': conv('s-1', false) } })
    w.src.observe(
      table(
        T0,
        [
          proc(20, 1, ['bash', '-c', 'env -i setsid npm run dev'], { env: { [ENGINE_KEY]: 's-1' } }),
          proc(21, 20, ['npm run dev']),
          proc(22, 21, ['sh', '-c', 'tsx watch src/index.ts']),
          proc(23, 22, ['node', 'tsx', 'watch']),
          proc(24, 23, ['node', 'index.ts']),
        ],
        [{ port: 3210, uid: 1000, user: 'op', pids: [24] }],
      ),
      T0,
    )
    const all = w.src.records()
    expect(all.map((r) => r.id)).toEqual(['21-210'])
    expect(all[0]!.value).toMatchObject({ origin: 'conversation', session: 's-1', ports: '3210', processes: 4, state: 'left' })
  })

  it("this server's own tree is Silos even when a conversation's shell started it — never «left running»", () => {
    const w = world({ facts: { 's-1': conv('s-1', false) } })
    w.src.observe(
      table(
        T0,
        [
          proc(20, 1, ['bash', '-c', 'env -i setsid npm run dev'], { env: { [ENGINE_KEY]: 's-1' } }),
          proc(21, 20, ['npm run dev']),
          proc(22, 21, ['node', 'tsx', 'watch']),
          proc(SELF, 22, ['node', 'index.ts']),
        ],
        [{ port: 3210, uid: 1000, user: 'op', pids: [SELF] }],
      ),
      T0,
    )
    const all = w.src.records()
    expect(all.map((r) => r.id)).toEqual(['21-210'])
    expect(all[0]!.value).toMatchObject({ origin: 'silos', state: 'running', ports: '3210' })
    expect(all[0]!.value.session).toBeUndefined()
    expect(all[0]!.value.why).toBeUndefined()
  })

  it('ports: the union over the tree, sorted', () => {
    const w = world({ facts: { 's-1': conv('s-1', true) } })
    w.src.observe(
      table(T0, convTree(), [
        { port: 5193, uid: 1000, user: 'op', pids: [22] },
        { port: 4391, uid: 1000, user: 'op', pids: [23] },
      ]),
      T0,
    )
    expect(recs(w).get('21-210')).toMatchObject({ ports: '4391, 5193', processes: 3 })
  })

  it("a listener outside any conversation: origin silos for this server's tree, machine otherwise; workers sharing the socket fold", () => {
    const w = world()
    w.src.observe(
      table(
        T0,
        [proc(SELF, 1, ['node', 'server/src/index.ts']), proc(50, 1, ['postgres', '-D', '/var/lib/pg']), proc(51, 50, ['postgres: writer'])],
        [
          { port: 3210, uid: 1000, user: 'op', pids: [SELF] },
          { port: 5432, uid: 1000, user: 'op', pids: [50, 51] },
        ],
      ),
      T0,
    )
    const r = recs(w)
    expect(r.get(`${SELF}-${SELF * 10}`)).toMatchObject({ origin: 'silos', ports: '3210', state: 'running' })
    expect(r.get('50-500')).toMatchObject({ origin: 'machine', ports: '5432', processes: 2 })
    expect(r.has('51-510')).toBe(false)
    // a plain non-listening process outside conversations is never a record
    expect(r.size).toBe(2)
  })

  it('a listener another user owns: said plainly, with its port and no command — origin other-user, never stoppable', () => {
    const w = world()
    w.src.observe(table(T0, [], [{ port: 22, uid: 0, user: 'root', pids: [] }]), T0)
    expect(recs(w).get('port-22-0')).toEqual({
      id: 'port-22-0',
      state: 'running',
      updatedBy: 'kernel',
      origin: 'other-user',
      ports: '22',
      stoppable: false,
      command: "a process of another user (root) — its command can't be read",
      startedAt: new Date(T0).toISOString(),
    })
    w.src.observe(table(T0 + 30_000, [], []), T0 + 30_000)
    expect(recs(w).get('port-22-0')).toMatchObject({ state: 'exited', exitedAt: new Date(T0 + 30_000).toISOString() })
  })
})

describe('running → left → exited', () => {
  it('left when its conversation stops (engine gone, Silos says not running), with why', () => {
    const w = world({ facts: { 's-1': conv('s-1', true) } })
    w.src.observe(table(T0, convTree()), T0)
    w.src.observe(table(T0 + MIN_ALIVE_MS, convTree()), T0 + MIN_ALIVE_MS)
    expect(recs(w).get('21-210')!.state).toBe('running')
    // the conversation closed: its engine exited, the dev server reparented to init
    w.facts.set('s-1', conv('s-1', false))
    w.src.observe(table(T0 + 90_000, convTree({ engineAlive: false })), T0 + 90_000)
    expect(recs(w).get('21-210')).toMatchObject({ state: 'left', why: 'its conversation is not running', conversation: 'Checkout with Stripe' })
  })

  it('an engine alive in the table keeps it running even when the Silos side says not', () => {
    const w = world({ facts: { 's-1': conv('s-1', false) } })
    w.src.observe(table(T0, convTree(), [{ port: 5193, uid: 1000, user: 'op', pids: [22] }]), T0)
    expect(recs(w).get('21-210')!.state).toBe('running')
  })

  it('a deleted conversation is said literally, never with an invented title', () => {
    const w = world({ facts: {} })
    w.src.observe(table(T0, convTree({ engineAlive: false }), [{ port: 5193, uid: 1000, user: 'op', pids: [22] }]), T0)
    // the wrapper's parent is init now — still descended
    expect(recs(w).get('21-210')).toMatchObject({
      state: 'left',
      why: 'its conversation was deleted',
      conversation: 'a deleted conversation (s-1)',
      session: 's-1',
    })
  })

  it('a session not yet in the index with its engine alive: running, no title said', () => {
    const w = world({ facts: {} })
    w.src.observe(table(T0, convTree(), [{ port: 5193, uid: 1000, user: 'op', pids: [22] }]), T0)
    const r = recs(w).get('21-210')!
    expect(r.state).toBe('running')
    expect(r.conversation).toBeUndefined()
  })

  it('an untitled conversation is said by its id', () => {
    const w = world({ facts: { 's-1': conv('s-1', false, null) } })
    w.src.observe(table(T0, convTree({ engineAlive: false }), [{ port: 1, uid: 1000, user: 'op', pids: [22] }]), T0)
    expect(recs(w).get('21-210')!.conversation).toBe('an untitled conversation (s-1)')
  })

  it("the engine's own key resolves first (the exact session), Silos' key after", () => {
    const w = world({ facts: { 'top-1': conv('top-1', true, 'Top'), 'nested-1': conv('nested-1', false, 'Nested') } })
    w.src.observe(
      table(
        T0,
        [proc(60, 1, ['node', 'x.js'], { env: { [SILOS_SESSION_KEY]: 'top-1', [ENGINE_KEY]: 'nested-1' } })],
        [{ port: 9, uid: 1000, user: 'op', pids: [60] }],
      ),
      T0,
    )
    expect(recs(w).get('60-600')).toMatchObject({ conversation: 'Nested', state: 'left' })
  })

  it('exited when a complete scan no longer finds it — its gauges dropped; a capped scan concludes nothing; pruned after 24 h', () => {
    const w = world({ facts: { 's-1': conv('s-1', true) } })
    w.src.observe(table(T0, convTree(), [{ port: 5193, uid: 1000, user: 'op', pids: [22] }]), T0)
    w.src.observe(table(T0 + 30_000, [], [], false), T0 + 30_000)
    expect(recs(w).get('21-210')!.state).toBe('running')
    w.src.observe(table(T0 + 60_000, []), T0 + 60_000)
    const r = recs(w).get('21-210')!
    expect(r).toMatchObject({ state: 'exited', exitedAt: new Date(T0 + 60_000).toISOString(), command: 'npm run dev', conversation: 'Checkout with Stripe' })
    expect(r.cpu).toBeUndefined()
    expect(r.memoryMb).toBeUndefined()
    expect(r.ports).toBeUndefined()
    // survives a restart (the store is on disk)
    const again = world({ file: join(dir, 'processes.json') })
    expect(again.src.records().find((x) => x.id === '21-210')!.value.state).toBe('exited')
    expect(again.src.expire(T0 + 60_000 + PROCESS_RETENTION_MS)).toBe(false)
    expect(again.src.expire(T0 + 60_000 + PROCESS_RETENTION_MS + 1)).toBe(true)
    expect(again.src.records()).toEqual([])
  })

  it('pid reuse: the same pid with a new start time is a new record, the old one exited', () => {
    const w = world()
    const l = (start: number) => table(T0, [proc(70, 1, ['node', 'a.js'], { startTicks: start })], [{ port: 8080, uid: 1000, user: 'op', pids: [70] }])
    w.src.observe(l(700), T0)
    w.src.observe({ ...l(999), at: T0 + 30_000 }, T0 + 30_000)
    const r = recs(w)
    expect(r.get('70-700')!.state).toBe('exited')
    expect(r.get('70-999')!.state).toBe('running')
  })

  it('first-seen survives a restart: the 60 s count from the first scan, not from the boot', () => {
    const w = world({ facts: { 's-1': conv('s-1', true) } })
    w.src.observe(table(T0, convTree()), T0)
    const again = world({ facts: { 's-1': conv('s-1', true) } })
    again.src.observe(table(T0 + MIN_ALIVE_MS, convTree()), T0 + MIN_ALIVE_MS)
    expect(again.src.records().map((r) => r.id)).toEqual(['21-210'])
  })
})

describe('cpu is a gauge: measured, never a change', () => {
  it('cpu = percent of one core between the last two scans; a cpu-only move writes nothing a reader journals or is told', async () => {
    const w = world({ facts: { 's-1': conv('s-1', true) } })
    const listeners = [{ port: 5193, uid: 1000, user: 'op', pids: [22] }]
    expect(w.src.observe(table(T0, convTree(), listeners), T0)).toBe(true)
    expect(recs(w).get('21-210')!.cpu).toBeUndefined() // one scan: nothing to average yet
    const written = w.src.lastWrite()
    const hot = convTree().map((p) => (p.pid === 22 ? { ...p, cpuSeconds: 20 + 15 } : p)) // 15 s of cpu in 30 s
    expect(w.src.observe(table(T0 + 30_000, hot, listeners), T0 + 30_000)).toBe(false)
    expect(recs(w).get('21-210')!.cpu).toBe(50)
    expect(w.src.lastWrite()).toBe(written)
    expect(w.src.records()[0]!.writtenAt).toBe(T0)
    // the journal, fed like the kernel feeds it, sees no transition
    const m = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'standard', 'reference', 'system.silo.json'), 'utf8'))
    const conv0 = deriveConvention(m.spec.sources[0]) as SourceConvention
    const reader = new SiloReader({ agentStates: () => [], projects: () => [] }, (k) => (k === 'process' ? w.src : null))
    const journal = new TransitionJournal(join(dir, 'conventions'))
    const feed = (now: number) =>
      observationsOf('system', m, reader.read('system', m, { now }), [conv0]).observations.map((o) => journal.observe(o, new Date(now)))
    feed(T0 + 30_000)
    const hotter = hot.map((p) => (p.pid === 22 ? { ...p, cpuSeconds: 80 } : p))
    w.src.observe(table(T0 + 60_000, hotter, listeners), T0 + 60_000)
    expect(feed(T0 + 60_000).flat()).toEqual([])
    // a fact moving (the conversation stopped) is a change
    w.facts.set('s-1', conv('s-1', false))
    expect(w.src.observe(table(T0 + 90_000, convTree({ engineAlive: false }), listeners), T0 + 90_000)).toBe(true)
    expect(
      feed(T0 + 90_000)
        .flat()
        .map((l) => [l.event, l.from, l.to]),
    ).toEqual([['transition', 'running', 'left']])
  })

  it('tick calls onChange only when a fact moved, and never overlaps itself', async () => {
    let n = 0
    let release: () => void = () => {}
    const tables = [table(T0, [proc(70, 1, ['node', 'a.js'])], [{ port: 8080, uid: 1000, user: 'op', pids: [70] }])]
    const w = world()
    const src = new ProcessRecords({
      file: join(dir, 'p2.json'),
      sessionKeys: () => [SILOS_SESSION_KEY],
      engineCommands: () => new Set(),
      table: {
        read: () =>
          new Promise((res) => {
            release = () => res(tables[0]!)
          }),
      },
      onChange: () => {
        n++
      },
    })
    void w
    const a = src.tick()
    expect(await src.tick()).toBe(false) // the first is still reading
    release()
    expect(await a).toBe(true)
    expect(n).toBe(1)
    const b = src.tick()
    release()
    expect(await b).toBe(false)
    expect(n).toBe(1)
  })

  it('no scan is judged while the Silos side is not ready (a conversation must never read «deleted» because the index is warming)', async () => {
    let reads = 0
    const src = new ProcessRecords({
      file: join(dir, 'p3.json'),
      sessionKeys: () => [],
      engineCommands: () => new Set(),
      ready: () => false,
      table: {
        read: async () => {
          reads++
          return null
        },
      },
    })
    expect(await src.tick()).toBe(false)
    expect(reads).toBe(0)
  })
})

describe('redaction — a command line is never stored with its secrets', () => {
  it('flag value, flag=value, KEY=value, inside a sh -c script, URL userinfo, opaque blobs; the length is capped', () => {
    const jwt = 'eyJhIjoiYWJjZGVmZ2hpamtsbW5vcCIsInQiOiIxMjM0NTY3ODkwIn0'
    expect(redactCommand(['/usr/local/bin/tunnel', 'run', '--token', jwt])).toBe(`tunnel run --token ${REDACTED}`)
    expect(redactCommand(['app', '--api-key=sk-live-0000', '--port=3000'])).toBe(`app --api-key=${REDACTED} --port=3000`)
    expect(redactCommand(['env', 'GITHUB_TOKEN=ghp_x1', 'DB_PASSWORD=hunter2', 'PORT=1', 'node', 'a.js'])).toBe(
      `env GITHUB_TOKEN=${REDACTED} DB_PASSWORD=${REDACTED} PORT=1 node a.js`,
    )
    expect(redactCommand(['bash', '-c', 'deploy --secret abc && API_AUTH=xyz curl -u op https://op:pw@example.test/x'])).toBe(
      `bash -c deploy --secret ${REDACTED} && API_AUTH=${REDACTED} curl -u op https://${REDACTED}@example.test/x`,
    )
    expect(redactCommand(['curl', '-H', 'x', `https://example.test/?q=1&token=${jwt}`])).not.toContain(jwt)
    expect(redactCommand(['worker', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'])).toBe(`worker ${REDACTED}`)
    expect(redactCommand(['-p', '--password', 'pw', '--credentials-file', '/home/op/c.json', '--passwd=1'])).toBe(
      `-p --password ${REDACTED} --credentials-file ${REDACTED} --passwd=${REDACTED}`,
    )
    // what is not a secret stays readable: paths, plain words, a boolean flag before another flag
    expect(redactCommand(['/usr/bin/node', '/home/op/shop/node_modules/.bin/vite', '--port', '5193', '--auth', '--open'])).toBe(
      'node /home/op/shop/node_modules/.bin/vite --port 5193 --auth --open',
    )
    const long = redactCommand(['node', ...Array.from({ length: 80 }, (_, i) => `arg${i}`)])
    expect(long.length).toBe(200)
    expect(long.endsWith('…')).toBe(true)
  })

  it('the stored file holds the redacted command, and no environment value but the session keys is ever read', () => {
    const w = world()
    w.src.observe(table(T0, [proc(80, 1, ['tunnel', 'run', '--token', 'eyJzZWNyZXQiOiJzaGgifQ'])], [{ port: 2000, uid: 1000, user: 'op', pids: [80] }]), T0)
    const onDisk = readFileSync(join(dir, 'processes.json'), 'utf8')
    expect(onDisk).not.toContain('eyJzZWNyZXQi')
    expect(onDisk).toContain(`--token ${REDACTED}`)
    expect(pickEnv(['HOME=/home/op', 'API_KEY=sk-1', `${SILOS_SESSION_KEY}=s-9`, 'EMPTY='].join('\0'), [SILOS_SESSION_KEY, 'EMPTY'])).toEqual({
      [SILOS_SESSION_KEY]: 's-9',
    })
  })

  it('a wrapper script that prepares the shell and evals one command is said by that command (still redacted)', () => {
    const script = `source /home/op/.snap/a.sh 2>/dev/null || true && \\builtin shopt -u extglob 2>/dev/null || true && eval 'npm run dev -- --token abc && echo '"'"'done'"'"'' && pwd -P >| /tmp/x`
    expect(evalTarget(script)).toBe("npm run dev -- --token abc && echo 'done'")
    expect(redactCommand(['/bin/bash', '-c', script])).toBe(`npm run dev -- --token ${REDACTED} && echo 'done'`)
    expect(evalTarget('make build')).toBeNull()
  })

  it('isShellWrapper: sh/bash -c, a login shell too; not an interactive shell nor another program', () => {
    expect(isShellWrapper({ argv: ['/bin/sh', '-c', 'x'] })).toBe(true)
    expect(isShellWrapper({ argv: ['bash', '-c', '-l', 'x'] })).toBe(true)
    expect(isShellWrapper({ argv: ['bash', '-lc', 'x'] })).toBe(true)
    expect(isShellWrapper({ argv: ['bash'] })).toBe(false)
    expect(isShellWrapper({ argv: ['node', '-c', 'x'] })).toBe(false)
  })
})

describe('the /proc reader (fixture text, never the real /proc)', () => {
  it('parseStat reads after the LAST paren: a comm with spaces and parens', () => {
    const fields = ['S', '7', ...Array.from({ length: 9 }, () => '0'), '150', '50', ...Array.from({ length: 6 }, () => '0'), '12345', '0', '2560']
    expect(parseStat(`42 (tmux: (server)) ${fields.join(' ')}`)).toEqual({
      comm: 'tmux: (server)',
      state: 'S',
      ppid: 7,
      startTicks: 12345,
      cpuTicks: 200,
      rssPages: 2560,
    })
    expect(parseStat('garbage')).toBeNull()
  })

  it('parseNetTcp keeps LISTEN rows only, with port, uid and inode', () => {
    const raw = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:0C8A 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 55501 1 0',
      '   1: 0100007F:0C8A 0100007F:A1B2 01 00000000:00000000 00:00000000 00000000  1000        0 55502 1 0',
      '   2: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1201 1 0',
    ].join('\n')
    expect(parseNetTcp(raw)).toEqual([
      { port: 3210, uid: 1000, inode: 55501 },
      { port: 22, uid: 0, inode: 1201 },
    ])
  })

  it("linuxProcTable over a fake /proc tree: this user's processes, picked env, listeners matched by socket inode, another user's said without pids", async () => {
    const root = join(dir, 'proc')
    const me = process.getuid!()
    mkdirSync(join(root, 'net'), { recursive: true })
    writeFileSync(join(root, 'stat'), 'cpu 1 2 3\nbtime 1763700000\n')
    const statLine = (pid: number, ppid: number) =>
      `${pid} (node) S ${ppid} ${Array.from({ length: 9 }, () => '0').join(' ')} 300 100 ${Array.from({ length: 6 }, () => '0').join(' ')} 5000 0 100`
    for (const [pid, ppid] of [
      [101, 1],
      [102, 101],
    ] as const) {
      const p = join(root, String(pid))
      mkdirSync(join(p, 'fd'), { recursive: true })
      writeFileSync(join(p, 'stat'), statLine(pid, ppid))
      writeFileSync(join(p, 'cmdline'), ['node', 'srv.js', '--token', 'x', ''].join('\0'))
      writeFileSync(join(p, 'environ'), ['API_KEY=sk-1', `${SILOS_SESSION_KEY}=s-1`, ''].join('\0'))
    }
    const { symlinkSync } = await import('node:fs')
    symlinkSync('/home/op/shop', join(root, '101', 'cwd'))
    symlinkSync('socket:[777]', join(root, '102', 'fd', '3'))
    writeFileSync(
      join(root, 'net', 'tcp'),
      [
        'header',
        `   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  ${me}        0 777 1 0`,
        '   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1201 1 0',
      ].join('\n'),
    )
    writeFileSync(join(dir, 'passwd'), 'root:x:0:0:root:/root:/bin/sh\n')
    const t = (await linuxProcTable({ procRoot: root, passwd: join(dir, 'passwd') }).read([SILOS_SESSION_KEY]))!
    expect(t.complete).toBe(true)
    const byPid = new Map(t.procs.map((p) => [p.pid, p]))
    expect(byPid.get(101)).toMatchObject({
      ppid: 1,
      startTicks: 5000,
      startedAt: 1763700000_000 + 50_000,
      argv: ['node', 'srv.js', '--token', 'x'],
      cwd: '/home/op/shop',
      cpuSeconds: 4,
      rssBytes: 100 * 4096,
      env: { [SILOS_SESSION_KEY]: 's-1' },
    })
    expect(byPid.get(102)!.cwd).toBeNull()
    expect(t.listeners).toEqual([
      { port: 8080, uid: me, user: null, pids: [102] },
      { port: 22, uid: 0, user: 'root', pids: [] },
    ])
  })

  it('alive: the same process only — alive, same start time, not a zombie (what a stop asks between its signals)', async () => {
    const root = join(dir, 'proc2')
    const line = (pid: number, state: string, start: number) =>
      `${pid} (node) ${state} 1 ${Array.from({ length: 9 }, () => '0').join(' ')} 0 0 ${Array.from({ length: 6 }, () => '0').join(' ')} ${start} 0 1`
    for (const [pid, state, start] of [
      [201, 'S', 7000],
      [202, 'Z', 7100],
      [203, 'R', 9999],
    ] as const) {
      mkdirSync(join(root, String(pid)), { recursive: true })
      writeFileSync(join(root, String(pid), 'stat'), line(pid, state, start))
    }
    const alive = await linuxProcTable({ procRoot: root }).alive!([
      { pid: 201, startTicks: 7000 },
      { pid: 202, startTicks: 7100 },
      { pid: 203, startTicks: 7300 },
      { pid: 204, startTicks: 1 },
    ])
    expect(alive).toEqual([{ pid: 201, startTicks: 7000 }])
  })

  it('a missing /proc is no data, said by nothing', async () => {
    expect(await linuxProcTable({ procRoot: join(dir, 'nope') }).read([])).toBeNull()
  })
})

describe('the catalog entry and the manifest', () => {
  const REF = join(import.meta.dirname, '..', '..', 'docs', 'standard', 'reference', 'system.silo.json')
  it('KERNEL_KINDS.process: running · left · exited (terminal), at = startedAt, no producers to bind', () => {
    const k = KERNEL_KINDS.process!
    expect(k.states).toEqual([
      { value: 'running', terminal: false },
      { value: 'left', terminal: false },
      { value: 'exited', terminal: true, quiet: true },
    ])
    expect(k.envelope.at).toBe('startedAt')
    expect(k.binds).toBeUndefined()
  })
  it('system.silo.json validates: kernel producer, platform anchor, open and the kernel-verb stop-process — a silo verb that writes is refused', () => {
    const m = JSON.parse(readFileSync(REF, 'utf8'))
    expect(validateSilo(m, { now: T0 }).errors).toEqual([])
    expect(m.spec.actions).toContainEqual({ verb: 'kernel-verb', name: 'stop-process', kind: 'process', when: 'stoppable' })
    expect(KERNEL_KINDS.process!.verbs).toEqual(['stop-process'])
    m.spec.actions = [{ verb: 'open' }, { verb: 'set-field', kind: 'process', fields: { state: {} } }]
    expect(validateSilo(m, { now: T0 }).errors.length).toBeGreaterThan(0)
  })
  it("the kernel-verb's when must read over the kind; its kind must be the silo's; over a files silo it is refused", () => {
    const m = JSON.parse(readFileSync(REF, 'utf8'))
    m.spec.actions[1].when = 'killable'
    expect(validateSilo(m, { now: T0 }).errors.map((e) => [e.check, e.where])).toEqual([[6, 'spec.actions[1].when']])
    const k = JSON.parse(readFileSync(REF, 'utf8'))
    k.spec.actions[1].kind = 'task'
    expect(validateSilo(k, { now: T0 }).errors.map((e) => [e.check, e.where, e.message])).toEqual([[6, 'spec.actions[1]', 'task is not a kind of this silo']])
    const files = JSON.parse(readFileSync(siloFile('invoices'), 'utf8'))
    files.spec.actions.push({ verb: 'kernel-verb', name: 'stop-process', kind: 'invoice' })
    expect(validateSilo(files, { now: T0 }).errors.map((e) => e.message)).toContain(
      'kernel-verb acts on kernel data only — this silo reads files, and its own verbs write them',
    )
  })
  it('the reader reads every record the engine holds through the manifest (none unreadable)', () => {
    const w = world({ facts: { 's-1': conv('s-1', false) } })
    w.src.observe(
      table(
        T0,
        [...convTree({ engineAlive: false }), proc(80, 1, ['tunnel', 'run'])],
        [
          { port: 5193, uid: 1000, user: 'op', pids: [22] },
          { port: 2000, uid: 1000, user: 'op', pids: [80] },
          { port: 22, uid: 0, user: 'root', pids: [] },
        ],
      ),
      T0,
    )
    const m = JSON.parse(readFileSync(REF, 'utf8'))
    const r = new SiloReader({ agentStates: () => [], projects: () => [] }, (k) => (k === 'process' ? w.src : null)).read('system', m, { now: T0 })
    expect(r.unreadable).toEqual([])
    expect(r.records.map((x) => [x.record.identity, x.record.state]).sort()).toEqual([
      ["a process of another user (root) — its command can't be read", 'running'],
      ['npm run dev', 'left'],
      ['tunnel run', 'running'],
    ])
  })
})

describe('Home stays as quiet as it was', () => {
  it('installed and active: no pulse (born off), no needs-you; an exit is NOT a Done today item nor a digest completion', () => {
    let now = T0
    const dataDir = join(dir, 'data')
    const root = join(dataDir, 'silos')
    const w = world({ facts: { 's-1': conv('s-1', true) }, file: ProcessRecords.fileIn(root) })
    const kinds = (k: string) => (k === 'process' ? w.src : null)
    const operator = new SiloOperatorStore(root)
    const registry = new SiloRegistry({ dataDir, operator })
    registry.load()
    const locations = { agentStates: () => [], projects: () => [] }
    const journal = new TransitionJournal(registry.conventionsDir)
    const kernel = new SiloKernel({ registry, reader: new SiloReader(locations, kinds), journal, now: () => now })
    const installer = new SiloInstaller({
      root,
      registry,
      operator,
      kernel,
      events: new SiloEvents(root),
      locations,
      agentStateBase: join(dir, 'agent-state'),
      isAgent: () => false,
      hasBearer: () => true,
      territoriesOf: () => [],
      now: () => now,
      kernelKinds: kinds,
    })
    const surfaces = new SiloSurfaces({
      registry,
      kernel,
      journal,
      isAgent: () => false,
      acks: new SiloAcks(root),
      producersOf: (id) => operator.producersOf(id),
    })
    const m = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'standard', 'reference', 'system.silo.json'), 'utf8'))
    expect(installer.submit({ manifest: m }, 'owner').code).toBe(201)
    expect(installer.approve('system', { slotsOff: ['pulse'] }).code).toBe(200)
    const listeners = [{ port: 5193, uid: 1000, user: 'op', pids: [22] }]
    w.src.observe(table(now, convTree(), listeners), now)
    kernel.refresh()
    now += 30_000
    w.facts.set('s-1', conv('s-1', false))
    w.src.observe(table(now, convTree({ engineAlive: false }), listeners), now)
    kernel.refresh()
    let b = surfaces.board(now)
    expect(b.pulse).toEqual([])
    expect(b.needsYou).toEqual([])
    now += 30_000
    w.src.observe(table(now, []), now)
    kernel.refresh()
    expect(kernel.reading('system')!.records.map((r) => r.record.state)).toEqual(['exited'])
    b = surfaces.board(now)
    expect(b.done).toEqual([])
    expect(surfaces.completions(T0, now + 1)).toEqual([])
    // the record keeps its story all the same (its page says when it exited)
    expect(journal.events('kernel%3Aprocess', T0, now + 1).map((l) => [l.event, l.to])).toEqual([
      ['opened', undefined],
      ['appeared', 'running'],
      ['transition', 'left'],
      ['transition', 'exited'],
    ])
  })
  it("the catalog: a process exiting and a worktree removed are the quiet ends; every other kernel kind's ends stay Done today", () => {
    expect(Object.entries(KERNEL_KINDS).flatMap(([k, kk]) => kk.states.filter((st) => st.quiet).map((st) => `${k}:${st.value}`))).toEqual([
      'process:exited',
      'worktree:removed',
    ])
  })
})
