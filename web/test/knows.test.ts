// knows.test.ts — the Knows derivation: each item's scope mapped onto the
// four-scope vocabulary, and skillWhere never claiming what is not so.
import { describe, expect, it } from 'vitest'
import { contextItems, skillWhere } from '../src/lib/knows'
import type { SkillCatalogEntry } from '../src/lib/types'

// honesty, not wording: a turned-off folder copy whose personal twin still
// loads never claims that no engine sees it, and only a personal skill is
// described as personal
describe('skillWhere — never a false claim about what loads', () => {
  it('held with a personal twin that still loads is not described like a plain held skill', () => {
    const plain = skillWhere({ state: 'held' })
    const twin = skillWhere({ state: 'held', stillLoads: 'personal' })
    expect(twin).not.toBe(plain)
    expect(twin).not.toMatch(/no engine sees it/)
  })
  it('a plugin, folder or held skill is never described as personal (a plugin skill once read «Personal»)', () => {
    for (const s of [{ source: 'project', state: 'active' }, { source: 'plugin', state: 'active', plugin: 'silos' }, { state: 'held' }, {}] as Parameters<
      typeof skillWhere
    >[0][]) {
      expect(skillWhere(s)).not.toMatch(/Personal/)
    }
  })
})
import type { ContextFile } from '../src/lib/types'

function ctx(name: string, scope: ContextFile['scope'], mtime = 1000): ContextFile {
  return { name, rel: name, folder: '/p', path: `/p/context/${name}`, scope, size: 10, mtime, kind: 'text' }
}

describe('contextItems', () => {
  it('shared → project and agent → agent, keeping the original word as rawScope', () => {
    const items = contextItems({ shared: [ctx('brief.md', 'shared', 7)], agent: [ctx('mine.md', 'agent', 8)] })
    expect(items).toEqual([
      { kind: 'context', name: 'brief.md', scope: 'project', rawScope: 'shared', path: '/p/context/brief.md', mtime: 7, rel: 'brief.md', folder: '/p' },
      { kind: 'context', name: 'mine.md', scope: 'agent', rawScope: 'agent', path: '/p/context/mine.md', mtime: 8, rel: 'mine.md', folder: '/p' },
    ])
  })
})

// origin, not place: a skill Silos could add does not come from the
// project before it is added — its own origin, the Silos platform
describe('skillRows — what Silos could add is never the project’s', () => {
  it('state available → owner silos, whatever its source; a held folder copy stays the project’s', async () => {
    const { skillRows } = await import('../src/components/knows/KnowsLibrary')
    const catalog: SkillCatalogEntry[] = [
      { name: 'loop', source: 'silos', state: 'available' },
      { name: 'team-plan', source: 'project', state: 'available' },
      { name: 'dormant', source: 'project', state: 'held' },
    ]
    const rows = skillRows({ catalog } as unknown as Parameters<typeof skillRows>[0])
    const available = rows.filter((r) => r.skill?.state === 'available')
    expect(available).toHaveLength(2)
    expect(available.every((r) => r.owner === 'silos')).toBe(true)
    expect(rows.find((r) => r.title === 'dormant')?.owner).toBe('project')
  })
})
