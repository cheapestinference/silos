// silo-check (silos/check.ts): the author kit's checker — JSON in plain
// words, then the REAL validator's findings, then the consequences the
// install dialog derives, rendered as text.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { checkSilo, renderCheck, runSiloCheck } from '../src/silos/check.js'
import { validateSilo } from '../src/silos/validator.js'
import { HOUSE_DIMENSIONS, dimensions, nativeWords } from '../src/silos/native.js'
import { siloFile } from './helpers/silo-manifests.js'

type Json = Record<string, any>
const NOW = Date.parse('2026-11-02T12:00:00Z')
const REPO = join(import.meta.dirname, '..', '..')

// the guide's minimal silo (docs/standard/authoring.md), trimmed from invoices
const MINIMAL: Json = {
  apiVersion: 'silo-standard/v0',
  metadata: { id: 'invoices-lite', version: '0.1.0', name: 'Invoices', description: 'Sales invoices an agent keeps; the overdue ones come to the owner' },
  spec: {
    producer: {
      role: 'finance',
      instructions: {
        summary: 'Keep one file per sales invoice under silos/invoices-lite/, named by its id.',
        protocol: ['Re-read a record before you write it; never write over a state the owner set.'],
      },
    },
    sources: [
      {
        id: 'invoices',
        type: 'files',
        root: 'agent-state',
        glob: 'silos/invoices-lite/*.json',
        parser: 'json',
        expects: { cadence: '24h', producer: 'agent' },
      },
    ],
    kinds: {
      invoice: {
        envelope: {
          id: { from: 'filename', mustMatchField: ['id'] },
          identity: { template: '{{number}} · {{customer}}', empty: '{{id}} · {{customer}}' },
          state: { field: 'state' },
          at: { field: 'date' },
          anchors: [{ hub: 'agent', from: 'location' }],
          updatedBy: { field: 'updatedBy', fallback: 'agent' },
        },
        roles: { due: { field: 'due' } },
        states: [
          { value: 'open', label: { one: 'outstanding', many: 'outstanding' } },
          { value: 'paid', label: { one: 'paid', many: 'paid' }, terminal: true },
        ],
        ownerWritable: ['state'],
        fields: {
          number: { type: 'string', optional: true },
          customer: { type: 'string', required: true },
          date: { type: 'timestamp', required: true, granularity: 'day' },
          due: { type: 'timestamp', optional: true, granularity: 'day' },
          total: { type: 'money', required: true },
          reminders: { type: 'number', empty: 0 },
        },
        examples: [
          {
            id: 'inv-0001',
            number: 'F-0001',
            customer: 'Example Co',
            date: '2026-10-02',
            due: '2026-11-01',
            total: { amount: 120.5, currency: 'EUR' },
            reminders: 0,
            state: 'open',
            updatedBy: 'agent',
          },
        ],
      },
    },
    views: [{ id: 'invoices', archetype: 'list', kind: 'invoice', columns: ['identity', 'state', 'total', 'due'], fold: { when: 'state = paid' } }],
    surfaces: {
      pulse: { kind: 'invoice', aggregate: 'sum', field: 'total', when: 'state = open', label: { term: 'outstanding' } },
      'needs-you': [{ when: 'state = open and due < now', urgency: 'due', clears: 'state = paid', actions: ['set-field', 'open', 'message-agent'] }],
    },
    actions: [
      { verb: 'set-field', kind: 'invoice', fields: { state: { writableBy: 'owner' } } },
      { verb: 'message-agent', kind: 'invoice', to: 'producer', templates: ['Chase payment for {{identity}} ({{total}})'] },
      { verb: 'agent-record-write', kind: 'invoice', by: 'producer' },
      { verb: 'open' },
      { verb: 'ack' },
    ],
  },
}
const variant = (edit: (m: Json) => void): string => {
  const m = structuredClone(MINIMAL)
  edit(m)
  return JSON.stringify(m, null, 2)
}

