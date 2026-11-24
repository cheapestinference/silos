import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  checkExpression,
  count,
  dictionaryForKind,
  evaluate,
  parse,
  sum,
  test as holds,
  validateDictionary,
  type EvalEnv,
  type Expr,
  type ExprContext,
  type FieldDict,
} from '../src/silos/expressions.js'
import { MANIFEST_DIRS } from './helpers/silo-manifests.js'

type Json = Record<string, any>
// the shipped manifests and the generic test fixtures — every expression of both
const manifests: Array<{ file: string; m: Json }> = MANIFEST_DIRS.flatMap((dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.silo.json'))
    .map((file) => ({ file, m: JSON.parse(readFileSync(join(dir, file), 'utf8')) })),
)

const ast = (src: string, ctx: ExprContext = 'predicate'): Expr => {
  const r = parse(src, ctx)
  if (!r.ok) throw new Error(`${src}: ${r.error.message}`)
  return r.ast
}
const err = (src: string, ctx: ExprContext = 'predicate'): { message: string; column: number } => {
  const r = parse(src, ctx)
  if (r.ok) throw new Error(`expected ${src} to fail`)
  return r.error
}

// Every expression a reference manifest writes, with the place it sits in,
// the language context and the kind it is evaluated over. needs-you entries
// name no kind: the pulse's kind, else the silo's only kind (finding, report).
interface Site {
  file: string
  where: string
  src: string
  ctx: ExprContext
  kind: string
}
function sites(): Site[] {
  const out: Site[] = []
  for (const { file, m } of manifests) {
    const kinds = Object.keys(m.spec.kinds ?? {})
    const defaultKind = m.spec.surfaces?.pulse?.kind ?? (kinds.length === 1 ? kinds[0] : kinds[0])
    for (const [k, spec] of Object.entries<Json>(m.spec.kinds ?? {})) {
      if (spec.envelope.state?.computed) out.push({ file, where: `${k}.envelope.state.computed`, src: spec.envelope.state.computed, ctx: 'state', kind: k })
      for (const [n, src] of Object.entries<string>(spec.computed ?? {})) out.push({ file, where: `${k}.computed.${n}`, src, ctx: 'computed', kind: k })
      for (const o of spec.labelOverrides ?? []) out.push({ file, where: `${k}.labelOverrides`, src: o.when, ctx: 'predicate', kind: k })
      for (const [s, sub] of Object.entries<Json>(spec.subKinds ?? {})) {
        for (const [n, src] of Object.entries<string>(sub.computed ?? {}))
          out.push({ file, where: `${k}/${s}.computed.${n}`, src, ctx: 'computed', kind: `${k}/${s}` })
        for (const o of sub.labelOverrides ?? []) out.push({ file, where: `${k}/${s}.labelOverrides`, src: o.when, ctx: 'predicate', kind: `${k}/${s}` })
      }
    }
    for (const v of m.spec.views ?? []) if (v.fold) out.push({ file, where: `views.${v.id}.fold`, src: v.fold.when, ctx: 'predicate', kind: v.kind })
    const s = m.spec.surfaces ?? {}
    if (s.pulse?.when) out.push({ file, where: 'pulse.when', src: s.pulse.when, ctx: 'predicate', kind: s.pulse.kind })
    for (const [i, n] of (s['needs-you'] ?? []).entries()) {
      out.push({ file, where: `needs-you[${i}].when`, src: n.when, ctx: 'predicate', kind: defaultKind })
      out.push({ file, where: `needs-you[${i}].clears`, src: n.clears, ctx: 'predicate', kind: defaultKind })
      if (n.fold) out.push({ file, where: `needs-you[${i}].fold`, src: n.fold.when, ctx: 'predicate', kind: defaultKind })
    }
  }
  return out
}

function dictFor(file: string, kind: string): FieldDict {
  const m = manifests.find((x) => x.file === file)!.m
  const [k, sub] = kind.split('/')
  const { dict, issues } = dictionaryForKind(k!, m.spec.kinds[k!])
  expect(issues).toEqual([])
  if (!sub) return dict
  return Object.values(dict.collections).find((c) => c.subKind === sub)!
}

describe('the reference manifests: every expression parses and validates', () => {
  const all = sites()
  it('finds the expressions of every reference manifest', () => {
    expect(new Set(all.map((s) => s.file))).toEqual(
      new Set([
        'support.silo.json',
        'plans.silo.json',
        'invoices.silo.json',
        'documents.silo.json',
        'task-mode.silo.json',
        'executions.silo.json',
        'system.silo.json',
      ]),
    )
    expect(all.length).toBeGreaterThanOrEqual(15)
  })
  it.each(all.map((s) => [`${s.file} ${s.where}: ${s.src}`, s] as const))('%s', (_label, s) => {
    const r = parse(s.src, s.ctx)
    expect(r.ok, r.ok ? '' : r.error.message).toBe(true)
    expect(checkExpression(s.src, dictFor(s.file, s.kind), s.ctx)).toEqual([])
  })
  it('every kind dictionary validates (references and no cycles)', () => {
    for (const { file, m } of manifests) {
      for (const [k, spec] of Object.entries<Json>(m.spec.kinds ?? {})) {
        const { dict, issues } = dictionaryForKind(k, spec)
        expect(issues, file).toEqual([])
        expect(validateDictionary(dict), file).toEqual([])
      }
    }
  })
})

describe('layer 1 — the grammar examples', () => {
  it.each([
    'state = needs_owner',
    'state in [open, partial] and kind = sale and due < now',
    'ready and owner is human',
    "state = done and notes startsWith 'Dropped:'",
    'parent.at < now - 30d',
    'state = action_needed and due < now + 7d',
    'total.currency = "EUR"',
    '(state = open or state = partial) and due >= now - 48h',
    'since(waiting_customer) < now - 5d',
    'amount <= 100',
    'state != closed',
  ])('parses %s', (src) => {
    expect(parse(src).ok).toBe(true)
  })

  it('or binds looser than and', () => {
    const e = ast('a = 1 or b = 2 and c = 3')
    expect(e.t).toBe('or')
    if (e.t === 'or') expect(e.items[1]!.t).toBe('and')
  })

  it('now ± duration is ms from the clock', () => {
    const e = ast('due < now + 7d')
    expect(e.t === 'cmp' && e.right.t === 'now' && e.right.offsetMs).toBe(7 * 86_400_000)
    const m = ast('due < now - 30m')
    expect(m.t === 'cmp' && m.right.t === 'now' && m.right.offsetMs).toBe(-30 * 60_000)
  })

  it.each([
    ['', 'the expression is empty', 1],
    ['state =', 'expected a field', 8],
    ['state = done and', 'ends where a condition was expected', 17],
    ['state == done', 'expected a field, a value', 8],
    ['notes startsWith Dropped', 'startsWith takes a quoted text', 18],
    ['owner is agent', '"is" is only followed by "human"', 10],
    ['due < now + 7', 'needs a duration like 7d', 13],
    ['due < 7d', 'only follows "now +" or "now -"', 7],
    ['due < now + 7w', 'neither a number nor a duration', 13],
    ['state in [open, partial', 'expected "]" to close the list', 24],
    ['state in [parent.at]', 'not field paths', 11],
    ["notes startsWith 'Dropped:", 'never closed', 18],
    ['state = done && ready', 'join conditions with "and" / "or"', 14],
    ['not ready', 'unexpected "ready"', 5],
    ['now', 'where a comparison was expected', 4],
    ['(state = done', 'expected ")"', 14],
    ['state = done state = new', 'unexpected "state"', 14],
  ])('%j fails in plain words with its position', (src, message, column) => {
    const e = err(src)
    expect(e.message).toContain(message)
    expect(e.column).toBe(column)
  })
})

describe('layer 2 — closed aggregators', () => {
  it('all/max parse in computed fields', () => {
    expect(parse('state = pending and all(dependsOn, state = done)', 'computed').ok).toBe(true)
    expect(parse('max(threads.lastMessageAt…, openedAt)', 'computed').ok).toBe(true)
    expect(parse('max(threads.lastMessageAt, openedAt)', 'computed').ok).toBe(true)
  })
  it('? : only as the root of a computed state', () => {
    expect(parse('all(tasks, state = done) ? done : active', 'state').ok).toBe(true)
    expect(err('all(tasks, state = done) ? done : active', 'computed').message).toContain('only exists in a computed state')
    expect(err('state = done ? done : active').message).toContain('only exists in a computed state')
    expect(err('all(tasks, state = done) ? done', 'state').message).toContain('expected ":"')
  })
  it('aggregators are refused in a predicate', () => {
    expect(err('all(tasks, state = done)').message).toContain('only live in computed fields and pulse')
  })
  // any (plans phase 1, G2): entered with its first real use — a task is
  // dropped when any of its notes says so
  it('any parses in computed fields, like all, and nowhere a predicate', () => {
    expect(parse("any(notes, text startsWith 'Dropped:')", 'computed').ok).toBe(true)
    expect(parse('state = done and any(dependsOn, state = blocked)', 'computed').ok).toBe(true)
    expect(err("any(notes, text startsWith 'Dropped:')").message).toContain('only live in computed fields and pulse')
    expect(err('any(tasks, all(dependsOn, state = done))', 'computed').message).toContain('one level only')
    expect(err('any(tasks.notes, state = done)', 'computed').message).toContain('not at a path')
  })
  describe('any — evaluation', () => {
    const notesDict = (): FieldDict =>
      dictionaryForKind('task', {
        envelope: { id: { field: 'id' }, identity: { template: '{{title}}' }, state: { field: 'status' } },
        states: [
          { value: 'pending', label: { one: 'pending', many: 'pending' } },
          { value: 'done', label: { one: 'done', many: 'done' }, terminal: true },
        ],
        fields: { dependsOn: { type: 'refs(task)' } },
        subKinds: { note: { path: 'notes[]', envelope: { identity: { template: '{{text}}' } }, fields: { text: { type: 'string', required: true } } } },
      }).dict
    const dropped = ast("any(notes, text startsWith 'Dropped:')", 'computed')
    const env = (over: Partial<EvalEnv> = {}): EvalEnv => ({ now: 0, dict: notesDict(), ...over })
    it('true when one child satisfies; vacuously FALSE over none', () => {
      expect(evaluate(dropped, { notes: [{ text: 'fine' }, { text: 'Dropped: superseded' }] }, env())).toBe(true)
      expect(evaluate(dropped, { notes: [{ text: 'fine' }] }, env())).toBe(false)
      expect(evaluate(dropped, { notes: [] }, env())).toBe(false)
      expect(evaluate(dropped, {}, env())).toBe(false)
    })
    it('over partial children: a child read and matching is proof; no match is never vouched for', () => {
      expect(evaluate(dropped, { notes: [{ text: 'Dropped: x' }] }, env({ partial: new Set(['notes']) }))).toBe(true)
      expect(evaluate(dropped, { notes: [{ text: 'fine' }] }, env({ partial: new Set(['notes']) }))).toBe(false)
    })
    it('over refs: a sibling that exists and satisfies — a ref naming no sibling never counts', () => {
      const blocked = ast('any(dependsOn, state = done)', 'computed')
      const siblings = [
        { id: 'a', state: 'pending' },
        { id: 'b', state: 'done' },
      ]
      expect(evaluate(blocked, { id: 'c', dependsOn: ['a', 'b'] }, env({ siblings }))).toBe(true)
      expect(evaluate(blocked, { id: 'c', dependsOn: ['a', 'ghost'] }, env({ siblings }))).toBe(false)
      expect(evaluate(blocked, { id: 'c', dependsOn: [] }, env({ siblings }))).toBe(false)
      expect(evaluate(blocked, { id: 'c' }, env({ siblings }))).toBe(false)
    })
    it('validates like all: children or refs only, the predicate over THEIR fields', () => {
      const d = notesDict()
      expect(checkExpression("any(notes, text startsWith 'x')", d, 'computed')).toEqual([])
      expect(checkExpression('any(notes, nope = 1)', d, 'computed')[0]!.message).toContain('nope is not a field of task/note')
      expect(checkExpression('any(status, text = 1)', d, 'computed')[0]!.message).toContain('any(status, …) needs children or refs')
    })
  })
  it('count and sum belong to pulse, not to expressions', () => {
    expect(err('count(tasks) > 3', 'computed').message).toContain('surfaces.pulse.aggregate')
    expect(err('sum(total)', 'computed').message).toContain('(with field)')
  })
  it('one level only', () => {
    expect(err('all(tasks, all(dependsOn, state = done))', 'computed').message).toContain('one level only')
  })
  it('a field named like an aggregator is still a field when not called', () => {
    expect(parse('max = 3').ok).toBe(true)
  })
})

describe('static validation — references must be declared', () => {
  const invoice = dictFor('invoices.silo.json', 'invoice')
  const task = dictFor('plans.silo.json', 'plan/task')
  const kase = dictFor('support.silo.json', 'case')
  const issues = (src: string, d: FieldDict, ctx: ExprContext = 'predicate'): string[] => checkExpression(src, d, ctx).map((i) => i.message)

  it('an undeclared field does not validate', () => {
    expect(issues('amount > 3 and state = open', invoice)).toEqual(['amount is not a field of invoice — declare it in fields (or fix the name)'])
    expect(checkExpression('state = open and dueDate < now', invoice)[0]!.column).toBe(18)
  })
  it('an undeclared state value does not validate', () => {
    expect(issues('state = opne', invoice)[0]).toBe("opne is not one of invoice's states (draft, open, partial, paid, refunded)")
    expect(issues('state in [open, payed]', invoice)[0]).toContain('payed is not one of')
    expect(issues('kind = invoice', invoice)[0]).toBe('invoice is not one of the values of kind (sale, purchase, refund)')
  })
  it('parent. only in a sub-kind, and only declared parent fields', () => {
    expect(issues('parent.at < now - 30d', task)).toEqual([])
    expect(issues('parent.title = x', task)).toEqual([])
    expect(issues('parent.nope = x', task)[0]).toContain('nope is not a field of plan')
    expect(issues('parent.at < now', invoice)[0]).toContain('has no parent')
  })
  it('money has amount and currency, nothing else', () => {
    expect(issues('total.currency = EUR', invoice)).toEqual([])
    expect(issues('total.amount > 100', invoice)).toEqual([])
    expect(issues('total.value > 100', invoice)[0]).toContain('money has amount and currency')
  })
  it('is human only over actor fields', () => {
    expect(issues('owner is human', task)).toEqual([])
    expect(issues('title is human', task)[0]).toBe('is human only works on an actor field — title is string')
  })
  it('a bare operand must be yes/no', () => {
    expect(issues('ready', task)).toEqual([])
    expect(issues('dueDerived and state = open', invoice)).toEqual([])
    expect(issues('notes and state = done', task)[0]).toBe('notes is not a yes/no field — compare it (notes = …)')
  })
  it('since(state) needs a declared state', () => {
    expect(issues('since(waiting_customer) < now - 5d', kase)).toEqual([])
    expect(issues('since(waiting) < now - 5d', kase)[0]).toContain("waiting is not one of case's states")
  })
  it('aggregators over undeclared children or refs do not validate', () => {
    const plan = dictFor('plans.silo.json', 'plan')
    expect(issues('all(steps, state = done) ? done : active', plan, 'state')[0]).toContain('steps is not a field of plan')
    expect(issues('all(tasks, status = done) ? done : active', plan, 'state')).toEqual([]) // status is the task's raw state field
    expect(issues('all(tasks, colour = red) ? done : active', plan, 'state')[0]).toContain('colour is not a field of plan/task')
    expect(issues('all(tasks, state = done) ? finished : active', plan, 'state')[0]).toContain("finished is not one of plan's states")
    expect(issues('all(title, state = done)', plan, 'computed')[0]).toContain('needs children or refs')
  })
  it('a computed field that depends on itself does not validate', () => {
    const { dict } = dictionaryForKind('x', {
      envelope: { state: { field: 'status' } },
      states: [{ value: 'a', label: {} }],
      fields: {},
      computed: { p: 'q and state = a', q: 'p' },
    })
    expect(validateDictionary(dict).map((i) => i.message)).toContain(
      'p depends on itself — a computed field cannot reference itself, directly or through another',
    )
  })
})

describe('evaluation', () => {
  const NOW = Date.parse('2026-10-30T12:00:00Z')
  const invoice = dictFor('invoices.silo.json', 'invoice')
  const env = (extra: Partial<EvalEnv> = {}): EvalEnv => ({ now: NOW, dict: invoice, ...extra })
  const overdue = ast('state in [open, partial] and kind = sale and due < now')
  const thisWeek = ast('state = open and due < now + 7d')

  it('invoices: overdue sales and «due this week», by the clock alone', () => {
    const r = { id: 'a', state: 'open', kind: 'sale', due: '2026-10-29' }
    expect(holds(overdue, r, env())).toBe(true)
    expect(holds(overdue, { ...r, due: '2026-11-03' }, env())).toBe(false)
    expect(holds(thisWeek, { ...r, due: '2026-11-03' }, env())).toBe(true)
    // the same record, a week later on the clock — nobody wrote anything
    expect(holds(overdue, { ...r, due: '2026-11-03' }, env({ now: NOW + 7 * 86_400_000 }))).toBe(true)
  })
  it('a missing value never satisfies a condition', () => {
    expect(holds(overdue, { state: 'open', kind: 'sale', due: null }, env())).toBe(false)
    expect(holds(ast('due >= now'), { due: undefined }, env())).toBe(false)
    expect(holds(ast('state != paid'), { state: 'open' }, env())).toBe(true)
  })
  it('money parts and quoted text', () => {
    expect(holds(ast('total.currency = EUR'), { total: { amount: 3, currency: 'EUR' } }, env())).toBe(true)
    expect(holds(ast('total.amount > 100'), { total: { amount: 465.51, currency: 'EUR' } }, env())).toBe(true)
    expect(holds(ast("notes startsWith 'Dropped:'"), { notes: 'Dropped: superseded' }, env())).toBe(true)
    expect(holds(ast("notes startsWith 'Dropped:'"), { notes: 'dropped' }, env())).toBe(false)
  })
  it('since(state) reads the journal; before the first observation it is false', () => {
    const e = ast('since(waiting_customer) < now - 5d')
    const kase = dictFor('support.silo.json', 'case')
    expect(holds(e, { id: 'c' }, { now: NOW, dict: kase, since: () => NOW - 6 * 86_400_000 })).toBe(true)
    expect(holds(e, { id: 'c' }, { now: NOW, dict: kase, since: () => NOW - 2 * 86_400_000 })).toBe(false)
    expect(holds(e, { id: 'c' }, { now: NOW, dict: kase, since: () => null })).toBe(false)
    expect(holds(e, { id: 'c' }, { now: NOW, dict: kase })).toBe(false)
  })
  it('is human: the value does not resolve to an agent id', () => {
    const e = ast('owner is human')
    const isAgent = (v: string): boolean => ['finance', 'writer'].includes(v)
    expect(holds(e, { owner: 'sam' }, { now: NOW, isAgent })).toBe(true)
    expect(holds(e, { owner: 'finance' }, { now: NOW, isAgent })).toBe(false)
    expect(holds(e, { owner: '' }, { now: NOW, isAgent })).toBe(false)
  })

  describe("plans: computed state, ready, labelOverride — on the manifest's own example", () => {
    const planSpec = manifests.find((x) => x.file === 'plans.silo.json')!.m.spec.kinds.plan
    const { dict: plan } = dictionaryForKind('plan', planSpec)
    const task = plan.collections.tasks!
    const normalizeTask = (t: Json): Json => ({ ...t, state: t.status })
    const example = planSpec.examples[0]
    const tasks: Json[] = example.tasks.map(normalizeTask)
    const planRec = { ...example, tasks }
    const taskEnv = (): EvalEnv => ({ now: NOW, dict: task, parent: planRec, siblings: tasks, isAgent: (v) => ['finance', 'writer'].includes(v) })

    it('state = all(tasks, state = done) ? done : active', () => {
      const stateAst = plan.computed.state!.ast!
      expect(evaluate(stateAst, planRec, { now: NOW, dict: plan })).toBe('active')
      const allDone = { ...planRec, tasks: tasks.map((t) => ({ ...t, state: 'done' })) }
      expect(evaluate(stateAst, allDone, { now: NOW, dict: plan })).toBe('done')
      // and through the dictionary: `state` IS the computed one
      expect(holds(ast('state = active'), planRec, { now: NOW, dict: plan })).toBe(true)
    })
    it('ready = state = pending and all(dependsOn, state = done); pulse.when = ready and owner is human', () => {
      const pulseWhen = ast('ready and owner is human')
      const byId = Object.fromEntries(tasks.map((t) => [t.id, t]))
      expect(holds(pulseWhen, byId.t2!, taskEnv())).toBe(true) // sam, pending, t1 done
      expect(holds(pulseWhen, byId.t1!, taskEnv())).toBe(false) // done
      expect(holds(pulseWhen, byId.t3!, taskEnv())).toBe(false) // blocked, finance
      // a dependency that names no sibling can't be vouched for
      expect(holds(ast('ready'), { ...byId.t2!, dependsOn: ['t9'] }, taskEnv())).toBe(false)
      // the computed field wins over a homonym written on disk
      expect(holds(ast('ready'), { ...byId.t3!, ready: true }, taskEnv())).toBe(false)
    })
    it('all(…) over a collection that is not whole is never vouched for', () => {
      const allDone = { ...planRec, tasks: tasks.map((t) => ({ ...t, state: 'done' })) }
      expect(evaluate(plan.computed.state!.ast!, allDone, { now: NOW, dict: plan, partial: new Set(['tasks']) })).toBe('active')
    })
    it('parent.at < now - 30d folds old plans', () => {
      const e = ast('parent.at < now - 30d')
      expect(holds(e, tasks[0]!, { ...taskEnv(), parent: { ...planRec, at: '2026-08-27' } })).toBe(true)
      expect(holds(e, tasks[0]!, { ...taskEnv(), parent: { ...planRec, at: '2026-10-20' } })).toBe(false)
    })
  })

  it('max(children.field…, field) takes the latest moment', () => {
    const kase = dictFor('support.silo.json', 'case')
    const e = ast('max(threads.lastMessageAt…, openedAt)', 'computed')
    const rec = { openedAt: '2026-10-01T00:00:00Z', threads: [{ lastMessageAt: '2026-10-05T00:00:00Z' }, { lastMessageAt: '2026-10-03T00:00:00Z' }] }
    expect(evaluate(e, rec, { now: NOW, dict: kase })).toBe('2026-10-05T00:00:00Z')
    expect(evaluate(e, { openedAt: '2026-10-01T00:00:00Z', threads: [] }, { now: NOW, dict: kase })).toBe('2026-10-01T00:00:00Z')
  })
})

describe('pulse aggregators', () => {
  it('count', () => {
    expect(count([{}, {}, {}])).toBe(3)
  })
  it('sum(money): one total per currency, never mixed; malformed values are counted, not guessed', () => {
    const r = sum(
      [
        { total: { amount: 465.51, currency: 'EUR' } },
        { total: { amount: 0.1, currency: 'EUR' } },
        { total: { amount: 0.2, currency: 'eur' } },
        { total: { amount: 186.04, currency: 'USD' } },
        { total: '71,00' },
        { total: null },
      ],
      'total',
    )
    expect(r.totals).toEqual([
      { currency: 'EUR', amount: 465.81 },
      { currency: 'USD', amount: 186.04 },
    ])
    expect(r.skipped).toBe(2)
  })
})
