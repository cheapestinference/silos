// heartbeat-audit.ts — the unattended-turn audit:
// the pure core over neutral tool calls, the two
// engines' tool-call readers on synthetic transcripts / DBs, and the loader
// that follows children and birth-marker-linked nested sessions.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentRegistry, mungePath } from '../src/agent-registry.js'
import { AgentStateStore } from '../src/agent-state.js'
import { BirthsStore } from '../src/births-store.js'
import type { ToolCallRecord } from '../src/harnesses/contract.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { claudeToolCallsOfLines } from '../src/harnesses/claude-code/tool-calls.js'
import { OpenCodeReader } from '../src/harnesses/opencode/reader.js'
import { opencodeToolCalls } from '../src/harnesses/opencode/tool-calls.js'
import type { PartRow } from '../src/harnesses/opencode/db.js'
import {
  NETWORK_RE,
  auditPaths,
  auditSessionsOf,
  auditToolCalls,
  collectTurnCalls,
  heartbeatVerdict,
  isTainted,
  ownerCredentialCut,
  shellSegments,
  type AuditContext,
} from '../src/heartbeat-audit.js'
import { makeOpenCodeDb } from './helpers/opencode-db.js'

const HOME = '/home/op'
const DATA = '/home/op/.silos'
const FOLDER = '/home/op/work/acme'
const PORT = 3210

const ctx = (over: Partial<AuditContext> = {}): AuditContext => ({
  cwd: FOLDER,
  home: HOME,
  silos: { port: PORT },
  paths: auditPaths({
    folders: [FOLDER],
    home: HOME,
    dataDir: DATA,
    // an engine's configFiles, as the contract hands them (shape only)
    engineConfigFiles: (f) => [`${f}/.mcp.json`, `${f}/opencode.json`, `${f}/opencode.jsonc`, `${HOME}/.config/opencode/**`],
  }),
  ownerTokenPaths: [`${DATA}/token`],
  ...over,
})
const bash = (command: string, name = 'Bash'): ToolCallRecord => ({ name, session: 's', command })
const audit1 = (command: string, over: Partial<AuditContext> = {}) => auditToolCalls([bash(command)], ctx(over))

const BEARER = '-H "Authorization: Bearer $SILOS_AGENT_TOKEN"'

describe('NETWORK_RE', () => {
  it("is the spec's regex verbatim", () => {
    expect(NETWORK_RE.source).toBe(
      String.raw`\b(curl|wget|gog|himalaya|mutt|nc|ssh|scp|telnet|rsync|openssl|python3?|node|deno|bun|git|gh|npm|npx|pnpm|yarn|pip3?|pipx|uv|perl|ruby|php|claude|opencode)\b|https?:\/\/|\/dev\/(tcp|udp)\/`,
    )
    expect(NETWORK_RE.flags).toBe('i')
  })
})

