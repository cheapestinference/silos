// Command automations:
// a real exec of server/test/fixtures/command-run.sh — exit 0 / ≠0 /
// timeout / >1 MB / a Vault secret printed and redacted / $SILOS_AGENT_STATE
// expanded / okCodes / the hand-over to the agent (the turn faked like the
// other resident tests) and that hand-over refused at a limit / budget and
// approval like an agent run / the inbox row of class `command`.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AgentRegistry } from '../src/agent-registry.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import type { SessionIndex } from '../src/session-index.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { AutomationsStore, countsAgainstBudget } from '../src/automations-store.js'
import { Resident, RUN_OUTCOME_INSTRUCTION } from '../src/resident.js'
import { AgentStateStore } from '../src/agent-state.js'
import { runCommand, expandAgentState, redactor, LOG_CAP_BYTES, REDACTED, lastNonEmptyLine, tailLines } from '../src/command-run.js'
import { validateRun, validateAutomationCreate, validateAutomationPatch } from '../src/automations-validate.js'
import { failedRunRow, runFailure } from '../src/inbox.js'
import type { QueryArgs, SdkMessage, SdkQueryHandle } from '../src/harnesses/claude-code/sdk-types.js'
import type { Automation, CommandRun } from '../src/automations-types.js'
import { defaultConfig } from '../src/config.js'
import { silosApiUrl } from '../src/agent-env.js'

const FIXTURE = resolve(__dirname, 'fixtures/command-run.sh')
const SECRET = 'sk-fixture-9f8e7d6c5b4a'
const TOKEN = 'agent-bearer-0123456789'

let base: string, root: string, dataDir: string, agentFolder: string
let registry: AgentRegistry, native: NativeStore, index: SessionIndex, store: AutomationsStore, chat: ChatService
let agentState: AgentStateStore
let calls: QueryArgs[]
let script: SdkMessage[]
let residents: Resident[]

function fakeQuery(): (args: QueryArgs) => SdkQueryHandle {
  return (args) => {
    calls.push(args)
    return {
      async *[Symbol.asyncIterator]() {
        for (const m of script) yield m
      },
      async interrupt() {
        return undefined
      },
    }
  }
}

const successScript: SdkMessage[] = [
  { type: 'system', subtype: 'init', session_id: 'sess-hand' },
  {
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Looked at it: a retry fixed it.\nOUTCOME: acted — reran the sync' } },
  },
  { type: 'result', subtype: 'success', total_cost_usd: 0 },
]

function mkResident(): Resident {
  const r = new Resident({
    store,
    registry,
    chat,
    native,
    index,
    root,
    dataDir,
    broadcast: () => {},
    claudeSessionsDir: join(base, 'no-claude-sessions'),
    tickIntervalMs: 999_999_999,
    agentState,
    vault: { envFor: (agentId) => (agentId === 'finance' ? { FIXTURE_SECRET: SECRET, SHORT: 'eu' } : {}) },
  })
  residents.push(r)
  return r
}

function mkAutomation(id: string, run: CommandRun, overrides: Partial<Automation> = {}): Automation {
  return {
    id,
    name: `Cmd ${id}`,
    agentId: 'finance',
    prompt: 'If the sync fails, find out why.',
    trigger: { kind: 'cron', expr: '0 6 * * *' },
    thread: { mode: 'new' },
    approval: false,
    keepAlive: false,
    paused: false,
    createdAt: new Date().toISOString(),
    run,
    ...overrides,
  }
}

const cmd = (verb: string[], extra: Partial<CommandRun> = {}): CommandRun => ({ kind: 'command', argv: [FIXTURE, ...verb], onFailure: 'inbox', ...extra })

async function runOnce(r: Resident, id: string): Promise<void> {
  expect(await r.runNowManual(id)).toEqual({ ok: true })
  await r.drain()
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'silos-cmd-'))
  root = join(base, 'projects')
  dataDir = join(base, 'data')
  agentFolder = join(base, 'finance')
  mkdirSync(root, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(agentFolder, { recursive: true })
  registry = new AgentRegistry(join(dataDir, 'agents.json'))
  registry.load()
  registry.create({ id: 'finance', name: 'Finance', folder: agentFolder })
  native = new NativeStore(join(dataDir, 'native.json'))
  index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  store = new AutomationsStore(dataDir)
  store.load()
  agentState = new AgentStateStore(join(dataDir, 'agent-state'), { tokenFor: () => TOKEN })
  calls = []
  script = successScript
  chat = new ChatService({ registry, native, queryFn: fakeQuery(), dataDir })
  residents = []
})

