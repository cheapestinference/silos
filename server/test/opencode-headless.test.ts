// opencode-headless.test.ts — `opencode run --format json` as Silos' chat
// engine for an OpenCode agent. The binary is a stub shell script at a temp
// path (opts.binary): a REAL child process, emitting recorded JSON lines,
// recording its argv / stdin / env to files — so the assertions are on what
// a real spawn gets, never on a fake.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRegistry, mungePath } from '../src/agent-registry.js'
import { AgentStateStore } from '../src/agent-state.js'
import { NativeStore } from '../src/native-store.js'
import { ConversationPrefsStore } from '../src/conversation-prefs.js'
import { ChatService } from '../src/chat-service.js'
import { ProvidersStore } from '../src/providers-store.js'
import { OpenCodeHeadless, HIGH_WATER, LOW_WATER, opencodeEngine } from '../src/harnesses/opencode/headless.js'
import type { ChatEvent } from '../src/chat-types.js'
import type { QueryFn } from '../src/harnesses/claude-code/sdk-types.js'

const RECORDED = [
  '{"type":"step_start","sessionID":"ses_h1","part":{}}',
  'warning: something',
  '{"type":"text","sessionID":"ses_h1","part":{"text":"Hello"}}',
  '{"type":"tool_use","sessionID":"ses_h1","part":{"tool":"read","state":{"status":"completed","input":{"filePath":"a"}}}}',
  '{"type":"step_finish","sessionID":"ses_h1","part":{"tokens":{"input":10,"output":5,"reasoning":1,"cache":{"read":100,"write":0}},"cost":0.002}}',
]

let base: string, cwd: string, registry: AgentRegistry, agentState: AgentStateStore, native: NativeStore, convPrefs: ConversationPrefsStore
// the reader's agentOfDb, faked: which agent's own DB holds each id
let dbOwners: Map<string, string>

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'oc-headless-'))
  cwd = join(base, 'proj')
  mkdirSync(cwd)
  registry = new AgentRegistry(join(base, 'agents.json'))
  registry.load()
  registry.create({ id: 'oc', name: 'Oc', folder: cwd, framework: 'opencode' })
  registry.create({ id: 'cl', name: 'Cl', folder: cwd })
  agentState = new AgentStateStore(join(base, 'agent-state'))
  native = new NativeStore(join(base, 'native.json'))
  convPrefs = new ConversationPrefsStore(base)
  dbOwners = new Map([['ses_h1', 'oc']])
})

/** A stub `opencode`: records argv, stdin and env, then runs `body`. */
function stub(body: string): { bin: string; rec: string } {
  const rec = join(base, 'rec')
  mkdirSync(rec, { recursive: true })
  const bin = join(base, 'opencode-stub.sh')
  writeFileSync(bin, ['#!/bin/sh', `printf '%s\\n' "$@" > '${rec}/argv'`, `cat > '${rec}/stdin'`, `env > '${rec}/env'`, body].join('\n'))
  chmodSync(bin, 0o755)
  return { bin, rec }
}

const printLines = (lines: string[]): string => lines.map((l) => `printf '%s\\n' '${l}'`).join('\n')

function headless(bin: string, extra: Partial<ConstructorParameters<typeof OpenCodeHeadless>[0]> = {}): OpenCodeHeadless {
  return new OpenCodeHeadless({
    binary: bin,
    registry,
    agentState,
    native,
    dataDir: base,
    home: base,
    silosApi: 'http://127.0.0.1:3210',
    convPrefs,
    agentOfDb: (id) => dbOwners.get(id) ?? null,
    ...extra,
  })
}

