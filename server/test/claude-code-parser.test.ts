import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  textOf,
  toolsOf,
  isNoise,
  splitCompleteLines,
  TranscriptAccumulator,
  interjectionsOf,
  interSessionOf,
  conversationalMessage,
} from '../src/harnesses/claude-code/parser.js'

describe('textOf', () => {
  it('a direct string', () => expect(textOf('hi')).toBe('hi'))
  it('concatenated text blocks', () =>
    expect(
      textOf([
        { type: 'text', text: 'a' },
        { type: 'thinking', thinking: 'x' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a\nb'))
  it('odd content -> empty', () => expect(textOf(null)).toBe(''))
})

describe('toolsOf', () => {
  it('extracts tool_use and detects Skill', () => {
    const c = [
      { type: 'text', text: 'hi' },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_use', name: 'Skill', input: { skill: 'finance-acme' } },
    ]
    expect(toolsOf(c)).toEqual([
      { name: 'Bash', skill: null },
      { name: 'Skill', skill: 'finance-acme' },
    ])
  })
  it('a string content -> []', () => expect(toolsOf('hi')).toEqual([]))
})

describe('isNoise', () => {
  it.each(['', '  ', '<system-reminder>x', 'Caveat: whatever', '[Request interrupted by user]'])('noise: %j', (t) => expect(isNoise(t)).toBe(true))
  it('normal text is not noise', () => expect(isNoise('fix the bug')).toBe(false))
})

describe('splitCompleteLines', () => {
  it('only consumes up to the last \\n', () => {
    const buf = Buffer.from('{"a":1}\n{"b":2}\n{"parcial', 'utf8')
    const { lines, consumed } = splitCompleteLines(buf)
    expect(lines).toEqual(['{"a":1}', '{"b":2}'])
    expect(consumed).toBe(Buffer.byteLength('{"a":1}\n{"b":2}\n'))
  })
  it('no \\n -> nothing consumed', () => {
    expect(splitCompleteLines(Buffer.from('{"a', 'utf8'))).toEqual({ lines: [], consumed: 0 })
  })
  it('does not break a split multibyte UTF-8 sequence', () => {
    const whole = Buffer.from('{"t":"café"}\n', 'utf8')
    const cut = whole.subarray(0, whole.length - 3) // cuts inside the é+\n
    expect(splitCompleteLines(cut).consumed).toBe(0) // no complete \n -> waits
  })
})

const linesOf = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8').split('\n')

describe('TranscriptAccumulator', () => {
  it('parses basic.jsonl: ai title, skills, cwd, filtered turns', () => {
    const acc = new TranscriptAccumulator()
    const turns = acc.feedLines(linesOf('basic.jsonl'))
    expect(acc.title).toBe('JSONL parser fix')
    expect(acc.titleSource).toBe('ai')
    expect(acc.cwd).toBe('/tmp/project-x')
    expect(acc.skills).toEqual(['finance-acme'])
    // turns: a real user, assistant text+Skill, assistant Bash-only, final assistant. Noise/meta filtered out.
    expect(turns.map((t) => [t.index, t.role, t.tools])).toEqual([
      [0, 'user', []],
      [1, 'assistant', ['skill:finance-acme']],
      [2, 'assistant', ['Bash']],
      [3, 'assistant', []],
    ])
    expect(acc.turnCount).toBe(4)
  })

  it("turnOpen: true from the owner's message until the CLI receipt (turn_duration) or an end_turn stop; intermediate assistant messages keep it open", () => {
    const acc = new TranscriptAccumulator()
    const user = (t: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' }, timestamp: t })
    const asst = (t: string, stop: string) =>
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: stop, content: [{ type: 'text', text: 'working…' }] }, timestamp: t })
    expect(acc.turnOpen).toBe(false)
    acc.feedLines([user('2026-08-25T10:00:00.000Z')])
    expect(acc.turnOpen).toBe(true)
    acc.feedLines([asst('2026-08-25T10:00:05.000Z', 'tool_use')])
    expect(acc.turnOpen).toBe(true) // still the agent's turn even though lastRole is now 'assistant'
    expect(acc.lastRole).toBe('assistant')
    acc.feedLines([JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 5000, timestamp: '2026-08-25T10:00:06.000Z' })])
    expect(acc.turnOpen).toBe(false)
    // SDK sessions (no turn_duration): end_turn closes it
    acc.feedLines([user('2026-08-25T10:01:00.000Z'), asst('2026-08-25T10:01:05.000Z', 'end_turn')])
    expect(acc.turnOpen).toBe(false)
    // survives the cache round-trip
    acc.feedLines([user('2026-08-25T10:02:00.000Z')])
    expect(new TranscriptAccumulator(acc.state).turnOpen).toBe(true)
  })

  it("turnOpen: a turn the owner did not start (task-notification, queued command, peer message) opens on the agent's first tool_use stop", () => {
    const asst = (t: string, stop: string, model = 'claude-opus-5-5') =>
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', model, stop_reason: stop, content: [{ type: 'text', text: 'on it' }] }, timestamp: t })
    const receipt = (t: string) => JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1, timestamp: t })
    const wakes = [
      // a background subagent finished — noise to the title/turn logic
      JSON.stringify({
        type: 'user',
        isMeta: true,
        promptSource: 'system',
        origin: { kind: 'task-notification' },
        message: { role: 'user', content: '<task-notification>\n<task-id>x</task-id></task-notification>' },
        timestamp: '2026-11-02T19:36:11.000Z',
      }),
      // a queued message delivered as an attachment, never a user record
      JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'and also this' }, timestamp: '2026-11-02T19:36:11.000Z' }),
    ]
    for (const wake of wakes) {
      const acc = new TranscriptAccumulator()
      acc.feedLines([receipt('2026-11-02T19:31:00.000Z'), wake])
      acc.feedLines([asst('2026-11-02T19:36:14.000Z', 'tool_use')])
      expect(acc.turnOpen).toBe(true)
      acc.feedLines([receipt('2026-11-02T19:40:00.000Z')])
      expect(acc.turnOpen).toBe(false)
    }
    // a synthetic notice (rate limit, API error) is not the agent working
    const acc = new TranscriptAccumulator()
    acc.feedLines([receipt('2026-11-02T19:31:00.000Z'), asst('2026-11-02T19:36:14.000Z', 'tool_use', '<synthetic>')])
    expect(acc.turnOpen).toBe(false)
  })

  it('toolSince: the ts of the last tool_use with no tool_result yet; cleared by the result, the receipt or an owner message', () => {
    const acc = new TranscriptAccumulator()
    const user = (t: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' }, timestamp: t })
    const use = (t: string, id: string) =>
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'sleep 300' } }] },
        timestamp: t,
      })
    const result = (t: string, id: string) =>
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] }, timestamp: t })
    expect(acc.toolSince).toBeNull()
    acc.feedLines([user('2026-08-25T10:00:00.000Z'), use('2026-08-25T10:00:05.000Z', 'a')])
    expect(acc.toolSince).toBe(Date.parse('2026-08-25T10:00:05.000Z'))
    expect(new TranscriptAccumulator(acc.state).toolSince).toBe(acc.toolSince) // cache round-trip
    acc.feedLines([result('2026-08-25T10:05:05.000Z', 'a')])
    expect(acc.toolSince).toBeNull()
    acc.feedLines([
      use('2026-08-25T10:05:10.000Z', 'b'),
      JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1, timestamp: '2026-08-25T10:05:11.000Z' }),
    ])
    expect(acc.toolSince).toBeNull()
    acc.feedLines([use('2026-08-25T10:06:00.000Z', 'c'), user('2026-08-25T10:07:00.000Z')])
    expect(acc.toolSince).toBeNull()
  })

  it("lastTs = the MOST RECENT timestamp in the content (honest activity), not the file's", () => {
    const acc = new TranscriptAccumulator()
    acc.feedLines([
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, timestamp: '2026-08-22T10:00:00.000Z' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, timestamp: '2026-08-22T10:05:00.000Z' }),
      // an entry with no timestamp (or invalid): doesn't lower or dirty the max
      JSON.stringify({ type: 'system', subtype: 'x' }),
    ])
    expect(acc.lastTs).toBe(Date.parse('2026-08-22T10:05:00.000Z'))
    // survives the cache round-trip (AccumulatorState)
    expect(new TranscriptAccumulator(acc.state).lastTs).toBe(acc.lastTs)
  })

  it('what the harness writes on --resume never moves lastTs (yesterday stays yesterday)', () => {
    const at = (ts: string, o: Record<string, unknown>) => JSON.stringify({ ...o, timestamp: ts })
    const acc = new TranscriptAccumulator()
    acc.feedLines([
      at('2026-10-29T13:00:00.000Z', { type: 'user', message: { role: 'user', content: 'ship it' } }),
      at('2026-10-29T13:05:00.000Z', {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }] },
      }),
      // the resume, a day later
      at('2026-10-30T17:16:37.280Z', { type: 'queue-operation', operation: 'enqueue', content: '<task-notification>\n<status>stopped</status>' }),
      at('2026-10-30T17:16:37.331Z', { type: 'queue-operation', operation: 'dequeue' }),
      at('2026-10-30T17:16:36.752Z', {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu1',
              is_error: true,
              content: "[Tool call interrupted: the session ended before this call's result was recorded]",
            },
          ],
        },
      }),
      at('2026-10-30T17:16:36.752Z', {
        type: 'assistant',
        message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] },
      }),
      at('2026-10-30T17:16:37.334Z', {
        type: 'user',
        origin: { kind: 'task-notification' },
        promptSource: 'system',
        message: { role: 'user', content: '<task-notification>\n<status>stopped</status>' },
      }),
    ])
    expect(acc.lastTs).toBe(Date.parse('2026-10-29T13:05:00.000Z'))
    // real activity after it still counts: a real result, a queued message, a reply
    acc.feedLines([at('2026-10-30T18:00:00.000Z', { type: 'queue-operation', operation: 'enqueue', content: 'and the docs' })])
    expect(acc.lastTs).toBe(Date.parse('2026-10-30T18:00:00.000Z'))
    acc.feedLines([
      at('2026-10-30T18:01:00.000Z', { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'done' }] } }),
    ])
    expect(acc.lastTs).toBe(Date.parse('2026-10-30T18:01:00.000Z'))
  })

  it('activity is an allow-list: a record kind the harness invents tomorrow never moves lastTs', () => {
    const at = (ts: string, o: Record<string, unknown>) => JSON.stringify({ ...o, timestamp: ts })
    const acc = new TranscriptAccumulator()
    acc.feedLines([
      at('2026-10-29T13:00:00.000Z', { type: 'user', message: { role: 'user', content: 'ship it' } }),
      at('2026-10-30T17:00:00.000Z', { type: 'some-future-bookkeeping', note: 'resumed' }),
      at('2026-10-30T17:00:01.000Z', { type: 'system', subtype: 'some_new_notice' }),
      at('2026-10-30T17:00:02.000Z', { type: 'attachment', attachment: { type: 'hook' } }),
      at('2026-10-30T17:00:03.000Z', { type: 'user', promptSource: 'system', message: { role: 'user', content: 'a harness prompt' } }),
    ])
    expect(acc.lastTs).toBe(Date.parse('2026-10-29T13:00:00.000Z'))
    // what somebody did still counts: a turn receipt, a message from another session
    acc.feedLines([at('2026-10-30T18:00:00.000Z', { type: 'system', subtype: 'turn_duration', durationMs: 5 })])
    expect(acc.lastTs).toBe(Date.parse('2026-10-30T18:00:00.000Z'))
    acc.feedLines([
      at('2026-10-30T19:00:00.000Z', {
        type: 'user',
        promptSource: 'system',
        origin: { kind: 'peer' },
        isMeta: true,
        message: { role: 'user', content: 'from builder' },
      }),
    ])
    expect(acc.lastTs).toBe(Date.parse('2026-10-30T19:00:00.000Z'))
  })

  it('with no valid timestamp at all -> lastTs null (the index falls back to the file mtime)', () => {
    const acc = new TranscriptAccumulator()
    acc.feedLines([JSON.stringify({ type: 'user', message: { role: 'user', content: 'no date' } })])
    expect(acc.lastTs).toBeNull()
  })

  it('with no ai-title falls back to the first non-noise user turn', () => {
    const acc = new TranscriptAccumulator()
    acc.feedLines(linesOf('no-ai-title.jsonl'))
    expect(acc.title).toBe('fix the parser bug please')
    expect(acc.titleSource).toBe('user')
  })

  // the skills preamble ChatService.withSkillsPrelude prepends to a first
  // session must not leak into the title — the derivation skips it BEFORE
  // the slice(0,90). The emitted turn's text stays complete (the JSONL's
  // truth is untouched): only the presentation (title) hides it.
  it('the [silos-context] preamble does not enter the title derived from the first user turn', () => {
    const acc = new TranscriptAccumulator()
    const preamble = '[silos-context] Your skills for this session: /finance-skill — load them when the task calls for them. [/silos-context]\n\n'
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: `${preamble}get me the quarterly VAT` },
    })
    const turns = acc.feedLines([line])
    expect(acc.title).toBe('get me the quarterly VAT')
    expect(acc.titleSource).toBe('user')
    expect(turns[0]!.text).toBe(`${preamble}get me the quarterly VAT`) // the JSONL's truth is untouched
  })

  // a first user message that is ONLY the preamble (no real text behind it)
  // used to strip down to '' — and '' passed the `titleSource === null`
  // guard (it's not null), so the title stayed fixed at "" forever: neither
  // session-index.ts's ?? '(untitled)' fallback (only fires on null) nor a
  // later real user turn could ever fix it.
  it('a preamble with NO real text behind it does not set the title — a later user turn can', () => {
    const acc = new TranscriptAccumulator()
    const preamble = '[silos-context] Your skills for this session: /finance-skill — load them when the task calls for them. [/silos-context]\n\n'
    const preambleOnly = JSON.stringify({ type: 'user', message: { role: 'user', content: preamble } })
    acc.feedLines([preambleOnly])
    expect(acc.title).toBeNull()
    expect(acc.titleSource).toBeNull()

    const real = JSON.stringify({ type: 'user', message: { role: 'user', content: 'get me the VAT' } })
    acc.feedLines([real])
    expect(acc.title).toBe('get me the VAT')
    expect(acc.titleSource).toBe('user')
  })

  // the composer's memory mode prepends [silos-memory ...] from the
  // CLIENT side (unlike the skills one, which is server-side) — same title
  // treatment, and both can stack at the start of the same message (a new
  // chat for an agent WITH skills that also starts in memory mode).
  it('the [silos-memory ...] preamble does not enter the derived title either', () => {
    const acc = new TranscriptAccumulator()
    const preamble = '[silos-memory path=/data/agents/a1/memory.md]\nold\n[/silos-memory]\n\n'
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: `${preamble}add a note about X` },
    })
    const turns = acc.feedLines([line])
    expect(acc.title).toBe('add a note about X')
    expect(turns[0]!.text).toBe(`${preamble}add a note about X`) // the JSONL's truth is untouched
  })

  it('stacked skills and memory preambles: neither one enters the title', () => {
    const acc = new TranscriptAccumulator()
    const context = '[silos-context] Your skills for this session: /finance-skill — load them when the task calls for them. [/silos-context]\n\n'
    const memory = '[silos-memory path=/data/agents/a1/memory.md]\nold\n[/silos-memory]\n\n'
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: `${context}${memory}get me the VAT` },
    })
    const turns = acc.feedLines([line])
    expect(acc.title).toBe('get me the VAT')
    expect(turns[0]!.text).toBe(`${context}${memory}get me the VAT`)
  })

  it('is resumable from state (a persistent cache)', () => {
    const acc1 = new TranscriptAccumulator()
    const all = linesOf('basic.jsonl')
    acc1.feedLines(all.slice(0, 6))
    const acc2 = new TranscriptAccumulator(acc1.state)
    const turns = acc2.feedLines(all.slice(6))
    expect(acc2.title).toBe('JSONL parser fix')
    expect(turns[0]?.index).toBe(acc1.turnCount) // indices continue, they don't reset
  })

  it('a corrupt line does not break the rest', () => {
    const acc = new TranscriptAccumulator()
    acc.feedLines(['{this is not json', '{"type":"ai-title","aiTitle":"ok"}'])
    expect(acc.title).toBe('ok')
  })

  it("caps a turn's text at 8000", () => {
    const acc = new TranscriptAccumulator()
    const big = JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(9000) } })
    const [t] = acc.feedLines([big])
    expect(t!.text.length).toBe(8000)
  })
})