describe('checkSilo', () => {
  it('a valid minimal silo: ok, no findings, the dialog rendered', () => {
    const r = checkSilo(JSON.stringify(MINIMAL), { now: NOW })
    expect(r.findings).toEqual([])
    expect(r.ok).toBe(true)
    const p = r.preview!
    expect(p.title).toBe('Install Invoices 0.1.0?')
    expect(p.basis).toBe('from the 1 example — no records on disk yet')
    expect(p.shows).toEqual([
      { place: 'Home’s pulse', says: 'Invoices: €120.50 outstanding.' },
      { place: 'Needs you · due', says: 'F-0001 · Example Co — outstanding · due Nov 1' },
      { place: 'Its page, a row', says: 'F-0001 · Example Co · outstanding · €120.50 · Nov 1' },
    ])
    expect(p.reads).toEqual([
      "agent-state:silos/invoices-lite · json — every agent's $SILOS_AGENT_STATE/silos/invoices-lite/*.json",
      '  written by an agent, at least every 24h — past that, every slot of the silo says its data is stale',
    ])
    expect(p.writes).toContain('the owner may set state on invoice')
    expect(p.writes).toContain('the producer may change its own records on invoice through the API, with its token')
    expect(p.routing).toEqual([])
    expect(p.automation).toBeNull()
    expect(p.brief).toContain('## Silo you produce: Invoices (invoices-lite)')
  })

  it("reuses the validator, never a copy of it: the preview is the validator's own", () => {
    const r = checkSilo(JSON.stringify(MINIMAL), { now: NOW })
    expect(r.validation).toEqual(validateSilo(MINIMAL, { now: NOW }))
  })

  it("a schema violation: the validator's words, position once, the conformance check named", () => {
    const r = checkSilo(
      variant((m) => {
        m.spec.surfaces['needs-you'][0].urgency = 'urgent'
      }),
      { now: NOW },
    )
    expect(r.ok).toBe(false)
    expect(r.preview).toBeUndefined()
    expect(r.findings).toEqual(['spec.surfaces.needs-you[0].urgency must be one of blocking, due, routine (found "urgent") [conformance §1]'])
  })

  it('a later check keeps its position in front', () => {
    const r = checkSilo(
      variant((m) => {
        m.spec.kinds.invoice.states[1].terminal = false
      }),
      { now: NOW },
    )
    expect(r.findings).toEqual(['spec.kinds.invoice.states: at least one state must be terminal (what counts as done) [conformance §5]'])
  })

  it("invalid JSON: the parser's words with line and column, the validator never runs", () => {
    const r = checkSilo('{\n  "apiVersion": "silo-standard/v0",\n}', { now: NOW })
    expect(r.ok).toBe(false)
    expect(r.validation).toBeUndefined()
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]).toMatch(/^That is not JSON yet — .*line 3 column 1/)
  })

  it('an empty file says so', () => {
    expect(checkSilo('  \n', { now: NOW }).findings).toEqual(['The file is empty — a silo is one JSON object (apiVersion, metadata, spec)'])
  })

  it('audience producer-agent: the routing is said, in the row and on its own line', () => {
    const r = checkSilo(
      variant((m) => {
        Object.assign(m.spec.surfaces['needs-you'][0], { audience: 'producer-agent', urgency: 'routine' })
      }),
      { now: NOW },
    )
    expect(r.ok).toBe(true)
    expect(r.preview!.shows[1]).toEqual({ place: 'Needs you · routine · goes to the producer, not you', says: 'F-0001 · Example Co — outstanding · due Nov 1' })
    expect(r.preview!.routing).toEqual([
      "entry 0 (routine): rows matching «state = open and due < now» go to the agents bound to finance, not to the owner's inbox — Home only counts them, until «state = paid». Approving the manifest grants this; the owner can send an entry back to their own inbox (audienceOff). With no producer bound, the owner keeps the rows.",
    ])
    expect(r.preview!.brief).toContain('These needs-you conditions are YOURS to work (audience: producer-agent)')
  })

  it('an unknown additive field validates and is said as a want', () => {
    const r = checkSilo(
      variant((m) => {
        m.spec.kinds.invoice.colour = 'red'
      }),
      { now: NOW },
    )
    expect(r.ok).toBe(true)
    expect(r.preview!.wants).toEqual(['spec.kinds.invoice.colour'])
    expect(renderCheck(r)).toContain('loads without 1 field this Silos does not know yet: spec.kinds.invoice.colour')
  })

  it('the reference silos validate: a sync with its cadence and requirement, and kernel data', () => {
    const invoices = checkSilo(readFileSync(siloFile('invoices'), 'utf8'), { now: NOW })
    expect(invoices.ok).toBe(true)
    expect(invoices.preview!.automation).toBe(
      'the dialog offers to create «Invoices — Invoicing sync», every 24h, at 00:00 server time — opt-in, run by the first bound producer',
    )
    expect(invoices.preview!.requirements).toEqual([
      "requires the token of the agent bound to finance — the sync reads the owner's changes through the API before writing — checked on the Silos it is installed on (Settings › Territory)",
    ])
    const sys = checkSilo(readFileSync(siloFile('system'), 'utf8'), { now: NOW })
    expect(sys.ok).toBe(true)
    expect(sys.preview!.brief).toBeNull()
    expect(sys.preview!.reads[0]).toMatch(/^kernel:process — /)
    expect(sys.preview!.writes[0]).toMatch(/^Silos itself keeps these records/)
  })
})

