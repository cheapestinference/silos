import { describe, it, expect, vi, afterEach } from 'vitest'
import { fireEvent, render, screen, cleanup, act } from '@testing-library/react'
import { ConfirmButton } from '../src/components/ConfirmButton'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('ConfirmButton', () => {
  it('first click arms (does not fire), second click confirms', () => {
    const onConfirm = vi.fn()
    render(
      <ConfirmButton onConfirm={onConfirm} confirmLabel="Sure?">
        Delete
      </ConfirmButton>,
    )
    fireEvent.click(screen.getByText('Delete'))
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Sure?'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('disarms itself after the timeout (a stray later click cannot destroy)', () => {
    vi.useFakeTimers()
    const onConfirm = vi.fn()
    render(
      <ConfirmButton onConfirm={onConfirm} confirmLabel="Sure?" timeoutMs={3000}>
        Delete
      </ConfirmButton>,
    )
    fireEvent.click(screen.getByText('Delete'))
    expect(screen.getByText('Sure?')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(3001)
    })
    expect(screen.getByText('Delete')).toBeInTheDocument() // disarmed
    fireEvent.click(screen.getByText('Delete'))
    expect(onConfirm).not.toHaveBeenCalled() // the stray click only re-arms, doesn't fire
  })
})