describe('TranscriptAccumulator — enrichment (thinking + toolUses)', () => {
  it('captures concatenated thinking and a tool detail linked to its result', () => {
    const acc = new TranscriptAccumulator()
    const turns = acc.feedLines(linesOf('rich.jsonl'))
    expect(turns).toHaveLength(3) // user, assistant(tool), final assistant — the tool_result emits no turn of its own
    const t = turns[1]!
    expect(t.thinking).toBe('The user wants an ls.\n\nI will use Bash.')
    expect(t.toolUses).toHaveLength(1)
    expect(t.toolUses![0]).toMatchObject({ name: 'Bash', skill: null })
    expect(t.toolUses![0]!.input).toContain('ls -la')
    expect(t.toolUses![0]!.result).toContain('file.txt')
    expect(turns[2]!.thinking).toBeUndefined()
    expect(turns[2]!.toolUses).toBeUndefined()
  })
  it('caps: input and result at 2000, thinking at 4000', () => {
    const acc = new TranscriptAccumulator()
    const big = 'x'.repeat(5000)
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: big },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: big } },
          ],
        },
      }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: big }] } }),
    ]
    const [t] = acc.feedLines(lines)
    expect(t!.thinking!.length).toBeLessThanOrEqual(4000)
    expect(t!.toolUses![0]!.input.length).toBeLessThanOrEqual(2000)
    expect(t!.toolUses![0]!.result!.length).toBeLessThanOrEqual(2000)
  })
  it('turns with no tools or thinking carry neither field (compat)', () => {
    const acc = new TranscriptAccumulator()
    const [t] = acc.feedLines([JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })])
    expect('thinking' in t!).toBe(false)
    expect('toolUses' in t!).toBe(false)
  })

  // message.usage.output_tokens is a real JSONL field on assistant entries
  // — we capture it additively for the external status monitor
  // (ExternalStatus sums these tokens per exchange). The JSONL's truth
  // doesn't change, the field is only exposed when present and numeric.
  it('captures message.usage.output_tokens on assistant turns; with no usage, no field', () => {
    const acc = new TranscriptAccumulator()
    const withUsage = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage: { output_tokens: 1234 } },
    })
    const withoutUsage = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'bye' }] },
    })
    const [t0, t1] = acc.feedLines([withUsage, withoutUsage])
    expect(t0!.outputTokens).toBe(1234)
    expect('outputTokens' in t1!).toBe(false)
  })

  it('a non-numeric usage.output_tokens does not set the field', () => {
    const acc = new TranscriptAccumulator()
    const weird = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage: { output_tokens: 'not-a-number' } },
    })
    const [t] = acc.feedLines([weird])
    expect('outputTokens' in t!).toBe(false)
  })
})

