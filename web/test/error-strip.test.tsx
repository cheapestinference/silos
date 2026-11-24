import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ErrorStrip } from '../src/components/ErrorStrip'
import { App } from '../src/App'
import { useStore } from '../src/store'
import { api } from '../src/lib/api'

vi.mock('../src/lib/api')

const mockedApi = vi.mocked(api, { deep: true })

beforeEach(() => {
  vi.clearAllMocks()
  mockedApi.overview.mockResolvedValue({ agents: [], now: 0, warming: false })
  useStore.setState({
    agents: [],
    warming: false,
    selectedAgentId: null,
    selected: null,
    detail: null,
    filter: '',
    active: null,
    execOut: null,
    modal: null,
    error: null,
    failedDraft: null,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ErrorStrip', () => {
  it('renders nothing if there is no error', () => {
    render(<ErrorStrip />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows the error text when store.error is not null', () => {
    useStore.setState({ error: 'something broke' })
    render(<ErrorStrip />)
    expect(screen.getByRole('alert')).toHaveTextContent('something broke')
  })

  it('the X button calls clearError()', () => {
    useStore.setState({ error: 'boom' })
    render(<ErrorStrip />)
    fireEvent.click(screen.getByLabelText('dismiss error'))
    expect(useStore.getState().error).toBeNull()
  })

  it('auto-dismisses after 8s', () => {
    vi.useFakeTimers()
    useStore.setState({ error: 'boom' })
    render(<ErrorStrip />)
    expect(useStore.getState().error).toBe('boom')

    vi.advanceTimersByTime(8000)

    expect(useStore.getState().error).toBeNull()
  })

  it("a new error before 8s resets the timer (it isn't dismissed early)", () => {
    vi.useFakeTimers()
    useStore.setState({ error: 'first' })
    const { rerender } = render(<ErrorStrip />)

    vi.advanceTimersByTime(5000)
    useStore.setState({ error: 'second' })
    rerender(<ErrorStrip />)

    vi.advanceTimersByTime(5000) // 10s since 'first', but only 5s since 'second'
    expect(useStore.getState().error).toBe('second')

    vi.advanceTimersByTime(3000) // completes 'second''s 8s
    expect(useStore.getState().error).toBeNull()
  })

  it('mounted from App, only appears when error !== null', async () => {
    render(<App />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    useStore.setState({ error: 'failure visible from App' })
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByText('failure visible from App')).toBeInTheDocument()

    useStore.getState().clearError()
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })
})
