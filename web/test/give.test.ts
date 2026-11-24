// give.test.ts — the Give button's words:
// the button says what will happen, by control; Open names its surface; the
// live line goes Starting → on it → or couldn't start, and paints both queues.
import { describe, it, expect } from 'vitest'
import { controlOf, giveVoice, liveLine, liveStateOf, surfaceOf, surfaceOfAgent, writeVoice } from '../src/lib/give'
import { pulseOf } from '../src/lib/turn-pulse'

describe("controlOf — the server's derived control", () => {
  it('own only when the server says so now; anything else is told', () => {
    expect(controlOf({ controlNow: 'own' })).toBe('own')
    expect(controlOf({ controlNow: 'told' })).toBe('told')
    // a stored own the server degraded, or a roster from before: told
    expect(controlOf({})).toBe('told')
    expect(controlOf(null)).toBe('told')
  })
})

describe('surfaceOfAgent', () => {
  it("reads the overview's facts; unknown ⇒ chat (the first console is the owner's to open)", () => {
    expect(surfaceOfAgent({ open: { hasConsole: true, consoleBriefs: true } })).toBe('console')
    expect(surfaceOfAgent({ open: { hasConsole: true, consoleBriefs: false } })).toBe('chat')
    expect(surfaceOfAgent({})).toBe('chat')
  })
})

// task-live: the sequence Starting → on it → or couldn't start, from the
// server's facts and the WS stream (never "on it" on the click)
describe("liveStateOf — the server's facts read with the stream", () => {
  const running = { kind: 'running' as const, turns: [{ turnId: 'k1', sessionId: null, started: false }] }
  it('handed to a turn: Starting — never «on it» at the click', () => {
    expect(liveStateOf(running, {})).toEqual({ kind: 'starting' })
  })
  it('its first output: on it, with the last tool and when', () => {
    let p = pulseOf({}, { ev: 'chat-init', turnId: 'k1', folder: 'f', sessionId: 's' }, 1000)
    expect(liveStateOf(running, p)).toEqual({ kind: 'starting' })
    p = pulseOf(p, { ev: 'chat-tool', turnId: 'k1', name: 'Read' }, 2000)
    expect(liveStateOf(running, p)).toEqual({ kind: 'on-it', tool: 'Read', lastAt: 2000 })
    p = pulseOf(p, { ev: 'chat-delta', turnId: 'k1', text: 'ok' }, 3000)
    expect(liveStateOf(running, p)).toEqual({ kind: 'on-it', tool: 'Read', lastAt: 3000 })
  })
  it("an error before anything: couldn't start, with why", () => {
    const p = pulseOf({}, { ev: 'chat-error', turnId: 'k1', error: 'spawn claude ENOENT' }, 1000)
    expect(liveStateOf(running, p)).toEqual({ kind: 'failed', why: 'spawn claude ENOENT' })
  })
  it("the server's holds: both queues, a failed start, a console", () => {
    expect(liveStateOf({ kind: 'queued', cap: 'agent', running: 2 }, {})).toEqual({ kind: 'queued-agent', running: 2 })
    expect(liveStateOf({ kind: 'queued', cap: 'global', running: 6 }, {})).toEqual({ kind: 'queued-fleet', running: 6 })
    expect(liveStateOf({ kind: 'failed', why: "its engine can't run: missing", engine: true }, {})).toEqual({
      kind: 'failed',
      why: "its engine can't run: missing",
      engine: true,
    })
    expect(liveStateOf({ kind: 'console', sessionId: 's' }, {})).toEqual({ kind: 'console' })
    expect(liveStateOf(null, {})).toBeNull()
  })
  it('started on the server, nothing heard since you came: on it, no clock', () => {
    const l = liveLine('Ana', liveStateOf({ kind: 'running', turns: [{ turnId: 'z', sessionId: 's', started: true }] }, {})!, 0)
    expect(l.stop).toBe(true)
    expect(l.text).not.toMatch(/ago/)
  })
})

describe('surfaceOf', () => {
  it('console only when one exists AND it takes the briefing; chat otherwise', () => {
    expect(surfaceOf({ hasConsole: true, consoleBriefs: true })).toBe('console')
    expect(surfaceOf({ hasConsole: false, consoleBriefs: true })).toBe('chat')
    expect(surfaceOf({ hasConsole: true, consoleBriefs: false })).toBe('chat')
  })
})

describe('giveVoice', () => {
  it('own: assigns now, save for later beside it', () => {
    expect(giveVoice({ owner: { name: 'Ana', control: 'own', surface: 'chat' } })).toMatchObject({
      primary: { act: 'assign' },
      secondary: { act: 'save' },
    })
  })
  it('told: opens the surface with you', () => {
    const c = giveVoice({ owner: { name: 'Ana', control: 'told', surface: 'console' } })
    expect(c.primary.act).toBe('open')
    expect(c.primary.label).toMatch(/console/)
    expect(giveVoice({ owner: { name: 'Ana', control: 'told', surface: 'chat' } }).primary.label).toMatch(/chat/)
  })
  it('told on a phone: no surface to open', () => {
    expect(giveVoice({ owner: { name: 'Ana', control: 'told', surface: 'console' }, mobile: true }).primary.label).not.toMatch(/console/)
  })
  it('yours: adds to my list, nothing beside it', () => {
    expect(giveVoice({ owner: null })).toMatchObject({ primary: { act: 'add' }, secondary: null, line: null })
  })
})

describe('liveLine', () => {
  const now = 100_000
  it("Starting → on it with the last tool → couldn't start", () => {
    expect(liveLine('Ana', { kind: 'starting' }, now).stop).toBe(true)
    const on = liveLine('Ana', { kind: 'on-it', tool: 'Read', lastAt: now - 4_000 }, now)
    expect(on.stop).toBe(true)
    expect(on.text).toContain('Read')
    expect(on.text).toContain('4s')
    const failed = liveLine('Ana', { kind: 'failed', why: 'its account is at its usage limit' }, now)
    expect(failed.stop).toBe(false)
    expect(failed.text).toContain('its account is at its usage limit')
  })
  it('a console on it has no Stop', () => {
    expect(liveLine('Ana', { kind: 'console' }, now).stop).toBe(false)
  })
})

describe('writeVoice', () => {
  it('own: no Send and open', () => {
    expect(writeVoice({ name: 'Ana', control: 'own', finished: false, held: null }).secondary).toBeNull()
  })
  it('told: Send and open beside Send', () => {
    expect(writeVoice({ name: 'Ana', control: 'told', finished: false, held: null }).secondary).not.toBeNull()
  })
  it('held: the box says why the note waits', () => {
    expect(writeVoice({ name: 'Ana', control: 'own', finished: false, held: 'its turn is running' }).placeholder).toContain('its turn is running')
  })
  it('closed: told still offers Send and open', () => {
    expect(writeVoice({ name: 'Ana', control: 'told', finished: true, held: null }).secondary).not.toBeNull()
  })
  it('told on a phone: Send alone — no console to open', () => {
    expect(writeVoice({ name: 'Ana', control: 'told', finished: false, held: null, mobile: true }).secondary).toBeNull()
  })
  it('yours: a note for the record, nothing beside it', () => {
    expect(writeVoice({ name: null, control: 'told', finished: false, held: null }).secondary).toBeNull()
  })
})