describe('TranscriptAccumulator — compact summary (v1.1)', () => {
  // an empirical format: a user entry with isCompactSummary:true and the
  // long summary generated by the harness when compacting. It must emit an
  // empty marker turn, never the real text.
  it("a compact summary emits a marker turn {text:'', compact:true} and does not set a title", () => {
    const acc = new TranscriptAccumulator()
    const line = JSON.stringify({
      type: 'user',
      isCompactSummary: true,
      timestamp: '2026-08-18T10:00:00.000Z',
      message: { role: 'user', content: 'This session is being continued from a previous conversation…' },
    })
    const turns = acc.feedLines([line])
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ role: 'user', text: '', compact: true })
    expect(JSON.stringify(turns[0])).not.toContain('This session is being continued')
    expect(acc.title).toBeNull()
    expect(acc.titleSource).toBeNull()
  })

  it('a real user turn after the compact summary does set a title', () => {
    const acc = new TranscriptAccumulator()
    const compact = JSON.stringify({
      type: 'user',
      isCompactSummary: true,
      message: { role: 'user', content: 'This session is being continued from a previous conversation…' },
    })
    const real = JSON.stringify({ type: 'user', message: { role: 'user', content: 'continue where we left off' } })
    acc.feedLines([compact, real])
    expect(acc.title).toBe('continue where we left off')
    expect(acc.titleSource).toBe('user')
  })
})

