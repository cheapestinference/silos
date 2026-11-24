// reconnect-band.test.tsx — reconnection is an amber band from the system
// notices family, with HONEST states: visible only while the WS is down,
// "Reconnected" only after a real recovery, and unmounted after 2s.
// Nothing is painted in the usual connected state, and a short blip (the
// precautionary reconnect after a long tab hide, ws.ts STALE_HIDDEN_MS)
// never paints anything: the band needs the drop to LAST (grace period).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { ReconnectBand } from '../src/components/ReconnectBand'
import { useStore } from '../src/store'

describe('ReconnectBand', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useStore.setState({ connection: 'connected' })
  })

  afterEach(() => {
    vi.useRealTimers()
    useStore.setState({ connection: 'connected' })
  })

  it('usual connected state: renders nothing (no spurious "Reconnected")', () => {
    const { container } = render(<ReconnectBand />)
    expect(container).toBeEmptyDOMElement()
  })

  it('reconnecting: a mono amber band with a pulse and "Reconnecting…"', () => {
    render(<ReconnectBand />)
    act(() => useStore.setState({ connection: 'reconnecting' }))
    act(() => {
      vi.advanceTimersByTime(1500)
    })
    const band = screen.getByRole('status')
    expect(band).toHaveTextContent('Reconnecting…')
    expect(band.className).toContain('amber')
    expect(band.className).toContain('font-mono')
    expect(band.className).toContain('band-pulse')
  })

  it('on recovery: "Reconnected" with a fade, and unmounts after 2s', () => {
    render(<ReconnectBand />)
    act(() => useStore.setState({ connection: 'reconnecting' }))
    act(() => {
      vi.advanceTimersByTime(1500)
    })
    act(() => useStore.setState({ connection: 'connected' }))
    const band = screen.getByRole('status')
    expect(band).toHaveTextContent('Reconnected')
    expect(band.className).toContain('band-fade')
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('no terracotta: the band is amber (orange is for action/live)', () => {
    render(<ReconnectBand />)
    act(() => useStore.setState({ connection: 'reconnecting' }))
    act(() => {
      vi.advanceTimersByTime(1500)
    })
    expect(screen.getByRole('status').className).not.toContain('terracotta')
  })

  it('a blip shorter than the grace period paints NOTHING — not even "Reconnected"', () => {
    const { container } = render(<ReconnectBand />)
    act(() => useStore.setState({ connection: 'reconnecting' }))
    act(() => {
      vi.advanceTimersByTime(800)
    })
    expect(container).toBeEmptyDOMElement()
    act(() => useStore.setState({ connection: 'connected' }))
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(container).toBeEmptyDOMElement()
  })

  it('a drop that outlasts the grace period is shown, and its recovery announced', () => {
    render(<ReconnectBand />)
    act(() => useStore.setState({ connection: 'reconnecting' }))
    act(() => {
      vi.advanceTimersByTime(1499)
    })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting…')
    act(() => useStore.setState({ connection: 'connected' }))
    expect(screen.getByRole('status')).toHaveTextContent('Reconnected')
  })
})
