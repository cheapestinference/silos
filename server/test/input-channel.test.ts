// input-channel.ts — an interactive turn's prompt as a stream the owner can
// still write into: the first message starts the turn, a push reaches it at
// its next step (priority 'next'), close ends the stream (the process exits
// with the turn), and nothing is accepted once closed (the caller queues it).
import { describe, it, expect } from 'vitest'
import { inputChannel, promptText } from '../src/harnesses/claude-code/input-channel.js'

async function drain(it: AsyncIterable<{ message: { content: string }; priority?: string }>): Promise<Array<[string, string | undefined]>> {
  const out: Array<[string, string | undefined]> = []
  for await (const m of it) out.push([m.message.content, m.priority])
  return out
}

describe('inputChannel', () => {
  it('starts with the turn text, delivers a push as priority next, and ends on close', async () => {
    const c = inputChannel('build it')
    const read = drain(c.iterable)
    expect(c.push('also add tests')).toBe(true)
    c.close()
    expect(await read).toEqual([
      ['build it', undefined],
      ['also add tests', 'next'],
    ])
  })

  it('a push waits for the reader: delivered after the stream was already idle', async () => {
    const c = inputChannel('go')
    const seen: string[] = []
    const reading = (async () => {
      for await (const m of c.iterable) seen.push(m.message.content)
    })()
    await new Promise((r) => setTimeout(r, 0))
    expect(seen).toEqual(['go'])
    c.push('steer')
    await new Promise((r) => setTimeout(r, 0))
    expect(seen).toEqual(['go', 'steer'])
    c.close()
    await reading
  })

  it('refuses a push once closed (the caller queues it) and an empty one', () => {
    const c = inputChannel('go')
    expect(c.push('   ')).toBe(false)
    c.close()
    expect(c.closed).toBe(true)
    expect(c.push('late')).toBe(false)
  })

  it('promptText reads the turn text from either prompt shape', () => {
    expect(promptText('plain')).toBe('plain')
    expect(promptText(inputChannel('streamed').iterable)).toBe('streamed')
    expect(promptText({})).toBeNull()
  })
})
