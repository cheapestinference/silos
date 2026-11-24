// silos/expressions.ts — the Silo Standard's ONE expression language
// (docs/standard/expressions.md), with its two named layers and nothing else:
//
//   Layer 1 — predicates: comparisons (= != < <= > >=), `in [..]`, `is human`,
//   `startsWith '…'`, `now ± duration`, `since(state)`, `monthStart` (the
//   start of the current month, UTC — plans 0.5.2), field paths with
//   `parent.`, joined by and/or with parentheses. Used by needs-you.when /
//   clears, fold.when, labelOverrides.when, pulse.when.
//
//   Layer 2 — CLOSED aggregators: `all(<children|refs>, pred)`,
//   `any(<children|refs>, pred)` (its first real use: a plan task is
//   dropped when any of its notes says so) and `max(a, b, …)` inside computed
//   fields; `count` / `sum(<money>)` over the live records of a kind for pulse
//   (exported as functions below — inside an expression string they are
//   refused with a pointer to surfaces.pulse).
//   One level deep: an aggregator never contains another. `? :` only as the
//   root of a computed STATE (plans: `all(tasks, state = done) ? done : active`).
//
// Deliberately not Turing-complete: no loops, no author functions, no regex,
// no arithmetic beyond `now ± d`, no access outside the evaluated record, its
// parent and its declared children/refs.
//
// Three entry points:
//   parse(expr, context)            → AST, or an error with position + plain words
//   evaluate(ast, record, env)      → the value (boolean for predicates)
//   validateExpression(ast, dict, context) → static issues: every referenced
//                                     field must be declared by the kind (the
//                                     validator, Task 7, calls this)
// plus dictionaryForKind(), which builds the field dictionary of a manifest
// kind (and its sub-kinds) that evaluate/validate read.
//
// Records handed to evaluate() are NORMALIZED views: the envelope names
// (`id`, `state`, `at`, `identity`, `updatedBy`) already resolved by the reader
// next to the kind's declared fields; children under their collection name
// (`tasks`, `threads`) or in env.children.

import { STALLED_CAUSES, TASK_FLOW_NAMES, taskFlow, type TaskEnv, type TaskRole } from './task-flow.js'

// ── AST ─────────────────────────────────────────────────────────────────────

export type ExprContext = 'predicate' | 'computed' | 'state'
export type CmpOp = '=' | '!=' | '<' | '<=' | '>' | '>='

export type Operand =
  // a field path in a FIELD position (left of a comparison, operand of
  // is human / startsWith / in, or any dotted path)
  | { t: 'field'; path: string[]; pos: number }
  // a bare identifier in a VALUE position (right of a comparison, ternary
  // branch): a declared field of the kind if there is one by that name,
  // otherwise a literal value (a state, a oneOf value) — the grammar's
  // `operand := field | value` with `value := … | state` shares the spelling.
  | { t: 'name'; name: string; pos: number }
  | { t: 'str'; value: string; pos: number }
  | { t: 'num'; value: number; pos: number }
  | { t: 'now'; offsetMs: number; pos: number }
  | { t: 'since'; state: string; pos: number }
  // the start of the current month in UTC (plans 0.5.2 — the clock of a
  // rotation's stamp and archive name): a moment, like `now`
  | { t: 'monthStart'; pos: number }
  | { t: 'all'; coll: string; pred: Expr; pos: number }
  | { t: 'any'; coll: string; pred: Expr; pos: number }
  | { t: 'max'; args: Array<{ path: string[]; pos: number }>; pos: number }

export type Expr =
  | { t: 'or'; items: Expr[]; pos: number }
  | { t: 'and'; items: Expr[]; pos: number }
  | { t: 'cmp'; op: CmpOp; left: Operand; right: Operand; pos: number }
  | { t: 'in'; left: Operand; values: Array<{ value: string | number; pos: number }>; pos: number }
  | { t: 'isHuman'; operand: Operand; pos: number }
  | { t: 'startsWith'; operand: Operand; prefix: string; pos: number }
  // an operand standing alone: a yes/no field (`ready`), `all(…)`, or — in a
  // computed field — the computed value itself (`max(…)`)
  | { t: 'value'; operand: Operand; pos: number }
  | { t: 'ternary'; cond: Expr; then: Operand; else: Operand; pos: number }

export interface ExprError {
  message: string
  pos: number // 0-based offset into the expression
  column: number // 1-based, for humans
}
export type ParseResult = { ok: true; ast: Expr } | { ok: false; error: ExprError }

// ── tokenizer ───────────────────────────────────────────────────────────────

type TokKind = 'ident' | 'str' | 'num' | 'dur' | 'op' | 'punct' | 'ellipsis' | 'eof'
interface Tok {
  k: TokKind
  v: string
  pos: number
}

class ExprFailure extends Error {
  constructor(
    message: string,
    public pos: number,
  ) {
    super(message)
  }
}

const DURATION_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 }
const AGGREGATORS = new Set(['all', 'max', 'any', 'count', 'sum'])

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (/\s/.test(c)) {
      i++
      continue
    }
    const start = i
    if (/[A-Za-z_]/.test(c)) {
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i]!)) i++
      out.push({ k: 'ident', v: src.slice(start, i), pos: start })
      continue
    }
    if (/[0-9]/.test(c)) {
      while (i < src.length && /[0-9]/.test(src[i]!)) i++
      if (i < src.length && /[mhd]/.test(src[i]!) && !/[A-Za-z0-9_]/.test(src[i + 1] ?? '')) {
        i++
        out.push({ k: 'dur', v: src.slice(start, i), pos: start })
        continue
      }
      if (src[i] === '.' && /[0-9]/.test(src[i + 1] ?? '')) {
        i++
        while (i < src.length && /[0-9]/.test(src[i]!)) i++
      }
      if (/[A-Za-z_]/.test(src[i] ?? ''))
        throw new ExprFailure(
          `"${src.slice(start, i + 1)}…" is neither a number nor a duration (durations are a whole number followed by m, h or d: 30m, 48h, 7d)`,
          start,
        )
      out.push({ k: 'num', v: src.slice(start, i), pos: start })
      continue
    }
    if (c === "'" || c === '"') {
      i++
      let s = ''
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\' && (src[i + 1] === c || src[i + 1] === '\\')) {
          s += src[i + 1]
          i += 2
          continue
        }
        s += src[i]
        i++
      }
      if (i >= src.length) throw new ExprFailure(`this text is never closed — add the closing ${c}`, start)
      i++
      out.push({ k: 'str', v: s, pos: start })
      continue
    }
    if (src.startsWith('...', i)) {
      out.push({ k: 'ellipsis', v: '...', pos: start })
      i += 3
      continue
    }
    if (c === '…') {
      out.push({ k: 'ellipsis', v: '…', pos: start })
      i++
      continue
    }
    const two = src.slice(i, i + 2)
    if (two === '!=' || two === '<=' || two === '>=') {
      out.push({ k: 'op', v: two, pos: start })
      i += 2
      continue
    }
    if (c === '=' || c === '<' || c === '>') {
      out.push({ k: 'op', v: c, pos: start })
      i++
      continue
    }
    if ('()[],?:+-.'.includes(c)) {
      out.push({ k: 'punct', v: c, pos: start })
      i++
      continue
    }
    if (c === '!') throw new ExprFailure('"!" alone is not an operator — use != to compare, there is no "not"', start)
    if (c === '&' || c === '|') throw new ExprFailure(`"${c}" is not part of the language — join conditions with "and" / "or"`, start)
    throw new ExprFailure(`"${c}" is not part of the expression language`, start)
  }
  out.push({ k: 'eof', v: '', pos: src.length })
  return out
}