describe('auditToolCalls — readOutside', () => {
  it('web and MCP tools of both engines, by name, once each', () => {
    const a = auditToolCalls(
      [
        { name: 'WebFetch', session: 's', outside: 'web' },
        { name: 'websearch', session: 's', outside: 'web' },
        { name: 'WebFetch', session: 's', outside: 'web' },
        { name: 'mcp__mail__search', session: 's', outside: 'mcp' },
        { name: 'mail_search', session: 's', outside: 'mcp' },
      ],
      ctx(),
    )
    expect(a).toEqual({ readOutside: ['WebFetch', 'websearch', 'mcp__mail__search', 'mcp__mail_search'] })
  })

  it('the API channel is exempt: Silos host, bearer, no owner credential', () => {
    expect(audit1(`curl -s "\${SILOS_API:-http://127.0.0.1:${PORT}}/api/agents/me/messages?state=new" ${BEARER}`)).toEqual({ readOutside: [] })
    expect(audit1(`curl -s -X POST $SILOS_API/api/proposals ${BEARER} -d '{"a":"b; c"}'`)).toEqual({ readOutside: [] })
    expect(audit1(`curl http://localhost:${PORT}/api/auth/me ${BEARER}`)).toEqual({ readOutside: [] })
  })

  it('the API without its bearer marks; another loopback port marks; an external host marks', () => {
    expect(audit1(`curl http://127.0.0.1:${PORT}/api/agents`).readOutside).toEqual(['Bash: curl'])
    expect(audit1(`curl http://127.0.0.1:8080/x ${BEARER}`).readOutside).toEqual(['Bash: curl'])
    expect(audit1(`curl http://127.0.0.1/x ${BEARER}`).readOutside).toEqual(['Bash: curl'])
    expect(audit1('curl -s https://example.com/feed').readOutside).toEqual(['Bash: curl'])
    // an exempt call does not carry a second segment that reaches out
    expect(audit1(`curl $SILOS_API/api/x ${BEARER} && curl https://example.com`).readOutside).toEqual(['Bash: curl'])
  })

  it('interpreters, remote shells, package managers, bash /dev/tcp', () => {
    expect(audit1('ssh deploy@build.example.org uptime').readOutside).toEqual(['Bash: ssh'])
    expect(audit1('python3 -c "import urllib.request as u; u.urlopen(\'http://x.example\')"').readOutside).toEqual(['Bash: python3'])
    expect(audit1('gh api repos/acme/x/issues').readOutside).toEqual(['Bash: gh'])
    expect(audit1('perl -MIO::Socket -e 1').readOutside).toEqual(['Bash: perl'])
    expect(audit1('ruby -e "puts 1"').readOutside).toEqual(['Bash: ruby'])
    expect(audit1('php -r "echo 1;"').readOutside).toEqual(['Bash: php'])
    expect(audit1('exec 3<>/dev/tcp/10.0.0.9/80; echo hi >&3').readOutside).toEqual(['Bash: /dev/tcp/'])
    expect(audit1('claude -p "find new regulations"').readOutside).toEqual(['Bash: claude'])
  })

  it('a NETWORK_RE match with no recognisable host marks (m13); a plain command does not', () => {
    expect(audit1('git fetch').readOutside).toEqual(['Bash: git'])
    expect(audit1('npm install').readOutside).toEqual(['Bash: npm'])
    expect(audit1('ls -la && wc -l plans/tasks.plan.json').readOutside).toEqual([])
  })

  it("the label keeps the engine's tool name", () => {
    expect(auditToolCalls([bash('wget https://example.com', 'bash')], ctx()).readOutside).toEqual(['bash: wget'])
  })

  it('child sessions mark `subagent` only when the context says so', () => {
    const calls: ToolCallRecord[] = [{ name: 'read', session: 'ses_child' }]
    expect(auditToolCalls(calls, ctx({ children: ['ses_child'] })).readOutside).toEqual([])
    expect(auditToolCalls(calls, ctx({ children: ['ses_child'], markChildSessions: true })).readOutside).toEqual(['subagent'])
    expect(auditToolCalls([], ctx({ children: [], markChildSessions: true })).readOutside).toEqual([])
  })
})

