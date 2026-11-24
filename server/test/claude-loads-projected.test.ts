// claude-loads-projected.test.ts — a plugin's projected weight on the Claude
// engine (harnesses/claude-code/loads/projected.ts): `claude plugin details`
// run on a fake runner — bounded and killed at the bound, one at a time,
// kept in memory per plugin version, gated on the engine version its line
// was confirmed on, nothing from an output it cannot read, and never a
// count from it. The kill is proven on a real process (a sleeping script).
import { describe, it, expect } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudePluginProjection, PROJECTED_CONFIRMED_ON, parseAlwaysOn, type DetailsCall } from '../src/harnesses/claude-code/loads/projected.js'
import type { LoadsProjectedInput, LoadsRow } from '../src/harnesses/contract.js'

// the real output of CLI 2.1.330, renamed to generic names
const DETAILS = `builder 1.2.0
  Description: Build things for example.com.
  Source: builder@synced

Component inventory
  Skills (2)  build-plan, build-check
  Agents (0)
  Hooks (0)
  MCP servers (9)  ledger, tickets, docs, calendar, mail, chat, design, tracker, notes  (tool schemas resolved at runtime; not counted)
  LSP servers (0)

Projected token cost
  Always-on:   ~1,125 tok   added to every session

Per-component (rounded)
  component             always-on  on-invoke
  build-plan                  ~90      ~1.2k
  build-check                 ~80      ~1.4k

  On-invoke cost is paid each time a skill or agent fires.
  Token counts are estimates and may differ from actual usage.
`

const CONFIRMED = PROJECTED_CONFIRMED_ON[0]!

const row = (over: Partial<LoadsRow> = {}): LoadsRow => ({
  key: 'plugin:acct-1:builder@synced',
  engine: 'claude-code',
  kind: 'plugin',
  name: 'builder@synced',
  label: 'builder',
  exact: true,
  origin: { owner: 'account', carrier: 'builder plugin', login: 'owner@example.com' },
  state: 'available',
  detail: '1.2.0',
  carries: {
    skills: ['build-plan', 'build-check'],
    commands: [],
    agents: [],
    hooks: { count: 0, events: [] },
    mcp: 2,
    placeholders: 7,
    lsp: [],
    outputStyles: [],
  },
  ...over,
})
const input = (over: Partial<LoadsProjectedInput> = {}): LoadsProjectedInput => ({
  folder: '/home/user/proj',
  home: '/home/user',
  row: row(),
  provider: null,
  engineVersion: CONFIRMED,
  ...over,
})

function fakeRunner(
  answer: (call: DetailsCall) => Promise<{ code: number | null; stdout: string }> | { code: number | null; stdout: string } = () => ({
    code: 0,
    stdout: DETAILS,
  }),
) {
  const calls: DetailsCall[] = []
  let running = 0
  let most = 0
  return {
    calls,
    most: () => most,
    runner: async (call: DetailsCall) => {
      calls.push(call)
      running++
      most = Math.max(most, running)
      try {
        return await answer(call)
      } finally {
        running--
      }
    },
  }
}
const proj = (f: ReturnType<typeof fakeRunner>, timeoutMs?: number) =>
  new ClaudePluginProjection({ runner: f.runner, bin: () => '/usr/bin/claude', ...(timeoutMs !== undefined ? { timeoutMs } : {}) })

