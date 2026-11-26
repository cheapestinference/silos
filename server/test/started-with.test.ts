// started-with.test.ts — what a conversation started with and carries now,
// measured from its own transcript.
//
// GOLDEN fixtures (test/fixtures/started-with/) are real transcript heads cut
// at the first measured reply and REDACTED: every text payload replaced by
// 'x' of the same length (json-escaped length where the measure serialises),
// markers and structure kept, home paths → /home/user, emails → fakes of the
// same length. The reference implementation gives the same numbers on
// the redacted fixture as on the original transcript (checked when cut).
// Installation names were then neutralised (folder → /home/user/acme, the
// accounting connector → ledgerly, business skill/branch names → generic):
// that moved a few hundred chars between owners, so the per-owner numbers
// below and the reference's are shifted by those same deltas.
// silos-console-long.jsonl.gz is a whole conversation (several days long) slimmed
// to the records the measure reads.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { claudeLoadsInventory } from '../src/harnesses/claude-code/loads/inventory.js'
import { readStartedWith, splitSystem, startedWith, hookName, pyDumps, cpLen } from '../src/harnesses/claude-code/started-with.js'
import { ASK_DECISIONS_NOTE } from '../src/chat-service.js'
// the automations note appends carried until 26-11 — old transcripts keep it
const OLD_AUTOMATIONS_NOTE = 'Scheduled or recurring work goes through Silos automations, never CronCreate: a Silos automation has owner-visible state.'
import { RUN_OUTCOME_INSTRUCTION } from '../src/run-outcome.js'
import { readInstructionsRecord } from '../src/harnesses/claude-code/instructions-record.js'
import type { LoadsReading, LoadsRow, StartedWith, StartedWithContext, StartedWithOwner } from '../src/harnesses/contract.js'

const F = join(import.meta.dirname, 'fixtures', 'started-with')
const fixture = (name: string): string[] =>
  (name.endsWith('.gz') ? gunzipSync(readFileSync(join(F, name))).toString('utf8') : readFileSync(join(F, name), 'utf8')).split('\n')
const ctxOf = (name: string): StartedWithContext => JSON.parse(readFileSync(join(F, `${name}.ctx.json`), 'utf8')) as StartedWithContext

const byOwner = (s: StartedWith, parts = s.parts): Partial<Record<StartedWithOwner, number>> => {
  const out: Partial<Record<StartedWithOwner, number>> = {}
  for (const p of parts) out[p.owner] = (out[p.owner] ?? 0) + p.tokens
  return out
}
const sum = (s: StartedWith): number => s.parts.reduce((a, p) => a + p.tokens, 0)

/** The reference's owners, for parity: it filed the subagent listing whole
 *  under engine and knew no `account` MCP server outside claude.ai (both
 *  rules were refined after it ran). */
function asReference(s: StartedWith): Partial<Record<StartedWithOwner, number>> {
  const out = byOwner(s)
  for (const p of s.parts) {
    if (p.kind === 'agents' && p.owner === 'you') {
      out.you! -= p.tokens
      out.engine = (out.engine ?? 0) + p.tokens
    }
    if (p.kind === 'mcp' && p.owner === 'account' && !p.ref!.startsWith('mcp-claude_ai_')) {
      out.account! -= p.tokens
      out.project = (out.project ?? 0) + p.tokens
    }
  }
  return out
}
const near = (got: Partial<Record<StartedWithOwner, number>>, want: Partial<Record<StartedWithOwner, number>>, tol: number): void => {
  for (const [o, n] of Object.entries(want))
    expect(Math.abs((got[o as StartedWithOwner] ?? 0) - n), `${o}: ${got[o as StartedWithOwner]} vs ${n}`).toBeLessThanOrEqual(tol)
  expect(
    Object.keys(got)
      .filter((o) => (got[o as StartedWithOwner] ?? 0) !== 0)
      .sort(),
  ).toEqual(Object.keys(want).sort())
}

