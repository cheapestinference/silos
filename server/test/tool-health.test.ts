// tool-health.test.ts — the turn's own status reading of its servers
// (harnesses/claude-code/turn-status.ts, through ChatService) and the ledger
// that keeps it (tool-health.ts): asked on the first assistant or tool
// message and never awaited; dropped when the result comes first; nothing
// recorded without the method or when it throws; nothing asked in a heartbeat
// without tools; `pending` kept as pending; 20 per folder and login, one per
// conversation; a failure's first date past the cap; a reason cleaned; no
// config kept; a login's connector list replaced only with connectors on;
// 0600 files, a regime, and fenced from every agent.
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRegistry } from '../src/agent-registry.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import type { QueryArgs, SdkMessage, SdkQueryHandle } from '../src/harnesses/claude-code/sdk-types.js'
import type { LoadsRow, TurnToolStatus } from '../src/harnesses/contract.js'
import { statusServers } from '../src/harnesses/claude-code/turn-status.js'
import { READINGS_PER_LOGIN, ToolHealthLedger, scrubReason, withHealth } from '../src/tool-health.js'
import { DATA_DIR_REGIMES } from '../src/seal-regimes.js'
import { DATA_DIR_DENIED } from '../src/territory.js'

const RESULT = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'sdk-result-success.json'), 'utf8')) as SdkMessage
const INIT: SdkMessage = { type: 'system', subtype: 'init', session_id: 'sess-1' }
const ASSISTANT: SdkMessage = { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }], usage: { output_tokens: 3, input_tokens: 5 } } }
const TOOL_RESULT: SdkMessage = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } }
const DELTA: SdkMessage = { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } }
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

let registry: AgentRegistry, native: NativeStore, base: string, recorded: TurnToolStatus[]
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'tool-health-'))
  mkdirSync('/tmp/ci', { recursive: true })
  registry = new AgentRegistry(join(base, 'agents.json'))
  registry.load()
  registry.create({ id: 'builder', name: 'Builder', folder: '/tmp/ci' })
  native = new NativeStore(join(base, 'native.json'))
  recorded = []
})

/** A fake query: yields `script` (awaiting a tick before each message when
 *  `slow`), with the status method given. `log` records the order. */
function fake(script: SdkMessage[], status: (() => Promise<unknown[]>) | 'none', log: string[] = [], slow = false): (a: QueryArgs) => SdkQueryHandle {
  return () => ({
    async *[Symbol.asyncIterator]() {
      for (const m of script) {
        if (slow) await tick()
        log.push(m.type)
        yield m
      }
    },
    async interrupt() {
      return {}
    },
    ...(status === 'none'
      ? {}
      : {
          mcpServerStatus: () => {
            log.push('ask')
            return status()
          },
        }),
  })
}
const chatWith = (queryFn: (a: QueryArgs) => SdkQueryHandle): ChatService =>
  new ChatService({
    registry,
    native,
    queryFn,
    toolHealth: {
      record: (r) => {
        recorded.push(r as TurnToolStatus)
      },
    },
  })
async function collect(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const e of gen) out.push(e)
  return out
}

