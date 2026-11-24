import { makeOpenCodeDb } from './helpers/opencode-db.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentRegistry } from '../src/agent-registry.js'
import { ephemeralPrefix } from '../src/ephemeral.js'
import { OpenCodeReader } from '../src/harnesses/opencode/reader.js'

// R10: OpenCode's own checklist (`todowrite` → the `todo`
// table) is the conversation's Checklist, read through the existing reader.
// cancelled is omitted; no rows → null. Synthetic rows in a throwaway DB.
const T0 = 1776984076759
let base: string, dataDir: string, db: ReturnType<typeof makeOpenCodeDb>, globalDb: ReturnType<typeof makeOpenCodeDb>
const readers: OpenCodeReader[] = []

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'opencode-todo-'))
  dataDir = join(base, 'data')
  mkdirSync(join(dataDir, 'agents', 'writer'), { recursive: true })
  writeFileSync(
    join(dataDir, 'agents.json'),
    JSON.stringify({ agents: [{ id: 'writer', name: 'Writer', role: 'writer', folder: '/home/u/proj', framework: 'opencode' }] }),
  )
  db = makeOpenCodeDb(join(dataDir, 'agents', 'writer'))
  db.insertSession({ id: 'ses_1', project_id: 'p_1', directory: '/home/u/proj', title: 't', version: '1.14.22', time_created: T0, time_updated: T0 + 1000 })
  db.insertMessage({ id: 'msg_1', session_id: 'ses_1', time_created: T0 + 10, data: { role: 'user', agent: 'build', time: { created: T0 + 10 } } })
  mkdirSync(join(base, 'global'))
  globalDb = makeOpenCodeDb(join(base, 'global'))
})
afterEach(() => {
  for (const r of readers.splice(0)) r.close()
  db.close()
  globalDb.close()
  rmSync(base, { recursive: true, force: true })
})

async function ctx() {
  const registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  const r = new OpenCodeReader({ dataDir, registry, globalDb: globalDb.path, muted: [], ephemeralPrefix: ephemeralPrefix() })
  readers.push(r)
  await r.init()
  return r.getContext('-home-u-proj', 'ses_1')!
}

describe('OpenCode — the Checklist from the todo table', () => {
  it('no rows → no plan', async () => {
    expect((await ctx()).plan).toBeNull()
  })

  it('one row', async () => {
    db.insertTodo({ session_id: 'ses_1', content: 'Write the parser', status: 'in_progress', position: 0 })
    expect((await ctx()).plan).toEqual({
      tasks: [{ id: '0', subject: 'Write the parser', status: 'in_progress', createdAt: '', agents: [] }],
      done: 0,
      total: 1,
    })
  })

  it('n rows in position order, states mapped, cancelled omitted', async () => {
    db.insertTodo({ session_id: 'ses_1', content: 'Third', status: 'pending', position: 2 })
    db.insertTodo({ session_id: 'ses_1', content: 'First', status: 'completed', position: 0 })
    db.insertTodo({ session_id: 'ses_1', content: 'Dropped', status: 'cancelled', position: 1 })
    db.insertTodo({ session_id: 'ses_1', content: 'Fourth', status: 'in_progress', position: 3 })
    const plan = (await ctx()).plan!
    expect(plan.tasks.map((t) => [t.subject, t.status])).toEqual([
      ['First', 'completed'],
      ['Third', 'pending'],
      ['Fourth', 'in_progress'],
    ])
    expect(plan.done).toBe(1)
    expect(plan.total).toBe(3)
  })

  it('only cancelled rows → no plan', async () => {
    db.insertTodo({ session_id: 'ses_1', content: 'Dropped', status: 'cancelled', position: 0 })
    expect((await ctx()).plan).toBeNull()
  })
})