describe('golden — real transcript heads (redacted)', () => {
  it('Builder console after /clear (ed8071c5): 88,094 tokens', () => {
    const s = startedWith(fixture('builder-console-clear.jsonl'), ctxOf('builder'))
    expect(s.measured).toBe(true)
    expect(s.mode).toBe('console')
    expect(s.totalTokens).toBe(88094)
    expect(sum(s)).toBe(88094)
    // the servers' instruction blocks (mcp_instructions_delta, three claude.ai
    // connectors' — 3,785 characters) are counted under their server: the
    // total is unchanged, the account's share grows by theirs
    expect(byOwner(s)).toEqual({ engine: 36092, silos: 3256, project: 24742, you: 16766, account: 7225, conversation: 13 })
    // without those records: this port's owners as they were (subagent
    // plugin types → you; railway + notion — ~/.claude.json projects[folder]
    // — the project's, login-bound; the rounding remainder rides engine)…
    const without = startedWith(
      fixture('builder-console-clear.jsonl').filter((l) => !l.includes('"mcp_instructions_delta"')),
      ctxOf('builder'),
    )
    expect(without.totalTokens).toBe(88094)
    expect(byOwner(without)).toEqual({ engine: 36736, silos: 3314, project: 25184, you: 17065, account: 5781, conversation: 14 })
    // …and the reference's numbers, its two coarser rules re-applied (it
    // never counted server instructions): ±2, the rounding remainder
    // landing on a different owner, plus the shift
    near(asReference(without), { project: 25184, silos: 3314, you: 16222, account: 5781, engine: 37578, conversation: 14 }, 2)
    // the instructions join their server's part, under its exact name
    expect(s.loadedNames).toEqual(expect.arrayContaining(['claude.ai Claude Docs', 'claude.ai Notion', 'claude.ai etherscan']))
    expect(part(s, 'mcp-claude_ai_Notion')).toMatchObject({ owner: 'account', label: 'Notion' })
    expect(part(s, 'mcp-claude_ai_Notion')!.chars).toBeGreaterThan(part(without, 'mcp-claude_ai_Notion')!.chars)
    // the first message is the one after /clear, not the command record
    expect(s.parts.find((p) => p.kind === 'first')).toMatchObject({ owner: 'conversation', chars: 33 })
    expect(s.failedMcpServers.map((f) => f.name)).toEqual(['plugin:product-management:similarweb'])
    expect(s.accounts).toEqual([{ email: 'owner-one@example.test', at: '2026-10-30T19:25:26.662Z' }])
  })

  it('Finance chat on SDK 2.1.304 (36cdf5d2): 65,091 tokens, the charter → agent', () => {
    const s = startedWith(fixture('finance-sdk.jsonl'), ctxOf('finance'))
    expect(s.mode).toBe('chat')
    expect(s.totalTokens).toBe(65091)
    expect(sum(s)).toBe(65091)
    expect(byOwner(s)).toEqual({ engine: 17372, agent: 68, silos: 5179, project: 25726, you: 16172, conversation: 574 })
    // the reference's per-owner roundings add up to 65,093 (2 over the
    // total); the remainder goes back to the owner of the largest part
    // (project), hence ±2 here
    near(asReference(s), { project: 25727, agent: 68, silos: 5179, you: 15314, engine: 18231, conversation: 574 }, 2)
    expect(s.parts.find((p) => p.ref === 'system-charter')).toMatchObject({ owner: 'agent', chars: 160 })
    // the [silos-context] prelude is Silos', the rest the conversation's
    expect(s.parts.find((p) => p.kind === 'prelude')).toMatchObject({ owner: 'silos' })
    expect(s.parts.find((p) => p.kind === 'first')).toMatchObject({ owner: 'conversation', chars: 1352 })
    // claude.ai connectors still connecting at the first turn: said, not counted
    expect(s.pendingMcp).toBe(6)
    expect(s.pendingMcpServers).toContain('claude.ai Gmail')
  })

  it('SDK 2.1.276 without api-request-shape (titler): measured from prompt_snapshot', () => {
    const s = startedWith(fixture('titler-sdk.jsonl'), ctxOf('titler'))
    expect(s.measured).toBe(true)
    expect(s.totalTokens).toBe(15118)
    expect(sum(s)).toBe(15118)
    expect(s.parts.some((p) => p.kind === 'tools')).toBe(false)
    expect(s.parts.find((p) => p.ref === 'system-engine')).toMatchObject({ owner: 'engine', chars: 92 })
    // an empty catalog: every listed bare skill is flagged
    expect(s.parts.find((p) => p.kind === 'skills')).toMatchObject({ owner: 'you', stale: true })
  })

  it('a worktree: instruction files owned by their type, never by cwd', () => {
    const s = startedWith(fixture('worktree-console.jsonl'), ctxOf('builder'))
    expect(s.totalTokens).toBe(104221)
    expect(sum(s)).toBe(104221)
    const files = s.parts.filter((p) => p.kind === 'instructions' || p.kind === 'memory-index')
    expect(files.some((p) => p.label.includes('/.claude/worktrees/'))).toBe(true)
    expect(files.every((p) => p.owner === 'project')).toBe(true)
  })

  it('a start hook whose output was too large: the stub is counted and flagged', () => {
    const r = readStartedWith(fixture('finance-console-persisted-hook.jsonl'), ctxOf('finance'))
    const hook = r.summary.parts.find((p) => p.truncated)!
    expect(hook).toMatchObject({ owner: 'you', kind: 'hook', label: 'claude-mem', truncated: { size: '10.1KB' } })
    expect(hook.truncated!.savedTo.startsWith('/home/user/')).toBe(true)
    // its injected context and the stub, both what reached the model
    expect(r.texts[hook.ref!]).toContain('<persisted-output>')
    expect(hook.chars).toBe(cpLen(r.texts[hook.ref!]!) - 2)
    expect(sum(r.summary)).toBe(81344)
  })

  it('a conversation that runs for days (4c440473): first non-zero turn, accounts, now', () => {
    const r = readStartedWith(fixture('silos-console-long.jsonl.gz'), ctxOf('silos'))
    const s = r.summary
    // the first reply reported 0 (a limit message): skipped
    expect(s.totalTokens).toBe(85898)
    expect(s.at).toBe('2026-10-27T17:26:53.700Z')
    expect(sum(s)).toBe(85898)
    expect(s.accounts).toEqual([
      { email: 'owner-one@example.test', at: '2026-10-27T17:26:43.877Z' },
      { email: 'owner-second@example.com', at: '2026-10-30T19:23:50.184Z' },
      { email: 'owner-one@example.test', at: '2026-11-02T15:09:27.691Z' },
    ])
    expect(s.contextNow).toEqual({ tokens: 497288, at: '2026-11-02T18:40:19.362Z' })
    expect(s.now).not.toBeNull()
    expect(s.now!.approx).toBe(true)
    const startChars = s.parts.reduce((a, p) => a + p.chars, 0)
    expect(s.now!.ratio).toBeCloseTo(startChars / 85898, 10)
    for (const p of s.now!.parts) {
      expect(p.ref!.startsWith('now-')).toBe(true)
      expect(p.tokens).toBe(Math.round(p.chars / s.now!.ratio))
      expect(r.texts[p.ref!]).toBeDefined()
    }
    // instructions now = the latest record (the project CLAUDE.md grew)
    const startClaude = s.parts.find((p) => p.kind === 'instructions')!
    const nowClaude = s.now!.parts.find((p) => p.kind === 'instructions')!
    expect(nowClaude.chars).toBeGreaterThan(startClaude.chars)
    expect(s.now!.tools).toBeGreaterThan(0)
  })
})