async function collect(gen: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

describe('OpenCodeHeadless — events', () => {
  it('maps the recorded stream to ChatEvents in order; non-JSON lines are ignored', async () => {
    const { bin } = stub(printLines(RECORDED))
    const evs = await collect(headless(bin).send({ turnId: 't1', agentId: 'oc', text: 'hi' }))
    expect(evs).toEqual([
      { ev: 'chat-init', turnId: 't1', folder: mungePath(cwd), sessionId: 'ses_h1' },
      { ev: 'chat-delta', turnId: 't1', text: 'Hello' },
      { ev: 'chat-tool', turnId: 't1', name: 'read', input: '{"filePath":"a"}' },
      { ev: 'chat-usage', turnId: 't1', outputTokens: 6, contextTokens: 110 },
      { ev: 'chat-done', turnId: 't1', subtype: 'success', costUsd: 0.002 },
    ])
  })

  it('a new session is registered native to the agent at chat-init (never read as a nested run)', async () => {
    const { bin } = stub(printLines(RECORDED))
    await collect(headless(bin).send({ turnId: 't1', agentId: 'oc', text: 'hi' }))
    expect(native.get(mungePath(cwd), 'ses_h1')?.agentId).toBe('oc')
  })

  it('reasoning → chat-thinking; cost 0 → costUsd null', async () => {
    const { bin } = stub(
      printLines([
        '{"type":"reasoning","sessionID":"ses_h2","part":{"text":"hmm"}}',
        '{"type":"step_finish","sessionID":"ses_h2","part":{"tokens":{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}},"cost":0}}',
      ]),
    )
    const evs = await collect(headless(bin).send({ turnId: 't2', agentId: 'oc', text: 'hi' }))
    expect(evs.map((e) => e.ev)).toEqual(['chat-init', 'chat-thinking', 'chat-usage', 'chat-done'])
    expect(evs[1]).toEqual({ ev: 'chat-thinking', turnId: 't2', text: 'hmm' })
    expect(evs[3]).toEqual({ ev: 'chat-done', turnId: 't2', subtype: 'success', costUsd: null })
  })

  it('non-zero exit without an error event → chat-error with the last stderr line', async () => {
    const { bin } = stub("echo 'first' >&2\necho 'boom' >&2\nexit 2")
    const evs = await collect(headless(bin).send({ turnId: 't3', agentId: 'oc', text: 'hi' }))
    expect(evs).toEqual([{ ev: 'chat-error', turnId: 't3', error: 'boom' }])
  })

  it('an error event → chat-error with its message (the 1.14.22 shape: top-level `error`, data.message), no chat-done after', async () => {
    const { bin } = stub(
      printLines([
        '{"type":"step_start","sessionID":"ses_e","part":{}}',
        '{"type":"error","sessionID":"ses_e","error":{"name":"APIError","data":{"message":"model not found"}}}',
      ]),
    )
    const evs = await collect(headless(bin).send({ turnId: 't4', agentId: 'oc', text: 'hi' }))
    expect(evs).toEqual([
      { ev: 'chat-init', turnId: 't4', folder: mungePath(cwd), sessionId: 'ses_e' },
      { ev: 'chat-error', turnId: 't4', error: 'model not found' },
    ])
  })

  it('the brief shape `part.error.message` is read too', async () => {
    const { bin } = stub(printLines(['{"type":"error","sessionID":"ses_e2","part":{"error":{"message":"nope"}}}']))
    const evs = await collect(headless(bin).send({ turnId: 't5', agentId: 'oc', text: 'hi' }))
    expect(evs.at(-1)).toEqual({ ev: 'chat-error', turnId: 't5', error: 'nope' })
  })

  it('a rate-limit text (error event or stderr) emits chat-ratelimit rejected before the chat-error', async () => {
    const a = stub(printLines(['{"type":"error","sessionID":"ses_r1","error":{"name":"APIError","data":{"message":"429 Too Many Requests"}}}']))
    const evA = await collect(headless(a.bin).send({ turnId: 'ra', agentId: 'oc', text: 'hi' }))
    expect(evA.slice(1)).toEqual([
      { ev: 'chat-ratelimit', turnId: 'ra', status: 'rejected' },
      { ev: 'chat-error', turnId: 'ra', error: '429 Too Many Requests' },
    ])
    const b = stub("echo 'You exceeded your current quota' >&2\nexit 1")
    const evB = await collect(headless(b.bin).send({ turnId: 'rb', agentId: 'oc', text: 'hi' }))
    expect(evB).toEqual([
      { ev: 'chat-ratelimit', turnId: 'rb', status: 'rejected' },
      { ev: 'chat-error', turnId: 'rb', error: 'You exceeded your current quota' },
    ])
  })

  it('a missing agent folder → an honest chat-error', async () => {
    registry.create({ id: 'gone', name: 'Gone', folder: join(base, 'nope'), framework: 'opencode' })
    const { bin } = stub(printLines(RECORDED))
    const evs = await collect(headless(bin).send({ turnId: 't6', agentId: 'gone', text: 'hi' }))
    expect(evs).toEqual([{ ev: 'chat-error', turnId: 't6', error: expect.stringMatching(/agent folder does not exist/) }])
  })
})

describe('OpenCodeHeadless — argv, stdin, env', () => {
  const argvOf = (rec: string): string[] => readFileSync(join(rec, 'argv'), 'utf8').split('\n').slice(0, -1)
  const envOf = (rec: string): Record<string, string> =>
    Object.fromEntries(
      readFileSync(join(rec, 'env'), 'utf8')
        .split('\n')
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    )

  it('a new turn: run --format json --dir <cwd>, bypass → --auto (an unanswered probe still passes it), never --print-logs; the prompt on stdin, not argv', async () => {
    const { bin, rec } = stub(printLines(RECORDED))
    const prompt = 'a long prompt\nwith lines'
    await collect(headless(bin).send({ turnId: 't1', agentId: 'oc', text: prompt }))
    const argv = argvOf(rec)
    expect(argv.slice(0, 5)).toEqual(['run', '--format', 'json', '--dir', cwd])
    expect(argv).toContain('--auto')
    expect(argv).toContain('--thinking')
    expect(argv).not.toContain('--print-logs')
    expect(argv).not.toContain('--session')
    expect(argv.join(' ')).not.toContain('a long prompt')
    expect(readFileSync(join(rec, 'stdin'), 'utf8')).toBe(prompt)
  })

  it('a resume: --session <id> and SILOS_SESSION_ID; a fork adds --fork', async () => {
    const { bin, rec } = stub(printLines(['{"type":"text","sessionID":"ses_r","part":{"text":"x"}}']))
    const h = headless(bin)
    await collect(h.send({ turnId: 't1', agentId: 'oc', text: 'hi', resume: { sessionId: 'ses_r', mode: 'append' } }))
    let argv = argvOf(rec)
    expect(argv[argv.indexOf('--session') + 1]).toBe('ses_r')
    expect(argv).not.toContain('--fork')
    expect(envOf(rec).SILOS_SESSION_ID).toBe('ses_r')
    // an append never re-registers the session as born here
    expect(native.get(mungePath(cwd), 'ses_r')).toBeNull()
    await collect(h.send({ turnId: 't2', agentId: 'oc', text: 'hi', resume: { sessionId: 'ses_r', mode: 'fork' } }))
    argv = argvOf(rec)
    expect(argv).toContain('--fork')
  })

  it('bypass: --auto (the minimum OpenCode lists it on `run`; an older one never gets here — the compatibility gate refuses it)', async () => {
    const { bin, rec } = stub(printLines(RECORDED))
    await collect(headless(bin).send({ turnId: 't1', agentId: 'oc', text: 'hi' }))
    expect(argvOf(rec)).toContain('--auto')
  })

  it('a non-bypass permission mode: no --auto, one warn line for the run', async () => {
    const { bin, rec } = stub(printLines(RECORDED))
    convPrefs.patch(mungePath(cwd), 'ses_p', { permissionMode: 'acceptEdits' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await collect(headless(bin).send({ turnId: 't1', agentId: 'oc', text: 'hi', resume: { sessionId: 'ses_p', mode: 'append' } }))
      expect(argvOf(rec)).not.toContain('--auto')
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toBe('opencode run: permission mode acceptEdits — asks are auto-rejected by opencode in headless mode')
    } finally {
      warn.mockRestore()
    }
  })

  it('plan → --agent plan (the plan agent: no edits), never --auto; the warn line stays', async () => {
    const { bin, rec } = stub(printLines(RECORDED))
    convPrefs.patch(mungePath(cwd), 'ses_p', { permissionMode: 'plan' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await collect(headless(bin).send({ turnId: 't1', agentId: 'oc', text: 'hi', resume: { sessionId: 'ses_p', mode: 'append' } }))
      const argv = argvOf(rec)
      expect(argv[argv.indexOf('--agent') + 1]).toBe('plan')
      expect(argv).not.toContain('--auto')
      expect(String(warn.mock.calls[0]?.[0])).toBe('opencode run: permission mode plan — asks are auto-rejected by opencode in headless mode')
    } finally {
      warn.mockRestore()
    }
  })

  it('acceptEdits: neither --auto nor --agent, and no edit base in the config', async () => {
    const { bin, rec } = stub(printLines(RECORDED))
    convPrefs.patch(mungePath(cwd), 'ses_p', { permissionMode: 'acceptEdits' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await collect(headless(bin).send({ turnId: 't1', agentId: 'oc', text: 'hi', resume: { sessionId: 'ses_p', mode: 'append' } }))
      const argv = argvOf(rec)
      expect(argv).not.toContain('--auto')
      expect(argv).not.toContain('--agent')
      expect(envOf(rec).OPENCODE_CONFIG_CONTENT).not.toContain('"edit"')
    } finally {
      warn.mockRestore()
    }
  })

  it('an unattended run ignores the conversation prefs (bypass stays)', async () => {
    const { bin, rec } = stub(printLines(RECORDED))
    convPrefs.patch(mungePath(cwd), 'ses_p', { permissionMode: 'acceptEdits' })
    await collect(headless(bin).send({ turnId: 't1', agentId: 'oc', text: 'hi', resume: { sessionId: 'ses_p', mode: 'append' }, unattended: true }))
    expect(argvOf(rec)).toContain('--auto')
  })

  it('--model only for a provider/model id', async () => {
    registry.create({ id: 'm1', name: 'M1', folder: cwd, framework: 'opencode', model: 'anthropic/claude-sonnet-4-5' })
    registry.create({ id: 'm2', name: 'M2', folder: cwd, framework: 'opencode', model: 'opus' })
    const { bin, rec } = stub(printLines(RECORDED))
    await collect(headless(bin).send({ turnId: 't1', agentId: 'm1', text: 'hi' }))
    let argv = argvOf(rec)
    expect(argv[argv.indexOf('--model') + 1]).toBe('anthropic/claude-sonnet-4-5')
    await collect(headless(bin).send({ turnId: 't2', agentId: 'm2', text: 'hi' }))
    argv = argvOf(rec)
    expect(argv).not.toContain('--model')
  })

  it('env: the shared assembly (own DB, config with the Silos plugin, agent identity); no SILOS_SESSION_ID on a new turn; secrets only in env', async () => {
    const vault = { envFor: () => ({ VAULT_SECRET: 's3cr3t-value' }) }
    const { bin, rec } = stub(printLines(RECORDED))
    await collect(headless(bin, { vault: vault as never }).send({ turnId: 't1', agentId: 'oc', text: 'hi' }))
    const env = envOf(rec)
    expect(env.OPENCODE_DB).toBe(join(base, 'agents', 'oc', 'opencode.db'))
    expect(existsSync(join(base, 'agents', 'oc'))).toBe(true)
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT).plugin[0]).toMatch(/plugin-opencode\/silos\.ts$/)
    expect(env.SILOS_AGENT_ID).toBe('oc')
    expect(env.SILOS_API).toBe('http://127.0.0.1:3210')
    // where the plugin polls for the owner's answers: Silos-owned, fenced
    expect(env.SILOS_ASKS_REPLIES).toBe(join(base, 'asks-replies', 'oc'))
    expect(env.VAULT_SECRET).toBe('s3cr3t-value')
    expect(env.SILOS_SESSION_ID).toBeUndefined()
    expect(env.OPENCODE_SERVER_PASSWORD).toBeUndefined()
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBeUndefined()
    expect(argvOf(rec).join(' ')).not.toContain('s3cr3t')
  })

  it('a fenced agent: fence as permission, OPENCODE_DISABLE_PROJECT_CONFIG=1', async () => {
    const fence = { permissions: { deny: ['Read(/home/x/secrets/**)'], additionalDirectories: [] } }
    const { bin, rec } = stub(printLines(RECORDED))
    await collect(
      headless(bin, { territory: { fenceFor: (id: string) => (id === 'oc' ? (fence as never) : null) } }).send({ turnId: 't1', agentId: 'oc', text: 'hi' }),
    )
    const env = envOf(rec)
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1')
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT).permission).toBeTruthy()
  })

  it("a fenced agent still gets every place Silos keeps (spec scopes §9): the folder's, the agent's, the thread's entries over them — the fence's rules as they were", async () => {
    const fence = { permissions: { deny: ['Read(/home/x/secrets/**)', 'Bash(rm -rf *)'], additionalDirectories: [] } }
    const territory = { fenceFor: (id: string) => (id === 'oc' ? (fence as never) : null) }
    const folderP = { mcp: { docs: { enabled: false }, search: { enabled: false } } }
    const agentP = { mcp: { docs: { enabled: true } }, permission: { skill: { drafts: 'deny' } } }
    const threadP = { mcp: { search: { enabled: true }, docs: { enabled: false } } }
    const seen: (string | undefined)[] = []
    const { bin, rec } = stub(printLines(RECORDED))
    await collect(headless(bin, { territory }).send({ turnId: 't0', agentId: 'oc', text: 'hi' }))
    const bare = JSON.parse(envOf(rec).OPENCODE_CONFIG_CONTENT) as { permission: Record<string, unknown>; mcp?: unknown }
    await collect(
      headless(bin, {
        territory,
        loadsCarried: (id, at) => {
          seen.push(at)
          return id === 'oc' ? [folderP, agentP, threadP] : []
        },
      }).send({ turnId: 't1', agentId: 'oc', text: 'hi' }),
    )
    const env = envOf(rec)
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1')
    const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT) as { permission: Record<string, unknown>; mcp: Record<string, unknown> }
    // later wins: the thread's over the agent's over the folder's
    expect(cfg.mcp).toEqual({ docs: { enabled: false }, search: { enabled: true } })
    // the fence's keys, in order and as they were; the skill's deny added
    const { skill, ...fenceKeys } = cfg.permission
    expect(fenceKeys).toEqual(bare.permission)
    expect(Object.keys(cfg.permission).slice(0, Object.keys(bare.permission).length)).toEqual(Object.keys(bare.permission))
    expect(skill).toEqual({ drafts: 'deny' })
    // asked for the turn's own folder
    expect(seen).toEqual([cwd])
  })

  // The provider through the real cascade (ChatService.providerForTurn over a real
  // ProvidersStore): the agent's own › the conversation's pin › the turn's
  it('provider: the cascade picks it, the config names it, the key rides only the env', async () => {
    const providers = new ProvidersStore(base)
    providers.load()
    const mm = providers.create({
      kind: 'harness-provider',
      label: 'MiniMax',
      harness: 'opencode',
      providerId: 'minimax-coding-plan',
      apiKey: 'mm-secret-key-123456',
    })
    const ci = providers.create({ label: 'ci', baseUrl: 'https://api.ci.test/anthropic', apiKey: 'sk-ci-secret-123456' })
    const zai = providers.create({ kind: 'harness-native', label: 'Z.ai', harness: 'opencode', providerId: 'zai' })
    registry.create({ id: 'pv', name: 'Pv', folder: cwd, framework: 'opencode', model: 'MiniMax-M2', provider: mm.id })
    dbOwners.set('ses_h1', 'pv')
    const chat = new ChatService({
      registry,
      native,
      queryFn: (() => {
        throw new Error('no claude')
      }) as unknown as QueryFn,
      providers,
      convPrefs,
    })
    const { bin, rec } = stub(printLines(RECORDED))
    const h = headless(bin, { providerFor: (a, pin) => chat.providerForTurn(a, pin).provider })

    // the agent's own: harness-provider
    await collect(h.send({ turnId: 't1', agentId: 'pv', text: 'hi' }))
    let env = envOf(rec)
    let cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT) as { provider?: unknown; model?: string }
    expect(cfg.provider).toEqual({ 'minimax-coding-plan': { options: { apiKey: '{env:SILOS_PROVIDER_KEY}' } } })
    expect(cfg.model).toBe('minimax-coding-plan/MiniMax-M2')
    expect(env.SILOS_PROVIDER_KEY).toBe('mm-secret-key-123456')
    expect(env.OPENCODE_CONFIG_CONTENT).not.toContain('mm-secret')
    expect(argvOf(rec).join(' ')).not.toContain('mm-secret')
    expect(argvOf(rec)[argvOf(rec).indexOf('--model') + 1]).toBe('minimax-coding-plan/MiniMax-M2')

    // the conversation's pin: anthropic-compatible
    convPrefs.patch(mungePath(cwd), 'ses_h1', { provider: ci.id })
    await collect(h.send({ turnId: 't2', agentId: 'pv', text: 'hi', resume: { sessionId: 'ses_h1', mode: 'append' } }))
    env = envOf(rec)
    cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT)
    expect(cfg.provider).toEqual({
      [`silos-${ci.id}`]: {
        npm: '@ai-sdk/anthropic',
        name: 'ci',
        options: { baseURL: 'https://api.ci.test/anthropic/v1', apiKey: '{env:SILOS_PROVIDER_KEY}' },
      },
    })
    expect(cfg.model).toBe(`silos-${ci.id}/MiniMax-M2`)
    expect(env.SILOS_PROVIDER_KEY).toBe('sk-ci-secret-123456')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()

    // the turn's override: harness-native — nothing injected, no key
    await collect(h.send({ turnId: 't3', agentId: 'pv', text: 'hi', resume: { sessionId: 'ses_h1', mode: 'append' }, overrides: { provider: zai.id } }))
    env = envOf(rec)
    cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT)
    expect(cfg.provider).toBeUndefined()
    expect(cfg.model).toBe('zai/MiniMax-M2')
    expect(env.SILOS_PROVIDER_KEY).toBeUndefined()
  })
})

