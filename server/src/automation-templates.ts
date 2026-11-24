// automation-templates.ts — an automation's shape with its specifics left
// blank. A template
// is DATA: a create body for POST /api/automations whose string values may
// hold {{blanks}}; using one fills the blanks and hands the body to the SAME
// create path (routes/automations.ts prepareCreate), so a template can never
// make an automation the API would refuse — authorization included.
//
// Built-ins come with Silos (automation-templates-builtin.ts); the owner's
// live in <dataDir>/automation-templates/<id>.json, written by «Save as
// template» (fromAutomation) or an import. Using one COPIES it: no link back.
//
// Three rules hold for every template, built-in or imported:
// - a blank inside a shell string (a watch's check.command) is a url or a
//   path, single-quoted, and those kinds can never hold a quote;
// - a template never holds a secret — export refuses a body the Vault's
//   redactor would change (it names the variable, never the value);
// - a template that cannot fill into a body the validator accepts is refused
//   when it is saved, not when someone tries to use it.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentRegistry } from './agent-registry.js'
import type { Automation } from './automations-types.js'
import { validateAutomationCreate } from './automations-validate.js'
import { parseArgvLine, promptGist, runWords, triggerWords } from './automation-words.js'
import { redactor } from './command-run.js'
import { atomicWriteJson } from './json-store.js'
import { BUILTIN_TEMPLATES } from './automation-templates-builtin.js'

export const TEMPLATE_KIND = 'silos.automation-template'
export const PARAM_KINDS = ['agent', 'text', 'url', 'path', 'time', 'day', 'command', 'glob'] as const
export type ParamKind = (typeof PARAM_KINDS)[number]

export interface TemplateParam {
  key: string
  kind: ParamKind
  label: string
  placeholder?: string
  default?: string
}

export interface AutomationTemplate {
  kind: typeof TEMPLATE_KIND
  version: 1
  id: string
  name: string
  // the template said in one line, its blanks as {{key}} — the picker draws
  // each blank as the field it asks for
  sentence: string
  description: string
  params: TemplateParam[]
  automation: Record<string, unknown>
}

export interface ListedTemplate extends AutomationTemplate {
  source: 'builtin' | 'user'
  // it execs without Claude (a command run, a shell watch): only the owner
  // may use it — the same line the create route draws
  ownerOnly: boolean
}

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/
const KEY = /^[a-z][a-zA-Z0-9]{0,30}$/
const BLANK = /\{\{([a-z][a-zA-Z0-9]{0,30})(?:\.(h|m))?\}\}/g
const URL_OK = /^https?:\/\/[^\s'"`\\$]+$/
const MAX_TEMPLATE_BYTES = 64 * 1024

export class TemplateError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message)
  }
}

// ---- one blank's value ------------------------------------------------------

export function checkParam(p: TemplateParam, raw: unknown, registry: Pick<AgentRegistry, 'get'>): string {
  const what = p.label || p.key
  if (typeof raw !== 'string' || raw.trim() === '') throw new TemplateError(`fill in ${what}`, p.key)
  const v = raw.trim()
  if (v.includes('\n') || v.includes('\r')) throw new TemplateError(`${what} is one line`, p.key)
  switch (p.kind) {
    case 'agent': {
      const a = registry.get(v)
      if (!a || a.archived) throw new TemplateError(`${what}: no agent ${v}`, p.key)
      return v
    }
    case 'text':
      if (v.length > 200) throw new TemplateError(`${what}: at most 200 characters`, p.key)
      return v
    case 'url':
      if (v.length > 500 || !URL_OK.test(v)) throw new TemplateError(`${what}: an http(s) address, with no spaces or quotes`, p.key)
      return v
    case 'path':
      if (!v.startsWith('/') || v.length > 500 || /['"`\\$]/.test(v)) throw new TemplateError(`${what}: an absolute path, with no quotes`, p.key)
      return v
    case 'time':
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new TemplateError(`${what}: a time as HH:MM`, p.key)
      return v
    case 'day': {
      const n = Number(v)
      if (!Number.isInteger(n) || n < 1 || n > 28) throw new TemplateError(`${what}: a day from 1 to 28`, p.key)
      return String(n)
    }
    case 'command': {
      const parsed = parseArgvLine(v)
      if ('error' in parsed) throw new TemplateError(`${what}: ${parsed.error}`, p.key)
      return v
    }
    case 'glob':
      if (v.length > 200 || v.includes('..')) throw new TemplateError(`${what}: a file pattern like *.pdf`, p.key)
      return v
  }
}

// ---- filling ----------------------------------------------------------------

function substitute(s: string, values: Map<string, string>, params: Map<string, TemplateParam>): string {
  return s.replace(BLANK, (_m, key: string, part?: 'h' | 'm') => {
    const p = params.get(key)
    const v = values.get(key)
    if (!p || v === undefined) throw new TemplateError(`the template has a blank {{${key}}} it never asks for`)
    if (p.kind === 'command') throw new TemplateError(`{{${key}}} is a command: it can only stand alone in an argv`)
    if (part) {
      if (p.kind !== 'time') throw new TemplateError(`{{${key}.${part}}}: only a time has .h and .m`)
      const [h, m] = v.split(':')
      return String(Number(part === 'h' ? h : m))
    }
    return v
  })
}

function fillValue(x: unknown, values: Map<string, string>, params: Map<string, TemplateParam>): unknown {
  if (typeof x === 'string') return substitute(x, values, params)
  if (Array.isArray(x)) {
    const out: unknown[] = []
    for (const item of x) {
      const whole = typeof item === 'string' ? /^\{\{([a-z][a-zA-Z0-9]{0,30})\}\}$/.exec(item) : null
      const p = whole ? params.get(whole[1]!) : undefined
      if (p?.kind === 'command') {
        const parsed = parseArgvLine(values.get(p.key) ?? '')
        if ('error' in parsed) throw new TemplateError(parsed.error, p.key)
        out.push(...parsed.argv)
      } else out.push(fillValue(item, values, params))
    }
    return out
  }
  if (typeof x === 'object' && x !== null) {
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, fillValue(v, values, params)]))
  }
  return x
}

