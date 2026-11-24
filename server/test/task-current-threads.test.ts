// task-current-threads.test.ts — the pure halves of the
// task-conversation rules: which of a task's conversations are CURRENT (releases[], one rule
// of validity by position, grouped by thread), the door's continuable tip,
// an OpenCode console key and its sealed id as ONE thread, the stall
// fingerprint, the briefing's last line, and the native-bound listing.
// Generic fixtures only.
import { describe, expect, it } from 'vitest'
import { currentConversationIdsOf, releasesOf, taskThreads, threadMembership } from '../src/task-threads.js'
import { fingerprintOf, type TaskSnap } from '../src/task-mode/evaluate.js'
import { claimBriefing, DISPOSITION_BOUND, DISPOSITION_UNBOUND, workBriefing } from '../src/task-mode/briefing.js'
import { bindNativeOnTasks, nativeBindPass } from '../src/task-native-bind.js'
import { taskLive, taskFlow, type TaskEnv } from '../src/silos/task-flow.js'
import type { LineageStore } from '../src/lineage.js'
import type { SessionMeta } from '../src/types.js'

const T0 = Date.parse('2026-11-08T09:00:00Z')
const MIN = 60_000
const meta = (id: string, mtime: number): SessionMeta => ({ id, folder: 'proj', title: 'T', skills: [], cwd: null, mtime, size: 10, turnCount: 1 })
const lineageOf = (parents: Record<string, string>): LineageStore =>
  ({ parentIdOf: (id: string) => parents[id] ?? null, continuationParentIdOf: (id: string) => parents[id] ?? null }) as unknown as LineageStore

describe('current conversations — one rule of validity (R13)', () => {
  const member = threadMembership([meta('anc', T0 - 10 * MIN), meta('tip', T0)], lineageOf({ tip: 'anc' }))

  it('no releases: every listed id is current', () => {
    expect(currentConversationIdsOf({ conversations: ['anc', 'other'] }, member)).toEqual(['anc', 'other'])
  })
  it('the LAST mark of a thread decides, by position: true → history, false → current', () => {
    expect(currentConversationIdsOf({ conversations: ['anc', 'other'], releases: [{ session: 'anc', released: true }] }, member)).toEqual(['other'])
    expect(
      currentConversationIdsOf(
        {
          conversations: ['anc'],
          releases: [
            { session: 'anc', released: true },
            { session: 'anc', released: false },
          ],
        },
        member,
      ),
    ).toEqual(['anc'])
    expect(
      currentConversationIdsOf(
        {
          conversations: ['anc'],
          releases: [
            { session: 'anc', released: false },
            { session: 'anc', released: true },
          ],
        },
        member,
      ),
    ).toEqual([])
  })
  it('/clear: the rotation shares the thread — a release named by the rotation lets the listed ancestor go', () => {
    expect(currentConversationIdsOf({ conversations: ['anc'], releases: [{ session: 'tip', released: true }] }, member)).toEqual([])
  })
  it('marks on no listed thread are ignored; a malformed mark is not one', () => {
    expect(
      currentConversationIdsOf(
        { conversations: ['anc'], releases: [{ session: 'elsewhere', released: true }, { session: 'anc', released: 'yes' }, 'anc'] },
        member,
      ),
    ).toEqual(['anc'])
    expect(releasesOf([{ session: 'a', released: true, at: 'x', by: 'writer' }, { session: '', released: true }, null])).toEqual([
      { session: 'a', released: true },
    ])
  })
  it('a hand-written {session, released: false} without at revives the thread', () => {
    expect(
      currentConversationIdsOf(
        {
          conversations: ['anc'],
          releases: [
            { session: 'anc', released: true, at: '2026-11-08T08:00:00Z', by: 'writer' },
            { session: 'anc', released: false },
          ],
        },
        member,
      ),
    ).toEqual(['anc'])
  })
})

