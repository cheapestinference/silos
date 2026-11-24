// claude-sign-in.test.tsx — the sign-in block: Claude's link (open + copy),
// a code field that types at Claude's prompt (it does not echo), Claude's
// own answer shown, "Signed in as …" when the login lands. The raw output
// folded. Silos keeps nothing: the field clears once sent.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ClaudeSignIn } from '../src/components/ClaudeSignIn'
import { claudeReply, isRejection, plainText, signInLink } from '../src/lib/claude-sign-in'
import { api } from '../src/lib/api'

vi.mock('../src/lib/api', async (orig) => {
  const real = await orig<typeof import('../src/lib/api')>()
  return { ...real, getToken: () => 't', api: { accounts: { login: vi.fn(), verify: vi.fn() }, terminals: { kill: vi.fn() } } }
})
const mockedApi = vi.mocked(api, { deep: true })

const LINK = 'https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y'
const PRINTED = `Opening browser to sign in…\r\nIf the browser didn't open, visit: \x1b]8;;${LINK}\x07\x1b[94m${LINK}\x1b[39m\x1b]8;;\x07\r\nPaste code here if prompted > `

class FakeSocket {
  static last: FakeSocket | null = null
  static OPEN = 1
  readyState = 1
  sent: string[] = []
  private listeners: Record<string, Array<(ev: unknown) => void>> = {}
  constructor(public url: string) {
    FakeSocket.last = this
  }
  addEventListener(t: string, cb: (ev: unknown) => void) {
    ;(this.listeners[t] ??= []).push(cb)
  }
  send(d: string) {
    this.sent.push(d)
  }
  close() {
    this.readyState = 3
  }
  emit(t: string, ev: unknown = {}) {
    for (const cb of this.listeners[t] ?? []) cb(ev)
  }
}

describe('reading what claude auth login prints', () => {
  it('the link is the OSC 8 target; text is readable; the answer to a code is the last line, never the prompt', () => {
    expect(signInLink(PRINTED)).toBe(LINK)
    expect(signInLink('visit: ' + LINK + '\r\n')).toBe(LINK)
    expect(signInLink('nothing yet')).toBeNull()
    expect(plainText(PRINTED)).not.toMatch(/\x1b/)
    const after = PRINTED + 'Invalid code. Please make sure the full code was copied.\r\nPaste code here if prompted > '
    const reply = claudeReply(after, PRINTED.length)
    expect(reply).toBe('Invalid code. Please make sure the full code was copied.')
    expect(isRejection(reply)).toBe(true)
    expect(claudeReply(PRINTED, PRINTED.length)).toBeNull()
  })
})

describe('ClaudeSignIn', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('WebSocket', FakeSocket)
    mockedApi.accounts.login.mockResolvedValue({ terminal: { id: 'term-1', agentId: null, cwd: '/d' } })
    mockedApi.accounts.verify.mockResolvedValue({
      name: 'kai',
      configDir: '/d',
      providerId: 'account:kai',
      loggedIn: false,
      email: null,
      plan: null,
      shared: true,
    })
    mockedApi.terminals.kill.mockResolvedValue(undefined)
  })

  it('step 1 opens or copies Claude’s link; step 2 types the code at Claude’s prompt and says what Claude answered', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    render(<ClaudeSignIn account="kai" onSignedIn={() => undefined} onCancel={() => undefined} />)
    await waitFor(() => expect(FakeSocket.last?.url).toContain('/ws/terminal/term-1'))
    expect(screen.getByLabelText('code from Claude')).toBeDisabled() // no link yet
    act(() => FakeSocket.last!.emit('message', { data: PRINTED }))
    expect(screen.getByRole('link', { name: /Open sign-in page/ })).toHaveAttribute('href', LINK)
    fireEvent.click(screen.getByRole('button', { name: /Copy link/ }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(LINK))
    await waitFor(() => expect(screen.getByRole('button', { name: /Copied/ })).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('code from Claude'), { target: { value: ' abc#123 ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(screen.getByText(/Checking the code with Claude/)).toBeInTheDocument()
    expect(screen.getByLabelText('code from Claude')).toHaveValue('') // nothing kept
    await waitFor(() => expect(FakeSocket.last!.sent).toEqual([JSON.stringify({ op: 'write', data: 'abc#123' }), JSON.stringify({ op: 'write', data: '\r' })]))
    act(() => FakeSocket.last!.emit('message', { data: 'Invalid code. Please make sure the full code was copied.\r\nPaste code here if prompted > ' }))
    expect(screen.getByRole('alert').textContent).toMatch(/Claude says: Invalid code/)
    // the field is usable again for another try
    expect(screen.getByLabelText('code from Claude')).toBeEnabled()
  })

  it('the login lands: "Signed in as …", then the host is told', async () => {
    const onSignedIn = vi.fn()
    render(<ClaudeSignIn account="kai" onSignedIn={onSignedIn} onCancel={() => undefined} />)
    await waitFor(() => expect(FakeSocket.last).not.toBeNull())
    mockedApi.accounts.verify.mockResolvedValue({
      name: 'kai',
      configDir: '/d',
      providerId: 'account:kai',
      loggedIn: true,
      email: 'kai@x.com',
      plan: null,
      shared: true,
    })
    await waitFor(() => expect(screen.getByText(/Signed in as/)).toBeInTheDocument(), { timeout: 3000 })
    expect(screen.getByText('kai@x.com')).toBeInTheDocument()
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled(), { timeout: 2000 })
  })

  it('Claude’s raw output is one click away; a sign-in that closed offers to start again', async () => {
    render(<ClaudeSignIn account="kai" onSignedIn={() => undefined} onCancel={() => undefined} />)
    await waitFor(() => expect(FakeSocket.last).not.toBeNull())
    act(() => FakeSocket.last!.emit('message', { data: PRINTED }))
    fireEvent.click(screen.getByRole('button', { name: /Show Claude’s output/ }))
    expect(screen.getByText(/Opening browser to sign in/)).toBeInTheDocument()
    act(() => FakeSocket.last!.emit('close'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start again' })).toBeInTheDocument())
  })
})