// ── unit rules over synthetic transcripts ────────────────────────────────
const L = (o: unknown): string => JSON.stringify(o)
const CTX: StartedWithContext = {
  charter: null,
  loaded: null,
  catalog: [],
  silosPluginDir: '/opt/silos/plugin',
  projectDir: '/w/proj',
}
const att = (attachment: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  L({ type: 'attachment', entrypoint: 'cli', attachment, ...extra })
const shape = (system: string[] = ['ENGINE'], tools: unknown[] = []): string =>
  L({ type: 'api-request-shape', shape: { system: system.map((text) => ({ type: 'text', text })), tools } })
const reply = (n: number, at = '2026-11-01T10:00:00.000Z'): string =>
  L({ type: 'assistant', timestamp: at, message: { usage: { input_tokens: 1, cache_creation_input_tokens: n - 1, cache_read_input_tokens: 0 } } })
const user = (content: unknown, extra: Record<string, unknown> = {}): string => L({ type: 'user', message: { role: 'user', content }, ...extra })
const part = (s: StartedWith, ref: string) => s.parts.find((p) => p.ref === ref)

describe('the system prompt split', () => {
  it('engine before the cut; charter → agent; # Agent memory → agent; the rest → silos', () => {
    const text = `ENGINE PART\nCharter line one\nmore charter\n# You are running inside Silos\nbriefing\n# Agent memory\nnotes\n${OLD_AUTOMATIONS_NOTE}\n${ASK_DECISIONS_NOTE}`
    const segs = splitSystem(text, 'Charter line one\nmore charter')
    expect(segs.map((x) => [x.owner, x.sub])).toEqual([
      ['engine', 'engine'],
      ['agent', 'charter'],
      ['silos', 'silos'],
      ['agent', 'agent-memory'],
      ['silos', 'silos'],
    ])
    expect(segs.map((x) => x.text).join('')).toBe(text)
    expect(segs[1]!.text).toBe('Charter line one\nmore charter\n')
    expect(segs[3]!.text).toBe('# Agent memory\nnotes\n')
  })
  it('the platform notes alone start Silos’ append; no marker → all engine', () => {
    expect(splitSystem(`abc${ASK_DECISIONS_NOTE}`, null).map((x) => x.owner)).toEqual(['engine', 'silos'])
    expect(splitSystem(`abc${OLD_AUTOMATIONS_NOTE}`, null).map((x) => x.owner)).toEqual(['engine', 'silos'])
    expect(splitSystem('only Claude Code', 'not here')).toEqual([{ owner: 'engine', sub: 'engine', text: 'only Claude Code' }])
  })
})

describe('owners by rule', () => {
  it('instructions: Project / AutoMem → project, User → you', () => {
    const s = startedWith(
      [
        att({
          type: 'instructions',
          files: [
            { path: '/w/proj/CLAUDE.md', type: 'Project', content: 'aaaa' },
            { path: '/m/MEMORY.md', type: 'AutoMem', content: 'bb' },
            { path: '/h/.claude/CLAUDE.md', type: 'User', content: 'c' },
          ],
        }),
        shape(),
        reply(100),
      ],
      CTX,
    )
    expect(s.parts.filter((p) => p.ref!.startsWith('file-')).map((p) => [p.owner, p.kind, p.chars])).toEqual([
      ['project', 'instructions', 4],
      ['project', 'memory-index', 2],
      ['you', 'instructions', 1],
    ])
  })

  it('skills: catalog project → project; user/plugin → you; an unknown bare name → you + stale; a plugin skill is never flagged', () => {
    const content = '- mine: x\n- personal: y\n- gone: z\n- superpowers:brainstorming: w\ncontinuation line'
    const s = startedWith([att({ type: 'skill_listing', content, names: ['mine', 'personal', 'gone', 'superpowers:brainstorming'] }), shape(), reply(100)], {
      ...CTX,
      catalog: [
        { name: 'mine', source: 'project' },
        { name: 'personal', source: 'user' },
      ],
    })
    expect(part(s, 'skills-project')).toMatchObject({ owner: 'project', chars: '- mine: x'.length + 1 })
    expect(part(s, 'skills-you')).toMatchObject({ owner: 'you', chars: '- personal: y'.length + 1 })
    // a plugin's skill lines are their plugin's own part
    expect(part(s, 'skills-plugin-superpowers')).toMatchObject({ owner: 'you', group: 'superpowers', chars: '- superpowers:brainstorming: w'.length + 1 })
    expect(part(s, 'skills-plugin-superpowers')!.stale).toBeUndefined()
    expect(part(s, 'skills-stale')).toMatchObject({ owner: 'you', stale: true, chars: '- gone: z'.length + 1 })
  })

  it('skills the Claude account sends are the account’s — prefixed or bare — never a plugin and never «no longer installed»; a personal namesake stays yours', () => {
    const content = '- acct-prefix:brief: x\n- shared: y\n- acct-prefix:shared: z\n- notes: w'
    const s = startedWith(
      [att({ type: 'skill_listing', content, names: ['acct-prefix:brief', 'shared', 'acct-prefix:shared', 'notes'] }), shape(), reply(100)],
      {
        ...CTX,
        catalog: [
          { name: 'shared', source: 'user' },
          { name: 'brief', source: 'account' },
          { name: 'shared', source: 'account' },
          { name: 'notes', source: 'account' },
        ],
      },
    )
    expect(part(s, 'skills-account')).toMatchObject({ owner: 'account', chars: '- acct-prefix:brief: x\n- acct-prefix:shared: z\n- notes: w\n'.length })
    expect(part(s, 'skills-you')).toMatchObject({ owner: 'you', chars: '- shared: y'.length + 1 })
    expect(part(s, 'skills-stale')).toBeUndefined()
    expect(s.parts.some((p) => p.ref?.startsWith('skills-plugin-'))).toBe(false)
  })

  it('subagent listing: built-in types → engine, plugin types → you, sized as json.dumps of the whole list', () => {
    const lines = ['- Explore: find', '- feature-dev:code-architect: designs']
    const s = startedWith(
      [
        att({ type: 'agent_listing_delta', addedLines: lines, addedTypes: ['Explore', 'feature-dev:code-architect'], builtInTypes: ['Explore'] }),
        shape(),
        reply(100),
      ],
      CTX,
    )
    expect(part(s, 'agents-engine')!.chars + part(s, 'agents-plugin-feature-dev')!.chars).toBe(pyDumps(lines).length)
    expect(part(s, 'agents-plugin-feature-dev')).toMatchObject({ owner: 'you', group: 'feature-dev' })
  })

  it('MCP: an id is resolved against the known names, never cut apart; built-in deferred names → engine', () => {
    const names = [
      'WebFetch',
      'mcp__claude_ai_Gmail__send',
      'mcp__plugin_stripe_stripe__pay',
      'mcp__google_calendar__list',
      'mcp__railway__deploy',
      'mcp__mine__x',
      'mcp__orphan__y',
    ]
    const s = startedWith(
      [
        att({
          type: 'deferred_tools_delta',
          addedNames: names,
          pendingMcpServers: ['claude.ai Notion'],
          failedMcpServers: [{ name: 'plugin:x:y', error: 'boom' }],
        }),
        shape(
          ['E'],
          [
            { name: 'mcp__mine__z', description: 'd' },
            { name: 'Read', description: 'r' },
          ],
        ),
        reply(100),
      ],
      {
        ...CTX,
        loaded: {
          injections: [],
          mcp: [
            { name: 'google calendar', source: 'project', from: '.mcp.json' },
            { name: 'railway', source: 'project', from: '~/.claude.json' },
            { name: 'mine', source: 'user', from: '~/.claude.json' },
            { name: 'orphan', source: 'plugin', from: 'p' },
          ],
        },
      },
    )
    expect(part(s, 'deferred')).toMatchObject({ owner: 'engine', chars: 'WebFetch'.length + 1 })
    // no known name has these ids: the id stays the label (a connector's id is the account's by structure)
    expect(part(s, 'mcp-claude_ai_Gmail')).toMatchObject({ owner: 'account', label: 'claude_ai_Gmail' })
    expect(part(s, 'mcp-plugin_stripe_stripe')).toMatchObject({ owner: 'you', label: 'plugin_stripe_stripe', unsourced: true })
    expect(part(s, 'mcp-google_calendar')).toMatchObject({ owner: 'project' })
    expect(part(s, 'mcp-railway')).toMatchObject({ owner: 'project', loginBound: true })
    // a user server: its deferred name and its surfaced definition, one row
    expect(part(s, 'mcp-mine')).toMatchObject({ owner: 'you', chars: 'mcp__mine__x'.length + 1 + pyDumps({ name: 'mcp__mine__z', description: 'd' }).length })
    // a plugin's same-named server never names a bare one
    expect(part(s, 'mcp-orphan')).toMatchObject({ owner: 'you', unsourced: true })
    expect(part(s, 'tools')).toMatchObject({ owner: 'engine' })
    expect(s.pendingMcp).toBe(1)
    expect(s.failedMcpServers).toEqual([{ name: 'plugin:x:y', error: 'boom' }])
  })

  it('hooks: injected text matched in order to hooks carrying additionalContext; named by join, plugin path, last word; owned by path', () => {
    const ok = (cmd: string, extra: Record<string, unknown> = {}): string =>
      att({ type: 'hook_success', hookEvent: 'SessionStart', command: cmd, stdout: '{"hookSpecificOutput":{"additionalContext":"…"}}', exitCode: 0, ...extra })
    const ctx: StartedWithContext = {
      ...CTX,
      loaded: { injections: [{ command: 'bash "${CLAUDE_PLUGIN_ROOT}/x.sh"', name: 'superpowers', origin: 'plugin' }], mcp: [] },
    }
    const s = startedWith(
      [
        ok('bash "${CLAUDE_PLUGIN_ROOT}/x.sh"'),
        att({ type: 'hook_success', hookEvent: 'SessionStart', command: 'quiet', stdout: '{"suppressOutput":true}', exitCode: 0 }),
        ok('/opt/silos/plugin/hooks/session-start.sh'),
        ok('node "$C/plugins/cache/thedotmack/claude-mem/9/run.js" start'),
        ok('/w/proj/.claude/hooks/start.sh'),
        att({ type: 'hook_success', hookEvent: 'SessionStart', command: 'broken.sh --flag', stdout: '', exitCode: 2 }),
        att({ type: 'hook_additional_context', content: ['aaaa', 'bbb', 'cc', 'd'] }),
        shape(),
        reply(100),
      ],
      ctx,
    )
    const hooks = s.parts.filter((p) => p.kind === 'hook').map((p) => [p.owner, p.label, p.chars, p.exitCode])
    expect(hooks).toEqual([
      ['you', 'superpowers', 4, undefined],
      ['silos', 'session-start.sh', 3, undefined],
      ['you', 'claude-mem', 2, undefined],
      ['project', 'start.sh', 1, undefined],
      // exited non-zero, injected nothing: still said
      ['you', '--flag', 0, 2],
    ])
    expect(hookName('x "${A}/plugins/marketplaces/acme/thing/run.sh"', CTX)).toBe('acme')
  })

  it('now.mcp: the servers in force after replaying deltas — a login change drops the old account’s connectors (Claude Code’s own delta), owners by prefix', () => {
    const delta = (added: string[], removed: string[] = []): string => att({ type: 'deferred_tools_delta', addedNames: added, removedNames: removed })
    const s = startedWith(
      [
        delta(['mcp__claude_ai_Gmail__search', 'mcp__claude_ai_Gmail__send', 'mcp__railway__deploy', 'mcp__plugin_stripe_stripe__x', 'WebFetch']),
        shape(),
        reply(100),
        // the account changes: Claude Code removes the old login's connectors and adds the new one's
        delta(['mcp__claude_ai_Drive__list'], ['mcp__claude_ai_Gmail__search', 'mcp__claude_ai_Gmail__send']),
      ],
      { ...CTX, loaded: { injections: [], mcp: [{ name: 'railway', source: 'project', from: '~/.claude.json' }] } },
    )
    expect(s.now!.mcp).toEqual(
      [
        { server: 'claude_ai_Drive', label: 'claude_ai_Drive', owner: 'account', tools: 1 },
        { server: 'railway', label: 'railway', owner: 'project', tools: 1, loginBound: true },
        { server: 'plugin_stripe_stripe', label: 'plugin_stripe_stripe', owner: 'you', tools: 1 },
      ].sort((x, y) => x.label.localeCompare(y.label)),
    )
  })

  it("now.mcp: the agent's own servers ride its plugin (plugin_<id>_<name>) and are the agent's — another plugin's stay yours", () => {
    const delta = att({ type: 'deferred_tools_delta', addedNames: ['mcp__plugin_fin-ops_books__list', 'mcp__plugin_stripe_stripe__x'], removedNames: [] })
    const s = startedWith([delta, shape(), reply(100)], { ...CTX, loaded: { injections: [], mcp: [{ name: 'books', source: 'agent', from: 'fin-ops' }] } })
    expect(s.now!.mcp.map((m) => [m.server, m.owner])).toEqual([
      ['plugin_fin-ops_books', 'agent'],
      ['plugin_stripe_stripe', 'you'],
    ])
  })

  it('Silos’ own briefing stays the Silos platform’s even when the project IS the Silos repo (the Silos agent) — the join wins over the path', () => {
    const cmd = '/home/user/silos/plugin/hooks/session-start.sh'
    const ok = att({ type: 'hook_success', hookEvent: 'SessionStart', command: cmd, stdout: '{"hookSpecificOutput":{"additionalContext":"…"}}', exitCode: 0 })
    const joined: StartedWithContext = {
      ...CTX,
      projectDir: '/home/user/silos',
      silosPluginDir: '/home/user/silos-layers/plugin',
      loaded: { injections: [{ command: cmd, name: 'Silos briefing', origin: 'silos' }], mcp: [] },
    }
    const a = startedWith([ok, att({ type: 'hook_additional_context', content: ['brief'] }), shape(), reply(100)], joined)
    expect(a.parts.find((p) => p.kind === 'hook')).toMatchObject({ owner: 'silos', label: 'Silos briefing' })
    // without the join (Silos can't name it), the plugin path still says Silos, before the project test
    const unjoined: StartedWithContext = { ...joined, loaded: { injections: [], mcp: [] } }
    const b = startedWith([ok, att({ type: 'hook_additional_context', content: ['brief'] }), shape(), reply(100)], unjoined)
    expect(b.parts.find((p) => p.kind === 'hook')).toMatchObject({ owner: 'silos' })
  })

  it('first message: the last real user record (after /clear), the prelude and a run’s OUTCOME instruction → silos', () => {
    const s = startedWith(
      [
        user('old'),
        user('<command-name>/clear</command-name>\n<command-message>clear</command-message>'),
        user('meta', { isMeta: true }),
        user([{ type: 'text', text: `[silos-context] skills: a [/silos-context]\n\nDo the beat.\n\n${RUN_OUTCOME_INSTRUCTION}` }]),
        shape(),
        reply(100),
      ],
      CTX,
    )
    expect(part(s, 'prelude')).toMatchObject({ owner: 'silos', chars: '[silos-context] skills: a [/silos-context]\n\n'.length })
    expect(part(s, 'outcome')).toMatchObject({ owner: 'silos', chars: RUN_OUTCOME_INSTRUCTION.length + 2 })
    expect(part(s, 'first')).toMatchObject({ owner: 'conversation', chars: 'Do the beat.'.length })
  })

  it('session context → engine; the account is the email in it, one entry per change', () => {
    const sc = (email: string, at: string): string =>
      att({ type: 'session_context', context: { userEmail: `The user's email address is ${email}. Use it.` } }, { timestamp: at })
    const s = startedWith([sc('a@x.io', 't1'), shape(), reply(100, 't2'), sc('a@x.io', 't3'), sc('b@y.io', 't4'), sc('a@x.io', 't5'), reply(500, 't6')], CTX)
    expect(part(s, 'context')).toMatchObject({ owner: 'engine' })
    expect(s.accounts).toEqual([
      { email: 'a@x.io', at: 't1' },
      { email: 'b@y.io', at: 't4' },
      { email: 'a@x.io', at: 't5' },
    ])
    expect(s.contextNow).toEqual({ tokens: 500, at: 't6' })
  })
})

describe('the first turn and now', () => {
  it('skips zero-usage replies and replies before the first shape', () => {
    const s = startedWith(
      [
        reply(70, 'early'),
        att({ type: 'instructions', files: [{ type: 'Project', content: 'x'.repeat(10) }] }),
        shape(),
        L({ type: 'assistant', message: { usage: { input_tokens: 0 } } }),
        reply(200, 'real'),
      ],
      CTX,
    )
    expect(s.totalTokens).toBe(200)
    expect(s.at).toBe('real')
  })

  it('tokens: proportional to size, the remainder on the largest part; they sum to the total', () => {
    const s = startedWith(
      [
        att({
          type: 'instructions',
          files: [
            { type: 'Project', content: 'a' },
            { type: 'Project', content: 'b' },
            { type: 'User', content: 'c' },
          ],
        }),
        shape(['E']),
        reply(10),
      ],
      CTX,
    )
    expect(sum(s)).toBe(10)
    const chars = s.parts.reduce((a, p) => a + p.chars, 0)
    for (const p of s.parts) expect(Math.abs(p.tokens - (10 * p.chars) / chars)).toBeLessThanOrEqual(1)
  })

  it('now: the latest record of each kind, listings and tools replayed, converted with the first turn’s ratio', () => {
    const s = startedWith(
      [
        att({ type: 'skill_listing', isInitial: true, content: '- a: 1\n- b: 2', names: ['a', 'b'] }),
        att({ type: 'deferred_tools_delta', addedNames: ['T1', 'T2', 'T3'] }),
        att({ type: 'instructions', files: [{ type: 'Project', content: 'x'.repeat(100) }] }),
        shape(['E'.repeat(50)]),
        reply(40),
        att({ type: 'skill_listing', isInitial: false, content: '- c: 3', names: ['c'] }),
        att({ type: 'deferred_tools_delta', addedNames: ['T4'], removedNames: ['T1', 'T2'], readdedNames: ['T1'] }),
        att({ type: 'instructions', files: [{ type: 'Project', content: 'x'.repeat(300) }] }),
        reply(900),
      ],
      { ...CTX, catalog: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] },
    )
    expect(s.totalTokens).toBe(40)
    const now = s.now!
    expect(now.tools).toBe(3) // T1 (re-added), T3, T4
    expect(now.parts.find((p) => p.kind === 'skills')!.chars).toBe('- a: 1\n- b: 2\n- c: 3\n'.length)
    expect(now.parts.find((p) => p.kind === 'instructions')!.chars).toBe(300)
    expect(now.parts.find((p) => p.kind === 'deferred')!.chars).toBe('T1 T3 T4 '.length)
    expect(now.ratio).toBeCloseTo(s.parts.reduce((a, p) => a + p.chars, 0) / 40, 10)
    expect(s.contextNow!.tokens).toBe(900)
  })
})

