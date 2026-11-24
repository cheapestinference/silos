import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, cpSync, truncateSync, utimesSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionIndex } from '../src/session-index.js'
import { ClaudeReader, claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { ephemeralPrefix } from '../src/ephemeral.js'
import type { HarnessReader } from '../src/harnesses/contract.js'

const FIX = new URL('./fixtures/basic.jsonl', import.meta.url).pathname
let root: string, cache: string, idx: SessionIndex, reader: ClaudeReader

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'deck-'))
  root = join(base, 'projects')
  cache = join(base, 'sessions-cache.json')
  mkdirSync(join(root, '-tmp-project-x'), { recursive: true })
  cpSync(FIX, join(root, '-tmp-project-x', 'aaa.jsonl'))
  // the index's heartbeat body lives on its Claude reader: tests drive it there
  reader = new ClaudeReader(root, cache)
  idx = new SessionIndex(reader)
})

describe('init + allSessions', () => {
  it('scans and produces correct meta', async () => {
    await idx.init()
    const [s] = idx.allSessions()
    expect(s).toMatchObject({
      id: 'aaa',
      folder: '-tmp-project-x',
      title: 'JSONL parser fix',
      skills: ['finance-acme'],
      cwd: '/tmp/project-x',
      turnCount: 4,
    })
  })
  it("startedAt = the transcript's birthtime ms (> 0, ≤ the file mtime) — cold scan and warm-cache restart alike", async () => {
    const file = join(root, '-tmp-project-x', 'aaa.jsonl')
    const st = statSync(file)
    await idx.init()
    const [s] = idx.allSessions()
    expect(s.startedAt).toBe(st.birthtimeMs)
    expect(s.startedAt).toBeGreaterThan(0)
    expect(s.startedAt).toBeLessThanOrEqual(st.mtimeMs)
    // warm cache: the entry is restored, not re-parsed — startedAt still present
    const again = claudeSessionIndex(root, cache)
    await again.init()
    expect(again.getMeta('-tmp-project-x', 'aaa')!.startedAt).toBe(st.birthtimeMs)
  })
  it('ignores session subdirs and non-jsonl files', async () => {
    mkdirSync(join(root, '-tmp-project-x', 'aaa', 'subagents'), { recursive: true })
    writeFileSync(join(root, '-tmp-project-x', 'aaa', 'subagents', 'agent-1.jsonl'), '{}\n')
    writeFileSync(join(root, '-tmp-project-x', 'note.txt'), 'x')
    await idx.init()
    expect(idx.allSessions()).toHaveLength(1)
  })
})

describe('pendingAsk travels in the session meta', () => {
  const ASK =
    '{"type":"assistant","timestamp":"2026-08-25T12:00:00.500Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu_ask","name":"AskUserQuestion","input":{"questions":[{"question":"q","options":[{"label":"A"}]}]}}]}}\n'
  const ANSWER =
    '{"type":"user","timestamp":"2026-08-25T12:00:01.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_ask","content":"A"}]}}\n'
  const ASK_U = '{"type":"user","timestamp":"2026-08-25T12:00:00.000Z","message":{"role":"user","content":"go"}}\n'

  it('an open AskUserQuestion sets pendingAsk; its answer clears it (field omitted)', async () => {
    await idx.init()
    appendFileSync(join(root, '-tmp-project-x', 'aaa.jsonl'), ASK_U + ASK)
    let meta = await idx.refresh('-tmp-project-x', 'aaa')
    expect(meta!.pendingAsk).toBe(true)
    appendFileSync(join(root, '-tmp-project-x', 'aaa.jsonl'), ANSWER)
    meta = await idx.refresh('-tmp-project-x', 'aaa')
    expect(meta!.pendingAsk).toBeUndefined()
  })
})

