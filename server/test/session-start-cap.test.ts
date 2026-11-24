// The SessionStart hook's output is ALWAYS under Claude Code's cap for a
// hook's additionalContext (10,000 characters — beyond it the model gets a
// file path and a 2,000-character preview instead of the rules), in every
// combination of loaded skills, roster size, inbox size, open tasks and
// SessionStart source; and each source sends only what the session's
// context does not already carry (session-start.sh, compose.py --hook).
import { describe, it, expect, afterEach } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BRIEFED_ENV, BRIEFING_FRAGMENTS, briefingText } from '../src/harnesses/briefing.js'
import { consoleAppend } from '../src/harnesses/claude-code/server-hooks.js'
import { SILOS_HOOK_ENTRIES } from '../src/harnesses/claude-code/settings.js'

const PLUGIN = fileURLToPath(new URL('../../plugin/', import.meta.url))
const HOOK = join(PLUGIN, 'hooks', 'session-start.sh')
const COMPOSE = join(PLUGIN, 'hooks', 'compose.py')
const ENGINE_CAP = 10_000
const HOOK_CAP = 9_500 // session-start.sh CAP: a margin under the engine's

const dirs: string[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r))
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const temp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p))
  dirs.push(d)
  return d
}

// one project: builder works in `root`, every other agent in a folder inside
// it — so builder knows them all, and a session started by hand in `root`
// is told them all
const agents = (n: number, hostile = false, root = '/home/u/projects') => ({
  agents: Array.from({ length: n }, (_, i) => ({
    id: i === 0 ? 'builder' : `agent${i}`,
    name: i === 0 ? 'Builder' : `Agent ${i}`,
    emoji: '🛠',
    folder: i === 0 ? root : hostile ? `${root}/${'deep/'.repeat(400)}${i}` : `${root}/p${i % 5}`,
    folders: i % 3 === 0 ? [`/home/u/shared/area-${i}`] : [],
    mission: { text: hostile ? 'x'.repeat(5000) : `Keeps part ${i} of the business running and reports weekly. Then more.` },
  })),
})
const inbox = (n: number, hostile = false) =>
  Array.from({ length: n }, (_, i) => ({
    id: hostile ? `m${i}${'i'.repeat(2000)}` : `m${i}`,
    from: hostile ? 'f'.repeat(3000) : `agent${i + 1}`,
    to: 'builder',
    state: 'new',
    at: `2026-11-1${i % 10}T09:00:00.000Z`,
    text: 'Please look at the failing sync and say what is missing before the close; details in context/ops/sync.md '.repeat(3),
    ...(hostile ? { readOutside: Array.from({ length: 200 }, (_, j) => `Tool${j}`) } : {}),
  }))
const tasks = (n: number) => ({
  k1: Array.from({ length: n }, (_, i) => ({
    key: `folder:/p/x/plan${i}/tasks/t${i}`,
    ref: `plan${i}#t${i}`,
    title: `Ship ${'the thing '.repeat(60)}${i}`,
    state: 'in_progress',
    current: true,
  })),
})

interface Run {
  skills: string[]
  roster: number
  msgs: number
  hostile?: boolean
  tasks?: number
  env?: Record<string, string>
  source?: string
  sessionId?: string
  transcript?: string
}

async function hook(r: Run): Promise<{ ctx: string; raw: string }> {
  const home = temp('cap-')
  const proj = join(home, 'proj')
  mkdirSync(proj)
  for (const s of r.skills) {
    mkdirSync(join(proj, '.claude', 'skills', s), { recursive: true })
    writeFileSync(join(proj, '.claude', 'skills', s, 'SKILL.md'), 'x')
  }
  // a session with no identity reads the roster from the file, never the API
  mkdirSync(join(home, '.silos'))
  writeFileSync(join(home, '.silos', 'agents.json'), JSON.stringify(agents(r.roster, r.hostile, proj)))
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    const u = req.url ?? ''
    if (u.startsWith('/api/agents/')) return res.end(JSON.stringify({ messages: inbox(r.msgs, r.hostile) }))
    if (u.startsWith('/api/tasks/by-session')) return res.end(JSON.stringify(tasks(r.tasks ?? 0)))
    res.end(JSON.stringify(agents(r.roster, r.hostile, proj)))
  })
  servers.push(server)
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const raw = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      'sh',
      [HOOK],
      {
        env: { PATH: process.env.PATH ?? '', HOME: home, CLAUDE_PROJECT_DIR: proj, CLAUDE_CONFIG_DIR: join(home, 'cfg'), SILOS_API: api, ...r.env },
        encoding: 'utf8',
      },
      (err, out) => (err ? reject(err) : resolve(out)),
    )
    child.stdin!.end(
      JSON.stringify({
        session_id: r.sessionId ?? 'k1',
        cwd: proj,
        source: r.source ?? 'startup',
        hook_event_name: 'SessionStart',
        ...(r.transcript ? { transcript_path: r.transcript } : {}),
      }),
    )
  })
  return { raw, ctx: raw.trim() === '' ? '' : JSON.parse(raw).hookSpecificOutput.additionalContext }
}

