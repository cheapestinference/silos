import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionIndex } from '../src/session-index.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { SessionStore } from '../src/session-store.js'
import { Titler, sanitizeTitle, type TitleInput } from '../src/titler.js'
import { generateTitleWithSdk } from '../src/harnesses/claude-code/titler-sdk.js'
import type { SdkMessage } from '../src/harnesses/claude-code/sdk-types.js'

// tests NEVER call the real SDK: generateTitle is always an injected fake
// (see TitlerDeps.generateTitle).

describe('sanitizeTitle', () => {
  // a kebab-case SLUG (#things-around-the-house) — spaces/punctuation -> hyphens.
  it('strips #, quotes; a lowercase kebab-case slug', () => {
    expect(sanitizeTitle('#invoice-sync')).toBe('invoice-sync')
    expect(sanitizeTitle('"Deploy VPS."')).toBe('deploy-vps')
    expect(sanitizeTitle('  Invoice   Sync!  ')).toBe('invoice-sync')
    expect(sanitizeTitle('«Piñata café»…')).toBe('piñata-café') // keeps accents/ñ
    expect(sanitizeTitle('Things around the house')).toBe('things-around-the-house')
  })
  it('a single word is valid; trims to 40 chars on a hyphen boundary', () => {
    expect(sanitizeTitle('invoice')).toBe('invoice')
    const long = sanitizeTitle('comprehensive-technical-documentation-of-taxation')
    expect(long).not.toBeNull()
    expect(long!.length).toBeLessThanOrEqual(40)
    expect(long!.endsWith('-')).toBe(false)
  })
  it('rejects multiline, more than 6 segments, and empty input', () => {
    expect(sanitizeTitle('invoice sync\nand more explanation')).toBeNull()
    expect(sanitizeTitle('one two three four five six seven')).toBeNull()
    expect(sanitizeTitle('')).toBeNull()
    expect(sanitizeTitle('   ')).toBeNull()
    expect(sanitizeTitle('---')).toBeNull() // only separators -> empty after hyphenation
  })
  it('strips emoji; emoji-only is rejected', () => {
    expect(sanitizeTitle('🚀 deploy vps ✅')).toBe('deploy-vps')
    expect(sanitizeTitle('🚀🎉')).toBeNull()
  })
  it('strips bidi overrides, zero-widths and flags; empty after cleanup is rejected', () => {
    expect(sanitizeTitle('deploy\u202Evps')).toBe('deployvps') // U+202E RLO cannot flip the sidebar
    expect(sanitizeTitle('invoice\u200Bsync')).toBe('invoicesync') // U+200B zero width space
    expect(sanitizeTitle('a\u200Cb\u2060c')).toBe('abc') // U+200C ZWNJ + U+2060 word joiner
    expect(sanitizeTitle('\u200B\u200C\u2060')).toBeNull() // "visually empty" still fails the empty check
    expect(sanitizeTitle('\u202E\u202D')).toBeNull()
    expect(sanitizeTitle('es \u{1F1EA}\u{1F1F8} deploy')).toBe('es-deploy') // a flag = regional indicators, not Extended_Pictographic
    expect(sanitizeTitle('\u{1F1EA}\u{1F1F8}\u{1F1EA}\u{1F1F8}')).toBeNull()
  })
})

// ---- sweep -------------------------------------------------------------

const HOUR = 3_600_000
let base: string, root: string, dataDir: string
let index: SessionIndex, store: SessionStore
let clock: Date
let calls: TitleInput[]
let response: () => Promise<string>

function seedSession(folder: string, id: string, opts: { ageMs?: number; onlyUser?: boolean; userText?: string } = {}): void {
  mkdirSync(join(root, folder), { recursive: true })
  const user = `{"type":"user","cwd":"/tmp/p","message":{"role":"user","content":${JSON.stringify(opts.userText ?? 'I need to reconcile the invoice payments')}}}\n`
  const assistant = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"sure, I will start with the statement"}]}}\n'
  const extra = '{"type":"user","message":{"role":"user","content":"thanks"}}\n'
  writeFileSync(join(root, folder, id + '.jsonl'), opts.onlyUser ? user + extra : user + assistant)
  const mtime = (clock.getTime() - (opts.ageMs ?? HOUR)) / 1000
  utimesSync(join(root, folder, id + '.jsonl'), mtime, mtime)
}