describe('TranscriptAccumulator — context and model (v1.1)', () => {
  it('sums input_tokens + cache_creation_input_tokens + cache_read_input_tokens and captures message.model', () => {
    const acc = new TranscriptAccumulator()
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-haiku-4-5-20251001',
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 2, cache_creation_input_tokens: 1043, cache_read_input_tokens: 107611 },
      },
    })
    acc.feedLines([line])
    expect(acc.state.contextTokens).toBe(108656)
    expect(acc.state.model).toBe('claude-haiku-4-5-20251001')
  })

  it('a later assistant with a bigger usage overwrites the accumulated context', () => {
    const acc = new TranscriptAccumulator()
    const first = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-haiku-4-5-20251001',
        content: [{ type: 'text', text: 'a' }],
        usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 },
      },
    })
    const second = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'b' }],
        usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 200000 },
      },
    })
    acc.feedLines([first, second])
    expect(acc.state.contextTokens).toBe(200002)
    expect(acc.state.model).toBe('claude-sonnet-4-5')
  })

  it('missing/partial usage does not break: sums only the numbers present; with none, leaves the accumulator untouched', () => {
    const acc = new TranscriptAccumulator()
    const withSome = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'a' }], usage: { input_tokens: 5 } },
    })
    acc.feedLines([withSome])
    expect(acc.state.contextTokens).toBe(5)

    const withoutUsage = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
    })
    acc.feedLines([withoutUsage])
    expect(acc.state.contextTokens).toBe(5) // untouched

    const acc2 = new TranscriptAccumulator()
    acc2.feedLines([withoutUsage])
    expect(acc2.state.contextTokens).toBeNull()
  })
})

describe('TranscriptAccumulator — external queue (v1.1, queue-operation)', () => {
  it('enqueue/remove-first-match/dequeue/popAll follow the expected sequence', () => {
    const acc = new TranscriptAccumulator()
    const op = (operation: string, content?: string) => JSON.stringify({ type: 'queue-operation', operation, ...(content !== undefined ? { content } : {}) })

    acc.feedLines([op('enqueue', 'a')])
    expect(acc.state.queue).toEqual(['a'])
    acc.feedLines([op('enqueue', 'b')])
    expect(acc.state.queue).toEqual(['a', 'b'])
    acc.feedLines([op('enqueue', 'a')])
    expect(acc.state.queue).toEqual(['a', 'b', 'a'])
    acc.feedLines([op('remove', 'a')])
    expect(acc.state.queue).toEqual(['b', 'a']) // removes only the first match
    acc.feedLines([op('dequeue')])
    expect(acc.state.queue).toEqual(['a'])
    acc.feedLines([op('popAll')])
    expect(acc.state.queue).toEqual([])
  })

  it('cap: 21 enqueues leaves queue.length at 20', () => {
    const acc = new TranscriptAccumulator()
    const lines = Array.from({ length: 21 }, (_, i) => JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: `m${i}` }))
    acc.feedLines(lines)
    expect(acc.state.queue).toHaveLength(20)
  })

  it('queue-operation emits no turn (it has no message)', () => {
    const acc = new TranscriptAccumulator()
    const turns = acc.feedLines([JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'a' })])
    expect(turns).toHaveLength(0)
  })
})

