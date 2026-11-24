// claude-loads-check.test.ts — «Check now» on the Claude engine
// (harnesses/claude-code/loads/check.ts), on a fake query: no prompt is
// ever sent, hooks are off in the flag settings, persistSession is false,
// the given agents' role plugins and the login's env are passed, and the
// process is closed on its answer and at the bound. Temp dirs only.
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHECK_BOUND_MS, claudeLoadsCheck, claudeSends } from '../src/harnesses/claude-code/loads/check.js'
import type { QueryArgs, SdkQueryHandle } from '../src/harnesses/claude-code/sdk-types.js'

let base: string, folder: string, home: string, stateDir: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'silos-check-'))
  folder = join(base, 'proj')
  home = join(base, 'home')
  stateDir = join(base, 'state', 'builder')
  mkdirSync(folder, { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(join(stateDir, 'plugin'), { recursive: true })
  writeFileSync(join(stateDir, 'plugin', '.mcp.json'), JSON.stringify({ mcpServers: { ledger: { command: 'x' } } }))
})

interface Fake {
  args: QueryArgs[]
  yielded: unknown[]
  closed: number
  asks: number
  queryFn: (a: QueryArgs) => SdkQueryHandle
}
function fake(answers: unknown[][] | 'never', account: unknown = { email: 'owner@example.com' }): Fake {
  const f: Fake = {
    args: [],
    yielded: [],
    closed: 0,
    asks: 0,
    queryFn: () => {
      throw new Error('unset')
    },
  }
  f.queryFn = (a) => {
    f.args.push(a)
    // whatever the prompt stream yields would be a prompt sent: read it all
    if (typeof a.prompt !== 'string')
      void (async () => {
        for await (const m of a.prompt) f.yielded.push(m)
      })()
    let release: () => void = () => {}
    const ended = new Promise<void>((r) => {
      release = r
    })
    return {
      async *[Symbol.asyncIterator]() {
        await ended
      },
      interrupt: async () => {
        release()
      },
      close: () => {
        f.closed++
        release()
      },
      initializationResult: async () => ({ account }),
      mcpServerStatus: () => {
        if (answers === 'never') return new Promise<unknown[]>(() => {})
        const rows = answers[Math.min(f.asks, answers.length - 1)]!
        f.asks++
        return Promise.resolve(rows)
      },
    }
  }
  return f
}
const agents = () => [{ id: 'builder', name: 'Builder', stateDir }]