describe('runSiloCheck — the CLI', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'silo-check-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('exit 0 on a valid file, 1 on a broken one, 2 without one', () => {
    writeFileSync(join(dir, 'ok.silo.json'), JSON.stringify(MINIMAL))
    writeFileSync(
      join(dir, 'bad.silo.json'),
      variant((m) => {
        delete m.spec.kinds.invoice.examples
      }),
    )
    const out: string[] = []
    const err: string[] = []
    const io = { cwd: dir, out: (s: string) => out.push(s), err: (s: string) => err.push(s), now: NOW }
    expect(runSiloCheck(['ok.silo.json'], io)).toBe(0)
    expect(out.join('\n')).toContain('ok.silo.json: validates against the Silo Standard v0')
    expect(out.join('\n')).toContain('Home’s pulse: Invoices: €120.50 outstanding.')
    out.length = 0
    expect(runSiloCheck(['--', 'bad.silo.json'], io)).toBe(1)
    expect(out.join('\n')).toBe('bad.silo.json: does not validate — 1 finding\n  spec.kinds.invoice is missing examples [conformance §1]')
    expect(runSiloCheck([], io)).toBe(2)
    expect(runSiloCheck(['missing.silo.json'], io)).toBe(1)
    expect(err.at(-1)).toMatch(/^missing\.silo\.json: cannot be read — /)
  })

  // defect: silo-check said «validates» for plans.silo.json
  // though every Silos' door refuses a native id
  it("a native id is refused in the door's own words — though the manifest validates; every house dimension is builtin and checks", () => {
    // since the executions kernelectomy the house serves nothing
    // natively: a fixture table keeps the rule honest
    const native = dimensions([{ id: 'executions', name: 'Executions', served: 'native' }])
    const plansFile = join(REPO, 'docs/standard/reference/plans.silo.json')
    const asExecutions = JSON.parse(readFileSync(plansFile, 'utf8'))
    asExecutions.metadata.id = 'executions'
    const r = checkSilo(JSON.stringify(asExecutions), { now: NOW, dimensions: native })
    expect(r.ok).toBe(false)
    // the id rule lives in the validator (one source for every door): the
    // manifest is sound, its id is what fails — said once, in the door's words
    expect(r.validation?.ok).toBe(false)
    expect(r.validation?.native).toBe(nativeWords('Executions'))
    expect(r.validation?.errors).toEqual([{ check: 2, where: 'metadata.id', message: nativeWords('Executions') }])
    expect(r.findings).toEqual([`${nativeWords('Executions')} — the install door refuses the id "executions", on every Silos`])
    // the house: executions validates AND is accepted, end to end
    const execFile = join(REPO, 'docs/standard/reference/executions.silo.json')
    expect(HOUSE_DIMENSIONS.nativeRefusal('executions')).toBeNull()
    expect(checkSilo(readFileSync(execFile, 'utf8'), { now: NOW })).toMatchObject({ ok: true, findings: [] })
    const out: string[] = []
    expect(runSiloCheck([execFile], { cwd: dir, out: (s) => out.push(s), err: () => {}, now: NOW })).toBe(0)
    expect(out[0]!.split('\n')[0]).toBe(`${execFile}: validates against the Silo Standard v0`)
    // the builtin plans validates AND is accepted
    expect(checkSilo(readFileSync(plansFile, 'utf8'), { now: NOW })).toMatchObject({ ok: true, findings: [] })
    // the builtin support is not native: it still checks (the owner's reinstall door takes it)
    expect(checkSilo(readFileSync(join(REPO, 'docs/standard/reference/support.silo.json'), 'utf8'), { now: NOW }).ok).toBe(true)
    // a fixture table decides
    expect(
      checkSilo(JSON.stringify(MINIMAL), { now: NOW, dimensions: dimensions([{ id: 'invoices-lite', name: 'Invoices', served: 'native' }]) }).findings[0],
    ).toBe(`${nativeWords('Invoices')} — the install door refuses the id "invoices-lite", on every Silos`)
  })

  it('the npm script runs end to end', async () => {
    const file = join(dir, 'bad.silo.json')
    writeFileSync(file, '{"apiVersion": "silo-standard/v0"')
    const run = promisify(execFile)
    const r = await run(join(REPO, 'node_modules', '.bin', 'tsx'), [join(REPO, 'scripts', 'silo-check.ts'), file], { cwd: REPO }).then(
      () => null,
      (e: { code: number; stdout: string }) => e,
    )
    expect(r?.code).toBe(1)
    expect(r?.stdout).toContain('That is not JSON yet')
  }, 30_000)
})