describe('TranscriptAccumulator — v1.1 round-trip via state', () => {
  it('contextTokens/model/queue survive new TranscriptAccumulator(state)', () => {
    const acc1 = new TranscriptAccumulator()
    acc1.feedLines([
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'pending' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-haiku-4-5-20251001',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 2, cache_creation_input_tokens: 1043, cache_read_input_tokens: 107611 },
        },
      }),
    ])
    const acc2 = new TranscriptAccumulator(acc1.state)
    expect(acc2.state.contextTokens).toBe(108656)
    expect(acc2.state.model).toBe('claude-haiku-4-5-20251001')
    expect(acc2.state.queue).toEqual(['pending'])
  })
})

describe('interjectionsOf (rescuing mid-turn messages)', () => {
  it('with no harness marker returns []', () => {
    expect(interjectionsOf('normal output from a tool, nothing special here')).toEqual([])
  })

  it('extracts the wrapped text of an interjection', () => {
    const text =
      'Tool ran without output or error\n\nThe user sent a new message while you were working:\nwait, change direction\n\nThis is how Claude Code surfaces messages the user sends mid-turn — respond to it now or continue your current task.'
    expect(interjectionsOf(text)).toEqual(['wait, change direction'])
  })

  it('extracts several consecutive interjections in the same text, in order', () => {
    // each interjection is wrapped with its own boilerplate before the
    // next one (the harness's real format) — not a simple line break.
    const text =
      'Tool output.\n\nThe user sent a new message while you were working:\nfirst interjection\n\nThis is how Claude Code surfaces messages the user sends mid-turn — respond to it now or continue your current task.\n\nThe user sent a new message while you were working:\nsecond interjection\n\nThis is how Claude Code surfaces messages the user sends mid-turn — respond to it now or continue your current task.'
    expect(interjectionsOf(text)).toEqual(['first interjection', 'second interjection'])
  })

  // a REAL interjection can span several paragraphs (the owner writes with
  // blank line breaks) — the regex's closing boundary can no longer be a
  // simple '\n\n' because it would cut the interjection in half. The
  // correct closing boundary is the harness's real boilerplate, not any '\n\n'.
  it('rescues a multi-paragraph interjection COMPLETE, up to the real boilerplate', () => {
    const text =
      'Tool output.\n\nThe user sent a new message while you were working:\nparagraph one with an idea.\n\nparagraph two, the continuation.\n\nThis is how Claude Code surfaces messages the user sends mid-turn — respond to it now or continue your current task.'
    expect(interjectionsOf(text)).toEqual(['paragraph one with an idea.\n\nparagraph two, the continuation.'])
  })

  it('an interjection with no boilerplate after it (end of text) is rescued to the end', () => {
    const text = 'Tool output.\n\nThe user sent a new message while you were working:\nmessage stuck at the end, no boilerplate behind it'
    expect(interjectionsOf(text)).toEqual(['message stuck at the end, no boilerplate behind it'])
  })

  // two interjections that share a SINGLE final boilerplate (the harness
  // doesn't always wrap each message with its own individual boilerplate —
  // sometimes it's two markers in a row and the boilerplate only closes
  // the whole block). The closing boundary must also stop at the next
  // marker, otherwise the first capture swallows the literal "The user
  // sent a new message while you were working:\n" plus the second
  // interjection's text, merging them into one corrupted string.
  it('two interjections sharing a single final boilerplate are rescued cleanly, without merging', () => {
    const text =
      'Tool output.\n\nThe user sent a new message while you were working:\nfirst\n\nThe user sent a new message while you were working:\nsecond\n\nThis is how Claude Code surfaces messages the user sends mid-turn — respond to it now or continue your current task.'
    expect(interjectionsOf(text)).toEqual(['first', 'second'])
  })
})

describe('TranscriptAccumulator — mid-turn interjections', () => {
  it('a tool_result with the harness wrapper emits a user turn with interjection:true', () => {
    const acc = new TranscriptAccumulator()
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2026-08-18T10:00:00.000Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content:
              'Tool ran without output or error\n\nThe user sent a new message while you were working:\nhold on, change of plan\n\nThis is how Claude Code surfaces messages the user sends mid-turn — respond to it now or continue your current task.',
          },
        ],
      },
    })
    const turns = acc.feedLines([line])
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({
      index: 0,
      role: 'user',
      text: 'hold on, change of plan',
      tools: [],
      ts: '2026-08-18T10:00:00.000Z',
      interjection: true,
    })
    expect(acc.turnCount).toBe(1)
  })

  it('two interjections in the same tool_result emit two turns, in order and with consecutive indices', () => {
    const acc = new TranscriptAccumulator()
    const content =
      'Tool output.\n\nThe user sent a new message while you were working:\nfirst interjection\n\nThis is how Claude Code surfaces messages the user sends mid-turn — respond to it now or continue your current task.\n\nThe user sent a new message while you were working:\nsecond interjection\n\nThis is how Claude Code surfaces messages the user sends mid-turn — respond to it now or continue your current task.'
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2026-08-18T10:01:00.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_2', content }] },
    })
    const turns = acc.feedLines([line])
    expect(turns.map((t) => [t.index, t.text, t.interjection])).toEqual([
      [0, 'first interjection', true],
      [1, 'second interjection', true],
    ])
    expect(acc.turnCount).toBe(2)
  })

  // regression guard: rich.jsonl has a normal tool_result (no wrapper) —
  // it must keep emitting no turn of its own, exactly as before this feature.
  it('a tool_result with no wrapper emits no interjection turn (rich.jsonl unaffected)', () => {
    const acc = new TranscriptAccumulator()
    const turns = acc.feedLines(linesOf('rich.jsonl'))
    expect(turns).toHaveLength(3)
    expect(turns.some((t) => t.interjection)).toBe(false)
  })
})