describe('the turn asks its servers’ status', () => {
  it('on the first assistant or tool message, never awaited — the turn’s messages arrive unchanged', async () => {
    const script = [INIT, DELTA, ASSISTANT, TOOL_RESULT, ASSISTANT, RESULT]
    const plain = await collect(chatWith(fake(script, 'none')).send({ turnId: 't0', agentId: 'builder', text: 'hi' }))
    const log: string[] = []
    // an answer that never comes: the turn still ends
    const asked = await collect(chatWith(fake(script, () => new Promise(() => {}), log)).send({ turnId: 't0', agentId: 'builder', text: 'hi' }))
    expect(asked).toEqual(plain)
    expect(log.slice(0, log.indexOf('ask') + 1)).toEqual(['system', 'stream_event', 'assistant', 'ask'])
    expect(log.filter((x) => x === 'ask')).toHaveLength(1)
    // a tool message alone asks too
    const log2: string[] = []
    await collect(chatWith(fake([INIT, TOOL_RESULT, RESULT], () => new Promise(() => {}), log2)).send({ turnId: 't1', agentId: 'builder', text: 'hi' }))
    expect(log2).toEqual(['system', 'user', 'ask', 'result'])
  })

  it('an answer before the result is recorded, with its conversation and how it was read', async () => {
    const rows = [
      {
        name: 'files',
        status: 'connected',
        source: 'project',
        scope: 'project',
        tools: [{ name: 'read' }, { name: 'write' }],
        config: { type: 'stdio', command: 'files-mcp', env: { API_KEY: 'k' } },
      },
    ]
    const before = Date.now()
    await collect(chatWith(fake([INIT, ASSISTANT, DELTA, RESULT], async () => rows, [], true)).send({ turnId: 't0', agentId: 'builder', text: 'hi' }))
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({
      folder: '/tmp/ci',
      agentId: 'builder',
      turnId: 't0',
      via: 'chat',
      servers: [{ name: 'files', status: 'connected', source: 'project', tools: 2 }],
    })
    // when its process started: a switch after that is not this reading's (switch-proof.ts)
    expect(recorded[0]!.started).toBeGreaterThanOrEqual(before)
    expect(JSON.stringify(recorded[0])).not.toContain('files-mcp')
    expect(JSON.stringify(recorded[0])).not.toContain('API_KEY')
  })

  it('a result that arrives first drops the reading, without an error', async () => {
    let answer!: (v: unknown[]) => void
    const events = await collect(
      chatWith(
        fake(
          [INIT, ASSISTANT, RESULT],
          () =>
            new Promise((r) => {
              answer = r
            }),
        ),
      ).send({ turnId: 't0', agentId: 'builder', text: 'hi' }),
    )
    answer([{ name: 'files', status: 'connected' }])
    await tick()
    expect(recorded).toEqual([])
    expect(events.some((e) => (e as { ev: string }).ev === 'chat-error')).toBe(false)
    expect(events.at(-1)).toMatchObject({ ev: 'chat-done', subtype: 'success' })
  })

  it('a query without the method, one that throws, one that rejects: nothing recorded, the turn intact', async () => {
    for (const status of [
      'none',
      () => {
        throw new Error('boom')
      },
      () => Promise.reject(new Error('gone')),
    ] as const) {
      const events = await collect(
        chatWith(fake([INIT, ASSISTANT, DELTA, RESULT], status as never, [], true)).send({ turnId: 't0', agentId: 'builder', text: 'hi' }),
      )
      await tick()
      expect(events.at(-1)).toMatchObject({ ev: 'chat-done' })
    }
    expect(recorded).toEqual([])
  })

  it('a heartbeat without its tools asks nothing', async () => {
    const log: string[] = []
    await collect(
      chatWith(fake([INIT, ASSISTANT, TOOL_RESULT, RESULT], async () => [], log, true)).send({
        turnId: 't0',
        agentId: 'builder',
        text: 'hi',
        unattended: true,
        turn: { class: 'heartbeat', kind: 'look', packetKeys: [] },
      }),
    )
    expect(log).not.toContain('ask')
    expect(recorded).toEqual([])
  })

  it('pending is kept as pending — and asked once more on a later message', async () => {
    let n = 0
    const log: string[] = []
    await collect(
      chatWith(
        fake(
          [INIT, ASSISTANT, DELTA, TOOL_RESULT, ASSISTANT, RESULT],
          async () => (n++ === 0 ? [{ name: 'slow', status: 'pending' }] : [{ name: 'slow', status: 'connected' }]),
          log,
          true,
        ),
      ).send({ turnId: 't0', agentId: 'builder', text: 'hi', unattended: true, turn: { class: 'run', automationId: 'a1' } }),
    )
    expect(log.filter((x) => x === 'ask')).toHaveLength(2)
    expect(recorded.map((r) => r.servers[0]!.status)).toEqual(['pending', 'connected'])
    expect(recorded[0]!.via).toBe('run')
  })

  it('every unattended turn says what it was: a run, a wake, a round with its tools', async () => {
    const turns = [
      { class: 'run' as const, automationId: 'a1' },
      { class: 'wake' as const, taskKey: 'proj/tasks/tasks/t1' },
      { class: 'heartbeat' as const, kind: 'round' as const, packetKeys: [], regime: { tools: true, perDay: 2 } },
    ]
    for (const turn of turns) {
      await collect(
        chatWith(fake([INIT, ASSISTANT, RESULT], async () => [{ name: 'files', status: 'connected' }], [], true)).send({
          turnId: `t-${turn.class}`,
          agentId: 'builder',
          text: 'hi',
          unattended: true,
          isolation: { settingSources: ['user', 'project'], disableAllHooks: true },
          turn,
        }),
      )
      await tick()
    }
    expect(recorded.map((r) => [r.via, r.agentId])).toEqual([
      ['run', 'builder'],
      ['wake', 'builder'],
      ['round', 'builder'],
    ])
  })
})

