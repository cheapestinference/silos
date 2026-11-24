import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRegistry, mungePath, MASTER_ID } from '../src/agent-registry.js'
import { NativeStore } from '../src/native-store.js'
import { LineageStore } from '../src/lineage.js'
import { AgentStateStore } from '../src/agent-state.js'
import { AgentTokens } from '../src/agent-tokens.js'
import { ProvidersStore } from '../src/providers-store.js'
import type { HeadlessContext, HeadlessEngine } from '../src/harnesses/contract.js'
import { ChatService, ASK_DECISIONS_NOTE, AUTOMATIONS_NOTE, askDecisionsNote } from '../src/chat-service.js'

// a Claude Code agent's append names its question tool (E10 #31)
const CLAUDE_ASK = askDecisionsNote('AskUserQuestion')
import { briefingText, silosBriefing, withBriefingAfter } from '../src/harnesses/briefing.js'
import { sdkTurnSkills } from '../src/harnesses/claude-code/headless.js'
// a turn WITH hooks carries the static briefing after its own append, for
// the skills it loads (its SessionStart then sends only roster and inbox)
const hooked = (own: string, cwd = '/tmp/ci', sources: string[] = ['user', 'project', 'local']): string =>
  withBriefingAfter(own, briefingText(sdkTurnSkills(cwd, sources, null)))
import { MessageStore } from '../src/messages.js'
import { MessageReads } from '../src/message-reads.js'
import { LiveTurns } from '../src/live-turns.js'
import type { QueryArgs, SdkMessage, SdkQueryHandle } from '../src/harnesses/claude-code/sdk-types.js'

function fakeQuery(script: SdkMessage[], calls: QueryArgs[]): (args: QueryArgs) => SdkQueryHandle {
  return (args) => {
    calls.push(args)
    return {
      async *[Symbol.asyncIterator]() {
        for (const m of script) yield m
      },
      async interrupt() {
        return { status: 'interrupted' }
      },
    }
  }
}

const SCRIPT: SdkMessage[] = [
  { type: 'system', subtype: 'init', session_id: 'sess-1' },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hel' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } },
  { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Bash' } } },
  { type: 'result', subtype: 'success', session_id: 'sess-1', total_cost_usd: 0.01 },
]

let registry: AgentRegistry, native: NativeStore, calls: QueryArgs[], base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'deck-'))
  mkdirSync('/tmp/ci', { recursive: true }) // the test agents' folder must EXIST (send's catch translates a nonexistent cwd into an honest error); idempotent
  registry = new AgentRegistry(join(base, 'agents.json'))
  registry.load()
  registry.create({ id: 'finance', name: 'FINANCE', folder: '/tmp/ci', skills: ['finance-skill'], model: 'claude-sonnet-5', mission: { text: 'charter' } })
  registry.create({ id: 'plain', name: 'Plain', folder: '/tmp/ci' }) // no skills or model
  native = new NativeStore(join(base, 'native.json'))
  calls = []
})

async function collect(gen: AsyncGenerator<unknown>): Promise<any[]> {
  const out: any[] = []
  for await (const e of gen) out.push(e)
  return out
}

