// floating-window.test.tsx — the draggable window (a modal that looks
// and moves like a window): a title bar that drags,
// a close ✕, Escape closes, dialog semantics. Home of the lineage and
// file-history trees.
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { FloatingWindow } from '../src/components/FloatingWindow'

describe('FloatingWindow', () => {
  it('renders title bar + content with dialog semantics, and ✕ closes', () => {
    const onClose = vi.fn()
    render(
      <FloatingWindow title="Session family" onClose={onClose}>
        <p>tree here</p>
      </FloatingWindow>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Session family' })
    expect(dialog).toBeInTheDocument()
    expect(screen.getByText('tree here')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close window' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape closes', () => {
    const onClose = vi.fn()
    render(
      <FloatingWindow title="w" onClose={onClose}>
        <p>x</p>
      </FloatingWindow>,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('dragging the title bar moves the window', () => {
    render(
      <FloatingWindow title="w" onClose={() => {}}>
        <p>x</p>
      </FloatingWindow>,
    )
    const bar = screen.getByTestId('window-titlebar')
    const dialog = screen.getByRole('dialog')
    const before = dialog.style.transform
    fireEvent.pointerDown(bar, { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(bar, { clientX: 140, clientY: 160, pointerId: 1 })
    fireEvent.pointerUp(bar, { pointerId: 1 })
    expect(dialog.style.transform).not.toBe(before)
    expect(dialog.style.transform).toContain('40')
  })

  it('dragging from the body does NOT move the window (only the title bar is a handle)', () => {
    render(
      <FloatingWindow title="w" onClose={() => {}}>
        <p>body content</p>
      </FloatingWindow>,
    )
    const dialog = screen.getByRole('dialog')
    const before = dialog.style.transform
    fireEvent.pointerDown(screen.getByText('body content'), { clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerMove(screen.getByText('body content'), { clientX: 90, clientY: 90, pointerId: 1 })
    expect(dialog.style.transform).toBe(before)
  })
})
