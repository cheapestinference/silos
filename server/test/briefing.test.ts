import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { BRIEFING_FRAGMENTS, briefingText, defaultBriefingDir } from '../src/harnesses/briefing.js'

// The convention every agent is told at SessionStart (both engines compose
// it from plugin/context/briefing.d): where its deliverables go, so Silos
// can show them. These rules live in base.md, so every composition has them.
const briefing = briefingText([...BRIEFING_FRAGMENTS])
const heartbeatPromptSource = readFileSync(fileURLToPath(new URL('../src/heartbeat-prompt.ts', import.meta.url)), 'utf8')
const deliverables = briefing.split('\n').find((l) => l.startsWith('- **Deliverables')) ?? ''

describe('the Silos briefing — the deliverables convention', () => {
  it('names the agent, its own folder and where each kind of file goes', () => {
    expect(briefing).toContain('`$SILOS_AGENT_ID`')
    expect(briefing).toContain('`$SILOS_AGENT_STATE`')
    expect(briefing).toContain('`context/<your agent id>/`')
    expect(briefing).toContain('`context/shared/`')
    expect(briefing).toMatch(/reports?, analys[ei]s, specs/)
    expect(briefing).toMatch(/[Cc]ode (goes|belongs) in the repo/)
    expect(deliverables).toMatch(/full path/)
  })
  // conversation files, rule 1: what an agent produces never
  // lands at the top level every conversation is told about
  it('puts what the agent produces in a subfolder of its context folder, never at its top level', () => {
    expect(deliverables).toMatch(/subfolder of `context\/<your agent id>\/`/)
    expect(deliverables).toMatch(/never at its top level/)
  })
  it('states the identity variables conditionally: not every claude briefed carries them', () => {
    expect(deliverables).toContain('When `$SILOS_AGENT_ID` is set')
    expect(deliverables).toMatch(/`\$SILOS_AGENT_STATE` when it is set/)
  })
  it('keeps the rule engine-agnostic: no claude or opencode word in that bullet', () => {
    const bullet = deliverables
    expect(bullet.length).toBeGreaterThan(0)
    expect(bullet).not.toMatch(/claude|opencode/i)
  })
})