describe('ChatService.send — a new session', () => {
  // review L2: `claude` gone between the cached compat gate and the turn —
  // the query refuses synchronously, before any process exists
  it('a query that refuses before starting: a chat-error, and the birth record of the never-born session is taken back', async () => {
    let born: string | undefined
    const queryFn = (args: QueryArgs): SdkQueryHandle => {
      born = args.options.sessionId as string
      expect(native.get('-tmp-ci', born)?.agentId).toBe('finance') // written before, as always
      throw new Error('Claude Code is not installed — no `claude` on PATH')
    }
    const chat = new ChatService({ registry, native, queryFn })
    const events = await collect(chat.send({ turnId: 't1', agentId: 'finance', text: 'hi' }))
    expect(events).toEqual([{ ev: 'chat-error', turnId: 't1', error: 'Claude Code is not installed — no `claude` on PATH' }])
    expect(born).toBeDefined()
    expect(native.get('-tmp-ci', born!)).toBeNull()
    expect(chat.isSessionActive(born!)).toBe(false)
  })

  it('maps init/deltas/tool/result and registers the native session', async () => {
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls) })
    const events = await collect(chat.send({ turnId: 't1', agentId: 'finance', text: 'hi' }))
    expect(events).toEqual([
      { ev: 'chat-init', turnId: 't1', folder: '-tmp-ci', sessionId: 'sess-1' },
      { ev: 'chat-delta', turnId: 't1', text: 'hel' },
      { ev: 'chat-delta', turnId: 't1', text: 'lo' },
      { ev: 'chat-tool', turnId: 't1', name: 'Bash' },
      { ev: 'chat-done', turnId: 't1', subtype: 'success', costUsd: 0.01 },
    ])
    expect(native.get('-tmp-ci', 'sess-1')?.agentId).toBe('finance')
  })

  it('captures slash_commands from init and exposes them in chat-init, without the terminal-only ones', async () => {
    const script: SdkMessage[] = [
      {
        type: 'system',
        subtype: 'init',
        session_id: 's-slash',
        // '/clear' arrives with a slash and another without — it gets normalized; 'exit' is terminal-only and is hidden.
        slash_commands: ['/clear', 'compact', 'model', 'exit', 'finance'],
        terminal_slash_commands: ['exit'],
      } as unknown as SdkMessage,
      { type: 'result', subtype: 'success', total_cost_usd: 0 },
    ]
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(script, calls) })
    const events = await collect(chat.send({ turnId: 't', agentId: 'finance', text: 'x' }))
    expect(events[0]).toEqual({
      ev: 'chat-init',
      turnId: 't',
      folder: '-tmp-ci',
      sessionId: 's-slash',
      slashCommands: ['clear', 'compact', 'model', 'finance'],
    })
  })

  it('init with no slash_commands -> chat-init without the field (an older CLI, a safe degradation)', async () => {
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls) })
    const events = await collect(chat.send({ turnId: 't1', agentId: 'finance', text: 'hi' }))
    expect(events[0]).toEqual({ ev: 'chat-init', turnId: 't1', folder: '-tmp-ci', sessionId: 'sess-1' })
    expect('slashCommands' in (events[0] as object)).toBe(false)
  })

  it('maps thinking_delta to chat-thinking', async () => {
    const script: SdkMessage[] = [
      { type: 'system', subtype: 'init', session_id: 's-th' },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } },
      { type: 'result', subtype: 'success', total_cost_usd: 0 },
    ]
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(script, calls) })
    const events = await collect(chat.send({ turnId: 't', agentId: 'finance', text: 'x' }))
    expect(events[1]).toEqual({ ev: 'chat-thinking', turnId: 't', text: 'hmm' })
  })

  it('maps message_delta with usage.output_tokens to chat-usage', async () => {
    const script: SdkMessage[] = [
      { type: 'system', subtype: 'init', session_id: 's-usage' },
      { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 1234 } } } as unknown as SdkMessage,
      { type: 'result', subtype: 'success', total_cost_usd: 0 },
    ]
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(script, calls) })
    const events = await collect(chat.send({ turnId: 't', agentId: 'finance', text: 'x' }))
    expect(events[1]).toEqual({ ev: 'chat-usage', turnId: 't', outputTokens: 1234 })
  })

  it('maps usage from an assistant message to chat-usage with contextTokens (input+cache_creation+cache_read)', async () => {
    const script: SdkMessage[] = [
      { type: 'system', subtype: 'init', session_id: 's-ctx' },
      {
        type: 'assistant',
        message: { usage: { output_tokens: 50, input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 } },
      } as unknown as SdkMessage,
      { type: 'result', subtype: 'success', total_cost_usd: 0 },
    ]
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(script, calls) })
    const events = await collect(chat.send({ turnId: 't', agentId: 'finance', text: 'x' }))
    expect(events[1]).toEqual({ ev: 'chat-usage', turnId: 't', outputTokens: 50, contextTokens: 1110 })
  })

  it('assistant usage with no input fields -> contextTokens undefined, NOT 0', async () => {
    const script: SdkMessage[] = [
      { type: 'system', subtype: 'init', session_id: 's-ctx-2' },
      { type: 'assistant', message: { usage: { output_tokens: 7 } } } as unknown as SdkMessage,
      { type: 'result', subtype: 'success', total_cost_usd: 0 },
    ]
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(script, calls) })
    const events = await collect(chat.send({ turnId: 't', agentId: 'finance', text: 'x' }))
    expect(events[1]).toEqual({ ev: 'chat-usage', turnId: 't', outputTokens: 7 })
    expect('contextTokens' in (events[1] as object)).toBe(false)
  })

  it('chat-tool includes a serialized input (max 120 chars) when the content_block carries one', async () => {
    const script: SdkMessage[] = [
      { type: 'system', subtype: 'init', session_id: 's-tool' },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read', input: { file_path: '/x/y.ts' } } },
      },
      { type: 'result', subtype: 'success', total_cost_usd: 0 },
    ]
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(script, calls) })
    const events = await collect(chat.send({ turnId: 't', agentId: 'finance', text: 'x' }))
    expect(events[1]).toEqual({ ev: 'chat-tool', turnId: 't', name: 'Read', input: '{"file_path":"/x/y.ts"}' })
  })

  it('chat-tool with no input in the content_block does not include the field', async () => {
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls) })
    const events = await collect(chat.send({ turnId: 't1', agentId: 'finance', text: 'hi' }))
    const tool = events.find((e: any) => e.ev === 'chat-tool')
    expect(tool).toEqual({ ev: 'chat-tool', turnId: 't1', name: 'Bash' })
  })

  it('chat-tool truncates the serialized input to 120 characters', async () => {
    const long = 'x'.repeat(200)
    const script: SdkMessage[] = [
      { type: 'system', subtype: 'init', session_id: 's-tool-long' },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Write', input: { content: long } } },
      },
      { type: 'result', subtype: 'success', total_cost_usd: 0 },
    ]
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(script, calls) })
    const events = await collect(chat.send({ turnId: 't', agentId: 'finance', text: 'x' }))
    const tool = events.find((e: any) => e.ev === 'chat-tool') as { input: string }
    expect(tool.input).toHaveLength(120)
  })

  it("builds the agent's options (cwd, bypass, preset+append, model, partials, settingSources)", async () => {
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls) })
    await collect(chat.send({ turnId: 't1', agentId: 'finance', text: 'hi' }))
    const o = calls[0]!.options
    expect(o.cwd).toBe('/tmp/ci')
    expect(o.permissionMode).toBe('bypassPermissions')
    expect(o.allowDangerouslySkipPermissions).toBe(true) // required by the SDK alongside bypassPermissions
    expect(o.includePartialMessages).toBe(true)
    expect(o.settingSources).toEqual(['user', 'project', 'local'])
    expect(o.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: hooked(`Your mission: charter\n\n${AUTOMATIONS_NOTE}\n\n${CLAUDE_ASK}`) })
    expect((o.env as Record<string, string>).SILOS_BRIEFING).toBe('system-prompt')
    expect(o.model).toBe('claude-sonnet-5')
  })

  it('isolation replaces settingSources and adds settings.disableAllHooks', async () => {
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls) })
    await collect(chat.send({ turnId: 't1', agentId: 'finance', text: 'hi', isolation: { settingSources: ['user'], disableAllHooks: true } }))
    const o = calls[0]!.options
    expect(o.settingSources).toEqual(['user'])
    expect(o.settings).toEqual({ disableAllHooks: true })
  })

  // R9: with hooks off pre-cron.sh never runs, so CronCreate is withheld
  // from the tool set; a hooked turn keeps the hook as its fence
  // the native scheduler is withheld from EVERY
  // unattended turn — tied to `unattended`, never to hooks (a run that
  // inherits hooks keeps the deny) — and a heartbeat turn runs with no web,
  // no subagents, no question, no MCP server at all, a turn cap, and hooks
  // off FIXED (G4-r6) whatever its isolation says
  it('CronCreate on every unattended turn; a heartbeat adds the whole prevention', async () => {
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls) })
    await collect(
      chat.send({
        turnId: 't1',
        agentId: 'finance',
        text: 'hi',
        unattended: true,
        turn: { class: 'run', automationId: 'a1' },
        isolation: { settingSources: ['user'], disableAllHooks: true },
      }),
    )
    await collect(chat.send({ turnId: 't2', agentId: 'finance', text: 'hi', unattended: true, turn: { class: 'run', automationId: 'a1' } }))
    await collect(chat.send({ turnId: 't3', agentId: 'finance', text: 'hi' }))
    await collect(chat.send({ turnId: 't4', agentId: 'finance', text: 'hi', unattended: true, turn: { class: 'heartbeat', kind: 'look', packetKeys: [] } }))
    expect(calls[0]!.options.disallowedTools).toEqual(['CronCreate', 'RemoteTrigger'])
    expect(calls[1]!.options.disallowedTools).toEqual(['CronCreate', 'RemoteTrigger'])
    expect('disallowedTools' in calls[2]!.options).toBe(false)
    const hb = calls[3]!.options
    expect(hb.disallowedTools).toEqual([
      'CronCreate',
      'WebFetch',
      'WebSearch',
      'Agent',
      'Task',
      'AskUserQuestion',
      'Skill(schedule)',
      'Skill(loop)',
      'Workflow',
      'RemoteTrigger',
      'ScheduleWakeup',
      'SendMessage',
    ])
    expect(hb.mcpServers).toEqual({})
    expect(hb.strictMcpConfig).toBe(true)
    expect(hb.maxTurns).toBe(30)
    expect((hb.settings as { disableAllHooks?: boolean }).disableAllHooks).toBe(true)
  })

  // R7: a hooks-off turn is briefed for the skills IT loads —
  // the folder's when settingSources has project, the account's personal
  // ones when it has user, none with neither.
  it("sdkTurnSkills: project → the folder's active skills; user → the account's; neither → []", () => {
    const root = mkdtempSync(join(tmpdir(), 'sdk-skills-'))
    const mk = (dir: string, n: string) => {
      mkdirSync(join(dir, n), { recursive: true })
      writeFileSync(join(dir, n, 'SKILL.md'), 'x')
    }
    const folder = join(root, 'proj')
    mk(join(folder, '.claude', 'skills'), 'team-plan')
    mkdirSync(join(folder, '.claude', 'skills', 'no-skill-md'), { recursive: true })
    const home = join(root, 'home')
    mk(join(home, '.claude', 'skills'), 'heartbeat')
    const account = join(root, 'account')
    mk(join(account, 'skills'), 'vault-secrets')
    expect(sdkTurnSkills(folder, ['user', 'project', 'local'], null, home)).toEqual(['heartbeat', 'team-plan'])
    expect(sdkTurnSkills(folder, ['user'], account, home)).toEqual(['vault-secrets'])
    expect(sdkTurnSkills(folder, ['project'], null, home)).toEqual(['team-plan'])
    expect(sdkTurnSkills(folder, [], null, home)).toEqual([])
    expect(briefingText(sdkTurnSkills(folder, [], null, home))).toBe(briefingText([]))
  })

  // Hooks off = no SessionStart at all: the same briefing + roster ride the
  // append (harnesses/briefing.ts), before the charter. A hooked turn carries
  // the briefing alone, after the charter — its roster comes from its hook.
  it('a run with its hooks off gets the Silos briefing and the fleet in its append; a hooked turn gets the briefing, not the fleet', async () => {
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls) })
    await collect(chat.send({ turnId: 't1', agentId: 'finance', text: 'hi', isolation: { settingSources: ['user'], disableAllHooks: true } }))
    const isolated = (calls[0]!.options.systemPrompt as any).append as string
    expect(isolated.startsWith(silosBriefing(registry.list(), 'finance', { withBearer: false, has: sdkTurnSkills('/tmp/ci', ['user'], null) }))).toBe(true)
    expect(isolated).toContain('# You are running inside Silos')
    expect(isolated).toContain('Your fleet (Silos):')
    expect(isolated.endsWith(`Your mission: charter\n\n${AUTOMATIONS_NOTE}\n\n${CLAUDE_ASK}`)).toBe(true)
    calls.length = 0
    await collect(chat.send({ turnId: 't2', agentId: 'finance', text: 'hi', isolation: { settingSources: ['user'] } }))
    const withHooks = (calls[0]!.options.systemPrompt as any).append as string
    expect(withHooks).toBe(hooked(`Your mission: charter\n\n${AUTOMATIONS_NOTE}\n\n${CLAUDE_ASK}`, '/tmp/ci', ['user']))
    expect(withHooks).toContain('# You are running inside Silos')
    expect(withHooks).not.toContain('Your fleet (Silos):')
  })

  // «the reader first»: every Claude turn WITHOUT
  // hooks (wakes, runs, heartbeats) carries «Your Silos inbox» in its append;
  // a turn with hooks (an inheritHooks run, the owner's chat) gets it from its
  // own SessionStart — never twice. An unattended turn marks what it was
  // served only when it ends WITH output.
  it('a turn with its hooks off carries «Your Silos inbox»; a hooked turn does not; read only at an unattended end with output', async () => {
    const messages = new MessageStore(base)
    const liveTurns = new LiveTurns()
    const m = messages.send({ from: 'plain', to: 'finance', text: 'the invoice from Monday' })
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls), liveTurns, messageReads: new MessageReads(messages, liveTurns) })
    await collect(
      chat.send({
        turnId: 't1',
        agentId: 'finance',
        text: 'hi',
        unattended: true,
        turn: { class: 'wake', taskKey: 'k' },
        isolation: { settingSources: ['user'], disableAllHooks: true },
      }),
    )
    const append = (calls[0]!.options.systemPrompt as any).append as string
    expect(append).toContain('Your Silos inbox: 1 unread message.')
    expect(append).toContain(`(${m.id}): the invoice from Monday`)
    // the wake produced output and ended: what it was served is read now
    expect(messages.get('finance', m.id)?.state).toBe('read')
    calls.length = 0
    messages.send({ from: 'plain', to: 'finance', text: 'another' })
    // an inheritHooks run travels without isolation: its SessionStart lists it
    await collect(chat.send({ turnId: 't2', agentId: 'finance', text: 'hi', unattended: true, turn: { class: 'run', automationId: 'a1' } }))
    expect((calls[0]!.options.systemPrompt as any).append).not.toContain('Your Silos inbox')
  })

  it('an unattended turn that produced nothing marks nothing (a dead turn eats no message)', async () => {
    const messages = new MessageStore(base)
    const liveTurns = new LiveTurns()
    const m = messages.send({ from: 'plain', to: 'finance', text: 'look' })
    const dead: SdkMessage[] = [
      { type: 'system', subtype: 'init', session_id: 's-dead' },
      { type: 'result', subtype: 'error_during_execution', total_cost_usd: 0 },
    ]
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(dead, calls), liveTurns, messageReads: new MessageReads(messages, liveTurns) })
    await collect(
      chat.send({
        turnId: 't1',
        agentId: 'finance',
        text: 'hi',
        unattended: true,
        turn: { class: 'wake', taskKey: 'k' },
        isolation: { settingSources: ['user'], disableAllHooks: true },
      }),
    ).catch(() => [])
    expect((calls[0]!.options.systemPrompt as any).append).toContain('Your Silos inbox')
    expect(messages.get('finance', m.id)?.state).toBe('new')
  })

  it('with no isolation, settings is not added (the original behavior)', async () => {
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls) })
    await collect(chat.send({ turnId: 't1', agentId: 'finance', text: 'hi' }))
    expect('settings' in calls[0]!.options).toBe(false)
  })

  it('maps rate_limit_event to chat-ratelimit (resetsAt epoch ms -> ISO)', async () => {
    const script: SdkMessage[] = [
      { type: 'system', subtype: 'init', session_id: 's-rl' },
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt: 1_755_600_000_000, rateLimitType: 'five_hour', utilization: 100 },
      } as unknown as SdkMessage,
      { type: 'result', subtype: 'error_during_execution', total_cost_usd: 0 },
    ]
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(script, calls) })
    const events = await collect(chat.send({ turnId: 't', agentId: 'finance', text: 'x' }))
    expect(events[1]).toEqual({
      ev: 'chat-ratelimit',
      turnId: 't',
      status: 'rejected',
      resetsAt: new Date(1_755_600_000_000).toISOString(),
      kind: 'five_hour',
      utilization: 100,
    })
  })

  it('emits chat-event with agentId for every event (so the resident can listen for chat-done without driving the generator)', async () => {
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls) })
    const heard: { agentId: string; event: { ev: string } }[] = []
    chat.on('chat-event', (m: { agentId: string; event: { ev: string } }) => heard.push(m))
    await collect(chat.send({ turnId: 't1', agentId: 'finance', text: 'hi' }))
    expect(heard.some((h) => h.agentId === 'finance' && h.event.ev === 'chat-done')).toBe(true)
  })

  it('cleans the CLAUDE* env for the SDK subprocess (the SDK does not merge with process.env)', async () => {
    process.env.CLAUDECODE_FAKE = '1'
    try {
      const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls) })
      await collect(chat.send({ turnId: 't1', agentId: 'finance', text: 'hi' }))
      const env = calls[0]!.options.env as Record<string, string>
      expect(env).toBeDefined()
      expect(Object.keys(env).some((k) => /^CLAUDE/.test(k))).toBe(false)
      expect(env.PATH).toBeDefined()
    } finally {
      delete process.env.CLAUDECODE_FAKE
    }
  })

  it('injects SILOS_AGENT_STATE from the agentState dep, merged after the provider env', async () => {
    const agentState = new AgentStateStore(mkdtempSync(join(tmpdir(), 'chat-agent-state-')))
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls), agentState })
    await collect(chat.send({ turnId: 't1', agentId: 'finance', text: 'hi' }))
    const env = calls[0]!.options.env as Record<string, string>
    expect(env.SILOS_AGENT_STATE).toBe(agentState.dirFor('finance'))
  })

  // E10 #39: SILOS_API is the server's own address, set AFTER the Vault (a
  // secret can't point the agent at another Silos) and never inherited.
  it("SILOS_API: the server's address, after the Vault, never inherited", async () => {
    const prev = process.env.SILOS_API
    process.env.SILOS_API = 'http://127.0.0.1:3210'
    try {
      const vault = { envFor: () => ({ SILOS_API: 'http://evil.example', OTHER: 'x' }) } as unknown as ConstructorParameters<typeof ChatService>[0]['vault']
      const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls), vault, silosApi: 'http://127.0.0.1:3299' })
      await collect(chat.send({ turnId: 't1', agentId: 'finance', text: 'hi' }))
      const env = calls[0]!.options.env as Record<string, string>
      expect(env.SILOS_API).toBe('http://127.0.0.1:3299')
      expect(env.OTHER).toBe('x')
    } finally {
      if (prev === undefined) delete process.env.SILOS_API
      else process.env.SILOS_API = prev
    }
  })

  // Births (plugin 0.7.0): the SDK session id is chosen BY
  // SILOS for a new session and a fork (the SDK's `sessionId` option), the
  // birth record is written BEFORE query() runs — so the session's own
  // birth marker (hook, at start) can never find it without a native record
  // and read it as nested — and the claude knows its conversation as
  // SILOS_SESSION_ID on every turn, new, resume or fork.
  it('new and fork: a pre-assigned sessionId, native registered before query(), SILOS_SESSION_ID on every kind of turn', async () => {
    const prev = process.env.SILOS_SESSION_ID
    process.env.SILOS_SESSION_ID = 'inherited-parent-session'
    try {
      const agentState = new AgentStateStore(mkdtempSync(join(tmpdir(), 'chat-agent-state-')))
      const nativeAtCall: boolean[] = []
      const q = fakeQuery(SCRIPT, calls)
      const queryFn = (args: QueryArgs) => {
        const id = args.options.sessionId as string | undefined
        nativeAtCall.push(id !== undefined && native.get('-tmp-ci', id)?.agentId === 'finance')
        return q(args)
      }
      const chat = new ChatService({ registry, native, queryFn, agentState })
      await collect(chat.send({ turnId: 't1', agentId: 'finance', text: 'hi' }))
      await collect(chat.send({ turnId: 't2', agentId: 'finance', text: 'go on', resume: { sessionId: 'sess-1', mode: 'append' } }))
      await collect(chat.send({ turnId: 't3', agentId: 'finance', text: 'fork', resume: { sessionId: 'sess-ext', mode: 'fork' } }))
      const env = (i: number) => calls[i]!.options.env as Record<string, string>
      const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      expect(calls[0]!.options.sessionId).toMatch(UUID)
      expect(env(0).SILOS_SESSION_ID).toBe(calls[0]!.options.sessionId)
      expect('sessionId' in calls[1]!.options).toBe(false) // the SDK forbids sessionId with a plain resume
      expect(env(1).SILOS_SESSION_ID).toBe('sess-1')
      expect(calls[2]!.options.sessionId).toMatch(UUID)
      expect(env(2).SILOS_SESSION_ID).toBe(calls[2]!.options.sessionId)
      expect(nativeAtCall).toEqual([true, false, true])
    } finally {
      if (prev === undefined) delete process.env.SILOS_SESSION_ID
      else process.env.SILOS_SESSION_ID = prev
    }
  })

  it("master's turn carries its OWN SILOS_AGENT_TOKEN — minted for it, never the inherited one", async () => {
    const prev = process.env.SILOS_AGENT_TOKEN
    process.env.SILOS_AGENT_TOKEN = 'inherited-parent-bearer'
    try {
      const dataDir = mkdtempSync(join(tmpdir(), 'chat-master-tok-'))
      const tokens = new AgentTokens(dataDir)
      const agentState = new AgentStateStore(join(dataDir, 'agent-state'), tokens)
      const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls), agentState })
      await collect(chat.send({ turnId: 't1', agentId: 'master', text: 'hi', cwd: dataDir }))
      await collect(chat.send({ turnId: 't2', agentId: 'finance', text: 'hi' }))
      const masterEnv = calls[0]!.options.env as Record<string, string>
      expect(masterEnv.SILOS_AGENT_ID).toBe('master')
      expect(masterEnv.SILOS_AGENT_TOKEN).toBe(tokens.tokenFor('master'))
      expect(tokens.agentIdOf(masterEnv.SILOS_AGENT_TOKEN!)).toBe('master')
      expect((calls[1]!.options.env as Record<string, string>).SILOS_AGENT_TOKEN).toBe(tokens.tokenFor('finance'))
    } finally {
      if (prev === undefined) delete process.env.SILOS_AGENT_TOKEN
      else process.env.SILOS_AGENT_TOKEN = prev
    }
  })

  it("a role with skills: query() gets plugins [{type:'local'}] and the manifest is ensured (role-plugin.ts)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'chat-role-skills-'))
    const agentState = new AgentStateStore(join(dataDir, 'agent-state'), new AgentTokens(dataDir))
    const skillDir = join(dataDir, 'agent-state', 'finance', 'plugin', 'skills', 'invoices')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: invoices\ndescription: x\n---\n')
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls), agentState })
    await collect(chat.send({ turnId: 't1', agentId: 'finance', text: 'hi' }))
    const o = calls[0]!.options as Record<string, any>
    expect(o.plugins).toEqual([{ type: 'local', path: join(dataDir, 'agent-state', 'finance', 'plugin') }])
    expect(existsSync(join(dataDir, 'agent-state', 'finance', 'plugin', '.claude-plugin', 'plugin.json'))).toBe(true)
  })

  it('a role without skills: no plugins option at all', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'chat-role-none-'))
    const agentState = new AgentStateStore(join(dataDir, 'agent-state'), new AgentTokens(dataDir))
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls), agentState })
    await collect(chat.send({ turnId: 't1', agentId: 'finance', text: 'hi' }))
    expect((calls[0]!.options as Record<string, unknown>).plugins).toBeUndefined()
  })

  it('a fenced agent: query() gets settings.permissions and additionalDirectories from the territory dep', async () => {
    const fence = {
      permissions: { deny: ['Read(//home/u/.silos/*.json)', 'Edit(//home/u/.silos/*.json)'], additionalDirectories: ['/srv/b', '/state/finance'] },
    }
    const asked: string[] = []
    const territory = {
      fenceFor: (id: string) => {
        asked.push(id)
        return id === 'finance' ? fence : null
      },
    }
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls), territory })
    await collect(chat.send({ turnId: 't1', agentId: 'finance', text: 'hi' }))
    expect(asked).toEqual(['finance'])
    const o = calls[0]!.options as Record<string, any>
    expect(o.settings.permissions.deny).toEqual(fence.permissions.deny)
    expect(o.settings.permissions.additionalDirectories).toEqual(['/srv/b', '/state/finance'])
    expect(o.additionalDirectories).toEqual(['/srv/b', '/state/finance'])
  })

  it('the fence merges with the other settings keys (isolation disableAllHooks)', async () => {
    const fence = { permissions: { deny: ['Read(//x/**)'], additionalDirectories: [] } }
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls), territory: { fenceFor: () => fence } })
    await collect(chat.send({ turnId: 't1', agentId: 'finance', text: 'hi', isolation: { settingSources: [], disableAllHooks: true } }))
    const o = calls[0]!.options as Record<string, any>
    expect(o.settings).toEqual({ disableAllHooks: true, permissions: fence.permissions })
  })

  it('no fence (master, or no territory dep): neither settings nor additionalDirectories appear', async () => {
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls), territory: { fenceFor: () => null } })
    await collect(chat.send({ turnId: 't1', agentId: 'finance', text: 'hi' }))
    const plain = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls) })
    await collect(plain.send({ turnId: 't2', agentId: 'finance', text: 'hi' }))
    for (const c of calls) {
      expect('settings' in c.options).toBe(false)
      expect('additionalDirectories' in c.options).toBe(false)
    }
  })

  it('an id the state store rejects degrades to no SILOS_AGENT_STATE instead of aborting the turn', async () => {
    // Only a hand-edited agents.json can hold an id that isn't a single safe
    // path segment — create() would never accept one.
    const file = join(base, 'hand-edited.json')
    writeFileSync(file, JSON.stringify({ agents: [{ id: '../escape', name: 'Odd', emoji: '🙃', role: '', folder: '/tmp/ci', skills: [] }] }))
    const handEdited = new AgentRegistry(file)
    handEdited.load()
    const agentState = new AgentStateStore(mkdtempSync(join(tmpdir(), 'chat-agent-state-')))
    const chat = new ChatService({ registry: handEdited, native, queryFn: fakeQuery(SCRIPT, calls), agentState })
    const events = await collect(chat.send({ turnId: 't1', agentId: '../escape', text: 'hi' }))
    expect(events.at(-1)).toMatchObject({ ev: 'chat-done' })
    const env = calls[0]!.options.env as Record<string, string>
    expect(env.SILOS_AGENT_STATE).toBeUndefined()
  })

  it("the skills note derives from the FOLDER's active skills — never agent.skills — and only when the folder has some", async () => {
    // capability states: <folder>/.claude/skills is the enforcement
    // unit; the agents.json `skills` declaration no longer drives the line.
    const withSkills = mkdtempSync(join(tmpdir(), 'deck-folder-skills-'))
    mkdirSync(join(withSkills, '.claude', 'skills', 'finance-skill'), { recursive: true })
    writeFileSync(join(withSkills, '.claude', 'skills', 'finance-skill', 'SKILL.md'), '---\ndescription: d\n---\nx')
    registry.create({ id: 'foldered', name: 'Foldered', folder: withSkills }) // declares NO skills — the folder does
    const noSkills = mkdtempSync(join(tmpdir(), 'deck-folder-empty-'))
    registry.create({ id: 'declared', name: 'Declared', folder: noSkills, skills: ['finance-skill'] }) // declares, folder empty
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls) })
    await collect(chat.send({ turnId: 't1', agentId: 'foldered', text: 'give me the VAT' }))
    expect(calls[0]!.prompt).toBe('give me the VAT') // the owner's words, untouched
    expect((calls[0]!.options.systemPrompt as any).append).toContain(
      'Your skills for this session include /finance-skill — load them when the task calls for them.',
    )
    calls.length = 0
    await collect(chat.send({ turnId: 't2', agentId: 'declared', text: 'hi' }))
    expect(calls[0]!.prompt).toBe('hi') // nothing active in the folder -> no preamble, whatever agents.json declares
    expect(calls[0]!.options.model).toBeUndefined()
    expect((calls[0]!.options.systemPrompt as any).append).toBe(hooked(`${AUTOMATIONS_NOTE}\n\n${CLAUDE_ASK}`, noSkills))
  })

  it('the skills note caps the list at 8 names', async () => {
    const many = mkdtempSync(join(tmpdir(), 'deck-many-'))
    for (let i = 0; i < 10; i++) {
      const dir = join(many, '.claude', 'skills', `s${String(i).padStart(2, '0')}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), 'x')
    }
    registry.create({ id: 'maxi', name: 'Maxi', folder: many })
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls) })
    await collect(chat.send({ turnId: 't1', agentId: 'maxi', text: 'go' }))
    expect(calls[0]!.prompt).toBe('go')
    expect((calls[0]!.options.systemPrompt as any).append).toContain('include /s00, /s01, /s02, /s03, /s04, /s05, /s06, /s07 — load')
  })

  it("the skills note names Silos' own skills before the cut of 8", async () => {
    const many = mkdtempSync(join(tmpdir(), 'deck-silos-skills-'))
    for (const n of ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'heartbeat', 'team-plan']) {
      const dir = join(many, '.claude', 'skills', n)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), 'x')
    }
    registry.create({ id: 'ord', name: 'Ord', folder: many })
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls) })
    await collect(chat.send({ turnId: 't1', agentId: 'ord', text: 'go' }))
    expect((calls[0]!.options.systemPrompt as any).append).toContain('include /heartbeat, /team-plan, /a0, /a1, /a2, /a3, /a4, /a5 — load')
  })

  it('non-empty agent memory gets added to systemPrompt.append AFTER systemAppend', async () => {
    mkdirSync(join(base, 'agents', 'finance'), { recursive: true })
    writeFileSync(join(base, 'agents', 'finance', 'memory.md'), 'Some memory notes\n')
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls), dataDir: base })
    await collect(chat.send({ turnId: 't1', agentId: 'finance', text: 'hi' }))
    expect((calls[0]!.options.systemPrompt as any).append).toBe(
      hooked(`Your mission: charter\n\n# Agent memory\nSome memory notes\n\n${AUTOMATIONS_NOTE}\n\n${CLAUDE_ASK}`),
    )
  })

  it('with no systemAppend, the agent memory is the whole append (no prior systemAppend)', async () => {
    mkdirSync(join(base, 'agents', 'plain'), { recursive: true })
    writeFileSync(join(base, 'agents', 'plain', 'memory.md'), "plain's notes")
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls), dataDir: base })
    await collect(chat.send({ turnId: 't1', agentId: 'plain', text: 'hi' }))
    expect((calls[0]!.options.systemPrompt as any).append).toBe(hooked(`# Agent memory\nplain's notes\n\n${AUTOMATIONS_NOTE}\n\n${CLAUDE_ASK}`))
  })

  it('a missing memory file adds nothing', async () => {
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls), dataDir: base })
    await collect(chat.send({ turnId: 't1', agentId: 'finance', text: 'hi' }))
    expect((calls[0]!.options.systemPrompt as any).append).toBe(hooked(`Your mission: charter\n\n${AUTOMATIONS_NOTE}\n\n${CLAUDE_ASK}`)) // no memory: just the usual charter
  })

  it('an empty memory file (or whitespace-only) adds nothing', async () => {
    mkdirSync(join(base, 'agents', 'finance'), { recursive: true })
    writeFileSync(join(base, 'agents', 'finance', 'memory.md'), '   \n\n  ')
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls), dataDir: base })
    await collect(chat.send({ turnId: 't1', agentId: 'finance', text: 'hi' }))
    expect((calls[0]!.options.systemPrompt as any).append).toBe(hooked(`Your mission: charter\n\n${AUTOMATIONS_NOTE}\n\n${CLAUDE_ASK}`))
  })

  it('with no dataDir in ChatDeps (compat), agent memory is never injected', async () => {
    // the file is never even created: this test only checks that
    // ChatService keeps working without dataDir — a safe degradation (see ChatDeps.dataDir).
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls) })
    await collect(chat.send({ turnId: 't1', agentId: 'finance', text: 'hi' }))
    expect((calls[0]!.options.systemPrompt as any).append).toBe(hooked(`Your mission: charter\n\n${AUTOMATIONS_NOTE}\n\n${CLAUDE_ASK}`))
  })

  it('master/nonexistent/archived get rejected', async () => {
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls) })
    await expect(collect(chat.send({ turnId: 't', agentId: 'master', text: 'x' }))).rejects.toThrow('master')
    await expect(collect(chat.send({ turnId: 't', agentId: 'nobody', text: 'x' }))).rejects.toThrow('not found')
    registry.archive('plain')
    await expect(collect(chat.send({ turnId: 't', agentId: 'plain', text: 'x' }))).rejects.toThrow('archived')
  })

  it('master (folder null) with no effective cwd rejects (message unchanged)', async () => {
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls) })
    await expect(collect(chat.send({ turnId: 't', agentId: MASTER_ID, text: 'x' }))).rejects.toThrow('master agent has no folder')
  })

  it("master with an effective cwd: options.cwd uses the given cwd and the session registers in native under THAT cwd's munged folder", async () => {
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls) })
    const cwd = '/tmp/some-master-project'
    const events = await collect(chat.send({ turnId: 't', agentId: MASTER_ID, text: 'x', cwd }))
    expect(calls[0]!.options.cwd).toBe(cwd)
    expect(events[0]).toEqual({ ev: 'chat-init', turnId: 't', folder: mungePath(cwd), sessionId: 'sess-1' })
    expect(native.get(mungePath(cwd), 'sess-1')?.agentId).toBe(MASTER_ID)
  })

  it('an agent with a folder ignores an extraneous effective cwd: uses agent.folder', async () => {
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls) })
    await collect(chat.send({ turnId: 't', agentId: 'finance', text: 'x', cwd: '/other/folder/unused' }))
    expect(calls[0]!.options.cwd).toBe('/tmp/ci')
  })

  it('an SDK error -> chat-error and terminates', async () => {
    const boom: any = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 's' } as SdkMessage
        throw new Error('the subprocess blew up')
      },
      async interrupt() {
        return {}
      },
    }
    const chat = new ChatService({ registry, native, queryFn: () => boom })
    const events = await collect(chat.send({ turnId: 't1', agentId: 'finance', text: 'x' }))
    expect(events.at(-1)).toEqual({ ev: 'chat-error', turnId: 't1', error: 'the subprocess blew up' })
  })
})

