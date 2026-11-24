// heartbeat-packet.test.ts — «since the last time» and the
// prompt that carries it (per engine AND per stage).
import { describe, expect, it } from 'vitest'
import { composePacket, keysOfIdea, lastListedOf, suppressedKeys, type PacketInput } from '../src/heartbeat-packet.js'
import { ASK_LINE, DECIDE_STAGE_LINE, HEARTBEAT_STAGE, heartbeatPrompt, roundPrompt, toolsLine } from '../src/heartbeat-prompt.js'
import { judgeCreation, signalMatches, SIGNAL_REQUIRED_HEARTBEAT } from '../src/plans-provenance.js'
import { PACKET_PER_SOURCE_MAX, PACKET_RELIST_MS } from '../src/limits.js'

const NOW = Date.parse('2026-11-16T09:07:00Z')
const SINCE = NOW - 7 * 24 * 3600_000
const base = (over: Partial<PacketInput> = {}): PacketInput => ({
  agentId: 'x',
  since: SINCE,
  now: NOW,
  messages: [],
  failedRuns: [],
  yours: [],
  waits: [],
  routed: [],
  decided: [],
  owner: [],
  lastListed: new Map(),
  considered: [],
  ...over,
})

describe('a wait Silos carries: said once, never weekly', () => {
  const carried = { key: 'k2', ref: 'p#t2', title: 'Wait', who: 'Builder', since: NOW - 60_000, carried: true }
  it('at its birth: one line that says it is carried — the asked agent sees it, nothing to do', () => {
    const p = composePacket(base({ waits: [carried] }))
    expect(p.keys).toEqual(['wait:k2'])
    expect(p.lines).toEqual(['wait:p#t2 «Wait» — Builder sees it at its next beat — nothing to do'])
  })
  it('listed once: never again while carried, however long it waits', () => {
    const listed = new Map([['wait:k2', NOW - 3 * PACKET_RELIST_MS]])
    expect(composePacket(base({ waits: [{ ...carried, since: NOW - 4 * PACKET_RELIST_MS }], lastListed: listed })).keys).toEqual([])
  })
  it('flipped to the relay: the usual weekly line returns', () => {
    const listed = new Map([['wait:k2', NOW - PACKET_RELIST_MS - 1]])
    const p = composePacket(base({ waits: [{ ...carried, carried: false, since: NOW - PACKET_RELIST_MS - 1 }], lastListed: listed }))
    expect(p.keys).toEqual(['wait:k2'])
    expect(p.lines[0]).toMatch(/^wait:p#t2 «Wait» has waited on Builder since /)
  })
})

describe('the packet is a delta with keys', () => {
  it('empty when nothing changed (a look is then skipped with zero tokens)', () => {
    expect(composePacket(base())).toMatchObject({ empty: true, keys: [] })
  })
  it('every source, keyed', () => {
    const p = composePacket(
      base({
        messages: [{ id: 'm1', from: 'y', fromName: 'Y', text: 'hello', at: NOW - 1000 }],
        failedRuns: [{ automationId: 'a1', runId: 'r1', name: 'Sync', error: 'boom', at: NOW - 2000 }],
        yours: [{ key: 'k1', ref: 'p#t1', title: 'Do it', by: 'owner', byName: 'the owner', at: NOW - 3000 }],
        waits: [{ key: 'k2', ref: 'p#t2', title: 'Wait', who: 'Z', since: NOW - PACKET_RELIST_MS - 1 }],
        routed: [{ key: 's:0:r', text: 'Facts: a row', at: NOW }],
        decided: [{ key: 'proposal:p1', text: 'accepted', at: NOW - 10 }],
        owner: [{ key: 'ceiling:x:2026-11-16', text: 'you started 10 times today' }],
      }),
    )
    expect(p.keys.sort()).toEqual(['message:m1', 'proposal:p1', 'row:ceiling:x:2026-11-16', 'row:s:0:r', 'run:a1/r1', 'task:k1', 'wait:k2'].sort())
    expect(p.lines.join('\n')).toContain('message:m1 from Y: «hello»')
  })
  it('a dropped idea does not come back without a new change; a message still new always does (m6)', () => {
    const considered = [
      { at: new Date(NOW - 500).toISOString(), idea: 'run:a1/r1 — the sync', decision: 'dropped' as const, why: 'known' },
      { at: new Date(NOW - 500).toISOString(), idea: 'message:m1 — hello', decision: 'dropped' as const, why: 'later' },
    ]
    const p = composePacket(
      base({
        considered,
        messages: [{ id: 'm1', from: 'y', fromName: 'Y', text: 'hello', at: NOW - 1000 }],
        failedRuns: [{ automationId: 'a1', runId: 'r1', name: 'Sync', error: 'boom', at: NOW - 2000 }],
      }),
    )
    expect(p.keys).toEqual(['message:m1'])
    // a NEW failure after the decision comes back
    const again = composePacket(base({ considered, failedRuns: [{ automationId: 'a1', runId: 'r1', name: 'Sync', error: 'boom', at: NOW - 100 }] }))
    expect(again.keys).toEqual(['run:a1/r1'])
  })
  it('later(until) comes back when until passes', () => {
    const c = [
      { at: new Date(NOW - 5000).toISOString(), idea: 'task:k1 — maybe', decision: 'later' as const, why: 'soon', until: new Date(NOW + 1000).toISOString() },
    ]
    const yours = [{ key: 'k1', ref: 'p#t1', title: 'Do it', at: NOW - 6000 }]
    expect(composePacket(base({ considered: c, yours })).keys).toEqual([])
    expect(composePacket(base({ considered: c, yours, now: NOW + 2000 })).keys).toEqual(['task:k1'])
  })
  it('yours (m5, m9): listed once, again after a week still not started; a dropped one never by relisting', () => {
    const yours = [{ key: 'k1', ref: 'p#t1', title: 'Do it', at: NOW - 6000 }]
    const listed = new Map([['task:k1', NOW - 24 * 3600_000]])
    expect(composePacket(base({ yours, lastListed: listed })).keys).toEqual([])
    const week = new Map([['task:k1', NOW - PACKET_RELIST_MS - 1]])
    expect(composePacket(base({ yours, lastListed: week })).keys).toEqual(['task:k1'])
    const dropped = [{ at: new Date(NOW - PACKET_RELIST_MS - 10).toISOString(), idea: 'task:k1', decision: 'dropped' as const, why: 'no' }]
    expect(composePacket(base({ yours, lastListed: week, considered: dropped })).keys).toEqual([])
  })
  it('a task added outside Silos is never listed as startable (S8)', () => {
    const p = composePacket(base({ yours: [{ key: 'k1', ref: 'p#t1', title: 'Odd', by: 'unknown', at: NOW }] }))
    expect(p.lines[0]).toContain("added outside Silos — the owner hasn't touched it")
    expect(p.lines[0]).not.toContain('pending, not started')
  })
  it('each source lists at most PACKET_PER_SOURCE_MAX, newest first; the rest «…and n more», out of the keys (m9-r5)', () => {
    const messages = Array.from({ length: PACKET_PER_SOURCE_MAX + 3 }, (_, i) => ({ id: `m${i}`, from: 'y', fromName: 'Y', text: 't', at: NOW - i }))
    const p = composePacket(base({ messages }))
    expect(p.keys).toHaveLength(PACKET_PER_SOURCE_MAX)
    expect(p.keys[0]).toBe('message:m0')
    expect(p.lines.at(-1)).toBe('…and 3 more')
  })
  it("last listed is read from earlier heartbeat runs' packet.keys; considered ideas name their keys", () => {
    const m = lastListedOf([
      { at: '2026-11-01T00:00:00Z', heartbeat: { packet: { keys: ['task:a'] } } },
      { at: '2026-11-08T00:00:00Z', heartbeat: { packet: { keys: ['task:a', 'message:b'] } } },
    ])
    expect(m.get('task:a')).toBe(Date.parse('2026-11-08T00:00:00Z'))
    expect(keysOfIdea('message:m1 — and task:folder:/x/p/tasks/t1, fine')).toEqual(['message:m1', 'task:folder:/x/p/tasks/t1'])
  })
})

// the asks another agent left it through Silos
describe("the packet's asks: ask:<taskKey>, a source of its own (H7)", () => {
  const a = {
    key: 'folder:/w/p/tasks/t1',
    ref: 'p#t1',
    title: 'Write the draft',
    fromName: 'Writer',
    action: 'review the draft',
    asked: 'Is part 2 right?',
    at: NOW - 1000,
  }
  it("enters at its birth with its line; the question, else the action; the mark of a run that read outside; Silos' own says the task is stuck", () => {
    const p = composePacket(
      base({
        asks: [
          a,
          { ...a, key: 'folder:/w/p/tasks/t2', ref: 'p#t2', asked: '', readOutside: ['WebFetch'], at: NOW - 2000 },
          { ...a, key: 'folder:/w/p/tasks/t3', ref: 'p#t3', title: 'Ship', action: 'unstick p#t3', asked: '', silos: true, at: NOW - 3000 },
        ],
      }),
    )
    expect(p.keys).toEqual(['ask:folder:/w/p/tasks/t1', 'ask:folder:/w/p/tasks/t2', 'ask:folder:/w/p/tasks/t3'])
    expect(p.lines[0]).toBe('ask:folder:/w/p/tasks/t1 — Writer waits on you for p#t1: «Is part 2 right?»')
    expect(p.lines[1]).toBe('ask:folder:/w/p/tasks/t2 — Writer waits on you for p#t2: «review the draft» — asked after reading the web (WebFetch)')
    expect(p.lines[2]).toBe('ask:folder:/w/p/tasks/t3 — p#t3 «Ship» is stuck and Silos asks you to help unstick it (Writer stays its owner)')
    expect(p.empty).toBe(false)
  })
  it('listed once: back only PACKET_RELIST_MS after — also past its reach; `later` and `dropped` suppress it; a listing in a FAILED run is no listing', () => {
    const listed = new Map([['ask:folder:/w/p/tasks/t1', NOW - 1000]])
    expect(composePacket(base({ asks: [a], lastListed: listed })).keys).toEqual([])
    const week = new Map([['ask:folder:/w/p/tasks/t1', NOW - PACKET_RELIST_MS]])
    expect(composePacket(base({ asks: [a], lastListed: week })).keys).toEqual(['ask:folder:/w/p/tasks/t1'])
    const later = [
      {
        at: new Date(NOW).toISOString(),
        idea: 'ask:folder:/w/p/tasks/t1 — after the release',
        decision: 'later' as const,
        why: 'x',
        until: new Date(NOW + 3600_000).toISOString(),
      },
    ]
    expect(composePacket(base({ asks: [a], considered: later })).keys).toEqual([])
    const dropped = [{ at: new Date(NOW).toISOString(), idea: 'ask:folder:/w/p/tasks/t1', decision: 'dropped' as const, why: 'x' }]
    expect(composePacket(base({ asks: [a], lastListed: week, considered: dropped })).keys).toEqual([])
    expect(suppressedKeys(dropped, NOW).has('ask:folder:/w/p/tasks/t1')).toBe(true)
    expect(keysOfIdea('ask:folder:/w/p/tasks/t1 — not mine')).toEqual(['ask:folder:/w/p/tasks/t1'])
    const runs = [{ at: new Date(NOW - 1000).toISOString(), status: 'failed', heartbeat: { packet: { keys: ['ask:folder:/w/p/tasks/t1', 'message:m1'] } } }]
    const m = lastListedOf(runs)
    expect(m.has('ask:folder:/w/p/tasks/t1')).toBe(false)
    expect(m.has('message:m1')).toBe(true)
    expect(composePacket(base({ asks: [a], lastListed: m })).keys).toEqual(['ask:folder:/w/p/tasks/t1'])
  })
  it('`ask:<key>` is a signal of the heartbeat that listed it — a task of its own answering it is created; its words name the form', () => {
    const turn = { class: 'heartbeat' as const, unattended: true, kind: 'look' as const, packetKeys: ['ask:folder:/w/p/tasks/t1'] }
    expect(signalMatches(turn, 'ask:folder:/w/p/tasks/t1')).toBe(true)
    expect(
      judgeCreation({
        agent: { id: 'x', name: 'X' },
        ledger: [],
        now: NOW,
        openTask: () => true,
        selfRecurrentLive: 0,
        turn,
        signal: 'ask:folder:/w/p/tasks/t1',
      }),
    ).toMatchObject({ ok: true })
    expect(SIGNAL_REQUIRED_HEARTBEAT).toContain('ask:<key>')
  })
  it('both prompts teach the answer (B2.11): the route, the turn, declining is an answer', () => {
    const M = { text: 'Keep the books.', never: [], updatedAt: 'x' }
    expect(ASK_LINE).toContain('POST /api/tasks/ask/answer {"key":"<key>","text":"<your answer>","turn":"$SILOS_TURN"}')
    expect(ASK_LINE).toContain('«not mine — ask the owner» is an answer too')
    for (const stage of ['decide', 'create'] as const)
      expect(
        heartbeatPrompt({
          kind: 'look',
          mission: M,
          blocks: { web: true, connectors: true, subagents: true },
          since: 'x',
          packetLines: [],
          consideredLines: [],
          stage,
        }),
      ).toContain(ASK_LINE)
    expect(
      roundPrompt({
        kind: 'round',
        mission: M,
        tools: false,
        perDay: 5,
        left: 5,
        blocks: { web: true, connectors: true, subagents: true },
        since: 'x',
        packetLines: [],
        openLines: [],
        undoneLines: [],
        consideredLines: [],
      }),
    ).toContain(ASK_LINE)
  })
})

describe('the prompt: per engine and per stage', () => {
  const M = { text: 'Keep the books.', never: ['pay anything'], updatedAt: 'x' }
  it("the decide variant (t3) has no create/propose; t5 emits the complete one — the stage flag is the plan's capability", () => {
    expect(HEARTBEAT_STAGE).toBe('create')
    const p = heartbeatPrompt({
      kind: 'think',
      mission: M,
      blocks: { web: true, connectors: true, subagents: true },
      since: 'x',
      packetLines: [],
      consideredLines: [],
      stage: 'decide',
    })
    expect(p).toContain(DECIDE_STAGE_LINE)
    expect(p).not.toMatch(/append-item|POST \/api\/proposals|Create ONE thing|editing the plan file/)
    expect(p).toContain("Never, without the owner's word:\n- pay anything")
    expect(p).toContain('"turn": "$SILOS_TURN"')
    const t5 = heartbeatPrompt({
      kind: 'think',
      mission: M,
      blocks: { web: true, connectors: true, subagents: true },
      since: 'x',
      packetLines: [],
      consideredLines: [],
    })
    expect(t5).toContain('Create ONE thing from your mission')
    expect(t5).toContain('append-item with "signal":"message:<id>"')
    expect(t5).toContain('POST /api/proposals, up to 3 pending')
    expect(t5).toContain('If you add a task by editing the plan file instead of append-item, write its "signal" in the task object')
    expect(t5).not.toContain(DECIDE_STAGE_LINE)
    // a look never offers the mission initiative
    const look = heartbeatPrompt({
      kind: 'look',
      mission: M,
      blocks: { web: true, connectors: true, subagents: true },
      since: 'x',
      packetLines: [],
      consideredLines: [],
    })
    expect(look).not.toContain('Create ONE thing')
    expect(look).toContain('append-item')
  })
  it("the tools line says each engine's truth: Claude blocks all three; an engine that cannot block connectors or subagents is told to not use them", () => {
    expect(toolsLine({ web: true, connectors: true, subagents: true })).toMatch(
      /^This turn has no web tools, no connectors and no subagents\. Do not reach the net from the shell either/,
    )
    const oc = toolsLine({ web: true, connectors: false, subagents: false })
    expect(oc).toMatch(
      /^This turn has no web tools\. Connectors may not be blocked on your engine: do not touch MCP tools\. Subagents may not be blocked on your engine: do not use them\./,
    )
    expect(toolsLine({ web: true, connectors: false, subagents: true })).toMatch(
      /^This turn has no web tools or subagents\. Connectors may not be blocked on your engine: do not touch MCP tools\./,
    )
  })
})
