// fence-refusals.test.ts — Settings › Territory's «N refused in beta ›»: each
// reader records a refused call as its time and the path its own input
// named (never the refusal text, the command, contents or output), and the
// count buckets those paths by project (project-scope.ts projectOfPath; no
// project → elsewhere). Generic data only.
import { describe, expect, it } from 'vitest'
import { ContextAccumulator } from '../src/harnesses/claude-code/context.js'
import { refusedSince } from '../src/fence-refusals.js'
import { projectOfPath } from '../src/project-scope.js'
import { refusedPathOf } from '../src/territory.js'

const line = (o: unknown): string => JSON.stringify(o)
const call = (id: string, name: string, input: Record<string, unknown>, ts: string, result: string, isError: boolean): string[] => [
  line({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }),
  line({
    type: 'user',
    timestamp: ts,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result, ...(isError ? { is_error: true } : {}) }] },
  }),
]

describe('projectOfPath — the project a refused path lies in', () => {
  const folders = ['/home/user/acme', '/home/user/acme/web', '/home/user/beta']
  it('the outermost folder that holds it; a sibling prefix, a parent and a dotfile are no project', () => {
    expect(projectOfPath('/home/user/acme/web/src/a.ts', folders)).toBe('/home/user/acme')
    expect(projectOfPath('/home/user/beta', folders)).toBe('/home/user/beta')
    expect(projectOfPath('/home/user/acme-web/a', folders)).toBeNull()
    expect(projectOfPath('/home/user', folders)).toBeNull()
    expect(projectOfPath('/home/user/.ssh/id_ed25519', folders)).toBeNull()
  })
})

describe('refusedPathOf — the path only, never what could carry a secret', () => {
  it('a file tool its path; a search its folder; a command the first absolute path it names, without the rest', () => {
    expect(refusedPathOf('Read', { file_path: '/home/user/beta/notes.md' })).toBe('/home/user/beta/notes.md')
    expect(refusedPathOf('Grep', { pattern: 'TOKEN=', path: '/home/user/beta/' })).toBe('/home/user/beta')
    expect(refusedPathOf('read', { filePath: '/home/user/beta/a.ts' })).toBe('/home/user/beta/a.ts')
    expect(refusedPathOf('Bash', { command: 'cat /home/user/beta/.env | grep API_KEY=sk_live_123' })).toBe('/home/user/beta/.env')
    expect(refusedPathOf('Bash', { command: 'echo hello' })).toBeNull()
    expect(refusedPathOf('WebFetch', { url: 'https://example.com/x' })).toBeNull()
  })
})

describe('Claude Code: the reader records a refused call — time and path, nothing else', () => {
  it('counts whole refusal shapes on is_error results; a file quoting the phrase is no refusal; no text, command or output kept', () => {
    const acc = new ContextAccumulator()
    acc.feedLines([
      ...call(
        't1',
        'Read',
        { file_path: '/home/user/beta/secret.md' },
        '2026-11-24T09:00:00Z',
        '<tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>',
        true,
      ),
      ...call(
        't2',
        'Bash',
        { command: 'cat /home/user/beta/.env | grep API_KEY=sk_live_123' },
        '2026-11-24T09:05:00Z',
        'Permission to use Bash with command cat /home/user/beta/.env | grep API_KEY=sk_live_123 has been denied.',
        true,
      ),
      // a file whose CONTENT quotes the phrase: read fine, not refused
      ...call(
        't3',
        'Read',
        { file_path: '/home/user/acme/docs.md' },
        '2026-11-24T09:06:00Z',
        'File is in a directory that is denied by your permission settings.',
        false,
      ),
      // another error: not a refusal
      ...call('t4', 'Read', { file_path: '/home/user/acme/missing.md' }, '2026-11-24T09:07:00Z', 'File does not exist.', true),
    ])
    const refused = acc.state.refused
    expect(refused).toEqual([
      { at: '2026-11-24T09:00:00Z', path: '/home/user/beta/secret.md' },
      { at: '2026-11-24T09:05:00Z', path: '/home/user/beta/.env' },
    ])
    const kept = JSON.stringify(refused)
    expect(kept).not.toContain('API_KEY')
    expect(kept).not.toContain('sk_live')
    expect(kept).not.toContain('denied')
    // what the cache keeps comes back as it was
    expect(new ContextAccumulator(acc.state).state.refused).toEqual(refused)
  })
})

describe('refusedSince — per agent, per project, today only', () => {
  const agents = [
    { id: 'builder', folder: '/home/user/acme' },
    { id: 'maker', folder: '/home/user/beta' },
    { id: 'old', folder: '/home/user/gone', archived: true },
  ]
  const ctx: Record<string, { refused: { at: string; path: string | null }[] }> = {
    'f/s1': {
      refused: [
        { at: '2026-11-24T09:00:00Z', path: '/home/user/beta/a' },
        { at: '2026-11-24T10:00:00Z', path: '/home/user/beta/b' },
        { at: '2026-11-23T10:00:00Z', path: '/home/user/beta/yesterday' },
        { at: '2026-11-24T11:00:00Z', path: '/home/user/.aws/credentials' },
        { at: '2026-11-24T11:30:00Z', path: null },
        // an archived agent's folder is no project any more
        { at: '2026-11-24T11:40:00Z', path: '/home/user/gone/x' },
      ],
    },
    'f/s2': { refused: [{ at: '2026-11-24T12:00:00Z', path: '/home/user/beta/c' }] },
    'f/s3': { refused: [{ at: '2026-11-24T12:00:00Z', path: '/home/user/acme/x' }] },
  }
  const sessions = [
    { folder: 'f', id: 's1', agentId: 'builder' },
    { folder: 'f', id: 's2', agentId: 'builder' },
    { folder: 'f', id: 's3', agentId: 'maker' },
    { folder: 'f', id: 's4', agentId: null },
  ]
  const since = Date.parse('2026-11-24T00:00:00Z')
  const read = refusedSince(sessions, (f, i) => ctx[`${f}/${i}`] ?? null, agents, since)

  it("counts each agent's refusals since the start of the day, bucketed by the project the path lies in", () => {
    const builder = read.find((a) => a.agentId === 'builder')!
    expect(builder.total).toBe(6)
    expect(builder.buckets.map((b) => [b.project, b.count])).toEqual([
      ['/home/user/beta', 3],
      [null, 3],
    ])
    // the door: the conversations where it happened, newest first
    expect(builder.buckets[0]!.conversations.map((c) => [c.id, c.count])).toEqual([
      ['s2', 1],
      ['s1', 2],
    ])
    expect(read.find((a) => a.agentId === 'maker')!.buckets).toEqual([
      { project: '/home/user/acme', count: 1, conversations: [{ folder: 'f', id: 's3', count: 1, lastAt: '2026-11-24T12:00:00Z' }] },
    ])
  })
  it('an agent with nothing refused today is absent', () => {
    expect(refusedSince(sessions, (f, i) => ctx[`${f}/${i}`] ?? null, agents, Date.parse('2026-11-25T00:00:00Z'))).toEqual([])
  })
})