// ── parser ──────────────────────────────────────────────────────────────────

const describeTok = (t: Tok): string => (t.k === 'eof' ? 'the end of the expression' : t.k === 'str' ? `the text '${t.v}'` : `"${t.v}"`)

class Parser {
  private i = 0
  // > 0 while parsing an aggregator's own predicate (one level only)
  private inAggregator = 0
  constructor(
    private toks: Tok[],
    private context: ExprContext,
  ) {}

  private peek(o = 0): Tok {
    return this.toks[Math.min(this.i + o, this.toks.length - 1)]!
  }
  private next(): Tok {
    const t = this.peek()
    this.i++
    return t
  }
  private isKw(t: Tok, v: string): boolean {
    return t.k === 'ident' && t.v === v
  }
  private isPunct(t: Tok, v: string): boolean {
    return t.k === 'punct' && t.v === v
  }
  private expectPunct(v: string, what: string): Tok {
    const t = this.peek()
    if (!this.isPunct(t, v)) throw new ExprFailure(`expected "${v}" ${what}, found ${describeTok(t)}`, t.pos)
    return this.next()
  }

  parseRoot(): Expr {
    if (this.peek().k === 'eof') throw new ExprFailure('the expression is empty', 0)
    const e = this.parseOr()
    const t = this.peek()
    if (this.isPunct(t, '?')) {
      if (this.context !== 'state')
        throw new ExprFailure('"? :" only exists in a computed state (e.g. all(tasks, state = done) ? done : active) — it is not a general expression', t.pos)
      this.next()
      const thenOp = this.parseBranch()
      this.expectPunct(':', 'between the two states of "? :"')
      const elseOp = this.parseBranch()
      const end = this.peek()
      if (end.k !== 'eof') throw new ExprFailure(`unexpected ${describeTok(end)} after the second state of "? :"`, end.pos)
      return { t: 'ternary', cond: e, then: thenOp, else: elseOp, pos: e.pos }
    }
    if (t.k !== 'eof') {
      throw new ExprFailure(t.k === 'ident' ? `unexpected "${t.v}" — join conditions with "and" / "or"` : `unexpected ${describeTok(t)}`, t.pos)
    }
    return e
  }

  private parseBranch(): Operand {
    const t = this.next()
    if (t.k === 'ident' && !this.isPunct(this.peek(), '.') && !this.isPunct(this.peek(), '(')) return { t: 'name', name: t.v, pos: t.pos }
    if (t.k === 'str') return { t: 'str', value: t.v, pos: t.pos }
    throw new ExprFailure(`each side of "? :" is a state name, found ${describeTok(t)}`, t.pos)
  }

  private parseOr(): Expr {
    const first = this.parseAnd()
    const items = [first]
    while (this.isKw(this.peek(), 'or')) {
      this.next()
      items.push(this.parseAnd())
    }
    return items.length === 1 ? first : { t: 'or', items, pos: first.pos }
  }

  private parseAnd(): Expr {
    const first = this.parseCmp()
    const items = [first]
    while (this.isKw(this.peek(), 'and')) {
      this.next()
      items.push(this.parseCmp())
    }
    return items.length === 1 ? first : { t: 'and', items, pos: first.pos }
  }

  private parseCmp(): Expr {
    const t = this.peek()
    if (this.isPunct(t, '(')) {
      this.next()
      const e = this.parseOr()
      this.expectPunct(')', 'to close the parenthesis')
      return e
    }
    if (t.k === 'eof') throw new ExprFailure('the expression ends where a condition was expected', t.pos)
    const left = this.parseOperand('field')
    const n = this.peek()
    if (n.k === 'op') {
      this.next()
      const right = this.parseOperand('value')
      return { t: 'cmp', op: n.v as CmpOp, left, right, pos: left.pos }
    }
    if (this.isKw(n, 'in')) {
      this.next()
      this.expectPunct('[', 'after "in"')
      const values: Array<{ value: string | number; pos: number }> = [this.parseListValue()]
      while (this.isPunct(this.peek(), ',')) {
        this.next()
        values.push(this.parseListValue())
      }
      this.expectPunct(']', 'to close the list')
      return { t: 'in', left, values, pos: left.pos }
    }
    if (this.isKw(n, 'is')) {
      this.next()
      const h = this.next()
      if (!this.isKw(h, 'human')) throw new ExprFailure(`"is" is only followed by "human" (owner is human), found ${describeTok(h)}`, h.pos)
      return { t: 'isHuman', operand: left, pos: left.pos }
    }
    if (this.isKw(n, 'startsWith')) {
      this.next()
      const s = this.next()
      if (s.k !== 'str') throw new ExprFailure(`startsWith takes a quoted text (notes startsWith 'Dropped:'), found ${describeTok(s)}`, s.pos)
      return { t: 'startsWith', operand: left, prefix: s.v, pos: left.pos }
    }
    // an operand alone: a yes/no field or an aggregator — never a literal,
    // `now` or `since`, which say nothing on their own
    if (left.t === 'field' || left.t === 'all' || left.t === 'any' || left.t === 'max') return { t: 'value', operand: left, pos: left.pos }
    throw new ExprFailure(
      `${n.k === 'eof' ? 'the expression ends' : `found ${describeTok(n)}`} where a comparison was expected (=, !=, <, <=, >, >=, in, is human, startsWith)`,
      n.pos,
    )
  }

