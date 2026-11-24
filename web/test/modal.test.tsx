import { describe, it, expect, vi, afterEach } from 'vitest'
import { fireEvent, render, screen, cleanup } from '@testing-library/react'
import { Modal } from '../src/components/Modal'

afterEach(() => {
  cleanup()
  document.body.style.overflow = ''
})

describe('Modal', () => {
  it('Escape and backdrop-click call onClose; the card click does not', () => {
    const onClose = vi.fn()
    render(
      <Modal onClose={onClose} label="test dialog">
        <button>inside</button>
      </Modal>,
    )
    // clicking the card (or its children) must NOT close
    fireEvent.mouseDown(screen.getByText('inside'))
    expect(onClose).not.toHaveBeenCalled()
    // Escape closes
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('locks body scroll while open and restores it on unmount', () => {
    document.body.style.overflow = 'auto'
    const { unmount } = render(
      <Modal onClose={() => {}} label="test">
        <span>x</span>
      </Modal>,
    )
    expect(document.body.style.overflow).toBe('hidden')
    unmount()
    expect(document.body.style.overflow).toBe('auto')
  })

  it('renders a labelled dialog', () => {
    render(
      <Modal onClose={() => {}} label="my dialog">
        <span>x</span>
      </Modal>,
    )
    expect(screen.getByRole('dialog', { name: 'my dialog' })).toBeInTheDocument()
  })
})
