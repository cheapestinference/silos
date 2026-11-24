// silo-install.test.ts — the install dialog's pure helpers (lib/silo-install):
// they word what the server derived, choose among REAL agents, read the
// server's refusals ahead. None of them derives a consequence.
import { describe, expect, it } from 'vitest'
import {
  actionWord,
  approveBlockers,
  dialogTitle,
  locationWords,
  producerChoices,
  promptGist,
  prose,
  proseList,
  slotPlace,
  splitLocations,
  submissionFor,
  submittedWords,
} from '../src/lib/silo-install'
import type { AgentView, SiloConsequences } from '../src/lib/types'

const agent = (id: string, name: string, over: Partial<AgentView> = {}): AgentView =>
  ({ id, name, emoji: '🤖', archived: false, ...over }) as unknown as AgentView

const derived = (over: Partial<SiloConsequences['derived']> = {}): Pick<SiloConsequences, 'derived'> => ({
  derived: {
    producerRole: 'finance',
    proposedProducers: ['finance'],
    forProducers: ['finance'],
    reads: [],
    slots: [],
    preview: null,
    requirements: [],
    wants: [],
    notes: [],
    errors: [],
    update: null,
    proposedAutomation: null,
    ...over,
  },
})

describe('the words of the dialog', () => {
  it('the action keeps its name: Install / Update / Reinstall, and the title asks it', () => {
    expect(actionWord('install')).toBe('Install')
    expect(actionWord('update')).toBe('Update')
    expect(actionWord('reinstall')).toBe('Reinstall')
    expect(dialogTitle({ kind: 'install', name: 'Support', id: 'support', version: { from: null, to: '0.1.0' } })).toBe('Install Support 0.1.0?')
    expect(dialogTitle({ kind: 'update', name: 'Invoices', id: 'invoices', version: { from: '0.1.0', to: '0.2.0' } })).toBe('Update Invoices 0.1.0 → 0.2.0?')
    expect(dialogTitle({ kind: 'reinstall', name: null, id: 'plans', version: { from: null, to: null } })).toBe('Reinstall plans?')
  })
  it('who submitted it, you when the owner did', () => {
    expect(submittedWords({ submittedBy: 'finance', source: 'draft' })).toContain('finance')
    expect(submittedWords({ submittedBy: 'owner', source: 'body' })).toContain('you')
    expect(submittedWords({ submittedBy: 'owner', source: 'body' })).not.toContain('owner')
  })
  it("the author's prose is quoted only when it is prose", () => {
    expect(prose('Sales invoices')).toBe('Sales invoices')
    expect(prose('  ')).toBeNull()
    expect(prose({ inject: 'x' })).toBeNull()
    expect(proseList(['a', 3, '', 'b', null])).toEqual(['a', 'b'])
    expect(proseList('not a list')).toEqual([])
  })
  it('each slot names where it lands; an unknown slot keeps its own name', () => {
    expect(slotPlace('pulse')).toBe('Home’s pulse')
    expect(slotPlace('needs-you')).toBe('Needs you')
    expect(slotPlace('timeline')).toBe('timeline')
  })
  it('what is on disk at a read location', () => {
    expect(locationWords({ exists: false, files: 0 })).toBe('not there yet')
    expect(locationWords({ exists: true, files: 0 })).toBe('there, no records yet')
    expect(locationWords({ exists: true, files: 1 })).toBe('1 record file')
    expect(locationWords({ exists: true, files: 12 })).toBe('12 record files')
  })
  it("the prompt's gist is its first written line", () => {
    expect(promptGist('\n\nRun the Ledgerly sync of the silo Invoices (invoices) now.\n\nMore')).toBe(
      'Run the Ledgerly sync of the silo Invoices (invoices) now.',
    )
    expect(promptGist('')).toBe('')
  })
})

describe('producer choices', () => {
  it('real agents only — never archived, never the master — the proposed first, then by name', () => {
    const agents = [
      agent('writer', 'Writer'),
      agent('master', 'Master'),
      agent('old', 'Old', { archived: true }),
      agent('finance', 'Finance'),
      agent('builder', 'Builder'),
    ]
    expect(producerChoices(agents, ['builder'])).toEqual([
      { id: 'builder', name: 'Builder', emoji: '🤖', proposed: true },
      { id: 'finance', name: 'Finance', emoji: '🤖', proposed: false },
      { id: 'writer', name: 'Writer', emoji: '🤖', proposed: false },
    ])
  })
})

describe("why Approve is not possible yet — the server's refusals, read ahead", () => {
  it('nothing in the way: empty', () => {
    expect(approveBlockers(derived({ requirements: [{ what: "requires finance's token", agentId: 'finance', met: true }] }), ['finance'])).toEqual([])
  })
  it('no producer bound (unless any agent may write); the unmet requirement in its own words; a manifest that no longer validates', () => {
    expect(
      approveBlockers(
        derived({ requirements: [{ what: 'requires the token of the agent bound to finance — no agent bound yet', agentId: null, met: false }] }),
        [],
      ),
    ).toEqual(['bind the producer role finance to at least one agent'])
    expect(approveBlockers(derived({ producerRole: 'any-agent' }), [])).toEqual([])
    expect(
      approveBlockers(
        derived({ requirements: [{ what: "requires finance's token — finance is archived, so it holds none", agentId: 'finance', met: false }] }),
        ['finance'],
      ),
    ).toEqual(["requires finance's token — finance is archived, so it holds none"])
    expect(approveBlockers(derived({ errors: [{ check: 9, where: 'examples', message: 'the example lacks contactId' }] }), ['finance'])).toEqual([
      'it no longer validates: the example lacks contactId',
    ])
  })
})

describe('the submission for a silo', () => {
  it('found by id, else null', () => {
    const subs = [
      { id: 'support', submittedBy: 'finance', at: '2026-10-31T10:00:00Z', source: 'body' as const, name: 'Support', version: '0.1.0', update: false },
    ]
    expect(submissionFor(subs, 'support')?.name).toBe('Support')
    expect(submissionFor(subs, 'invoices')).toBeNull()
  })
})

describe('the places a source reads', () => {
  it('the ones holding something listed, the empty ones counted apart — order kept', () => {
    const a = { location: 'agent:a', exists: false, files: 0 }
    const b = { location: 'agent:b', exists: true, files: 3 }
    const c = { location: 'agent:c', exists: true, files: 0 }
    expect(splitLocations([a, b, c])).toEqual({ listed: [b, c], quiet: [a] })
    expect(splitLocations([a])).toEqual({ listed: [], quiet: [a] })
  })
})

describe("a kernel source: nobody to bind, data said in the catalog's words", () => {
  it('Install is not blocked by an empty binding when the producer is the kernel', () => {
    const c = { derived: { errors: [], producerRole: 'kernel', requirements: [] } } as unknown as Pick<SiloConsequences, 'derived'>
    expect(approveBlockers(c, [])).toEqual([])
    const files = { derived: { errors: [], producerRole: 'finance', requirements: [] } } as unknown as Pick<SiloConsequences, 'derived'>
    expect(approveBlockers(files, [])).toEqual(['bind the producer role finance to at least one agent'])
  })
})