describe('ChatService.send — continuation', () => {
  const FORK_SCRIPT: SdkMessage[] = [
    { type: 'system', subtype: 'init', session_id: 'sess-FORK' },
    { type: 'result', subtype: 'success', session_id: 'sess-FORK', total_cost_usd: 0 },
  ]

  it('append: passes resume with no forkSession and does NOT re-register in native', async () => {
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls) })
    await collect(chat.send({ turnId: 't1', agentId: 'finance', text: 'go on', resume: { sessionId: 'sess-1', mode: 'append' } }))
    expect(calls[0]!.options.resume).toBe('sess-1')
    expect(calls[0]!.options.forkSession).toBeUndefined()
    expect(calls[0]!.prompt).toBe('go on') // no preamble on continuation
    expect(native.get('-tmp-ci', 'sess-1')).toBeNull() // append doesn't register (it would already be registered if native)
  })

  it('fork: passes forkSession true and registers the NEW session_id', async () => {
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(FORK_SCRIPT, calls) })
    const events = await collect(
      chat.send({ turnId: 't2', agentId: 'finance', text: 'continue this', resume: { sessionId: 'sess-old-external', mode: 'fork' } }),
    )
    expect(calls[0]!.options.resume).toBe('sess-old-external')
    expect(calls[0]!.options.forkSession).toBe(true)
    expect(events[0]).toEqual({ ev: 'chat-init', turnId: 't2', folder: '-tmp-ci', sessionId: 'sess-FORK' })
    expect(native.get('-tmp-ci', 'sess-FORK')?.agentId).toBe('finance') // the BRANCH is native; the original is left untouched
  })

  it('chains: fork records the lineage (child -> source), append records nothing', async () => {
    const lineage = new LineageStore(join(base, 'lineage.json'))
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(FORK_SCRIPT, calls), lineage })
    await collect(chat.send({ turnId: 't2', agentId: 'finance', text: 'continue this', resume: { sessionId: 'sess-old-external', mode: 'fork' } }))
    expect(lineage.parentOf('-tmp-ci/sess-FORK')).toBe('-tmp-ci/sess-old-external')

    const chat2 = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls), lineage })
    await collect(chat2.send({ turnId: 't3', agentId: 'finance', text: 'go on', resume: { sessionId: 'sess-1', mode: 'append' } }))
    expect(lineage.parentOf('-tmp-ci/sess-1')).toBeNull()
  })

  it('chains: with no lineage injected, fork breaks nothing (a safe degradation)', async () => {
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(FORK_SCRIPT, calls) })
    const events = await collect(
      chat.send({ turnId: 't2', agentId: 'finance', text: 'continue this', resume: { sessionId: 'sess-old-external', mode: 'fork' } }),
    )
    expect(events[0]).toEqual({ ev: 'chat-init', turnId: 't2', folder: '-tmp-ci', sessionId: 'sess-FORK' })
  })
})