function mkTitler(overrides: Partial<ConstructorParameters<typeof Titler>[0]> = {}): Titler {
  return new Titler({
    index,
    store,
    dataDir,
    generateTitle: async (input) => {
      calls.push(input)
      return response()
    },
    classifyAgentId: () => 'finance',
    now: () => clock,
    ...overrides,
  })
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'deck-titler-'))
  root = join(base, 'projects')
  dataDir = join(base, 'data')
  mkdirSync(root, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  index = claudeSessionIndex(root, join(dataDir, 'cache.json'))
  store = new SessionStore(root, dataDir)
  clock = new Date('2026-08-20T12:00:00.000Z')
  calls = []
  response = async () => 'invoice sync'
})

describe('sweep: basic titling', () => {
  it('titles an eligible session, persists the autoTitle and does not re-title it', async () => {
    seedSession('-tmp-p', 'aaa')
    await index.init()
    const t = mkTitler()
    expect(await t.sweep()).toBe(1)
    expect(store.autoTitle('-tmp-p', 'aaa')).toBe('invoice-sync')
    expect(store.titleResolver()('-tmp-p', 'aaa', 'raw')).toEqual({ title: 'invoice-sync', origin: 'auto' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.excerpt).toContain('User: I need to reconcile the invoice payments')
    expect(calls[0]!.excerpt).toContain('Assistant: sure, I will start')
    // a second sweep: already titled, not a single extra call
    expect(await t.sweep()).toBe(0)
    expect(calls).toHaveLength(1)
  })
  it("passes the same agent's sibling titles (manual and auto) to the generator", async () => {
    seedSession('-tmp-p', 'aaa')
    seedSession('-tmp-p', 'bbb')
    seedSession('-tmp-p', 'ccc')
    await index.init()
    store.rename('-tmp-p', 'bbb', 'deploy vps')
    store.setAutoTitle('-tmp-p', 'ccc', 'tax filing')
    const t = mkTitler()
    await t.sweep()
    expect(calls).toHaveLength(1) // only aaa was a candidate
    expect(calls[0]!.siblings).toEqual(expect.arrayContaining(['deploy vps', 'tax filing']))
  })
})

describe('sweep: candidate selection', () => {
  it('skips manual, auto, live, no exchange, muted, and ephemeral', async () => {
    seedSession('-tmp-p', 'manual')
    seedSession('-tmp-p', 'auto')
    seedSession('-tmp-p', 'live', { ageMs: 60_000 }) // activity 1 min ago: live
    seedSession('-tmp-p', 'solo-user', { onlyUser: true }) // 2 turns but no assistant reply
    seedSession('-muted', 'muted-s')
    seedSession('-tmp-ephemeral-x', 'ef') // hangs off the ephemeral prefix below
    seedSession('-tmp-p', 'eligible')
    await index.init()
    store.rename('-tmp-p', 'manual', 'By hand')
    store.setAutoTitle('-tmp-p', 'auto', 'already set')
    const t = mkTitler({ muted: ['-muted'], ephemeralPrefix: '-tmp-ephemeral' })
    expect(await t.sweep()).toBe(1)
    expect(store.autoTitle('-tmp-p', 'eligible')).toBe('invoice-sync')
    expect(calls).toHaveLength(1)
    // solo-user does not mark an attempt: without a full exchange it gets re-evaluated later
    const state = JSON.parse(readFileSync(join(dataDir, 'titler.json'), 'utf8')) as { attempts: Record<string, number> }
    expect(state.attempts['-tmp-p/solo-user']).toBeUndefined()
  })
  it('a batch of at most 3 per sweep, most recent activity first', async () => {
    for (let i = 0; i < 5; i++) seedSession('-tmp-p', `s${i}`, { ageMs: HOUR + i * HOUR }) // s0 is the most recent
    await index.init()
    let n = 0
    response = async () => `title ${n++}`
    const t = mkTitler()
    expect(await t.sweep()).toBe(3)
    expect(store.autoTitle('-tmp-p', 's0')).not.toBeNull()
    expect(store.autoTitle('-tmp-p', 's1')).not.toBeNull()
    expect(store.autoTitle('-tmp-p', 's2')).not.toBeNull()
    expect(store.autoTitle('-tmp-p', 's3')).toBeNull() // out of the batch
    expect(await t.sweep()).toBe(2) // the next sweep picks up the rest
  })
})

describe("sweep: the owner's conversations first", () => {
  it("sessions Silos opened (runs, message conversations) come after the owner's, whatever their recency", async () => {
    for (let i = 0; i < 5; i++) seedSession('-tmp-p', `s${i}`, { ageMs: HOUR + i * HOUR }) // s0 is the most recent
    await index.init()
    let n = 0
    response = async () => `title ${n++}`
    // s0..s2 (the most recent) were opened by Silos
    const t = mkTitler({ bornOfSilos: (m) => ['s0', 's1', 's2'].includes(m.id) })
    expect(await t.sweep()).toBe(3)
    expect(store.autoTitle('-tmp-p', 's3')).not.toBeNull()
    expect(store.autoTitle('-tmp-p', 's4')).not.toBeNull()
    expect(store.autoTitle('-tmp-p', 's0')).not.toBeNull() // the newest of Silos' after them
    expect(store.autoTitle('-tmp-p', 's1')).toBeNull()
  })
})

describe('sweep: budget and failures', () => {
  it('a persisted daily cap; resets the next day', async () => {
    for (let i = 0; i < 6; i++) seedSession('-tmp-p', `s${i}`)
    await index.init()
    let n = 0
    response = async () => `title ${n++}`
    const t = mkTitler({ dailyCap: 4 })
    expect(await t.sweep()).toBe(3) // batch of 3
    expect(await t.sweep()).toBe(1) // only 1 left in the budget
    expect(await t.sweep()).toBe(0)
    // restart: the daily counter lives on disk, not in memory
    const t2 = mkTitler({ dailyCap: 4 })
    expect(await t2.sweep()).toBe(0)
    expect(calls).toHaveLength(4)
    // the next day: a fresh budget
    clock = new Date('2026-08-21T12:00:00.000Z')
    expect(await t2.sweep()).toBe(2) // the 2 that were left
  })
  it('an invalid output from the model: max 2 attempts, the mark persists across restarts', async () => {
    seedSession('-tmp-p', 'aaa')
    await index.init()
    response = async () => 'this is not a title it is a very long explanation from the model'
    const t = mkTitler()
    expect(await t.sweep()).toBe(0)
    expect(await t.sweep()).toBe(0)
    expect(calls).toHaveLength(2)
    expect(await t.sweep()).toBe(0) // a 3rd attempt does NOT happen
    expect(calls).toHaveLength(2)
    // restart: the failed mark survives in titler.json
    const t2 = mkTitler()
    expect(await t2.sweep()).toBe(0)
    expect(calls).toHaveLength(2)
    expect(store.autoTitle('-tmp-p', 'aaa')).toBeNull()
  })
  it('an SDK rate limit: aborts the batch, does NOT consume attempts, and the cooldown survives restarts', async () => {
    seedSession('-tmp-p', 'aaa', { ageMs: HOUR })
    seedSession('-tmp-p', 'bbb', { ageMs: 2 * HOUR })
    await index.init()
    response = async () => {
      throw new Error('429: rate limit exceeded, resets at 5pm')
    }
    const t = mkTitler()
    expect(await t.sweep()).toBe(0)
    expect(calls).toHaveLength(1) // the batch aborts: bbb isn't even attempted
    // an environmental error must never burn the session's 2-attempt budget
    const state = JSON.parse(readFileSync(join(dataDir, 'titler.json'), 'utf8')) as { attempts: Record<string, number>; cooldownUntil?: string }
    expect(state.attempts).toEqual({})
    expect(state.cooldownUntil).toBeDefined()
    // cooldown: not a single call within the window — NOT EVEN AFTER A
    // RESTART (tsx watch): the cooldown lives in titler.json, not in memory
    clock = new Date(clock.getTime() + 60_000)
    const t2 = mkTitler() // a new process
    expect(await t2.sweep()).toBe(0)
    expect(calls).toHaveLength(1)
    // past the window (15 min) it tries again — aaa still has its 2 attempts
    clock = new Date(clock.getTime() + 16 * 60_000)
    response = async () => 'invoice sync'
    expect(await t2.sweep()).toBe(2)
  })
  it('the daily cap bounds CALLS — a persistent non-rate-limit error stays bounded and never burns attempts', async () => {
    for (let i = 0; i < 6; i++) seedSession('-tmp-p', `s${i}`)
    await index.init()
    response = async () => {
      throw new Error('spawn claude ENOENT')
    } // looksLikeRateLimit doesn't recognize it
    const t = mkTitler({ dailyCap: 4 })
    expect(await t.sweep()).toBe(0) // 3 calls (batch)
    expect(await t.sweep()).toBe(0) // 1 call (rest of the budget)
    expect(await t.sweep()).toBe(0) // 0 calls: budget exhausted
    expect(await t.sweep()).toBe(0)
    expect(calls).toHaveLength(4) // bounded by the daily cap, not 3 per tick forever
    const state = JSON.parse(readFileSync(join(dataDir, 'titler.json'), 'utf8')) as { countToday: number; attempts: Record<string, number> }
    expect(state.countToday).toBe(4)
    expect(state.attempts).toEqual({}) // the model never saw the content — not a single attempt consumed
  })
  it('with no candidates, touches neither disk nor the generator', async () => {
    await index.init()
    const t = mkTitler()
    expect(await t.sweep()).toBe(0)
    expect(calls).toHaveLength(0)
    expect(existsSync(join(dataDir, 'titler.json'))).toBe(false)
  })
})

describe('the batch fills up with viable candidates', () => {
  it('3 recent non-viable sessions do not starve out the older backlog', async () => {
    // the 3 most recent pass the filter (turnCount >= 2) but have no
    // assistant reply -> a null excerpt. Before this fix they hogged the
    // batch slice and the older, viable ones NEVER got titled.
    seedSession('-tmp-p', 'inv0', { onlyUser: true, ageMs: HOUR })
    seedSession('-tmp-p', 'inv1', { onlyUser: true, ageMs: 2 * HOUR })
    seedSession('-tmp-p', 'inv2', { onlyUser: true, ageMs: 3 * HOUR })
    seedSession('-tmp-p', 'v0', { ageMs: 10 * HOUR })
    seedSession('-tmp-p', 'v1', { ageMs: 11 * HOUR })
    await index.init()
    let n = 0
    response = async () => `title ${n++}`
    const t = mkTitler()
    expect(await t.sweep()).toBe(2)
    expect(store.autoTitle('-tmp-p', 'v0')).not.toBeNull()
    expect(store.autoTitle('-tmp-p', 'v1')).not.toBeNull()
    expect(calls).toHaveLength(2) // the non-viable ones spend no calls
  })
  it('a re-evaluable backoff: a non-viable session is not re-read on every sweep; a new mtime re-evaluates it right away', async () => {
    seedSession('-tmp-p', 'inv', { onlyUser: true })
    await index.init()
    const spy = vi.spyOn(index, 'readTurns')
    const t = mkTitler()
    await t.sweep() // reads it once, marks the backoff
    expect(spy).toHaveBeenCalledTimes(1)
    await t.sweep() // backoff still active + same mtime: no re-read
    await t.sweep()
    expect(spy).toHaveBeenCalledTimes(1)
    // the assistant's reply arrives -> a new mtime -> immediate re-evaluation
    appendFileSync(join(root, '-tmp-p', 'inv.jsonl'), '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I am ready"}]}}\n')
    const mtime = (clock.getTime() - 30 * 60_000) / 1000 // 30 min ago: not live
    utimesSync(join(root, '-tmp-p', 'inv.jsonl'), mtime, mtime)
    await index.refresh('-tmp-p', 'inv')
    expect(await t.sweep()).toBe(1)
    expect(store.autoTitle('-tmp-p', 'inv')).toBe('invoice-sync')
  })
})

// a peer message (an inter-session turn from the parser) carries role:'user'
// but is NOT the owner's ask — the titler's excerpt must never label it
// "User: …" nor count it as a viable exchange. A real shape from the corpus
// (an entry delivered with isMeta:true + origin peer).
describe('the titler excerpt ignores inter-session messages', () => {
  const PEER_BODY = 'Change of plan — do NOT wait for my SUCCESS: there is a holdup in the deployment.'
  const peerLine = (): string =>
    JSON.stringify({
      type: 'user',
      isMeta: true,
      promptSource: 'system',
      origin: { kind: 'peer', from: 'uds:/tmp/cc-socks/41897.sock', name: 'acme-e8', fromMode: 'bypass', body: PEER_BODY },
      message: {
        role: 'user',
        content: `Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/41897.sock" from-name="acme-e8" from-mode="bypass">\n${PEER_BODY}\n</cross-session-message>`,
      },
    }) + '\n'

  function seedWithPeer(id: string, opts: { withRealUser: boolean }): void {
    mkdirSync(join(root, '-tmp-p'), { recursive: true })
    const realUser = '{"type":"user","cwd":"/tmp/p","message":{"role":"user","content":"I need to reconcile the invoice payments"}}\n'
    const assistant = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"sure, I will start with the statement"}]}}\n'
    // the peer arrives FIRST (a session that starts by reacting to another session)
    writeFileSync(join(root, '-tmp-p', id + '.jsonl'), peerLine() + (opts.withRealUser ? realUser : '') + assistant)
    const mtime = (clock.getTime() - HOUR) / 1000
    utimesSync(join(root, '-tmp-p', id + '.jsonl'), mtime, mtime)
  }

  it('with a peer among the first user turns, the excerpt is built from the REAL ask', async () => {
    seedWithPeer('aaa', { withRealUser: true })
    await index.init()
    const t = mkTitler()
    expect(await t.sweep()).toBe(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.excerpt).toContain('User: I need to reconcile the invoice payments')
    expect(calls[0]!.excerpt).not.toContain(PEER_BODY) // the peer message is never labeled "User:"
  })

  it('a session with ONLY a peer + assistant (no real ask) is non-viable: no excerpt, no call', async () => {
    seedWithPeer('bbb', { withRealUser: false })
    await index.init()
    const t = mkTitler()
    expect(await t.sweep()).toBe(0)
    expect(calls).toHaveLength(0)
  })
})