describe('auditToolCalls — ownerCredential (credential position only)', () => {
  it('x-token header with the token file read in place', () => {
    const cmd = `curl -H "x-token: $(cat ~/.silos/token)" http://127.0.0.1:${PORT}/api/agents`
    const a = audit1(cmd)
    expect(a.ownerCredential).toEqual([`x-token header: ${cmd}`, `owner token file: ${cmd}`])
    expect(a.readOutside).toEqual(['Bash: curl'])
    expect(ownerCredentialCut(a)).toBe("used the owner's credential in an unattended turn (x-token header)")
  })

  it('?token= inside a URL, even next to a bearer', () => {
    const a = audit1(`curl "http://127.0.0.1:${PORT}/api/agents?token=abc" ${BEARER}`)
    expect(a.ownerCredential).toHaveLength(1)
    expect(a.ownerCredential![0]).toMatch(/^\?token= in URL: /)
    expect(a.readOutside).toEqual(['Bash: curl'])
    expect(audit1(`curl "$SILOS_API/api/x?a=1&token=abc" ${BEARER}`).ownerCredential).toHaveLength(1)
  })

  it('the token file chained by pipe or by a variable', () => {
    expect(audit1(`cat ~/.silos/token | curl -H @- http://127.0.0.1:${PORT}/api/x`).ownerCredential?.[0]).toMatch(/^owner token file: /)
    expect(audit1(`T=$(cat ${DATA}/token); curl -H "x-token: $T" $SILOS_API/api/x`).ownerCredential?.map((o) => o.split(':')[0])).toEqual([
      'x-token header',
      'owner token file',
    ])
  })

  it('the same vocabulary outside credential position is NOT a use', () => {
    expect(audit1('grep -rn "x-token" server/')).toEqual({ readOutside: [] })
    expect(audit1('grep -n "?token=" docs/deploy/railway-template.md')).toEqual({ readOutside: [] })
    expect(audit1('cat ~/.silos/token; echo done').ownerCredential).toBeUndefined()
    // a network command that only NAMES it, not as a header nor a URL param
    expect(audit1('git grep "x-token"').ownerCredential).toBeUndefined()
    expect(audit1(`curl http://localhost:${PORT}/api/auth/me ${BEARER}`).ownerCredential).toBeUndefined()
  })
})

describe('auditToolCalls — memoryEdited / configEdited', () => {
  it('file tools by path', () => {
    const a = auditToolCalls(
      [
        { name: 'Write', session: 's', writes: [`${FOLDER}/CLAUDE.md`] },
        { name: 'edit', session: 's', writes: ['AGENTS.md'] },
        { name: 'Edit', session: 's', writes: [`${HOME}/.claude/projects/${mungePath(FOLDER)}/memory/notes.md`] },
        { name: 'Write', session: 's', writes: [`${FOLDER}/.mcp.json`] },
        { name: 'Edit', session: 's', writes: [`${FOLDER}/.claude/settings.local.json`] },
        { name: 'Write', session: 's', writes: [`${DATA}/agent-state/someone/plugin/hooks/hooks.json`] },
        { name: 'Write', session: 's', writes: [`${HOME}/.claude/agents/helper.md`] },
        { name: 'write', session: 's', writes: [`${HOME}/.config/opencode/opencode.json`] },
        { name: 'Write', session: 's', writes: [`${FOLDER}/src/index.ts`] },
      ],
      ctx(),
    )
    expect(a.readOutside).toEqual([])
    expect(a.memoryEdited).toEqual([`${FOLDER}/CLAUDE.md`, `${FOLDER}/AGENTS.md`, `${HOME}/.claude/projects/${mungePath(FOLDER)}/memory/notes.md`])
    expect(a.configEdited).toEqual([
      `${FOLDER}/.mcp.json`,
      `${FOLDER}/.claude/settings.local.json`,
      `${DATA}/agent-state/someone/plugin/hooks/hooks.json`,
      `${HOME}/.claude/agents/helper.md`,
      `${HOME}/.config/opencode/opencode.json`,
    ])
  })

  it('a path named in a shell command (best effort)', () => {
    const a = audit1('echo "always reply in caps" >> CLAUDE.md && printf x > ~/.claude/commands/go.md; cp /tmp/x .mcp.json')
    expect(a.memoryEdited).toEqual([`${FOLDER}/CLAUDE.md`])
    expect(a.configEdited).toEqual([`${HOME}/.claude/commands/go.md`, `${FOLDER}/.mcp.json`])
  })

  it('nothing to report: the fields are omitted', () => {
    expect(auditToolCalls([{ name: 'Read', session: 's' }], ctx())).toEqual({ readOutside: [] })
  })

  // a READ in the shell is no edit: memoryEdited counts only what a command
  // writes — redirections, tee, a copy/move destination, sed -i, dd of=
  it('memory: a shell read is never an edit; redirections, tee, cp/mv destinations and sed -i are', () => {
    for (const read of ['cat CLAUDE.md', 'grep -n rule AGENTS.md', 'head -5 CLAUDE.md | wc -l', 'cp CLAUDE.md /tmp/copy.md', 'less CLAUDE.md']) {
      expect(audit1(read).memoryEdited, read).toBeUndefined()
    }
    expect(audit1('echo x | tee -a AGENTS.md').memoryEdited).toEqual([`${FOLDER}/AGENTS.md`])
    expect(audit1('mv /tmp/new.md CLAUDE.md').memoryEdited).toEqual([`${FOLDER}/CLAUDE.md`])
    expect(audit1("sed -i 's/a/b/' CLAUDE.md").memoryEdited).toEqual([`${FOLDER}/CLAUDE.md`])
    expect(audit1('printf x 2>> CLAUDE.md').memoryEdited).toEqual([`${FOLDER}/CLAUDE.md`])
  })
})