const AGENT = { SILOS_AGENT_ID: 'builder', SILOS_AGENT_TOKEN: 't', SILOS_TURN: 'f'.repeat(32), SILOS_SESSION_ID: 'k1' }
const BRIEFED = { ...AGENT, ...BRIEFED_ENV }
const HEAD = '# You are running inside Silos'
const SLIM = '# Silos runs on this machine' // what a session without a bearer gets instead
const FLEET = 'Your projects (Silos):'
const HERE = "This folder's agents (Silos):" // what a session with no identity is told

describe('session-start hook: always under the cap', () => {
  const skillSets = [[], ['team-plan'], [...BRIEFING_FRAGMENTS]]
  const modes: Array<[string, Partial<Run>]> = [
    ['a claude started by hand', { env: {} }],
    ['a Silos launch (briefing in its system prompt)', { env: BRIEFED }],
    ['a Silos console after /clear, 10 open tasks', { env: BRIEFED, source: 'clear', tasks: 10 }],
    ['an agent env with no system-prompt briefing, /clear, 10 open tasks', { env: AGENT, source: 'clear', tasks: 10 }],
    ['a claude launched from a shell inside a Silos session', { env: BRIEFED, sessionId: 'nested-1' }],
    ['compaction of a hand-started claude', { env: {}, source: 'compact' }],
  ]
  const runs: Array<[string, Run]> = []
  // every mode × every skill set, over three fleet shapes rather than the
  // full 3 × 2 grid: the briefing fills whatever room the rest leaves, so
  // every composition lands just under the cap and the risk is the dynamic
  // part. Kept: the smallest (1 agent, no message — the most briefing; the
  // hand-started ones measured 9,421 of 9,500), the fullest shown in full
  // (7 agents, 7 messages — 9,472, the highest measured) and the truncated
  // one (30 agents: builder is told 29 — 12 shown and «and 17 more»); the hostile fields below.
  const fleets: Array<[number, number]> = [
    [1, 0],
    [7, 7],
    [30, 7],
  ]
  for (const [mode, m] of modes)
    for (const skills of skillSets)
      for (const [roster, msgs] of fleets) {
        runs.push([`${mode} · ${skills.length} skills · ${roster} agents · ${msgs} messages`, { skills, roster, msgs, ...m }])
      }
  for (const [mode, m] of modes)
    runs.push([`${mode} · hostile fields (5,000-char missions, 3,000-char senders)`, { skills: [], roster: 100, msgs: 9, hostile: true, ...m }])

  it(`${runs.length} compositions: every additionalContext ≤ ${HOOK_CAP} (engine cap ${ENGINE_CAP}), valid JSON`, async () => {
    const over: string[] = []
    for (let i = 0; i < runs.length; i += 12) {
      const batch = runs.slice(i, i + 12)
      const outs = await Promise.all(batch.map(([, r]) => hook(r)))
      outs.forEach(({ ctx }, j) => {
        if (ctx.length > HOOK_CAP) over.push(`${batch[j]![0]}: ${ctx.length}`)
      })
    }
    expect(over).toEqual([])
  }, 120_000)

  it('the briefing it does send keeps every rule, at least by name and file', async () => {
    const { ctx } = await hook({ skills: [], roster: 30, msgs: 7, env: AGENT, source: 'clear', tasks: 10 })
    for (const rule of [
      '**Deliverables',
      '**Scheduled and recurring work',
      '**Messages rule.**',
      '**Never launch `claude`',
      '**Be legible.**',
      '**Tasks rule.**',
      '**Secrets go through the Vault',
      '**Heartbeat rule.**',
    ]) {
      expect(ctx, rule).toContain(rule)
    }
    expect(ctx.length).toBeLessThanOrEqual(HOOK_CAP)
  })

  it('a roster or a task list too long to show says how many more and where', async () => {
    const { ctx } = await hook({ skills: [], roster: 30, msgs: 0, env: BRIEFED, source: 'clear', tasks: 10 })
    // 30 agents of one project: builder is told the other 29 — 12 shown, 17 more
    expect(ctx).toContain('- … and 17 more — GET ${SILOS_API:-http://127.0.0.1:3210}/api/agents')
    expect(ctx.split('This console was working on').length - 1).toBe(3)
    expect(ctx).toContain(
      '… and 7 more tasks this console works — the list: GET ${SILOS_API:-http://127.0.0.1:3210}/api/tasks/by-session?session=$SILOS_SESSION_ID',
    )
  })
})