// the create body this template makes with these answers — NOT validated
// here: the caller hands it to the create path, which is the one judge
export function fillTemplate(t: AutomationTemplate, answers: unknown, registry: Pick<AgentRegistry, 'get'>): Record<string, unknown> {
  const given = typeof answers === 'object' && answers !== null && !Array.isArray(answers) ? (answers as Record<string, unknown>) : {}
  const values = new Map<string, string>()
  for (const p of t.params) values.set(p.key, checkParam(p, given[p.key] ?? p.default, registry))
  return fillValue(t.automation, values, new Map(t.params.map((p) => [p.key, p]))) as Record<string, unknown>
}

// ---- a template's own shape -------------------------------------------------

function blanksIn(x: unknown, at: string, out: { key: string; at: string; quoted: boolean; s: string }[]): void {
  if (typeof x === 'string') {
    for (const m of x.matchAll(BLANK)) {
      const i = m.index ?? 0
      out.push({ key: m[1]!, at, quoted: x[i - 1] === "'" && x[i + m[0].length] === "'", s: x })
    }
  } else if (Array.isArray(x)) x.forEach((v, i) => blanksIn(v, `${at}[${i}]`, out))
  else if (typeof x === 'object' && x !== null) for (const [k, v] of Object.entries(x)) blanksIn(v, at ? `${at}.${k}` : k, out)
}

// a sample answer per kind — only to prove the template fills into a valid body
const SAMPLE: Record<ParamKind, string> = {
  agent: 'sample-agent',
  text: 'sample',
  url: 'https://example.com/health',
  path: '/srv/sample',
  time: '06:30',
  day: '5',
  command: '/usr/bin/true',
  glob: '*.pdf',
}
const ANY_AGENT: Pick<AgentRegistry, 'get'> = { get: () => ({ id: 'sample-agent', name: 'Sample', folder: '/srv/sample' }) as ReturnType<AgentRegistry['get']> }

