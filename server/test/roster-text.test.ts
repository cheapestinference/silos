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

// What roster.py prints for {"agents": agents} with SILOS_AGENT_ID=me
// ('' when it prints nothing), minus print()'s newline — the shell's $(...) drops it too.
function python(agents: unknown[], me: string): string {
  let out = ''
  try {
    out = execFileSync('python3', [script], { input: JSON.stringify({ agents }), env: { ...process.env, SILOS_AGENT_ID: me }, encoding: 'utf8' })
  } catch (e) {
    out = (e as { stdout?: string }).stdout ?? ''
  }
  return out.replace(/\n$/, '')
}

const builder = {
  id: 'builder',
  name: 'Builder',
  emoji: '🛠',
  folder: '/home/u/ci',
  folders: ['/home/u/builder', ''],
  skills: [],
  mission: { text: 'Keep  the VPS\nalive. Deploys too!', never: ['delete backups'], updatedAt: '2026-11-10T00:00:00Z' },
}
const finance = { id: 'finance', name: 'Finance', emoji: '', folder: '/home/u/ci', skills: [] }
const master = { id: 'master', name: 'Master', emoji: '★', folder: null, skills: [] }
const old = { id: 'old', name: 'Old', emoji: '', folder: '/o', archived: true, skills: [] }
const nofolder = { id: 'nf', emoji: '', folder: null, skills: [], mission: { text: 'Answers the inbox', never: [] } }
// mission shapes the two renderers must read alike: no sentence end, a
// question first, an empty text, and malformed values
const asks = { id: 'asks', name: 'Asks', emoji: '', folder: '/a', skills: [], mission: { text: '  Who pays?  Then  the rest.' } }
const blank = { id: 'blank', name: 'Blank', emoji: '', folder: '/b', skills: [], mission: { text: '' } }
const odd = { id: 'odd', name: 'Odd', emoji: '', folder: '/c', skills: [], mission: 'a string, not a mission' }
const listy = { id: 'listy', name: 'Listy', emoji: '', folder: '/d', skills: [], mission: ['x'] }
// a responsibility (the old duty, alive until t3) is never said any more
const duty = { id: 'duty', name: 'Duty', emoji: '', folder: '/e', skills: [], responsibility: 'old duty', role: 'old role' }

const cases: Array<[string, unknown[], string]> = [
  ['two agents, me = builder', [builder, finance], 'builder'],
  ['two agents, me = finance', [builder, finance], 'finance'],
  ['no identity', [builder, finance], ''],
  ['master and archived are left out; master gets no territory line', [master, builder, old, finance], 'master'],
  ['archived me still gets its line', [builder, old], 'old'],
  ['agent without folders and without name', [builder, nofolder], 'nf'],
  ['nothing to list prints nothing', [master, old], 'builder'],
  ['non-object entries ignored', [null, 3, 'x', builder], 'builder'],
  ['mission shapes', [asks, blank, odd, listy, duty], 'asks'],
  // bounded (the hook's output is capped): 12 agents, then «N more»; each
  // line cut at 160 characters (code points, emoji included)
  ['a fleet longer than the list', Array.from({ length: 15 }, (_, i) => ({ id: `a${i}`, name: `A${i}`, emoji: '🛠', folder: `/f${i}`, skills: [] })), 'a14'],
  ['a line longer than the cut', [{ ...builder, emoji: '🛠', mission: { text: `${'é🛠'.repeat(120)}.`, never: [] } }], 'builder'],
]

describe('rosterText', () => {
  it('pins the two-agent rendering', () => {
    expect(rosterText([builder, finance] as never, 'builder', { withBearer: true })).toBe(
      [
        'Your fleet (Silos):',
        '- 🛠 Builder — in /home/u/ci, /home/u/builder — Keep the VPS alive.',
        '- Finance — in /home/u/ci',
        'You are Builder. Your territory: /home/u/ci, /home/u/builder. To get something done elsewhere, message its agent (see "Messages" below); do not work there.',
      ].join('\n'),
    )
    expect(rosterText([master, old] as never, 'builder', { withBearer: false })).toBe('')
  })
  it('says the first sentence of each mission, never a role or a responsibility', () => {
    expect(rosterText([asks, blank, odd, nofolder, duty] as never, '', { withBearer: true })).toBe(
      ['Your fleet (Silos):', '- Asks — in /a — Who pays?', '- Blank — in /b', '- Odd — in /c', '- nf — Answers the inbox', '- Duty — in /e'].join('\n'),
    )
  })
  it('lists 12 agents, then how many more and where the whole fleet is; cuts a long line', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ id: `a${i}`, name: `A${i}`, emoji: '', folder: `/f${i}`, skills: [] }))
    const lines = rosterText(many as never, '', { withBearer: true }).split('\n')
    expect(lines).toHaveLength(1 + 12 + 1)
    expect(lines.at(-1)).toBe('- … and 3 more — the whole fleet: GET ${SILOS_API:-http://127.0.0.1:3210}/api/agents')
    const long = rosterText([{ ...builder, mission: { text: 'x'.repeat(400), never: [] } }] as never, '', { withBearer: true }).split('\n')[1]!
    expect(Array.from(long)).toHaveLength(160)
    expect(long.endsWith('…')).toBe(true)
  })
  for (const [name, agents, me] of cases) {
    it.skipIf(!hasPython)(`matches roster.py: ${name}`, () => {
      for (const withBearer of [true, false]) expect(rosterText(agents as never, me, { withBearer })).toBe(python(agents, me))
    })
  }
})