describe('subagent activity keeps an open turn warm', () => {
  const U = '{"type":"user","timestamp":"2026-08-25T12:00:00.000Z","message":{"role":"user","content":"go"}}\n'
  const RECEIPT = '{"type":"system","subtype":"turn_duration","durationMs":1,"timestamp":"2026-08-25T12:00:01.000Z"}\n'
  function subagentWrite(at: number): void {
    const dir = join(root, '-tmp-project-x', 'aaa', 'subagents')
    mkdirSync(dir, { recursive: true })
    const f = join(dir, 'agent-abc.jsonl')
    writeFileSync(f, '{"type":"assistant"}\n')
    utimesSync(f, at / 1000, at / 1000)
  }

  it('turn OPEN: mtime = the newest subagent transcript when it is fresher than the main one (the subagent works, the main file stays quiet)', async () => {
    await idx.init()
    appendFileSync(join(root, '-tmp-project-x', 'aaa.jsonl'), U)
    const later = Date.parse('2026-08-25T12:03:00.000Z')
    subagentWrite(later)
    const meta = await idx.refresh('-tmp-project-x', 'aaa')
    expect(meta!.turnOpen).toBe(true)
    expect(meta!.mtime).toBe(later)
  })

  it('turn CLOSED: the subagent files no longer count (a stale subagent dir must not make a finished conversation look alive)', async () => {
    await idx.init()
    appendFileSync(join(root, '-tmp-project-x', 'aaa.jsonl'), U + RECEIPT)
    subagentWrite(Date.parse('2026-08-25T12:03:00.000Z'))
    const meta = await idx.refresh('-tmp-project-x', 'aaa')
    expect(meta!.turnOpen).toBe(false)
    expect(meta!.mtime).toBe(Date.parse('2026-08-25T12:00:01.000Z'))
  })

  it('turn CLOSED: a fresh background agent travels as subMtime in the meta — the mtime stays the main transcript (ordering untouched)', async () => {
    await idx.init()
    appendFileSync(join(root, '-tmp-project-x', 'aaa.jsonl'), U + RECEIPT)
    const at = Date.parse('2026-08-25T12:03:00.000Z')
    subagentWrite(at)
    const meta = await idx.refresh('-tmp-project-x', 'aaa')
    expect(meta!.turnOpen).toBe(false)
    expect(meta!.subMtime).toBe(at)
    expect(meta!.mtime).toBe(Date.parse('2026-08-25T12:00:01.000Z'))
  })

  it('the heartbeat keeps watching a CLOSED turn while its background agent is fresh (the Agent tool spawns detached and ends the turn)', async () => {
    await idx.init()
    appendFileSync(join(root, '-tmp-project-x', 'aaa.jsonl'), U + RECEIPT)
    // whole seconds: utimes granularity would otherwise round the ms away
    const now = Math.floor(Date.now() / 1000) * 1000
    subagentWrite(now - 60_000)
    await idx.refresh('-tmp-project-x', 'aaa')
    const events: { subMtime?: number }[] = []
    idx.on('session', (m) => events.push(m))
    const later = now - 30_000
    subagentWrite(later)
    await reader.pollSubagentActivity()
    expect(events).toHaveLength(1)
    expect(events[0]!.subMtime).toBe(later)
  })

  it('a warm-cache restart still sees the background agent (subMtime is not cached — recomputed at init)', async () => {
    appendFileSync(join(root, '-tmp-project-x', 'aaa.jsonl'), U + RECEIPT)
    const at = Date.parse('2026-08-25T12:03:00.000Z')
    subagentWrite(at)
    await idx.init() // parses and flushes the cache
    const idx2 = claudeSessionIndex(root, cache)
    await idx2.init() // cache hit — the fast path must not skip the subagents dir
    expect(idx2.getMeta('-tmp-project-x', 'aaa')!.subMtime).toBe(at)
  })

  it('the heartbeat re-emits the session when its subagents advance with no main-file event', async () => {
    await idx.init()
    appendFileSync(join(root, '-tmp-project-x', 'aaa.jsonl'), U)
    await idx.refresh('-tmp-project-x', 'aaa')
    const events: { mtime: number }[] = []
    idx.on('session', (m) => events.push(m))
    const later = Date.parse('2026-08-25T12:05:00.000Z')
    subagentWrite(later)
    await reader.pollSubagentActivity() // what the interval runs
    expect(events).toHaveLength(1)
    expect(events[0]!.mtime).toBe(later)
    await reader.pollSubagentActivity() // nothing new → silent
    expect(events).toHaveLength(1)
  })
})