describe('claudeLoadsCheck', () => {
  it("sends no prompt, hooks off in the flag settings, persistSession false, the role plugins and the login's env", async () => {
    const f = fake([
      [{ name: 'github', status: 'connected', source: 'project', config: { type: 'http', url: 'https://gh.example/mcp?token=x' }, tools: [{}, {}] }],
    ])
    const r = await claudeLoadsCheck(
      { folder, home, provider: { id: 'account:work', kind: 'claude-account', label: 'Claude · work', configDir: join(base, 'acct') }, agents: agents() },
      { queryFn: f.queryFn },
    )
    expect(f.args).toHaveLength(1)
    const { prompt, options } = f.args[0]!
    expect(typeof prompt).not.toBe('string')
    expect(f.yielded).toEqual([])
    expect(options.persistSession).toBe(false)
    expect(options.settings).toEqual({ disableAllHooks: true })
    expect(options.settingSources).toEqual(['user', 'project', 'local'])
    expect(options.plugins).toEqual([{ type: 'local', path: join(stateDir, 'plugin') }])
    expect((options.env as Record<string, string>).CLAUDE_CONFIG_DIR).toBe(join(base, 'acct'))
    expect(options.cwd).toBe(folder)
    expect(f.closed).toBe(1)
    // the login is the engine's own answer; config never leaves
    expect(r.login).toBe('owner@example.com')
    expect(r.servers).toEqual([{ name: 'github', status: 'connected', source: 'project', tools: 2 }])
    expect(r.complete).toBe(true)
  })

  it('asks again while a server is still connecting, then closes on the answer', async () => {
    const f = fake([[{ name: 'a', status: 'pending' }], [{ name: 'a', status: 'connected' }]])
    const r = await claudeLoadsCheck({ folder, home, provider: null, agents: [] }, { queryFn: f.queryFn })
    expect(f.asks).toBe(2)
    expect(r.servers[0]!.status).toBe('connected')
    expect(f.closed).toBe(1)
    expect(f.args[0]!.options.plugins).toBeUndefined()
  })

  it('is closed at the bound: no answer is a refusal; a pending answer is kept as pending', async () => {
    expect(CHECK_BOUND_MS).toBe(20_000)
    const silent = fake('never')
    await expect(claudeLoadsCheck({ folder, home, provider: null, agents: [], timeoutMs: 40 }, { queryFn: silent.queryFn })).rejects.toThrow(/didn't answer/)
    expect(silent.closed).toBe(1)
    const slow = fake([[{ name: 'a', status: 'pending' }]])
    const r = await claudeLoadsCheck({ folder, home, provider: null, agents: [], timeoutMs: 40 }, { queryFn: slow.queryFn })
    expect(slow.closed).toBe(1)
    expect(r).toMatchObject({ complete: false, servers: [{ name: 'a', status: 'pending' }] })
  })

  it('as an agent: its kept entries ride the flag tier through the launch allowlist — nothing else, hooks still off', async () => {
    const payload = {
      enabledPlugins: { 'demo@mkt': false },
      deniedMcpServers: [{ serverName: 'ledger' }],
      disableClaudeAiConnectors: true,
      permissions: { allow: ['Bash(*)'] },
      hooks: { Stop: [] },
      env: { X: '1' },
      disableAllHooks: false,
    }
    const f = fake([[{ name: 'github', status: 'connected', source: 'project' }]])
    const r = await claudeLoadsCheck({ folder, home, provider: null, agents: agents(), as: { agent: 'builder', payload } }, { queryFn: f.queryFn })
    expect(f.args[0]!.options.settings).toEqual({
      disableAllHooks: true,
      enabledPlugins: { 'demo@mkt': false },
      deniedMcpServers: [{ serverName: 'ledger' }],
      disableClaudeAiConnectors: true,
    })
    // the agent's connectors key is read like any layer's: none fetched for it
    expect(r.connectorsOn).toBe(false)
    // no payload kept: the project's check, unchanged
    const g = fake([[]])
    await claudeLoadsCheck({ folder, home, provider: null, agents: agents(), as: { agent: 'builder', payload: null } }, { queryFn: g.queryFn })
    expect(g.args[0]!.options.settings).toEqual({ disableAllHooks: true })
  })

  it('«See what it sends» runs without the local layer and says whether connectors were fetched', async () => {
    mkdirSync(join(folder, '.claude'), { recursive: true })
    writeFileSync(join(folder, '.claude', 'settings.local.json'), JSON.stringify({ disableClaudeAiConnectors: true }))
    expect(claudeSends({ folder, home, provider: null })).toEqual({ account: true, here: false })
    const f = fake([[{ name: 'claude.ai Drive', status: 'connected', source: 'claudeai' }]])
    const r = await claudeLoadsCheck({ folder, home, provider: null, agents: [], withoutLocal: true }, { queryFn: f.queryFn })
    expect(f.args[0]!.options.settingSources).toEqual(['user', 'project'])
    expect(r.connectorsOn).toBe(true)
    // a gateway key has no account to send anything
    expect(
      claudeSends({ folder, home, provider: { id: 'gw', kind: 'anthropic-compatible', label: 'gw', baseUrl: 'https://gw.example', apiKey: 'k' } }),
    ).toEqual({ account: false, here: false })
  })

  it('a query that throws while asking closes the process and surfaces the error', async () => {
    const f = fake([[]])
    const bad = (a: QueryArgs): SdkQueryHandle => ({ ...f.queryFn(a), mcpServerStatus: () => Promise.reject(new Error('process exited')) })
    await expect(claudeLoadsCheck({ folder, home, provider: null, agents: [] }, { queryFn: bad })).rejects.toThrow('process exited')
    expect(f.closed).toBe(1)
  })
})
