// respondToGate: ONE gesture on a gate of the
// owner's — the gate closes FIRST (its Done judged on the state the owner
// saw, K7), then the text lands as an owner note on each open
// agent task that depends on it directly; a note that fails leaves the gate
// closed and says which waiters miss it, and a repeat writes only those.
// Refused on an agent's task, on a task nothing waits on, and when the
// manifest gives the owner no notes to answer with.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SiloRegistry } from '../src/silos/registry.js'
import { SiloReader } from '../src/silos/reader.js'
import { SiloKernel } from '../src/silos/kernel.js'
import { TransitionJournal } from '../src/silos/journal.js'
import { OverlayStore } from '../src/silos/overlay.js'
import { SiloActions, SiloAcks, SiloEvents, SiloProposals } from '../src/silos/actions.js'
import { respondToGate } from '../src/silos/respond.js'
import type { KindRecord } from '../src/silos/voice.js'

type Json = Record<string, any>
const STATES = ['pending', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled']
const isAgent = (v: string): boolean => ['writer', 'finance'].includes(v)

function manifest(withNotes = true): Json {
  return {
    apiVersion: 'silo-standard/v0',
    metadata: { id: 'worklist', version: '0.1.0', name: 'Worklist', description: 'task fixture' },
    spec: {
      producer: { role: 'writer', instructions: { summary: 'writes plans', protocol: ['one file per plan'] } },
      sources: [{ id: 'plans', type: 'files', root: 'project', glob: 'worklist/*.plan.json', parser: 'json', expects: { producer: 'agent' } }],
      kinds: {
        plan: {
          envelope: {
            id: { from: 'filename' },
            identity: { template: '{{title}}' },
            state: { computed: 'all(tasks, state in [done, cancelled]) ? done : active' },
            at: { field: 'updatedAt' },
            anchors: [{ hub: 'folder', from: 'location' }],
            updatedBy: { absent: 'unknown' },
          },
          states: [
            { value: 'active', label: { one: 'active', many: 'active' } },
            { value: 'done', label: { one: 'done', many: 'done' }, terminal: true },
          ],
          fields: { title: { type: 'string', required: true }, updatedAt: { type: 'timestamp', required: true } },
          unknownFields: 'preserve',
          subKinds: {
            task: {
              path: 'tasks[]',
              envelope: {
                id: { field: 'id' },
                identity: { template: '{{title}}' },
                state: { field: 'status' },
                at: { inherit: 'parent.at' },
                updatedBy: { absent: 'unknown' },
              },
              states: STATES.map((v) => ({ value: v, label: { one: v, many: v }, ...(v === 'done' || v === 'cancelled' ? { terminal: true } : {}) })),
              roles: { task: { owner: 'owner', dependsOn: 'dependsOn' } },
              fields: { owner: { type: 'actor', required: true }, dependsOn: { type: 'refs(task)', withinParent: true } },
              computed: { ready: 'state in [pending, in_progress, blocked] and all(dependsOn, state = done) and waiting = false' },
              ...(withNotes
                ? {
                    subKinds: {
                      note: {
                        path: 'notes[]',
                        appendOnly: true,
                        envelope: { identity: { template: '{{text}}' }, at: { field: 'at', mayBeEmpty: true }, updatedBy: { field: 'by' } },
                        fields: { text: { type: 'string', required: true, max: 8000 } },
                      },
                    },
                  }
                : {}),
            },
          },
          examples: [
            {
              _file: 'a.plan.json',
              title: 'A',
              updatedAt: '2026-11-01',
              tasks: [{ id: 't1', title: 'one', owner: 'writer', status: 'pending', dependsOn: [] }],
            },
          ],
        },
      },
      surfaces: {},
      actions: [
        { verb: 'set-field', subKind: 'plan/task', fields: { status: { writableBy: 'owner' } } },
        ...(withNotes ? [{ verb: 'append-item', subKind: 'plan/task/note', by: ['owner', 'producer'] }] : []),
        { verb: 'open' },
      ],
    },
  }
}

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'silo-respond-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

function setup(m: Json) {
  const dataDir = join(base, 'data')
  mkdirSync(join(dataDir, 'silos', 'registry', 'worklist'), { recursive: true })
  writeFileSync(join(dataDir, 'silos', 'registry', 'worklist', 'silo.json'), JSON.stringify(m))
  const registry = new SiloRegistry({ dataDir, operator: { decisionFor: () => 'approved', slotsOff: () => [] } })
  registry.load()
  const kernel = new SiloKernel({
    registry,
    journal: new TransitionJournal(registry.conventionsDir),
    overlay: new OverlayStore(registry.conventionsDir),
    isAgent,
    reader: new SiloReader({ agentStates: () => [], projects: () => [join(base, 'proj')] }),
  })
  kernel.refresh()
  const actions = new SiloActions({
    registry,
    kernel,
    events: new SiloEvents(registry.root),
    acks: new SiloAcks(registry.root),
    proposals: new SiloProposals(registry.root),
    agentStateBase: join(dataDir, 'agent-state'),
    isAgent,
    agentMayReadLocation: () => false,
  })
  const respond = (recordKey: string, text: string, state: string | null = 'pending', acts: Pick<SiloActions, 'appendItem' | 'taskGesture'> = actions) => {
    kernel.refresh()
    const baseRecs: KindRecord[] = (kernel.reading('worklist')?.records ?? []).map((r) => ({
      rec: r.record,
      anchors: r.anchors as Json,
      key: `${r.location}/${r.record.id}`,
      file: r.file || null,
    }))
    return respondToGate({
      siloId: 'worklist',
      manifest: m,
      base: baseRecs,
      key: recordKey,
      text,
      state,
      actions: acts,
      voice: { now: Date.now(), isAgent },
      isAgent,
    })
  }
  return { actions, kernel, respond }
}
function put(tasks: Json[]): string {
  const f = join(base, 'proj', 'worklist', 'p.plan.json')
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, JSON.stringify({ title: 'P', updatedAt: '2026-11-01', tasks }, null, 2))
  return f
}
const t = (id: string, owner: string, status: string, dependsOn: string[] = []): Json => ({ id, title: `Task ${id}`, owner, status, dependsOn })
const key = (id: string): string => `folder:${join(base, 'proj')}/p/tasks/${id}`