describe('compose.py --budget: the briefing within any budget', () => {
  it('never over the budget, for every skill subset and budgets 0…15,000; the whole text whenever it fits', () => {
    const py = `
import sys, itertools
sys.path.insert(0, ${JSON.stringify(join(PLUGIN, 'hooks'))})
import compose
bad = []
names = compose.FRAGMENTS
for r in range(len(names) + 1):
    for has in itertools.combinations(names, r):
        full = compose.compose(set(has), compose.ROOT)
        for b in range(0, 15001, 125):
            t = compose.compose_within(set(has), compose.ROOT, b)
            if compose.units(t) > b: bad.append('%s@%d over' % (','.join(has), b))
            if compose.units(full) <= b and t != full: bad.append('%s@%d not whole' % (','.join(has), b))
print('\\n'.join(bad))
`
    // -B: importing compose writes no __pycache__ into the plugin
    expect(execFileSync('python3', ['-I', '-B', '-c', py], { encoding: 'utf8' }).trim()).toBe('')
  })
  it('a rule whose detail does not fit is named with the file that holds it — the agent reads it there', () => {
    const full = execFileSync('python3', [COMPOSE, '--has', ''], { encoding: 'utf8' })
    const budget = full.length - 200 // just short of the whole text: one detail has to fold
    const t = execFileSync('python3', [COMPOSE, '--has', '', '--budget', String(budget)], { encoding: 'utf8' })
    expect(t.length).toBeLessThanOrEqual(budget)
    expect(t).toContain('- **Scheduled and recurring work')
    expect(t).toMatch(
      /The rest of this rule \(its recipes and formats\) is in `[^`]*\/plugin\/context\/briefing\.d\/base\.md` — read it before you act on this rule\./,
    )
    // the file it names holds what was left out
    const path = /is in `([^`]*base\.md)`/.exec(t)![1]!
    expect(readFileSync(path, 'utf8')).toContain('/api/proposals')
  })
})

describe('session-start hook: each source sends what the context does not carry yet', () => {
  const transcript = (lines: unknown[]): string => {
    const p = join(temp('tr-'), 's.jsonl')
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    return p
  }
  const injected = (text: string) => ({ type: 'attachment', attachment: { type: 'hook_additional_context', hookEvent: 'SessionStart', content: [text] } })
  const boundary = { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' }
  const base = { skills: ['team-plan'], roster: 7, msgs: 2 }

  it('a Silos launch: never the briefing (its system prompt has it) — roster and inbox on startup', async () => {
    const { ctx } = await hook({ ...base, env: BRIEFED })
    expect(ctx).not.toContain(HEAD)
    expect(ctx).toContain(FLEET)
    expect(ctx).toContain('Your Silos inbox: 2 unread messages.')
  })
  it('a claude launched from a shell inside it inherits SILOS_BRIEFING but not the system prompt: it gets the briefing', async () => {
    const { ctx } = await hook({ ...base, env: BRIEFED, sessionId: 'nested-1' })
    expect(ctx.startsWith(HEAD)).toBe(true)
  })
  it('/clear in a Silos console: roster, inbox and the tasks it works — not the briefing again', async () => {
    const { ctx } = await hook({ ...base, env: BRIEFED, source: 'clear', tasks: 1, sessionId: 'rotated' })
    expect(ctx).not.toContain(HEAD)
    expect(ctx).toContain(FLEET)
    expect(ctx).toContain('This console was working on')
  })
  it('a claude started by hand (no bearer): the slim briefing on startup, clear and compact; with a bearer, the briefing', async () => {
    for (const source of ['startup', 'clear', 'compact']) {
      const { ctx } = await hook({ ...base, env: {}, source })
      expect(ctx.startsWith(SLIM), source).toBe(true)
      expect(ctx, source).not.toContain(HEAD)
      expect(ctx, source).toContain(HERE)
      const agent = await hook({ ...base, env: AGENT, source })
      expect(agent.ctx.startsWith(HEAD), source).toBe(true)
    }
  })
  it('a hand-started claude resumed: the slim briefing is not sent twice', async () => {
    const tp = transcript([injected(`${SLIM}\n\n…\n\n${FLEET}\n- x`), { type: 'user', message: { content: 'hi' } }])
    const { raw } = await hook({ ...base, msgs: 0, env: {}, source: 'resume', transcript: tp })
    expect(raw).toBe('')
  })
  it('resume and fork: only the inbox when the transcript since its last compaction already holds briefing and roster', async () => {
    const tp = transcript([injected(`${briefingText(['team-plan'])}\n\n${FLEET}\n- x`), { type: 'user', message: { content: 'hi' } }])
    for (const source of ['resume', 'fork']) {
      for (const env of [AGENT, BRIEFED]) {
        const { ctx } = await hook({ ...base, env, source, transcript: tp })
        expect(ctx, source).not.toContain(HEAD)
        expect(ctx, source).not.toContain(FLEET)
        expect(ctx, source).toContain('Your Silos inbox')
      }
    }
  })
  it('resume: both again when they were injected before a compaction, or never (a stub or no transcript)', async () => {
    const compacted = transcript([injected(`${briefingText(['team-plan'])}\n\n${FLEET}`), boundary])
    const stubbed = transcript([
      { type: 'attachment', attachment: { type: 'hook_system_message', hookEvent: 'SessionStart', content: `<persisted-output>\n${HEAD}` } },
    ])
    for (const tp of [compacted, stubbed, join(tmpdir(), 'no-such-transcript.jsonl')]) {
      const { ctx } = await hook({ ...base, env: AGENT, source: 'resume', transcript: tp })
      expect(ctx.startsWith(HEAD)).toBe(true)
      expect(ctx).toContain(FLEET)
    }
  })
  // a transcript longer than compose.py reads is read from its END: a
  // compaction near the end is seen, however much came before it
  it('a long transcript is judged by its tail, never by its first bytes', () => {
    const filler = Array.from({ length: 200 }, (_, i) => ({ type: 'user', message: { content: `turn ${i} ${'x'.repeat(80)}` } }))
    const carried = (lines: unknown[], scanMax: number): string =>
      execFileSync(
        'python3',
        [
          '-B',
          '-c',
          'import sys\nsys.path.insert(0, sys.argv[1])\nimport compose\ncompose.SCAN_MAX = int(sys.argv[3])\nprint(" ".join(sorted(compose.carries(sys.argv[2]))))',
          join(PLUGIN, 'hooks'),
          transcript(lines),
          String(scanMax),
        ],
        { encoding: 'utf8' },
      ).trim()
    const start = injected(`${HEAD}\n\n${FLEET}`)
    // injected at the start, compacted near the end: not held
    expect(carried([start, ...filler, boundary, { type: 'user' }], 2000)).toBe('')
    // injected again after that compaction: held
    expect(carried([start, ...filler, boundary, start, { type: 'user' }], 2000)).toBe('briefing roster')
    // injected only before the window, no compaction in it: sent again (the safe side)
    expect(carried([start, ...filler], 2000)).toBe('')
    expect(carried([start, ...filler], 64 * 1024 * 1024)).toBe('briefing roster')
  })
  it('a Silos launch resumed: the roster only when the transcript lacks it; never the briefing', async () => {
    const { ctx } = await hook({ ...base, env: BRIEFED, source: 'resume', transcript: transcript([{ type: 'user' }]) })
    expect(ctx).not.toContain(HEAD)
    expect(ctx).toContain(FLEET)
  })
  it('nothing to say prints nothing (no empty JSON)', async () => {
    const { raw } = await hook({ skills: [], roster: 0, msgs: 0, env: { ...BRIEFED_ENV } })
    expect(raw).toBe('')
  })
})

describe('the launches that carry the briefing in the system prompt', () => {
  it('a console: the agent append, then the briefing for its skills, and SILOS_BRIEFING', () => {
    const r = consoleAppend('Your mission: charter', ['team-plan'])
    expect(r.append).toBe(`Your mission: charter\n\n${briefingText(['team-plan'])}`)
    expect(r.briefedEnv).toEqual({ SILOS_BRIEFING: 'system-prompt' })
  })
  it('no agent append (unknown or archived agent): no file, no marker — the hook briefs it', () => {
    expect(consoleAppend(null, ['team-plan'])).toEqual({ append: undefined, briefedEnv: {} })
  })
  it('no readable briefing: the agent append alone, and no marker', () => {
    expect(consoleAppend('charter', [], join(tmpdir(), 'no-briefing-here'))).toEqual({ append: 'charter', briefedEnv: {} })
  })
})

describe('hooks.json', () => {
  const json = JSON.parse(readFileSync(join(PLUGIN, 'hooks', 'hooks.json'), 'utf8')) as {
    hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>>
  }
  it("every command quotes ${CLAUDE_PLUGIN_ROOT} and has a timeout; the entries are the installer's", () => {
    for (const [event, entries] of Object.entries(json.hooks)) {
      for (const e of entries)
        for (const h of e.hooks) {
          expect(h.command, event).toMatch(/^"\$\{CLAUDE_PLUGIN_ROOT\}"\//)
          expect(h.command.replace(/"\$\{CLAUDE_PLUGIN_ROOT\}"/g, '')).not.toContain('${CLAUDE_PLUGIN_ROOT}')
          expect(typeof h.timeout, event).toBe('number')
        }
    }
    for (const [event, want] of Object.entries(SILOS_HOOK_ENTRIES)) {
      const e = json.hooks[event]![0]!
      expect(e.matcher).toBe(want.matcher)
      expect(e.hooks[0]!.command).toBe(`"\${CLAUDE_PLUGIN_ROOT}"/hooks/${want.script}`)
      expect(e.hooks[0]!.timeout).toBe(want.timeout)
    }
  })
  it('SessionStart fires on every source Claude Code has: startup, resume, clear, compact, fork', () => {
    expect(json.hooks.SessionStart![0]!.matcher.split('|').sort()).toEqual(['clear', 'compact', 'fork', 'resume', 'startup'])
  })
  it('both commands run from a plugin root with a space in its path', async () => {
    const root = join(temp('plugin root '), 'with space')
    cpSync(PLUGIN, root, { recursive: true })
    for (const [event, input] of [
      ['SessionStart', { session_id: 's', source: 'startup', hook_event_name: 'SessionStart' }],
      ['PreToolUse', { tool_name: 'CronCreate', tool_input: { recurring: true } }],
    ] as const) {
      const out = await new Promise<string>((resolve, reject) => {
        // the shell form Claude Code runs: sh -c "<command>" with the placeholder expanded.
        // An agent's session: outside Silos (no agent, no Silos answering) the cron
        // gate allows silently and would print nothing to read here.
        const child = execFile(
          'sh',
          ['-c', json.hooks[event]![0]!.hooks[0]!.command.split('${CLAUDE_PLUGIN_ROOT}').join(root)],
          { env: { PATH: process.env.PATH ?? '', HOME: temp('h-'), SILOS_API: 'http://127.0.0.1:9', SILOS_AGENT_ID: 'writer' }, encoding: 'utf8' },
          (err, o) => (err ? reject(err) : resolve(o)),
        )
        child.stdin!.end(JSON.stringify(input))
      })
      expect(JSON.parse(out).hookSpecificOutput.hookEventName, event).toBe(event)
    }
  })
})
