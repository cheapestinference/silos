// first-run.test.ts — the first-run tour's model (lib/first-run.ts): which
// engines can be chosen, which silos the tour offers and what toggling them
// does, and what Create sends — defaults as absence.
import { describe, expect, it } from 'vitest'
import { agentPayloadExtras, engineRows, siloOps, siloRows, tourSteps, withEngine, worksPayload, worksProblem, type TourChoice } from '../src/lib/first-run'
import { startingSetPatch, type ChosenClass } from '../src/lib/starting-set'
import { unknownDescriptor } from '../src/lib/harnesses'
import type { EngineCompat, HarnessDescriptor, SiloAvailable, SiloDescriptor } from '../src/lib/types'

const engine = (id: string, isDefault: boolean): HarnessDescriptor => ({ ...unknownDescriptor(id), label: id.toUpperCase(), default: isDefault })
const compat = (harness: string, state: EngineCompat['state'], installed: string | null): EngineCompat => ({
  harness,
  name: harness,
  state,
  installed,
  needed: '1.0.0',
  update: null,
  refuses: [],
  message: state === 'ok' ? null : `${harness} isn't installed`,
})
const installed = (id: string, role: string | null): SiloDescriptor =>
  ({ id, name: id, description: `the ${id} silo`, provenance: 'builtin', producer: role ? { role, sync: null } : null }) as unknown as SiloDescriptor
const offer = (id: string, producerRole: string | null): SiloAvailable => ({ id, name: id, description: null, version: '0.1.0', producerRole })
const choice = (o: Partial<TourChoice> = {}): TourChoice => ({ engine: 'alpha', provider: '', silos: {}, ...o })

describe('engineRows', () => {
  it('keeps registration order, recommends the default and refuses an engine this machine cannot run', () => {
    const rows = engineRows([engine('alpha', true), engine('beta', false)], [compat('alpha', 'ok', '2.0.0'), compat('beta', 'missing', null)])
    expect(rows.map((r) => r.id)).toEqual(['alpha', 'beta'])
    expect(rows[0]).toMatchObject({ usable: true, recommended: true, version: '2.0.0', why: null })
    expect(rows[1]).toMatchObject({ usable: false, recommended: false, version: null, why: "beta isn't installed" })
  })
  it('an outdated engine is refused too; one with no verdict is usable', () => {
    const rows = engineRows([engine('alpha', true), engine('beta', false)], [compat('alpha', 'outdated', '0.1.0')])
    expect(rows.map((r) => r.usable)).toEqual([false, true])
  })
})

describe('siloRows', () => {
  it('the recommended silos come included (on, with what each gives up); the catalog offers only the optional silos that need no agent', () => {
    const rows = siloRows(
      [
        { ...installed('plans', 'any-agent'), lineup: 'recommended', loses: 'Tasks go away.' },
        { ...installed('support', 'helpdesk'), lineup: 'optional' },
        { ...installed('system', 'kernel'), lineup: 'recommended' },
        { ...installed('own', null), provenance: null, lineup: null },
      ],
      [offer('hierarchy', null), offer('executions', 'kernel'), offer('helpdesk', 'helpdesk'), offer('crew', 'task-agent'), offer('board', 'any-agent')],
    )
    expect(rows.map((r) => [r.id, r.installed, r.recommended, r.on])).toEqual([
      ['plans', true, true, true],
      ['system', true, true, true],
      ['hierarchy', false, false, false],
      ['executions', false, false, false],
    ])
    expect(rows[0]!.loses).toBe('Tasks go away.')
  })
})

describe('siloOps', () => {
  it('only what changed: an included one off is uninstalled, an offer on is installed', () => {
    const rows = siloRows(
      [
        { ...installed('plans', 'any-agent'), lineup: 'recommended' },
        { ...installed('system', 'kernel'), lineup: 'recommended' },
      ],
      [offer('hierarchy', null), offer('executions', 'kernel')],
    )
    expect(siloOps(rows, { system: false, hierarchy: true, plans: true })).toEqual({ uninstall: ['system'], install: ['hierarchy'] })
    expect(siloOps(rows, {})).toEqual({ uninstall: [], install: [] })
  })
})

describe('choices', () => {
  it('changing the engine drops a provider of the other engine; the same engine keeps it', () => {
    expect(withEngine(choice({ provider: 'key-1' }), 'beta')).toMatchObject({ engine: 'beta', provider: '' })
    expect(withEngine(choice({ provider: 'key-1' }), 'alpha')).toMatchObject({ engine: 'alpha', provider: 'key-1' })
  })
  it('Create sends defaults as absence', () => {
    expect(agentPayloadExtras(choice(), 'alpha')).toEqual({})
    expect(agentPayloadExtras(choice({ engine: 'beta', provider: 'key-1' }), 'alpha')).toEqual({ framework: 'beta', provider: 'key-1' })
  })
})

// how the agent works is asked, never inferred from whether a mission was written
describe('how it works', () => {
  it('on its own needs a mission; when given work it does not', () => {
    expect(worksProblem('own', '', 'Ana')).toEqual(expect.any(String))
    expect(worksProblem('own', 'Keep the books.', 'Ana')).toBeNull()
    expect(worksProblem('told', '', 'Ana')).toBeNull()
  })
  it('a mission on an agent that works when given work is sent as Only when told; otherwise nothing is asked', () => {
    expect(worksPayload('told', 'Keep the books.')).toEqual({ control: 'told' })
    expect(worksPayload('told', '')).toEqual({})
    expect(worksPayload('own', 'Keep the books.')).toEqual({})
  })
})

// what a new project starts with (spec tools-origin §8): a step only for an
// engine that declares classes, and Create saves the set only when it
// differs from Recommended
describe('At start', () => {
  const cls = (id: string, recommended: boolean, chosen?: boolean): ChosenClass => ({
    id,
    what: id,
    from: 'an account',
    recommended,
    ...(chosen !== undefined ? { chosen } : {}),
  })
  const set = [cls('plugins', false), cls('connectors', false), cls('skills', true)]
  it('an engine with no class has the four steps; one with classes gets At start after Runs on', () => {
    expect(tourSteps([]).map((s) => s.id)).toEqual(['who', 'engine', 'runs-on', 'silos'])
    expect(tourSteps(set).map((s) => s.id)).toEqual(['who', 'engine', 'runs-on', 'at-start', 'silos'])
  })
  it('sends nothing while every class is on Recommended — ticked back included', () => {
    expect(startingSetPatch('alpha', set, {})).toBeNull()
    expect(startingSetPatch('alpha', set, { plugins: false, skills: true })).toBeNull()
  })
  it('sends only the classes that differ from Recommended, under the engine', () => {
    expect(startingSetPatch('alpha', set, { connectors: true, skills: false })).toEqual({ alpha: { connectors: true, skills: false } })
  })
  it('a stored choice ticked back to Recommended is taken back (null); one left alone is resent as it is', () => {
    const stored = [cls('plugins', false, true), cls('connectors', false), cls('skills', true, false)]
    expect(startingSetPatch('alpha', stored, { plugins: false })).toEqual({ alpha: { plugins: null, skills: false } })
  })
  it('changing the engine forgets the ticks of the other engine', () => {
    expect(withEngine(choice({ start: { plugins: true } }), 'beta').start).toEqual({})
  })
})