  private parseListValue(): { value: string | number; pos: number } {
    const t = this.next()
    if (t.k === 'str') return { value: t.v, pos: t.pos }
    if (t.k === 'num') return { value: Number(t.v), pos: t.pos }
    if (this.isPunct(t, '-') && this.peek().k === 'num') {
      const nt = this.next()
      return { value: -Number(nt.v), pos: t.pos }
    }
    if (t.k === 'ident') {
      if (this.isPunct(this.peek(), '.')) throw new ExprFailure(`a list holds values (states, texts, numbers), not field paths — "${t.v}." is a path`, t.pos)
      return { value: t.v, pos: t.pos }
    }
    throw new ExprFailure(`expected a value in the list, found ${describeTok(t)}`, t.pos)
  }

  private parsePath(first: Tok): string[] {
    const path = [first.v]
    while (this.isPunct(this.peek(), '.')) {
      this.next()
      const seg = this.next()
      if (seg.k !== 'ident') throw new ExprFailure(`expected a field name after ".", found ${describeTok(seg)}`, seg.pos)
      path.push(seg.v)
    }
    return path
  }

  private parseOperand(position: 'field' | 'value'): Operand {
    const t = this.next()
    if (t.k === 'str') return { t: 'str', value: t.v, pos: t.pos }
    if (t.k === 'num') return { t: 'num', value: Number(t.v), pos: t.pos }
    if (this.isPunct(t, '-') && this.peek().k === 'num') {
      const nt = this.next()
      return { t: 'num', value: -Number(nt.v), pos: t.pos }
    }
    if (t.k === 'dur') throw new ExprFailure(`a duration (${t.v}) only follows "now +" or "now -"`, t.pos)
    if (t.k !== 'ident') throw new ExprFailure(`expected a field, a value, now or since(…), found ${describeTok(t)}`, t.pos)

    if (t.v === 'now' && !this.isPunct(this.peek(), '.')) {
      const sign = this.peek()
      if (this.isPunct(sign, '+') || this.isPunct(sign, '-')) {
        this.next()
        const d = this.next()
        if (d.k !== 'dur') throw new ExprFailure(`"now ${sign.v}" needs a duration like 7d, 48h or 30m, found ${describeTok(d)}`, d.pos)
        const ms = Number(d.v.slice(0, -1)) * DURATION_MS[d.v.slice(-1)]!
        return { t: 'now', offsetMs: sign.v === '+' ? ms : -ms, pos: t.pos }
      }
      return { t: 'now', offsetMs: 0, pos: t.pos }
    }
    if (t.v === 'since' && this.isPunct(this.peek(), '(')) {
      this.next()
      const s = this.next()
      if (s.k !== 'ident' && s.k !== 'str') throw new ExprFailure(`since(…) takes a state name, found ${describeTok(s)}`, s.pos)
      this.expectPunct(')', 'to close since(…)')
      return { t: 'since', state: s.v, pos: t.pos }
    }
    if (t.v === 'monthStart' && !this.isPunct(this.peek(), '.')) return { t: 'monthStart', pos: t.pos }
    if (AGGREGATORS.has(t.v) && this.isPunct(this.peek(), '(')) return this.parseAggregator(t)

    const path = this.parsePath(t)
    if (position === 'value' && path.length === 1) return { t: 'name', name: path[0]!, pos: t.pos }
    return { t: 'field', path, pos: t.pos }
  }

  private parseAggregator(t: Tok): Operand {
    if (t.v === 'count' || t.v === 'sum')
      throw new ExprFailure(
        `${t.v} is a pulse aggregator — declare it in surfaces.pulse.aggregate${t.v === 'sum' ? ' (with field)' : ''}, not inside an expression`,
        t.pos,
      )
    if (this.inAggregator > 0) throw new ExprFailure(`one level only: ${t.v}(…) cannot sit inside another aggregator`, t.pos)
    if (this.context === 'predicate')
      throw new ExprFailure(
        `aggregators (${t.v}) only live in computed fields and pulse — not in a predicate; declare a computed field and use its name here`,
        t.pos,
      )
    this.next() // (
    if (t.v === 'all' || t.v === 'any') {
      const name = t.v
      const c = this.next()
      if (c.k !== 'ident') throw new ExprFailure(`${name}(…) starts with the children or refs it looks at (${name}(tasks, …)), found ${describeTok(c)}`, c.pos)
      if (this.isPunct(this.peek(), '.')) throw new ExprFailure(`${name}(…) looks at direct children or refs by their name, not at a path`, this.peek().pos)
      this.expectPunct(',', `after "${c.v}" — ${name}(${c.v}, <condition>)`)
      this.inAggregator++
      const pred = this.parseOr()
      this.inAggregator--
      this.expectPunct(')', `to close ${name}(…)`)
      return { t: name, coll: c.v, pred, pos: t.pos }
    }
    // max
    const args: Array<{ path: string[]; pos: number }> = []
    for (;;) {
      const a = this.next()
      if (a.k !== 'ident') throw new ExprFailure(`max(…) takes fields (max(threads.lastMessageAt, openedAt)), found ${describeTok(a)}`, a.pos)
      args.push({ path: this.parsePath(a), pos: a.pos })
      if (this.peek().k === 'ellipsis') this.next() // `threads.lastMessageAt…` = every child's value; the marker is optional
      if (this.isPunct(this.peek(), ',')) {
        this.next()
        continue
      }
      break
    }
    this.expectPunct(')', 'to close max(…)')
    return { t: 'max', args, pos: t.pos }
  }
}

function errorAt(message: string, pos: number): ExprError {
  return { message, pos, column: pos + 1 }
}

// Parse an expression for the place it is written in: 'predicate' (layer 1
// only), 'computed' (layer 1 + all/max), 'state' (computed + one root `? :`).
export function parse(expr: string, context: ExprContext = 'predicate'): ParseResult {
  if (typeof expr !== 'string') return { ok: false, error: errorAt('an expression must be a text', 0) }
  try {
    return { ok: true, ast: new Parser(tokenize(expr), context).parseRoot() }
  } catch (e) {
    if (e instanceof ExprFailure) return { ok: false, error: errorAt(e.message, e.pos) }
    throw e
  }
}

// ── the field dictionary of a kind ──────────────────────────────────────────

export interface FieldInfo {
  type: string // a catalog type (string, timestamp, money, actor, refs, …) or 'state' / 'computed'
  values?: string[] // the closed set it takes: the kind's states, a oneOf, a refs' sub-kind…
  refsOf?: string // refs(<sub-kind>)
}

export interface FieldDict {
  kind: string // qualified for messages: 'case', 'plan/task'
  subKind?: string // the sub-kind's own name ('task') when this is a sub-kind
  fields: Record<string, FieldInfo>
  computed: Record<string, { ast: Expr | null; context: ExprContext; boolean: boolean }>
  collections: Record<string, FieldDict> // children by collection name: 'tasks' → plan/task
  parent?: FieldDict
  // labelOverrides, parsed: a state READ differently under a predicate
  labelOverrides: Array<{ when: string; ast: Expr | null; label: string }>
  // roles.task: the fields that are the task's owner,
  // dependencies, wait, next check and conversations — the kernel computes
  // waiting / gate / stalled / stalledCause / stalledBy from them
  // (task-flow.ts), at request time
  task?: TaskRole
}

