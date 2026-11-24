// loaded-at-start.test.tsx — Knows › At start: the pure
// grouping (one row per plugin/settings file/Silos, sizes only when seen)
// and the row as drawn — every part only when it has something, the
// subfolder files and plugin servers folded, the Tools door only when the
// engine says Tools governs its servers.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { LoadedAtStartRow } from '../src/components/agent/LoadedAtStartRow'
import { useStore } from '../src/store'
import {
  formatChars,
  formatFileSize,
  injectionRows,
  instructionGroups,
  isEmptyLoaded,
  mcpGroups,
  observedTotal,
  serverCounts,
} from '../src/lib/loaded-at-start'
import type { LoadedAtStart, LoadedInjection } from '../src/lib/types'

vi.mock('../src/lib/api')

const inj = (over: Partial<LoadedInjection>): LoadedInjection => ({ origin: 'plugin', name: 'p', on: [], command: 'c', file: '/f', ...over })
const seen = (chars: number, excerpt = 'x') => ({ chars, excerpt, at: 1 })

const loaded = (over: Partial<LoadedAtStart> = {}): LoadedAtStart => ({
  engine: 'Claude Code',
  folder: '/proj',
  instructions: [],
  injections: [],
  outputStyle: null,
  mcp: [],
  toolsDoor: true,
  notes: [],
  ...over,
})

beforeEach(() => {
  vi.resetAllMocks()
})

describe('loaded-at-start derivations', () => {
  it('one row per origin+name: hook counts, sizes summed only from what was seen, the longest excerpt', () => {
    const rows = injectionRows([
      inj({ name: 'claude-mem', command: 'start', on: ['startup', 'clear'], seen: seen(0, '') }),
      inj({ name: 'claude-mem', command: 'context', on: ['startup', 'compact'], seen: seen(7046, 'recent context') }),
      inj({ name: 'security-guidance', command: 's' }),
      inj({ origin: 'silos', name: 'Silos briefing', command: 'b', seen: { chars: 5, excerpt: 'hi', at: 1, failed: true } }),
      inj({ name: 'x-output-style', outputStyle: true, seen: seen(1018) }),
    ])
    expect(rows.map((r) => [r.name, r.hooks, r.on, r.chars, r.excerpt, r.failed, r.outputStyle])).toEqual([
      ['claude-mem', 2, ['startup', 'clear', 'compact'], 7046, 'recent context', false, false],
      ['security-guidance', 1, [], null, '', false, false],
      ['Silos briefing', 1, [], 5, 'hi', true, false],
      ['x-output-style', 1, [], 1018, 'x', false, true],
    ])
    expect(observedTotal(rows)).toBe(8069)
    expect(observedTotal(injectionRows([inj({})]))).toBeNull()
  })

  it('a hook that fires on every start makes its row fire on every start', () => {
    expect(injectionRows([inj({ on: ['startup'] }), inj({ command: 'd', on: [] })])[0]!.on).toEqual([])
  })

  it('sizes in words', () => {
    expect(formatChars(202)).toBe('202 chars')
    expect(formatChars(3405)).toBe('3.4k chars')
    expect(formatChars(5000)).toBe('5k chars')
    expect(formatChars(17400)).toBe('17k chars')
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(2150)).toBe('2.1 KB')
  })

  it('instructions by when; MCP by source, plugins grouped; empty detection', () => {
    const l = loaded({
      instructions: [
        { path: '/proj/CLAUDE.local.md', rel: 'CLAUDE.local.md', kind: 'local', when: 'start', bytes: 10 },
        { path: '/proj/src/CLAUDE.md', rel: 'src/CLAUDE.md', kind: 'subfolder', when: 'on-demand', under: 'src/', bytes: 169 },
      ],
      mcp: [
        { name: 'railway', source: 'project', from: '~/.claude.json' },
        { name: 'a', source: 'plugin', from: 'pm' },
        { name: 'b', source: 'plugin', from: 'pm' },
        { name: 'slack', source: 'plugin', from: 'design', account: { login: 'sam@example.com' } },
        { name: 'gmail', source: 'plugin', from: 'design', account: { login: 'sam@example.com' }, placeholder: true },
        { name: 'slack', source: 'plugin', from: 'support', account: { login: 'sam@example.com' }, sameAs: 'plugin:design:slack' },
        { name: 'claude_ai_ledgerly', source: 'account', from: 'claude.ai' },
      ],
    })
    expect(instructionGroups(l.instructions).onDemand.map((i) => i.rel)).toEqual(['src/CLAUDE.md'])
    const g = mcpGroups(l.mcp)
    expect(g.configured.map((m) => m.name)).toEqual(['railway'])
    // the machine's plugins apart from the ones the Claude account sends, per login
    expect(g.plugins.map((p) => [p.plugin, p.servers.map((m) => m.name)])).toEqual([['pm', ['a', 'b']]])
    expect(g.accountPlugins.map((a) => [a.login, a.plugins.map((p) => [p.plugin, p.servers.map((m) => m.name)])])).toEqual([
      [
        'sam@example.com',
        [
          ['design', ['slack', 'gmail']],
          ['support', ['slack']],
        ],
      ],
    ])
    expect(serverCounts(g.accountPlugins[0]!.plugins.flatMap((p) => p.servers))).toEqual({ own: 1, placeholders: 1, shared: 1 })
    expect(g.account.map((m) => m.name)).toEqual(['claude_ai_ledgerly'])
    expect(isEmptyLoaded(l)).toBe(false)
    expect(isEmptyLoaded(loaded({ notes: ['only a note'] }))).toBe(true)
  })
})