describe('self-feeding', () => {
  it("never titles the generator's own sessions, even with the ephemeral rule turned off", async () => {
    // SILOS_NO_EPHEMERAL=1 => ephemeralPrefix null => the helper session ENTERS the index
    seedSession('-tmp-silos-titler-abc123', 'helper')
    seedSession('-tmp-p', 'real')
    await index.init()
    const t = mkTitler({ ephemeralPrefix: null })
    expect(await t.sweep()).toBe(1) // only the real session
    expect(store.autoTitle('-tmp-p', 'real')).toBe('invoice-sync')
    expect(store.autoTitle('-tmp-silos-titler-abc123', 'helper')).toBeNull()
    expect(calls).toHaveLength(1)
  })
})

describe('leftovers', () => {
  it('generateTitleWithSdk deletes its tmpdir when done (even on error)', async () => {
    const cwds: string[] = []
    const okQuery = (args: { options: Record<string, unknown> }) => {
      cwds.push(args.options.cwd as string)
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<SdkMessage> {
          yield { type: 'result', subtype: 'success', result: 'invoice sync' }
        },
        async interrupt() {
          return undefined
        },
      }
    }
    const gen = generateTitleWithSdk(okQuery as never)
    expect(await gen({ excerpt: 'User: hi\nAssistant: hello', siblings: [] })).toBe('invoice sync')
    expect(cwds[0]).toContain('silos-titler-')
    expect(existsSync(cwds[0]!)).toBe(false) // cleaned up in the finally
    // the error path: the tmpdir is cleaned up too
    const errQuery = (args: { options: Record<string, unknown> }) => {
      cwds.push(args.options.cwd as string)
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<SdkMessage> {
          throw new Error('boom')
        },
        async interrupt() {
          return undefined
        },
      }
    }
    const gen2 = generateTitleWithSdk(errQuery as never)
    await expect(gen2({ excerpt: 'User: x\nAssistant: y', siblings: [] })).rejects.toThrow('boom')
    expect(existsSync(cwds[1]!)).toBe(false)
  })
  it('prunes attempt marks for sessions no longer in the index', async () => {
    seedSession('-tmp-p', 'aaa')
    await index.init()
    response = async () => 'an invalid output with far too many words to ever be a title'
    const t = mkTitler()
    await t.sweep()
    let state = JSON.parse(readFileSync(join(dataDir, 'titler.json'), 'utf8')) as { attempts: Record<string, number> }
    expect(state.attempts['-tmp-p/aaa']).toBe(1)
    index.remove('-tmp-p', 'aaa') // trashed
    await t.sweep()
    state = JSON.parse(readFileSync(join(dataDir, 'titler.json'), 'utf8')) as { attempts: Record<string, number> }
    expect(state.attempts['-tmp-p/aaa']).toBeUndefined()
  })
})