export interface ExprIssue {
  where: string // e.g. 'plan/task computed.ready'
  message: string
  pos: number
  column: number
}

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const strOf = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

function fieldInfoOf(spec: unknown): FieldInfo {
  const s = isObj(spec) ? spec : {}
  const type = strOf(s.type) ?? 'string'
  const refs = /^refs\(([a-z][a-z0-9_-]*)\)$/.exec(type)
  if (refs) return { type: 'refs', refsOf: refs[1]! }
  const info: FieldInfo = { type }
  if (Array.isArray(s.oneOf)) info.values = s.oneOf.filter((x): x is string => typeof x === 'string')
  return info
}

// The names a kind (or sub-kind) declares: its envelope (id, identity, state,
// at, updatedBy unless declared absent), the raw fields the envelope maps
// (status, lastActivityAt…), its fields, its computed fields and its role
// fields. A predicate may reference exactly these (plus parent.<…> in a
// sub-kind and the children of its collections inside an aggregator).
function declare(dict: FieldDict, spec: Json, issues: ExprIssue[]): void {
  const env = isObj(spec.envelope) ? spec.envelope : {}
  const states = Array.isArray(spec.states) ? spec.states.map((s) => (isObj(s) ? strOf(s.value) : undefined)).filter((v): v is string => v !== undefined) : []
  dict.fields.id = { type: 'string' }
  dict.fields.identity = { type: 'string' }
  const idSpec = isObj(env.id) ? env.id : {}
  if (strOf(idSpec.field)) dict.fields[idSpec.field as string] = { type: 'string' }
  const stSpec = isObj(env.state) ? env.state : null
  if (stSpec) {
    dict.fields.state = { type: 'state', values: states }
    if (strOf(stSpec.field)) dict.fields[stSpec.field as string] = { type: 'state', values: states }
  }
  const atSpec = isObj(env.at) ? env.at : null
  if (atSpec || dict.parent) dict.fields.at = { type: 'timestamp' }
  if (atSpec && strOf(atSpec.field)) dict.fields[atSpec.field as string] = { type: 'timestamp' }
  const ubSpec = isObj(env.updatedBy) ? env.updatedBy : null
  if (ubSpec && ubSpec.absent !== 'unknown') {
    const values = Array.isArray(ubSpec.values) ? ubSpec.values.filter((x): x is string => typeof x === 'string') : undefined
    dict.fields.updatedBy = values ? { type: 'actor', values } : { type: 'actor' }
    if (strOf(ubSpec.field)) dict.fields[ubSpec.field as string] = dict.fields.updatedBy
  }
  const fields = isObj(spec.fields) ? spec.fields : {}
  for (const [name, f] of Object.entries(fields)) dict.fields[name] = fieldInfoOf(f)
  const computed = isObj(spec.computed) ? spec.computed : {}
  for (const [name, src] of Object.entries(computed)) {
    if (typeof src !== 'string') continue
    const r = parse(src, 'computed')
    if (!r.ok) issues.push({ where: `${dict.kind} computed.${name}`, ...r.error })
    dict.computed[name] = { ast: r.ok ? r.ast : null, context: 'computed', boolean: r.ok ? isBooleanExpr(r.ast) : false }
    dict.fields[name] = { type: 'computed' }
  }
  for (const o of Array.isArray(spec.labelOverrides) ? spec.labelOverrides : []) {
    if (!isObj(o) || typeof o.when !== 'string' || typeof o.label !== 'string') continue
    const r = parse(o.when, 'predicate')
    if (!r.ok) issues.push({ where: `${dict.kind} labelOverrides`, ...r.error })
    dict.labelOverrides.push({ when: o.when, ast: r.ok ? r.ast : null, label: o.label })
  }
  // roles.task: the kernel-computed names join the dictionary, typed
  const roles = isObj(spec.roles) ? spec.roles : {}
  if (isObj(roles.task)) {
    const t = roles.task
    const name = (k: string): string | undefined => (typeof t[k] === 'string' && t[k] !== '' ? (t[k] as string) : undefined)
    dict.task = {
      owner: name('owner') ?? '',
      dependsOn: name('dependsOn') ?? '',
      ...(name('waitingOn') ? { waitingOn: name('waitingOn')! } : {}),
      ...(name('nextCheckAt') ? { nextCheckAt: name('nextCheckAt')! } : {}),
      ...(name('conversations') ? { conversations: name('conversations')! } : {}),
      ...(name('releases') ? { releases: name('releases')! } : {}),
    }
    dict.fields.waiting = { type: 'boolean' }
    dict.fields.gate = { type: 'boolean' }
    dict.fields.stalled = { type: 'boolean' }
    dict.fields.stalledCause = { type: 'string', values: [...STALLED_CAUSES] }
    dict.fields.stalledBy = { type: 'string' }
    dict.fields.waitsOnHuman = { type: 'boolean' }
    // A1.6: a wait on an agent, the owner's to relay for now
    dict.fields.waitsOnRelay = { type: 'boolean' }
    // (task-flow.ts): the owner's turn to start its agent · ready, nobody on it
    dict.fields.waitsStart = { type: 'boolean' }
    dict.fields.idle = { type: 'boolean' }
  }
  // a computed STATE (plans: derived from the children) is the value of `state`
  if (stSpec && typeof stSpec.computed === 'string') {
    const r = parse(stSpec.computed, 'state')
    if (!r.ok) issues.push({ where: `${dict.kind} envelope.state.computed`, ...r.error })
    dict.computed.state = { ast: r.ok ? r.ast : null, context: 'state', boolean: false }
  }
}

function isBooleanExpr(e: Expr): boolean {
  if (e.t === 'value') return e.operand.t === 'all' || e.operand.t === 'any'
  return e.t !== 'ternary'
}