describe('an OpenCode console key and its sealed id are ONE thread (nativeIdOf)', () => {
  const nativeIdOf = (id: string): string | null => (id === 'key-0001' ? 'ses_0001' : null)
  const threads = taskThreads({ metas: [meta('ses_0001', T0)], lineage: null, ownerOf: () => 'writer', nativeIdOf })
  it('the key and the ses_ share threadKey', () => {
    expect(threads.threadKey('key-0001')).toBe(threads.threadKey('ses_0001'))
  })
  it('listed key → sealed → release: neither the key nor the ses_ is a holder; the wakes are not held', () => {
    const listed = ['key-0001', 'ses_0001']
    expect(threads.holdersOf('writer', threads.currentOf(listed, undefined)).sort()).toEqual(['key-0001', 'ses_0001'])
    const current = threads.currentOf(listed, [{ session: 'key-0001', released: true }])
    expect(current).toEqual([])
    expect(threads.holdersOf('writer', current)).toEqual([])
    expect(threads.tipOf('writer', current)).toBeNull()
  })
  it("without nativeIdOf, an id is its own (today's tests unchanged)", () => {
    const plain = taskThreads({ metas: [meta('ses_0001', T0)], lineage: null, ownerOf: () => 'writer' })
    expect(plain.threadKey('key-0001')).not.toBe(plain.threadKey('ses_0001'))
  })
})

describe("the door's tip: the newest CONTINUABLE member (R5)", () => {
  // a run is transcriptOnly; the door, /work, the wakes and /talk never resume one
  const runs = new Set(['run-auto', 'run-nested'])
  const continuable = (m: SessionMeta): boolean => !runs.has(m.id)
  const threadsOf = (ids: Array<[string, number]>) =>
    taskThreads({ metas: ids.map(([id, t]) => meta(id, t)), lineage: null, ownerOf: () => 'writer', continuable })
  it('1 · a normal tip is the newest', () => {
    expect(
      threadsOf([
        ['a', T0 - MIN],
        ['b', T0],
      ]).tipOf('writer', ['a', 'b']),
    ).toEqual({ sessionId: 'b', folder: 'proj' })
  })
  it('2 · a tip that is an automation run: the conversation before it', () => {
    expect(
      threadsOf([
        ['a', T0 - MIN],
        ['run-auto', T0],
      ]).tipOf('writer', ['a', 'run-auto'])?.sessionId,
    ).toBe('a')
  })
  it('3 · a tip that is a nested run: the conversation before it', () => {
    expect(
      threadsOf([
        ['a', T0 - MIN],
        ['run-nested', T0],
      ]).tipOf('writer', ['a', 'run-nested'])?.sessionId,
    ).toBe('a')
  })
  it('4 · only a run: nothing to continue (the door starts one)', () => {
    expect(threadsOf([['run-auto', T0]]).tipOf('writer', ['run-auto'])).toBeNull()
  })
  it('5 · a message conversation is continuable', () => {
    expect(threadsOf([['msg-0001', T0]]).tipOf('writer', ['msg-0001'])?.sessionId).toBe('msg-0001')
  })
  it('a run is still a member: a holder, and live', () => {
    const th = threadsOf([
      ['a', T0 - MIN],
      ['run-auto', T0],
    ])
    expect(th.holdersOf('writer', ['a', 'run-auto']).sort()).toEqual(['a', 'run-auto'])
    expect(th.anyLive(['a', 'run-auto'], (id) => id === 'run-auto')).toBe(true)
  })
  it("a wake after /clear goes to the rotation (the listed ancestor's tip)", () => {
    const th = taskThreads({
      metas: [meta('anc', T0 - MIN), meta('tip', T0)],
      lineage: lineageOf({ tip: 'anc' }),
      ownerOf: () => 'writer',
      continuable: () => true,
    })
    expect(th.tipOf('writer', ['anc'])?.sessionId).toBe('tip')
  })
})

describe('task-flow and turn read the CURRENT conversations', () => {
  it('taskLive asks only the current ids; currentConversations rides the flow', () => {
    const env: TaskEnv = {
      isLive: (id) => id === 'old',
      wakes: () => 'never',
      currentOf: (listed, rel) => (Array.isArray(rel) && rel.length > 0 ? listed.filter((x) => x !== 'old') : listed),
    }
    expect(taskLive(env, ['old'], undefined)).toBe(true)
    expect(taskLive(env, ['old'], [{ session: 'old', released: true }])).toBe(false)
    const dict = { task: { owner: 'owner', dependsOn: 'dependsOn', conversations: 'conversations', releases: 'releases' } }
    const t = { id: 't1', state: 'in_progress', owner: 'writer', dependsOn: [], conversations: ['old', 'new'], releases: [{ session: 'old', released: true }] }
    expect(taskFlow(t, [t], dict, { now: T0, taskEnv: env }).currentConversations).toEqual(['new'])
    // no currentOf on the env: every listed id
    expect(taskFlow(t, [t], dict, { now: T0, taskEnv: { isLive: () => false, wakes: () => 'never' } }).currentConversations).toEqual(['old', 'new'])
  })
})