// a real inventory from the corpus: system/turn_duration (CLI receipts) and
// assistant entries with message.model="<synthetic>" (harness notices: rate
// limits, API errors...).
describe('TranscriptAccumulator — turn_duration receipts', () => {
  it("system/turn_duration emits a marker turn {text:'', durationMs} with a ts", () => {
    const acc = new TranscriptAccumulator()
    const line = JSON.stringify({
      type: 'system',
      subtype: 'turn_duration',
      durationMs: 19254,
      messageCount: 23,
      timestamp: '2026-08-17T16:53:18.093Z',
      isMeta: false,
    })
    const turns = acc.feedLines([line])
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ role: 'assistant', text: '', durationMs: 19254, ts: '2026-08-17T16:53:18.093Z' })
  })

  it('other system subtypes emit nothing (the original behavior)', () => {
    const acc = new TranscriptAccumulator()
    const boundary = JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-08-17T16:53:18.093Z' })
    const info = JSON.stringify({ type: 'system', subtype: 'informational', content: 'Remote Control disconnected', level: 'warning' })
    expect(acc.feedLines([boundary, info])).toHaveLength(0)
  })

  it('a non-numeric or negative durationMs emits no turn', () => {
    const acc = new TranscriptAccumulator()
    const bad = JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: '19254' })
    const negative = JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: -5 })
    expect(acc.feedLines([bad, negative])).toHaveLength(0)
  })
})

// Working != live: message.stop_reason from the corpus — "end_turn" ONLY on
// a turn's final message; intermediate ones (including text between tools)
// carry "tool_use". An honest close for SDK sessions with no marker.
describe('TranscriptAccumulator — turnEnded (stop_reason end_turn)', () => {
  const assistant = (stopReason: string | null, content: unknown[]): string =>
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-23T19:04:25.000Z',
      message: { role: 'assistant', model: 'claude-fable-5', stop_reason: stopReason, content },
    })

  it("a turn's final text (end_turn) comes out with turnEnded:true", () => {
    const acc = new TranscriptAccumulator()
    const turns = acc.feedLines([assistant('end_turn', [{ type: 'text', text: 'Done.' }])])
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ role: 'assistant', text: 'Done.', turnEnded: true })
  })

  it('an intermediate text (stop_reason tool_use) does NOT carry turnEnded', () => {
    const acc = new TranscriptAccumulator()
    const turns = acc.feedLines([assistant('tool_use', [{ type: 'text', text: "I'll take a look." }])])
    expect(turns).toHaveLength(1)
    expect(turns[0]!.turnEnded).toBeUndefined()
  })

  it('a synthetic notice never claims the close even with end_turn', () => {
    const acc = new TranscriptAccumulator()
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-23T19:04:25.000Z',
      message: { role: 'assistant', model: '<synthetic>', stop_reason: 'end_turn', content: [{ type: 'text', text: 'API error' }] },
    })
    const turns = acc.feedLines([line])
    expect(turns).toHaveLength(1)
    expect(turns[0]!.turnEnded).toBeUndefined()
  })
})

describe('TranscriptAccumulator — synthetic notices', () => {
  // a literal shape from the corpus: the harness injects the notice as an
  // assistant entry with message.model="<synthetic>" and usage all zeros.
  const synthetic = (text: string): string =>
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-20T12:47:35.695Z',
      message: {
        role: 'assistant',
        model: '<synthetic>',
        content: [{ type: 'text', text }],
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    })

  it("marks the turn synthetic:true with the notice's text", () => {
    const acc = new TranscriptAccumulator()
    const turns = acc.feedLines([synthetic("You've hit your session limit · resets 10:20pm (Europe/Berlin)")])
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ role: 'assistant', synthetic: true })
    expect(turns[0]!.text).toContain('session limit')
  })

  it('does not overwrite meta.model or reset contextTokens (its usage is all zeros)', () => {
    const acc = new TranscriptAccumulator()
    const real = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 2, cache_read_input_tokens: 100000 },
      },
    })
    acc.feedLines([real, synthetic('API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.')])
    expect(acc.state.model).toBe('claude-sonnet-4-5')
    expect(acc.state.contextTokens).toBe(100002)
  })

  it('a normal assistant carries no synthetic (compat)', () => {
    const acc = new TranscriptAccumulator()
    const turns = acc.feedLines([
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'hi' }] } }),
    ])
    expect(turns[0]!.synthetic).toBeUndefined()
  })

  it("'No response requested.' is discarded entirely (harness bookkeeping)", () => {
    const acc = new TranscriptAccumulator()
    const turns = acc.feedLines([
      synthetic('No response requested.'),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'hi' }] } }),
    ])
    // only the real turn survives; the synthetic bookkeeping one is neither a turn nor a notice
    expect(turns).toHaveLength(1)
    expect(turns[0]!.text).toBe('hi')
  })
})