afterEach(() => {
  for (const r of residents) r.stop()
})

describe('runCommand — the exec itself', () => {
  const run = (argv: string[], extra: Partial<Parameters<typeof runCommand>[0]> = {}) =>
    runCommand({
      argv: [FIXTURE, ...argv],
      cwd: agentFolder,
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 10_000,
      logFile: join(base, 'logs', 'a', 'r.log'),
      secrets: [],
      ...extra,
    })

  it('exit 0: the code, the last line, the log on disk (0600)', async () => {
    const res = await run(['ok'])
    expect(res.exitCode).toBe(0)
    expect(res.timedOut).toBe(false)
    expect(res.lastLine).toBe('synced 3 invoices')
    const log = join(base, 'logs', 'a', 'r.log')
    expect(readFileSync(log, 'utf8')).toBe('starting\nsynced 3 invoices\n')
    expect(statSync(log).mode & 0o777).toBe(0o600)
    expect(res.logBytes).toBe(Buffer.byteLength('starting\nsynced 3 invoices\n'))
  })

  it('exit ≠ 0: the code, stderr in the same log', async () => {
    const res = await run(['fail', '7'])
    expect(res.exitCode).toBe(7)
    expect(res.output).toContain('boom: ledgerly said 500')
    expect(res.lastLine).toBe('boom: ledgerly said 500')
  })

  it('no shell: an argument with ; and $( ) is one literal argument', async () => {
    const res = await run(['args', 'a; rm -rf /tmp/x', '$(id)', '>> out.log'])
    expect(res.output).toBe('[args]\n[a; rm -rf /tmp/x]\n[$(id)]\n[>> out.log]\n')
  })

  it('a timeout kills it and says so (no exit code)', async () => {
    const res = await run(['sleep'], { timeoutMs: 300, killGraceMs: 200 })
    expect(res.timedOut).toBe(true)
    expect(res.exitCode).toBeUndefined()
    expect(res.output).toContain('going to sleep')
  })

  it('output over 1 MB: the tail is kept, the log never passes the cap, the head says what was dropped', async () => {
    const res = await run(['big'])
    expect(res.exitCode).toBe(0)
    const log = readFileSync(join(base, 'logs', 'a', 'r.log'), 'utf8')
    expect(Buffer.byteLength(log)).toBeLessThanOrEqual(LOG_CAP_BYTES)
    expect(log.startsWith('[… earlier output dropped')).toBe(true)
    expect(log).toContain('line 29999 of')
    expect(log).not.toContain('line 0 of')
    expect(res.lastLine).toBe('the end')
    // whole lines only after the header
    expect(log.split('\n')[1]).toMatch(/^line \d+ of a long/)
  })

  it('a secret printed by the command is redacted before the log is written; a too-short value is not searched', async () => {
    const res = await run(['secret'], {
      env: { PATH: process.env.PATH ?? '', FIXTURE_SECRET: SECRET, SILOS_AGENT_TOKEN: TOKEN },
      secrets: [SECRET, TOKEN, 'eu'],
    })
    const log = readFileSync(join(base, 'logs', 'a', 'r.log'), 'utf8')
    expect(log).not.toContain(SECRET)
    expect(log).not.toContain(TOKEN)
    expect(log).toContain(`token is ${REDACTED} here`)
    expect(log).toContain(`bearer ${REDACTED}`)
    expect(res.output).not.toContain(SECRET)
  })

  it('the child sees only the env it is handed', async () => {
    const res = await run(['env'], { env: { PATH: process.env.PATH ?? '', ONLY_THIS: '1' } })
    const names = res.output
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('=')[0])
    expect(names).toContain('ONLY_THIS')
    expect(names).not.toContain('SILOS_ROOT')
    expect(names.filter((n) => !['PATH', 'ONLY_THIS', 'PWD', 'SHLVL', '_', 'OLDPWD'].includes(n!))).toEqual([])
  })

  it('a program that does not exist / a folder that does not: an error, no exit code', async () => {
    const a = await runCommand({ argv: ['/nonexistent/prog'], cwd: agentFolder, env: {}, timeoutMs: 5000, logFile: join(base, 'l1.log'), secrets: [] })
    expect(a.exitCode).toBeUndefined()
    expect(a.error).toBe('not found: /nonexistent/prog')
    const b = await run(['ok'], { cwd: join(base, 'nope') })
    expect(b.error).toMatch(/its folder does not exist/)
  })

  it('helpers: expansion, redaction, last line, tail', () => {
    expect(expandAgentState('$SILOS_AGENT_STATE/x.sh', '/s/finance')).toBe('/s/finance/x.sh')
    expect(expandAgentState('${SILOS_AGENT_STATE}/x', '/s/finance')).toBe('/s/finance/x')
    expect(expandAgentState('$SILOS_AGENT_STATEX', '/s')).toBe('$SILOS_AGENT_STATEX')
    expect(expandAgentState('$HOME/x', '/s')).toBe('$HOME/x')
    expect(() => expandAgentState('$SILOS_AGENT_STATE/x', null)).toThrow(/not available/)
    expect(redactor(['abcd', 'abcdef'])('xabcdefx abcd')).toBe(`x${REDACTED}x ${REDACTED}`)
    expect(lastNonEmptyLine('a\nb\n\n  \n')).toBe('b')
    expect(lastNonEmptyLine('x'.repeat(300))!.length).toBe(200)
    expect(tailLines('1\n2\n3\n', 2)).toBe('2\n3')
  })
})