// Build the dictionary of a manifest kind and its sub-kinds. `issues` are the
// computed fields that do not parse (the validator also runs
// validateDictionary over the result for references and cycles).
export function dictionaryForKind(name: string, kindSpec: unknown): { dict: FieldDict; issues: ExprIssue[] } {
  const spec = isObj(kindSpec) ? kindSpec : {}
  const issues: ExprIssue[] = []
  const dict: FieldDict = { kind: name, fields: {}, computed: {}, collections: {}, labelOverrides: [] }
  declare(dict, spec, issues)
  declareSubKinds(dict, spec, issues, 1)
  // a task role names fields the kind declares (its collections count)
  for (const d of dictionariesUnder(dict)) {
    if (!d.task) continue
    if (d.task.owner === '' || d.task.dependsOn === '')
      issues.push({ where: `${d.kind} roles.task`, message: 'roles.task needs owner and dependsOn', pos: 0, column: 1 })
    for (const [k, v] of Object.entries(d.task)) {
      if (v !== '' && !(v in d.fields))
        issues.push({ where: `${d.kind} roles.task`, message: `roles.task.${k} names ${v}, which ${d.kind} does not declare`, pos: 0, column: 1 })
    }
  }
  return { dict, issues }
}

// How deep sub-kinds nest: a record's children (a plan's
// tasks) and THEIR children (a task's notes[] and conversations[]) — never a
// third level (the validator refuses one in plain words; nothing reads it).
export const MAX_SUBKIND_DEPTH = 2

function declareSubKinds(dict: FieldDict, spec: Json, issues: ExprIssue[], depth: number): void {
  if (depth > MAX_SUBKIND_DEPTH) return
  const subs = isObj(spec.subKinds) ? spec.subKinds : {}
  for (const [subName, subSpec] of Object.entries(subs)) {
    if (!isObj(subSpec)) continue
    const coll = (strOf(subSpec.path) ?? subName).replace(/\[\]$/, '')
    const child: FieldDict = { kind: `${dict.kind}/${subName}`, subKind: subName, fields: {}, computed: {}, collections: {}, labelOverrides: [], parent: dict }
    declare(child, subSpec, issues)
    dict.collections[coll] = child
    dict.fields[coll] = { type: 'children' }
    declareSubKinds(child, subSpec, issues, depth + 1)
  }
}

// a dictionary and every sub-kind under it, depth first
export function dictionariesUnder(dict: FieldDict): FieldDict[] {
  return [dict, ...Object.values(dict.collections).flatMap((c) => dictionariesUnder(c))]
}

// Static checks over every computed field of a dictionary (and its
// sub-kinds): references declared, and no computed field depending on itself.
export function validateDictionary(dict: FieldDict): ExprIssue[] {
  const issues: ExprIssue[] = []
  const all = dictionariesUnder(dict)
  for (const d of all) {
    for (const [name, c] of Object.entries(d.computed)) {
      if (!c.ast) continue
      for (const i of validateExpression(c.ast, d, c.context))
        issues.push({ ...i, where: `${d.kind} ${name === 'state' && c.context === 'state' ? 'envelope.state.computed' : `computed.${name}`}` })
    }
    for (const o of d.labelOverrides) {
      if (!o.ast) continue
      for (const i of validateExpression(o.ast, d, 'predicate')) issues.push({ ...i, where: `${d.kind} labelOverrides` })
    }
    // cycles: a computed that (transitively) references itself never settles
    const refs = (n: string): string[] => {
      const c = d.computed[n]
      return c?.ast ? namesReferenced(c.ast).filter((x) => x in d.computed) : []
    }
    for (const start of Object.keys(d.computed)) {
      const stack = [...refs(start)]
      const seen = new Set<string>()
      while (stack.length > 0) {
        const n = stack.pop()!
        if (n === start) {
          issues.push({
            where: `${d.kind} computed.${start}`,
            message: `${start} depends on itself — a computed field cannot reference itself, directly or through another`,
            pos: 0,
            column: 1,
          })
          break
        }
        if (seen.has(n)) continue
        seen.add(n)
        stack.push(...refs(n))
      }
    }
  }
  return issues
}

// Same-record names an expression reads (not inside aggregators' children,
// not parent.) — for the cycle check, and for the validator's «is this
// condition dispatchable» (which fields can make it change).
export function namesReferenced(e: Expr): string[] {
  const out: string[] = []
  const op = (o: Operand): void => {
    if (o.t === 'field' && o.path[0] !== 'parent') out.push(o.path[0]!)
    else if (o.t === 'name') out.push(o.name)
    else if (o.t === 'max') for (const a of o.args) out.push(a.path[0]!)
    else if (o.t === 'all' || o.t === 'any') out.push(o.coll)
  }
  const walk = (x: Expr): void => {
    switch (x.t) {
      case 'or':
      case 'and':
        x.items.forEach(walk)
        break
      case 'cmp':
        op(x.left)
        op(x.right)
        break
      case 'in':
      case 'isHuman':
      case 'startsWith':
        op(x.t === 'in' ? x.left : x.operand)
        break
      case 'value':
        op(x.operand)
        break
      case 'ternary':
        walk(x.cond)
        break
    }
  }
  walk(e)
  return out
}

// ── static validation of one expression ─────────────────────────────────────

const STRINGISH = new Set(['string', 'email', 'url', 'path', 'attachment', 'actor', 'state'])
const MONEY_PARTS = new Set(['amount', 'currency'])

interface Resolved {
  info: FieldInfo
  dict: FieldDict
  label: string
}

