// The conduct with tasks lives in ONE place, the team-plan skill — its
// SKILL.md (the recipes and the conduct: what survives a compaction, which
// re-attaches only a skill's first 5,000 tokens) and the reference files it
// points at; the other sources carry only the key sentences they derive
// from it, and none rewrites a rule of its own.
import { describe, expect, it } from 'vitest'
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
// prose is wrapped differently in each file: compare with whitespace collapsed
const flat = (s: string) => s.replace(/\s+/g, ' ')
const count = (hay: string, needle: string) => flat(hay).split(flat(needle)).length - 1

const R2 =
  "Your own steps inside this conversation stay here — in the engine's checklist when it has one — never as Silos tasks. Plan mode's proposal is Claude Code's; it never goes in `plans/`."
const ONE_TASK = 'one piece of work = one task in plans/tasks.plan.json'
const HUMAN_CLOSE = "A human's task closes on the human's word or on evidence the system holds"

const SKILL = read('plugin/skills/team-plan/SKILL.md')
// the skill as a whole (its core and the reference files it points at)
const REFERENCES = readdirSync(fileURLToPath(new URL('../../plugin/skills/team-plan/reference/', import.meta.url)))
  .sort()
  .map((f) => `plugin/skills/team-plan/reference/${f}`)
const SKILL_ALL = [SKILL, ...REFERENCES.map(read)].join('\n')
const [, front, body] = SKILL.split(/^---$/m)
const description = /description: (.*)/.exec(front ?? '')?.[1] ?? ''

// every other source an agent (or the reviewer) reads rules from
const briefing = [
  ...readdirSync(fileURLToPath(new URL('../../plugin/context/briefing.d/', import.meta.url))).map((f) => `plugin/context/briefing.d/${f}`),
  ...readdirSync(fileURLToPath(new URL('../../plugin/context/reference/', import.meta.url))).map((f) => `plugin/context/reference/${f}`),
  'plugin/context/hand-started.md',
]
const others = [
  ...briefing,
  'plugin/skills/heartbeat/SKILL.md',
  'plugin/skills/support-inbox/SKILL.md',
  'plugin/skills/vault-secrets/SKILL.md',
  'plugin/README.md',
  'docs/product.md',
  'docs/standard/reference/task-mode.silo.json',
  'server/src/heartbeat-prompt.ts',
  'plugin/hooks/inbox.py',
]