describe('validateRun — what the API accepts', () => {
  it('absent, null and {kind:"agent"} are an agent turn (never stored)', () => {
    expect(validateRun(undefined)).toBeUndefined()
    expect(validateRun(null)).toBeUndefined()
    expect(validateRun({ kind: 'agent' })).toBeUndefined()
  })
  it('a command: argv, cwd, timeout, onFailure, okCodes', () => {
    expect(validateRun({ kind: 'command', argv: ['/usr/bin/python3', 'x.py'], onFailure: 'inbox' })).toEqual({
      kind: 'command',
      argv: ['/usr/bin/python3', 'x.py'],
      onFailure: 'inbox',
    })
    expect(
      validateRun({ kind: 'command', argv: ['$SILOS_AGENT_STATE/s.sh'], cwd: '$SILOS_AGENT_STATE/x', timeoutMs: 60_000, onFailure: 'agent', okCodes: [0, 3] }),
    ).toEqual({ kind: 'command', argv: ['$SILOS_AGENT_STATE/s.sh'], cwd: '$SILOS_AGENT_STATE/x', timeoutMs: 60_000, onFailure: 'agent', okCodes: [0, 3] })
    expect(validateRun({ kind: 'command', argv: ['x'], onFailure: 'inbox', okCodes: [0] })).toEqual({ kind: 'command', argv: ['x'], onFailure: 'inbox' })
  })
  it.each([
    [{ kind: 'shell', argv: ['x'], onFailure: 'inbox' }, /run.kind/],
    [{ kind: 'command', argv: [], onFailure: 'inbox' }, /non-empty list/],
    [{ kind: 'command', argv: 'ls -la', onFailure: 'inbox' }, /non-empty list/],
    [{ kind: 'command', argv: ['ls', ''], onFailure: 'inbox' }, /non-empty string/],
    [{ kind: 'command', argv: ['ls', 3], onFailure: 'inbox' }, /non-empty string/],
    [{ kind: 'command', argv: Array(65).fill('a'), onFailure: 'inbox' }, /at most 64/],
    [{ kind: 'command', argv: ['a'.repeat(4097)], onFailure: 'inbox' }, /longer than/],
    [{ kind: 'command', argv: ['ls'], onFailure: 'email' }, /onFailure/],
    [{ kind: 'command', argv: ['ls'], onFailure: 'inbox', cwd: 'relative/dir' }, /absolute/],
    [{ kind: 'command', argv: ['ls'], onFailure: 'inbox', timeoutMs: 61 * 60_000 }, /timeoutMs/],
    [{ kind: 'command', argv: ['ls'], onFailure: 'inbox', timeoutMs: 10 }, /timeoutMs/],
    [{ kind: 'command', argv: ['ls'], onFailure: 'inbox', okCodes: [256] }, /okCodes/],
  ])('refuses %j', (v, msg) => {
    expect(() => validateRun(v)).toThrow(msg)
  })
  it('a command that only tells you needs no prompt; one that hands over does', () => {
    const body = { name: 'n', agentId: 'finance', trigger: { kind: 'cron', expr: '0 6 * * *' } }
    expect(validateAutomationCreate({ ...body, run: { kind: 'command', argv: ['ls'], onFailure: 'inbox' } }, registry).prompt).toBe('')
    expect(() => validateAutomationCreate({ ...body, run: { kind: 'command', argv: ['ls'], onFailure: 'agent' } }, registry)).toThrow(/prompt required/)
    expect(() => validateAutomationCreate(body, registry)).toThrow(/prompt required/)
    const current = { ...mkAutomation('v', cmd(['ok'])), prompt: '' }
    // switching to an agent turn needs the prompt it lacks
    expect(() => validateAutomationPatch({ run: { kind: 'agent' } }, registry, current)).toThrow(/prompt required/)
    const back = validateAutomationPatch({ run: { kind: 'agent' }, prompt: 'do it' }, registry, current)
    expect('run' in back && back.run === undefined).toBe(true)
  })
})