describe('incremental refresh', () => {
  it('append -> parses only the new part and emits session', async () => {
    await idx.init()
    const before = idx.getMeta('-tmp-project-x', 'aaa')!
    const events: unknown[] = []
    idx.on('session', (m) => events.push(m))
    appendFileSync(
      join(root, '-tmp-project-x', 'aaa.jsonl'),
      '{"type":"assistant","timestamp":"2026-08-17T11:00:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"more"}]}}\n',
    )
    const after = await idx.refresh('-tmp-project-x', 'aaa')
    expect(after!.turnCount).toBe(before.turnCount + 1)
    expect(events).toHaveLength(1)
  })
  it('a partial line without \\n stays pending until completed', async () => {
    await idx.init()
    const f = join(root, '-tmp-project-x', 'aaa.jsonl')
    appendFileSync(f, '{"type":"assistant","message":{"role":"assistant","content":[{"type":"te')
    expect((await idx.refresh('-tmp-project-x', 'aaa'))!.turnCount).toBe(4)
    appendFileSync(f, 'xt","text":"fin"}]}}\n')
    expect((await idx.refresh('-tmp-project-x', 'aaa'))!.turnCount).toBe(5)
  })
  it('truncated -> re-parses from scratch', async () => {
    await idx.init()
    truncateSync(join(root, '-tmp-project-x', 'aaa.jsonl'), 0)
    appendFileSync(join(root, '-tmp-project-x', 'aaa.jsonl'), '{"type":"user","cwd":"/tmp/p","message":{"role":"user","content":"new"}}\n')
    const m = await idx.refresh('-tmp-project-x', 'aaa')
    expect(m!.turnCount).toBe(1)
    expect(m!.title).toBe('new')
  })
  it('a new file appears; a deleted one emits removed', async () => {
    await idx.init()
    writeFileSync(join(root, '-tmp-project-x', 'bbb.jsonl'), '{"type":"user","cwd":"/tmp/p","message":{"role":"user","content":"hi"}}\n')
    await idx.refresh('-tmp-project-x', 'bbb')
    expect(idx.allSessions()).toHaveLength(2)
    const removed: string[] = []
    idx.on('removed', (folder, id) => removed.push(`${folder}/${id}`))
    idx.remove('-tmp-project-x', 'bbb')
    expect(idx.allSessions()).toHaveLength(1)
    expect(removed).toEqual(['-tmp-project-x/bbb'])
  })
})