// Every field the expression references must be declared by the kind (or by
// its parent through `parent.`, or by its children inside an aggregator);
// literals compared against a closed field (state, oneOf) must be one of its
// values; `is human` only over actor fields; a bare operand only for yes/no.
export function validateExpression(ast: Expr, dict: FieldDict, context: ExprContext = 'predicate'): Array<{ message: string; pos: number; column: number }> {
  const issues: Array<{ message: string; pos: number; column: number }> = []
  const fail = (message: string, pos: number): void => {
    issues.push(errorAt(message, pos))
  }

  const resolve = (path: string[], d: FieldDict, pos: number): Resolved | null => {
    let cur = d
    let segs = path
    while (segs[0] === 'parent') {
      if (!cur.parent) {
        fail(`${cur.kind} has no parent — parent. only works in a sub-kind`, pos)
        return null
      }
      cur = cur.parent
      segs = segs.slice(1)
      if (segs.length === 0) {
        fail('parent. must be followed by a field (parent.at)', pos)
        return null
      }
    }
    const head = segs[0]!
    const info = cur.fields[head]
    if (!info) {
      fail(`${head} is not a field of ${cur.kind} — declare it in fields (or fix the name)`, pos)
      return null
    }
    if (segs.length === 1) return { info, dict: cur, label: path.join('.') }
    if (info.type === 'money' && segs.length === 2 && MONEY_PARTS.has(segs[1]!)) {
      return { info: { type: segs[1] === 'amount' ? 'number' : 'string' }, dict: cur, label: path.join('.') }
    }
    fail(
      `${path.join('.')} goes inside ${head}, which has no part "${segs.slice(1).join('.')}"${info.type === 'money' ? ' (money has amount and currency)' : ''}`,
      pos,
    )
    return null
  }

  const literalAgainst = (target: Resolved | null, value: string | number, pos: number): void => {
    if (!target?.info.values || typeof value !== 'string') return
    if (target.info.values.includes(value)) return
    const what = target.info.type === 'state' ? `${target.dict.kind}'s states` : `the values of ${target.label}`
    fail(`${value} is not one of ${what} (${target.info.values.join(', ')})`, pos)
  }

  // the operand as a field (or null when it is a literal / clock / aggregator)
  const operandField = (o: Operand, d: FieldDict): Resolved | null | 'literal' => {
    if (o.t === 'field') return resolve(o.path, d, o.pos)
    if (o.t === 'name') return d.fields[o.name] ? resolve([o.name], d, o.pos) : 'literal'
    if (o.t === 'since') {
      const st = d.fields.state
      if (!st) fail(`since(${o.state}) needs a kind with states — ${d.kind} has none`, o.pos)
      else if (st.values && !st.values.includes(o.state))
        fail(`since(${o.state}): ${o.state} is not one of ${d.kind}'s states (${st.values.join(', ')})`, o.pos)
      return null
    }
    if (o.t === 'all' || o.t === 'any') {
      checkAll(o, d)
      return null
    }
    if (o.t === 'max') {
      checkMax(o, d)
      return null
    }
    return null
  }

  const checkAll = (o: Extract<Operand, { t: 'all' | 'any' }>, d: FieldDict): void => {
    const child = d.collections[o.coll]
    if (child) {
      walk(o.pred, child)
      return
    }
    const info = d.fields[o.coll]
    if (info?.type === 'refs') {
      const target = info.refsOf === d.subKind ? d : Object.values(d.parent?.collections ?? {}).find((c) => c.subKind === info.refsOf)
      if (!target) {
        fail(`${o.coll} refers to ${info.refsOf}, which is not a sub-kind next to ${d.kind}`, o.pos)
        return
      }
      walk(o.pred, target)
      return
    }
    fail(`${o.t}(${o.coll}, …) needs children or refs — ${o.coll} is ${info ? `a ${info.type} field` : `not a field`} of ${d.kind}`, o.pos)
  }

  const checkMax = (o: Extract<Operand, { t: 'max' }>, d: FieldDict): void => {
    for (const a of o.args) {
      const child = d.collections[a.path[0]!]
      if (child && a.path.length === 2) {
        resolve([a.path[1]!], child, a.pos)
        continue
      }
      if (child) {
        fail(`max(${a.path.join('.')}) — name one field of the children (${a.path[0]}.<field>)`, a.pos)
        continue
      }
      resolve(a.path, d, a.pos)
    }
  }

  const walk = (e: Expr, d: FieldDict): void => {
    switch (e.t) {
      case 'or':
      case 'and':
        e.items.forEach((x) => walk(x, d))
        return
      case 'cmp': {
        const l = operandField(e.left, d)
        const r = operandField(e.right, d)
        const asLiteral = (o: Operand, res: typeof l): string | null => (o.t === 'str' ? o.value : o.t === 'name' && res === 'literal' ? o.name : null)
        const rl = asLiteral(e.right, r)
        const ll = asLiteral(e.left, l)
        if (l && l !== 'literal' && rl !== null) literalAgainst(l, rl, e.right.pos)
        if (r && r !== 'literal' && ll !== null) literalAgainst(r, ll, e.left.pos)
        return
      }
      case 'in': {
        const l = operandField(e.left, d)
        if (l && l !== 'literal') for (const v of e.values) literalAgainst(l, v.value, v.pos)
        return
      }
      case 'isHuman': {
        const l = operandField(e.operand, d)
        if (l && l !== 'literal' && l.info.type !== 'actor') fail(`is human only works on an actor field — ${l.label} is ${l.info.type}`, e.pos)
        return
      }
      case 'startsWith': {
        const l = operandField(e.operand, d)
        if (l && l !== 'literal' && !STRINGISH.has(l.info.type)) fail(`startsWith works on text — ${l.label} is ${l.info.type}`, e.pos)
        return
      }
      case 'value': {
        const o = e.operand
        if (o.t === 'all' || o.t === 'any' || o.t === 'max') {
          operandField(o, d)
          if (o.t === 'max' && context === 'predicate') fail('max(…) is a value, not a condition', o.pos)
          return
        }
        const l = operandField(o, d)
        if (!l || l === 'literal') return
        const isBool = l.info.type === 'boolean' || (l.info.type === 'computed' && l.dict.computed[l.label.split('.').pop()!]?.boolean === true)
        // the root of a computed field may be a plain value (max(…) or a field)
        if (!isBool && !(context !== 'predicate' && e === ast)) fail(`${l.label} is not a yes/no field — compare it (${l.label} = …)`, e.pos)
        return
      }
      case 'ternary': {
        walk(e.cond, d)
        for (const b of [e.then, e.else]) {
          const v = b.t === 'name' ? b.name : b.t === 'str' ? b.value : null
          const st = d.fields.state
          if (v !== null && st?.values && !st.values.includes(v)) fail(`${v} is not one of ${d.kind}'s states (${st.values.join(', ')})`, b.pos)
        }
        return
      }
    }
  }
  walk(ast, dict)
  return issues
}

// Parse + validate in one call: the validator's per-expression step.
export function checkExpression(expr: string, dict: FieldDict, context: ExprContext = 'predicate'): Array<{ message: string; pos: number; column: number }> {
  const r = parse(expr, context)
  if (!r.ok) return [r.error]
  return validateExpression(r.ast, dict, context)
}

// ── evaluation ──────────────────────────────────────────────────────────────

export type EvalRecord = Record<string, unknown>