describe('OpenCodeHeadless — cancel, liveness', () => {
  it('cancel() → SIGTERM → chat-done cancelled, quickly', async () => {
    // the child sleeps past the test timeout: the turn ending at all is the kill
    const { bin } = stub(printLines(['{"type":"step_start","sessionID":"ses_c","part":{}}']) + '\nsleep 30')
    const h = headless(bin)
    const evs: ChatEvent[] = []
    for await (const ev of h.send({ turnId: 'tc', agentId: 'oc', text: 'hi' })) {
      evs.push(ev)
      if (ev.ev === 'chat-init') {
        expect(h.isInflight('tc')).toBe(true)
        expect(h.isSessionActive('ses_c')).toBe(true)
        expect(await h.cancel('tc')).toBe(true)
      }
    }
    expect(evs.at(-1)).toEqual({ ev: 'chat-done', turnId: 'tc', subtype: 'cancelled', costUsd: null })
    expect(h.isInflight('tc')).toBe(false)
    expect(h.isSessionActive('ses_c')).toBe(false)
    expect(await h.cancel('tc')).toBe(false)
  })

  // the grace is injected (production: 5 s); the signals are counted, not timed
  it('a child ignoring SIGTERM is SIGKILLed after the grace → chat-done cancelled', async () => {
    const { bin } = stub("trap '' TERM\n" + printLines(['{"type":"step_start","sessionID":"ses_k","part":{}}']) + '\nsleep 30')
    const h = headless(bin, { killGraceMs: 200 })
    const sent: unknown[] = []
    const kill = vi.spyOn(process, 'kill')
    const evs: ChatEvent[] = []
    try {
      for await (const ev of h.send({ turnId: 'tk', agentId: 'oc', text: 'hi' })) {
        evs.push(ev)
        if (ev.ev === 'chat-init') await h.cancel('tk')
      }
      for (const [, sig] of kill.mock.calls) if (sig !== 0 && sig !== undefined) sent.push(sig)
    } finally {
      kill.mockRestore()
    }
    expect(evs.at(-1)).toEqual({ ev: 'chat-done', turnId: 'tk', subtype: 'cancelled', costUsd: null })
    // TERM first, ignored; the turn only ended once KILL followed
    expect(sent).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('two turns on the same session at once are refused', async () => {
    const { bin } = stub(printLines(['{"type":"step_start","sessionID":"ses_l","part":{}}']) + '\nsleep 30')
    const h = headless(bin)
    const first = h.send({ turnId: 'a', agentId: 'oc', text: 'hi', resume: { sessionId: 'ses_l', mode: 'append' } })
    await first.next()
    await expect(collect(h.send({ turnId: 'b', agentId: 'oc', text: 'hi', resume: { sessionId: 'ses_l', mode: 'append' } }))).rejects.toThrow(
      /already in progress/,
    )
    await h.cancel('a')
    await collect(first)
  })
})

describe('ChatService dispatch by harness', () => {
  const neverQuery: QueryFn = () => {
    throw new Error('the Claude SDK must not be called for an OpenCode agent')
  }

  it('an OpenCode agent goes to the headless engine; its events are emitted as chat-event too', async () => {
    const { bin } = stub(printLines(RECORDED))
    const chat = new ChatService({ registry, native, queryFn: neverQuery, headless: { opencode: (ctx) => opencodeEngine(headless(bin), ctx.hooks) } })
    const emitted: unknown[] = []
    chat.on('chat-event', (e) => emitted.push(e))
    const evs = await collect(chat.send({ turnId: 't1', agentId: 'oc', text: 'hi' }))
    expect(evs.map((e) => e.ev)).toEqual(['chat-init', 'chat-delta', 'chat-tool', 'chat-usage', 'chat-done'])
    expect(emitted).toHaveLength(5)
    expect(emitted[0]).toEqual({ agentId: 'oc', event: evs[0] })
  })

  it('cancel / isInflight / isSessionActive consult the headless engine', async () => {
    const { bin } = stub(printLines(['{"type":"step_start","sessionID":"ses_cs","part":{}}']) + '\nsleep 8')
    const chat = new ChatService({ registry, native, queryFn: neverQuery, headless: { opencode: (ctx) => opencodeEngine(headless(bin), ctx.hooks) } })
    const evs: ChatEvent[] = []
    for await (const ev of chat.send({ turnId: 'tc', agentId: 'oc', text: 'hi' })) {
      evs.push(ev)
      if (ev.ev === 'chat-init') {
        expect(chat.isInflight('tc')).toBe(true)
        expect(chat.isSessionActive('ses_cs')).toBe(true)
        expect(await chat.cancel('tc')).toBe(true)
      }
    }
    expect(evs.at(-1)).toMatchObject({ ev: 'chat-done', subtype: 'cancelled' })
  })

  it('an OpenCode agent without a headless engine is refused, never sent to the Claude SDK', async () => {
    const chat = new ChatService({ registry, native, queryFn: neverQuery })
    await expect(collect(chat.send({ turnId: 't1', agentId: 'oc', text: 'hi' }))).rejects.toThrow(/OpenCode/)
  })

  it('a Claude agent still goes to the SDK even with a headless engine wired', async () => {
    const { bin, rec } = stub(printLines(RECORDED))
    let called = 0
    const queryFn: QueryFn = () => {
      called++
      return Object.assign(
        (async function* () {
          yield { type: 'result', subtype: 'success', total_cost_usd: 0 }
        })(),
        { interrupt: async () => {} },
      )
    }
    const chat = new ChatService({ registry, native, queryFn, headless: { opencode: (ctx) => opencodeEngine(headless(bin), ctx.hooks) } })
    await collect(chat.send({ turnId: 't1', agentId: 'cl', text: 'hi' }))
    expect(called).toBe(1)
    expect(existsSync(join(rec, 'argv'))).toBe(false)
  })
})

describe('OpenCodeHeadless — the announced session id is not trusted (fix round 1)', () => {
  it('a Claude uuid announced on stdout → chat-error, no chat-init, no native record, child killed', async () => {
    const forged = '0b6f7a52-1111-4222-8333-944445555666'
    // the child sleeps past the test timeout: the turn ending at all is the kill
    const { bin } = stub(printLines([`{"type":"text","sessionID":"${forged}","part":{"text":"x"}}`]) + '\nsleep 30')
    const evs = await collect(headless(bin).send({ turnId: 'f1', agentId: 'oc', text: 'hi' }))
    expect(evs).toEqual([{ ev: 'chat-error', turnId: 'f1', error: expect.stringMatching(/^unexpected session id/) }])
    expect(native.get(mungePath(cwd), forged)).toBeNull()
  })

  it("another agent's ses_ id → chat-init emitted but never registered", async () => {
    dbOwners.set('ses_theirs', 'cl')
    const { bin } = stub(printLines(['{"type":"text","sessionID":"ses_theirs","part":{"text":"x"}}']))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const h = headless(bin)
      const evs = await collect(h.send({ turnId: 'f2', agentId: 'oc', text: 'hi' }))
      expect(evs[0]).toEqual({ ev: 'chat-init', turnId: 'f2', folder: mungePath(cwd), sessionId: 'ses_theirs' })
      expect(native.get(mungePath(cwd), 'ses_theirs')).toBeNull()
      expect(h.sealPending()).toBe(0)
      expect(native.get(mungePath(cwd), 'ses_theirs')).toBeNull()
    } finally {
      warn.mockRestore()
    }
  })

  it('a contested id is never registered', async () => {
    dbOwners.set('ses_two', 'oc')
    const { bin } = stub(printLines(['{"type":"text","sessionID":"ses_two","part":{"text":"x"}}']))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await collect(headless(bin, { isContested: (id) => id === 'ses_two' }).send({ turnId: 'f3', agentId: 'oc', text: 'hi' }))
      expect(native.get(mungePath(cwd), 'ses_two')).toBeNull()
    } finally {
      warn.mockRestore()
    }
  })

  it('an own ses_ not in the DB yet waits; sealPending registers it once the DB has it', async () => {
    const { bin } = stub(printLines(['{"type":"text","sessionID":"ses_late","part":{"text":"x"}}']))
    const h = headless(bin)
    const evs = await collect(h.send({ turnId: 'f4', agentId: 'oc', text: 'hi' }))
    expect(evs[0]).toMatchObject({ ev: 'chat-init', sessionId: 'ses_late' })
    expect(native.get(mungePath(cwd), 'ses_late')).toBeNull()
    dbOwners.set('ses_late', 'oc')
    expect(h.sealPending()).toBe(1)
    expect(native.get(mungePath(cwd), 'ses_late')?.agentId).toBe('oc')
    expect(h.sealPending()).toBe(0)
  })

  it('an append resume announcing a different id → chat-error and the child killed', async () => {
    dbOwners.set('ses_other', 'oc')
    const { bin } = stub(printLines(['{"type":"text","sessionID":"ses_other","part":{"text":"x"}}']) + '\nsleep 30') // past the test timeout: ending is the kill
    const h = headless(bin)
    const evs = await collect(h.send({ turnId: 'f5', agentId: 'oc', text: 'hi', resume: { sessionId: 'ses_mine', mode: 'append' } }))
    expect(evs).toEqual([{ ev: 'chat-error', turnId: 'f5', error: expect.stringMatching(/^unexpected session id/) }])
    expect(h.isSessionActive('ses_other')).toBe(false)
    expect(h.isSessionActive('ses_mine')).toBe(false)
  })

  it('after an error nothing more is emitted (no second chat-error, no chat-done)', async () => {
    const { bin } = stub(
      printLines([
        '{"type":"error","sessionID":"ses_h1","error":{"data":{"message":"first"}}}',
        '{"type":"error","sessionID":"ses_h1","error":{"data":{"message":"second"}}}',
        '{"type":"text","sessionID":"ses_h1","part":{"text":"late"}}',
      ]) + '\necho boom >&2\nexit 3',
    )
    const evs = await collect(headless(bin).send({ turnId: 'f6', agentId: 'oc', text: 'hi' }))
    expect(evs.map((e) => e.ev)).toEqual(['chat-init', 'chat-error'])
    expect(evs[1]).toMatchObject({ error: 'first' })
  })
})