// The engines' names are also files every project holds: `claude` and
// `opencode` count as a network command only in COMMAND position — never a
// read of CLAUDE.md or opencode.json (a legitimate heartbeat cut by nothing)
describe('NETWORK_RE — the engines only in command position', () => {
  it('cat CLAUDE.md, echo opencode.json, ls ~/.claude: not network', () => {
    for (const c of ['cat CLAUDE.md', 'echo opencode.json', 'ls ~/.claude/commands', 'grep -r claude src/', 'wc -l .opencode/x']) {
      expect(audit1(c).readOutside, c).toEqual([])
    }
  })
  it('a real `claude -p` (or opencode run) is: at the start, after a separator, inside $( ) or backticks, through a path or env', () => {
    for (const c of [
      'claude -p "find new tax law"',
      'cd x && claude -p hi',
      'echo hi | opencode run "x"',
      'out=$(claude -p "x")',
      'r=`opencode run x`',
      '/usr/local/bin/claude -p x',
      'FOO=1 claude -p x',
      'timeout 60 claude -p x',
    ]) {
      expect(audit1(c).readOutside, c).toHaveLength(1)
    }
    expect(audit1('claude -p "x"').readOutside).toEqual(['Bash: claude'])
  })
})

describe('shellSegments', () => {
  it('splits on unquoted separators only, and records pipes', () => {
    expect(shellSegments(`a 'x;y' | b "p && q" && c $(d; e) ; f`)).toEqual([
      { text: `a 'x;y'`, pipesInto: true },
      { text: 'b "p && q"', pipesInto: false },
      { text: 'c $(d; e)', pipesInto: false },
      { text: 'f', pipesInto: false },
    ])
  })
})

describe('verdicts', () => {
  const gapsOff = { mcp: false, childSessions: false }
  it('tainted = non-empty readOutside; cut only with creations or proposals', () => {
    expect(isTainted({ readOutside: [] })).toBe(false)
    expect(isTainted(undefined)).toBe(false)
    expect(heartbeatVerdict({ readOutside: ['WebFetch'] }, { createdOrProposed: false, gaps: gapsOff })).toEqual({
      tainted: true,
      undo: true,
      cut: false,
      why: null,
    })
    expect(heartbeatVerdict({ readOutside: ['WebFetch'] }, { createdOrProposed: true, gaps: gapsOff })).toEqual({
      tainted: true,
      undo: true,
      cut: true,
      why: 'created work after reading outside (WebFetch)',
    })
  })

  it('an engine gap (MCP / subagent) undoes but never cuts; anything else beside it still cuts', () => {
    const gaps = { mcp: true, childSessions: true }
    expect(heartbeatVerdict({ readOutside: ['mcp__mail_search', 'subagent'] }, { createdOrProposed: true, gaps })).toMatchObject({ undo: true, cut: false })
    expect(heartbeatVerdict({ readOutside: ['mcp__mail_search', 'bash: curl'] }, { createdOrProposed: true, gaps })).toMatchObject({ undo: true, cut: true })
    expect(heartbeatVerdict({ readOutside: ['mcp__mail_search'] }, { createdOrProposed: true, gaps: gapsOff })).toMatchObject({ cut: true })
  })

  it('an unreadable transcript fails closed: `transcript unreadable` taints the run, with no tool call at all', () => {
    const audit = auditToolCalls([], ctx({ unread: ['nested-1'] }))
    expect(audit.readOutside).toEqual(['transcript unreadable'])
    expect(isTainted(audit)).toBe(true)
    expect(auditToolCalls([], ctx({ unread: [] })).readOutside).toEqual([])
  })

  it('no owner credential, no cut', () => {
    expect(ownerCredentialCut({ readOutside: ['Bash: curl'] })).toBeNull()
  })
})