describe('the resident — a command run in place of a turn', () => {
  it('exit 0: ok, exit code, the last line as summary, a log; no Claude', async () => {
    store.create(mkAutomation('c1', cmd(['ok'])))
    const r = mkResident()
    await runOnce(r, 'c1')
    const run = store.listRuns('c1')[0]!
    expect(run.status).toBe('ok')
    expect(run.exitCode).toBe(0)
    expect(run.summary).toBe('synced 3 invoices')
    expect(run.command).toMatchObject({ exitCode: 0, lastLine: 'synced 3 invoices' })
    expect(run.produced).toBe(true)
    expect(calls).toHaveLength(0)
    expect(readFileSync(store.runLogPath('c1', run.id), 'utf8')).toContain('synced 3 invoices')
    expect(store.get('c1')?.lastRun).toMatchObject({ status: 'ok', exitCode: 0, summary: 'synced 3 invoices' })
  })

  it('the OUTCOME line an agent run speaks is read from the script too', async () => {
    store.create(mkAutomation('c2', cmd(['outcome'])))
    const r = mkResident()
    await runOnce(r, 'c2')
    const run = store.listRuns('c2')[0]!
    expect(run.outcome).toBe('acted')
    expect(run.summary).toBe('synced 3 invoices')
  })

  it('exit ≠ 0 with onFailure inbox: failed, «exited N», the command leg, no Claude', async () => {
    store.create(mkAutomation('c3', cmd(['fail', '2'])))
    const r = mkResident()
    await runOnce(r, 'c3')
    const run = store.listRuns('c3')[0]!
    expect(run.status).toBe('failed')
    expect(run.error).toBe('exited 2')
    expect(run.exitCode).toBe(2)
    expect(run.summary).toBe('boom: ledgerly said 500')
    expect(run.handover).toBeUndefined()
    expect(calls).toHaveLength(0)
    expect(store.get('c3')?.lastRunError).toBe('exited 2')
  })

  it('okCodes: an exit listed there is not a failure', async () => {
    store.create(mkAutomation('c4', cmd(['fail', '3'], { okCodes: [0, 3] })))
    const r = mkResident()
    await runOnce(r, 'c4')
    expect(store.listRuns('c4')[0]).toMatchObject({ status: 'ok', exitCode: 3 })
  })

  it('a timeout: failed, «timed out after …», no exit code', async () => {
    store.create(mkAutomation('c5', cmd(['sleep'], { timeoutMs: 1000 })))
    const r = mkResident()
    await runOnce(r, 'c5')
    const run = store.listRuns('c5')[0]!
    expect(run.status).toBe('failed')
    expect(run.error).toBe('timed out after 1 min')
    expect(run.command?.timedOut).toBe(true)
    expect(run.exitCode).toBeUndefined()
  }, 15_000)

  it('env: the Vault secrets for the agent + its state + its bearer, PATH/HOME — never the rest of the server env; secrets redacted in the log', async () => {
    process.env.SILOS_TEST_LEAK = 'should-not-pass'
    try {
      store.create(mkAutomation('c6', cmd(['env'])))
      store.create(mkAutomation('c6b', cmd(['secret'])))
      const r = mkResident()
      await runOnce(r, 'c6')
      await runOnce(r, 'c6b')
      const envLog = readFileSync(store.runLogPath('c6', store.listRuns('c6')[0]!.id), 'utf8')
      expect(envLog).toContain(`FIXTURE_SECRET=${REDACTED}`)
      expect(envLog).toContain(`SILOS_AGENT_STATE=${join(dataDir, 'agent-state', 'finance')}`)
      expect(envLog).toContain('SILOS_AGENT_ID=finance')
      expect(envLog).toContain(`SILOS_AGENT_TOKEN=${REDACTED}`)
      expect(envLog).toContain('PATH=')
      expect(envLog).not.toContain('SILOS_TEST_LEAK')
      const secretLog = readFileSync(store.runLogPath('c6b', store.listRuns('c6b')[0]!.id), 'utf8')
      expect(secretLog).not.toContain(SECRET)
      expect(secretLog).not.toContain(TOKEN)
      expect(secretLog).toContain(`token is ${REDACTED} here`)
    } finally {
      delete process.env.SILOS_TEST_LEAK
    }
  })

  it('$SILOS_AGENT_STATE expands in argv and cwd', async () => {
    const stateDir = agentState.dirFor('finance')
    store.create(mkAutomation('c7', { kind: 'command', argv: [FIXTURE, 'args', '$SILOS_AGENT_STATE/ledgerly-export'], onFailure: 'inbox' }))
    store.create(mkAutomation('c7b', { kind: 'command', argv: [FIXTURE, 'pwd'], cwd: '${SILOS_AGENT_STATE}', onFailure: 'inbox' }))
    const r = mkResident()
    await runOnce(r, 'c7')
    await runOnce(r, 'c7b')
    expect(readFileSync(store.runLogPath('c7', store.listRuns('c7')[0]!.id), 'utf8')).toContain(`[${stateDir}/ledgerly-export]`)
    expect(store.listRuns('c7b')[0]!.summary).toBe(stateDir)
  })

  it('cwd defaults to the agent folder', async () => {
    store.create(mkAutomation('c8', cmd(['pwd'])))
    const r = mkResident()
    await runOnce(r, 'c8')
    expect(store.listRuns('c8')[0]!.summary).toBe(agentFolder)
  })

  // E10 #39: a server on SILOS_PORT=3299 hands its commands ITS address —
  // never the 3210 one inherited from a console it was started from, never
  // one a Vault entry names (SILOS_API goes after the Vault).
  it('SILOS_API: a server on SILOS_PORT=3299 launches a command that prints http://127.0.0.1:3299', async () => {
    const prev = { port: process.env.SILOS_PORT, api: process.env.SILOS_API, host: process.env.SILOS_HOST }
    process.env.SILOS_PORT = '3299'
    process.env.SILOS_API = 'http://127.0.0.1:3210'
    delete process.env.SILOS_HOST
    try {
      const cfg = defaultConfig()
      // the composition root's own wiring (index.ts) …
      expect(silosApiUrl(cfg.host, cfg.port)).toBe('http://127.0.0.1:3299')
      store.create(mkAutomation('api1', cmd(['api'])))
      store.create(mkAutomation('api2', cmd(['api'])))
      // … and a Resident with no explicit address: the config's
      const bare = new Resident({
        store,
        registry,
        chat,
        native,
        index,
        root,
        dataDir,
        broadcast: () => {},
        claudeSessionsDir: join(base, 'no-claude-sessions'),
        tickIntervalMs: 999_999_999,
        agentState,
        vault: { envFor: () => ({ SILOS_API: 'http://evil.example:1' }) },
      })
      residents.push(bare)
      await runOnce(bare, 'api1')
      expect(store.listRuns('api1')[0]!.summary).toBe('http://127.0.0.1:3299')
      const wired = new Resident({
        store,
        registry,
        chat,
        native,
        index,
        root,
        dataDir,
        broadcast: () => {},
        claudeSessionsDir: join(base, 'no-claude-sessions'),
        tickIntervalMs: 999_999_999,
        agentState,
        silosApi: silosApiUrl(cfg.host, cfg.port),
      })
      residents.push(wired)
      await runOnce(wired, 'api2')
      expect(store.listRuns('api2')[0]!.summary).toBe('http://127.0.0.1:3299')
    } finally {
      for (const [k, v] of [
        ['SILOS_PORT', prev.port],
        ['SILOS_API', prev.api],
        ['SILOS_HOST', prev.host],
      ] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('a program that is not there: failed with the reason, no exit code, budget not spent', async () => {
    store.create(mkAutomation('c9', { kind: 'command', argv: ['/nonexistent/sync'], onFailure: 'inbox' }))
    const r = mkResident()
    await runOnce(r, 'c9')
    const run = store.listRuns('c9')[0]!
    expect(run).toMatchObject({ status: 'failed', error: 'not found: /nonexistent/sync', produced: false })
    expect(countsAgainstBudget(run)).toBe(false)
  })

  it('onFailure agent: the failure is handed to an agent turn in the SAME run — prompt + exit code + log tail; both legs kept', async () => {
    store.create(mkAutomation('h1', cmd(['fail', '3'], { onFailure: 'agent' })))
    const r = mkResident()
    await runOnce(r, 'h1')
    expect(calls).toHaveLength(1)
    const prompt = calls[0]!.prompt as string
    expect(prompt.startsWith('If the sync fails, find out why.')).toBe(true)
    expect(prompt).toContain(`The command \`${FIXTURE} fail 3\` exited 3.`)
    expect(prompt).toContain('boom: ledgerly said 500')
    expect(prompt.endsWith(RUN_OUTCOME_INSTRUCTION)).toBe(true)
    const runs = store.listRuns('h1')
    expect(new Set(runs.map((x) => x.id)).size).toBe(1) // one run, not two
    const run = runs[0]!
    expect(run).toMatchObject({
      status: 'ok',
      handover: true,
      exitCode: 3,
      outcome: 'acted',
      summary: 'reran the sync',
      sessionKey: expect.stringContaining('sess-hand'),
    })
    expect(run.command).toMatchObject({ exitCode: 3, lastLine: 'boom: ledgerly said 500' })
  })

  it('the hand-over never sees a secret: the tail it is given is the redacted log', async () => {
    store.create(mkAutomation('h2', { kind: 'command', argv: ['/bin/sh', '-c', `echo "key $FIXTURE_SECRET"; exit 1`], onFailure: 'agent' }))
    const r = mkResident()
    await runOnce(r, 'h2')
    expect(calls[0]!.prompt).not.toContain(SECRET)
    expect(calls[0]!.prompt).toContain(`key ${REDACTED}`)
  })

  it('a hand-over refused at a usage limit: failed (never waiting_reset, even with keepAlive) with both reasons, one inbox row of class command', async () => {
    script = [
      { type: 'system', subtype: 'init', session_id: 'sess-lim' },
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt: Date.now() + 3600_000, rateLimitType: 'seven_day' },
      } as unknown as SdkMessage,
      { type: 'result', subtype: 'error_during_execution', total_cost_usd: 0 },
    ]
    store.create(mkAutomation('h3', cmd(['fail', '3'], { onFailure: 'agent' }), { keepAlive: true }))
    const r = mkResident()
    await runOnce(r, 'h3')
    const run = store.listRuns('h3')[0]!
    expect(run.status).toBe('failed')
    expect(run.handover).toBe(true)
    expect(run.exitCode).toBe(3)
    expect(run.error).toBeTruthy()
    const failure = runFailure(run.error, run)
    expect(failure.class).toBe('command')
    expect(failure.text).toMatch(/^exited 3 · boom: ledgerly said 500 — handed over, but /)
    const row = failedRunRow(store.get('h3')!, store.listRuns('h3'), 'Finance')
    expect(row).not.toBeNull()
    expect(row!.kind).toBe('failedRun')
  })

  // the cron's own fires (a «Run now» is the owner's gesture: outside the
  // budget)
  it('budget: a command run spends the daily budget like a turn; the next is skipped', async () => {
    store.create(mkAutomation('b1', cmd(['ok']), { maxRunsPerDay: 1 }))
    const r = mkResident()
    await r.executeRun(store.get('b1')!)
    await r.drain()
    await r.executeRun(store.get('b1')!)
    await r.drain()
    const runs = store.listRuns('b1')
    expect(runs[0]).toMatchObject({ status: 'skipped', reason: 'daily budget reached (1/day)' })
    expect(runs[1]).toMatchObject({ status: 'ok' })
  })

  it('approval: the command waits for the go and runs only once approved', async () => {
    store.create(mkAutomation('ap', cmd(['ok']), { approval: true }))
    const r = mkResident()
    await runOnce(r, 'ap')
    const waiting = store.listRuns('ap')[0]!
    expect(waiting.status).toBe('waiting_approval')
    expect(existsSync(store.runLogPath('ap', waiting.id))).toBe(false)
    expect(r.approveRun(waiting.id)).toEqual({ ok: true })
    await r.drain()
    expect(store.listRuns('ap')[0]).toMatchObject({ id: waiting.id, status: 'ok', exitCode: 0 })
  })

  it('an automation switched back to an agent turn runs a turn again', async () => {
    store.create(mkAutomation('sw', cmd(['ok'])))
    store.update('sw', { run: undefined })
    const r = mkResident()
    await runOnce(r, 'sw')
    expect(calls).toHaveLength(1)
    expect(store.listRuns('sw')[0]!.command).toBeUndefined()
  })
})

describe('the inbox — class command', () => {
  it('a failed command enters at once, says «exited N · last line», even with a next run scheduled', async () => {
    store.create(mkAutomation('i1', cmd(['fail', '2']), { nextRunAt: new Date(Date.now() + 3600_000).toISOString() }))
    const r = mkResident()
    await runOnce(r, 'i1')
    const row = failedRunRow(store.get('i1')!, store.listRuns('i1'), 'Finance')
    expect(row).toMatchObject({ kind: 'failedRun', urgency: 'due', streak: 1 })
    if (row?.kind !== 'failedRun') throw new Error('no row')
    expect(row.failure).toEqual({ class: 'command', text: 'exited 2 · boom: ledgerly said 500' })
    expect(row.voice).toBe('Cmd i1 failed — exited 2 · boom: ledgerly said 500 · Finance')
  })

  it('a timed-out command is admitted at once too (not the agent «2 in a row» timeout rule), and is never «limit»', () => {
    const a = mkAutomation('i2', cmd(['sleep']), { nextRunAt: new Date(Date.now() + 3600_000).toISOString() })
    const run = {
      id: 'r1',
      automationId: 'i2',
      at: new Date().toISOString(),
      status: 'failed' as const,
      error: 'timed out after 10 min',
      command: { timedOut: true, durationMs: 600_000, logBytes: 10 },
    }
    const row = failedRunRow(a, [run], 'Finance')
    if (row?.kind !== 'failedRun') throw new Error('no row')
    expect(row.failure).toEqual({ class: 'command', text: 'timed out' })
    const limited = { ...run, error: "You've reached your Fable limit" }
    expect(runFailure(limited.error, limited).class).toBe('command')
  })
})

// a command run is a turn of its automation — its
// bearer writes carry a token of class `run` (else every bearer write of a
// live command automation would be a 403), dropped when the command ends
describe('the turn token of a command run', () => {
  it("SILOS_TURN rides the command's env, a run of its automation while it runs, dropped after", async () => {
    const out = join(base, 'turn.txt')
    const seen: unknown[] = []
    const mint = chat.liveTurns.mintTurn.bind(chat.liveTurns)
    chat.liveTurns.mintTurn = (input) => {
      const t = mint(input)
      seen.push(chat.liveTurns.get(t))
      return t
    }
    store.create(mkAutomation('tk', { kind: 'command', argv: ['sh', '-c', `printf %s "$SILOS_TURN" > ${out}`], onFailure: 'inbox' }))
    const r = mkResident()
    await r.executeRun(store.get('tk')!)
    await r.drain()
    const token = readFileSync(out, 'utf8')
    expect(token.length).toBeGreaterThan(16)
    expect(seen[0]).toMatchObject({ agentId: 'finance', class: 'run', automationId: 'tk', unattended: true })
    expect(chat.liveTurns.get(token)).toBeNull()
  })
})