describe('ChatService.send — per-session turn lock', () => {
  it('a second turn resuming the same session collides with the first one in progress; once released, a third works', async () => {
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const blockingQuery = (): SdkQueryHandle => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'sess-1' } as SdkMessage
        await gate
        yield { type: 'result', subtype: 'success', session_id: 'sess-1', total_cost_usd: 0 } as SdkMessage
      },
      async interrupt() {
        return {}
      },
    })
    const chat = new ChatService({ registry, native, queryFn: blockingQuery })

    const firstGen = chat.send({ turnId: 't1', agentId: 'finance', text: 'continue', resume: { sessionId: 'sess-1', mode: 'append' } })
    const firstInit = await firstGen.next() // advances to init: the lock is already taken
    expect(firstInit.value).toMatchObject({ ev: 'chat-init' })

    await expect(collect(chat.send({ turnId: 't2', agentId: 'finance', text: 'another', resume: { sessionId: 'sess-1', mode: 'append' } }))).rejects.toThrow(
      'a turn is already in progress for this session',
    )

    releaseFirst()
    const rest = await collect(firstGen as AsyncGenerator<unknown>)
    expect(rest.at(-1)).toEqual({ ev: 'chat-done', turnId: 't1', subtype: 'success', costUsd: 0 })

    const third = await collect(chat.send({ turnId: 't3', agentId: 'finance', text: 'done', resume: { sessionId: 'sess-1', mode: 'append' } }))
    expect(third.at(-1)).toEqual({ ev: 'chat-done', turnId: 't3', subtype: 'success', costUsd: 0 })
  })

  it('a consumer that abandons the generator (return() after the first event) releases the lock and the inflight entry', async () => {
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls) })
    const gen = chat.send({ turnId: 't1', agentId: 'finance', text: 'continue', resume: { sessionId: 'sess-1', mode: 'append' } })
    const first = await gen.next()
    expect(first.value).toMatchObject({ ev: 'chat-init' })
    expect(chat.isSessionActive('sess-1')).toBe(true)
    expect(chat.isInflight('t1')).toBe(true)
    const done = await gen.return(undefined)
    expect(done.done).toBe(true)
    expect(chat.isSessionActive('sess-1')).toBe(false)
    expect(chat.isInflight('t1')).toBe(false)
    // the session takes a new turn at once
    const next = await collect(chat.send({ turnId: 't2', agentId: 'finance', text: 'again', resume: { sessionId: 'sess-1', mode: 'append' } }))
    expect(next.at(-1)).toEqual({ ev: 'chat-done', turnId: 't2', subtype: 'success', costUsd: 0.01 })
  })
})

