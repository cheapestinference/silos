import { describe, expect, it } from 'vitest'
import { commandAction, applySuggestion, buildCommands, detectTrigger } from '../src/hooks/useAutocomplete'

describe('detectTrigger', () => {
  it('"@" preceded by a space triggers files with the q up to the caret', () => {
    expect(detectTrigger('look at @src/pa', 15)).toEqual({ kind: 'files', q: 'src/pa', start: 8 })
  })

  it('"@" at the start of the message triggers files', () => {
    expect(detectTrigger('@x', 2)).toEqual({ kind: 'files', q: 'x', start: 0 })
  })

  it('"/" as the first character triggers skills', () => {
    expect(detectTrigger('/cf', 3)).toEqual({ kind: 'skills', q: 'cf', start: 0 })
  })

  it('a non-initial "/" (e.g. "a/b") triggers nothing', () => {
    expect(detectTrigger('a/b', 3)).toBeNull()
  })

  it('a space after the "@" kills the trigger', () => {
    expect(detectTrigger('email @ ', 8)).toBeNull()
  })

  it('with neither an initial "@" nor "/" there is no trigger', () => {
    expect(detectTrigger('hello agent', 11)).toBeNull()
  })

  it('an "@" stuck to a word (no space before it) does not trigger', () => {
    expect(detectTrigger('foo@bar', 7)).toBeNull()
  })

  it('a second "@" after the first overrides it as the q delimiter', () => {
    expect(detectTrigger('look at @src @other', 19)).toEqual({ kind: 'files', q: 'other', start: 13 })
  })

  it('a "/" followed by a space inside the message kills the skills trigger', () => {
    expect(detectTrigger('/foo bar', 8)).toBeNull()
  })

  it('an "@" after a message that starts with "/" still triggers files — the "@" is checked first', () => {
    expect(detectTrigger('/finance check @docs/inv', 24)).toEqual({ kind: 'files', q: 'docs/inv', start: 15 })
  })
})

describe('applySuggestion', () => {
  it('replaces from trigger.start to the caret with "@suggestion " and places the caret after the space', () => {
    const trigger = { kind: 'files' as const, q: 'src/pa', start: 5 }
    const r = applySuggestion('look @src/pa', 12, trigger, 'src/pages/App.tsx')
    expect(r.text).toBe('look @src/pages/App.tsx ')
    expect(r.caret).toBe('look @src/pages/App.tsx '.length)
  })

  it('with skills, replaces with "/suggestion " from the start', () => {
    const trigger = { kind: 'skills' as const, q: 'cf', start: 0 }
    const r = applySuggestion('/cf', 3, trigger, 'finance-acme')
    expect(r.text).toBe('/finance-acme ')
    expect(r.caret).toBe('/finance-acme '.length)
  })

  it('preserves the text after the caret when replacing mid-message', () => {
    const trigger = { kind: 'files' as const, q: 'pa', start: 5 }
    const r = applySuggestion('tell @pa what is there', 8, trigger, 'package.json')
    expect(r.text).toBe('tell @package.json  what is there')
    expect(r.caret).toBe('tell @package.json '.length)
  })
})

describe('buildCommands', () => {
  it('maps the init\'s real list to suggestions with a "/name" label and the commands section', () => {
    const r = buildCommands(['clear', 'compact'], '')
    expect(r).toMatchObject([
      { value: 'clear', label: '/clear', section: 'commands', action: 'new-conversation' },
      { value: 'compact', label: '/compact', section: 'commands' },
    ])
  })

  it('filters by what was typed (substring, case-insensitive)', () => {
    const r = buildCommands(['clear', 'compact', 'model', 'usage'], 'co')
    expect(r.map((s) => s.value)).toEqual(['compact'])
  })

  it('the ones starting with what was typed come first', () => {
    const r = buildCommands(['agents', 'usage', 'compact'], 'a')
    // 'agents' starts with 'a'; 'usage' and 'compact' only contain it
    expect(r[0]!.value).toBe('agents')
  })

  it('maps /clear and /model to native actions; an unknown command is a passthrough with no description', () => {
    const r = buildCommands(['clear', 'model', 'mycommand'], '')
    const clear = r.find((s) => s.value === 'clear')!
    const model = r.find((s) => s.value === 'model')!
    const custom = r.find((s) => s.value === 'mycommand')!
    expect(clear.action).toBe('new-conversation')
    expect(model.action).toBe('open-model')
    expect(custom.action).toBeUndefined()
    expect(custom.description).toBeUndefined()
  })

  it('normalizes a leading slash and dedupes', () => {
    const r = buildCommands(['/clear', 'clear', 'compact'], '')
    expect(r.map((s) => s.value)).toEqual(['clear', 'compact'])
  })
})

describe('commandAction (a belt-and-suspenders for the send-time mapping)', () => {
  const COMMANDS = ['clear', 'compact', 'model', 'usage']

  it('an exact, advertised "/clear" returns the mapped action, even with surrounding whitespace', () => {
    expect(commandAction('/clear', COMMANDS)).toBe('new-conversation')
    expect(commandAction('  /clear  ', COMMANDS)).toBe('new-conversation')
    expect(commandAction('/model', COMMANDS)).toBe('open-model')
  })

  it('a known passthrough (/compact) does NOT return an action (sent as-is)', () => {
    expect(commandAction('/compact', COMMANDS)).toBeNull()
  })

  it('a command with args ("/model sonnet") does NOT match → passes through as-is', () => {
    expect(commandAction('/model sonnet', COMMANDS)).toBeNull()
  })

  it('a mapped command NOT advertised by the session is not intercepted', () => {
    expect(commandAction('/clear', ['compact', 'usage'])).toBeNull()
  })

  it('normal text (no "/") is never an action', () => {
    expect(commandAction('clear the table', COMMANDS)).toBeNull()
    expect(commandAction('hello', COMMANDS)).toBeNull()
  })
})