describe('the status rows the engine hands over', () => {
  it('never carry config; an entry with no URL and no command has no address — by structure', () => {
    const out = statusServers([
      {
        name: 'plugin:kit:mail',
        status: 'failed',
        error: 'No URL configured for this server',
        source: 'plugin',
        scope: 'dynamic',
        config: { type: 'http', url: '' },
      },
      { name: 'claude.ai Drive', status: 'needs-auth', source: 'claudeai', config: { type: 'claudeai-proxy', url: 'https://mcp.example.com/x', id: 'abc' } },
      { name: 'odd', status: 'exploded' },
      { status: 'connected' },
    ])
    expect(out).toEqual([
      { name: 'plugin:kit:mail', status: 'failed', error: 'No URL configured for this server', source: 'plugin', scope: 'dynamic', noAddress: true },
      { name: 'claude.ai Drive', status: 'needs-auth', source: 'claudeai' },
    ])
  })
})

describe('the ledger', () => {
  let dir: string, ledger: ToolHealthLedger, clock: number
  const F = '/home/user/proj'
  const rec = (conversation: string, servers: TurnToolStatus['servers'], over: Partial<TurnToolStatus> = {}): void => {
    clock += 1000
    ledger.record({
      folder: F,
      conversation,
      turnId: `turn-${clock}`,
      agentId: 'builder',
      login: 'sam@example.com',
      via: 'chat',
      connectorsOn: false,
      servers,
      ...over,
    })
  }
  beforeEach(() => {
    dir = join(base, 'data', 'tool-health')
    clock = 1_000_000
    ledger = new ToolHealthLedger(dir, () => clock)
  })

  it('keeps 20 per folder and login, one per conversation (its newest)', () => {
    for (let i = 0; i < 25; i++) rec(`c${i}`, [{ name: 'files', status: 'connected' }])
    rec('c24', [{ name: 'files', status: 'failed', error: 'down' }])
    for (let i = 0; i < 3; i++) rec(`o${i}`, [{ name: 'files', status: 'connected' }], { login: 'kim@example.com' })
    const all = ledger.readings(F)
    const sam = all.filter((r) => r.login === 'sam@example.com')
    expect(sam).toHaveLength(READINGS_PER_LOGIN)
    expect(sam.filter((r) => r.conversation === 'c24')).toHaveLength(1)
    expect(sam[0]).toMatchObject({ conversation: 'c24', servers: [{ status: 'failed' }] })
    expect(all.filter((r) => r.login === 'kim@example.com')).toHaveLength(3)
    // another folder is another file
    expect(ledger.readings('/home/user/other')).toEqual([])
  })

  it('a failure’s first date survives the cap; pending neither breaks nor extends it; connected ends it; a placeholder is never one', () => {
    const first = clock + 1000
    for (let i = 0; i < 30; i++)
      rec(`c${i}`, [
        { name: 'files', status: 'failed', error: 'down' },
        { name: 'plugin:kit:mail', status: 'failed', noAddress: true },
      ])
    rec('p', [{ name: 'files', status: 'pending' }])
    expect(ledger.readings(F).some((r) => r.at === first)).toBe(false)
    expect(ledger.runs(F)).toEqual([expect.objectContaining({ name: 'files', since: first, count: 30 })])
    // the same turn read twice counts once
    ledger.record({
      folder: F,
      conversation: 'x',
      turnId: 'same',
      agentId: 'builder',
      login: 'sam@example.com',
      via: 'chat',
      connectorsOn: false,
      servers: [{ name: 'files', status: 'failed' }],
    })
    ledger.record({
      folder: F,
      conversation: 'x',
      turnId: 'same',
      agentId: 'builder',
      login: 'sam@example.com',
      via: 'chat',
      connectorsOn: false,
      servers: [{ name: 'files', status: 'failed' }],
    })
    expect(ledger.runs(F)[0]!.count).toBe(31)
    rec('ok', [{ name: 'files', status: 'connected' }])
    expect(ledger.runs(F)).toEqual([])
  })

  it('a reason loses URLs, credential-like strings and markup; no config is stored', () => {
    expect(
      scrubReason('Dynamic Client Registration rejected (HTTP 403): !DOCTYPE HTML PUBLIC -//W3C//DTD HTML 4.01//EN http://www.w3.org/TR/html4/loose.dtd'),
    ).toBe('Dynamic Client Registration rejected (HTTP 403)')
    expect(scrubReason('connect to https://user:pw@mcp.example.com/v1/sse?token=abc failed')).toBe('connect to mcp.example.com failed')
    const creds = scrubReason(
      '401 with Authorization: Bearer abcdefghijklmnop api_key=s3cr3tvalue sk-ant-abcdefghijklmnopqrstuvwxyz and AKIAABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
    )
    for (const secret of ['abcdefghijklmnop', 's3cr3tvalue', 'sk-ant', 'AKIAABCDEFGHIJKLMNOPQRSTUVWXYZ012345']) expect(creds).not.toContain(secret)
    expect(creds.startsWith('401 with')).toBe(true)
    expect(scrubReason('bad gateway <html><body>secret page</body></html>')).toBe('bad gateway')
    expect(scrubReason('x'.repeat(20).split('').join(' ').repeat(20)).length).toBeLessThanOrEqual(160)
    // through the ledger: a row with a config never stores it (the engine
    // drops it; a stray field from a future caller is not kept either)
    rec('c', [{ name: 'files', status: 'failed', error: 'see https://mcp.example.com/a?key=1', config: { headers: { Authorization: 'Bearer zzz' } } } as never])
    const disk = readFileSync(
      join(
        dir,
        readdirSync(dir).find((f) => f !== 'logins.json')!,
      ),
      'utf8',
    )
    expect(disk).not.toContain('Bearer')
    expect(disk).not.toContain('config')
    expect(ledger.readings(F)[0]!.servers[0]!.reason).toBe('see mcp.example.com')
  })

  it('a login’s connector list is replaced only by a reading taken with connectors on', () => {
    rec(
      'a',
      [
        { name: 'claude.ai Mail', status: 'connected', source: 'claudeai' },
        { name: 'claude.ai Drive', status: 'needs-auth', source: 'claudeai' },
      ],
      { connectorsOn: true },
    )
    expect(ledger.connectorsOf('sam@example.com')?.connectors).toEqual(['claude.ai Drive', 'claude.ai Mail'])
    // connectors off here: lists none — the list stands
    rec('b', [{ name: 'files', status: 'connected' }], { connectorsOn: false })
    expect(ledger.connectorsOf('sam@example.com')?.connectors).toEqual(['claude.ai Drive', 'claude.ai Mail'])
    // in another folder, with them on: replaced
    ledger.record({
      folder: '/home/user/other',
      conversation: 'z',
      turnId: 'z',
      agentId: 'builder',
      login: 'sam@example.com',
      via: 'chat',
      connectorsOn: true,
      servers: [{ name: 'claude.ai Mail', status: 'connected', source: 'claudeai' }],
    })
    expect(ledger.connectorsOf('sam@example.com')?.connectors).toEqual(['claude.ai Mail'])
    expect(ledger.connectorsOf('kim@example.com')).toBeNull()
  })

  it('files are 0600; the entry has its regime and is fenced from every agent', () => {
    rec('a', [{ name: 'claude.ai Mail', status: 'connected', source: 'claudeai' }], { connectorsOn: true })
    const files = readdirSync(dir)
    expect(files).toContain('logins.json')
    for (const f of files) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(DATA_DIR_REGIMES['tool-health']?.regime).toBe('out-of-seal')
    expect(DATA_DIR_DENIED).toContain('tool-health')
  })

  it('switch records are kept by place: the machine’s in one file of its own (0600) for every folder, never a folder’s; forget leaves them', () => {
    ledger.noteSwitch(F, 'mcp:project:files', 'off', 5, 10)
    ledger.noteSwitch(F, 'plugin:design@market', 'off', 7, 11, 'machine')
    ledger.noteSwitch(F, 'plugin:design@market', 'on', 8, 12, 'machine')
    expect(ledger.switches(F)).toEqual([{ key: 'mcp:project:files', to: 'off', at: 10, mtime: 5 }])
    expect(ledger.switches('/home/user/other', 'machine')).toEqual([{ key: 'plugin:design@market', to: 'on', at: 12, mtime: 8 }])
    expect(statSync(join(dir, 'machine.json')).mode & 0o777).toBe(0o600)
    ledger.forget('c1')
    expect(ledger.switches(F, 'machine')).toHaveLength(1)
  })
})

