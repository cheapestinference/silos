// media.test.tsx — multimedia in the transcript: an image pasted in the
// user bubble, a thumbnail in the tool's detail, a lightbox with the Esc
// contract, and the turn window as a materialization boundary (no <img>
// in the DOM outside the window).
import { describe, expect, it, beforeEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Turn, areTurnsEqual } from '../src/components/Turn'
import { Transcript } from '../src/components/Transcript'
import { ToolChip } from '../src/components/ToolChip'
import { MediaScope } from '../src/components/MediaImage'
import { useStore } from '../src/store'
import type { AgentView, SessionDetail, SessionView, Turn as TurnType, TurnImage } from '../src/lib/types'

function makeTurn(overrides: Partial<TurnType> = {}): TurnType {
  return { index: 0, role: 'assistant', text: '', tools: [], ts: null, ...overrides }
}

function makeAgent(): AgentView {
  return { id: 'a1', name: 'Ana', emoji: '🧠', folder: '/x', skills: [], sessions: [], liveCount: 0, sessionCount: 0 }
}

function makeSession(): SessionView {
  return {
    id: 's1',
    folder: 'f',
    title: 'Session',
    skills: [],
    cwd: null,
    mtime: 1_700_000_000_000,
    size: 10,
    turnCount: 1,
    live: false,
    worktree: false,
    native: true,
    agentId: 'a1',
  }
}

function makeDetail(turns: TurnType[]): SessionDetail {
  return { meta: makeSession(), turns, total: turns.length }
}

function resetStore(): void {
  useStore.setState({
    agents: [makeAgent()],
    warming: false,
    selectedAgentId: 'a1',
    selected: { folder: 'f', id: 's1' },
    detail: null,
    filter: '',
    active: null,
    execOut: null,
    modal: null,
    error: null,
    userTextPersisted: false,
    receipts: {},
  })
}

const img: TurnImage = { ref: 'u.uuid-1.0', mediaType: 'image/png', bytes: 3759, w: 96, h: 64 }
const imgTool: TurnImage = { ref: 't.tu1.0', mediaType: 'image/png', bytes: 465, w: 128, h: 80 }

function withScope(ui: React.ReactNode): React.ReactElement {
  return <MediaScope base="/api/sessions/f/s1">{ui}</MediaScope>
}

beforeEach(resetStore)

describe('UserImage in the user bubble', () => {
  it("renders a lazy <img> with the ref's URL and reserves the slot (aspect-ratio)", () => {
    const t = makeTurn({ role: 'user', text: 'what is this?', images: [img] })
    render(withScope(<Turn turn={t} />))
    const el = screen.getByAltText('pasted image')
    expect(el.getAttribute('loading')).toBe('lazy')
    expect(el.getAttribute('src')).toContain('/api/sessions/f/s1/media/u.uuid-1.0')
    // the box reserves the size BEFORE the bitmap loads (bottom-lock)
    const box = el.closest('button')!
    expect(box.style.aspectRatio).toBe('96 / 64')
    expect(screen.getByText('what is this?')).toBeInTheDocument()
  })

  it('a turn that is ONLY an image (empty text) still paints the bubble', () => {
    const t = makeTurn({ role: 'user', text: '', images: [img] })
    render(withScope(<Turn turn={t} />))
    expect(screen.getByAltText('pasted image')).toBeInTheDocument()
  })

  it('with no MediaScope, degrades to a mute label with the weight (never a broken fetch)', () => {
    const t = makeTurn({ role: 'user', text: 'x', images: [img] })
    render(<Turn turn={t} />)
    expect(screen.queryByAltText('pasted image')).not.toBeInTheDocument()
    expect(screen.getByText(/image · 4 KB/)).toBeInTheDocument()
  })
})

