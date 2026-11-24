import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { toolLabel, prettyToolName, ToolChip } from '../src/components/ToolChip'
import type { ToolUseDetail } from '../src/lib/types'

const detail = (over: Partial<ToolUseDetail> = {}): ToolUseDetail => ({
  name: 'Read',
  skill: null,
  input: '{}',
  result: 'ok',
  ...over,
})

describe('prettyToolName / toolLabel (MCP)', () => {
  it('renders an MCP wire name as "<server> · <tool>"', () => {
    expect(prettyToolName('mcp__claude_ai_Gmail__search_threads')).toBe('Gmail · search_threads')
    expect(prettyToolName('mcp__plugin_product-management_slack__send')).toBe('slack · send')
    expect(prettyToolName('Read')).toBe('Read') // non-MCP untouched
    expect(toolLabel('mcp__claude_ai_Notion__notion-search')).toBe('Notion · notion-search')
  })
})

describe('ToolChip error state', () => {
  it('a failed tool call is marked (data-error + ⚠) so it is scannable', () => {
    render(<ToolChip tool={detail({ name: 'Bash', isError: true })} />)
    const btn = screen.getByRole('button')
    expect(btn.getAttribute('data-error')).toBe('true')
    expect(screen.getByLabelText('failed')).toBeInTheDocument()
  })

  it('a successful tool call is not marked', () => {
    render(<ToolChip tool={detail({ name: 'Bash', isError: false })} />)
    expect(screen.getByRole('button').getAttribute('data-error')).toBeNull()
  })
})
