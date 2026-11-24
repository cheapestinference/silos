// run-outcome.test.ts — a run history reads as results: the outcome word, a
// failure said in plain words, and consecutive "no news" runs folded.
import { describe, expect, it } from 'vitest'
import { explainRunError, failureReason, foldRangeLabel, foldRoutine, runOutcomeWord } from '../src/lib/automations'
import { runFailure } from '../../server/src/run-failure'
import type { Run } from '../src/lib/types'

const run = (o: Partial<Run> & Pick<Run, 'id'>): Run => ({ automationId: 'a', at: '2026-10-20T10:00:00.000Z', status: 'ok', ...o })

describe('explainRunError', () => {
  it('usage limits read as "The usage limit was reached", with the retry time when the run carries it', () => {
    const fable = "Claude Code returned an error result: You've reached your Fable limit. Switch to another model, or manage usage credits"
    const limit = explainRunError({ error: 'usage limit hit' }).text
    expect(explainRunError({ error: fable }).text).toBe(limit)
    expect(explainRunError({ error: fable }).retry).toBeUndefined()
    const r = explainRunError({ error: fable, resetsAt: '2026-10-20T15:30:00.000Z' })
    expect(r.text).toBe(limit)
    expect(r.retry).toMatch(/\d{1,2}:\d{2}/)
    expect(explainRunError({ error: "Claude Code returned an error result: You've hit your session limit · resets 5:50am (Europe/Berlin)" }).text).toBe(limit)
    expect(explainRunError({ error: '429 rate limit exceeded' }).text).toBe(limit)
  })
  it('anything else: the raw error, trimmed to 120 characters', () => {
    expect(explainRunError({ error: '  Claude Code process exited with code 1 ' })).toEqual({ text: 'Claude Code process exited with code 1' })
    const long = explainRunError({ error: 'y'.repeat(300) }).text
    expect(long).toHaveLength(120)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe("one source with Home: the Automations page says the server's own words", () => {
  it('every class reads the same as the server inbox (server/src/run-failure.ts), capitalised to stand alone', () => {
    const errors = [
      "You've reached your Fable limit",
      'API Error: 400 x',
      'timeout',
      'interrupted by a server restart',
      'agent not found',
      'Anywhere needs a folder',
      'Prompt is too long',
      'the turn did not finish',
    ]
    for (const e of errors) {
      const server = runFailure(e).text
      expect(explainRunError({ error: e }).text).toBe(server.charAt(0).toUpperCase() + server.slice(1))
      expect(failureReason(e).toLowerCase()).toBe(server.toLowerCase())
    }
  })
})

describe('runOutcomeWord', () => {
  it('acted / no news on ok runs that said so; the bare status otherwise', () => {
    expect(runOutcomeWord({ status: 'ok', outcome: 'acted' })).toBe('acted')
    expect(runOutcomeWord({ status: 'ok', outcome: 'nothing' })).toBe('no news')
    expect(runOutcomeWord({ status: 'ok' })).toBe('ok')
    expect(runOutcomeWord({ status: 'failed', outcome: 'acted' })).toBe('failed')
  })
})

describe('foldRoutine — what goes as usual folds, what changes stands out', () => {
  it('folds 2+ consecutive ok runs with the same outcome; a change breaks the streak; failed and waiting never fold', () => {
    const runs = [
      run({ id: 'n1', outcome: 'nothing' }),
      run({ id: 'n2', outcome: 'nothing' }),
      run({ id: 'n3', outcome: 'nothing' }),
      run({ id: 'a1', outcome: 'acted' }),
      run({ id: 'n4', outcome: 'nothing' }),
      run({ id: 'f1', status: 'failed', error: 'timeout' }),
      run({ id: 'n5', outcome: 'nothing' }),
      run({ id: 'n6', outcome: 'nothing' }),
      run({ id: 'u1' }),
      run({ id: 'w1', status: 'waiting_reset' }),
      run({ id: 'a2', outcome: 'acted' }),
      run({ id: 'a3', outcome: 'acted' }),
      run({ id: 'a4', outcome: 'acted' }),
      run({ id: 'u2' }),
      run({ id: 'u3' }),
    ]
    const items = foldRoutine(runs)
    expect(items.map((i) => (i.kind === 'run' ? i.run.id : `fold:${i.runs.map((r) => r.id).join(',')}`))).toEqual([
      'fold:n1,n2,n3',
      'a1',
      'n4',
      'f1',
      'fold:n5,n6',
      'u1',
      'w1',
      'fold:a2,a3,a4',
      'fold:u2,u3',
    ])
  })
  it('the range reads oldest – newest; one day says its day once', () => {
    const same = foldRangeLabel([{ at: '2026-10-20T14:00:00.000Z' }, { at: '2026-10-20T10:00:00.000Z' }])
    expect(same.split(' – ')).toHaveLength(2)
    const two = foldRangeLabel([{ at: '2026-10-21T14:00:00.000Z' }, { at: '2026-10-18T10:00:00.000Z' }])
    expect(two.split(' – ')).toHaveLength(2)
    expect(two.indexOf('18')).toBeLessThan(two.indexOf('21'))
  })
})