describe('team-plan is the one source of task conduct', () => {
  // (the skill split, on purpose) the description is in every session's
  // skill listing: it says when to use the skill and nothing else — the R2
  // sentence reaches a session with the skill through the .with fragment
  it('the R2 sentence: in the body, in both fragments and in product.md — not in the description', () => {
    expect(count(description, R2)).toBe(0)
    expect(description.length).toBeLessThan(400)
    expect(count(body ?? '', R2)).toBeGreaterThanOrEqual(1)
    for (const rel of ['plugin/context/briefing.d/team-plan.with.md', 'plugin/context/briefing.d/team-plan.without.md', 'docs/product.md']) {
      expect(count(read(rel), R2), rel).toBeGreaterThanOrEqual(1)
    }
  })
  it('«one piece of work = one task in plans/tasks.plan.json» in SKILL and .without', () => {
    expect(SKILL).toContain(ONE_TASK)
    expect(read('plugin/context/briefing.d/team-plan.without.md')).toContain(ONE_TASK)
  })
  it('no source but SKILL says «draft a team plan» or «one task per section»', () => {
    for (const rel of others) {
      expect(read(rel), rel).not.toMatch(/draft a team plan|one task per section/i)
    }
  })
  // what a compaction keeps of an invoked skill is its first 5,000 tokens:
  // the core must hold both recipes and the conduct inside that, with room
  it('SKILL.md is the core: both recipes and Behavior before any format, and well under 5,000 tokens', () => {
    expect(SKILL.length).toBeLessThan(16_000) // ~4 characters a token
    const at = (s: string) => SKILL.indexOf(s)
    for (const first of ['/api/tasks/claim', '/api/tasks/release', '## Behavior']) {
      expect(at(first), first).toBeGreaterThan(-1)
      expect(at(first), first).toBeLessThan(at('## The files'))
    }
  })
  it('every reference file SKILL.md points at exists, and every one that exists is pointed at', () => {
    const named = new Set([...SKILL.matchAll(/\]\((reference\/[a-z-]+\.md)\)/g)].map((m) => `plugin/skills/team-plan/${m[1]}`))
    expect([...named].sort()).toEqual(REFERENCES)
    for (const rel of REFERENCES)
      for (const m of read(rel).matchAll(/\]\(([a-z-]+\.md)\)/g)) expect(REFERENCES, `${rel} → ${m[1]}`).toContain(`plugin/skills/team-plan/reference/${m[1]}`)
  })
  it('the human-closing rule is written only in SKILL', () => {
    expect(flat(SKILL)).toContain(HUMAN_CLOSE)
    for (const rel of REFERENCES) expect(flat(read(rel)), rel).not.toContain(HUMAN_CLOSE)
    for (const rel of others) expect(flat(read(rel)), rel).not.toContain(HUMAN_CLOSE)
  })
  // this repo is itself an agent folder: its own team-plan is a relative
  // link to the one it ships — never a second copy to keep equal
  it("the repo's own .claude/skills/team-plan is a relative link to plugin/skills/team-plan", () => {
    const link = fileURLToPath(new URL('../../.claude/skills/team-plan', import.meta.url))
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe('../../plugin/skills/team-plan')
  })
  it('SKILL carries the task-flow rules: ask/wait, claim the execution task, Unlink, the on-screen label', () => {
    for (const s of [
      'When you wait on the owner, ALWAYS write `asked` (and `options` when the answer is a choice)',
      'Creating the task wakes nobody',
      'Claim it when execution starts',
      'Release (the owner sees it as Unlink)',
      'In the API send `"plan":"tasks"`',
      "The task's owner claims it first",
      "for someone else's task, message its owner",
      '`$CLAUDE_CONFIG_DIR/plans/`',
    ])
      expect(flat(SKILL_ALL), s).toContain(flat(s))
    expect(SKILL_ALL).not.toMatch(/TodoWrite|TaskCreate/)
  })
  // What an agent without the skill must know too is said in BOTH, word for
  // word — the label and what to send, the worktree path, which engines
  // remind after a reset. (the briefing trim, on purpose) Without the skill
  // the always-on rule keeps the label; the worktree path and the reset
  // rule live in the file that rule names, plugin/context/reference/tasks.md.
  const REFERENCE = 'plugin/context/reference/tasks.md'
  const LABEL =
    'A task of the project\'s list is named by its project, as the screen shows it: `<project>#t3` — say it so in notes and answers. In the API send `"plan":"tasks"` (Silos finds the project from your conversation; add `"folder"` when it asks), and `"plan":"<project>"` works too. Never name a plan like its project folder.'
  const WORKTREE =
    "From a git worktree, edit the main checkout's `plans/` — `\"$(git rev-parse --path-format=absolute --git-common-dir)/../$(git rev-parse --show-prefix)plans/\"`, run from the project's root — never the worktree's copy: Silos reads only the main one."
  const RESET =
    "In a Silos console of Claude Code, `/clear` keeps the conversation and its tasks (Silos reminds you of them, with this recipe filled); anywhere else — OpenCode's `/new`, a claude you started yourself — the next conversation is a new one with a new id, nothing reminds it, and it cannot release for the old one: release before you switch."
  it('the label, the worktree path and the reset rule: the same words with the skill and without it', () => {
    const without = read('plugin/context/briefing.d/team-plan.without.md')
    const reference = read(REFERENCE)
    for (const s of [LABEL, WORKTREE, RESET]) expect(count(SKILL_ALL, s), s.slice(0, 40)).toBe(1)
    expect(count(without, LABEL)).toBe(1)
    for (const s of [WORKTREE, RESET]) expect(count(reference, s), s.slice(0, 40)).toBe(1)
    expect(count(read('plugin/context/briefing.d/team-plan.with.md'), LABEL)).toBe(1)
  })
  it('.without names the reference file, and the file is there', () => {
    expect(read('plugin/context/briefing.d/team-plan.without.md')).toContain('`{{context}}/reference/tasks.md`')
    expect(read(REFERENCE).length).toBeGreaterThan(0)
  })
  it('the reference carries the rules that lived only in SKILL: Silos writes too, Dropped/cancelled, the list never moves', () => {
    const without = flat(read(REFERENCE))
    expect(without).toContain('Silos writes in these files too')
    expect(without).toContain('re-read right before you write')
    expect(without).toContain('a note that starts `Dropped:`')
    expect(without).toContain('`cancelled` resolves no dependency')
    expect(without).toContain("the project's list never moves")
  })
  it('no «standing list», no repeated R2 line under a heading', () => {
    for (const rel of ['plugin/skills/team-plan/SKILL.md', ...REFERENCES, ...briefing]) expect(read(rel), rel).not.toMatch(/standing list/i)
    expect(body).not.toMatch(/^## [^\n]+\nYour own steps/m)
    expect(count(body ?? '', R2)).toBe(1)
  })
})