describe('ToolThumbnail in the ToolChip detail', () => {
  it('a chip with an image: a glyph on the chip and a thumbnail when expanded; "(no result)" does not lie', () => {
    render(withScope(<ToolChip tool={{ name: 'Read', skill: null, input: '{"file_path":"/shot.png"}', result: '', images: [imgTool] }} />))
    // the glyph warns before expanding
    expect(screen.getByLabelText('has image')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Read/ }))
    const thumb = screen.getByAltText('tool result image')
    expect(thumb.getAttribute('loading')).toBe('lazy')
    expect(thumb.getAttribute('src')).toContain('/media/t.tu1.0')
    // an empty message result + a present image → no "(no result)"
    expect(screen.queryByText('(no result)')).not.toBeInTheDocument()
  })

  it('a chip with no image keeps the usual behavior', () => {
    render(withScope(<ToolChip tool={{ name: 'Bash', skill: null, input: '{}', result: null }} />))
    fireEvent.click(screen.getByRole('button', { name: 'Bash' }))
    expect(screen.getByText('(no result)')).toBeInTheDocument()
  })
})

describe('lightbox', () => {
  it('a click opens the viewer with the full-size image and an honest caption', () => {
    const t = makeTurn({ role: 'user', text: '', images: [img] })
    render(withScope(<Turn turn={t} />))
    fireEvent.click(screen.getByAltText('pasted image').closest('button')!)
    const dialog = screen.getByRole('dialog', { name: 'Image viewer' })
    expect(dialog).toBeInTheDocument()
    expect(screen.getByAltText('full size image').getAttribute('src')).toContain('/media/u.uuid-1.0')
    expect(screen.getByText(/image\/png · 96×64 · 4 KB/)).toBeInTheDocument()
  })

  it('Esc closes the viewer AND calls preventDefault (contract: does not cancel the turn)', () => {
    const t = makeTurn({ role: 'user', text: '', images: [img] })
    render(withScope(<Turn turn={t} />))
    fireEvent.click(screen.getByAltText('pasted image').closest('button')!)
    expect(screen.getByRole('dialog', { name: 'Image viewer' })).toBeInTheDocument()
    const ev = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    act(() => {
      document.dispatchEvent(ev)
    })
    expect(ev.defaultPrevented).toBe(true)
    expect(screen.queryByRole('dialog', { name: 'Image viewer' })).not.toBeInTheDocument()
  })

  it('a click on the background closes it', () => {
    const t = makeTurn({ role: 'user', text: '', images: [img] })
    render(withScope(<Turn turn={t} />))
    fireEvent.click(screen.getByAltText('pasted image').closest('button')!)
    fireEvent.mouseDown(screen.getByRole('dialog', { name: 'Image viewer' }))
    expect(screen.queryByRole('dialog', { name: 'Image viewer' })).not.toBeInTheDocument()
  })
})

describe('the turn window — images outside the window do NOT materialize', () => {
  it('a turn with an image past the cap puts no <img> in the DOM; expanding the window brings it', () => {
    // turn 0 carries the image; 250 more turns follow → the initial
    // window (200) leaves turn 0 out and its <img> must not exist.
    const turns: TurnType[] = [
      makeTurn({ index: 0, role: 'user', text: 'look', images: [img] }),
      ...Array.from({ length: 250 }, (_, i) => makeTurn({ index: i + 1, role: 'assistant', text: `turn ${i + 1}` })),
    ]
    useStore.setState({ detail: makeDetail(turns) })
    render(<Transcript />)
    expect(screen.queryByAltText('pasted image')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show earlier turns' }))
    expect(screen.getByAltText('pasted image')).toBeInTheDocument()
  })
})

describe('areTurnsEqual — images enter the comparator', () => {
  it('the same turn with a new image on the toolUse → re-render', () => {
    const before = makeTurn({
      role: 'assistant',
      text: 'x',
      toolUses: [{ name: 'Read', skill: null, input: '{}', result: null }],
      tools: ['Read'],
    })
    const after = makeTurn({
      role: 'assistant',
      text: 'x',
      toolUses: [{ name: 'Read', skill: null, input: '{}', result: '', images: [imgTool] }],
      tools: ['Read'],
    })
    expect(areTurnsEqual(before, after)).toBe(false)
    expect(areTurnsEqual(before, { ...before })).toBe(true)
  })
})