describe('ChatService.isInflight', () => {
  it('true while the turn is in progress, false before it starts and after it finishes', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const blockingQuery = (): SdkQueryHandle => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'sess-x' } as SdkMessage
        await gate
        yield { type: 'result', subtype: 'success', session_id: 'sess-x', total_cost_usd: 0 } as SdkMessage
      },
      async interrupt() {
        return {}
      },
    })
    const chat = new ChatService({ registry, native, queryFn: blockingQuery })
    expect(chat.isInflight('t1')).toBe(false)

    const gen = chat.send({ turnId: 't1', agentId: 'finance', text: 'x' })
    await gen.next() // consumes init: the handle is already registered in the inflight map
    expect(chat.isInflight('t1')).toBe(true)
    expect(chat.isInflight('other-turn')).toBe(false)

    release()
    await collect(gen as AsyncGenerator<unknown>)
    expect(chat.isInflight('t1')).toBe(false)
  })
})

// a nonexistent cwd (a renamed repo, a stale path in agents.json) -> the SDK
// fails to spawn with a misleading libc message; the catch translates it to
// the HONEST error only when the real folder does not exist.
describe('ChatService.send — nonexistent folder (an honest error)', () => {
  function queryThatBlowsUp(msg: string): (args: QueryArgs) => SdkQueryHandle {
    return () =>
      ({
        async *[Symbol.asyncIterator]() {
          throw new Error(msg)
        },
        async interrupt() {
          return undefined
        },
      }) as unknown as SdkQueryHandle
  }
  const MISLEADING_SDK_ERROR = 'Claude Code native binary ... failed to launch ... musl dynamic loader (/lib/ld-musl-*) is missing.'

  it('a folder that does NOT exist -> chat-error with the honest message, not the libc one', async () => {
    registry.create({ id: 'moved', name: 'Moved', folder: '/path/that/does/not/exist/never-xyz' })
    const chat = new ChatService({ registry, native, queryFn: queryThatBlowsUp(MISLEADING_SDK_ERROR) })
    const events = await collect(chat.send({ turnId: 't', agentId: 'moved', text: 'hi' }))
    const err = events.find((e: any) => e.ev === 'chat-error') as any
    expect(err.error).toContain('agent folder does not exist')
    expect(err.error).toContain('/path/that/does/not/exist/never-xyz')
    expect(err.error).not.toContain('musl')
  })

  it("a folder that DOES exist -> the SDK's error is kept as-is (not rewritten)", async () => {
    registry.create({ id: 'exists', name: 'Exists', folder: base }) // base = mkdtemp, exists
    const chat = new ChatService({ registry, native, queryFn: queryThatBlowsUp('real SDK boom') })
    const events = await collect(chat.send({ turnId: 't', agentId: 'exists', text: 'hi' }))
    const err = events.find((e: any) => e.ev === 'chat-error') as any
    expect(err.error).toBe('real SDK boom')
  })
})

