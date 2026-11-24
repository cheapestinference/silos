import { describe, it, expect } from 'vitest'
import { runFailure, failureSentence, NO_REASON } from '../src/run-failure.js'
import { runFailure as inboxRunFailure } from '../src/inbox.js'

// run-failure.ts — THE reading of a failed run, shared by the server's
// Needs you and the web's Automations page (web/src/lib/automations.ts
// imports this very file; web/test/run-outcome.test.ts pins that side).
describe('run-failure — one reading of a failed run', () => {
  const samples = [
    "You've reached your Fable limit · resets 6am",
    'API Error: 400 {"type":"error"}',
    'timeout',
    'interrupted by a server restart',
    'agent not found or archived',
    'Anywhere needs a folder on the thread',
    'Prompt is too long',
    'the turn did not finish',
    '',
    'Claude Code process exited with code 1',
  ]

  it('the inbox re-exports the same function — no second copy', () => {
    expect(inboxRunFailure).toBe(runFailure)
  })

  it("a sentence of its own: Silos' phrases get a capital, a quoted engine error stays as written", () => {
    expect(failureSentence(samples[0])).toBe('The usage limit was reached')
    expect(failureSentence(samples[1])).toBe('The API rejected the request (400)')
    expect(failureSentence(samples[2])).toBe('It timed out after 30 min')
    expect(failureSentence(samples[3])).toBe('A Silos restart interrupted it')
    expect(failureSentence(samples[4])).toBe('Its agent is missing or archived')
    expect(failureSentence('')).toBe('No reason recorded')
    expect(failureSentence(undefined)).toBe('No reason recorded')
    expect(failureSentence('claude exited with code 1')).toBe('claude exited with code 1')
  })

  it('the sentence and the clause are the same words for every class', () => {
    for (const e of samples) {
      const f = runFailure(e)
      expect(failureSentence(e).toLowerCase()).toBe(f.text.toLowerCase())
    }
    expect(runFailure('').text).toBe(NO_REASON)
  })
})