describe('persistent cache', () => {
  it('a second init with a cache does not re-read unchanged files', async () => {
    await idx.init()
    await idx.flushCache()
    const idx2 = claudeSessionIndex(root, cache)
    await idx2.init()
    expect(idx2.getMeta('-tmp-project-x', 'aaa')!.title).toBe('JSONL parser fix')
    // and it can still continue incrementally after being restored
    appendFileSync(
      join(root, '-tmp-project-x', 'aaa.jsonl'),
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"post-cache"}]}}\n',
    )
    expect((await idx2.refresh('-tmp-project-x', 'aaa'))!.turnCount).toBe(5)
  })

  // getContext() survives a flush+reload just like getMeta() does — the same
  // ContextAccumulator.state is persisted in the same cache entry (version
  // bump 2 -> 3).
  it('getContext() survives a flush + reload', async () => {
    await idx.init()
    appendFileSync(join(root, '-tmp-project-x', 'aaa.jsonl'), '{"type":"permission-mode","permissionMode":"bypassPermissions"}\n')
    await idx.refresh('-tmp-project-x', 'aaa')
    await idx.flushCache()
    const idx2 = claudeSessionIndex(root, cache)
    await idx2.init()
    expect(idx2.getContext('-tmp-project-x', 'aaa')).toEqual(idx.getContext('-tmp-project-x', 'aaa'))
    expect(idx2.getContext('-tmp-project-x', 'aaa')!.flags.permissionMode).toBe('bypassPermissions')
  })

  // a cache from an earlier version (without `context` per entry) must not
  // be restored as-is — the CACHE_VERSION bump invalidates it entirely and
  // forces a re-parse from scratch, same as the previous bump (v1 -> v2).
  it('an older-version cache (without context) is ignored and re-parsed', async () => {
    await idx.init()
    writeFileSync(
      cache,
      JSON.stringify({
        version: 2,
        files: {
          '-tmp-project-x/aaa': {
            lineOffset: 0,
            mtime: 0,
            size: 0,
            state: { title: null, titleSource: null, skills: [], cwd: null, turnCount: 0, contextTokens: null, model: null, queue: [] },
          },
        },
      }),
    )
    const idx2 = claudeSessionIndex(root, cache)
    await idx2.init()
    expect(idx2.getMeta('-tmp-project-x', 'aaa')!.title).toBe('JSONL parser fix') // re-parsed, not the stale cache
    expect(idx2.getContext('-tmp-project-x', 'aaa')).not.toBeNull()
  })

  // bump 4 -> 5 — the parser now emits turns for messages that arrive
  // BETWEEN sessions (previously swallowed by isMeta/isNoise); a v4 cache
  // has turnCounts that no longer line up with an incremental tail and must
  // be discarded entirely (re-parse from scratch), same as earlier bumps.
  it('a v4 cache (pre inter-session messages) is ignored and re-parsed', async () => {
    await idx.init()
    writeFileSync(
      cache,
      JSON.stringify({
        version: 4,
        files: {
          '-tmp-project-x/aaa': {
            lineOffset: 0,
            mtime: 0,
            size: 0,
            state: { title: 'stale', titleSource: 'user', skills: [], cwd: null, turnCount: 0, contextTokens: null, model: null, queue: [] },
            context: {},
          },
        },
      }),
    )
    const idx2 = claudeSessionIndex(root, cache)
    await idx2.init()
    expect(idx2.getMeta('-tmp-project-x', 'aaa')!.title).toBe('JSONL parser fix') // re-parsed, not 'stale'
  })
})

describe('meta v1.1 — contextTokens/model/queue', () => {
  it('a session with usage+queue carries the fields in its meta', async () => {
    await idx.init()
    appendFileSync(
      join(root, '-tmp-project-x', 'aaa.jsonl'),
      '{"type":"queue-operation","operation":"enqueue","content":"next"}\n' +
        '{"type":"assistant","message":{"role":"assistant","model":"claude-haiku-4-5-20251001",' +
        '"content":[{"type":"text","text":"more"}],' +
        '"usage":{"input_tokens":2,"cache_creation_input_tokens":1043,"cache_read_input_tokens":107611}}}\n',
    )
    const m = await idx.refresh('-tmp-project-x', 'aaa')
    expect(m!.contextTokens).toBe(108656)
    expect(m!.model).toBe('claude-haiku-4-5-20251001')
    expect(m!.queue).toEqual(['next'])
  })

  it('a session without usage or a queue carries no fields (undefined, not null)', async () => {
    const m = await idx.refresh('-tmp-project-x', 'aaa')
    expect(m!.contextTokens).toBeUndefined()
    expect(m!.model).toBeUndefined()
    expect(m!.queue).toBeUndefined()
    expect('contextTokens' in m!).toBe(false)
    expect('model' in m!).toBe(false)
    expect('queue' in m!).toBe(false)
  })
})

