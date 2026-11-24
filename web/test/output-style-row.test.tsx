import { describe, expect, it } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { OutputStyleRow } from '../src/components/OutputStyleRow'
import type { OutputStyleInfo } from '../src/lib/types'

const styles = [
  { id: 'default', source: 'built-in' },
  { id: 'Explanatory', source: 'built-in' },
] as OutputStyleInfo[]

function open(started: boolean) {
  render(
    <OutputStyleRow
      agentName="Support"
      agentStyle="default"
      styles={styles}
      now={{ style: 'default', from: 'agent' }}
      started={started}
      onChoose={() => undefined}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: /Answers in/ }))
}

describe('OutputStyleRow — switching mid-conversation', () => {
  it('a conversation with answers warns about switching mid-conversation', () => {
    open(true)
    expect(screen.getByTestId('output-style-started')).toBeInTheDocument()
  })

  it('a new conversation has nothing to warn about', () => {
    open(false)
    expect(screen.queryByTestId('output-style-started')).toBeNull()
  })
})