describe('tolerant', () => {
  it('garbage lines, foreign shapes and missing fields never throw', () => {
    const lines = [
      '',
      'not json',
      '42',
      '[1,2]',
      'null',
      L({ type: 'attachment' }),
      L({ type: 'attachment', attachment: { type: 'instructions', files: 'nope' } }),
      L({ type: 'attachment', attachment: { type: 'skill_listing', content: 7 } }),
      L({ type: 'attachment', attachment: { type: 'agent_listing_delta' } }),
      L({ type: 'attachment', attachment: { type: 'deferred_tools_delta', addedNames: [1, null, 'X'] } }),
      L({ type: 'attachment', attachment: { type: 'hook_additional_context', content: [null] } }),
      L({ type: 'api-request-shape', shape: { system: 'x', tools: {} } }),
      L({ type: 'user', message: null }),
      L({ type: 'assistant', message: { usage: { input_tokens: 'many', cache_read_input_tokens: 9 } } }),
    ]
    const s = startedWith(lines, CTX)
    expect(s.totalTokens).toBe(9)
    expect(s.measured).toBe(true)
    expect(sum(s)).toBe(9)
  })

  it('no api-request-shape and no prompt_snapshot → measured: false with the total only', () => {
    const s = startedWith([att({ type: 'instructions', files: [{ type: 'Project', content: 'abc' }] }), reply(321)], CTX)
    expect(s).toMatchObject({ measured: false, totalTokens: 321, parts: [], now: null })
  })

  it('no reply yet → no measurement', () => {
    const s = startedWith([shape(), user('hi')], CTX)
    expect(s).toMatchObject({ measured: false, totalTokens: null, parts: [] })
  })
})

