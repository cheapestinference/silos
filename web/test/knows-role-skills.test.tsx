// Role skills on the agent page: a catalog entry
// whose plugin IS the agent id is the agent's OWN — its own group and the
// agent owner — while any other plugin skill stays the machine's.
import { describe, expect, it } from 'vitest'
import { skillRows } from '../src/components/knows/KnowsLibrary'
import type { KnowsSources } from '../src/components/knows/KnowsAnatomy'

const src = {
  catalog: [
    { name: 'invoices', description: 'Ledgerly close', source: 'plugin', plugin: 'finance', state: 'active' },
    { name: 'brainstorming', source: 'plugin', plugin: 'superpowers', state: 'active' },
    { name: 'team-plan', source: 'project', state: 'active' },
  ],
} as unknown as KnowsSources

describe('skillRows — role skills', () => {
  it("the agent's own plugin groups as role skills, owned by the agent", () => {
    const rows = skillRows(src, 'finance')
    const role = rows.find((r) => r.title === 'invoices')!
    expect(role.group).toBe('From Agent — role skills')
    expect(role.owner).toBe('agent')
    const machine = rows.find((r) => r.title === 'brainstorming')!
    expect(machine.group).toBe('From This machine — plugins')
    expect(machine.owner).toBe('you')
    const folder = rows.find((r) => r.title === 'team-plan')!
    expect(folder.owner).toBe('project')
  })
  it('without an agent id nothing is claimed as a role skill', () => {
    const rows = skillRows(src)
    expect(rows.find((r) => r.title === 'invoices')!.group).toBe('From This machine — plugins')
  })
})