// Every recipe that POSTs a message names
// its sender, and the briefing tells the truth about when a message is read
describe('plugin recipes that send a message', () => {
  const heartbeat = readFileSync(fileURLToPath(new URL('../../plugin/skills/heartbeat/SKILL.md', import.meta.url)), 'utf8')
  const messages = briefing.split('\n').find((l) => l.startsWith('- **Messages')) ?? ''
  it('send X-Silos-Agent from $SILOS_AGENT_ID', () => {
    for (const text of [messages]) {
      const posts = text.split('`').filter((c) => c.includes('-X POST') && c.includes('/messages'))
      expect(posts.length).toBeGreaterThan(0)
      for (const p of posts) expect(p).toMatch(/X-Silos-Agent: \$SILOS_AGENT_ID/)
    }
  })
  // no urgency — read at the next conversation;
  // to move work now, a task and its start
  it('say read at the next conversation, no urgency, move work with a task; the inbox is fetched from Silos; close with an answer', () => {
    expect(messages).toContain(
      "A message is read at the recipient's next conversation — any conversation starts with its inbox. To move work NOW, give it a task and start it: if it is yours, POST /api/tasks/assign; if it is another agent's, write the task in its project and leave the rest to the owner.",
    )
    expect(messages).not.toMatch(/urgent/)
    expect(messages).toMatch(/messages\?state=new" -H "Authorization: Bearer \$SILOS_AGENT_TOKEN" -H "x-silos-turn: \$SILOS_TURN"/)
    expect(messages).toContain('"answer"')
    expect(heartbeat).not.toMatch(/refused for the day/)
  })
})

// (R7) no session is told to use a skill it does not have
describe('briefing composition (briefing.d)', () => {
  const dir = defaultBriefingDir()
  const part = (f: string) => readFileSync(join(dir, f), 'utf8').replace(/\n+$/, '')
  it('base.md names no skill', () => {
    const base = part('base.md')
    expect(base).not.toMatch(/skill/i)
    for (const n of BRIEFING_FRAGMENTS) expect(base).not.toContain(`\`${n}\``)
  })
  it('every fragment has its .with and .without, and nothing else lives there', () => {
    expect(readdirSync(dir).sort()).toEqual(['base.md', ...BRIEFING_FRAGMENTS.flatMap((n) => [`${n}.with.md`, `${n}.without.md`])].sort())
  })
  it('a .with names its skill; a .without names no skill at all', () => {
    for (const n of BRIEFING_FRAGMENTS) {
      expect(part(`${n}.with.md`)).toContain(`\`${n}\` skill`)
      expect(part(`${n}.without.md`)).not.toMatch(/skill/i)
    }
  })
  it('with no skills, the briefing points at none', () => {
    const none = briefingText([])
    expect(none).not.toMatch(/skill/i)
    expect(none).toContain('# You are running inside Silos')
  })
  it('composes base → team-plan → vault-secrets → heartbeat, one newline between, none at the end', () => {
    const t = briefingText(['heartbeat', 'some-other-skill'])
    // {{context}} in a fragment is the real path of plugin/context
    const context = realpathSync(join(dir, '..'))
    expect(t).toBe(
      [part('base.md'), part('team-plan.without.md'), part('vault-secrets.without.md'), part('heartbeat.with.md')]
        .join('\n')
        .split('{{context}}')
        .join(context),
    )
    expect(t.endsWith('\n')).toBe(false)
  })
  // a rule may keep what is needed only now and then in a file it names:
  // the path it gives must be one the agent can open, from any folder
  it('every file a rule points at exists, by absolute path, in every composition', () => {
    for (const has of [[], [...BRIEFING_FRAGMENTS]]) {
      const t = briefingText(has)
      expect(t).not.toContain('{{')
      const named = [...t.matchAll(/`(\/[^`]*\/reference\/[^`]+\.md)`/g)].map((m) => m[1]!)
      if (has.length === 0) expect(named.length).toBeGreaterThanOrEqual(2)
      for (const p of named) expect(existsSync(p), p).toBe(true)
    }
  })
  // the heartbeat fragments replaced responsibility's —
  // anchored «Heartbeat rule.», every call with its turn
  it('the Heartbeat rule: both heartbeat fragments start with it and send the turn', () => {
    for (const f of ['heartbeat.with.md', 'heartbeat.without.md']) {
      expect(part(f).startsWith('- **Heartbeat rule.**')).toBe(true)
      expect(part(f)).toContain('$SILOS_TURN')
    }
    // (the briefing trim, on purpose) without the skill the rule is one
    // line: the heartbeat turn's own prompt carries each call
    expect(part('heartbeat.without.md').split('\n')).toHaveLength(1)
    expect(heartbeatPromptSource).toContain('/api/agents/$SILOS_AGENT_ID/considered')
    expect(BRIEFING_FRAGMENTS).toEqual(['team-plan', 'vault-secrets', 'heartbeat'])
  })
  it('an unreadable part is left out; no fragments at all → empty', () => {
    expect(briefingText([], join(dir, 'nope'))).toBe('')
  })
  it('the R2 sentence rides both team-plan fragments', () => {
    const R2 =
      "Your own steps inside this conversation stay here — in the engine's checklist when it has one — never as Silos tasks. Plan mode's proposal is Claude Code's; it never goes in `plans/`."
    expect(part('team-plan.with.md')).toContain(R2)
    expect(part('team-plan.without.md')).toContain(R2)
  })
  // (the briefing trim, on purpose) the always-on rule names the file; the
  // file holds the format and the recipes
  it('without team-plan: the rule says claim and release and names the reference, which has the format, whole-file writes, both recipes and the manual fallback with the releases revive', () => {
    const rule = part('team-plan.without.md')
    expect(rule).toMatch(/claim it; when this conversation moves on, release it/)
    expect(rule).toContain('`{{context}}/reference/tasks.md`')
    const t = readFileSync(join(dir, '..', 'reference', 'tasks.md'), 'utf8')
    expect(t).toContain('plans/<slug>.plan.json')
    expect(t).toMatch(/read → modify → write the WHOLE file/)
    expect(t).toContain('{"title": "", "tasks": []}')
    for (const verb of ['claim', 'release']) {
      expect(t).toContain(`\${SILOS_API:-http://127.0.0.1:3210}/api/tasks/${verb}`)
    }
    expect(t.split('${SILOS_AGENT_ID:+-H "X-Silos-Agent: $SILOS_AGENT_ID"}').length).toBe(3)
    expect(t.split(`"session":"'"\${SILOS_SESSION_ID:-\${CLAUDE_CODE_SESSION_ID:-$SILOS_CONSOLE_KEY}}"'","turn":"'"$SILOS_TURN"'"}'`).length).toBe(3)
    expect(t).toContain('"released": false')
  })
})