export function checkTemplate(raw: unknown): AutomationTemplate {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new TemplateError('not a template file')
  const o = raw as Record<string, unknown>
  if (o.kind !== TEMPLATE_KIND || o.version !== 1) throw new TemplateError(`not a template file (kind must be ${TEMPLATE_KIND}, version 1)`)
  if (JSON.stringify(o).length > MAX_TEMPLATE_BYTES) throw new TemplateError('the template is too large')
  if (typeof o.id !== 'string' || !ID.test(o.id)) throw new TemplateError('id: lowercase letters, digits and dashes')
  for (const f of ['name', 'sentence'] as const) {
    if (typeof o[f] !== 'string' || (o[f] as string).trim() === '' || (o[f] as string).length > 200) throw new TemplateError(`${f} required (one line)`)
  }
  if (o.description !== undefined && typeof o.description !== 'string') throw new TemplateError('description must be text')
  if (!Array.isArray(o.params)) throw new TemplateError('params must be a list')
  const params: TemplateParam[] = o.params.map((p, i) => {
    const q = (typeof p === 'object' && p !== null ? p : {}) as Record<string, unknown>
    if (typeof q.key !== 'string' || !KEY.test(q.key)) throw new TemplateError(`params[${i}].key: a short camelCase name`)
    if (!(PARAM_KINDS as readonly unknown[]).includes(q.kind)) throw new TemplateError(`params[${i}].kind: one of ${PARAM_KINDS.join(', ')}`)
    if (typeof q.label !== 'string' || q.label.trim() === '') throw new TemplateError(`params[${i}].label required`)
    return {
      key: q.key,
      kind: q.kind as ParamKind,
      label: q.label.trim(),
      ...(typeof q.placeholder === 'string' ? { placeholder: q.placeholder } : {}),
      ...(typeof q.default === 'string' ? { default: q.default } : {}),
    }
  })
  const keys = new Set<string>()
  for (const p of params) {
    if (keys.has(p.key)) throw new TemplateError(`params: ${p.key} twice`)
    keys.add(p.key)
  }
  if (typeof o.automation !== 'object' || o.automation === null || Array.isArray(o.automation))
    throw new TemplateError('automation: the create body, with {{blanks}}')
  const automation = o.automation as Record<string, unknown>
  const trig = automation.trigger as { kind?: unknown } | undefined
  if (trig?.kind === 'webhook') throw new TemplateError('a webhook carries its own secret — it cannot be a template')
  const blanks: { key: string; at: string; quoted: boolean; s: string }[] = []
  blanksIn(automation, '', blanks)
  blanksIn(o.sentence, 'sentence', blanks)
  const kindOf = new Map(params.map((p) => [p.key, p.kind]))
  for (const b of blanks) {
    if (!kindOf.has(b.key)) throw new TemplateError(`${b.at}: the blank {{${b.key}}} is not in params`)
    // a shell string: only a quoted url or path — those kinds can't hold a quote
    if (b.at === 'trigger.check.command') {
      const k = kindOf.get(b.key)
      if ((k !== 'url' && k !== 'path') || !b.quoted)
        throw new TemplateError(`trigger.check.command: a blank in a shell command must be a url or a path inside single quotes ('{{${b.key}}}')`)
    }
  }
  const used = new Set(blanks.filter((b) => b.at !== 'sentence').map((b) => b.key))
  for (const p of params) if (!used.has(p.key)) throw new TemplateError(`params: ${p.key} is never used in the automation`)
  const t: AutomationTemplate = {
    kind: TEMPLATE_KIND,
    version: 1,
    id: o.id,
    name: (o.name as string).trim(),
    sentence: (o.sentence as string).trim(),
    description: typeof o.description === 'string' ? o.description.trim() : '',
    params,
    automation,
  }
  // it must fill into a body the create path accepts
  const sample = Object.fromEntries(params.map((p) => [p.key, p.default ?? SAMPLE[p.kind]]))
  try {
    validateAutomationCreate(fillTemplate(t, sample, ANY_AGENT), ANY_AGENT as AgentRegistry)
  } catch (err) {
    throw new TemplateError(`filled in, it is not a valid automation: ${err instanceof Error ? err.message : String(err)}`)
  }
  return t
}

export function execsWithoutClaude(body: Record<string, unknown>): boolean {
  const run = body.run as { kind?: unknown } | undefined
  const trig = body.trigger as { kind?: unknown; check?: { type?: unknown } } | undefined
  return run?.kind === 'command' || (trig?.kind === 'watch' && trig.check?.type === 'command')
}

// ---- export -----------------------------------------------------------------

export interface Secret {
  id?: string
  name: string
  value: string
} // id: its Vault entry, when it is one