describe('claude plugin details — the one figure', () => {
  it('reads the Always-on line only: the figure, from the documented subcommand, under a built env, in the folder', async () => {
    const f = fakeRunner()
    expect(await proj(f).estimate(input())).toBe(1125)
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]!.args).toEqual(['plugin', 'details', 'builder@synced'])
    expect(f.calls[0]!.cwd).toBe('/home/user/proj')
    expect(f.calls[0]!.env.HOME).toBe('/home/user')
    expect(Object.keys(f.calls[0]!.env).some((k) => k.startsWith('ANTHROPIC_') || k === 'CLAUDECODE')).toBe(false)
    expect(f.calls[0]!.env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })

  it('an account login runs under its own config dir', async () => {
    const f = fakeRunner()
    await proj(f).estimate(
      input({ provider: { id: 'account:work', kind: 'claude-account', label: 'Claude · work', configDir: '/home/user/.silos/accounts/work' } }),
    )
    expect(f.calls[0]!.env.CLAUDE_CONFIG_DIR).toBe('/home/user/.silos/accounts/work')
  })

  it('an engine version the line was not confirmed on shows nothing, and nothing runs', async () => {
    const f = fakeRunner()
    const p = proj(f)
    expect(await p.estimate(input({ engineVersion: '2.1.331' }))).toBeNull()
    expect(await p.estimate(input({ engineVersion: '2.1.329' }))).toBeNull()
    expect(await p.estimate(input({ engineVersion: null }))).toBeNull()
    expect(f.calls).toHaveLength(0)
  })

  it('an output it cannot read shows nothing', () => {
    expect(parseAlwaysOn('')).toBeNull()
    expect(parseAlwaysOn('Plugin "builder@synced" not found.')).toBeNull()
    // the line without its heading, a changed wording, a changed unit, two lines
    expect(parseAlwaysOn(DETAILS.replace('Projected token cost\n', ''))).toBeNull()
    expect(parseAlwaysOn(DETAILS.replace('added to every session', 'added per session'))).toBeNull()
    expect(parseAlwaysOn(DETAILS.replace('~1,125 tok', '~1,125 tokens'))).toBeNull()
    expect(
      parseAlwaysOn(
        DETAILS.replace(
          '  Always-on:   ~1,125 tok   added to every session',
          '  Always-on:   ~1,125 tok   added to every session\n  Always-on:   ~9 tok   added to every session',
        ),
      ),
    ).toBeNull()
    expect(parseAlwaysOn(DETAILS.replace('~1,125', '~1.125.000'))).toBeNull()
    // the shapes it reads
    expect(parseAlwaysOn(DETAILS.replace('~1,125', '~619'))).toBe(619)
    expect(parseAlwaysOn(DETAILS.replace('~1,125', '~2.1k'))).toBe(2100)
  })

  it('a refusal or an unreadable answer shows nothing', async () => {
    expect(await proj(fakeRunner(() => ({ code: 1, stdout: 'Plugin "builder@synced" not found.' }))).estimate(input())).toBeNull()
    expect(await proj(fakeRunner(() => ({ code: 0, stdout: 'builder 1.2.0\n' }))).estimate(input())).toBeNull()
    expect(
      await proj(
        fakeRunner(() => {
          throw new Error('spawn failed')
        }),
      ).estimate(input()),
    ).toBeNull()
    expect(await new ClaudePluginProjection({ runner: fakeRunner().runner, bin: () => null }).estimate(input())).toBeNull()
  })

  it('counts never come from it: only a number comes back, whatever the output counts', async () => {
    const f = fakeRunner()
    const r = row()
    const before = JSON.stringify(r)
    const out = await proj(f).estimate(input({ row: r }))
    expect(typeof out).toBe('number')
    // the row's counts are the manifest's (2 servers + 7 placeholders), untouched by «MCP servers (9)»
    expect(JSON.stringify(r)).toBe(before)
  })

  it('only a plugin row with an engine id is asked — never a server, never an id the CLI could read as a flag', async () => {
    const f = fakeRunner()
    const p = proj(f)
    expect(await p.estimate(input({ row: row({ kind: 'mcp', name: 'ledger' }) }))).toBeNull()
    expect(await p.estimate(input({ row: row({ name: '--plugin-dir=/tmp@x' }) }))).toBeNull()
    expect(await p.estimate(input({ row: row({ name: 'builder' }) }))).toBeNull()
    expect(f.calls).toHaveLength(0)
  })
})

describe('claude plugin details — how it runs', () => {
  it('kept in memory per plugin version: a second opening never runs it again; a new version does', async () => {
    const f = fakeRunner()
    const p = proj(f)
    await p.estimate(input())
    await p.estimate(input())
    expect(f.calls).toHaveLength(1)
    await p.estimate(input({ row: row({ detail: '1.3.0' }) }))
    expect(f.calls).toHaveLength(2)
    // two openings at once share one run
    const g = fakeRunner()
    const r = new ClaudePluginProjection({ runner: g.runner, bin: () => 'claude' })
    await Promise.all([r.estimate(input()), r.estimate(input())])
    expect(g.calls).toHaveLength(1)
  })

  it('a timeout or a refusal is not kept: the next opening asks again', async () => {
    let n = 0
    const f = fakeRunner(() => (++n === 1 ? { code: null, stdout: '' } : { code: 0, stdout: DETAILS }))
    const p = proj(f)
    expect(await p.estimate(input())).toBeNull()
    expect(await p.estimate(input())).toBe(1125)
    expect(f.calls).toHaveLength(2)
  })

  it('one at a time: a second plugin waits for the first to end', async () => {
    const releases: (() => void)[] = []
    const f = fakeRunner(
      () =>
        new Promise((res) => {
          releases.push(() => res({ code: 0, stdout: DETAILS }))
        }),
    )
    const p = proj(f)
    const a = p.estimate(input())
    const b = p.estimate(input({ row: row({ key: 'plugin:other@market', name: 'other@market', detail: '2.0.0' }) }))
    await new Promise((r) => setTimeout(r, 10))
    expect(f.calls).toHaveLength(1)
    releases[0]!()
    await a
    await new Promise((r) => setTimeout(r, 10))
    expect(f.calls).toHaveLength(2)
    releases[1]!()
    expect(await b).toBe(1125)
    expect(f.most()).toBe(1)
  })

  it('bounded: the runner is handed the bound', async () => {
    const f = fakeRunner()
    await proj(f, 1234).estimate(input())
    expect(f.calls[0]!.timeoutMs).toBe(1234)
  })

  it('killed at the bound: a process that never answers is gone and nothing is shown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'silos-projected-'))
    const pidFile = join(dir, 'pid')
    const bin = join(dir, 'claude')
    writeFileSync(bin, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`)
    chmodSync(bin, 0o755)
    const p = new ClaudePluginProjection({ bin: () => bin, timeoutMs: 300 })
    expect(await p.estimate(input({ folder: dir, home: dir }))).toBeNull()
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(() => process.kill(pid, 0)).toThrow()
  })
})