// ── engines + loader ────────────────────────────────────────────────────

describe('engine tool calls', () => {
  it('Claude transcript lines: web, MCP, Bash, file tools, server tools', () => {
    const line = (content: unknown[], ts = '2026-11-10T09:00:00.000Z') =>
      JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content } })
    const calls = claudeToolCallsOfLines(
      [
        line([
          { type: 'text', text: 'hi' },
          { type: 'tool_use', id: 't1', name: 'WebFetch', input: { url: 'https://x' } },
        ]),
        line([
          { type: 'tool_use', id: 't2', name: 'mcp__mail__read', input: {} },
          { type: 'server_tool_use', id: 't3', name: 'web_search', input: {} },
        ]),
        line([
          { type: 'tool_use', id: 't4', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool_use', id: 't5', name: 'NotebookEdit', input: { notebook_path: '/a.ipynb' } },
        ]),
        JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } }),
        'not json tool_use',
      ],
      'sess',
    )
    expect(calls).toEqual([
      { name: 'WebFetch', session: 'sess', at: Date.parse('2026-11-10T09:00:00.000Z'), outside: 'web' },
      expect.objectContaining({ name: 'mcp__mail__read', outside: 'mcp' }),
      expect.objectContaining({ name: 'web_search', outside: 'web' }),
      expect.objectContaining({ name: 'Bash', command: 'ls' }),
      expect.objectContaining({ name: 'NotebookEdit', writes: ['/a.ipynb'] }),
    ])
  })

  it("OpenCode parts: web tools, MCP tools by OpenCode's naming, bash, write/edit/patch", () => {
    const part = (tool: string, input: unknown, i: number): PartRow => ({
      id: `prt_${i}`,
      message_id: 'msg_1',
      session_id: 'ses_a',
      time_created: 1000 + i,
      data: { type: 'tool', tool, callID: `c${i}`, state: { status: 'completed', input } },
    })
    const calls = opencodeToolCalls(
      [
        part('webfetch', { url: 'https://x' }, 1),
        part('websearch', { query: 'q' }, 2),
        part('mail_search', {}, 3),
        part('apply_patch', { patchText: '*** Begin Patch\n*** Update File: AGENTS.md\n@@\n-a\n+b\n*** End Patch' }, 4),
        part('bash', { command: 'gh pr list' }, 5),
        part('write', { filePath: '/w/x.ts' }, 6),
        part('read', { filePath: '/w/y.ts' }, 7),
      ],
      'ses_a',
    )
    expect(calls.map((c) => [c.name, c.outside ?? c.command ?? c.writes ?? null])).toEqual([
      ['webfetch', 'web'],
      ['websearch', 'web'],
      ['mail_search', 'mcp'],
      ['apply_patch', ['AGENTS.md']],
      ['bash', 'gh pr list'],
      ['write', ['/w/x.ts']],
      ['read', null],
    ])
  })
})