describe('LoadedAtStartRow', () => {
  it('draws the injections with their size and opening words, and names a plugin standing in for an output style', () => {
    render(
      <LoadedAtStartRow
        agentName="Support"
        onOpenMemory={() => {}}
        loaded={loaded({
          injections: [
            inj({ origin: 'silos', name: 'Silos briefing', on: ['startup', 'resume', 'clear'], seen: seen(5693, '# You are running inside Silos') }),
            inj({ name: 'explanatory-output-style', outputStyle: true, seen: seen(1018, "You are in 'explanatory' output style mode") }),
            inj({ name: 'security-guidance', command: 's' }),
            inj({ name: 'quiet-async', command: 'q', unseenIn: 9 }),
          ],
        })}
      />,
    )
    expect(screen.getByText('prints nothing')).toHaveAttribute('title', expect.stringMatching(/last 9 starts/))
    expect(screen.getAllByTestId('loaded-injection')).toHaveLength(4)
    expect(screen.getByText('5.7k chars')).toBeInTheDocument()
    expect(screen.getByText('on startup, resume, clear')).toBeInTheDocument()
    expect(screen.getByText('“# You are running inside Silos”')).toBeInTheDocument()
    expect(screen.getByText('not seen yet')).toBeInTheDocument()
    expect(screen.getByText(/6\.7k/)).toBeInTheDocument()
    expect(screen.getByText(/acts as one/)).toBeInTheDocument()
  })

  it("a style plugin Silos switches off reads as off, adds nothing to the total, and the agent's style says where it comes from", () => {
    render(
      <LoadedAtStartRow
        agentName="Support"
        onOpenMemory={() => {}}
        loaded={loaded({
          injections: [
            inj({ origin: 'silos', name: 'Silos briefing', seen: seen(5693, '# You are running inside Silos') }),
            inj({ name: 'explanatory-output-style', outputStyle: true, offBySilos: true, seen: seen(1018, "You are in 'explanatory' output style mode") }),
          ],
          outputStyle: { name: 'default', from: "Silos — the agent's default", silos: true },
        })}
      />,
    )
    expect(screen.getByText(/Off in the conversations Silos starts/)).toBeInTheDocument()
    expect(screen.queryByText(/acts as one/)).toBeNull()
    expect(screen.getByText('5.7k chars at its last start')).toBeInTheDocument()
    expect(screen.getByText(/Silos — the agent's default/)).toBeInTheDocument()
  })

  it('instruction files are one door to Memory, their one house', () => {
    const open = vi.fn()
    render(
      <LoadedAtStartRow
        agentName="Finance"
        onOpenMemory={open}
        loaded={loaded({
          instructions: [
            { path: '/proj/CLAUDE.local.md', rel: 'CLAUDE.local.md', kind: 'local', when: 'start', bytes: 2150 },
            { path: '/proj/src/CLAUDE.md', rel: 'src/CLAUDE.md', kind: 'subfolder', when: 'on-demand', under: 'src/', bytes: 169 },
          ],
        })}
      />,
    )
    expect(screen.queryByText('src/CLAUDE.md')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('at-start-instructions'))
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('MCP: configured names, plugin servers folded, connectors as used, and ONE door to the Tools — only when the engine says so', () => {
    const changePage = vi.fn()
    const changeProjectTab = vi.fn()
    useStore.setState({ changePage, changeProjectTab } as never)
    const mcp: LoadedAtStart['mcp'] = [
      { name: 'railway', source: 'project', from: '~/.claude.json' },
      { name: 'notion', source: 'project', from: '~/.claude.json' },
      { name: 'mcp-search', source: 'plugin', from: 'claude-mem' },
      { name: 'ledgerly', source: 'account', from: 'claude.ai' },
    ]
    const { unmount } = render(<LoadedAtStartRow agentName="Finance" onOpenMemory={() => {}} loaded={loaded({ mcp })} />)
    expect(screen.getByText('railway')).toBeInTheDocument()
    expect(screen.getByText('configured for this folder')).toBeInTheDocument()
    expect(screen.queryByText('mcp-search')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /1 from a plugin/ }))
    expect(screen.getByText('mcp-search')).toBeInTheDocument()
    expect(screen.getByText('claude.ai connectors its conversations used')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('loaded-tools-door'))
    expect(changePage).toHaveBeenCalledWith({ kind: 'project', folder: '/proj' })
    expect(changeProjectTab).toHaveBeenCalledWith('tools')
    unmount()
    render(<LoadedAtStartRow agentName="Oc" onOpenMemory={() => {}} loaded={loaded({ engine: 'OpenCode', mcp, toolsDoor: false })} />)
    expect(screen.queryByTestId('loaded-tools-door')).not.toBeInTheDocument()
  })
})
