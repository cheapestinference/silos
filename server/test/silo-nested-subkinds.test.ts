// Nested sub-kinds, depth ≤ 2 (plans phase 1, G1): a sub-kind may declare its
// own sub-kinds — a task's notes[] and conversations[] — read, keyed, lifted,
// evaluated, journaled and appended to exactly like a record's children, one
// level further. A third level is refused by the validator in plain words.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dictionaryForKind, evaluate, parse } from '../src/silos/expressions.js'
import { readRecordValue, SiloReader } from '../src/silos/reader.js'
import { kindsOf, recordsOfKind, type KindRecord } from '../src/silos/voice.js'
import { observationsOf } from '../src/silos/journal.js'
import { validateSilo } from '../src/silos/validator.js'
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { TransitionJournal } from '../src/silos/journal.js'
import { OverlayStore } from '../src/silos/overlay.js'
import { SiloActions, SiloAcks, SiloEvents, SiloProposals } from '../src/silos/actions.js'

type Json = Record<string, any>

// a plan-like silo whose task carries notes[] (appendOnly) and conversations[]
function manifest(): Json {
  return {
    apiVersion: 'silo-standard/v0',
    metadata: { id: 'nested', version: '0.1.0', name: 'Nested', description: 'nested sub-kinds fixture' },
    spec: {
      producer: { role: 'writer', instructions: { summary: 'writes plans', protocol: ['one file per plan'] } },
      sources: [{ id: 'plans', type: 'files', root: 'project', glob: 'nested/*.plan.json', parser: 'json', expects: { producer: 'agent' } }],
      kinds: {
        plan: {
          envelope: {
            id: { from: 'filename' },
            identity: { template: '{{title}}' },
            state: { computed: 'all(tasks, state = done) ? closed : open' },
            at: { field: 'updatedAt' },
            anchors: [{ hub: 'folder', from: 'location' }],
            updatedBy: { absent: 'unknown' },
          },
          states: [
            { value: 'open', label: { one: 'open', many: 'open' } },
            { value: 'closed', label: { one: 'closed', many: 'closed' }, terminal: true },
          ],
          fields: { title: { type: 'string', required: true }, updatedAt: { type: 'timestamp', required: true }, status: { type: 'string', optional: true } },
          unknownFields: 'preserve',
          subKinds: {
            task: {
              path: 'tasks[]',
              envelope: {
                id: { field: 'id' },
                identity: { template: '{{title}}' },
                state: { field: 'status' },
                at: { inherit: 'parent.at' },
                updatedBy: { absent: 'unknown' },
              },
              states: [
                { value: 'pending', label: { one: 'pending', many: 'pending' } },
                { value: 'done', label: { one: 'done', many: 'done' }, terminal: true },
              ],
              fields: { owner: { type: 'actor', required: true } },
              computed: { noted: "all(notes, text startsWith 'ok')" },
              subKinds: {
                note: {
                  path: 'notes[]',
                  appendOnly: true,
                  writeMerge: 'union(at,by,text) ordered by at',
                  envelope: {
                    identity: { template: '{{text}}' },
                    at: { field: 'at', mayBeEmpty: true },
                    updatedBy: { field: 'by', values: ['agent', 'owner'] },
                  },
                  fields: { text: { type: 'string', required: true, max: 2000 } },
                  lift: { when: 'notes as a string (or the loose note field)', synthesize: { at: '', by: 'agent', text: '{{the string || note}}' } },
                },
                conversation: {
                  path: 'conversations[]',
                  envelope: { id: { field: 'session' }, identity: { template: '{{session}}' } },
                  fields: { session: { type: 'string', required: true } },
                  lift: { when: 'a string, or the loose conversation field', synthesize: { session: '{{the string || conversation}}' } },
                },
              },
            },
          },
          examples: [
            {
              _file: 'a.plan.json',
              title: 'A',
              updatedAt: '2026-11-01',
              tasks: [{ id: 't1', title: 'one', owner: 'writer', status: 'pending', notes: 'ok — a string note' }],
            },
          ],
        },
      },
      surfaces: {},
      actions: [{ verb: 'append-item', subKind: 'plan/task/note', by: ['owner', 'producer'] }, { verb: 'open' }],
    },
  }
}

