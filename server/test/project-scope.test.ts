import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OWNERS_DESK, agentsAt, agentsOf, foldersShareProject, knows, mayName, nameFor, ofProject, reaches, sameProject } from '../src/project-scope.js'
import { MASTER_ID } from '../src/agent-registry.js'
import { bearerMayReadKey, bearerMayReadLocation } from '../src/silos/bearer-scope.js'

const builder = { id: 'builder', folder: '/home/user/acme' }
const finance = { id: 'finance', folder: '/home/user/acme/books/' }
const maker = { id: 'maker', folder: '/home/user/beta' }
const scribe = { id: 'scribe', folder: '/home/user/acme/docs', folders: ['/home/user/beta'] }
const web = { id: 'web', folder: '/home/user/acme-web' }
const gone = { id: 'gone', folder: '/home/user/acme', archived: true }
const master = { id: 'master', folder: null }
const loose = { id: 'loose', folder: null }
const all = [builder, finance, maker, scribe, web, gone, master, loose]
const names: Record<string, string> = {
  builder: 'Builder',
  finance: 'Finance',
  maker: 'Maker',
  scribe: 'Scribe',
  web: 'Web',
  gone: 'Gone',
  master: 'Master',
  owner: 'owner',
  Silos: 'Silos',
}
const nameOf = (id: string): string => names[id] ?? id

describe('project-scope', () => {
  it("the owner's desk is the registry's (the leaf keeps its own copy)", () => {
    expect(OWNERS_DESK).toBe(MASTER_ID)
  })
  it('foldersShareProject: some pair nests or is equal; the sibling prefix never', () => {
    expect(foldersShareProject(['/home/user/acme/web'], ['/home/user/beta', '/home/user/acme'])).toBe(true)
    expect(foldersShareProject(['/home/user/acme'], ['/home/user/acme-web'])).toBe(false)
    expect(foldersShareProject([], ['/home/user/acme'])).toBe(false)
  })
  it('sameProject: equal, nested both ways, disjoint, the sibling prefix, a trailing slash', () => {
    expect(sameProject('/home/user/acme', '/home/user/acme')).toBe(true)
    expect(sameProject('/home/user/acme', '/home/user/acme/docs')).toBe(true)
    expect(sameProject('/home/user/acme/docs', '/home/user/acme')).toBe(true)
    expect(sameProject('/home/user/acme/', '/home/user/acme')).toBe(true)
    expect(sameProject('/home/user/acme', '/home/user/beta')).toBe(false)
    expect(sameProject('/home/user/acme', '/home/user/acme-web')).toBe(false)
    expect(sameProject('/', '/home/user/acme')).toBe(false)
    expect(sameProject('acme', 'acme')).toBe(false)
  })
  it('knows: symmetric, not transitive; master, no folder and archived know nobody', () => {
    expect(knows(builder, finance)).toBe(true)
    expect(knows(finance, builder)).toBe(true)
    expect(knows(builder, scribe) && knows(scribe, maker)).toBe(true)
    expect(knows(builder, maker)).toBe(false)
    expect(knows(builder, web)).toBe(false)
    for (const x of [gone, master, loose]) {
      expect(knows(builder, x)).toBe(false)
      expect(knows(x, builder)).toBe(false)
    }
    expect(agentsOf(builder, all).map((a) => a.id)).toEqual(['finance', 'scribe'])
    expect(agentsOf(maker, all).map((a) => a.id)).toEqual(['scribe'])
    expect(agentsOf(master, all)).toEqual([])
  })
  it('ofProject and agentsAt: nesting both ways', () => {
    expect(ofProject(finance, '/home/user/acme')).toBe(true)
    expect(ofProject(builder, '/home/user/acme/books/2026')).toBe(true)
    expect(ofProject(web, '/home/user/acme')).toBe(false)
    expect(agentsAt('/home/user/beta/src', all).map((a) => a.id)).toEqual(['maker', 'scribe'])
    expect(agentsAt('/home/user/other', all)).toEqual([])
  })
  it('membership is the declared text: a .git file or a symlink in a folder changes no answer', () => {
    const root = mkdtempSync(join(tmpdir(), 'scope-'))
    try {
      const a = join(root, 'a')
      const b = join(root, 'b')
      mkdirSync(a)
      mkdirSync(b)
      writeFileSync(join(a, '.git'), `gitdir: ${b}/.git\n`)
      symlinkSync(b, join(a, 'link'))
      const x = { id: 'x', folder: a }
      const y = { id: 'y', folder: b }
      expect(knows(x, y)).toBe(false)
      expect(ofProject(x, b)).toBe(false)
      expect(ofProject(y, join(a, 'link'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('nameFor: known, itself, the owner, Silos, the desk named; an unknown id as written', () => {
    expect(nameFor('builder', 'finance', all, nameOf)).toBe('Finance')
    expect(nameFor('builder', 'builder', all, nameOf)).toBe('Builder')
    expect(nameFor('builder', 'owner', all, nameOf)).toBe('owner')
    expect(nameFor('builder', 'Silos', all, nameOf)).toBe('Silos')
    expect(nameFor('builder', 'master', all, nameOf)).toBe('Master')
    expect(nameFor('builder', 'maker', all, nameOf)).toBe('maker')
    expect(nameFor('builder', 'gone', all, nameOf)).toBe('gone')
    expect(nameFor(null, 'maker', all, nameOf)).toBe('Maker')
    expect(nameFor('master', 'maker', all, nameOf)).toBe('Maker')
    expect(mayName('maker', 'builder', all)).toBe(false)
  })
  it('silo reads by bearer: nesting both ways is one project; a key through a folder around it is judged at its location', () => {
    const terr = (id: string): string[] => (id === 'web' ? ['/repo/web'] : id === 'lead' ? ['/repo'] : [])
    // web (nested) reads the parent's plans, lead the nested folder's
    expect(bearerMayReadLocation('web', 'folder:/repo', terr)).toBe(true)
    expect(bearerMayReadLocation('lead', 'folder:/repo/web', terr)).toBe(true)
    expect(bearerMayReadLocation('web', 'folder:/repo-api', terr)).toBe(false)
    const may = (by: string) => (loc: string) => bearerMayReadLocation(by, loc, terr)
    // a key at or inside its folder: decided from the key alone
    expect(bearerMayReadKey('lead', 'folder:/repo/web/p/tasks/t1', may('lead'))).toBe(true)
    // a key that only passes through a folder around its own: not decided
    // from the text (the location may be a sibling) — the caller looks it up
    expect(bearerMayReadKey('web', 'folder:/repo/p/tasks/t1', may('web'))).toBe(false)
    expect(bearerMayReadKey('web', 'folder:/repo/api/p/tasks/t1', may('web'))).toBe(false)
    expect(bearerMayReadKey('web', 'agent:web/x', may('web'))).toBe(true)
    expect(bearerMayReadKey('web', 'agent:lead/x', may('web'))).toBe(false)
  })
  it('reaches: the owner and the desk everything; an agent its projects', () => {
    expect(reaches(null, '/home/user/beta', all)).toBe(true)
    expect(reaches('master', '/home/user/beta', all)).toBe(true)
    expect(reaches('builder', '/home/user/acme/plans', all)).toBe(true)
    expect(reaches('builder', '/home/user/beta', all)).toBe(false)
    expect(reaches('builder', null, all)).toBe(false)
  })
})