export interface EvalEnv {
  now: number // epoch ms — the clock enters predicates (timer re-evaluation)
  dict?: FieldDict // the kind's dictionary: types (timestamps compare as time) and computed fields
  parent?: EvalRecord // for parent.<field>
  children?: Record<string, EvalRecord[]> // children by collection name (else record[<collection>])
  siblings?: EvalRecord[] // the records next to this one inside the parent (refs resolve by id)
  // epoch ms when THIS record last entered <state>, from the transition
  // journal; null before the first observation (the predicate is then false)
  since?: (record: EvalRecord, state: string) => number | null
  // ONLY a rotation's `when` with `undated: "old"` (plans 0.5.2): a since(…)
  // with no recorded transition (null — the journal's baseline) counts as
  // long ago. Everywhere else since null stays false: the language never invents
  sinceUndatedIsOld?: boolean
  // true when the value resolves to an agent id (`is human` = it does not)
  isAgent?: (value: string) => boolean
  // this record's collections that are NOT whole (a child could not be read):
  // all(…) over one of them can't be vouched for → false
  partial?: ReadonlySet<string>
  // the live facts a task's flow reads (task-flow.ts) — request time only;
  // absent: nothing is live and nobody wakes
  taskEnv?: TaskEnv
  // the record's key, when the caller has it: a task's flow asks the wake on
  // its way BY it (task-flow.ts wakeOnTheWay — A1.9), as
  // flowOf does; absent, by the owner and the task's id in any plan. It is
  // THIS record's: a child's, a sibling's or a parent's env never carries it
  key?: string
  // the record's silo location (voice.ts KindRecord.location): a task's flow
  // judges its owner against it (owner-outside-project). Absent: not judged
  location?: string
  // (E6) the ids of the siblings the parent's file holds
  // that the reader could not build — the task flow's (voice.ts KindRecord)
  unreadableSiblings?: readonly string[]
}

interface Val {
  v: unknown
  time: boolean
}

const MISSING = (v: unknown): boolean => v === undefined || v === null
const toTime = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v !== '') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : t
  }
  return null
}

function getPath(rec: EvalRecord | undefined, path: string[]): unknown {
  let cur: unknown = rec
  for (const seg of path) {
    if (!isObj(cur)) return undefined
    cur = cur[seg]
  }
  return cur
}

class Evaluator {
  // computed fields currently being evaluated (a guard: validateDictionary
  // rejects cycles, this keeps an unvalidated one from recursing forever)
  private active = new Set<string>()

  field(path: string[], rec: EvalRecord, env: EvalEnv): Val {
    let dict = env.dict
    let target: EvalRecord | undefined = rec
    let segs = path
    let parentEnv: EvalEnv = env
    while (segs[0] === 'parent') {
      target = parentEnv.parent
      dict = dict?.parent
      segs = segs.slice(1)
      parentEnv = { now: env.now } // a parent's own parent is out of reach (one level)
    }
    const head = segs[0]!
    // the task flow's names, computed by the kernel over the record and its
    // siblings (never read from the file)
    if (dict?.task && target === rec && segs.length === 1 && TASK_FLOW_NAMES.has(head)) {
      const f = taskFlow(rec, env.siblings ?? [], dict, env)
      return { v: f[head as keyof typeof f], time: false }
    }
    const comp = dict?.computed[head]
    if (comp?.ast && target) {
      const key = `${dict!.kind}.${head}`
      if (this.active.has(key)) return { v: undefined, time: false }
      this.active.add(key)
      try {
        const ctxEnv: EvalEnv =
          target === rec ? env : { ...env, dict, parent: undefined, children: undefined, siblings: undefined, key: undefined, unreadableSiblings: undefined }
        const v = this.expr(comp.ast, target, ctxEnv)
        return { v: segs.length > 1 ? getPath(isObj(v) ? v : undefined, segs.slice(1)) : v, time: false }
      } finally {
        this.active.delete(key)
      }
    }
    const v = getPath(target, segs)
    const info = segs.length === 1 ? dict?.fields[head] : undefined
    return { v, time: info?.type === 'timestamp' }
  }