describe('muted folders', () => {
  it('init: does not even readdir inside a muted folder — its sessions never appear', async () => {
    mkdirSync(join(root, '-muted-observer'), { recursive: true })
    writeFileSync(join(root, '-muted-observer', 'zzz.jsonl'), '{"type":"user","cwd":"/tmp/p","message":{"role":"user","content":"plugin noise"}}\n')
    const muted = claudeSessionIndex(root, cache, ['-muted-observer'])
    await muted.init()
    expect(muted.allSessions()).toHaveLength(1) // only the non-muted folder
    expect(muted.getMeta('-muted-observer', 'zzz')).toBeNull()
    // the non-muted folder stays intact
    expect(muted.getMeta('-tmp-project-x', 'aaa')).not.toBeNull()
  })

  it('refresh() on a muted folder is a no-op: never resurrects it in the index', async () => {
    mkdirSync(join(root, '-muted-observer'), { recursive: true })
    writeFileSync(join(root, '-muted-observer', 'zzz.jsonl'), '{"type":"user","cwd":"/tmp/p","message":{"role":"user","content":"noise"}}\n')
    const muted = claudeSessionIndex(root, cache, ['-muted-observer'])
    await muted.init()
    const m = await muted.refresh('-muted-observer', 'zzz')
    expect(m).toBeNull()
    expect(muted.getMeta('-muted-observer', 'zzz')).toBeNull()
    expect(muted.allSessions()).toHaveLength(1)
  })
})

describe('ephemeral noise (sessions under the OS tmp dir)', () => {
  // note: the base folder seeded in this file's global beforeEach
  // ('-tmp-project-x') simulates a cwd of "/tmp/project-x" — which in this
  // environment DOES fall under the real tmpdir (prefix '-tmp'). So these
  // tests don't use it as a "normal sibling": they use their own folder
  // outside of /tmp to verify that non-ephemeral folders survive intact.
  const REAL_FOLDER = '-home-user-project-real'
  const REAL_LINE = '{"type":"user","cwd":"/home/user/project-real","message":{"role":"user","content":"real work"}}\n'

  it("init: a folder with the tmpdir's munged prefix is skipped; a normal sibling (outside tmp) is unaffected", async () => {
    const prefix = ephemeralPrefix() // in this environment, '-tmp'
    const ephFolder = `${prefix}-claude-1234--home-user-x-scratchpad-r1`
    mkdirSync(join(root, ephFolder), { recursive: true })
    writeFileSync(join(root, ephFolder, 'zzz.jsonl'), '{"type":"user","cwd":"/tmp/claude-1234/x/scratchpad-r1","message":{"role":"user","content":"smoke"}}\n')
    mkdirSync(join(root, REAL_FOLDER), { recursive: true })
    writeFileSync(join(root, REAL_FOLDER, 'main.jsonl'), REAL_LINE)

    const withEphemeral = claudeSessionIndex(root, cache, [], prefix)
    await withEphemeral.init()
    expect(withEphemeral.getMeta(ephFolder, 'zzz')).toBeNull()
    expect(withEphemeral.getMeta(REAL_FOLDER, 'main')).not.toBeNull()
  })

  it('refresh() on an ephemeral folder is a no-op: never resurrects it in the index', async () => {
    const prefix = ephemeralPrefix()
    const ephFolder = `${prefix}-claude-1234--home-user-x-scratchpad-r2`
    mkdirSync(join(root, ephFolder), { recursive: true })
    writeFileSync(join(root, ephFolder, 'zzz.jsonl'), '{"type":"user","cwd":"/tmp/claude-1234/x/scratchpad-r2","message":{"role":"user","content":"smoke"}}\n')

    const withEphemeral = claudeSessionIndex(root, cache, [], prefix)
    await withEphemeral.init()
    const m = await withEphemeral.refresh(ephFolder, 'zzz')
    expect(m).toBeNull()
    expect(withEphemeral.getMeta(ephFolder, 'zzz')).toBeNull()
  })

  it('without an ephemeralPrefix (default null) the behavior is identical to before — opt-in, breaks nothing existing', async () => {
    await idx.init() // the beforeEach's idx, without ephemeralPrefix
    expect(idx.allSessions()).toHaveLength(1)
    expect(idx.getMeta('-tmp-project-x', 'aaa')).not.toBeNull()
  })

  it('merged skip-set: muted.json and ephemeral noise are hidden together', async () => {
    const prefix = ephemeralPrefix()
    const ephFolder = `${prefix}-claude-1234--home-user-x-scratchpad-r3`
    mkdirSync(join(root, ephFolder), { recursive: true })
    writeFileSync(join(root, ephFolder, 'zzz.jsonl'), '{"type":"user","cwd":"/tmp/claude-1234/x/scratchpad-r3","message":{"role":"user","content":"smoke"}}\n')
    mkdirSync(join(root, '-muted-observer'), { recursive: true })
    writeFileSync(join(root, '-muted-observer', 'yyy.jsonl'), '{"type":"user","cwd":"/tmp/p","message":{"role":"user","content":"plugin noise"}}\n')
    mkdirSync(join(root, REAL_FOLDER), { recursive: true })
    writeFileSync(join(root, REAL_FOLDER, 'main.jsonl'), REAL_LINE)

    const merged = claudeSessionIndex(root, cache, ['-muted-observer'], prefix)
    await merged.init()
    expect(merged.getMeta(ephFolder, 'zzz')).toBeNull()
    expect(merged.getMeta('-muted-observer', 'yyy')).toBeNull()
    expect(merged.getMeta(REAL_FOLDER, 'main')).not.toBeNull()
  })
})