const read = (value: Json) => readRecordValue(manifest(), 'plan', value, 'p1', { now: Date.parse('2026-11-03T12:00:00Z'), isAgent: (v) => v === 'writer' })
const plan = (tasks: Json[]): Json => ({ title: 'P', updatedAt: '2026-11-01', tasks })

describe('dictionary and kinds, depth 2', () => {
  it("the task's collections are in its dictionary; kindsOf names plan/task/note", () => {
    const { dict, issues } = dictionaryForKind('plan', manifest().spec.kinds.plan)
    expect(issues).toEqual([])
    expect(Object.keys(dict.collections.tasks!.collections)).toEqual(['notes', 'conversations'])
    expect(dict.collections.tasks!.collections.notes!.kind).toBe('plan/task/note')
    expect(dict.collections.tasks!.collections.notes!.parent).toBe(dict.collections.tasks)
    const kinds = kindsOf(manifest())
    expect([...kinds.keys()]).toEqual(['plan', 'plan/task', 'plan/task/note', 'plan/task/conversation'])
    expect(kinds.get('plan/task/note')!.parent!.name).toBe('plan/task')
    expect(kinds.get('plan/task/note')!.coll).toBe('notes')
  })
})

describe('the reader, depth 2', () => {
  it('reads explicit notes and conversations under each task', () => {
    const b = read(
      plan([
        {
          id: 't1',
          title: 'one',
          owner: 'writer',
          status: 'pending',
          notes: [{ at: '2026-11-02', by: 'owner', text: 'ok go' }],
          conversations: [{ session: 'abc12345-0000' }],
        },
      ]),
    )
    expect(b.ok).toBe(true)
    if (!b.ok) return
    const t1 = (b.record.tasks as Json[])[0]!
    expect(t1.notes).toEqual([expect.objectContaining({ id: '0', identity: 'ok go', at: '2026-11-02', updatedBy: 'owner', text: 'ok go' })])
    expect(t1.conversations).toEqual([expect.objectContaining({ id: 'abc12345-0000', session: 'abc12345-0000' })])
  })

  it('lifts: notes as a string, a string item, the singular note, a loose conversation, a list of session strings', () => {
    const b = read(
      plan([
        { id: 't1', title: 'one', owner: 'writer', status: 'pending', notes: 'ok — written as a string', conversation: 'sess-0001-aaaa' },
        {
          id: 't2',
          title: 'two',
          owner: 'writer',
          status: 'pending',
          notes: ['first', { at: '', by: 'owner', text: 'second' }],
          conversations: ['sess-0002-bbbb', 'sess-0003-cccc'],
        },
        { id: 't3', title: 'three', owner: 'writer', status: 'done', note: 'Dropped: the singular field' },
        { id: 't4', title: 'four', owner: 'writer', status: 'pending' },
      ]),
    )
    expect(b.ok).toBe(true)
    if (!b.ok) return
    const [t1, t2, t3, t4] = b.record.tasks as Json[]
    expect(t1!.notes.map((n: Json) => [n.text, n.updatedBy, n.at])).toEqual([['ok — written as a string', 'agent', '']])
    expect(t1!.conversations.map((c: Json) => c.id)).toEqual(['sess-0001-aaaa'])
    expect(t2!.notes.map((n: Json) => [n.text, n.updatedBy])).toEqual([
      ['first', 'agent'],
      ['second', 'owner'],
    ])
    expect(t2!.conversations.map((c: Json) => c.id)).toEqual(['sess-0002-bbbb', 'sess-0003-cccc'])
    expect(t3!.notes.map((n: Json) => n.text)).toEqual(['Dropped: the singular field'])
    expect(t4!.notes).toEqual([])
    expect(t4!.conversations).toEqual([])
  })

  it("a note that can't be read never takes its task down: the task reads, the plan's remarks name it, all() over the partial notes is false", () => {
    const b = read(plan([{ id: 't1', title: 'one', owner: 'writer', status: 'pending', notes: [{ text: 'ok fine' }, { by: 'agent' }] }]))
    expect(b.ok).toBe(true)
    if (!b.ok) return
    const t1 = (b.record.tasks as Json[])[0]!
    expect(t1.notes.map((n: Json) => n.text)).toEqual(['ok fine'])
    expect(b.remarks).toEqual(['tasks[0] (t1): notes[1] is not read: missing text'])
    expect(t1.noted).toBe(false) // the second note might not start with ok — never vouched for
  })

  it("a computed over the task's notes (all at depth 2) evaluates", () => {
    const b = read(
      plan([
        { id: 't1', title: 'one', owner: 'writer', status: 'pending', notes: ['ok a', 'ok b'] },
        { id: 't2', title: 'two', owner: 'writer', status: 'pending', notes: ['ok', 'no'] },
      ]),
    )
    if (!b.ok) throw new Error(b.reason)
    expect((b.record.tasks as Json[]).map((t) => t.noted)).toEqual([true, false])
  })

  it('recordsOfKind keys a note <plan key>/tasks/<task>/notes/<index>, with its task as parent', () => {
    const b = read(plan([{ id: 't1', title: 'one', owner: 'writer', status: 'pending', notes: ['x', 'y'] }]))
    if (!b.ok) throw new Error(b.reason)
    const kinds = kindsOf(manifest())
    const base: KindRecord[] = [{ rec: b.record, anchors: { folder: '/w' }, key: 'folder:/w/p1', file: '/w/nested/p1.plan.json' }]
    const notes = recordsOfKind(kinds, base, 'plan/task/note')
    expect(notes.map((n) => n.key)).toEqual(['folder:/w/p1/tasks/t1/notes/0', 'folder:/w/p1/tasks/t1/notes/1'])
    expect(notes[0]!.parent!.id).toBe('t1')
    expect(notes[0]!.file).toBe('/w/nested/p1.plan.json')
    // a predicate over a note reads its own fields and its parent (the task)
    const ast = parse("text = 'y' and parent.owner = writer").ok ? (parse("text = 'y' and parent.owner = writer") as { ast: never }).ast : null
    expect(evaluate(ast!, notes[1]!.rec, { now: 0, dict: kinds.get('plan/task/note')!.dict, parent: notes[1]!.parent })).toBe(true)
  })
})

