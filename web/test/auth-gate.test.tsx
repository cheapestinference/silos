// Remote sign-in (Silos ID, opt-in) — the client's entry gate. The golden rule
// verified here: only the owner credential opens
// the app; with no credential, «Pair this browser» (login disabled) or
// the login screen (login enabled) — cream, wordmark, one action.
// No real network: fetch is mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AuthGate } from '../src/components/AuthGate'
import { LoginView } from '../src/components/LoginView'
import { getGoogleIdentity, setGoogleIdentity, signOutEverywhere } from '../src/lib/auth'
import { getToken, storeToken } from '../src/lib/api'

const CONFIG_ON = { enabled: true, mode: 'silos-id' }

function mockFetch(routes: Record<string, { status: number; body: unknown }>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    for (const [route, r] of Object.entries(routes)) {
      if (url.includes(route)) {
        return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } })
      }
    }
    return new Response('{}', { status: 404 })
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

// nobody is the owner by default — the gate asks
// GET /api/auth/me who THIS browser's credential is; only 'owner' opens
// the app. Without Google login, anything else is «Pair this browser».
describe('AuthGate', () => {
  it('the owner credential (who: owner): straight to the app, whatever the login config', async () => {
    storeToken('valid-token')
    const fetchFn = mockFetch({
      '/api/auth/me': { status: 200, body: { who: 'owner' } },
      '/api/auth/config': { status: 200, body: CONFIG_ON },
    })
    render(
      <AuthGate>
        <div data-testid="app">the app</div>
      </AuthGate>,
    )
    expect(await screen.findByTestId('app')).toBeInTheDocument()
    const meCall = fetchFn.mock.calls.find((c) => String(c[0]).includes('/api/auth/me'))
    expect((meCall?.[1]?.headers as Record<string, string>)['x-token']).toBe('valid-token')
  })

  it('login disabled and NO credential (a local visit, who: unknown): «Pair this browser», never the app', async () => {
    mockFetch({
      '/api/auth/me': { status: 200, body: { who: 'unknown' } },
      '/api/auth/config': { status: 200, body: { enabled: false } },
    })
    render(
      <AuthGate>
        <div data-testid="app">the app</div>
      </AuthGate>,
    )
    expect(await screen.findByRole('heading', { name: 'Pair this browser' })).toBeInTheDocument()
    expect(screen.queryByText('Continue with Google')).not.toBeInTheDocument()
    expect(screen.queryByTestId('app')).not.toBeInTheDocument()
  })

  it('pasting the token from ~/.silos/token pairs the browser: checked by /api/auth/me, stored, the app opens', async () => {
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const t = (init?.headers as Record<string, string> | undefined)?.['x-token']
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.includes('/api/auth/me')) return json({ who: t === 'the-token' ? 'owner' : 'unknown' })
      if (url.includes('/api/auth/config')) return json({ enabled: false })
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fn)
    render(
      <AuthGate>
        <div data-testid="app">the app</div>
      </AuthGate>,
    )
    const field = await screen.findByLabelText('Token from ~/.silos/token')
    await userEvent.type(field, 'wrong')
    await userEvent.click(screen.getByRole('button', { name: 'Pair this browser' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('~/.silos/token')
    expect(getToken()).toBe('')
    await userEvent.clear(field)
    await userEvent.type(field, 'the-token')
    await userEvent.click(screen.getByRole('button', { name: 'Pair this browser' }))
    expect(await screen.findByTestId('app')).toBeInTheDocument()
    expect(getToken()).toBe('the-token')
  })

  it('login enabled and no owner credential: the login screen with a wordmark, one button, and the ?token= hatch', async () => {
    mockFetch({
      '/api/auth/me': { status: 200, body: { who: 'unknown' } },
      '/api/auth/config': { status: 200, body: CONFIG_ON },
    })
    render(
      <AuthGate>
        <div data-testid="app">the app</div>
      </AuthGate>,
    )
    expect(await screen.findByRole('button', { name: /Continue with Google/ })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Silos' })).toBeInTheDocument()
    expect(screen.getByText(/\?token=/)).toBeInTheDocument() // a documented hatch
    expect(screen.queryByTestId('app')).not.toBeInTheDocument()
  })

  it('login enabled with an expired token (who: unknown): back to the gate', async () => {
    storeToken('old-token')
    mockFetch({
      '/api/auth/me': { status: 200, body: { who: 'unknown' } },
      '/api/auth/config': { status: 200, body: CONFIG_ON },
    })
    render(
      <AuthGate>
        <div data-testid="app">the app</div>
      </AuthGate>,
    )
    expect(await screen.findByText('Continue with Google')).toBeInTheDocument()
  })

  it('the server does not answer: the app, with its own error surface', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('down')
      }),
    )
    render(
      <AuthGate>
        <div data-testid="app">the app</div>
      </AuthGate>,
    )
    expect(await screen.findByTestId('app')).toBeInTheDocument()
  })
})

// Silos ID: the way in is picked HERE, on the instance's own page — the
// broker only carries it out
describe('LoginView · Silos ID', () => {
  const started = (): URL => {
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign })
    return new Proxy({} as URL, {
      get: (_t, k) => (new URL(String(assign.mock.calls[0]![0]), 'https://my-silos.example.com') as unknown as Record<string, unknown>)[k as string],
    })
  }
  afterEach(() => vi.unstubAllGlobals())
  it('Google leaves for the broker with the method picked', async () => {
    const to = started()
    render(<LoginView />)
    await userEvent.click(screen.getByRole('button', { name: /Continue with Google/ }))
    expect(to.pathname).toBe('/api/auth/silos-id/start')
    expect(to.searchParams.get('method')).toBe('google')
  })
  it('an email is sent from here: the address goes with the method', async () => {
    const to = started()
    render(<LoginView />)
    await userEvent.click(screen.getByRole('button', { name: /Use email instead/ }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Email' }), 'ana@example.com')
    await userEvent.click(screen.getByRole('button', { name: /Send link/ }))
    expect(to.searchParams.get('method')).toBe('email')
    expect(to.searchParams.get('email')).toBe('ana@example.com')
  })
})

describe('signOutEverywhere', () => {
  it('revokes the session on the server (POST /api/auth/logout with the token), clears the token and identity, and reloads', async () => {
    storeToken('session-token')
    setGoogleIdentity({ email: 'owner@example.com', name: 'Owner', photo: null })
    const fetchFn = mockFetch({
      '/api/auth/logout': { status: 200, body: { ok: true } },
      '/api/auth/config': { status: 200, body: CONFIG_ON },
    })
    const reload = vi.fn()
    // jsdom does not implement navigation — the entire location is replaced
    vi.stubGlobal('location', { ...window.location, reload })
    await signOutEverywhere()
    const logoutCall = fetchFn.mock.calls.find((c) => String(c[0]).includes('/api/auth/logout'))
    expect(logoutCall).toBeDefined()
    expect((logoutCall?.[1]?.headers as Record<string, string>)['x-token']).toBe('session-token')
    expect(getToken()).toBe('')
    expect(getGoogleIdentity()).toBeNull()
    expect(reload).toHaveBeenCalledOnce()
  })
})