describe('readTurns', () => {
  it('returns full turns with indices and parses the last line without \\n', async () => {
    await idx.init()
    appendFileSync(
      join(root, '-tmp-project-x', 'aaa.jsonl'),
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"no newline"}]}}',
    )
    const turns = await idx.readTurns('-tmp-project-x', 'aaa')
    expect(turns).toHaveLength(5)
    expect(turns.map((t) => t.index)).toEqual([0, 1, 2, 3, 4])
    expect(turns[4]!.text).toBe('no newline')
  })
})

describe('disk attribution of plan files (context.files disk, plan-touch-by-disk t1)', () => {
  it('a plan a Bash command NAMES lands in context.files; a sibling never named does not', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cwd-'))
    const folder = cwd.replace(/\//g, '-')
    mkdirSync(join(root, folder), { recursive: true })
    mkdirSync(join(cwd, 'plans'))
    writeFileSync(join(cwd, 'plans', 'x.plan.json'), '{"title":"x","tasks":[]}') // the mention must be REAL
    const file = join(root, folder, 'bbb.jsonl')
    writeFileSync(
      file,
      `{"type":"user","timestamp":"2026-08-26T10:00:00.000Z","cwd":"${cwd}","message":{"role":"user","content":"plan it"}}\n` +
        `{"type":"assistant","timestamp":"2026-08-26T10:00:01.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu_b","name":"Bash","input":{"command":"cat > plans/x.plan.json <<EOF"}}]}}\n`,
    )
    await idx.refresh(folder, 'bbb')
    expect(idx.getContext(folder, 'bbb')!.files).toEqual([{ path: join(cwd, 'plans', 'x.plan.json'), edits: 0, writes: 0, reads: 0, sent: 0, disk: 1 }])
  })
})