// The console injects the SAME identity a chat session gets — one agent,
// the same self on both engines (see the /api/console route).
describe('systemAppendFor', () => {
  it('returns the exact chat append for a known agent', () => {
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls) })
    expect(chat.systemAppendFor('finance', [])).toBe(`Your mission: charter\n\n${AUTOMATIONS_NOTE}\n\n${CLAUDE_ASK}`)
  })

  // E10 #31: the question tool is named per engine, in this append only;
  // the first 8 words — started-with's marker — never change
  it('an OpenCode agent is told its own question tool', () => {
    registry.create({ id: 'oc', name: 'Oc', folder: '/tmp/ci', framework: 'opencode' })
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls) })
    const append = chat.systemAppendFor('oc', [])!
    expect(append.endsWith(askDecisionsNote('question'))).toBe(true)
    expect(append).toContain('ask with the question tool')
    expect(append).not.toContain('AskUserQuestion')
    const eight = (s: string) => s.split(/\s+/).slice(0, 8).join(' ')
    expect(eight(askDecisionsNote('question'))).toBe(eight(ASK_DECISIONS_NOTE))
    expect(eight(CLAUDE_ASK)).toBe(eight(ASK_DECISIONS_NOTE))
  })

  it('an agent with no charter still gets the platform note', () => {
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls) })
    expect(chat.systemAppendFor('plain', [])).toBe(`${AUTOMATIONS_NOTE}\n\n${CLAUDE_ASK}`)
  })

  it('null for an unknown agent', () => {
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls) })
    expect(chat.systemAppendFor('ghost', [])).toBeNull()
  })
})

// t2 (R3): the mission reaches EVERY conversation of both
// engines as the head of the system append — Claude's SDK append and console
// (--append-system-prompt-file) and OpenCode's per-process `instructions`
// all read ChatService.systemAppendFor.
describe('the mission in the system append', () => {
  for (const framework of ['claude-code', 'opencode'] as const) {
    it(`${framework}: the text and its Never lines, in that order, before the platform notes`, () => {
      registry.create({
        id: 'm',
        name: 'M',
        folder: '/tmp/ci',
        framework,
        mission: { text: 'Taxes and accounts.', never: ['file anything', ' pay anything '] },
      })
      const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls) })
      const append = chat.systemAppendFor('m', [])!
      expect(append.startsWith("Your mission: Taxes and accounts.\nNever, without the owner's word:\n- file anything\n- pay anything\n\n")).toBe(true)
      expect(append).toContain(AUTOMATIONS_NOTE)
    })

    it(`${framework}: no Never line when the owner wrote none`, () => {
      registry.create({ id: 'm', name: 'M', folder: '/tmp/ci', framework, mission: { text: 'Answers the inbox' } })
      const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls) })
      const append = chat.systemAppendFor('m', [])!
      expect(append.startsWith('Your mission: Answers the inbox\n\n')).toBe(true)
      expect(append).not.toContain('Never, without')
    })
  }

  it('a saved change reaches the next conversation; a cleared mission leaves no trace', () => {
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls) })
    registry.update('finance', { mission: { text: 'Books only.', never: ['pay'] } })
    expect(chat.systemAppendFor('finance', [])!.startsWith("Your mission: Books only.\nNever, without the owner's word:\n- pay\n\n")).toBe(true)
    registry.update('finance', { mission: null })
    expect(chat.systemAppendFor('finance', [])).toBe(`${AUTOMATIONS_NOTE}\n\n${CLAUDE_ASK}`)
  })

  it('a responsibility (the old duty, alive until t3) never reaches the append', () => {
    registry.create({ id: 'old', name: 'Old', folder: '/tmp/ci', responsibility: 'keep the VPS alive' })
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls) })
    expect(chat.systemAppendFor('old', [])).toBe(`${AUTOMATIONS_NOTE}\n\n${CLAUDE_ASK}`)
  })

  it('the SDK turn carries it as systemPrompt.append', async () => {
    registry.update('finance', { mission: { text: 'Books only.', never: ['pay'] } })
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls) })
    await collect(chat.send({ turnId: 'tm', agentId: 'finance', text: 'hi' }))
    expect((calls[0]!.options.systemPrompt as any).append.startsWith("Your mission: Books only.\nNever, without the owner's word:\n- pay\n\n")).toBe(true)
  })
})