describe('collectTurnCalls — session, children, nested sessions', () => {
  let base: string, projects: string, dataDir: string
  const AGENT = 'ops'
  const MAIN = '11111111-1111-4111-8111-111111111111'
  const NESTED = '22222222-2222-4222-8222-222222222222'
  const STRAY = '33333333-3333-4333-8333-333333333333'
  const work = '/srv/acme'
  const line = (name: string, input: unknown, ts = '2026-11-10T09:00:00.000Z') =>
    JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id: name, name, input }] } })
  const transcript = (id: string, lines: string[]): void => {
    mkdirSync(join(projects, mungePath(work)), { recursive: true })
    writeFileSync(join(projects, mungePath(work), `${id}.jsonl`), lines.join('\n') + '\n')
  }
  const marker = (agent: string, id: string, parent: string | null): void => {
    const dir = join(dataDir, 'agent-state', agent, 'births')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ sessionId: id, agentId: agent, parent, cwd: work, source: 'startup', at: '2026-11-10T09:00:00Z' }))
  }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'heartbeat-audit-'))
    projects = join(base, 'projects')
    dataDir = join(base, 'data')
    mkdirSync(projects, { recursive: true })
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  const births = () => new BirthsStore(new AgentStateStore(join(dataDir, 'agent-state')), { ttlMs: 0 })

  it('Claude: subagent transcripts and a nested `claude -p` linked by its birth marker', async () => {
    transcript(MAIN, [line('Bash', { command: 'claude -p "summarise the inbox"' }), line('Agent', { prompt: 'look' })])
    const subDir = join(projects, mungePath(work), MAIN, 'subagents')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(join(subDir, 'agent-a1.jsonl'), line('WebSearch', { query: 'q' }) + '\n')
    transcript(NESTED, [line('WebFetch', { url: 'https://example.com' })])
    marker(AGENT, NESTED, MAIN)
    // a marker of another agent naming the same parent is not this turn's
    transcript(STRAY, [line('mcp__x__y', {})])
    marker('other', STRAY, MAIN)

    const index = claudeSessionIndex(projects, join(base, 'cache.json'))
    const turn = await collectTurnCalls({ folder: mungePath(work), sessionId: MAIN, agentId: AGENT }, { sessions: auditSessionsOf(index), births: births() })
    expect(turn.children).toEqual(['agent-a1'])
    expect(turn.nested).toEqual([NESTED])
    expect(turn.unread).toEqual([])
    expect(turn.calls.map((c) => `${c.session}:${c.name}`)).toEqual([`${MAIN}:Bash`, `${MAIN}:Agent`, 'agent-a1:WebSearch', `${NESTED}:WebFetch`])
    const a = auditToolCalls(turn.calls, { ...ctx({ cwd: work, children: turn.children }) })
    expect(a.readOutside).toEqual(['Bash: claude', 'WebSearch', 'WebFetch'])
  })

  it('`since` leaves out calls and births before the run started', async () => {
    transcript(MAIN, [line('WebFetch', {}, '2026-11-01T09:00:00.000Z'), line('Bash', { command: 'ls' }, '2026-11-10T09:00:00.000Z')])
    marker(AGENT, NESTED, MAIN)
    transcript(NESTED, [line('WebFetch', {})])
    const index = claudeSessionIndex(projects, join(base, 'cache.json'))
    const deps = { sessions: auditSessionsOf(index), births: births() }
    const ref = { folder: mungePath(work), sessionId: MAIN, agentId: AGENT }
    const resumed = await collectTurnCalls({ ...ref, since: Date.parse('2026-11-05T00:00:00.000Z') }, deps)
    expect(resumed.calls.map((c) => `${c.session}:${c.name}`)).toEqual([`${MAIN}:Bash`, `${NESTED}:WebFetch`])
    const later = await collectTurnCalls({ ...ref, since: Date.now() + 60_000 }, deps)
    expect(later.calls).toEqual([])
    expect(later.nested).toEqual([])
  })

  it('an unknown session is reported unread, never as clean calls', async () => {
    const index = claudeSessionIndex(projects, join(base, 'cache.json'))
    const turn = await collectTurnCalls({ folder: mungePath(work), sessionId: MAIN }, { sessions: auditSessionsOf(index), births: births() })
    expect(turn).toEqual({ calls: [], children: [], nested: [], unread: [MAIN] })
  })

  describe('OpenCode', () => {
    let db: ReturnType<typeof makeOpenCodeDb>
    let reader: OpenCodeReader
    const T0 = 1_780_000_000_000
    const sess = (id: string, parent: string | null) => ({
      id,
      project_id: 'p1',
      parent_id: parent,
      directory: work,
      title: id,
      version: '1.19.4',
      time_created: T0,
      time_updated: T0 + 1,
    })
    const msg = (id: string, session: string, agent = 'build') => ({
      id,
      session_id: session,
      time_created: T0 + 1,
      data: { role: 'user', agent, time: { created: T0 + 1 } },
    })
    const tool = (id: string, session: string, name: string, input: unknown) => ({
      id,
      message_id: `m_${session}`,
      session_id: session,
      time_created: T0 + 2,
      data: { type: 'tool', tool: name, callID: id, state: { status: 'completed', input } },
    })

    beforeEach(async () => {
      mkdirSync(join(dataDir, 'agents', AGENT), { recursive: true })
      writeFileSync(join(dataDir, 'agents.json'), JSON.stringify({ agents: [{ id: AGENT, name: 'Ops', folder: work, framework: 'opencode' }] }))
      const registry = new AgentRegistry(join(dataDir, 'agents.json'))
      registry.load()
      db = makeOpenCodeDb(join(dataDir, 'agents', AGENT))
      db.insertSession(sess('ses_main', null))
      db.insertMessage(msg('m_ses_main', 'ses_main'))
      db.insertPart(tool('p1', 'ses_main', 'task', { prompt: 'look around' }))
      db.insertPart(tool('p2', 'ses_main', 'bash', { command: `curl $SILOS_API/api/agents/${AGENT}/messages ${BEARER}` }))
      db.insertSession(sess('ses_child', 'ses_main'))
      db.insertMessage(msg('m_ses_child', 'ses_child', 'general'))
      db.insertPart(tool('p3', 'ses_child', 'webfetch', { url: 'https://example.com' }))
      db.insertSession(sess('ses_grandchild', 'ses_child'))
      db.insertMessage(msg('m_ses_grandchild', 'ses_grandchild', 'explore'))
      db.insertPart(tool('p4', 'ses_grandchild', 'mail_search', {}))
      db.insertSession(sess('ses_nested', null))
      db.insertMessage(msg('m_ses_nested', 'ses_nested'))
      db.insertPart(tool('p5', 'ses_nested', 'websearch', { query: 'q' }))
      reader = new OpenCodeReader({ dataDir, registry, globalDb: null, muted: [], ephemeralPrefix: null })
      await reader.init()
    })
    afterEach(() => {
      reader.close()
      db.close()
    })

    it('child sessions by parent_id at any depth, and an `opencode run` nested by its marker', async () => {
      marker(AGENT, 'ses_nested', 'ses_main')
      const index = claudeSessionIndex(projects, join(base, 'cache.json'))
      index.addReader(reader)
      const turn = await collectTurnCalls(
        { folder: mungePath(work), sessionId: 'ses_main', agentId: AGENT },
        { sessions: auditSessionsOf(index), births: births() },
      )
      expect(turn.children).toEqual(['ses_child', 'ses_grandchild'])
      expect(turn.nested).toEqual(['ses_nested'])
      expect(turn.calls.map((c) => `${c.session}:${c.name}`)).toEqual([
        'ses_main:task',
        'ses_main:bash',
        'ses_child:webfetch',
        'ses_grandchild:mail_search',
        'ses_nested:websearch',
      ])
      const plain = auditToolCalls(turn.calls, ctx({ cwd: work, children: turn.children }))
      expect(plain.readOutside).toEqual(['webfetch', 'mcp__mail_search', 'websearch'])
      // an OpenCode heartbeat while the `task` deny is unverified: the children mark too
      const hb = auditToolCalls(turn.calls, ctx({ cwd: work, children: turn.children, markChildSessions: true }))
      expect(hb.readOutside).toEqual(['webfetch', 'mcp__mail_search', 'websearch', 'subagent'])
    })
  })
})
