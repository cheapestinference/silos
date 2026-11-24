// agent-context.test.ts — stripAgentContext: the UI must never show the
// skills preamble the server prepends to a new session's first turn
// (ChatService.withSkillsPrelude). A pure function, no DOM.
import { describe, expect, it } from 'vitest'
import { stripAgentContext } from '../src/lib/agent-context'

const PRELUDE = '[silos-context] Your skills for this session: /finance-skill — load them when the task calls for them. [/silos-context]\n\n'

describe('stripAgentContext', () => {
  it('removes the leading [silos-context]…[/silos-context] block and the whitespace after it', () => {
    expect(stripAgentContext(`${PRELUDE}give me the VAT`)).toBe('give me the VAT')
  })

  it('text without the block is unchanged', () => {
    expect(stripAgentContext('hello')).toBe('hello')
  })

  it('the block must be LEADING — if it appears further into the text it is left alone', () => {
    const text = `hello ${PRELUDE.trim()}`
    expect(stripAgentContext(text)).toBe(text)
  })

  it('empty text does not break', () => {
    expect(stripAgentContext('')).toBe('')
  })
})

// the composer's memory mode prepends [silos-memory ...] on the CLIENT side —
// the same presentation treatment as the skills one.
describe('stripAgentContext — [silos-memory]', () => {
  const MEMORY =
    "[silos-memory path=/data/agents/a1/memory.md]\nprevious content\n\nApply the user's instruction to this file; respond briefly with what changed.\n[/silos-memory]\n\n"

  it('removes the leading [silos-memory ...]…[/silos-memory] block', () => {
    expect(stripAgentContext(`${MEMORY}add a note about X`)).toBe('add a note about X')
  })

  it('stacks with [silos-context] — strips BOTH if they appear back-to-back at the start', () => {
    const CONTEXT = '[silos-context] Your skills for this session: /finance-skill — load them when the task calls for them. [/silos-context]\n\n'
    expect(stripAgentContext(`${CONTEXT}${MEMORY}give me the VAT`)).toBe('give me the VAT')
  })

  it('the path attribute can carry slashes and dots without breaking the regex', () => {
    const withPath = '[silos-memory path=/home/user/.silos/agents/finance/memory.md]x[/silos-memory]\n\nhello'
    expect(stripAgentContext(withPath)).toBe('hello')
  })
})
