// project-reach.test.ts — what the Profile says a change of folders opens
// and closes is the one resolver's answer (project-scope.ts), never a
// private reading: nesting is one project, a sibling prefix is not, and an
// agent already known elsewhere is not «newly» known.
import { describe, expect, it } from 'vitest'
import { folderChange, worksWith } from '../src/lib/project-reach'
import { aroundFolder } from '../src/lib/home'

const a = (id: string, folder: string | null, folders: string[] = [], archived = false) => ({ id, name: id, folder, folders, archived })
const ALL = [
  a('builder', '/home/user/acme'),
  a('finance', '/home/user/acme'),
  a('web', '/home/user/acme/web'),
  a('maker', '/home/user/beta'),
  a('scribe', '/home/user/acme', ['/home/user/beta']),
  a('old', '/home/user/beta', [], true),
  a('sib', '/home/user/acme-web'),
]

describe('worksWith', () => {
  it('lists, per folder, the agents of that project — nested folders included, siblings and the archived not', () => {
    expect(worksWith(ALL[4]!, ALL).map((w) => [w.folder, w.agents.map((x) => x.id)])).toEqual([
      ['/home/user/acme', ['builder', 'finance', 'web']],
      ['/home/user/beta', ['maker']],
    ])
    expect(worksWith(a('desk', null), ALL)).toEqual([])
  })
})

describe('folderChange', () => {
  it('a new project: the agents it will come to know, without those it knows already', () => {
    const c = folderChange(ALL[0]!, { folder: '/home/user/acme', folders: ['/home/user/beta'] }, ALL)
    expect(c?.added.map((x) => [x.folder, x.agents.map((y) => y.id)])).toEqual([['/home/user/beta', ['maker']]])
    expect(c?.removed).toEqual([])
    expect(c?.startsIn).toBe('/home/user/acme')
  })
  it('a folder inside a project it already works in changes nothing', () => {
    expect(folderChange(ALL[0]!, { folder: '/home/user/acme', folders: ['/home/user/acme/docs'] }, ALL)).toBeNull()
  })
  it('a sibling prefix is another project', () => {
    const c = folderChange(ALL[0]!, { folder: '/home/user/acme', folders: ['/home/user/acme-web'] }, ALL)
    expect(c?.added.map((x) => x.agents.map((y) => y.id))).toEqual([['sib']])
  })
  it('leaving a project: who stops knowing it — not one it still shares another project with', () => {
    const c = folderChange(ALL[4]!, { folder: '/home/user/acme', folders: [] }, ALL)
    expect(c?.removed.map((x) => [x.folder, x.agents.map((y) => y.id)])).toEqual([['/home/user/beta', ['maker']]])
    const moved = folderChange(ALL[4]!, { folder: '/home/user/beta', folders: [] }, ALL)
    expect(moved?.removed.map((x) => x.agents.map((y) => y.id))).toEqual([['builder', 'finance', 'web']])
  })
})

describe('aroundFolder — the project page of a nested folder says «from acme»', () => {
  it('an agent of the outer folder is from it; one that works here or deeper is not; a sibling is no member', () => {
    expect(aroundFolder({ folder: '/home/user/acme' }, '/home/user/acme/web')).toBe('/home/user/acme')
    expect(aroundFolder({ folder: '/home/user/acme/web' }, '/home/user/acme/web')).toBeNull()
    expect(aroundFolder({ folder: '/home/user/acme/web/app' }, '/home/user/acme/web')).toBeNull()
    expect(aroundFolder({ folder: '/home/user/beta', folders: ['/home/user/acme'] }, '/home/user/acme/web')).toBe('/home/user/acme')
    expect(aroundFolder({ folder: '/home/user/acme-web' }, '/home/user/acme/web')).toBeNull()
  })
})