  operand(o: Operand, rec: EvalRecord, env: EvalEnv): Val {
    switch (o.t) {
      case 'field':
        return this.field(o.path, rec, env)
      case 'name':
        return env.dict?.fields[o.name] ? this.field([o.name], rec, env) : { v: o.name, time: false }
      case 'str':
        return { v: o.value, time: false }
      case 'num':
        return { v: o.value, time: false }
      case 'now':
        return { v: env.now + o.offsetMs, time: true }
      case 'since': {
        const at = env.since?.(rec, o.state) ?? null
        return { v: at === null && env.sinceUndatedIsOld === true ? 0 : at, time: true }
      }
      case 'monthStart': {
        const d = new Date(env.now)
        return { v: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), time: true }
      }
      case 'all':
        return { v: this.all(o, rec, env), time: false }
      case 'any':
        return { v: this.any(o, rec, env), time: false }
      case 'max':
        return this.max(o, rec, env)
    }
  }

  private childrenOf(coll: string, rec: EvalRecord, env: EvalEnv): EvalRecord[] {
    const list = env.children?.[coll] ?? rec[coll]
    return Array.isArray(list) ? list.filter(isObj) : []
  }

  // true when every child (or referenced sibling) satisfies pred — vacuously
  // true over none; a ref that names no sibling can't be vouched for → false.
  private all(o: Extract<Operand, { t: 'all' }>, rec: EvalRecord, env: EvalEnv): boolean {
    const dict = env.dict
    const childDict = dict?.collections[o.coll]
    const info = dict?.fields[o.coll]
    // children: a declared collection, or — with no dictionary to say — a
    // list of objects; refs: a list of sibling ids
    const raw = env.children?.[o.coll] ?? rec[o.coll]
    const looksLikeChildren = info === undefined && Array.isArray(raw) && raw.length > 0 && raw.every(isObj)
    if (childDict || looksLikeChildren) {
      if (env.partial?.has(o.coll)) return false
      const kids = this.childrenOf(o.coll, rec, env)
      const childEnv: EvalEnv = { ...env, dict: childDict, parent: rec, siblings: kids, children: undefined, partial: undefined, key: undefined }
      return kids.every((k) => this.truthy(this.expr(o.pred, k, childEnv)))
    }
    // refs: ids of siblings
    const ids = rec[o.coll]
    if (!Array.isArray(ids)) return MISSING(ids) // no refs written = nothing to wait for
    const sibDict = info?.refsOf && info.refsOf !== dict?.subKind ? Object.values(dict?.parent?.collections ?? {}).find((c) => c.subKind === info.refsOf) : dict
    const sibs = env.siblings ?? []
    return ids.every((id) => {
      const s = sibs.find((x) => x.id === id)
      return s !== undefined && this.truthy(this.expr(o.pred, s, { ...env, dict: sibDict, key: undefined }))
    })
  }

  // true when SOME child (or referenced sibling) satisfies pred — vacuously
  // FALSE over none. Over partial children a child read and matching is
  // proof; no match is never vouched for (false, like all: never invents).
  // A ref naming no sibling never counts.
  private any(o: Extract<Operand, { t: 'any' }>, rec: EvalRecord, env: EvalEnv): boolean {
    const dict = env.dict
    const childDict = dict?.collections[o.coll]
    const info = dict?.fields[o.coll]
    const raw = env.children?.[o.coll] ?? rec[o.coll]
    const looksLikeChildren = info === undefined && Array.isArray(raw) && raw.length > 0 && raw.every(isObj)
    if (childDict || looksLikeChildren) {
      const kids = this.childrenOf(o.coll, rec, env)
      const childEnv: EvalEnv = { ...env, dict: childDict, parent: rec, siblings: kids, children: undefined, partial: undefined, key: undefined }
      return kids.some((k) => this.truthy(this.expr(o.pred, k, childEnv)))
    }
    const ids = rec[o.coll]
    if (!Array.isArray(ids)) return false
    const sibDict = info?.refsOf && info.refsOf !== dict?.subKind ? Object.values(dict?.parent?.collections ?? {}).find((c) => c.subKind === info.refsOf) : dict
    const sibs = env.siblings ?? []
    return ids.some((id) => {
      const s = sibs.find((x) => x.id === id)
      return s !== undefined && this.truthy(this.expr(o.pred, s, { ...env, dict: sibDict, key: undefined }))
    })
  }

  private max(o: Extract<Operand, { t: 'max' }>, rec: EvalRecord, env: EvalEnv): Val {
    let best: { t: number; raw: unknown } | null = null
    const consider = (raw: unknown): void => {
      const t = toTime(raw)
      if (t !== null && (best === null || t > best.t)) best = { t, raw }
    }
    for (const a of o.args) {
      const childDict = env.dict?.collections[a.path[0]!]
      const kids = a.path.length === 2 ? this.childrenOf(a.path[0]!, rec, env) : null
      if (kids && (childDict || kids.length > 0)) {
        for (const k of kids) consider(k[a.path[1]!])
        continue
      }
      consider(this.field(a.path, rec, env).v)
    }
    const b = best as { t: number; raw: unknown } | null
    return { v: b === null ? undefined : b.raw, time: true }
  }

  truthy(v: unknown): boolean {
    return v === true
  }

  private compare(op: CmpOp, a: Val, b: Val): boolean {
    if (a.time || b.time) {
      const x = toTime(a.v)
      const y = toTime(b.v)
      if (x === null || y === null) return op === '!=' ? !(x === null && y === null) : false
      return cmpNum(op, x, y)
    }
    if (MISSING(a.v) || MISSING(b.v)) {
      if (op === '=') return MISSING(a.v) && MISSING(b.v)
      if (op === '!=') return !(MISSING(a.v) && MISSING(b.v))
      return false
    }
    if (typeof a.v === 'number' && typeof b.v === 'number') return cmpNum(op, a.v, b.v)
    const numA = typeof a.v === 'number' ? a.v : typeof a.v === 'string' && typeof b.v === 'number' && a.v.trim() !== '' ? Number(a.v) : NaN
    const numB = typeof b.v === 'number' ? b.v : typeof b.v === 'string' && typeof a.v === 'number' && b.v.trim() !== '' ? Number(b.v) : NaN
    if (!Number.isNaN(numA) && !Number.isNaN(numB)) return cmpNum(op, numA, numB)
    if (isObj(a.v) || isObj(b.v) || Array.isArray(a.v) || Array.isArray(b.v)) return op === '!='
    const x = String(a.v)
    const y = String(b.v)
    switch (op) {
      case '=':
        return x === y
      case '!=':
        return x !== y
      case '<':
        return x < y
      case '<=':
        return x <= y
      case '>':
        return x > y
      case '>=':
        return x >= y
    }
  }

  expr(e: Expr, rec: EvalRecord, env: EvalEnv): unknown {
    switch (e.t) {
      case 'or':
        return e.items.some((x) => this.truthy(this.expr(x, rec, env)))
      case 'and':
        return e.items.every((x) => this.truthy(this.expr(x, rec, env)))
      case 'cmp':
        return this.compare(e.op, this.operand(e.left, rec, env), this.operand(e.right, rec, env))
      case 'in': {
        const l = this.operand(e.left, rec, env)
        if (MISSING(l.v)) return false
        return e.values.some((x) => this.compare('=', l, { v: x.value, time: false }))
      }
      case 'isHuman': {
        const v = this.operand(e.operand, rec, env).v
        return typeof v === 'string' && v.trim() !== '' && !(env.isAgent?.(v) ?? false)
      }
      case 'startsWith': {
        const v = this.operand(e.operand, rec, env).v
        return typeof v === 'string' && v.startsWith(e.prefix)
      }
      case 'value':
        return this.operand(e.operand, rec, env).v
      case 'ternary': {
        const branch = this.truthy(this.expr(e.cond, rec, env)) ? e.then : e.else
        return branch.t === 'name' ? branch.name : branch.t === 'str' ? branch.value : undefined
      }
    }
  }
}

function cmpNum(op: CmpOp, x: number, y: number): boolean {
  switch (op) {
    case '=':
      return x === y
    case '!=':
      return x !== y
    case '<':
      return x < y
    case '<=':
      return x <= y
    case '>':
      return x > y
    case '>=':
      return x >= y
  }
}

// The value of an expression for one record: a boolean for predicates, the
// computed value (a state, a timestamp…) for computed fields.
export function evaluate(ast: Expr, record: EvalRecord, env: EvalEnv): unknown {
  return new Evaluator().expr(ast, record, env)
}

// A predicate's verdict — only `true` is true (a missing value never
// satisfies a condition: the language never invents).
export function test(ast: Expr, record: EvalRecord, env: EvalEnv): boolean {
  return evaluate(ast, record, env) === true
}

// ── pulse aggregators: count and sum(<money>) ───────────────────────────────
// Over the records the caller hands in (the LIVE records of the kind, already
// filtered by pulse.when — the kernel decides liveness from `terminal`).

export interface Money {
  amount: number
  currency: string
}

export function isMoney(v: unknown): v is Money {
  return isObj(v) && typeof v.amount === 'number' && Number.isFinite(v.amount) && typeof v.currency === 'string' && v.currency.trim() !== ''
}

export function count(records: readonly unknown[]): number {
  return records.length
}

// One total per currency — currencies are NEVER mixed. A value that is not a
// normalized {amount, currency} is not guessed at: it is counted in
// `skipped` so the surface can say so.
export function sum(records: readonly EvalRecord[], field: string): { totals: Money[]; skipped: number } {
  const by = new Map<string, number>()
  let skipped = 0
  for (const r of records) {
    const v = getPath(r, field.split('.'))
    if (!isMoney(v)) {
      skipped++
      continue
    }
    const cur = v.currency.trim().toUpperCase()
    by.set(cur, (by.get(cur) ?? 0) + v.amount)
  }
  const totals = [...by.entries()]
    .map(([currency, amount]) => ({ currency, amount: Math.round(amount * 1e6) / 1e6 }))
    .sort((a, b) => a.currency.localeCompare(b.currency))
  return { totals, skipped }
}