describe('the stall fingerprint (fingerprintOf) and releases', () => {
  const snap = (over: Partial<TaskSnap> = {}): TaskSnap => ({
    key: 'k',
    planKey: 'p',
    planId: 'p',
    id: 't1',
    ref: 'p#t1',
    title: 'T',
    owner: 'writer',
    state: 'in_progress',
    dependsOn: [],
    parent: null,
    nextCheckAt: null,
    waitingOn: false,
    waitingFor: null,
    stalledCause: null,
    stalledBy: null,
    stalledAt: null,
    notes: [],
    conversations: ['a'],
    current: ['a'],
    file: null,
    folder: null,
    ...over,
  })
  it('a task without releases keeps its fingerprint byte for byte', () => {
    const t = snap()
    expect(fingerprintOf(t, [t])).toBe(JSON.stringify(['in_progress', 0, [], [], false, null, 1]))
  })
  it('one with releases changes when it is released and when it is revived', () => {
    const before = snap()
    const released = snap({ releases: [{ session: 'a', released: true }] })
    const revived = snap({
      releases: [
        { session: 'a', released: true },
        { session: 'a', released: false },
      ],
    })
    const fps = [before, released, revived].map((t) => fingerprintOf(t, [t]))
    expect(new Set(fps).size).toBe(3)
    expect(fps[1]!.endsWith(',["releases",["a:released"]]]')).toBe(true)
  })
})

describe("the briefing's close (R6): only the LAST line changes", () => {
  const t = { ref: 'p#t1', title: 'T', file: '/p/plans/p.plan.json', id: 't1', state: 'pending', notes: [] }
  it('the first line is identical with and without bound; the last says the dispositions when unbound', () => {
    const b = workBriefing(t, [], (x) => x, { bound: true }).split('\n')
    const u = workBriefing(t, [], (x) => x, { bound: false }).split('\n')
    expect(u[0]).toBe(b[0])
    expect(b.at(-1)).toBe(DISPOSITION_BOUND)
    expect(u.at(-1)).toBe(DISPOSITION_UNBOUND)
    const cb = claimBriefing(t, [], { linked: true, tookOver: false, bound: true }).split('\n')
    const cu = claimBriefing(t, [], { linked: true, tookOver: false, bound: false }).split('\n')
    expect(cu[0]).toBe(cb[0])
    expect(cu.at(-1)).toBe(DISPOSITION_UNBOUND)
  })
  it('a claim folds the wakes that waited for it', () => {
    const text = claimBriefing(t, [], {
      linked: true,
      tookOver: false,
      bound: true,
      queued: [{ says: 'a note from the owner', notes: [{ at: 'x', by: 'owner', text: 'check the log' }] }],
    })
    expect(text).toContain('Waiting for you on it: a note from the owner.')
    expect(text).toContain('check the log')
  })
})

describe('native-bound: a console key listed before the seal gets its id listed', () => {
  it('on the event: the tasks listing the key gain the id; nothing for key = id or an id already there', () => {
    const appended: Array<[string, string]> = []
    const tasks = [
      { key: 'k1', conversations: ['key-0001'] },
      { key: 'k2', conversations: ['key-0001', 'ses_0001'] },
      { key: 'k3', conversations: ['other'] },
    ]
    expect(bindNativeOnTasks(tasks, 'key-0001', 'ses_0001', (k, id) => appended.push([k, id]))).toEqual(['k1'])
    expect(appended).toEqual([['k1', 'ses_0001']])
    expect(
      bindNativeOnTasks(tasks, 'ses_0001', 'ses_0001', () => {
        throw new Error('never')
      }),
    ).toEqual([])
  })
  it('the one pass after a restart lists every sealed id not yet listed', () => {
    const appended: Array<[string, string]> = []
    const n = nativeBindPass(
      [
        { key: 'k1', conversations: ['key-0001'] },
        { key: 'k2', conversations: ['key-0002', 'ses_0002'] },
      ],
      (k) => ({ 'key-0001': 'ses_0001', 'key-0002': 'ses_0002' })[k] ?? null,
      (k, id) => appended.push([k, id]),
    )
    expect(n).toBe(1)
    expect(appended).toEqual([['k1', 'ses_0001']])
  })
})
