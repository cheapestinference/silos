// agent-state-confinement.test.ts — sixth review round, the confused deputy
// in an agent's state dir: the agent's Bash is not fenced, so it can plant
// links (symbolic or hard) in $SILOS_AGENT_STATE; the server runs
// unsandboxed and must never read or write ANOTHER agent's state — or
// Silos' own files — on an agent's behalf. Every reader/writer of that dir
// goes through safe-file.ts. Reproduced first: a link at watch-state.json
// overwrote a fake territory.json on the resident's tick, a link at
// status.log.jsonl appended to a fake bashrc, and status/runmode/asks/births
// of another agent read as alice's. Temp dirs only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentStateStore } from '../src/agent-state.js'
import { AsksStore } from '../src/asks-store.js'
import { BirthsStore } from '../src/births-store.js'
import { ContextService } from '../src/context-service.js'
import { assembleOpencode } from '../src/harnesses/opencode/assemble.js'

let T: string, base: string, st: AgentStateStore, alice: string, bob: string
beforeEach(() => {
  T = realpathSync(mkdtempSync(join(tmpdir(), 'as-conf-')))
  base = join(T, 'data', 'agent-state')
  st = new AgentStateStore(base)
  alice = st.dirFor('alice')
  bob = st.dirFor('bob')
})
afterEach(() => rmSync(T, { recursive: true, force: true }))

describe('writes Silos makes in an agent state never land elsewhere', () => {
  it('the OpenCode briefing files: a planted link at opencode/ or at a file never gets the briefing written through it', () => {
    const victim = join(T, 'data', 'territory.json')
    writeFileSync(victim, 'VICTIM')
    mkdirSync(join(alice, 'opencode'))
    symlinkSync(victim, join(alice, 'opencode', 'context.md'))
    const deps = { agentState: st, agents: () => [], dataDir: join(T, 'data'), home: T, silosApi: 'http://x' } as never
    const agent = { id: 'alice', name: 'Alice', folder: T } as never
    assembleOpencode(deps, agent, T)
    expect(readFileSync(victim, 'utf8')).toBe('VICTIM')
    rmSync(join(alice, 'opencode'), { recursive: true })
    mkdirSync(join(T, 'elsewhere'))
    symlinkSync(join(T, 'elsewhere'), join(alice, 'opencode'))
    expect(() => assembleOpencode(deps, agent, T)).toThrow()
    expect(readdirSync(join(T, 'elsewhere'))).toEqual([])
  })
})

describe('reads Silos makes for an agent are of that agent only', () => {
  it("produced: with the agent dir a link to bob nothing of bob's is listed; a plain dir lists", () => {
    const ctx = new ContextService()
    writeFileSync(join(alice, 'mine.md'), 'a')
    expect(ctx.produced(st.verifiedDir('alice')).map((f) => f.name)).toEqual(['mine.md'])
    writeFileSync(join(bob, 'notes.md'), 'bob notes')
    renameSync(alice, alice + '.old')
    symlinkSync('bob', alice)
    expect(ctx.produced(st.verifiedDir('alice'))).toEqual([])
  })

  it("asks: a linked asks/ or a linked ask file of bob's never shows as alice's, nor is answered as hers", () => {
    const ask = { id: 'q1', sessionId: 's1', type: 'bash', askedAt: new Date().toISOString(), title: 'BOB ASK' }
    mkdirSync(join(bob, 'asks', 's1'), { recursive: true })
    writeFileSync(join(bob, 'asks', 's1', 'q1.json'), JSON.stringify(ask))
    symlinkSync('../bob/asks', join(alice, 'asks'))
    const asks = new AsksStore(st, { dataDir: join(T, 'data'), ttlMs: 0 })
    expect(asks.all().filter((a) => a.agentId === 'alice')).toEqual([])
    expect(asks.reply('alice', 's1', 'q1', 'allow')).toBe('missing')
    rmSync(join(alice, 'asks'))
    mkdirSync(join(alice, 'asks', 's1'), { recursive: true })
    linkSync(join(bob, 'asks', 's1', 'q1.json'), join(alice, 'asks', 's1', 'q1.json'))
    expect(asks.all().filter((a) => a.agentId === 'alice')).toEqual([])
    rmSync(join(alice, 'asks', 's1', 'q1.json'))
    symlinkSync(join(bob, 'asks', 's1', 'q1.json'), join(alice, 'asks', 's1', 'q1.json'))
    expect(asks.all().filter((a) => a.agentId === 'alice')).toEqual([])
    // bob's own still reads
    expect(asks.all().filter((a) => a.agentId === 'bob')).toHaveLength(1)
  })

  it('births: a marker hard-linked or linked from elsewhere is not read', () => {
    const marker = { sessionId: 'sess-1', agentId: 'alice', at: new Date().toISOString() }
    mkdirSync(join(alice, 'births'))
    const elsewhere = join(T, 'm.json')
    writeFileSync(elsewhere, JSON.stringify(marker))
    symlinkSync(elsewhere, join(alice, 'births', 'sess-1.json'))
    linkSync(elsewhere, join(alice, 'births', 'sess-2.json'))
    const births = new BirthsStore(st, { ttlMs: 0 })
    expect(births.all()).toEqual([])
    writeFileSync(join(alice, 'births', 'sess-3.json'), JSON.stringify({ ...marker, sessionId: 'sess-3' }))
    expect(new BirthsStore(st, { ttlMs: 0 }).all().map((b) => b.sessionId)).toEqual(['sess-3'])
  })
})
