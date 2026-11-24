// Side panels opened from the context column close on a press anywhere
// else and on Escape — also when the focus sits in the real console's
// terminal (which swallows keys), and only the topmost overlay closes.
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { useDismissOnOutside, useModalBehavior } from '../src/components/Modal'

function Panel({ name, onClose, owner }: { name: string; onClose: () => void; owner?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useModalBehavior(ref, onClose)
  useDismissOnOutside(ref, onClose, owner ? { owner } : {})
  return (
    <div ref={ref} role="dialog" aria-label={name} tabIndex={-1}>
      <button type="button">inside {name}</button>
    </div>
  )
}

// a stand-in for xterm: it stops every key it handles from bubbling
function Terminal() {
  return <textarea aria-label="terminal" onKeyDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} />
}

describe('side panel dismissal', () => {
  it('a press outside closes it; a press inside does not', () => {
    const onClose = vi.fn()
    render(
      <>
        <button type="button">elsewhere</button>
        <Panel name="p" onClose={onClose} />
      </>,
    )
    fireEvent.pointerDown(screen.getByRole('button', { name: 'inside p' }))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'elsewhere' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a press on the terminal counts as outside even though it stops the event', () => {
    const onClose = vi.fn()
    render(
      <>
        <Terminal />
        <Panel name="p" onClose={onClose} />
      </>,
    )
    fireEvent.pointerDown(screen.getByRole('textbox', { name: 'terminal' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('its own opener does not close it (no close→reopen)', () => {
    const onClose = vi.fn()
    render(
      <>
        <button type="button" data-panel-owned="run-on">
          opener
        </button>
        <Panel name="p" owner="run-on" onClose={onClose} />
      </>,
    )
    fireEvent.pointerDown(screen.getByRole('button', { name: 'opener' }))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Escape with the focus in the terminal closes the panel and never reaches the terminal', () => {
    const onClose = vi.fn()
    const termKey = vi.fn()
    render(
      <>
        <textarea
          aria-label="terminal"
          onKeyDown={(e) => {
            termKey()
            e.stopPropagation()
          }}
        />
        <Panel name="p" onClose={onClose} />
      </>,
    )
    const term = screen.getByRole('textbox', { name: 'terminal' })
    term.focus()
    fireEvent.keyDown(term, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(termKey).not.toHaveBeenCalled()
  })

  it('Escape inside the panel closes it once', () => {
    const onClose = vi.fn()
    render(<Panel name="p" onClose={onClose} />)
    fireEvent.keyDown(screen.getByRole('button', { name: 'inside p' }), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('with a dialog over the panel, Escape closes only the top one', () => {
    const closeBelow = vi.fn()
    const closeTop = vi.fn()
    render(
      <>
        <Panel name="below" onClose={closeBelow} />
        <Panel name="top" onClose={closeTop} />
      </>,
    )
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(closeTop).toHaveBeenCalledTimes(1)
    expect(closeBelow).not.toHaveBeenCalled()
  })
})