describe('respondToGate', () => {
  it('writes the answer as an owner note on EACH open agent task waiting directly, then closes the gate', () => {
    const f = put([
      t('g', 'sam', 'pending'),
      t('a', 'writer', 'blocked', ['g']),
      t('b', 'finance', 'pending', ['g']),
      t('c', 'writer', 'done', ['g']),
      t('h', 'sam', 'blocked', ['g']),
    ])
    const { respond } = setup(manifest())
    const r = respond(key('g'), 'Option A — the repo lives in acme/silos')
    expect(r.ok).toBe(true)
    expect(r.notified).toEqual([
      { key: key('a'), owner: 'writer' },
      { key: key('b'), owner: 'finance' },
    ])
    const raw = JSON.parse(readFileSync(f, 'utf8'))
    expect(raw.tasks.find((x: Json) => x.id === 'g').status).toBe('done')
    for (const id of ['a', 'b']) {
      const notes = raw.tasks.find((x: Json) => x.id === id).notes
      expect(notes).toHaveLength(1)
      expect(notes[0].by).toBe('owner')
      expect(notes[0].text).toBe('Option A — the repo lives in acme/silos')
    }
    // the done agent task and the HUMAN's dependent task get no note
    for (const id of ['c', 'h']) expect(raw.tasks.find((x: Json) => x.id === id).notes).toBeUndefined()
  })

  it("refuses an agent's task (a person answers their own gate) and a task nothing waits on", () => {
    put([t('g', 'sam', 'pending'), t('a', 'writer', 'blocked', ['g']), t('solo', 'sam', 'pending')])
    const { respond } = setup(manifest())
    const agents = respond(key('a'), 'x')
    expect(agents.ok).toBe(false)
    if (!agents.ok) expect([agents.code, agents.reason.includes('a person answers their own gate')]).toEqual([409, true])
    const solo = respond(key('solo'), 'x')
    expect(solo.ok).toBe(false)
    if (!solo.ok) expect(solo.code).toBe(409)
  })

  it('a manifest with no owner-writable notes refuses before writing anything', () => {
    const f = put([t('g', 'sam', 'pending'), t('a', 'writer', 'blocked', ['g'])])
    const { respond } = setup(manifest(false))
    const r = respond(key('g'), 'x')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe(400)
    const raw = JSON.parse(readFileSync(f, 'utf8'))
    expect(raw.tasks.find((x: Json) => x.id === 'g').status).toBe('pending')
  })

  it("the state the owner saw is not the gate's now: NOTHING is written — the Done is judged first, on what was painted (K7)", () => {
    const f = put([t('g', 'sam', 'in_progress'), t('a', 'writer', 'blocked', ['g'])])
    const { respond } = setup(manifest())
    const r = respond(key('g'), 'answer', 'pending')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect([r.code, r.reason]).toEqual([409, 'it changed — it is in progress now'])
      expect(r.notified).toEqual([])
    }
    const raw = JSON.parse(readFileSync(f, 'utf8'))
    expect(raw.tasks.find((x: Json) => x.id === 'g').status).toBe('in_progress')
    expect(raw.tasks.find((x: Json) => x.id === 'a').notes ?? []).toHaveLength(0)
  })

  it('the gate closes BEFORE the notes (J10.10): each note is written with the gate already done', () => {
    put([t('g', 'sam', 'pending'), t('a', 'writer', 'blocked', ['g'])])
    const { respond, actions, kernel } = setup(manifest())
    const seen: string[] = []
    const spy = {
      taskGesture: (...a: Parameters<SiloActions['taskGesture']>) => {
        seen.push('done')
        return actions.taskGesture(...a)
      },
      appendItem: (...a: Parameters<SiloActions['appendItem']>) => {
        kernel.refresh()
        seen.push(`note:${(kernel.reading('worklist')!.records[0]!.record.tasks as Json[]).find((x) => x.id === 'g')!.state}`)
        return actions.appendItem(...a)
      },
    }
    expect(respond(key('g'), 'answer', 'pending', spy).ok).toBe(true)
    expect(seen).toEqual(['done', 'note:done'])
  })

  it('a note that fails after the close: `closed`, `missing` — and a repeat over the done gate writes only the missing ones (K7)', () => {
    const f = put([t('g', 'sam', 'pending'), t('a', 'writer', 'blocked', ['g']), t('b', 'finance', 'blocked', ['g'])])
    const { respond, actions } = setup(manifest())
    const failing = {
      taskGesture: actions.taskGesture.bind(actions),
      appendItem: (...a: Parameters<SiloActions['appendItem']>) =>
        a[1] === key('b') ? { ok: false as const, code: 409, reason: 'the record changed while it was being written' } : actions.appendItem(...a),
    }
    const r = respond(key('g'), 'Option A', 'pending', failing)
    expect(r.ok).toBe(false)
    if (!r.ok) expect([r.closed, r.missing, r.notified.map((x) => x.key)]).toEqual([true, [key('b')], [key('a')]])
    let raw = JSON.parse(readFileSync(f, 'utf8'))
    expect(raw.tasks.find((x: Json) => x.id === 'g').status).toBe('done')
    // sent again: the gate's Done answers already, a's note is not written twice, b gets its own
    const again = respond(key('g'), 'Option A', 'pending')
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.value.already).toBe(true)
    raw = JSON.parse(readFileSync(f, 'utf8'))
    expect(raw.tasks.find((x: Json) => x.id === 'a').notes).toHaveLength(1)
    expect(raw.tasks.find((x: Json) => x.id === 'b').notes.map((n: Json) => n.text)).toEqual(['Option A'])
  })
})