// A dying `claude` writes a fresh stub JSONL holding only bookkeeping
// (last-prompt/ai-title/mode/bridge-session — none with a timestamp, no
// turns). It is NOT a conversation: nothing to open, and its only "time"
// is the file's mtime, so a mass process-kill made a batch of them all
// read "1m ago" at once. The rule: no timestamped content + no
// turns + nothing queued → listed nowhere, but still reachable by id
// (trash, lineage and console lookups must keep seeing it).
describe('bookkeeping-only stubs are not conversations', () => {
  const STUB =
    '{"type":"last-prompt","lastPrompt":"ok publish","leafUuid":"x","sessionId":"ghost"}\n' +
    '{"type":"ai-title","aiTitle":"github ci broken","sessionId":"ghost"}\n' +
    '{"type":"mode","mode":"normal","sessionId":"ghost"}\n' +
    '{"type":"bridge-session","sessionId":"ghost","bridgeSessionId":"cse_1"}\n'
  const USER = '{"type":"user","timestamp":"2026-10-20T10:00:00.000Z","message":{"role":"user","content":"hello"}}\n'

  it('a stub with no timestamped content is absent from allSessions but getMeta still answers', async () => {
    writeFileSync(join(root, '-tmp-project-x', 'ghost.jsonl'), STUB)
    await idx.init()
    expect(idx.allSessions().map((s) => s.id)).toEqual(['aaa'])
    expect(idx.getMeta('-tmp-project-x', 'ghost')).toMatchObject({ id: 'ghost', title: 'github ci broken' })
  })

  it('refresh() of a stub emits nothing; real content later surfaces it normally', async () => {
    await idx.init()
    const emitted: string[] = []
    idx.on('session', (m: { id: string }) => emitted.push(m.id))
    const f = join(root, '-tmp-project-x', 'ghost.jsonl')
    writeFileSync(f, STUB)
    await idx.refresh('-tmp-project-x', 'ghost')
    expect(emitted).toEqual([])
    appendFileSync(f, USER)
    await idx.refresh('-tmp-project-x', 'ghost')
    expect(emitted).toEqual(['ghost'])
    expect(
      idx
        .allSessions()
        .map((s) => s.id)
        .sort(),
    ).toEqual(['aaa', 'ghost'])
  })

  it('a queued external message keeps a turnless session visible (only true bookkeeping hides)', async () => {
    // queue-operation entries carry no timestamp either, but a queued
    // message is the owner waiting on this conversation — never hide it.
    writeFileSync(join(root, '-tmp-project-x', 'queued.jsonl'), '{"type":"queue-operation","operation":"enqueue","content":"do it","sessionId":"queued"}\n')
    await idx.init()
    expect(
      idx
        .allSessions()
        .map((s) => s.id)
        .sort(),
    ).toEqual(['aaa', 'queued'])
  })
})

// Edge cases pinned before the Claude reader leaves SessionIndex (claude
// adapter relocation, Task 12): emission and readiness must not move.
describe('reader-split edge cases (emission + readiness)', () => {
  it('remove() of a Claude id the index never indexed emits no removed', async () => {
    await idx.init()
    const removed: string[] = []
    idx.on('removed', (folder, id) => removed.push(`${folder}/${id}`))
    idx.remove('-tmp-project-x', 'never-seen')
    expect(removed).toEqual([])
  })

  it('the heartbeat re-emits a bookkeeping-only session whose subagent file moved', async () => {
    const STUB = '{"type":"ai-title","aiTitle":"stub","sessionId":"ghost"}\n'
    writeFileSync(join(root, '-tmp-project-x', 'ghost.jsonl'), STUB)
    const dir = join(root, '-tmp-project-x', 'ghost', 'subagents')
    mkdirSync(dir, { recursive: true })
    const f = join(dir, 'agent-abc.jsonl')
    writeFileSync(f, '{"type":"assistant"}\n')
    const now = Math.floor(Date.now() / 1000) * 1000
    utimesSync(f, (now - 60_000) / 1000, (now - 60_000) / 1000)
    await idx.init()
    idx.stopHeartbeat()
    expect(idx.allSessions().map((s) => s.id)).toEqual(['aaa'])
    const emitted: string[] = []
    idx.on('session', (m: { id: string }) => emitted.push(m.id))
    utimesSync(f, (now - 30_000) / 1000, (now - 30_000) / 1000)
    await reader.pollSubagentActivity()
    expect(emitted).toEqual(['ghost'])
  })

  it('init() rejects when the cache cannot be written after the scan — and isReady() is already true', async () => {
    const bad = claudeSessionIndex(root, join(root, 'no-such-dir', 'cache.json'))
    await expect(bad.init()).rejects.toThrow()
    bad.stopHeartbeat()
    expect(bad.isReady()).toBe(true)
    expect(bad.getMeta('-tmp-project-x', 'aaa')).not.toBeNull()
  })

  it('init() propagates the cache-write failure (index.ts logs it as the initial scan failure)', async () => {
    const bad = claudeSessionIndex(root, join(root, 'no-such-dir', 'cache.json'))
    let err: unknown = null
    await bad.init().catch((e) => {
      err = e
    })
    bad.stopHeartbeat()
    expect(err).toBeInstanceOf(Error)
    expect((err as NodeJS.ErrnoException).code).toBe('ENOENT')
  })
})