describe('OpenCodeHeadless — bounded buffering (fix round 1)', () => {
  it('a 9 MB stdout line → chat-error "output line too long" and the child (group) killed', async () => {
    const pidFile = join(base, 'sleeper.pid')
    // the grandchild sleeps past the test timeout: ending at all is the group kill
    const { bin } = stub(`sleep 30 &\necho $! > '${pidFile}'\nhead -c 9437184 /dev/zero | tr '\\0' 'a'\nwait`)
    const evs = await collect(headless(bin).send({ turnId: 'b1', agentId: 'oc', text: 'hi' }))
    expect(evs).toEqual([{ ev: 'chat-error', turnId: 'b1', error: 'output line too long' }])
    // the grandchild died with the group
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('5000 lines to a slow consumer: all delivered, the queue never above the high-water mark', async () => {
    const { bin } = stub(
      `awk 'BEGIN { for (i = 0; i < 5000; i++) printf "{\\"type\\":\\"text\\",\\"sessionID\\":\\"ses_h1\\",\\"part\\":{\\"text\\":\\"%d\\"}}\\n", i }'`,
    )
    let maxDepth = 0
    const h = headless(bin, {
      onQueueDepth: (d) => {
        maxDepth = Math.max(maxDepth, d)
      },
    })
    const texts: string[] = []
    let n = 0
    for await (const ev of h.send({ turnId: 'b2', agentId: 'oc', text: 'hi' })) {
      if (ev.ev === 'chat-delta') texts.push(ev.text)
      if (++n % 500 === 0) await new Promise((r) => setTimeout(r, 20))
    }
    expect(texts).toHaveLength(5000)
    expect(texts[4999]).toBe('4999')
    expect(maxDepth).toBeLessThanOrEqual(HIGH_WATER)
    expect(maxDepth).toBeGreaterThan(LOW_WATER)
  }, 15_000)

  it('only the last stderr line is kept, capped at 4 KB', async () => {
    const { bin } = stub(`head -c 20000 /dev/zero | tr '\\0' 'e' >&2\necho >&2\nhead -c 6000 /dev/zero | tr '\\0' 'z' >&2\necho >&2\nexit 1`)
    const evs = await collect(headless(bin).send({ turnId: 'b3', agentId: 'oc', text: 'hi' }))
    expect(evs).toHaveLength(1)
    const err = (evs[0] as { error: string }).error
    expect(err).toMatch(/^z+$/)
    expect(err.length).toBe(4096)
  })
})

describe('OpenCodeHeadless — env (fix round 1)', () => {
  it('inherited OPENCODE_* never reach the child; only the assembled config does', async () => {
    const { bin, rec } = stub(printLines(RECORDED))
    process.env.OPENCODE_CONFIG = '/operator/opencode.json'
    process.env.OPENCODE_PERMISSION = '{"bash":"allow"}'
    try {
      await collect(headless(bin).send({ turnId: 'e1', agentId: 'oc', text: 'hi' }))
    } finally {
      delete process.env.OPENCODE_CONFIG
      delete process.env.OPENCODE_PERMISSION
    }
    const env = readFileSync(join(rec, 'env'), 'utf8')
    expect(env).not.toContain('OPENCODE_CONFIG=')
    expect(env).not.toContain('OPENCODE_PERMISSION=')
    expect(env).toContain('OPENCODE_CONFIG_CONTENT=')
    // Silos' own skills ride the assembled config (heartbeat, team-plan…)
    expect(env).toMatch(/OPENCODE_CONFIG_CONTENT=.*"skills":\{"paths":\["[^"]*\/plugin\/skills"\]\}/)
  })

  it('the session lock is held until the child is dead, even when the consumer stops early', async () => {
    dbOwners.set('ses_lk', 'oc')
    const { bin } = stub("trap '' TERM\n" + printLines(['{"type":"text","sessionID":"ses_lk","part":{"text":"x"}}']) + '\nsleep 30')
    const h = headless(bin, { killGraceMs: 300 })
    const gen = h.send({ turnId: 'lk', agentId: 'oc', text: 'hi', resume: { sessionId: 'ses_lk', mode: 'append' } })
    await gen.next()
    await gen.return(undefined)
    // SIGTERM ignored: the child lives on, and so does the lock
    expect(h.isSessionActive('ses_lk')).toBe(true)
    // released only once the SIGKILL after the grace has ended the child
    // (it sleeps past the test timeout: nothing else would end it)
    while (h.isSessionActive('ses_lk')) await new Promise((r) => setTimeout(r, 25))
  })
})
