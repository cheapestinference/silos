import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ScopePill, ScopeBar } from '../src/components/knows/ScopePill'

afterEach(cleanup)

describe('ScopePill', () => {
  it('shows the scope as the label by default, painted with its scope tokens', () => {
    render(<ScopePill scope="auto" />)
    const pill = screen.getByText('auto')
    expect(pill.style.color).toBe('var(--scope-auto)')
    expect(pill.style.background).toBe('var(--scope-auto-soft)')
  })

  it('shows a custom label but keeps the scope color', () => {
    render(<ScopePill scope="project" label="shared" />)
    const pill = screen.getByText('shared')
    expect(screen.queryByText('project')).toBeNull()
    expect(pill.style.color).toBe('var(--scope-project)')
    expect(pill.style.background).toBe('var(--scope-project-soft)')
  })
})

describe('ScopeBar', () => {
  it('splits widths proportionally to the counts, each part in its scope color', () => {
    const { container } = render(
      <ScopeBar
        parts={[
          { scope: 'auto', count: 12 },
          { scope: 'project', count: 6 },
          { scope: 'agent', count: 6 },
        ]}
      />,
    )
    const segs = Array.from(container.querySelectorAll<HTMLElement>('[data-scope]'))
    expect(segs.map((s) => s.dataset.scope)).toEqual(['auto', 'project', 'agent'])
    expect(segs.map((s) => s.style.width)).toEqual(['50%', '25%', '25%'])
    expect(segs.map((s) => s.style.background)).toEqual(['var(--scope-auto)', 'var(--scope-project)', 'var(--scope-agent)'])
  })

  it('omits zero-count parts', () => {
    const { container } = render(
      <ScopeBar
        parts={[
          { scope: 'global', count: 0 },
          { scope: 'auto', count: 3 },
          { scope: 'agent', count: 1 },
        ]}
      />,
    )
    const segs = Array.from(container.querySelectorAll<HTMLElement>('[data-scope]'))
    expect(segs.map((s) => s.dataset.scope)).toEqual(['auto', 'agent'])
    expect(segs.map((s) => s.style.width)).toEqual(['75%', '25%'])
  })

  it('is a 4px-tall track, and an empty track when every count is zero', () => {
    const { container } = render(<ScopeBar parts={[{ scope: 'auto', count: 0 }]} />)
    const bar = container.firstElementChild as HTMLElement
    expect(bar.style.height).toBe('4px')
    expect(container.querySelectorAll('[data-scope]')).toHaveLength(0)
  })
})
