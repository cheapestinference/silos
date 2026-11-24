import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../src/lib/api')
import { api } from '../src/lib/api'
import { resetConversationRefs } from '../src/lib/conversation-refs'
import { registerConversationLinks } from '../src/lib/terminal-conversation-links'
import { useStore } from '../src/store'
import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'

const mocked = vi.mocked(api, { deep: true })

// a terminal line as xterm holds it: one cell per column, a wide glyph is a
// width-2 cell followed by a width-0 one
function fakeTerm(cells: { ch: string; w: number }[]): { term: Terminal; provider: () => ILinkProvider } {
  let p: ILinkProvider | null = null
  const line = { length: cells.length, getCell: (x: number) => ({ getChars: () => cells[x]!.ch, getWidth: () => cells[x]!.w }) }
  const term = {
    buffer: { active: { getLine: (y: number) => (y === 0 ? line : undefined) } },
    registerLinkProvider: (prov: ILinkProvider) => {
      p = prov
      return { dispose: () => {} }
    },
  } as unknown as Terminal
  return { term, provider: () => p! }
}
const cellsOf = (s: string) =>
  [...s]
    .map((ch) =>
      ch === '🧭'
        ? [
            { ch, w: 2 },
            { ch: '', w: 0 },
          ]
        : [{ ch, w: 1 }],
    )
    .flat()

describe('the console: a session name the TUI prints is a link to its conversation', () => {
  beforeEach(() => {
    resetConversationRefs()
    vi.clearAllMocks()
    mocked.conversationRefs.mockResolvedValue({ 'silos-3d': { sessionId: 'S', folder: 'F', agentId: 'silos', title: 'Reconnect loop', live: true } })
  })
  it("the range covers the name's cells even after a wide glyph; a click opens it; unknown names give no link", async () => {
    const open = vi.fn().mockResolvedValue(undefined)
    useStore.setState({ agents: [], openSession: open } as never)
    const { term, provider } = fakeTerm(cellsOf('🧭 ask silos-3d or silos-99'))
    registerConversationLinks(term)
    const links = await new Promise<ILink[] | undefined>((r) => provider().provideLinks(1, r))
    expect(links).toHaveLength(1)
    // '🧭' takes cells 0-1, ' ' 2, 'ask' 3-5, ' ' 6 → 'silos-3d' starts at cell 7 (x is 1-based)
    expect(links![0]!.range).toEqual({ start: { x: 8, y: 1 }, end: { x: 15, y: 1 } })
    links![0]!.activate(new MouseEvent('click'), 'silos-3d')
    expect(open).toHaveBeenCalledWith('F', 'S')
  })
  it('a line with no candidates asks nothing', async () => {
    const { term, provider } = fakeTerm(cellsOf('just output'))
    registerConversationLinks(term)
    expect(await new Promise((r) => provider().provideLinks(1, r))).toBeUndefined()
    expect(mocked.conversationRefs).not.toHaveBeenCalled()
  })
})
