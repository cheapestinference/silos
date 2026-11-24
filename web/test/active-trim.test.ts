import { describe, expect, it } from 'vitest'
import { activeTrim, NO_TRIM } from '../src/lib/active-trim'
import type { Turn } from '../src/lib/types'

function turn(partial: Partial<Turn> & Pick<Turn, 'index' | 'role' | 'text'>): Turn {
  return { tools: [], ts: null, ...partial }
}

describe('activeTrim (a live transcript with no echo)', () => {
  it('with no echo of the persisted userText, trims nothing', () => {
    const turns = [turn({ index: 0, role: 'user', text: 'something else' })]
    expect(activeTrim(turns, 'hello', 'streamed text')).toEqual(NO_TRIM)
  })

  it('with the persisted echo but no assistant turns yet, only marks it echoed', () => {
    const turns = [turn({ index: 0, role: 'user', text: 'hello' })]
    expect(activeTrim(turns, 'hello', 'strea')).toEqual({ chars: 0, tools: 0, echoed: true })
  })

  it('trims text already persisted and counts tool-turns as chips', () => {
    const turns = [
      turn({ index: 0, role: 'user', text: 'hello' }),
      turn({ index: 1, role: 'assistant', text: 'Let me check the code.' }),
      turn({ index: 2, role: 'assistant', text: '', tools: ['Bash'] }),
      turn({ index: 3, role: 'assistant', text: '', tools: ['Read'] }),
    ]
    const active = 'Let me check the code.\n\nAnd I keep writing this'
    expect(activeTrim(turns, 'hello', active)).toEqual({
      chars: 'Let me check the code.'.length,
      tools: 2,
      echoed: true,
    })
  })

  it('tolerates whitespace between messages when matching the second text turn', () => {
    const turns = [
      turn({ index: 0, role: 'user', text: 'hello' }),
      turn({ index: 1, role: 'assistant', text: 'First.' }),
      turn({ index: 2, role: 'assistant', text: 'Second.' }),
    ]
    const active = 'First.\n\nSecond. and the still-live tail'
    const r = activeTrim(turns, 'hello', active)
    expect(active.slice(r.chars).trimStart()).toBe('and the still-live tail')
  })

  it('on a mismatch (deltas still in flight), stops trimming, staying conservative', () => {
    const turns = [
      turn({ index: 0, role: 'user', text: 'hello' }),
      turn({ index: 1, role: 'assistant', text: "text the WS hasn't streamed yet" }),
      turn({ index: 2, role: 'assistant', text: '', tools: ['Bash'] }),
    ]
    // the tool-turn after the mismatch is NOT counted — trimming chips
    // without having matched the prior text would throw off the correspondence.
    expect(activeTrim(turns, 'hello', 'something else in flight')).toEqual({ chars: 0, tools: 0, echoed: true })
  })

  it('the echo search skips peer messages (interSession) and turns from another exchange do not count', () => {
    const turns = [
      turn({ index: 0, role: 'user', text: 'hello' }),
      turn({ index: 1, role: 'assistant', text: 'Reply.' }),
      turn({ index: 2, role: 'user', text: 'peer notice', interSession: { from: 'x' } }),
    ]
    const r = activeTrim(turns, 'hello', 'Reply.')
    expect(r.echoed).toBe(true)
    expect(r.chars).toBe('Reply.'.length)
  })

  it('a receipt marker (durationMs, no text or tools) does not break the trim', () => {
    const turns = [
      turn({ index: 0, role: 'user', text: 'hello' }),
      turn({ index: 1, role: 'assistant', text: '', durationMs: 1200 }),
      turn({ index: 2, role: 'assistant', text: 'Continuing.' }),
    ]
    expect(activeTrim(turns, 'hello', 'Continuing. and more').chars).toBe('Continuing.'.length)
  })
})