describe('the journal sees state-bearing children at depth 2', () => {
  it('a grandchild with a state is an observation keyed under its task', () => {
    const m = manifest()
    m.spec.kinds.plan.subKinds.task.subKinds.note.envelope.state = { field: 'kind' }
    m.spec.kinds.plan.subKinds.task.subKinds.note.states = [
      { value: 'open', label: { one: 'open', many: 'open' } },
      { value: 'shut', label: { one: 'shut', many: 'shut' }, terminal: true },
    ]
    const b = readRecordValue(
      m,
      'plan',
      plan([{ id: 't1', title: 'one', owner: 'writer', status: 'pending', notes: [{ text: 'ok', kind: 'shut', by: 'agent', at: '' }] }]),
      'p1',
    )
    if (!b.ok) throw new Error(b.reason)
    const reading = {
      records: [
        {
          silo: 'nested',
          kind: 'plan',
          source: 'plans',
          file: '/w/nested/p1.plan.json',
          rel: 'nested/p1.plan.json',
          location: 'folder:/w',
          anchors: {},
          mtimeMs: 0,
          raw: {},
          record: b.record,
          remarks: [],
          partial: [],
        },
      ],
      unreadable: [],
      lastWrite: null,
      sources: {},
      truncated: [],
      problems: [],
    }
    const obs = observationsOf('nested', m, reading as never, [
      { source: 'plans', convention: 'project:nested/*.plan.json', dir: '/conv', root: 'project', glob: 'nested/*.plan.json' } as never,
    ])
    expect(obs.observations[0]!.entries.map((e) => [e.key, e.kind, e.state, e.terminal])).toEqual([
      ['folder:/w/p1', 'plan', 'open', false],
      ['folder:/w/p1/tasks/t1', 'plan/task', 'pending', false],
      ['folder:/w/p1/tasks/t1/notes/0', 'plan/task/note', 'shut', true],
    ])
  })
})

