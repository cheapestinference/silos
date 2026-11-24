import { describe, expect, it } from 'vitest'
import { aggregateTools } from '../src/tools-aggregate.js'

describe('aggregateTools', () => {
  it('sums counts for the same (server,name) across different agents and merges agentIds', () => {
    const out = aggregateTools([
      { agentId: 'a1', tools: [{ name: 'Bash', server: null, count: 3 }] },
      { agentId: 'a2', tools: [{ name: 'Bash', server: null, count: 5 }] },
    ])
    expect(out).toEqual([{ name: 'Bash', server: null, count: 8, agentIds: ['a1', 'a2'] }])
  })

  it('the same name on different MCP servers is NOT merged', () => {
    const out = aggregateTools([
      { agentId: 'a1', tools: [{ name: 'search', server: 'notion', count: 1 }] },
      { agentId: 'a1', tools: [{ name: 'search', server: 'stripe', count: 1 }] },
    ])
    expect(out).toHaveLength(2)
    expect(out.map((t) => t.server).sort()).toEqual(['notion', 'stripe'])
  })

  it('sorts by count desc, and by name on ties', () => {
    const out = aggregateTools([
      {
        agentId: 'a1',
        tools: [
          { name: 'Zeta', server: null, count: 1 },
          { name: 'Bash', server: null, count: 9 },
          { name: 'Alfa', server: null, count: 1 },
        ],
      },
    ])
    expect(out.map((t) => t.name)).toEqual(['Bash', 'Alfa', 'Zeta'])
  })

  it('an agent does not repeat its own id even if it uses the tool several times', () => {
    const out = aggregateTools([
      { agentId: 'a1', tools: [{ name: 'Bash', server: null, count: 1 }] },
      { agentId: 'a1', tools: [{ name: 'Bash', server: null, count: 1 }] },
    ])
    expect(out[0]!.agentIds).toEqual(['a1'])
    expect(out[0]!.count).toBe(2)
  })

  it('no entries → an empty list', () => {
    expect(aggregateTools([])).toEqual([])
  })
})