describe('context files added mid-session reach the NEXT turn as news', () => {
  // the SDK's init names the session the turn runs (the id Silos minted, or the resumed one)
  const echoQuery =
    (calls: QueryArgs[], opts: { failBeforeInit?: () => boolean } = {}) =>
    (args: QueryArgs): SdkQueryHandle => {
      calls.push(args)
      const sid = (args.options.sessionId ?? args.options.resume) as string
      const fail = opts.failBeforeInit?.() === true
      return {
        async *[Symbol.asyncIterator]() {
          if (fail) throw new Error('refused before the model')
          yield { type: 'system', subtype: 'init', session_id: sid }
          yield { type: 'result', subtype: 'success', session_id: sid, total_cost_usd: 0 }
        },
        async interrupt() {
          return { status: 'interrupted' as const }
        },
      }
    }
  const appendOf = (c: QueryArgs): string => (c.options.systemPrompt as { append: string }).append
  const resume = (sessionId: string) => ({ resume: { sessionId, mode: 'append' as const } })

  it('turn 1 lists the files; a file uploaded after it is called out on turn 2; turn 3 is quiet again', async () => {
    const { ContextService, CONTEXT_NEWS_HEADING } = await import('../src/context-service.js')
    const folder = mkdtempSync(join(tmpdir(), 'ctx-chat-'))
    registry.update('finance', { folder })
    const context = new ContextService()
    context.save(folder, 'shared', 'finance', 'guide.md', Buffer.from('g'))
    const calls: QueryArgs[] = []
    const chat = new ChatService({ registry, native, queryFn: echoQuery(calls), dataDir: base, context })
    await collect(chat.send({ turnId: 't1', agentId: 'finance', text: 'hi' }))
    const sid = calls[0]!.options.sessionId as string
    expect(appendOf(calls[0]!)).toContain('- context/shared/guide.md')
    expect(appendOf(calls[0]!)).not.toContain(CONTEXT_NEWS_HEADING)
    await new Promise((r) => setTimeout(r, 5))
    context.save(folder, 'agent', 'finance', '036-08-26.pdf', Buffer.from('%PDF'))
    await collect(chat.send({ turnId: 't2', agentId: 'finance', text: 'again', ...resume(sid) }))
    expect(appendOf(calls[1]!)).toContain(`${CONTEXT_NEWS_HEADING}\n- context/finance/036-08-26.pdf`)
    await new Promise((r) => setTimeout(r, 5))
    await collect(chat.send({ turnId: 't3', agentId: 'finance', text: 'and', ...resume(sid) }))
    expect(appendOf(calls[2]!)).not.toContain(CONTEXT_NEWS_HEADING)
  })

  it('news is per THREAD: two conversations of one agent both learn of a new top-level file, and a console open eats it for neither', async () => {
    const { ContextService, CONTEXT_NEWS_HEADING } = await import('../src/context-service.js')
    const folder = mkdtempSync(join(tmpdir(), 'ctx-chat-'))
    registry.update('finance', { folder })
    const context = new ContextService()
    context.save(folder, 'shared', 'finance', 'guide.md', Buffer.from('g'))
    const calls: QueryArgs[] = []
    const chat = new ChatService({ registry, native, queryFn: echoQuery(calls), dataDir: base, context })
    await collect(chat.send({ turnId: 'a1', agentId: 'finance', text: 'hi' }))
    await collect(chat.send({ turnId: 'b1', agentId: 'finance', text: 'hi' }))
    const [a, b] = [calls[0]!.options.sessionId as string, calls[1]!.options.sessionId as string]
    await new Promise((r) => setTimeout(r, 5))
    context.save(folder, 'agent', 'finance', 'new.pdf', Buffer.from('%PDF'))
    // a console of the same agent opens (and of thread A itself): a launch, never a turn
    chat.systemAppendFor('finance', [])
    chat.systemAppendFor('finance', [], { sessionId: a, cwd: folder })
    await collect(chat.send({ turnId: 'a2', agentId: 'finance', text: 'x', ...resume(a) }))
    await collect(chat.send({ turnId: 'b2', agentId: 'finance', text: 'x', ...resume(b) }))
    expect(appendOf(calls[2]!)).toContain(`${CONTEXT_NEWS_HEADING}\n- context/finance/new.pdf`)
    expect(appendOf(calls[3]!)).toContain(`${CONTEXT_NEWS_HEADING}\n- context/finance/new.pdf`)
  })

  it('a queued line is printed once, only to its thread, and survives a turn that fails before init', async () => {
    const { ContextService, CONTEXT_GIVEN_HEADING } = await import('../src/context-service.js')
    const { queueContextNews, readContextNews } = await import('../src/context-news.js')
    const folder = mkdtempSync(join(tmpdir(), 'ctx-chat-'))
    registry.update('finance', { folder })
    const context = new ContextService()
    const calls: QueryArgs[] = []
    let failNext = false
    const chat = new ChatService({ registry, native, queryFn: echoQuery(calls, { failBeforeInit: () => failNext }), dataDir: base, context })
    await collect(chat.send({ turnId: 'a1', agentId: 'finance', text: 'hi' }))
    await collect(chat.send({ turnId: 'b1', agentId: 'finance', text: 'hi' }))
    const [a, b] = [calls[0]!.options.sessionId as string, calls[1]!.options.sessionId as string]
    context.save(folder, 'conversation', 'finance', 'brief.md', Buffer.from('b'), a)
    const line = `context/finance/conversations/${a}/brief.md`
    queueContextNews(base, a, line)
    failNext = true
    const failed = await collect(chat.send({ turnId: 'a2', agentId: 'finance', text: 'x', ...resume(a) }))
    expect(failed.some((e) => e.ev === 'chat-error')).toBe(true)
    expect(appendOf(calls[2]!)).toContain(`${CONTEXT_GIVEN_HEADING}\n- ${line}`)
    expect(readContextNews(base, a)).toEqual([line]) // still queued
    failNext = false
    await collect(chat.send({ turnId: 'b2', agentId: 'finance', text: 'x', ...resume(b) }))
    expect(appendOf(calls[3]!)).not.toContain(CONTEXT_GIVEN_HEADING)
    expect(appendOf(calls[3]!)).not.toContain('brief.md')
    await collect(chat.send({ turnId: 'a3', agentId: 'finance', text: 'x', ...resume(a) }))
    expect(appendOf(calls[4]!)).toContain(`${CONTEXT_GIVEN_HEADING}\n- ${line}`)
    expect(appendOf(calls[4]!)).toContain(`Given to this conversation:\n- ${line}`)
    expect(readContextNews(base, a)).toEqual([])
    await collect(chat.send({ turnId: 'a4', agentId: 'finance', text: 'x', ...resume(a) }))
    expect(appendOf(calls[5]!)).not.toContain(CONTEXT_GIVEN_HEADING)
  })
})

describe('liveOn — «is something writing this conversation?»', () => {
  it('a resumed turn registers while it runs, with its unattended flag, and clears when it ends; a new session registers nothing', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const chat = new ChatService({
      registry,
      native,
      queryFn: (args) => {
        calls.push(args)
        return {
          async *[Symbol.asyncIterator]() {
            await gate
            for (const m of SCRIPT) yield m
          },
          async interrupt() {
            return { status: 'interrupted' as const }
          },
        }
      },
    })
    const done = collect(
      chat.send({
        turnId: 't-live',
        agentId: 'finance',
        text: 'hi',
        unattended: true,
        turn: { class: 'run' },
        resume: { sessionId: 'sess-1', mode: 'append' },
      }),
    )
    await new Promise((r) => setTimeout(r, 20))
    expect(chat.liveOn('sess-1')).toEqual({ turnId: 't-live', unattended: true })
    expect(chat.liveOn('sess-other')).toBeNull()
    release()
    await done
    expect(chat.liveOn('sess-1')).toBeNull()
  })

  it('a NEW session (no resume) never registers — it has no id to collide with', async () => {
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls) })
    await collect(chat.send({ turnId: 't-new', agentId: 'finance', text: 'hi' }))
    expect(chat.liveOn('sess-1')).toBeNull()
  })
})