// ── the inventory places a start (tools-origin T5) ─────────────────────
// The folder's inventory (Harness.loads — run here for real on a temp home)
// is handed to the measure: a part takes its row's owner, label and key.
describe('placed by the folder’s inventory', () => {
  const ORG = '00000000-0000-4000-8000-00000000000a'
  const ACC = '00000000-0000-4000-8000-00000000000b'
  const EMAIL = 'sam@example.com'
  let base: string, home: string, folder: string, managed: string, transcript: string
  const put = (path: string, v: unknown): void => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, typeof v === 'string' ? v : JSON.stringify(v))
  }
  const claude = (...p: string[]): string => join(home, '.claude', ...p)
  const installDesign = (): void => {
    const dir = join(base, 'cache', 'design-market')
    put(join(dir, '.claude-plugin', 'plugin.json'), { name: 'design', mcpServers: { files: { command: 'f' } } })
    put(claude('plugins', 'installed_plugins.json'), { version: 2, plugins: { 'design@market': [{ scope: 'user', installPath: dir, version: '1.0.0' }] } })
  }
  const sendDesign = (): void => {
    const dir = claude('plugins', 'synced', `${ORG}_${ACC}`, 'design')
    put(join(dir, '.claude-plugin', 'plugin.json'), { name: 'design', mcpServers: { files: { command: 'f' }, chat: { url: 'https://chat.example.com' } } })
    put(join(dir, 'hooks', 'hooks.json'), { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'design-start.sh' }] }] } })
  }
  const rows = (readings: LoadsReading[] = []): LoadsRow[] =>
    claudeLoadsInventory({ folder, home, managedDir: managed, recentTranscripts: [transcript], seenToolIds: [], readings }).rows
  const ctxWith = (loads: LoadsRow[]): StartedWithContext => ({
    ...CTX,
    projectDir: folder,
    loads,
    catalog: [{ name: 'personal', source: 'user' }],
    loaded: { injections: [{ command: 'design-start.sh', name: 'design', origin: 'plugin' }], mcp: [] },
  })
  // a start that carried the design plugin's server, a skill, a subagent type and its start hook
  const start = (): string[] => [
    att({
      type: 'hook_success',
      hookEvent: 'SessionStart',
      command: 'design-start.sh',
      stdout: '{"hookSpecificOutput":{"additionalContext":"…"}}',
      exitCode: 0,
    }),
    att({ type: 'hook_additional_context', content: ['design says hello'] }),
    att({ type: 'skill_listing', content: '- design:critique: reviews a design\n- personal: y', names: ['design:critique', 'personal'] }),
    att({
      type: 'agent_listing_delta',
      addedLines: ['- Explore: find', '- design:reviewer: reviews'],
      addedTypes: ['Explore', 'design:reviewer'],
      builtInTypes: ['Explore'],
    }),
    att({ type: 'deferred_tools_delta', addedNames: ['mcp__plugin_design_files__open', 'mcp__plugin_design_files__save', 'WebFetch'] }),
    att({ type: 'mcp_instructions_delta', addedNames: ['plugin:design:files'], addedBlocks: ['## files\nuse it well'], removedNames: [] }),
    shape(['ENGINE'], [{ name: 'mcp__plugin_design_files__find', description: 'd' }]),
    reply(1000),
  ]
  const designParts = (s: StartedWith) => s.parts.filter((p) => p.group === 'design' || p.kind === 'hook')

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'started-with-loads-'))
    home = join(base, 'home')
    folder = join(base, 'proj')
    managed = join(base, 'managed')
    mkdirSync(folder, { recursive: true })
    mkdirSync(managed, { recursive: true })
    transcript = join(base, 't.jsonl')
    put(
      transcript,
      [
        L({ type: 'attachment', attachment: { type: 'session_context', context: { userEmail: `The user's email address is ${EMAIL}.` } } }),
        L({ type: 'session-owner', accountUuid: ACC, organizationUuid: ORG, sessionId: 's1' }),
      ].join('\n') + '\n',
    )
  })

  it('an account plugin’s parts are the account’s — its server (tools, deferred names, instructions), skills, subagent types and start hook', () => {
    sendDesign()
    const loads = rows()
    const s = startedWith(start(), ctxWith(loads))
    const server = part(s, 'mcp-plugin_design_files')!
    expect(server).toMatchObject({ owner: 'account', label: 'files', group: 'design', item: `server:${ACC}:design@synced:files` })
    // the tool definition, both deferred names and the instruction block, one part
    expect(server.chars).toBe(
      pyDumps({ name: 'mcp__plugin_design_files__find', description: 'd' }).length +
        'mcp__plugin_design_files__open'.length +
        1 +
        'mcp__plugin_design_files__save'.length +
        1 +
        cpLen('## files\nuse it well'),
    )
    const plugin = `plugin:${ACC}:design@synced`
    expect(part(s, 'skills-plugin-design')).toMatchObject({ owner: 'account', item: plugin })
    expect(part(s, 'agents-plugin-design')).toMatchObject({ owner: 'account', item: plugin })
    expect(s.parts.find((p) => p.kind === 'hook')).toMatchObject({ owner: 'account', item: plugin })
    expect(designParts(s).every((p) => p.owner === 'account')).toBe(true)
    // what is not the plugin's stays where it was
    expect(part(s, 'skills-you')).toMatchObject({ owner: 'you' })
    expect(part(s, 'agents-engine')).toMatchObject({ owner: 'engine' })
    expect(s.loadedNames).toEqual(['plugin:design:files'])
  })

  it('a plugin installed AND sent: the copy a reading names, else the installed one when it is on, else the account’s', () => {
    installDesign()
    sendDesign()
    const ownerOf = (loads: LoadsRow[]): [StartedWithOwner, string | undefined] => {
      const p = part(startedWith(start(), ctxWith(loads)), 'mcp-plugin_design_files')!
      return [p.owner, p.item]
    }
    // no reading, the installed copy on: the installed one's
    expect(ownerOf(rows())).toEqual(['you', 'server:design@market:files'])
    // a reading naming a server only the account copy declares: the account's
    const read: LoadsReading = { at: 1, login: EMAIL, servers: [{ name: 'plugin:design:chat', status: 'connected', source: 'plugin' }] }
    expect(ownerOf(rows([read]))).toEqual(['account', `server:${ACC}:design@synced:files`])
    // the installed copy off in this project: the account's
    put(join(folder, '.claude', 'settings.local.json'), { enabledPlugins: { 'design@market': false } })
    expect(ownerOf(rows())).toEqual(['account', `server:${ACC}:design@synced:files`])
  })

  it('labels come from the resolver: an exact name’s row, never an id cut at an underscore; an id two names share stays unresolved', () => {
    const loads: LoadsRow[] = [
      {
        key: 'connector:sam@example.com:claude.ai Google Drive',
        engine: 'Claude Code',
        kind: 'connector',
        name: 'claude.ai Google Drive',
        label: 'Google Drive',
        exact: true,
        origin: { owner: 'account', carrier: 'connector', login: EMAIL },
        state: 'active',
      },
      {
        key: 'mcp:project:my.tool',
        engine: 'Claude Code',
        kind: 'mcp',
        name: 'my.tool',
        label: 'my.tool',
        exact: true,
        origin: { owner: 'project', carrier: '.mcp.json' },
        state: 'active',
      },
      {
        key: 'mcp:user:my tool',
        engine: 'Claude Code',
        kind: 'mcp',
        name: 'my tool',
        label: 'my tool',
        exact: true,
        origin: { owner: 'you', carrier: '~/.claude.json' },
        state: 'active',
      },
      {
        key: 'mcp:local:books_api',
        engine: 'Claude Code',
        kind: 'mcp',
        name: 'books_api',
        label: 'books_api',
        exact: true,
        origin: { owner: 'you', carrier: '~/.claude.json · this folder' },
        state: 'active',
      },
    ]
    const s = startedWith(
      [
        att({
          type: 'deferred_tools_delta',
          addedNames: ['mcp__claude_ai_Google_Drive__list', 'mcp__my_tool__go', 'mcp__books_api__get', 'mcp__plugin_some-thing_x_y__z'],
        }),
        shape(),
        reply(100),
      ],
      { ...CTX, loads },
    )
    expect(part(s, 'mcp-claude_ai_Google_Drive')).toMatchObject({
      owner: 'account',
      label: 'Google Drive',
      item: 'connector:sam@example.com:claude.ai Google Drive',
    })
    // `my.tool` and `my tool` both carry the id my_tool: neither is chosen
    expect(part(s, 'mcp-my_tool')).toMatchObject({ label: 'my_tool', unsourced: true })
    expect(part(s, 'mcp-my_tool')!.item).toBeUndefined()
    // underscores in a real name are kept; a folder's ~/.claude.json server is login-bound
    expect(part(s, 'mcp-books_api')).toMatchObject({ owner: 'you', label: 'books_api', item: 'mcp:local:books_api', loginBound: true })
    // an id no name has keeps the id — never «y · some-thing»
    expect(part(s, 'mcp-plugin_some-thing_x_y')).toMatchObject({ label: 'plugin_some-thing_x_y', unsourced: true })
    expect(s.now!.mcp.find((m) => m.server === 'claude_ai_Google_Drive')).toMatchObject({
      label: 'Google Drive',
      owner: 'account',
      item: 'connector:sam@example.com:claude.ai Google Drive',
    })
  })

  it('the total is unchanged: placing by the inventory moves tokens between owners, never adds any', () => {
    sendDesign()
    const bare = startedWith(start(), { ...CTX, projectDir: folder })
    const placed = startedWith(start(), ctxWith(rows()))
    expect(placed.totalTokens).toBe(bare.totalTokens)
    expect(sum(placed)).toBe(1000)
    expect(sum(bare)).toBe(1000)
    expect(placed.parts.reduce((a, p) => a + p.chars, 0)).toBe(bare.parts.reduce((a, p) => a + p.chars, 0))
    expect(byOwner(bare).account ?? 0).toBe(0)
    expect(byOwner(placed).account).toBeGreaterThan(0)
  })
})