describe('the others carry no task rule of their own', () => {
  // (B2.11) changed on purpose: 0.2.4 named the `answered` wake; 0.2.5 renamed its wake source to English (`wakes`)
  it('Task mode 0.2.5: its own rules only, pointing at team-plan', () => {
    const m = JSON.parse(read('docs/standard/reference/task-mode.silo.json'))
    expect(m.metadata.version).toBe('0.2.5')
    expect(m.spec.producer.instructions.summary).toContain('another agent answered what you asked it through Silos')
    const protocol: string[] = m.spec.producer.instructions.protocol
    expect(protocol[0]).toContain("Tasks follow team-plan (or your briefing's Tasks rule)")
    expect(protocol.join(' ')).not.toMatch(/POST \/api\/tasks\/claim|plans\/tasks\.plan\.json|engine's checklist/)
    expect(m.metadata.description).toContain('a task handed to you')
    expect(m.spec.producer.instructions.summary).toContain('a task handed to you')
  })
  it('inbox.py names no skill', () => {
    for (const rel of ['plugin/hooks/inbox.py']) {
      expect(read(rel), rel).not.toMatch(/team-plan|heartbeat skill|responsibility skill|`heartbeat`|`responsibility`/)
    }
    expect(read('plugin/hooks/inbox.py')).toContain('your Messages rule has the exact curl')
  })
  // C1: ONE rule for waiting on the owner — team-plan's
  // `waitingOn` with `asked`; the question tool only for a decision that is
  // no task's. No other source sends «blocked on the owner» to the question tool.
  // C1: ONE rule for waiting on the owner — team-plan's
  // `waitingOn` with `asked`; the question tool only for a decision that is
  // no task's. No other source sends «blocked on the owner» to the question tool.
  it('waiting on the owner: nobody but team-plan pairs «blocked on the owner» with the question tool', () => {
    const near = /blocked on the owner[^.]{0,200}question tool|question tool[^.]{0,200}blocked on the owner/i
    for (const rel of others) expect(flat(read(rel)), rel).not.toMatch(near)
  })
  // C2: every pointer at a briefing rule by name lands on a header of that name
  it("every «briefing's X rule» / «the X rule above» has a «**X rule.**» header in the briefing", () => {
    const fragments = briefing.map(read).join('\n')
    const sources = [...others, 'plugin/skills/team-plan/SKILL.md', 'server/src/harnesses/briefing.ts', 'server/src/harnesses/inbox-text.ts']
    const named = new Set<string>()
    for (const rel of sources) {
      for (const m of read(rel).matchAll(/(?:briefing's|the|your) ([A-Z][a-z]+) rule\b/g)) named.add(m[1]!)
    }
    expect([...named].sort()).toEqual(expect.arrayContaining(['Messages', 'Tasks']))
    for (const x of named) expect(fragments, x).toContain(`**${x} rule.**`)
  })
})