describe('the unattended provider', () => {
  // one fake engine per harness: it resolves the provider through the
  // router's hook exactly as both real engines do (the turn's pin › the
  // agent's own, fallback applied) and says what it got
  type Seen = { turnId: string; provider: string | null }
  let seen: Seen[]
  let limitNext: string | null
  const fakeEngine = (ctx: HeadlessContext): HeadlessEngine => ({
    async *send(agent, input) {
      const turn = ctx.hooks.providerFor(agent, input.overrides?.provider, input.turnId)
      seen.push({ turnId: input.turnId, provider: turn.provider?.id ?? null })
      yield { ev: 'chat-init', turnId: input.turnId, folder: 'f', sessionId: `s-${input.turnId}` }
      if (limitNext) ctx.hooks.onRateLimit(agent, turn, { ev: 'chat-ratelimit', turnId: input.turnId, status: 'rejected', resetsAt: limitNext })
      yield { ev: 'chat-done', turnId: input.turnId, subtype: 'success', costUsd: 0.5 }
    },
    async cancel() {
      return false
    },
    isInflight() {
      return false
    },
    isSessionActive() {
      return false
    },
  })
  let providers: ProvidersStore
  let keyId: string
  let engineKeyId: string
  let switchTo: string | null
  const build = (): ChatService =>
    new ChatService({
      registry,
      native,
      queryFn: fakeQuery(SCRIPT, calls),
      providers,
      headless: { 'claude-code': fakeEngine, opencode: fakeEngine },
      settings: { unattendedProvider: () => switchTo },
    })

  beforeEach(() => {
    mkdirSync(join(base, 'claude-accounts', 'alt'), { recursive: true })
    providers = new ProvidersStore(base)
    providers.load()
    keyId = providers.create({ kind: 'anthropic-compatible', label: 'Gateway', baseUrl: 'https://gw.example', apiKey: 'sk-test-0000000000' }).id
    engineKeyId = providers.create({ kind: 'harness-provider', harness: 'opencode', providerId: 'zai', label: 'Zai', apiKey: 'zk-test-0000000000' }).id
    registry.create({ id: 'oc', name: 'Oc', folder: '/tmp/ci', framework: 'opencode' })
    seen = []
    limitNext = null
    switchTo = keyId
  })

  const run = (chat: ChatService, turnId: string, extra: Record<string, unknown> = {}, agentId = 'plain') =>
    collect(chat.send({ turnId, agentId, text: 'x', unattended: true, turn: { class: 'run', automationId: 'a1' }, ...extra }))

  it('an unattended turn naming no provider runs on the switch; an attended one keeps the agent’s own', async () => {
    const chat = build()
    await run(chat, 'u1')
    await collect(chat.send({ turnId: 'a1', agentId: 'plain', text: 'x' }))
    expect(seen).toEqual([
      { turnId: 'u1', provider: keyId },
      { turnId: 'a1', provider: 'default' },
    ])
  })

  it('no switch (null): each agent’s own cascade', async () => {
    switchTo = null
    await run(build(), 'u1')
    expect(seen[0]!.provider).toBe('default')
  })

  it('an automation’s runsOn.provider wins over the switch (the owner set it)', async () => {
    await run(build(), 'u1', { overrides: { provider: 'account:alt' } })
    expect(seen[0]!.provider).toBe('account:alt')
  })

  it('the owner’s own chat turn resent unattended (class chat) is not switched', async () => {
    await collect(build().send({ turnId: 'r1', agentId: 'plain', text: 'x', unattended: true, turn: { class: 'chat' } }))
    expect(seen[0]!.provider).toBe('default')
  })

  it('per engine: an agent whose engine cannot run the switch keeps its own; a vanished id is skipped', async () => {
    switchTo = 'account:alt' // a Claude account never runs on OpenCode
    const chat = build()
    await run(chat, 'oc1', {}, 'oc')
    await run(chat, 'cc1')
    switchTo = engineKeyId // an OpenCode key never reaches a Claude process
    await run(chat, 'cc2')
    await run(chat, 'oc2', {}, 'oc')
    switchTo = 'account:gone'
    await run(chat, 'cc3')
    expect(seen.map((s) => s.provider)).toEqual(['default', 'account:alt', 'default', engineKeyId, 'default'])
  })

  it('the agent’s fallback chain applies to the EFFECTIVE provider', async () => {
    registry.update('plain', { fallback: ['account:alt'] })
    const chat = build()
    limitNext = new Date(Date.now() + 3_600_000).toISOString()
    await run(chat, 'u1') // the switch's key hits its limit
    limitNext = null
    await run(chat, 'u2')
    expect(seen.map((s) => s.provider)).toEqual([keyId, 'account:alt'])
  })

  it('chat-done says whether the provider prices; the conversation remembers the switch put it there', async () => {
    const chat = build()
    const evs = await run(chat, 'u1')
    expect(evs.find((e) => e.ev === 'chat-done')).toMatchObject({ priced: true, costUsd: 0.5 })
    expect(chat.unattendedProviderOf('s-u1')).toBe(keyId)
    const plan = await run(chat, 'u2', { overrides: { provider: 'account:alt' } })
    expect(plan.find((e) => e.ev === 'chat-done')).toMatchObject({ priced: false })
    expect(chat.unattendedProviderOf('s-u2')).toBeNull()
  })
})

// The skills an SDK turn is told about are the skills it loads (scopes,
// found 24-11): the briefing's skill rules and the «Your skills for this
// session» note both read the launch's one answer (sdkTurnSkills ->
// loads/skills.ts launchSkillNames), so a skill turned off at ANY place is
// never named — the model would try it, the engine would refuse it, and its
// SKILL.md would still be readable in the folder. HOME is a temp dir: the
// machine's personal skills and settings are the test's own.
describe('an SDK turn names only the skills it loads', () => {
  const NOTE = 'Your skills for this session include'
  let folder: string, home: string, priorHome: string | undefined
  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'turn-skills-'))
    home = join(root, 'home')
    mkdirSync(home, { recursive: true })
    priorHome = process.env.HOME
    process.env.HOME = home
    folder = join(root, 'project')
    for (const n of ['team-plan', 'ledger-notes']) {
      mkdirSync(join(folder, '.claude', 'skills', n), { recursive: true })
      writeFileSync(join(folder, '.claude', 'skills', n, 'SKILL.md'), `---\nname: ${n}\ndescription: ${n}\n---\nx`)
    }
    registry.create({ id: 'builder', name: 'Builder', folder })
  })
  afterEach(() => {
    if (priorHome === undefined) delete process.env.HOME
    else process.env.HOME = priorHome
  })

  const turn = async (
    over: { carried?: (agentId: string, cwd?: string, conversation?: string) => unknown[]; send?: Record<string, unknown> } = {},
  ): Promise<string> => {
    const chat = new ChatService({ registry, native, queryFn: fakeQuery(SCRIPT, calls), ...(over.carried ? { loadsCarried: over.carried } : {}) } as any)
    calls.length = 0
    await collect(chat.send({ turnId: `t${calls.length}`, agentId: 'builder', text: 'hi', ...over.send } as any))
    return ((calls[0]!.options.systemPrompt as any).append ?? '') as string
  }
  const noteOf = (append: string): string | undefined => append.split('\n').find((l) => l.startsWith(NOTE))
  /** neither the note nor the briefing names team-plan; ledger-notes still named when the folder is read */
  const offEverywhere = (append: string, folderRead = true): void => {
    expect(noteOf(append)).toBe(folderRead ? `${NOTE} /ledger-notes — load them when the task calls for them.` : undefined)
    expect(append).toContain(briefingText([]))
    expect(append).not.toContain(briefingText(['team-plan']))
  }
  const local = (v: unknown): void => writeFileSync(join(folder, '.claude', 'settings.local.json'), JSON.stringify(v))

  it("nothing off: the append is byte-identical — the folder's skills, Silos' own first", async () => {
    const append = await turn()
    expect(append).toBe(
      `${withBriefingAfter(`${AUTOMATIONS_NOTE}\n\n${CLAUDE_ASK}`, briefingText(['team-plan']))}\n\n${NOTE} /team-plan, /ledger-notes — load them when the task calls for them.`,
    )
  })

  it('off for the agent (a launch entry)', async () => {
    offEverywhere(await turn({ carried: () => [{ skillOverrides: { 'team-plan': 'off' } }] }))
  })

  it("off for the conversation (its thread's entry, after its agent's «on»)", async () => {
    const carried = (_a: string, _c?: string, conversation?: string): unknown[] => [
      { skillOverrides: { 'team-plan': 'on' } },
      ...(conversation ? [{ skillOverrides: { 'team-plan': 'off' } }] : []),
    ]
    offEverywhere(await turn({ carried, send: { resume: { sessionId: 'sess-known', mode: 'append' } } }))
  })

  it("off in the project's local file: an attended turn reads it, a wake carries it", async () => {
    local({ skillOverrides: { 'team-plan': 'off' } })
    offEverywhere(await turn())
    offEverywhere(
      await turn({
        send: { unattended: true, turn: { class: 'wake', taskKey: 'k' }, isolation: { settingSources: ['user', 'project'], disableAllHooks: true } },
      }),
    )
  })

  it('off for the machine (the user file reaches the folder copy)', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ skillOverrides: { 'team-plan': 'user-invocable-only' } }))
    offEverywhere(await turn())
  })

  it("a run without the project's settings loads no folder copy: none is named", async () => {
    offEverywhere(
      await turn({ send: { unattended: true, turn: { class: 'run', automationId: 'a1' }, isolation: { settingSources: ['user'], disableAllHooks: true } } }),
      false,
    )
  })

  it("an «on» at a narrower place restores it: the agent's over the local file's «off»", async () => {
    local({ skillOverrides: { 'team-plan': 'off', 'ledger-notes': 'name-only' } })
    const append = await turn({ carried: () => [{ skillOverrides: { 'team-plan': 'on' } }] })
    expect(noteOf(append)).toBe(`${NOTE} /team-plan, /ledger-notes — load them when the task calls for them.`)
    expect(append).toContain(briefingText(['team-plan']))
  })
})