describe('reader-split fix round 1', () => {
  const USER = '{"type":"user","timestamp":"2026-10-20T10:00:00.000Z","message":{"role":"user","content":"hello"}}\n'

  it('before init(): a file refreshed, deleted and refreshed again still emits removed (the watcher starts before init)', async () => {
    const events: string[] = []
    idx.on('session', (m: { id: string }) => events.push(`session ${m.id}`))
    idx.on('removed', (_f: string, id: string) => events.push(`removed ${id}`))
    const f = join(root, '-tmp-project-x', 'abc.jsonl')
    writeFileSync(f, USER)
    await idx.refresh('-tmp-project-x', 'abc')
    unlinkSync(f)
    await idx.refresh('-tmp-project-x', 'abc')
    expect(events).toEqual(['session abc', 'removed abc'])
  })

  it('init() twice does not double the removed emission', async () => {
    await idx.init()
    idx.stopHeartbeat()
    await idx.init()
    idx.stopHeartbeat()
    const removed: string[] = []
    idx.on('removed', (_f: string, id: string) => removed.push(id))
    unlinkSync(join(root, '-tmp-project-x', 'aaa.jsonl'))
    await idx.refresh('-tmp-project-x', 'aaa')
    expect(removed).toEqual(['aaa'])
  })

  it('a ses_* file under the Claude root, with a reader that owns ses_ ids: listed only by that reader, never twice', async () => {
    writeFileSync(join(root, '-tmp-project-x', 'ses_x.jsonl'), USER)
    const other: HarnessReader = {
      harness: 'opencode',
      ownsId: (id) => id.startsWith('ses_'),
      list: () => [],
      init: async () => {},
      getMeta: () => null,
      getContext: () => null,
      readTurns: async () => [],
      refresh: async () => null,
      remove: () => false,
      watch: () => () => {},
    }
    idx.addReader(other)
    await idx.init()
    idx.stopHeartbeat()
    expect(idx.allSessions().map((s) => s.id)).toEqual(['aaa'])
    expect(idx.getMeta('-tmp-project-x', 'ses_x')).toBeNull()
    expect(await idx.refresh('-tmp-project-x', 'ses_x')).toBeNull()
  })

  it('a ses_* file with no reader owning ses_ ids stays a Claude file (session-owner fixtures rely on it)', async () => {
    writeFileSync(join(root, '-tmp-project-x', 'ses_x.jsonl'), USER)
    await idx.init()
    idx.stopHeartbeat()
    expect(
      idx
        .allSessions()
        .map((s) => s.id)
        .sort(),
    ).toEqual(['aaa', 'ses_x'])
  })
})
