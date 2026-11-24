import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, symlinkSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The cron fence without leaks, by whose session it is.
// A Silos agent's session (its agent id or its bearer in the environment):
// CronCreate's `recurring` is optional and defaults to TRUE (Claude Code
// 2.1.319), so the hook denies unless the call says `recurring: false`
// literally; `durable: true` persists to .claude/scheduled_tasks.json and
// is denied too. A session a person started by hand: only `durable: true`
// is denied, and only where a Silos answers — a recurring session-scoped
// cron (a fixed-interval /loop) passes. Input it cannot read allows
// (never-break-claude); without python3 it allows with one line on stderr.
const HOOK = fileURLToPath(new URL('../../plugin/hooks/pre-cron.sh', import.meta.url))
// nothing listens here: Silos «not running»
const NOWHERE = 'http://127.0.0.1:9'

type Run = { decision: 'deny' | 'allow'; reason: string; stderr: string }
function run(stdin: string, env: Record<string, string>): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = execFile('/bin/sh', [HOOK], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) return reject(err)
      if (stdout.trim() === '') return resolve({ decision: 'allow', reason: '', stderr })
      const j = JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }
      expect(j.hookSpecificOutput.permissionDecision).toBe('deny')
      resolve({ decision: 'deny', reason: j.hookSpecificOutput.permissionDecisionReason, stderr })
    })
    child.stdin!.end(stdin)
  })
}
// an agent inside Silos (the server's own address need not answer)
const AGENT = { SILOS_AGENT_ID: 'writer', SILOS_API: NOWHERE }
const decide = async (stdin: string): Promise<'deny' | 'allow'> => (await run(stdin, AGENT)).decision
const call = (toolInput: Record<string, unknown>): string =>
  JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'CronCreate', tool_input: { cron: '*/5 * * * *', prompt: 'ping', ...toolInput } })

describe('pre-cron.sh — the CronCreate fence', () => {
  it('no `recurring` field → deny (the field defaults to true)', async () => {
    expect(await decide(call({}))).toBe('deny')
  })
  it('recurring: true → deny', async () => {
    expect(await decide(call({ recurring: true }))).toBe('deny')
  })
  it('recurring: false → allow (a one-shot self-ping)', async () => {
    expect(await decide(call({ recurring: false }))).toBe('allow')
    expect(await decide(call({ recurring: false, durable: false }))).toBe('allow')
  })
  it('recurring: false with durable: true → deny', async () => {
    expect(await decide(call({ recurring: false, durable: true }))).toBe('deny')
  })
  it('only a literal false is a one-shot (a falsy non-boolean is not)', async () => {
    expect(await decide(call({ recurring: 0 }))).toBe('deny')
    expect(await decide(call({ recurring: 'false' }))).toBe('deny')
  })
  it('unreadable JSON → allow', async () => {
    expect(await decide('{not json')).toBe('allow')
    expect(await decide('')).toBe('allow')
  })
  it('an agent gets the proposal recipe with its bearer, and what stays allowed', async () => {
    const r = await run(call({}), AGENT)
    expect(r.reason).toContain('/api/proposals')
    expect(r.reason).toContain('$SILOS_AGENT_TOKEN')
    expect(r.reason).toContain('A one-shot CronCreate with recurring:false, never durable, is fine')
  })
  it('the bearer alone marks an agent session too (no agent id in the environment)', async () => {
    const r = await run(call({ recurring: true }), { SILOS_AGENT_TOKEN: 'tok', SILOS_API: NOWHERE })
    expect(r.decision).toBe('deny')
    expect(r.reason).toContain('/api/proposals')
    expect(r.reason).not.toContain('tok"') // the recipe names the variable, never its value
  })
})

describe('pre-cron.sh — inside or outside Silos', () => {
  let server: Server
  let api = ''
  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(req.url === '/healthz' ? '{"ok":true}' : '{}')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const a = server.address()
    api = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  // a session a person started by hand: no agent id, no bearer
  it('by hand, recurring and not durable (a fixed-interval /loop) → allow, with Silos running or not', async () => {
    for (const input of [call({}), call({ recurring: true }), call({ recurring: true, durable: false })]) {
      expect(await run(input, { SILOS_API: api })).toEqual({ decision: 'allow', reason: '', stderr: '' })
    }
    expect(await run(call({ recurring: true }), { SILOS_API: NOWHERE })).toEqual({ decision: 'allow', reason: '', stderr: '' })
  })
  it('by hand, durable → deny where a Silos answers, pointing at the automation page', async () => {
    for (const input of [call({ durable: true }), call({ recurring: false, durable: true })]) {
      const r = await run(input, { SILOS_API: api })
      expect(r.decision).toBe('deny')
      expect(r.reason).toContain(`${api}/automation/new`)
      expect(r.reason).not.toContain('SILOS_AGENT_TOKEN')
    }
  })
  it('by hand, durable, no Silos answering → allow, and say nothing', async () => {
    const r = await run(call({ durable: true }), { SILOS_API: NOWHERE })
    expect(r).toEqual({ decision: 'allow', reason: '', stderr: '' })
  })
  it('the same recurring call in an agent session → deny, with or without Silos answering', async () => {
    expect((await run(call({ recurring: true }), { SILOS_AGENT_ID: 'writer', SILOS_API: api })).decision).toBe('deny')
    expect((await run(call({ recurring: true }), { SILOS_AGENT_ID: 'writer', SILOS_API: NOWHERE })).decision).toBe('deny')
  })
  it('a one-shot never probes: allowed whatever answers', async () => {
    expect((await run(call({ recurring: false }), { SILOS_API: api })).decision).toBe('allow')
  })
})

describe('pre-cron.sh — python3 is missing: allow, one line on stderr', () => {
  // a PATH holding only what the hook may find: the named tools, linked
  function pathWith(tools: string[]): string {
    const bin = mkdtempSync(join(tmpdir(), 'deck-bin-'))
    for (const t of tools) {
      const dir = (process.env.PATH ?? '').split(':').find((d) => d !== '' && existsSync(join(d, t)))
      if (dir !== undefined) symlinkSync(join(dir, t), join(bin, t))
    }
    return bin
  }
  it('without python3', async () => {
    const r = await run(call({ recurring: true }), { ...AGENT, PATH: pathWith(['cat', 'grep', 'dirname']) })
    expect(r.decision).toBe('allow')
    expect(r.stderr.trim().split('\n')).toHaveLength(1)
    expect(r.stderr).toMatch(/python3 is not installed/)
  })
  it("curl is not needed: the probe for a Silos is Python's", async () => {
    const r = await run(call({ durable: true }), { SILOS_API: NOWHERE, PATH: pathWith(['cat', 'grep', 'dirname', 'python3']) })
    expect(r).toEqual({ decision: 'allow', reason: '', stderr: '' })
  })
})
