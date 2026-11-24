import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { rosterText } from '../src/harnesses/roster-text.js'

const script = fileURLToPath(new URL('../../plugin/hooks/roster.py', import.meta.url))
const hasPython = (() => {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

// What roster.py prints for {"agents": agents} with SILOS_AGENT_ID=me and
// --cwd ('' when it prints nothing), minus print()'s newline — the shell's $(...) drops it too.
function python(agents: unknown[], me: string, cwd = ''): string {
  let out = ''
  try {
    out = execFileSync('python3', [script, ...(cwd ? ['--cwd', cwd] : [])], {
      input: JSON.stringify({ agents }),
      env: { ...process.env, SILOS_AGENT_ID: me },
      encoding: 'utf8',
    })
  } catch (e) {
    out = (e as { stdout?: string }).stdout ?? ''
  }
  return out.replace(/\n$/, '')
}

// two businesses on one install: acme (builder, finance, ops nested in it),
// beta (maker), scribe of both; a sibling folder that shares a prefix
const A = { id: 'builder', name: 'Builder', emoji: '🛠', folder: '/home/user/acme', skills: [], mission: { text: 'Builds the product. And more.' } }
const F = {
  id: 'finance',
  name: 'Finance',
  emoji: '🧮',
  folder: '/home/user/acme/',
  folders: ['/home/user/acme-ops'],
  skills: [],
  mission: { text: 'Keeps the books and files the taxes.' },
}
const O = { id: 'ops', name: 'Ops', emoji: '', folder: '/home/user/acme/ops', skills: [] }
const M = { id: 'maker', name: 'Maker', emoji: '', folder: '/home/user/beta', skills: [], mission: { text: 'Makes beta.' } }
const S = { id: 'scribe', name: 'Scribe', emoji: '', folder: '/home/user/acme/docs', folders: ['/home/user/beta'], skills: [] }
const W = { id: 'web', name: 'Web', emoji: '', folder: '/home/user/acme-web', skills: [] }
const ARCH = { id: 'gone', name: 'Gone', emoji: '', folder: '/home/user/acme', skills: [], archived: true }
const MASTER = { id: 'master', name: 'Master', emoji: '★', folder: null, skills: [] }
const mixed = [MASTER, A, F, O, M, S, W, ARCH]
// the API's scoped answer to builder's bearer: its record + rows with the
// folders they share
const scoped = [
  A,
  { id: 'finance', name: 'Finance', emoji: '🧮', folders: ['/home/user/acme'], mission: { text: 'Keeps the books and files the taxes.' } },
  { id: 'ops', name: 'Ops', emoji: '', folders: ['/home/user/acme/ops'], mission: { text: '' } },
  { id: 'scribe', name: 'Scribe', emoji: '', folders: ['/home/user/acme/docs'], mission: { text: '' } },
]

const cases: Array<[string, unknown[], string, string?]> = [
  ['mixed install, me = builder', mixed, 'builder'],
  ['mixed install, me = finance (two projects kept apart)', mixed, 'finance'],
  ['mixed install, me = maker', mixed, 'maker'],
  ['mixed install, me = scribe (a bridge)', mixed, 'scribe'],
  ['mixed install, me = web (alone)', mixed, 'web'],
  ['mixed install, me = gone (archived)', mixed, 'gone'],
  ['mixed install, me = an unknown id', mixed, 'nobody'],
  ['no identity, in acme/src', mixed, '', '/home/user/acme/src'],
  ['no identity, in beta', mixed, '', '/home/user/beta/'],
  ["no identity, nobody's folder", mixed, '', '/home/user/other'],
  ['no identity, no cwd', mixed, ''],
  ['master in acme', mixed, 'master', '/home/user/acme'],
  ['master at /', mixed, 'master', '/'],
  ['non-object entries ignored', [null, 3, 'x', A, F], 'builder'],
  [
    'mission shapes',
    [
      { id: 'asks', name: 'Asks', emoji: '', folder: '/a', skills: [], mission: { text: '  Who pays?  Then  the rest.' } },
      { id: 'blank', name: 'Blank', emoji: '', folder: '/a/b', skills: [], mission: { text: '' } },
      { id: 'odd', name: 'Odd', emoji: '', folder: '/a', skills: [], mission: 'a string' },
      { id: 'listy', name: 'Listy', emoji: '', folder: '/a', skills: [], mission: ['x'] },
      { id: 'nm', emoji: '', folder: '/a', folders: '/a/x', skills: [], responsibility: 'old duty', role: 'old role' },
    ],
    'asks',
  ],
  // bounded (the hook's output is capped): 12 agents, then «N more»; each
  // line cut at 160 characters (code points, emoji included)
  [
    'a project longer than the list',
    Array.from({ length: 15 }, (_, i) => ({ id: `a${i}`, name: `A${i}`, emoji: '🛠', folder: `/f/${i}`, folders: ['/f'], skills: [] })),
    'a14',
  ],
  ['a line longer than the cut', [A, { ...F, emoji: '🛠', mission: { text: `${'é🛠'.repeat(120)}.`, never: [] } }], 'builder'],
  ["the API's scoped answer", scoped, 'builder'],
]

describe('rosterText', () => {
  it('an agent is told the agents of its projects, by the folders they share', () => {
    expect(rosterText(mixed as never, 'builder', { withBearer: true })).toBe(
      [
        'Your projects (Silos): /home/user/acme',
        'Agents who work there with you:',
        '- 🧮 Finance — in /home/user/acme — Keeps the books and files the taxes.',
        '- Ops — in /home/user/acme/ops',
        '- Scribe — in /home/user/acme/docs',
        'You are Builder. For work in a folder that is theirs and not yours, message that agent (see "Messages" below). Outside your projects there is nobody for you to reach: ask the owner. Do not work outside your projects.',
      ].join('\n'),
    )
  })
  it('never transitive: the bridge knows both sides, each side only the bridge', () => {
    const maker = rosterText(mixed as never, 'maker', { withBearer: true })
    expect(maker).toContain('- Scribe — in /home/user/beta')
    for (const other of ['Builder', 'Finance', 'Ops', 'Web', '/home/user/acme']) expect(maker).not.toContain(other)
    const scribe = rosterText(mixed as never, 'scribe', { withBearer: true })
    for (const both of ['Builder', 'Finance', 'Maker']) expect(scribe).toContain(both)
    expect(scribe.split('\n').at(-1)).toBe(
      "Your projects are kept apart: do not carry one project's matters, files or messages into another unless the owner asks.",
    )
    // one project nested in another is not «kept apart»
    expect(rosterText(mixed as never, 'builder', { withBearer: true })).not.toContain('kept apart')
  })
  it('alone: the wall, no list', () => {
    expect(rosterText(mixed as never, 'web', { withBearer: true })).toBe(
      [
        'Your projects (Silos): /home/user/acme-web',
        'You are Web, the only agent there. Outside your projects there is nobody for you to reach: ask the owner. Do not work outside your projects.',
      ].join('\n'),
    )
  })
  it("no identity and the owner's desk: the agents of the folder it runs in", () => {
    const here = rosterText(mixed as never, '', { withBearer: false, cwd: '/home/user/beta' })
    expect(here).toBe(["This folder's agents (Silos):", '- Maker — in /home/user/beta — Makes beta.', '- Scribe — in /home/user/beta'].join('\n'))
    expect(rosterText(mixed as never, 'master', { withBearer: true, cwd: '/home/user/beta/src' })).toBe(here)
    expect(rosterText(mixed as never, '', { withBearer: false, cwd: '/home/user/other' })).toBe('')
    expect(rosterText(mixed as never, '', { withBearer: false })).toBe('')
  })
  it('lists 12 agents, then how many more and where; cuts a long line', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ id: `a${i}`, name: `A${i}`, emoji: '', folder: `/f/${i}`, folders: ['/f'], skills: [] }))
    const lines = rosterText(many as never, 'a0', { withBearer: true }).split('\n')
    expect(lines).toHaveLength(1 + 1 + 12 + 1 + 1)
    expect(lines.at(-2)).toBe('- … and 2 more — GET ${SILOS_API:-http://127.0.0.1:3210}/api/agents')
    const long = rosterText([A, { ...F, mission: { text: 'x'.repeat(400), never: [] } }] as never, 'builder', { withBearer: true }).split('\n')[2]!
    expect(Array.from(long)).toHaveLength(160)
    expect(long.endsWith('…')).toBe(true)
  })
  for (const [name, agents, me, cwd] of cases) {
    it.skipIf(!hasPython)(`matches roster.py: ${name}`, () => {
      for (const withBearer of [true, false]) expect(rosterText(agents as never, me, { withBearer, cwd: cwd ?? null })).toBe(python(agents, me, cwd ?? ''))
    })
  }
  it.skipIf(!hasPython)("the raw agents.json and the API's scoped answer give the same bytes", () => {
    expect(python(scoped, 'builder')).toBe(python(mixed, 'builder'))
    expect(rosterText(scoped as never, 'builder', { withBearer: true })).toBe(rosterText(mixed as never, 'builder', { withBearer: true }))
  })
})
