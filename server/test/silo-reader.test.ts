// The declarative reader of `files` sources (Silo Standard step 1, Task 3):
// confinement, expansion by root class, the full envelope with declared
// absences, aliases, lift, sub-kinds, computed-at-read, and the explain of
// every unreadable record. Fixtures: the reference manifests' own examples
// and synthetic files written to a temp dir — never real data.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SiloReader, exampleFileId, parseFile, readRecordValue, renderTemplate } from '../src/silos/reader.js'
import { confineGlob, scanSource, stemOf, type SiloLocations } from '../src/silos/files-source.js'
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { siloManifest } from './helpers/silo-manifests.js'

type Json = Record<string, any>
const ref = (id: string): Json => siloManifest(id) as Json
const REFS = ['support', 'plans', 'invoices', 'documents']
const NOW = Date.parse('2026-10-30T12:00:00Z')
const isAgent = (v: string): boolean => ['finance', 'writer', 'support'].includes(v)

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'silo-reader-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

// temp agent-state (<base>/agent-state/<agent>/) and project folders (<base>/p/<name>)
function locations(agents: string[] = [], projects: string[] = []): SiloLocations {
  return {
    agentStates: () => agents.map((a) => ({ agentId: a, dir: join(base, 'agent-state', a) })),
    projects: () => projects.map((p) => join(base, 'p', p)),
  }
}
function write(rel: string, content: unknown): string {
  const file = join(base, rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  return file
}

describe('every example of the four reference manifests produces a valid envelope', () => {
  for (const id of REFS) {
    const m = ref(id)
    for (const [kind, spec] of Object.entries<Json>(m.spec.kinds)) {
      for (const [i, ex] of spec.examples.entries()) {
        it(`${id}/${kind} example ${i}`, () => {
          const r = readRecordValue(m, kind, ex, exampleFileId(m, kind, ex), { now: NOW, isAgent })
          if (!r.ok) throw new Error(r.reason)
          expect(r.record.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
          // support: a case with an empty summary stays blank
          if (id === 'support') expect(r.record.identity).toBe((r.record as Json).summary)
          else expect(r.record.identity).not.toBe('')
          expect(spec.states.map((s: Json) => s.value)).toContain(r.record.state)
          expect(r.record.stateLabel).toBeTruthy()
        })
      }
    }
  }
})

describe('support — the explain of a broken case names the field, exactly', () => {
  const m = ref('support')
  const canonical = m.spec.kinds.case.examples[0]
  const freehand = m.spec.kinds.case.examples[1]
  const read = (v: unknown, id = 'canonical-case'): string | null => {
    const r = readRecordValue(m, 'case', v, id, { now: NOW })
    return r.ok ? null : r.reason
  }
  // conformance.md, the suite: customerEmail removed, an invalid status
  it('without customerEmail', () => {
    const { customerEmail: _drop, ...rest } = canonical
    expect(read(rest)).toBe('missing customerEmail')
  })
  it('an invalid status', () => {
    expect(read({ ...canonical, status: 'pending' })).toBe('status "pending" is not one of new/needs_owner/draft_ready/waiting_customer/closed')
    const { status: _s, ...rest } = canonical
    expect(read(rest)).toBe('status null is not one of new/needs_owner/draft_ready/waiting_customer/closed')
  })
  // the generalized explain says what support-store's explainCase said, on
  // the same files — its words frozen here when the store was deleted
  it.each<[string, Json, string, string]>([
    [
      'no id',
      (() => {
        const { id: _i, ...r } = canonical
        return r
      })(),
      'canonical-case',
      'missing id (the file name says "canonical-case")',
    ],
    ['id ≠ file name', { ...canonical, id: 'other' }, 'canonical-case', 'id "other" does not match the file name "canonical-case"'],
    ['id under an alias, wrong', { ...freehand, id: undefined, case: 'x' }, 'freehand-case', 'id (as `case`) "x" does not match the file name "freehand-case"'],
    [
      'customer is two addresses',
      { ...freehand, customer: 'a@b.co (also: c@d.co)' },
      'freehand-case',
      'missing customerEmail (found `customer`, which is not a single email address)',
    ],
    [
      'no openedAt nor opened',
      (() => {
        const { opened: _o, ...r } = freehand
        return r
      })(),
      'freehand-case',
      'missing openedAt (or opened)',
    ],
    ['not an object', [1, 2] as unknown as Json, 'x', 'not a JSON object'],
    ['threads not a list', { ...canonical, threads: 3 }, 'canonical-case', 'threads is not an array'],
  ])('%s — the same words explainCase said', (_label, value, id, words) => {
    expect(read(JSON.parse(JSON.stringify(value)), id)).toBe(words)
  })
  // One rule for every sub-kind (the store differed: a bad thread failed the
  // case, a bad note vanished): the child stays out, the parent still reads,
  // and its remarks name the child with explainCase's own words.
  it.each<[string, Json, string]>([
    [
      'a thread without lastMessageId',
      { ...canonical, threads: [{ threadId: 't', lastMessageAt: '2026-10-01T00:00:00Z' }] },
      'threads[0] missing lastMessageId',
    ],
    ['a thread without threadId', { ...canonical, threads: [{ lastMessageId: 'm', lastMessageAt: '2026-10-01T00:00:00Z' }] }, 'threads[0] missing threadId'],
  ])('%s — the case reads, the thread is named', (_label, value, words) => {
    const store = { error: words }
    const r = readRecordValue(m, 'case', value, 'canonical-case')
    if (!r.ok) throw new Error(r.reason)
    expect((r.record as Json).threads).toEqual([])
    expect(r.remarks).toEqual([store.error.replace(/^threads\[0\] /, 'threads[0] is not read: ')])
  })
  it('customer as an object: same field, same question — a field named after its alias says whose it is', () => {
    expect(read({ ...freehand, customer: { email: 'x@y.co' } }, 'freehand-case')).toBe(
      "missing customerEmail (found `customer`, an object — which of its fields is the customer's email?)",
    )
  })
})

describe('support — tolerances: aliases, conditioned alias, lift (empty, never invented)', () => {
  const m = ref('support')
  const freehand = m.spec.kinds.case.examples[1]
  const r = readRecordValue(m, 'case', freehand, 'freehand-case', { now: NOW })
  if (!r.ok) throw new Error(r.reason)
  const rec = r.record as Json
  it('opened → openedAt, customer → customerEmail (normalized), intent and summary from empty', () => {
    expect(rec.openedAt).toBe('2026-10-20T10:00:00Z')
    expect(rec.customerEmail).toBe('another@example.com')
    expect(rec.summary).toBe('')
    expect(rec.identity).toBe('') // summary empty → the case stays blank (no fallback to intent)
  })
  it('a loose thread_id is lifted to one thread with empty subject and message id', () => {
    expect(rec.threads).toHaveLength(1)
    expect(rec.threads[0]).toMatchObject({
      id: 'th_777',
      threadId: 'th_777',
      subject: '',
      lastMessageId: '',
      lastMessageAt: '2026-10-21T08:00:00Z',
      draftId: 'd_8',
      at: '2026-10-21T08:00:00Z',
      identity: '(thread)',
    })
  })
  it('a string note is lifted to a minimal note: no time, by agent', () => {
    expect(rec.notes).toEqual([expect.objectContaining({ at: '', by: 'agent', text: 'asked them for the order number', updatedBy: 'agent' })])
  })
  it('explicit threads win over a loose threadId', () => {
    const c = readRecordValue(m, 'case', { ...m.spec.kinds.case.examples[0], threadId: 'loose' }, 'canonical-case')
    expect(c.ok && (c.record as Json).threads.map((t: Json) => t.threadId)).toEqual(['th_001'])
  })
  it('no threads and no threadId is a case with zero threads; draftId absent stays absent', () => {
    const { thread_id: _t, draft_id: _d, ...rest } = freehand
    const c = readRecordValue(m, 'case', rest, 'freehand-case')
    expect(c.ok && (c.record as Json).threads).toEqual([])
    const noDraft = readRecordValue(m, 'case', { ...freehand, draft_id: undefined }, 'freehand-case')
    expect(noDraft.ok && 'draftId' in (noDraft.record as Json).threads[0]).toBe(false)
  })
  it('updatedBy falls back to agent (declared), unknown fields are preserved', () => {
    expect(rec.updatedBy).toBe('agent')
    const c = readRecordValue(m, 'case', { ...freehand, mine: { x: 1 } }, 'freehand-case')
    expect(c.ok && (c.record as Json).mine).toEqual({ x: 1 })
  })
  it('a note that cannot be read stays out and is SAID, the case still reads', () => {
    const c = readRecordValue(m, 'case', { ...freehand, notes: [{ at: '2026-10-21T08:00:00Z', note: 'wrong key' }, 'ok'] }, 'freehand-case')
    if (!c.ok) throw new Error(c.reason)
    expect((c.record as Json).notes.map((n: Json) => n.text)).toEqual(['ok'])
    expect(c.remarks).toEqual(['notes[0] is not read: missing text'])
  })
  it('at: lastActivityAt written is authoritative; else updatedAt, else openedAt', () => {
    expect(rec.at).toBe('2026-10-21T08:00:00Z')
    const canon = readRecordValue(m, 'case', m.spec.kinds.case.examples[0], 'canonical-case')
    expect(canon.ok && canon.record.at).toBe('2026-10-28T09:05:00Z')
  })
})

describe('plans — computed state, ready, labelOverride, inherited at, declared-absent updatedBy', () => {
  const m = ref('plans')
  const [ex0, ex1, ex2] = m.spec.kinds.plan.examples
  const r0 = readRecordValue(m, 'plan', ex0, exampleFileId(m, 'plan', ex0), { now: NOW, isAgent })
  const r1 = readRecordValue(m, 'plan', ex1, exampleFileId(m, 'plan', ex1), { now: NOW, isAgent })
  const r2 = readRecordValue(m, 'plan', ex2, exampleFileId(m, 'plan', ex2), { now: NOW, isAgent })
  if (!r0.ok || !r1.ok || !r2.ok) throw new Error('plan examples must read')
  const p0 = r0.record as Json
  it('the id is what the file pattern matched (*.plan.json)', () => {
    expect(exampleFileId(m, 'plan', ex0)).toBe('august-close')
    expect(p0.id).toBe('august-close')
  })
  it('state is computed from the tasks; updatedBy is declared absent → null, never invented', () => {
    expect(p0.state).toBe('active')
    expect((r2.record as Json).state).toBe('done')
    expect(p0.updatedBy).toBeNull()
  })
  it("tasks inherit the plan's at; ready is computed over siblings", () => {
    const byId = Object.fromEntries(p0.tasks.map((t: Json) => [t.id, t]))
    expect(byId.t1.at).toBe('2026-08-27')
    expect([byId.t1.ready, byId.t2.ready, byId.t3.ready]).toEqual([false, true, false])
  })
  it('cancelled reads «dropped» by its state, never by a note', () => {
    expect((r2.record as Json).tasks[0].stateLabel).toMatchObject({ one: 'dropped' })
    expect((r2.record as Json).tasks[0].dropped).toBeUndefined()
    expect(p0.tasks[0].stateLabel).toEqual({ one: 'done', many: 'done' })
  })
  it('notes[] of objects and conversations[] of ids read (0.7.0)', () => {
    const byId = Object.fromEntries(p0.tasks.map((t: Json) => [t.id, t]))
    expect(byId.t2.notes.map((n: Json) => [n.text, n.updatedBy])).toEqual([['Before the 28th', 'finance']])
    expect(byId.t3.notes.map((n: Json) => n.text)).toEqual(['Waits for the figure from t2'])
    expect(byId.t1.conversations.map((c: Json) => c.id)).toEqual(['6ad8e4db-0000-4000-8000-000000000001'])
  })
  it('no old shape is read (0.7.0): a notes string leaves its task out, a string note stays out of its task — both said; a loose note or conversation is no child', () => {
    const plan = {
      title: 'P',
      tasks: [
        { id: 't1', title: 'string notes', owner: 'finance', status: 'pending', dependsOn: [], notes: 'Before the 28th' },
        { id: 't2', title: 'a string note', owner: 'finance', status: 'pending', dependsOn: [], notes: ['plain'] },
        {
          id: 't3',
          title: 'loose fields',
          owner: 'finance',
          status: 'pending',
          dependsOn: [],
          note: 'Waits',
          conversation: '6ad8e4db-0000-4000-8000-000000000001',
        },
      ],
    }
    const r = readRecordValue(m, 'plan', plan, 'p', { now: NOW, isAgent })
    if (!r.ok) throw new Error(r.reason)
    const tasks = (r.record as Json).tasks as Json[]
    expect(tasks.map((t) => t.id)).toEqual(['t2', 't3'])
    expect(r.remarks.join('\n')).toMatch(/tasks\[0\] is not read: notes is not an array/)
    expect(r.remarks.join('\n')).toMatch(/tasks\[1\] \(t2\): notes\[0\] is not read/)
    expect(tasks[0]!.notes).toEqual([])
    expect([tasks[1]!.notes, tasks[1]!.conversations]).toEqual([[], []])
  })
  it('the new shape reads: in review, cancelled, parent, waitingOn, nextCheckAt, due, conversations[], notes[] (0.2.0)', () => {
    const byId = Object.fromEntries((r1.record as Json).tasks.map((t: Json) => [t.id, t]))
    // cancelled is said «dropped» (plans 0.6.1 — one word with the owner's Drop)
    expect([byId.t1.state, byId.t4.state, byId.t4.stateLabel.one]).toEqual(['in_review', 'cancelled', 'dropped'])
    expect(byId.t1.notes).toEqual([
      expect.objectContaining({ text: "Done; needs sam's OK. Next: sam reviews.", updatedBy: 'writer', at: '2026-11-02T10:00:00Z' }),
    ])
    expect(byId.t1.conversations.map((c: Json) => c.id)).toEqual(['9d99c98d-0000-4000-8000-000000000002'])
    expect([byId.t3.parent, byId.t3.waitingOn, byId.t2.due]).toEqual(['t1', { owner: 'ana', action: 'send the glossary' }, '2026-11-06'])
    // in review is not ready; a task waiting on someone is not ready; t2 waits on t1 (in review)
    expect([byId.t1.ready, byId.t2.ready, byId.t3.ready, byId.t4.ready]).toEqual([false, false, false, false])
    expect((r1.record as Json).state).toBe('active')
  })
  it('a computed field ignores its homonym written in the file, and says so', () => {
    const r = readRecordValue(m, 'plan', { ...ex0, tasks: ex0.tasks.map((t: Json) => (t.id === 't3' ? { ...t, ready: true } : t)) }, 'x', { now: NOW })
    if (!r.ok) throw new Error(r.reason)
    expect((r.record as Json).tasks[2].ready).toBe(false)
    const st = readRecordValue(m, 'plan', { ...ex0, state: 'done' }, 'x')
    expect(st.ok && st.record.state).toBe('active')
    expect(st.ok && st.remarks).toEqual(['state is computed — the value written in the file ("done") is ignored'])
  })
  it("with a task unread, all(tasks, …) can't be vouched for: the plan stays active", () => {
    const r = readRecordValue(m, 'plan', { ...ex2, tasks: [...ex2.tasks, { id: 't9', title: 'x', owner: 'writer', status: 'someday' }] }, 'x')
    if (!r.ok) throw new Error(r.reason)
    expect(r.record.state).toBe('active')
    expect(r.partial).toEqual(['tasks'])
  })
  it('a task in an unknown status is not read, and the plan says which', () => {
    const r = readRecordValue(m, 'plan', { ...ex0, tasks: [...ex0.tasks, { id: 't4', title: 'x', owner: 'writer', status: 'later' }] }, 'x')
    expect(r.ok && r.remarks).toEqual(['tasks[3] is not read: status "later" is not one of pending/in_progress/in_review/blocked/done/cancelled'])
  })
})

describe('invoices / documents — identity fallback, money, dates', () => {
  const f = ref('invoices')
  it('identity falls back to the declared empty template when documentNumber is null', () => {
    const r = readRecordValue(f, 'invoice', f.spec.kinds.invoice.examples[1], 'inv-70b2')
    expect(r.ok && r.record.identity).toBe('inv-70b2 · Cloud Provider Inc')
  })
  it('money must be normalized by the producer — a localized string is refused with the field named', () => {
    const r = readRecordValue(f, 'invoice', { ...f.spec.kinds.invoice.examples[0], total: '71,00' }, 'inv-70a1')
    expect(r.ok ? '' : r.reason).toBe('total must be money as {amount, currency} (found "71,00")')
  })
  it('a date that is not a date', () => {
    const r = readRecordValue(f, 'invoice', { ...f.spec.kinds.invoice.examples[0], date: '02/10/2026x' }, 'inv-70a1')
    expect(r.ok ? '' : r.reason).toBe('date "02/10/2026x" is not a date')
  })
  it('oneOf', () => {
    const r = readRecordValue(f, 'invoice', { ...f.spec.kinds.invoice.examples[0], kind: 'gift' }, 'inv-70a1')
    expect(r.ok ? '' : r.reason).toBe('kind "gift" is not one of sale/purchase/refund')
  })
  it('a file name that is not a record id', () => {
    const r = readRecordValue(f, 'invoice', f.spec.kinds.invoice.examples[0], 'hd 70a1')
    expect(r.ok ? '' : r.reason).toBe('the file name gives the id "hd 70a1", which is not a valid record id')
  })
})

describe('templates', () => {
  it('{{a || b}} takes the first non-blank; money reads amount and currency', () => {
    expect(renderTemplate('{{a || b}} / {{t}}', { a: '', b: 'B', t: { amount: 3, currency: 'EUR' } }).text).toBe('B / 3 EUR')
    expect(renderTemplate('{{x}}', {}).blanks).toBe(1)
    expect(renderTemplate('{{a string}}', {}, 'S').text).toBe('S')
  })
})

describe('parsers', () => {
  it('json errors are said', () => {
    expect(parseFile('{', 'json')).toMatchObject({ error: expect.stringMatching(/^not valid JSON: /) })
  })
  it('md-frontmatter: the YAML block is the record, the rest is body', () => {
    expect(parseFile('---\ntitle: Hello\nstate: received\ndue: 2026-11-01\n---\n# Body\n', 'md-frontmatter')).toEqual({
      value: { title: 'Hello', state: 'received', due: '2026-11-01', body: '# Body\n' },
    })
    expect(parseFile('# no frontmatter', 'md-frontmatter')).toEqual({ error: 'no frontmatter — the file must start with a --- block' })
    expect(parseFile('---\n- a\n---\n', 'md-frontmatter')).toEqual({ error: 'the frontmatter is not a set of key: value fields' })
  })
})

describe('files source — expansion and confinement', () => {
  it("agent-state: every agent's silos/<silo>/; project: every known folder", () => {
    write('agent-state/finance/silos/invoices/a1.json', {})
    write('agent-state/writer/silos/invoices/b2.json', {})
    write('agent-state/writer/silos/other/c3.json', {})
    write('p/one/plans/x.plan.json', {})
    write('p/two/plans/y.plan.json', {})
    write('p/two/plans/closed/z.plan.json', {})
    const locs = locations(['finance', 'writer', 'empty'], ['one', 'two', 'missing'])
    const a = scanSource({ id: 's', root: 'agent-state', glob: 'silos/invoices/*.json', parser: 'json' }, locs)
    expect(a.files.map((f) => `${f.location.key}:${f.rel}:${f.stem}`)).toEqual([
      'agent:finance:silos/invoices/a1.json:a1',
      'agent:writer:silos/invoices/b2.json:b2',
    ])
    const p = scanSource({ id: 's', root: 'project', glob: 'plans/*.plan.json', parser: 'json' }, locs)
    expect(p.files.map((f) => `${f.location.folder?.split('/').pop()}:${f.stem}`)).toEqual(['one:x', 'two:y'])
  })

  it('refuses what is not a regular file, too large, a link out, and never walks dot-entries, node_modules or a linked folder', () => {
    const dir = join(base, 'agent-state', 'finance', 'silos', 'x')
    write('agent-state/finance/silos/x/ok.json', {})
    write('agent-state/finance/silos/x/.hidden.json', {})
    write('agent-state/finance/silos/x/w.json.tmp', {})
    write('agent-state/finance/silos/x/big.json', `"${'a'.repeat(1024 * 1024 + 10)}"`)
    write('outside/secret.json', {})
    write('agent-state/finance/silos/x/sub/deep.json', {})
    write('agent-state/finance/silos/x/node_modules/n.json', {})
    write('agent-state/finance/silos/x/.git/g.json', {})
    execFileSync('mkfifo', [join(dir, 'fifo.json')])
    symlinkSync(join(base, 'outside', 'secret.json'), join(dir, 'escape.json'))
    symlinkSync(join(dir, 'ok.json'), join(dir, 'inner.json'))
    symlinkSync(join(base, 'outside'), join(dir, 'linkdir'))
    const locs = locations(['finance'])
    const flat = scanSource({ id: 's', root: 'agent-state', glob: 'silos/x/*.json', parser: 'json' }, locs)
    // a record that is a link is never read, even one that stays inside (seventh review round)
    expect(flat.files.map((f) => f.stem).sort()).toEqual(['ok'])
    expect(Object.fromEntries(flat.unreadable.map((u) => [u.rel.split('/').pop(), u.reason]))).toEqual({
      'big.json': 'larger than 1024 KB — not read',
      'escape.json': 'a link that leads outside its folder — it is not read',
      'fifo.json': 'not a regular file',
      'inner.json': 'a link — a record is read only from a regular file, never through a link',
    })
    const deep = scanSource({ id: 's', root: 'agent-state', glob: 'silos/x/**/*.json', parser: 'json' }, locs)
    expect(deep.files.map((f) => f.rel).sort()).toEqual(['silos/x/ok.json', 'silos/x/sub/deep.json'])
  })

  it('a convention folder that is a link leaving its location is not read', () => {
    write('outside/silos/x/a.json', {})
    mkdirSync(join(base, 'agent-state', 'finance'), { recursive: true })
    symlinkSync(join(base, 'outside', 'silos'), join(base, 'agent-state', 'finance', 'silos'))
    const s = scanSource({ id: 's', root: 'agent-state', glob: 'silos/x/*.json', parser: 'json' }, locations(['finance']))
    expect(s.files).toEqual([])
    expect(s.unreadable[0]!.reason).toBe("silos/x leads outside finance's agent state — it is not read")
  })

  it.each([
    [{ id: 's', root: 'agent-state', glob: 'silos/invoices/*.json' }, null],
    [{ id: 's', root: 'agent-state', glob: 'support/cases/*.json' }, null], // the closed legacy list
    [{ id: 's', root: 'agent-state', glob: 'notes/*.json' }, "under agent-state a silo's records live in silos/<silo>/"],
    [{ id: 's', root: 'agent-state', glob: 'silos/*.json' }, "under agent-state a silo's records live in silos/<silo>/"],
    [{ id: 's', root: 'project', glob: '*.json' }, 'names no folder of its own'],
    [{ id: 's', root: 'project', glob: '**/*.json' }, 'names no folder of its own'],
    [{ id: 's', root: 'project', glob: 'plans/../x/*.json' }, 'climbs out'],
    [{ id: 's', root: 'project', glob: 'plans/{a,b}.json' }, 'only *, ? and ** are read'],
    [{ id: 's', root: 'project', glob: 'plans/**' }, 'must end in a file pattern'],
  ])('confineGlob %j', (src, msg) => {
    const r = confineGlob(src)
    if (msg === null) expect(r).toBeNull()
    else expect(r).toContain(msg)
  })

  it('stemOf', () => {
    expect(stemOf('*.plan.json', 'a.plan.json')).toBe('a')
    expect(stemOf('*.json', 'b.json')).toBe('b')
    expect(stemOf('x-?.json', 'x-1.json')).toBe('x-1')
  })
})

describe('SiloReader — a whole silo over disk', () => {
  it('support over synthetic cases: valid ones normalized and anchored, broken ones explained, last write', () => {
    const m = ref('support')
    write('agent-state/support/support/cases/canonical-case.json', m.spec.kinds.case.examples[0])
    write('agent-state/support/support/cases/freehand-case.json', m.spec.kinds.case.examples[1])
    write('agent-state/writer/support/cases/broken.json', { id: 'broken', status: 'closed', openedAt: '2026-10-01T00:00:00Z' })
    write('agent-state/writer/support/cases/nojson.json', '{')
    const old = join(base, 'agent-state/writer/support/cases/broken.json')
    utimesSync(old, new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'))
    const reader = new SiloReader(locations(['support', 'writer']))
    const r = reader.read('support', m, { now: NOW })
    expect(r.problems).toEqual([])
    expect(r.records.map((x) => `${x.location}:${x.record.id}`).sort()).toEqual(['agent:support:canonical-case', 'agent:support:freehand-case'])
    expect(r.records[0]!.anchors).toEqual({ agent: 'support' })
    expect(r.unreadable.map((u) => [u.id, u.reason]).sort()).toEqual([
      ['broken', 'missing customerEmail'],
      ['nojson', expect.stringMatching(/^not valid JSON: /)],
    ])
    expect(r.lastWrite).not.toBeNull()
  })

  it('re-reads a file whose mtime changed, keeps the parse otherwise', () => {
    const m = ref('invoices')
    const file = write('agent-state/finance/silos/invoices/inv-70a1.json', m.spec.kinds.invoice.examples[0])
    const reader = new SiloReader(locations(['finance']))
    expect(reader.read('invoices', m).records[0]!.record.state).toBe('open')
    writeFileSync(file, JSON.stringify({ ...m.spec.kinds.invoice.examples[0], state: 'paid' }))
    utimesSync(file, new Date(), new Date(Date.now() + 5000))
    expect(reader.read('invoices', m).records[0]!.record.state).toBe('paid')
  })

  it('project sources anchor to their folder', () => {
    const m = ref('documents')
    write('p/acme/context/documents/official-request-2026.json', m.spec.kinds.document.examples[0])
    const r = new SiloReader(locations([], ['acme'])).read('documents', m)
    expect(r.records[0]!.anchors).toEqual({ folder: join(base, 'p', 'acme') })
  })

  it('a source outside its confinement is never read, even if handed in', () => {
    const m = ref('invoices')
    m.spec.sources[0].glob = 'notes/*.json'
    write('agent-state/finance/notes/a.json', m.spec.kinds.invoice.examples[0])
    const r = new SiloReader(locations(['finance'])).read('invoices', m)
    expect(r.records).toEqual([])
    expect(r.problems[0]).toContain('live in silos/<silo>/')
  })

  it('a manifest with several kinds names no source→kind link: nothing is read, and it says why', () => {
    const m = ref('invoices')
    m.spec.kinds.other = m.spec.kinds.invoice
    expect(new SiloReader(locations(['finance'])).read('invoices', m).problems[0]).toContain('nothing says which source feeds which')
  })
})

describe('SiloKernel — what is read lands in the registry status', () => {
  it('counts parsed/failed and the last write; an error silo is not read', () => {
    const dataDir = join(base, 'data')
    mkdirSync(join(dataDir, 'silos', 'registry', 'support'), { recursive: true })
    writeFileSync(join(dataDir, 'silos', 'registry', 'support', 'silo.json'), JSON.stringify(ref('support')))
    mkdirSync(join(dataDir, 'silos', 'registry', 'broken'), { recursive: true })
    writeFileSync(join(dataDir, 'silos', 'registry', 'broken', 'silo.json'), '{')
    const m = ref('support')
    write('agent-state/writer/support/cases/canonical-case.json', m.spec.kinds.case.examples[0])
    write('agent-state/writer/support/cases/broken.json', { id: 'broken' })
    const registry = new SiloRegistry({ dataDir })
    registry.load()
    const kernel = new SiloKernel({ registry, reader: new SiloReader(locations(['writer'])), now: () => NOW })
    kernel.refresh()
    expect(registry.get('support')!.status.records).toEqual({ parsed: 1, failed: 1 })
    expect(registry.get('support')!.status.lastWrite).toMatch(/^\d{4}-/)
    expect(kernel.reading('broken')).toBeNull()
    expect(kernel.reading('support')!.records).toHaveLength(1)
    // persisted by the kernel in status.json
    expect(JSON.parse(readFileSync(join(dataDir, 'silos', 'registry', 'support', 'status.json'), 'utf8')).records).toEqual({ parsed: 1, failed: 1 })
    expect(readdirSync(join(dataDir, 'silos'))).toEqual(['registry'])
  })
})
