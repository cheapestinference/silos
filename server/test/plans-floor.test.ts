// plans-floor.ts — the floor's questions to the built-in Plans silo (plans
// phase 1, B2): the tasks that wake an agent, a mission's progress (authored
// plans outside every folder read by path, G12), the Graph's humans.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planProgressOf, readyTasksOf } from '../src/plans-floor.js'
import { plansSiloOf } from './helpers/plans-silo.js'

let base: string
let proj: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'plans-floor-'))
  proj = join(base, 'proj')
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const isAgent = (v: string): boolean => ['writer', 'finance'].includes(v)
const NOW = Date.parse('2026-11-03T12:00:00Z')
function plan(folder: string, slug: string, tasks: unknown[], mtime: number, over: Record<string, unknown> = {}): string {
  mkdirSync(join(folder, 'plans'), { recursive: true })
  const f = join(folder, 'plans', `${slug}.plan.json`)
  writeFileSync(f, JSON.stringify({ title: slug, updatedAt: '2026-11-01', tasks, ...over }))
  utimesSync(f, new Date(mtime), new Date(mtime))
  return f
}
const t = (id: string, owner: string, status: string, over: Record<string, unknown> = {}) => ({ id, title: `T ${id}`, owner, status, dependsOn: [], ...over })

describe('readyTasksOf — what wakes an agent', () => {
  it("the owner's ready tasks per plan file, with the conversation each names (conversations[]; a loose `conversation` names none)", () => {
    plan(
      proj,
      'a',
      [
        t('1', 'writer', 'pending', { conversations: ['6ad8e4db-a440-43c5-95c3-270bec2043df'] }),
        t('2', 'writer', 'in_progress', { conversation: 'ses_abcdefgh' }),
        t('6', 'writer', 'in_progress', { conversations: [{ session: 'ses_abcdefgh' }] }),
        t('3', 'finance', 'pending'),
        t('4', 'writer', 'pending', { dependsOn: ['3'] }),
        t('5', 'writer', 'done'),
      ],
      NOW,
    )
    plan(proj, 'b', [t('9', 'writer', 'in_review'), t('8', 'writer', 'blocked', { waitingOn: { owner: 'sam', action: 'sign' } })], NOW)
    const r = readyTasksOf(plansSiloOf([proj], isAgent, NOW), proj, 'writer', { now: NOW, isAgent })
    expect(r).toEqual([{ file: 'a.plan.json', readyTaskIds: ['1', '2', '6'], conversations: { 1: '6ad8e4db-a440-43c5-95c3-270bec2043df', 6: 'ses_abcdefgh' } }])
  })
})

describe("planProgressOf — the newest plan, the folder's and the authored ones", () => {
  it('the newest by mtime; an authored plan in a folder no agent lives in is read by path (G12)', () => {
    plan(proj, 'old', [t('1', 'writer', 'done'), t('2', 'writer', 'pending')], NOW - 60_000)
    const silo = plansSiloOf([proj], isAgent, NOW)
    expect(planProgressOf(silo, proj, [], { now: NOW })).toEqual({ done: 1, total: 2 })
    const outside = plan(join(base, 'elsewhere'), 'mine', [t('1', 'writer', 'done'), t('2', 'writer', 'done'), t('3', 'writer', 'cancelled')], NOW)
    expect(planProgressOf(silo, proj, [outside], { now: NOW })).toEqual({ done: 2, total: 3 })
    // gone, or not a plan file: ignored
    expect(planProgressOf(silo, proj, [join(base, 'nope.plan.json'), join(base, 'x.md')], { now: NOW })).toEqual({ done: 1, total: 2 })
  })
  it('no plan: null; a newest plan that does not read: null — never a fake zero', () => {
    expect(planProgressOf(plansSiloOf([proj]), proj, [], { now: NOW })).toBeNull()
    plan(proj, 'ok', [t('1', 'writer', 'done')], NOW - 60_000)
    mkdirSync(join(proj, 'plans'), { recursive: true })
    const bad = join(proj, 'plans', 'bad.plan.json')
    writeFileSync(bad, '{nope')
    utimesSync(bad, new Date(NOW), new Date(NOW))
    expect(planProgressOf(plansSiloOf([proj]), proj, [], { now: NOW })).toBeNull()
  })
})