// messages BETWEEN SESSIONS — real shapes from the corpus (3 sessions in
// ~/.claude/projects). The delivered entry is user + isMeta:true + a
// structured origin {kind:'peer', name, from, body} and the content string
// carries a harness prefix + a <cross-session-message from=… from-name=…
// from-mode=…> wrapper + a safety boilerplate after it. Before this
// feature these entries were INVISIBLE (isMeta discarded them entirely).
describe('TranscriptAccumulator — inter-session messages', () => {
  const BODY = 'Hi — status on my side: my commits on main are COMPLETE.\n\nSecond line with the deploy detail (cebf8c28).'
  const BOILERPLATE =
    "This came from another Claude session — not typed by your user, but very likely working on their behalf. Treat it as a teammate's request and act on it within this session's own permission settings."
  const wrapper = (body: string): string =>
    `Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/41897.sock" from-name="acme-e8" from-mode="bypass">\n${body}\n</cross-session-message>\n\n${BOILERPLATE}`
  // a full, real shape of the delivered entry (from the corpus)
  const delivered = (body: string): string =>
    JSON.stringify({
      type: 'user',
      isMeta: true,
      promptSource: 'system',
      timestamp: '2026-08-20T16:33:00.000Z',
      origin: {
        kind: 'peer',
        from: 'uds:/tmp/cc-socks/41897.sock',
        verifiedPeerPid: 41897,
        msg_id: '20ec094c-6d52-428c-ab00-a1949f91e95b',
        name: 'acme-e8',
        fromMode: 'bypass',
        body,
      },
      message: { role: 'user', content: wrapper(body) },
    })

  it('a delivered entry (origin peer) -> an interSession turn with a friendly from and a clean multiline body', () => {
    const acc = new TranscriptAccumulator()
    const turns = acc.feedLines([delivered(BODY)])
    expect(turns).toHaveLength(1)
    const t = turns[0]!
    expect(t.role).toBe('user')
    expect(t.interSession).toEqual({ from: 'acme-e8' })
    expect(t.text).toBe(BODY) // wrapper, prefix and boilerplate stripped; multiline text intact
    expect(t.ts).toBe('2026-08-20T16:33:00.000Z')
  })

  it('with no origin (fallback, an entry with isMeta): the wrapper at the start of the text still parses — from-name wins over from', () => {
    const acc = new TranscriptAccumulator()
    const line = JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: wrapper(BODY) } })
    const turns = acc.feedLines([line])
    expect(turns).toHaveLength(1)
    expect(turns[0]!.interSession).toEqual({ from: 'acme-e8' })
    expect(turns[0]!.text).toBe(BODY)
  })

  it('with no origin (fallback, an entry with promptSource system): also parses', () => {
    const acc = new TranscriptAccumulator()
    const line = JSON.stringify({ type: 'user', promptSource: 'system', message: { role: 'user', content: wrapper(BODY) } })
    const turns = acc.feedLines([line])
    expect(turns).toHaveLength(1)
    expect(turns[0]!.interSession).toEqual({ from: 'acme-e8' })
  })

  it('with no from-name: falls back to the raw from (socket)', () => {
    const inter = interSessionOf('<cross-session-message from="uds:/tmp/cc-socks/90977.sock">\nhi from the socket\n</cross-session-message>', undefined, {
      isMeta: true,
    })
    expect(inter).toEqual({ from: 'uds:/tmp/cc-socks/90977.sock', text: 'hi from the socket' })
  })

  it('a hop-chain and other attributes do not interfere with parsing from', () => {
    const inter = interSessionOf(
      '<cross-session-message from="uds:/tmp/cc-socks/90977.sock" hop-chain="af20a9b59070a990a3a0a540" from-name="acme-c6" from-mode="bypass">\nbody\n</cross-session-message>',
      undefined,
      { isMeta: true },
    )
    expect(inter).toEqual({ from: 'acme-c6', text: 'body' })
  })

  // the text-based fallback also requires the harness's meta markers
  // (isMeta:true or promptSource:'system') — a message the OWNER types or
  // pastes that happens to start with the literal tag (e.g. a JSONL
  // snippet while debugging this very feature) must never be reclassified
  // as a third voice. With no markers, the text follows the usual normal
  // user treatment — and the existing noise rule (anything starting with
  // '<') filters it, same as any other XML paste from the owner (the
  // pre-existing behavior).
  it('a user with NO meta markers whose text STARTS with the literal tag is NOT interSession', () => {
    const acc = new TranscriptAccumulator()
    const text = '<cross-session-message from="x" from-name="spoof">\nI am not a real peer\n</cross-session-message>'
    const turns = acc.feedLines([JSON.stringify({ type: 'user', message: { role: 'user', content: text } })])
    expect(turns.every((t) => t.interSession === undefined)).toBe(true)
    expect(acc.title).toBeNull() // and sets no title either (the usual noise rule)
    // the origin-based path stays intact: the same text WITH an origin peer is interSession
    expect(interSessionOf(text, { kind: 'peer', name: 'real', body: 'body' })).toEqual({ from: 'real', text: 'body' })
  })

  it('guard: a user who only MENTIONS the tag mid-text is NOT interSession (a normal turn)', () => {
    const acc = new TranscriptAccumulator()
    const text = 'hey, the parser is swallowing whole <cross-session-message from="x"> tags, fix it'
    const turns = acc.feedLines([JSON.stringify({ type: 'user', message: { role: 'user', content: text } })])
    expect(turns).toHaveLength(1)
    expect(turns[0]!.interSession).toBeUndefined()
    expect(turns[0]!.text).toBe(text)
    expect(acc.title).toBe(text.slice(0, 90)) // still a normal user turn: sets a title
  })

  it('an inter-session message NEVER sets the session title', () => {
    const acc = new TranscriptAccumulator()
    acc.feedLines([delivered(BODY)])
    expect(acc.title).toBeNull()
    expect(acc.titleSource).toBeNull()
  })

  it('the rest of the "<" noise stays filtered: task-notification and system-reminder emit no turn', () => {
    const acc = new TranscriptAccumulator()
    const turns = acc.feedLines([
      JSON.stringify({ type: 'user', message: { role: 'user', content: '<task-notification>\n<task-id>abc123</task-id>\n</task-notification>' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '<system-reminder>something</system-reminder>' } }),
    ])
    expect(turns).toHaveLength(0)
  })

  it('a queue-operation copy (raw content with the wrapper, starting with "<") stays out of the queue', () => {
    const acc = new TranscriptAccumulator()
    acc.feedLines([
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content: '<cross-session-message from="uds:/tmp/cc-socks/41897.sock" from-name="acme-e8" from-mode="bypass">\nhi\n</cross-session-message>',
      }),
    ])
    expect(acc.queue).toEqual([])
  })

  it('interSessionOf: normal text and empty content -> null (with or without meta markers)', () => {
    expect(interSessionOf('fix the bug')).toBeNull()
    expect(interSessionOf('fix the bug', undefined, { isMeta: true })).toBeNull()
    expect(interSessionOf('', undefined, { isMeta: true })).toBeNull()
    expect(interSessionOf(null, undefined, { isMeta: true })).toBeNull()
  })
})