// THE one reader of a conversation's instruction files (instructions-record.ts,
// spec memory-places §6): the engine's replay — the last record without
// `changed`, then each later one's files and removed — and the starts it saw
describe('instruction files — the one reader', () => {
  const T = (m: number): string => `2026-11-20T10:${String(m).padStart(2, '0')}:00.000Z`
  const ins = (at: number, files: { path: string; type?: string; content?: string }[], delta?: { removed?: unknown[] }) =>
    att(
      {
        type: 'instructions',
        files: files.map((f) => ({ type: 'Project', content: 'x', ...f })),
        ...(delta ? { changed: true, reason: 'session_start', ...(delta.removed ? { removed: delta.removed } : {}) } : {}),
      },
      { timestamp: T(at) },
    )
  const hook = (at: number) => att({ type: 'hook_success', hookEvent: 'SessionStart', command: 'x', stdout: '' }, { timestamp: T(at) })
  const said = (at: number) => L({ type: 'assistant', timestamp: T(at), message: { usage: { input_tokens: 5 } } })
  const paths = (r: { files: { path: string }[] }) => r.files.map((f) => f.path)

  it('a base, then a delta: the delta adds and replaces by path, never stands for the set', () => {
    const r = readInstructionsRecord([
      ins(1, [{ path: '/p/CLAUDE.md', content: 'aaaa' }, { path: '/p/CLAUDE.local.md' }]),
      ins(5, [{ path: '/p/CLAUDE.md', content: 'bb' }, { path: '/p/.claude/rules/x.md' }], {}),
    ])
    expect(paths(r)).toEqual(['/p/CLAUDE.md', '/p/CLAUDE.local.md', '/p/.claude/rules/x.md'])
    expect(r.files[0]!.content).toBe('bb')
    expect(r.state).toBe('recorded')
    expect(r.lastRecordAt).toBe(T(5))
  })

  it('removed drops what a later start no longer loads; a new base starts over', () => {
    const r = readInstructionsRecord([
      ins(1, [{ path: '/h/a/projects/k/memory/MEMORY.md', type: 'AutoMem' }, { path: '/p/CLAUDE.md' }]),
      ins(5, [{ path: '/h/b/projects/k/memory/MEMORY.md', type: 'AutoMem' }], { removed: ['/h/a/projects/k/memory/MEMORY.md', { path: '/nowhere' }] }),
    ])
    expect(paths(r)).toEqual(['/p/CLAUDE.md', '/h/b/projects/k/memory/MEMORY.md'])
    const again = readInstructionsRecord([ins(1, [{ path: '/p/CLAUDE.md' }, { path: '/p/x.md' }]), ins(9, [{ path: '/p/CLAUDE.md' }])])
    expect(paths(again)).toEqual(['/p/CLAUDE.md'])
  })

  it('a nested load is on demand, with its parent; a new base clears it, a removed path drops it', () => {
    const nested = (at: number, path: string, parent?: string) =>
      att({ type: 'nested_memory', path, content: { type: 'Project', content: 'nn', ...(parent ? { parent } : {}) } }, { timestamp: T(at) })
    const r = readInstructionsRecord([ins(1, [{ path: '/p/CLAUDE.md' }]), nested(3, '/p/web/CLAUDE.md'), nested(3, '/p/web/AGENTS.md', '/p/web/CLAUDE.md')])
    expect(r.nested.map((n) => [n.path, n.parent ?? null, n.content])).toEqual([
      ['/p/web/CLAUDE.md', null, 'nn'],
      ['/p/web/AGENTS.md', '/p/web/CLAUDE.md', 'nn'],
    ])
    expect(paths(r)).toEqual(['/p/CLAUDE.md'])
    expect(readInstructionsRecord([ins(1, [{ path: '/p/CLAUDE.md' }]), nested(3, '/p/web/CLAUDE.md'), ins(7, [{ path: '/p/CLAUDE.md' }])]).nested).toEqual([])
    expect(
      readInstructionsRecord([ins(1, [{ path: '/p/CLAUDE.md' }]), nested(3, '/p/web/CLAUDE.md'), ins(7, [], { removed: ['/p/web/CLAUDE.md'] })]).nested,
    ).toEqual([])
  })

  it('no record is not «not read»: a start after the last record is unchanged, a fresh start with none is empty, neither is unread', () => {
    // a start (its SessionStart hook, then a reply) with no record since: the set did not change
    const unchanged = readInstructionsRecord([hook(0), ins(1, [{ path: '/p/CLAUDE.md' }]), said(2), hook(30), said(31)])
    expect(unchanged.state).toBe('unchanged')
    expect(paths(unchanged)).toEqual(['/p/CLAUDE.md'])
    expect(unchanged.lastStartAt).toBe(T(30))
    // a fresh conversation that loaded nothing
    const empty = readInstructionsRecord([hook(0), said(1)])
    expect(empty).toMatchObject({ state: 'empty', files: [] })
    // a hook with no reply after it is not a start yet
    expect(readInstructionsRecord([hook(0)]).state).toBe('unread')
    expect(readInstructionsRecord([]).state).toBe('unread')
    // a start the caller knows from elsewhere (a chat turn's status) counts too
    expect(readInstructionsRecord([], [Date.parse(T(4))]).state).toBe('empty')
    expect(readInstructionsRecord([ins(1, [{ path: '/p/CLAUDE.md' }])], [Date.parse(T(4))]).state).toBe('unchanged')
    expect(readInstructionsRecord([ins(1, [{ path: '/p/CLAUDE.md' }])]).state).toBe('recorded')
  })

  it('a damaged line is skipped, the rest replayed', () => {
    const good = ins(1, [{ path: '/p/CLAUDE.md' }])
    expect(
      paths(
        readInstructionsRecord([
          good,
          '{"type":"attachment","attachment":{"type":"instructions","files":[{"pa',
          'null',
          '[]',
          ins(2, [{ path: '/p/b.md' }], {}),
        ]),
      ),
    ).toEqual(['/p/CLAUDE.md', '/p/b.md'])
    expect(
      paths(readInstructionsRecord([good, L({ type: 'attachment', attachment: { type: 'instructions', changed: true, files: 'nope', removed: 7 } })])),
    ).toEqual(['/p/CLAUDE.md'])
  })

  it("one file under two logins' paths is two recorded paths — the list matches them by real path", () => {
    const r = readInstructionsRecord([
      ins(1, [{ path: '/h/.claude/CLAUDE.md', type: 'User' }]),
      ins(4, [{ path: '/h/.silos/accounts/sam/CLAUDE.md', type: 'User' }], { removed: ['/h/.claude/CLAUDE.md'] }),
    ])
    expect(r.files.map((f) => [f.path, f.type])).toEqual([['/h/.silos/accounts/sam/CLAUDE.md', 'User']])
  })

  it('Started with on a delta: the first turn is the base, now is the replay (removed honoured)', () => {
    const s = startedWith(
      [
        ins(1, [
          { path: '/p/CLAUDE.md', content: 'x'.repeat(100) },
          { path: '/p/CLAUDE.local.md', content: 'y'.repeat(50) },
        ]),
        shape(['E'.repeat(50)]),
        reply(40),
        ins(5, [{ path: '/p/.claude/rules/r.md', content: 'z'.repeat(30) }], { removed: ['/p/CLAUDE.local.md'] }),
        reply(900),
      ],
      CTX,
    )
    expect(s.parts.filter((p) => p.kind === 'instructions').map((p) => [p.label, p.chars])).toEqual([
      ['/p/CLAUDE.md', 100],
      ['/p/CLAUDE.local.md', 50],
    ])
    expect(s.now!.parts.filter((p) => p.kind === 'instructions').map((p) => [p.label, p.chars])).toEqual([
      ['/p/CLAUDE.md', 100],
      ['/p/.claude/rules/r.md', 30],
    ])
  })
})
