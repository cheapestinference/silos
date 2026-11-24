// Auto-resume + nudge: the LIMIT banner gains a reassurance line ("Silos
// will resume this automatically at <time>") ONLY when a resume is genuinely
// scheduled (a live-proof rule), a "Cancel", and a nudge toward
// cheapestinference that hides if the agent already uses it.
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Turn, type LimitBannerInfo } from '../src/components/Turn'
import { Transcript } from '../src/components/Transcript'
import { useStore } from '../src/store'
import { resetTime } from '../src/lib/rate-limits'
import { agentOnCheapest, isCheapestProvider, CHEAPESTINFERENCE_BASE_URL } from '../src/lib/providers'
import type { AgentView, PendingResume, ProviderView, SessionDetail, Turn as TurnType } from '../src/lib/types'

function limitTurn(): TurnType {
  return { index: 0, role: 'assistant', text: "You've hit your session limit · resets 4pm (Europe/Berlin)", tools: [], ts: null, synthetic: true }
}

const RESUME: NonNullable<LimitBannerInfo['resume']> = { resetsAt: '2026-08-21T16:00:00.000Z', folder: 'f', sessionId: 's1' }

describe('the limit banner — the resume reassurance', () => {
  it('with a scheduled resume: shows "Silos will resume this automatically at <time>" + Cancel', () => {
    render(<Turn turn={limitTurn()} limit={{ resume: RESUME, nudge: false }} />)
    expect(screen.getByText(/Silos will resume this automatically at/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('with NO scheduled resume: does NOT claim it will resume (a live-proof rule)', () => {
    render(<Turn turn={limitTurn()} limit={{ nudge: false }} />)
    expect(screen.queryByText(/will resume this automatically/)).not.toBeInTheDocument()
    expect(screen.queryByText(/will continue this on/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
  })

  it('with a fallback: the copy says "continuing on <provider>", not a reset time', () => {
    render(<Turn turn={limitTurn()} limit={{ resume: { ...RESUME, fallbackLabel: 'cheapestinference' }, nudge: false }} />)
    expect(screen.getByText(/continue this on cheapestinference/)).toBeInTheDocument()
    expect(screen.queryByText(/will resume this automatically at/)).not.toBeInTheDocument()
  })

  it('a gaveUp record → an honest TERMINAL message + Dismiss, NOT "will resume"', () => {
    render(<Turn turn={limitTurn()} limit={{ resume: { ...RESUME, gaveUp: { tries: 5 } }, nudge: false }} />)
    expect(screen.getByText(/5 tries/)).toBeInTheDocument()
    expect(screen.queryByText(/will resume this automatically/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
  })

  it('gaveUp with tries 0 (an unrecoverable destination) → a message with no "after N tries"', () => {
    render(<Turn turn={limitTurn()} limit={{ resume: { ...RESUME, gaveUp: { tries: 0 } }, nudge: true }} />)
    expect(screen.getByText(/Couldn't resume automatically/)).not.toHaveTextContent(/\d+ tries/)
    // the nudge still makes sense in the terminal state (it's when it matters most)
    expect(screen.getByText(/Tired of waiting\?/)).toBeInTheDocument()
  })

  it('Cancel calls cancelPendingResume with folder/sessionId', () => {
    const spy = vi.fn()
    useStore.setState({ cancelPendingResume: spy as unknown as (f: string, i: string) => Promise<void> })
    render(<Turn turn={limitTurn()} limit={{ resume: RESUME, nudge: false }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(spy).toHaveBeenCalledWith('f', 's1')
  })
})

describe('the limit banner — the cheapestinference nudge', () => {
  it('nudge:false → no wink', () => {
    render(<Turn turn={limitTurn()} limit={{ nudge: false }} />)
    expect(screen.queryByText(/Tired of waiting\?/)).not.toBeInTheDocument()
  })

  it("the nudge's link navigates to Settings › Accounts & providers", () => {
    const spy = vi.fn()
    useStore.setState({ changePage: spy as unknown as (p: unknown) => void })
    render(<Turn turn={limitTurn()} limit={{ nudge: true }} />)
    fireEvent.click(screen.getByRole('button', { name: /Skip limits with cheapestinference/ }))
    expect(spy).toHaveBeenCalledWith({ kind: 'settings', tab: 'accounts' })
  })
})

describe('the limit banner — only hangs off the LIMIT notice', () => {
  it('an API error (not a limit) shows neither reassurance nor nudge, even with limitInfo present', () => {
    const apiErr: TurnType = { index: 0, role: 'assistant', text: 'API Error: 529 Overloaded.', tools: [], ts: null, synthetic: true }
    render(<Turn turn={apiErr} limit={{ resume: RESUME, nudge: true }} />)
    expect(screen.getByText('api error')).toBeInTheDocument()
    expect(screen.queryByText(/will resume this automatically/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Tired of waiting\?/)).not.toBeInTheDocument()
  })
})

// real integration: Transcript derives limitInfo from the store
// (pendingResumes + providers + agent) and passes it to the synthetic
// notice's Turn.
describe("Transcript — the limit banner with the store's real state", () => {
  const agent: AgentView = { id: 'a1', name: 'Ana', emoji: '🧠', folder: '/x', skills: [], sessions: [], liveCount: 0, sessionCount: 0 }
  const limitTurnDetail = (): SessionDetail => ({
    meta: {
      id: 's1',
      folder: 'f',
      title: 'S',
      skills: [],
      cwd: null,
      mtime: 1,
      size: 1,
      turnCount: 1,
      live: false,
      worktree: false,
      native: true,
      agentId: 'a1',
      titleOrigin: 'raw',
    },
    turns: [{ index: 0, role: 'assistant', text: "You've hit your session limit · resets 4pm", tools: [], ts: null, synthetic: true }],
    total: 1,
  })
  const pr = (): PendingResume => ({
    agentId: 'a1',
    folder: 'f',
    sessionId: 's1',
    text: 'continue',
    resetsAt: '2026-08-21T16:00:00.000Z',
    resumeAt: '2026-08-21T16:00:00.000Z',
    createdAt: 'x',
    attempts: 0,
  })

  function seed(over: Partial<Parameters<typeof useStore.setState>[0]> = {}): void {
    useStore.setState({
      agents: [agent],
      warming: false,
      selectedAgentId: 'a1',
      selected: { folder: 'f', id: 's1' },
      detail: limitTurnDetail(),
      filter: '',
      active: null,
      execOut: null,
      modal: null,
      error: null,
      userTextPersisted: false,
      receipts: {},
      pendingResumes: {},
      providers: [],
      ...over,
    })
  }

  it('with a resume in the store for this conversation → the reassurance appears; the default nudge (an agent on default)', () => {
    seed({ pendingResumes: { 'f/s1': pr() } })
    render(<Transcript />)
    expect(screen.getByText(/Silos will resume this automatically at/)).toBeInTheDocument()
    expect(screen.getByText(/Tired of waiting\?/)).toBeInTheDocument() // an agent on default → gets nudged
  })

  it('with no resume in the store → no reassurance (but the nudge still shows, the limit painted)', () => {
    seed({ pendingResumes: {} })
    render(<Transcript />)
    expect(screen.queryByText(/will resume this automatically/)).not.toBeInTheDocument()
    expect(screen.getByText(/Tired of waiting\?/)).toBeInTheDocument()
  })

  it('an agent ALREADY on cheapestinference → no nudge', () => {
    const ci: ProviderView = {
      id: 'p1',
      kind: 'anthropic-compatible',
      label: 'ci',
      baseUrl: CHEAPESTINFERENCE_BASE_URL,
      apiKey: 'sk-…',
      createdAt: 'x',
      window: null,
    }
    seed({ agents: [{ ...agent, provider: 'p1' }], providers: [ci], pendingResumes: {} })
    render(<Transcript />)
    expect(screen.queryByText(/Tired of waiting\?/)).not.toBeInTheDocument()
  })
})

describe('auto-resume helpers', () => {
  it('resetTime: a reset within 24h → just the time (no day)', () => {
    const now = Date.parse('2026-08-21T12:00:00.000Z')
    const reset = '2026-08-21T16:00:00.000Z'
    const expected = new Date(reset).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    expect(resetTime(reset, now)).toBe(expected)
  })

  it('resetTime: a reset more than 24h out → prepends the weekday', () => {
    const now = Date.parse('2026-08-21T12:00:00.000Z')
    const reset = '2026-08-25T16:00:00.000Z' // >24h
    const out = resetTime(reset, now)!
    const day = new Date(reset).toLocaleDateString(undefined, { weekday: 'short' })
    expect(out.startsWith(day)).toBe(true)
  })

  it('resetTime: an invalid date → null (never promises a made-up time)', () => {
    expect(resetTime('not-a-date')).toBeNull()
  })

  it('isCheapestProvider: an exact match on baseUrl, not a substring', () => {
    const ci: ProviderView = {
      id: 'p1',
      kind: 'anthropic-compatible',
      label: 'ci',
      baseUrl: CHEAPESTINFERENCE_BASE_URL,
      apiKey: 'sk-…',
      createdAt: 'x',
      window: null,
    }
    const evil: ProviderView = {
      id: 'p2',
      kind: 'anthropic-compatible',
      label: 'evil',
      baseUrl: 'https://api.cheapestinference.com.evil.io/anthropic',
      apiKey: 'sk-…',
      createdAt: 'x',
      window: null,
    }
    expect(isCheapestProvider(ci)).toBe(true)
    expect(isCheapestProvider(evil)).toBe(false)
  })

  it("agentOnCheapest: true if the agent's provider resolves to cheapest; false with the default", () => {
    const ci: ProviderView = {
      id: 'p1',
      kind: 'anthropic-compatible',
      label: 'ci',
      baseUrl: CHEAPESTINFERENCE_BASE_URL,
      apiKey: 'sk-…',
      createdAt: 'x',
      window: null,
    }
    expect(agentOnCheapest({ provider: 'p1' }, [ci])).toBe(true)
    expect(agentOnCheapest({ provider: undefined }, [ci])).toBe(false) // default → Anthropic
    expect(agentOnCheapest({ provider: 'other' }, [ci])).toBe(false)
    // an in-progress fallback also counts
    expect(agentOnCheapest({ onFallback: { providerId: 'p1', from: 'default', until: 'x' } }, [ci])).toBe(true)
  })
})
