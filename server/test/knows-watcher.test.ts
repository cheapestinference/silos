// knows-watcher.test.ts — the Knows Drawer's live feed: fs writes on the
// memory/context/skills paths of registered agents become one coalesced
// `knows` WS event per (kind, folder).
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRegistry, mungePath } from '../src/agent-registry.js'
import { anchorFor, startKnowsWatcher, type KnowsEvent } from '../src/knows-watcher.js'

let closer: { close(): Promise<void>; ready: Promise<void> } | null = null
afterEach(async () => {
  await closer?.close()
  closer = null
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for the knows watcher')
    await sleep(25)
  }
}

// A temp home with ~/.claude/projects, a data dir and one registered agent
// whose folder exists. `withMemoryDir` pre-creates the auto-memory dir.
function setup(opts: { withMemoryDir?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'deck-knows-'))
  const home = join(base, 'home')
  const projectsRoot = join(home, '.claude', 'projects')
  const dataDir = join(base, 'data')
  const folder = join(base, 'proj')
  mkdirSync(projectsRoot, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(folder, { recursive: true })
  const memDir = join(projectsRoot, mungePath(folder), 'memory')
  if (opts.withMemoryDir) mkdirSync(memDir, { recursive: true })
  const registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  registry.create({ id: 'builder', name: 'BUILDER', folder })
  return { home, projectsRoot, dataDir, folder, memDir, registry }
}

function start(env: ReturnType<typeof setup>, debounceMs?: number) {
  const events: KnowsEvent[] = []
  closer = startKnowsWatcher({
    registry: env.registry,
    broadcast: (e) => {
      events.push(e)
    },
    home: env.home,
    projectsRoot: env.projectsRoot,
    dataDir: env.dataDir,
    ...(debounceMs !== undefined ? { debounceMs } : {}),
  })
  return events
}