describe('a row’s health', () => {
  const row = (over: Partial<LoadsRow>): LoadsRow => ({
    key: 'k',
    engine: 'e',
    kind: 'mcp',
    name: 'files',
    label: 'files',
    exact: true,
    origin: { owner: 'project', carrier: '.mcp.json' },
    state: 'active',
    ...over,
  })
  const reading = (
    at: number,
    login: string | null,
    servers: { name: string; status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'; noAddress?: true }[],
  ) => ({ at, login, from: 'turn' as const, agent: 'builder', via: 'chat' as const, servers })

  it('the newest reading that lists it — on its own login for a Claude account row', () => {
    const rs = [
      reading(1, 'kim@example.com', [{ name: 'claude.ai Mail', status: 'needs-auth' }]),
      reading(2, 'sam@example.com', [
        { name: 'claude.ai Mail', status: 'connected' },
        { name: 'files', status: 'failed' },
      ]),
    ]
    const [mail, files] = withHealth(
      [row({ kind: 'connector', name: 'claude.ai Mail', origin: { owner: 'account', carrier: 'connector', login: 'kim@example.com' } }), row({})],
      rs,
    )
    expect(mail!.health).toMatchObject({ status: 'needs-auth', read: { at: 1, login: 'kim@example.com', via: 'chat', agent: 'builder' } })
    expect(files!.health).toMatchObject({ status: 'failed', read: { at: 2 } })
  })

  it('pending stays pending; a placeholder, a shared address, a held row and a copy standing aside have none; no address in a reading is a placeholder', () => {
    const rs = [
      reading(1, null, [
        { name: 'files', status: 'pending' },
        { name: 'seen', status: 'failed', noAddress: true },
      ]),
    ]
    const out = withHealth(
      [
        row({}),
        row({ placeholder: {} }),
        row({ sameAs: 'x' }),
        row({ state: 'held' }),
        row({ replacedBy: 'x' }),
        row({ name: 'seen', observed: { from: 'reading' } }),
      ],
      rs,
    )
    expect(out[0]!.health?.status).toBe('pending')
    for (const r of out.slice(1, 5)) expect(r.health).toBeUndefined()
    expect(out[5]).toMatchObject({ placeholder: {} })
    expect(out[5]!.health).toBeUndefined()
  })
})