// an automation → a template: the agent becomes the one blank, the rest is
// literal. What is tied to THIS machine's state is left out (the kept
// conversation's id, a pinned account, run history).
export function fromAutomation(a: Automation, opts: { id: string; name?: string; description?: string }, secrets: readonly Secret[]): AutomationTemplate {
  if (a.trigger.kind === 'webhook') throw new TemplateError('a webhook carries its own secret — it cannot be a template')
  const body: Record<string, unknown> = {
    name: a.name,
    agentId: '{{agent}}',
    prompt: a.prompt,
    trigger: a.trigger,
    thread: a.thread.mode === 'keep' ? { mode: 'keep', ...(a.thread.folder ? { folder: a.thread.folder } : {}) } : { mode: 'new' },
    approval: a.approval,
    keepAlive: a.keepAlive,
    ...(a.maxRunsPerDay !== undefined ? { maxRunsPerDay: a.maxRunsPerDay } : {}),
    ...(a.runsOn?.model ? { runsOn: { model: a.runsOn.model } } : {}),
    ...(a.run ? { run: a.run } : {}),
  }
  const text = JSON.stringify(body)
  if (/\{\{[a-z]/.test(JSON.stringify({ ...body, agentId: '' })))
    throw new TemplateError('the automation already holds {{…}} — that text would read as a blank')
  for (const s of secrets) {
    if (redactor([s.value])(text) !== text)
      throw new TemplateError(`it holds the value of ${s.name} — name the variable ($${s.name}) instead of its value, then save it as a template`)
  }
  const name = opts.name?.trim() || a.name
  // said the way Needs you says a proposed automation: when, then what
  const when = triggerWords(a.trigger)
  const what = a.run?.kind === 'command' ? `${runWords(a)}; a failure goes to the agent` : promptGist(a.prompt, 160)
  return checkTemplate({
    kind: TEMPLATE_KIND,
    version: 1,
    id: opts.id,
    name,
    sentence: `{{agent}} runs ${name.slice(0, 120)}`,
    description: opts.description?.trim() || `${when.charAt(0).toUpperCase()}${when.slice(1)}. ${what}`.trim(),
    params: [{ key: 'agent', kind: 'agent', label: 'Who runs it' }],
    automation: body,
  })
}

// a free id from a name: «Watch the API» → watch-the-api, -2… when taken
export function templateIdFrom(name: string, taken: (id: string) => boolean): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'template'
  let id = base
  for (let n = 2; taken(id); n++) id = `${base}-${n}`
  return id
}

// ---- the catalog ------------------------------------------------------------

export class AutomationTemplates {
  readonly dir: string
  private readonly builtins: AutomationTemplate[]

  constructor(
    private readonly dataDir: string,
    builtins: readonly unknown[] = BUILTIN_TEMPLATES,
  ) {
    this.dir = join(dataDir, 'automation-templates')
    // a broken built-in is a bug of ours: fail loudly at boot, in tests first
    this.builtins = builtins.map((b) => checkTemplate(b))
  }

  private users(): AutomationTemplate[] {
    if (!existsSync(this.dir)) return []
    const out: AutomationTemplate[] = []
    for (const f of readdirSync(this.dir)
      .filter((n) => n.endsWith('.json'))
      .sort()) {
      try {
        out.push(checkTemplate(JSON.parse(readFileSync(join(this.dir, f), 'utf8'))))
      } catch {
        /* a hand-edited file that no longer reads is skipped, never fatal */
      }
    }
    return out
  }

  list(): ListedTemplate[] {
    const mark =
      (source: 'builtin' | 'user') =>
      (t: AutomationTemplate): ListedTemplate => ({ ...t, source, ownerOnly: execsWithoutClaude(t.automation) })
    const builtinIds = new Set(this.builtins.map((t) => t.id))
    // the owner's own first: they are what this fleet already runs
    return [
      ...this.users()
        .filter((t) => !builtinIds.has(t.id))
        .map(mark('user')),
      ...this.builtins.map(mark('builtin')),
    ]
  }

  get(id: string): ListedTemplate | null {
    return this.list().find((t) => t.id === id) ?? null
  }

  isBuiltin(id: string): boolean {
    return this.builtins.some((t) => t.id === id)
  }

  // an import or an export — refused over a built-in, and over a user
  // template unless replace
  save(raw: unknown, opts: { replace?: boolean } = {}): ListedTemplate {
    const t = checkTemplate(raw)
    if (this.isBuiltin(t.id)) throw new TemplateError(`${t.id} is a template that comes with Silos — give yours another id`, 'id')
    const file = join(this.dir, `${t.id}.json`)
    if (existsSync(file) && !opts.replace) throw new TemplateError(`a template ${t.id} already exists`, 'id')
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    atomicWriteJson(file, t, { mode: 0o600 })
    return { ...t, source: 'user', ownerOnly: execsWithoutClaude(t.automation) }
  }

  // to the trash, never rm (invariant 3)
  remove(id: string): 'removed' | 'builtin' | 'not-found' {
    if (this.isBuiltin(id)) return 'builtin'
    if (!ID.test(id)) return 'not-found'
    const file = join(this.dir, `${id}.json`)
    if (!existsSync(file)) return 'not-found'
    const trash = join(this.dataDir, 'trash', 'automation-templates')
    mkdirSync(trash, { recursive: true, mode: 0o700 })
    renameSync(file, join(trash, `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`))
    return 'removed'
  }
}