describe('startKnowsWatcher', () => {
  it('a new .md in memory/ emits an added auto-memory event for the folder', async () => {
    const env = setup({ withMemoryDir: true })
    const events = start(env, 50)
    await closer!.ready // chokidar scanned the anchors

    writeFileSync(join(env.memDir, 'note.md'), '# hi')
    await until(() => events.length > 0)
    expect(events).toEqual([{ type: 'knows', folder: env.folder, kind: 'memory', action: 'added', name: 'note.md', scope: 'auto' }])
  })

  it('picks up a memory/ dir that did not exist when the watcher started', async () => {
    const env = setup()
    const events = start(env, 50)
    await closer!.ready // chokidar scanned the anchors

    mkdirSync(env.memDir, { recursive: true })
    await sleep(200) // the new dir gets watched
    writeFileSync(join(env.memDir, 'late.md'), '# late')
    await until(() => events.some((e) => e.name === 'late.md'))
    expect(events.find((e) => e.name === 'late.md')).toMatchObject({ kind: 'memory', scope: 'auto', action: 'added', folder: env.folder })
  })

  it('a file uploaded to context/shared/ emits a shared context event; context/<id>/ carries the agentId', async () => {
    const env = setup()
    const events = start(env, 50)
    await closer!.ready // chokidar scanned the anchors

    mkdirSync(join(env.folder, 'context', 'shared'), { recursive: true })
    await sleep(200)
    writeFileSync(join(env.folder, 'context', 'shared', 'spec.pdf'), 'pdf')
    await until(() => events.length > 0)
    expect(events).toEqual([{ type: 'knows', folder: env.folder, kind: 'context', action: 'added', name: 'spec.pdf', scope: 'shared' }])

    mkdirSync(join(env.folder, 'context', 'builder'), { recursive: true })
    await sleep(200)
    writeFileSync(join(env.folder, 'context', 'builder', 'notes.txt'), 'x')
    await until(() => events.length > 1)
    expect(events[1]).toEqual({ type: 'knows', folder: env.folder, agentId: 'builder', kind: 'context', action: 'added', name: 'notes.txt', scope: 'agent' })
  })

  it('a deliverable deep under context/<id>/ is named by its relative path; deeper than the walk, dot-dirs and node_modules stay silent', async () => {
    const env = setup()
    const events = start(env, 50)
    await closer!.ready // chokidar scanned the anchors

    const builder = join(env.folder, 'context', 'builder')
    mkdirSync(join(builder, 'analysis', 'q4'), { recursive: true })
    mkdirSync(join(builder, 'a', 'b', 'c', 'd', 'e'), { recursive: true })
    mkdirSync(join(builder, 'node_modules', 'x'), { recursive: true })
    mkdirSync(join(builder, '.cache'), { recursive: true })
    mkdirSync(join(builder, 'conversations', 'aaaaaaaa-1111-4111-8111-111111111111'), { recursive: true })
    await sleep(300)
    writeFileSync(join(builder, 'a', 'b', 'c', 'd', 'e', 'too-deep.md'), 'x')
    writeFileSync(join(builder, 'node_modules', 'x', 'index.js'), 'x')
    writeFileSync(join(builder, '.cache', 'tmp.md'), 'x')
    await sleep(300)
    writeFileSync(join(builder, 'a', 'b', 'c', 'd', 'deepest.md'), 'x')
    await until(() => events.length > 0)
    await sleep(200)
    expect(events).toEqual([
      { type: 'knows', folder: env.folder, agentId: 'builder', kind: 'context', action: 'added', name: 'a/b/c/d/deepest.md', scope: 'agent' },
    ])

    writeFileSync(join(builder, 'analysis', 'q4', '16-audit.md'), 'x')
    await until(() => events.length > 1)
    expect(events[1]).toMatchObject({ agentId: 'builder', name: 'analysis/q4/16-audit.md', scope: 'agent' })

    // one conversation's file: the same context event, its own scope — never the agent's
    writeFileSync(join(builder, 'conversations', 'aaaaaaaa-1111-4111-8111-111111111111', 'brief.md'), 'x')
    await until(() => events.length > 2)
    expect(events[2]).toMatchObject({ agentId: 'builder', kind: 'context', name: 'brief.md', scope: 'conversation' })
  })

  it('global CLAUDE.md, project CLAUDE.md, agent memory.md and both skills roots map to their scopes', async () => {
    const env = setup()
    mkdirSync(join(env.dataDir, 'agents', 'builder'), { recursive: true })
    const events = start(env, 50)
    await closer!.ready // chokidar scanned the anchors

    // One write can surface as more than one event: a skill's dir `addDir`
    // fires at once, its SKILL.md `add` only after awaitWriteFinish (~80 ms+),
    // which outlasts this test's 50 ms debounce (production's 300 ms
    // coalesces them). Waiting for just the first event let the straggler
    // land as the NEXT step's events[n] (~1 run in 3). So each step waits
    // for the watcher to go quiet, and every event it produced must match.
    const quiet = async (ms = 400) => {
      let seen = events.length
      let t0 = Date.now()
      while (Date.now() - t0 < ms) {
        await sleep(25)
        if (events.length !== seen) {
          seen = events.length
          t0 = Date.now()
        }
      }
    }
    const step = async (write: () => void, expected: Partial<KnowsEvent>) => {
      const n = events.length
      write()
      await until(() => events.length > n)
      await quiet()
      for (const e of events.slice(n)) expect(e).toMatchObject(expected)
    }
    await step(() => writeFileSync(join(env.home, '.claude', 'CLAUDE.md'), 'g'), {
      kind: 'memory',
      scope: 'global',
      folder: '',
      name: 'CLAUDE.md',
      action: 'added',
    })
    await step(() => writeFileSync(join(env.folder, 'CLAUDE.md'), 'p'), { kind: 'memory', scope: 'project', folder: env.folder, name: 'CLAUDE.md' })
    await step(() => writeFileSync(join(env.dataDir, 'agents', 'builder', 'memory.md'), 'a'), {
      kind: 'memory',
      scope: 'agent',
      folder: env.folder,
      agentId: 'builder',
      name: 'memory.md',
    })
    await step(
      () => {
        mkdirSync(join(env.folder, '.claude', 'skills', 'deploy'), { recursive: true })
        writeFileSync(join(env.folder, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\n---')
      },
      { kind: 'skills', scope: 'project', folder: env.folder, name: 'deploy' },
    )
    await step(
      () => {
        mkdirSync(join(env.home, '.claude', 'skills', 'mine'), { recursive: true })
        writeFileSync(join(env.home, '.claude', 'skills', 'mine', 'SKILL.md'), '---\nname: mine\n---')
      },
      { kind: 'skills', scope: 'user', folder: '', name: 'mine' },
    )
  })

  // a sentinel of another (kind, folder), written after: once its event is
  // out, anything the ignored writes had produced would be out too
  it('ignores files outside the watched paths and atomic-write temp files', async () => {
    const env = setup({ withMemoryDir: true })
    mkdirSync(join(env.folder, 'plans'))
    const events = start(env, 50)
    await closer!.ready // chokidar scanned the anchors

    writeFileSync(join(env.folder, 'README.md'), 'not knows')
    writeFileSync(join(env.memDir, '.note.md.tmp-abcd'), 'tmp')
    writeFileSync(join(env.memDir, 'data.json'), '{}')
    writeFileSync(join(env.folder, 'plans', 'sentinel.plan.json'), '{}')
    await until(() => events.length > 0)
    expect(events.map((e) => e.name)).toEqual(['sentinel.plan.json'])
  })

  it('a burst inside the debounce window is exactly 1 event per (kind, folder), carrying the last state', async () => {
    const env = setup({ withMemoryDir: true })
    mkdirSync(join(env.folder, 'context', 'shared'), { recursive: true })
    const events = start(env) // default debounce (300 ms)
    await closer!.ready // chokidar scanned the anchors

    for (let i = 0; i < 10; i++) {
      writeFileSync(join(env.memDir, `note-${i}.md`), `# ${i}`)
      if (i === 5) writeFileSync(join(env.folder, 'context', 'shared', 'a.txt'), 'a')
      await sleep(20)
    }
    await until(() => events.length >= 2)
    await sleep(600) // nothing else trickles out after the window
    expect(events).toHaveLength(2)
    expect(events.find((e) => e.kind === 'memory')).toEqual({
      type: 'knows',
      folder: env.folder,
      kind: 'memory',
      action: 'added',
      name: 'note-9.md',
      scope: 'auto',
    })
    expect(events.find((e) => e.kind === 'context')).toMatchObject({ name: 'a.txt', scope: 'shared' })
  })

  it('reports changed and removed', async () => {
    const env = setup({ withMemoryDir: true })
    const file = join(env.memDir, 'x.md')
    writeFileSync(file, 'v1')
    const events = start(env, 50)
    await closer!.ready // chokidar scanned the anchors

    writeFileSync(file, 'v2 longer')
    await until(() => events.length > 0)
    expect(events[0]).toMatchObject({ action: 'changed', name: 'x.md' })
    rmSync(file)
    await until(() => events.length > 1)
    expect(events[1]).toMatchObject({ action: 'removed', name: 'x.md' })
  })

  it('re-anchors a watched dir that is deleted and re-created (resync)', async () => {
    const env = setup({ withMemoryDir: true })
    const events: KnowsEvent[] = []
    closer = startKnowsWatcher({
      registry: env.registry,
      broadcast: (e) => {
        events.push(e)
      },
      home: env.home,
      projectsRoot: env.projectsRoot,
      dataDir: env.dataDir,
      debounceMs: 50,
      resyncMs: 100,
    })
    await closer!.ready // chokidar scanned the anchors
    rmSync(env.memDir, { recursive: true })
    await sleep(400) // a resync notices the anchor is gone and watches an ancestor
    mkdirSync(env.memDir)
    await sleep(200)
    writeFileSync(join(env.memDir, 'back.md'), 'x')
    await until(() => events.some((e) => e.name === 'back.md'))
  })

  it('an agent registered after start gets watched on the next resync', async () => {
    const env = setup()
    const events: KnowsEvent[] = []
    closer = startKnowsWatcher({
      registry: env.registry,
      broadcast: (e) => {
        events.push(e)
      },
      home: env.home,
      projectsRoot: env.projectsRoot,
      dataDir: env.dataDir,
      debounceMs: 50,
      resyncMs: 100,
    })
    await closer!.ready // chokidar scanned the anchors
    const folder2 = join(env.folder, '..', 'proj2')
    mkdirSync(folder2)
    env.registry.create({ id: 'finance', name: 'FINANCE', folder: folder2 })
    await sleep(400)
    writeFileSync(join(folder2, 'CLAUDE.md'), 'p2')
    await until(() => events.some((e) => e.folder === folder2))
    expect(events.find((e) => e.folder === folder2)).toMatchObject({ kind: 'memory', scope: 'project', name: 'CLAUDE.md' })
  })

  it('writing <folder>/plans/x.plan.json emits ONE coalesced plans event with folder and name', async () => {
    const env = setup()
    mkdirSync(join(env.folder, 'plans'), { recursive: true })
    const events = start(env) // default debounce (300 ms)
    await closer!.ready // chokidar scanned the anchors

    writeFileSync(join(env.folder, 'plans', 'x.plan.json'), '{"tasks":[]}')
    await sleep(20)
    writeFileSync(join(env.folder, 'plans', 'x.plan.json'), '{"tasks":[{"id":"t1"}]}')
    await until(() => events.length > 0)
    await sleep(500)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'knows', kind: 'plans', folder: env.folder, name: 'x.plan.json' })
    expect(events[0]?.agentId).toBeUndefined()
  })

  it('a plans/ dir created after start is picked up', async () => {
    const env = setup()
    const events = start(env, 50)
    await closer!.ready // chokidar scanned the anchors
    mkdirSync(join(env.folder, 'plans'))
    await sleep(200)
    writeFileSync(join(env.folder, 'plans', 'late.plan.json'), '{}')
    await until(() => events.some((e) => e.kind === 'plans'))
    expect(events.find((e) => e.kind === 'plans')).toMatchObject({ folder: env.folder, name: 'late.plan.json', action: 'added' })
  })

  it('a non-plan file in plans/ emits nothing', async () => {
    const env = setup()
    mkdirSync(join(env.folder, 'plans'), { recursive: true })
    const events = start(env, 50)
    await closer!.ready // chokidar scanned the anchors
    writeFileSync(join(env.folder, 'plans', 'notes.md'), 'x')
    writeFileSync(join(env.folder, 'plans', 'x.json'), '{}')
    mkdirSync(join(env.folder, 'plans', 'sub'))
    writeFileSync(join(env.folder, 'plans', 'sub', 'y.plan.json'), '{}')
    // sentinel of another (kind, folder): once it is out, the rest would be
    writeFileSync(join(env.folder, 'CLAUDE.md'), 'p')
    await until(() => events.length > 0)
    expect(events.map((e) => e.kind)).toEqual(['memory'])
  })

  it('every territory of an agent gets its plans/ watched', async () => {
    const env = setup()
    const second = join(env.folder, '..', 'second')
    mkdirSync(join(second, 'plans'), { recursive: true })
    env.registry.update('builder', { folders: [second] } as never)
    const events = start(env, 50)
    await closer!.ready // chokidar scanned the anchors
    writeFileSync(join(second, 'plans', 's.plan.json'), '{}')
    await until(() => events.some((e) => e.kind === 'plans'))
    expect(events.find((e) => e.kind === 'plans')).toMatchObject({ folder: second, name: 's.plan.json' })
  })

  it('a context/<id> dir in a secondary territory is watched', async () => {
    const env = setup()
    const second = join(env.folder, '..', 'second-ctx')
    mkdirSync(join(second, 'context', 'builder'), { recursive: true })
    env.registry.update('builder', { folders: [second] })
    const events = start(env, 50)
    await closer!.ready // chokidar scanned the anchors
    writeFileSync(join(second, 'context', 'builder', 'brief.md'), 'x')
    await until(() => events.some((e) => e.kind === 'context'))
    expect(events.find((e) => e.kind === 'context')).toMatchObject({ folder: second, agentId: 'builder', name: 'brief.md' })
  })

  it('the plans event folder is normalised (no trailing slash, no ..)', async () => {
    const env = setup()
    const second = join(env.folder, '..', 'second-norm')
    mkdirSync(join(second, 'plans'), { recursive: true })
    const raw = `${env.folder}/../second-norm/`
    const agents = env.registry.list().map((a) => (a.id === 'builder' ? { ...a, folders: [raw] } : a))
    const fake = { list: () => agents } as unknown as AgentRegistry
    const events: KnowsEvent[] = []
    closer = startKnowsWatcher({
      registry: fake,
      broadcast: (e) => {
        events.push(e)
      },
      home: env.home,
      projectsRoot: env.projectsRoot,
      dataDir: env.dataDir,
      debounceMs: 50,
    })
    await closer!.ready // chokidar scanned the anchors
    writeFileSync(join(second, 'plans', 'n.plan.json'), '{}')
    await until(() => events.some((e) => e.kind === 'plans'))
    expect(events.find((e) => e.kind === 'plans')).toMatchObject({ folder: second, name: 'n.plan.json' })
  })

  it('close() stops everything: no event after it resolves', async () => {
    const env = setup({ withMemoryDir: true })
    const events = start(env, 50)
    await closer!.ready // chokidar scanned the anchors
    await closer!.close()
    closer = null

    writeFileSync(join(env.memDir, 'after.md'), 'x')
    await sleep(400)
    expect(events).toEqual([])
  })

  // A missing root must never anchor the watch at some broad ancestor: with
  // a home directly under /tmp the nearest existing ancestor was /tmp itself
  // (1.37M entries) and the process ran out of memory in ~5 min. Each target
  // is anchored at most at its own root (territory, projects root, data dir,
  // ~/.claude); a missing root watches nothing until a resync finds it.
  it('a missing root watches nothing above it, and is picked up once it appears', async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-knows-missing-'))
    // siblings the old nearest-ancestor walk would have crawled
    for (let i = 0; i < 5; i++) mkdirSync(join(base, `noise-${i}`))
    const home = join(base, 'home') // missing
    const projectsRoot = join(home, '.claude', 'projects')
    const dataDir = join(base, 'data') // missing
    const folder = join(base, 'proj')
    mkdirSync(folder)
    const registry = new AgentRegistry(join(base, 'agents.json'))
    registry.load()
    registry.create({ id: 'builder', name: 'BUILDER', folder })
    const events: KnowsEvent[] = []
    const w = startKnowsWatcher({
      registry,
      broadcast: (e) => {
        events.push(e)
      },
      home,
      projectsRoot,
      dataDir,
      debounceMs: 50,
      resyncMs: 100,
    })
    closer = w
    await closer!.ready // chokidar scanned the anchors
    for (const a of w.anchors()) {
      expect(a === folder || a.startsWith(folder + '/'), `anchored outside its root: ${a}`).toBe(true)
    }
    expect(w.anchors()).not.toContain(base)

    mkdirSync(join(home, '.claude'), { recursive: true })
    await sleep(400) // a resync finds the root
    expect(w.anchors()).toContain(join(home, '.claude'))
    expect(w.anchors()).not.toContain(base)
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'g')
    await until(() => events.some((e) => e.scope === 'global'))
    rmSync(base, { recursive: true, force: true })
  })
})

describe('anchorFor', () => {
  it('the target if it exists, else its nearest existing ancestor no higher than its root, else nothing', () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-knows-anchor-'))
    const root = join(base, 'root')
    expect(anchorFor(join(root, 'a', 'b'), root)).toBeNull() // the root itself is missing
    mkdirSync(join(root, 'a'), { recursive: true })
    expect(anchorFor(join(root, 'a', 'b', 'c'), root)).toBe(join(root, 'a'))
    expect(anchorFor(join(root, 'x'), root)).toBe(root)
    mkdirSync(join(root, 'a', 'b'))
    expect(anchorFor(join(root, 'a', 'b'), root)).toBe(join(root, 'a', 'b'))
    // a target outside its root never climbs past it
    expect(anchorFor(join(base, 'elsewhere', 'f'), root)).toBeNull()
    rmSync(base, { recursive: true, force: true })
  })
})