describe('the validator: two levels, never three', () => {
  it('the fixture validates', () => {
    const r = validateSilo(manifest())
    expect(r.errors).toEqual([])
  })
  it('a third level is refused in plain words', () => {
    const m = manifest()
    m.spec.kinds.plan.subKinds.task.subKinds.note.subKinds = {
      word: { path: 'words[]', envelope: { identity: { template: '{{w}}' } }, fields: { w: { type: 'string', required: true } } },
    }
    const r = validateSilo(m)
    expect(r.errors).toContainEqual(
      expect.objectContaining({ where: 'spec.kinds.plan.subKinds.task.subKinds.note.subKinds.word', message: expect.stringContaining('two levels') }),
    )
  })
})

describe('append-item at depth 2: the owner adds a note to a task', () => {
  let base: string
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'silo-nested-'))
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  function setup() {
    const dataDir = join(base, 'data')
    mkdirSync(join(dataDir, 'silos', 'registry', 'nested'), { recursive: true })
    writeFileSync(join(dataDir, 'silos', 'registry', 'nested', 'silo.json'), JSON.stringify(manifest()))
    const registry = new SiloRegistry({ dataDir, operator: { decisionFor: () => 'approved', slotsOff: () => [] } })
    registry.load()
    const isAgent = (v: string): boolean => v === 'writer'
    const kernel = new SiloKernel({
      registry,
      journal: new TransitionJournal(registry.conventionsDir),
      overlay: new OverlayStore(registry.conventionsDir),
      isAgent,
      reader: new SiloReader({ agentStates: () => [], projects: () => [join(base, 'proj')] }),
    })
    const actions = new SiloActions({
      registry,
      kernel,
      events: new SiloEvents(registry.root),
      acks: new SiloAcks(registry.root),
      proposals: new SiloProposals(registry.root),
      agentStateBase: join(dataDir, 'agent-state'),
      isAgent,
      agentMayReadLocation: () => false,
    })
    return { kernel, actions }
  }
  function put(v: Json): string {
    const f = join(base, 'proj', 'nested', 'p1.plan.json')
    mkdirSync(join(f, '..'), { recursive: true })
    writeFileSync(f, JSON.stringify(v, null, 2))
    return f
  }
  const key = (): string => `folder:${join(base, 'proj')}/p1/tasks/t1`

  it("materializes the string note as the agent's, appends the owner's (at = now, by = owner), keeps every other field", () => {
    const f = put({
      ...plan([
        { id: 't1', title: 'one', owner: 'writer', status: 'pending', notes: 'agent wrote this', extra: 1 },
        { id: 't2', title: 'two', owner: 'writer', status: 'pending' },
      ]),
      context: 'kept',
    })
    const { kernel, actions } = setup()
    kernel.refresh()
    const r = actions.appendItem('nested', key(), 'notes', { text: '  go ahead  ', by: 'agent' })
    expect(r.ok).toBe(true)
    const raw = JSON.parse(readFileSync(f, 'utf8'))
    expect(raw.context).toBe('kept')
    expect(raw.tasks[0].extra).toBe(1)
    expect(raw.tasks[0].notes).toEqual([
      { at: '', by: 'agent', text: 'agent wrote this' },
      { text: 'go ahead', at: expect.stringMatching(/^\d{4}-/), by: 'owner' },
    ])
    expect(raw.tasks[1]).toEqual({ id: 't2', title: 'two', owner: 'writer', status: 'pending' })
  })

  it('refuses a key that is no task, and a collection the task has no append for', () => {
    put(plan([{ id: 't1', title: 'one', owner: 'writer', status: 'pending' }]))
    const { kernel, actions } = setup()
    kernel.refresh()
    expect(actions.appendItem('nested', `folder:${join(base, 'proj')}/p1/tasks/nope`, 'notes', { text: 'x' })).toMatchObject({ ok: false, code: 404 })
    expect(actions.appendItem('nested', key(), 'conversations', { session: 'x' })).toMatchObject({ ok: false, code: 403 })
  })
})