// Claude Code (2.1.207+) forks on `--resume`: the NEW file's records carry
// `session_id` = the origin and `sessionId` = the file itself. The first
// such origin is the chain link; a file that is its own start has none.
describe('TranscriptAccumulator — resumedFrom', () => {
  const line = (o: Record<string, unknown>): string =>
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, timestamp: '2026-08-26T07:45:34.496Z', ...o })
  it('reads the origin from session_id ≠ sessionId, once', () => {
    const acc = new TranscriptAccumulator()
    acc.feedLines([line({ sessionId: 'new', session_id: 'old' }), line({ sessionId: 'new', session_id: 'other' })])
    expect(acc.resumedFrom).toBe('old')
    expect(acc.state.resumedFrom).toBe('old')
  })
  // Claude Code 2.1.33x: the --resume twin names its origin in its own
  // record — unread, a console relaunch split the thread in two
  it('reads the origin from a derived-from record via fork; a /clear or a self-reference is no resume origin', () => {
    const fork = new TranscriptAccumulator()
    fork.feedLines([
      JSON.stringify({ type: 'derived-from', v: 1, sessionId: 'new', sessions: [{ type: 'claude_code_session', id: 'old', via: 'fork' }] }),
      line({ sessionId: 'new' }),
    ])
    expect(fork.resumedFrom).toBe('old')
    const cleared = new TranscriptAccumulator()
    cleared.feedLines([
      JSON.stringify({
        type: 'derived-from',
        v: 1,
        sessionId: 'new',
        sessions: [
          { id: 'old', via: 'clear' },
          { id: 'old', via: 'compact' },
        ],
      }),
    ])
    expect(cleared.resumedFrom).toBeNull()
    const self = new TranscriptAccumulator()
    self.feedLines([JSON.stringify({ type: 'derived-from', sessionId: 'me', sessions: [{ id: 'me', via: 'fork' }] })])
    expect(self.resumedFrom).toBeNull()
  })
  it('stays null when the record names itself (or carries no ids); restored from state', () => {
    const acc = new TranscriptAccumulator()
    acc.feedLines([line({ sessionId: 'me', session_id: 'me' }), line({})])
    expect(acc.resumedFrom).toBeNull()
    const restored = new TranscriptAccumulator({ ...acc.state, resumedFrom: 'x' })
    expect(restored.resumedFrom).toBe('x')
  })
})

// A console `/clear` starts a new file whose first records are the
// SessionStart hooks' output, filed as "SessionStart:clear" — the only mark
// a /clear leaves in the transcript (a startup or a resume names itself
// differently).
describe('TranscriptAccumulator — startedByClear', () => {
  const hook = (hookName: string): string =>
    JSON.stringify({
      parentUuid: null,
      attachment: { type: 'hook_success', hookName, hookEvent: 'SessionStart', content: '' },
      type: 'attachment',
      timestamp: '2026-10-20T07:45:34.496Z',
    })
  it('marks a transcript started by /clear, and survives the cache', () => {
    const acc = new TranscriptAccumulator()
    acc.feedLines([hook('SessionStart:clear')])
    expect(acc.startedByClear).toBe(true)
    expect(new TranscriptAccumulator(acc.state).startedByClear).toBe(true)
  })
  it('a startup or resume hook is not a /clear; an old cache reads false', () => {
    const acc = new TranscriptAccumulator()
    acc.feedLines([hook('SessionStart:startup'), hook('SessionStart:resume')])
    expect(acc.startedByClear).toBe(false)
    const { startedByClear: _drop, ...old } = acc.state
    expect(new TranscriptAccumulator(old).startedByClear).toBe(false)
  })
})

// «Open» goes to a console only when the agent has one in the index:
// Claude Code stamps each record with `entrypoint` — the
// first one seen decides, and the cache keeps it.
describe('TranscriptAccumulator — console (entrypoint)', () => {
  const rec = (entrypoint: string): string =>
    JSON.stringify({ type: 'user', entrypoint, sessionId: 's', timestamp: '2026-11-10T09:00:00.000Z', message: { role: 'user', content: 'hi' } })
  it('cli is a console, sdk is a chat — the first seen decides, and survives the cache', () => {
    const cli = new TranscriptAccumulator()
    cli.feedLines([rec('cli'), rec('sdk-ts')])
    expect(cli.console).toBe(true)
    expect(new TranscriptAccumulator(cli.state).console).toBe(true)
    const sdk = new TranscriptAccumulator()
    sdk.feedLines([rec('sdk-ts')])
    expect(sdk.console).toBe(false)
    const resumed = new TranscriptAccumulator(sdk.state)
    resumed.feedLines([rec('cli')])
    expect(resumed.console).toBe(false)
  })
  it('no entrypoint yet: unknown, and an old cache reads unknown', () => {
    const acc = new TranscriptAccumulator()
    acc.feedLines([JSON.stringify({ type: 'summary', summary: 'x' })])
    expect(acc.console).toBeNull()
    const { console: _drop, ...old } = acc.state
    expect(new TranscriptAccumulator(old).console).toBeNull()
  })
})

// Newer Claude Code writes `api-request-blob` records — the request body it
// sent, replaying system/user/assistant messages with a `message.role`. A
// reader that classified by `message.role` alone painted each as an extra
// turn (a reply and its Bash chip twice — run 3049cb69). The rule:
// only records whose own `type` is 'user' | 'assistant' are conversation.
describe('request blobs are never conversation', () => {
  it('conversationalMessage: only type user|assistant with an agreeing role', () => {
    expect(conversationalMessage({ type: 'user', message: { role: 'user', content: 'hi' } })?.role).toBe('user')
    expect(conversationalMessage({ type: 'assistant', message: { role: 'assistant', content: [] } })?.role).toBe('assistant')
    for (const role of ['user', 'assistant', 'system']) {
      expect(conversationalMessage({ type: 'api-request-blob', message: { role, content: 'x' } })).toBeNull()
    }
    expect(conversationalMessage({ type: 'user', message: { role: 'assistant', content: 'x' } })).toBeNull()
    expect(conversationalMessage({ type: 'user' })).toBeNull()
    expect(conversationalMessage({ message: { role: 'user', content: 'x' } })).toBeNull()
  })

  it('a transcript with blob records yields each turn once, tool chips once, and the right last role', () => {
    const acc = new TranscriptAccumulator()
    const turns = acc.feedLines(linesOf('request-blobs.jsonl'))
    expect(turns.map((t) => [t.role, t.text, t.tools])).toEqual([
      ['user', 'check the disk', []],
      ['assistant', 'Looking at the disk usage.', ['Bash']],
      ['assistant', 'The disk is 40% full.', []],
    ])
    expect(turns[1]!.toolUses?.[0]?.result).toBe('/dev/sda1 40%')
    expect(acc.turnCount).toBe(3)
    expect(acc.lastRole).toBe('assistant')
    expect(acc.turnOpen).toBe(false) // a trailing assistant blob doesn't reopen anything
  })
})
