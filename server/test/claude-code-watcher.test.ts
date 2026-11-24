import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { startWatcher } from '../src/harnesses/claude-code/watcher.js'
import { ephemeralPrefix } from '../src/ephemeral.js'

const LINE = '{"type":"user","cwd":"/tmp/p","message":{"role":"user","content":"hi"}}\n'
let closer: { close(): Promise<void> } | null = null
afterEach(async () => {
  await closer?.close()
  closer = null
})

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for the watcher')
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('startWatcher', () => {
  it('detects add, change and unlink for top-level sessions', async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    const root = join(base, 'projects')
    mkdirSync(join(root, '-tmp-p'), { recursive: true })
    const idx = claudeSessionIndex(root, join(base, 'cache.json'))
    await idx.init()
    closer = startWatcher(root, idx)
    await new Promise((r) => setTimeout(r, 300)) // watcher ready

    writeFileSync(join(root, '-tmp-p', 'x.jsonl'), LINE)
    await until(() => idx.getMeta('-tmp-p', 'x')?.turnCount === 1)

    appendFileSync(join(root, '-tmp-p', 'x.jsonl'), LINE.replace('hi', 'another'))
    await until(() => idx.getMeta('-tmp-p', 'x')?.turnCount === 2)

    // session subdirs don't count
    mkdirSync(join(root, '-tmp-p', 'x', 'subagents'), { recursive: true })
    writeFileSync(join(root, '-tmp-p', 'x', 'subagents', 'agent-1.jsonl'), LINE)
    await new Promise((r) => setTimeout(r, 400))
    expect(idx.allSessions()).toHaveLength(1)

    rmSync(join(root, '-tmp-p', 'x.jsonl'))
    await until(() => idx.getMeta('-tmp-p', 'x') === null)
  })

  it('an unlink right after a change clears the pending timer and does not resurrect it', async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    const root = join(base, 'projects')
    mkdirSync(join(root, '-tmp-p'), { recursive: true })
    const idx = claudeSessionIndex(root, join(base, 'cache.json'))
    await idx.init()
    closer = startWatcher(root, idx)
    await new Promise((r) => setTimeout(r, 300)) // watcher ready

    writeFileSync(join(root, '-tmp-p', 'y.jsonl'), LINE)
    await until(() => idx.getMeta('-tmp-p', 'y')?.turnCount === 1)

    appendFileSync(join(root, '-tmp-p', 'y.jsonl'), LINE.replace('hi', 'another'))
    rmSync(join(root, '-tmp-p', 'y.jsonl')) // immediate unlink, the debounce timer is still pending
    await until(() => idx.getMeta('-tmp-p', 'y') === null)

    // wait for the debounce time to pass + margin
    await new Promise((r) => setTimeout(r, 300))
    // verify it's still null (the timer didn't resurrect it)
    expect(idx.getMeta('-tmp-p', 'y')).toBeNull()
  })

  it('completely ignores events from a muted folder (never reaches index.refresh)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    const root = join(base, 'projects')
    mkdirSync(join(root, '-tmp-p'), { recursive: true })
    mkdirSync(join(root, '-muted-observer'), { recursive: true })
    const idx = claudeSessionIndex(root, join(base, 'cache.json'), ['-muted-observer'])
    await idx.init()
    closer = startWatcher(root, idx, ['-muted-observer'])
    await new Promise((r) => setTimeout(r, 300)) // watcher ready

    // a normal session does get indexed, as a control
    writeFileSync(join(root, '-tmp-p', 'x.jsonl'), LINE)
    await until(() => idx.getMeta('-tmp-p', 'x')?.turnCount === 1)

    // the session inside the muted folder never shows up, no matter how long we wait
    writeFileSync(join(root, '-muted-observer', 'zzz.jsonl'), LINE)
    await new Promise((r) => setTimeout(r, 400))
    expect(idx.getMeta('-muted-observer', 'zzz')).toBeNull()
    expect(idx.allSessions()).toHaveLength(1) // only x, zzz never got in
  })

  it('ignores events from an ephemeral folder (under the OS tmp) while also respecting muted ones — never reaches index.refresh', async () => {
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    const root = join(base, 'projects')
    const prefix = ephemeralPrefix() // in this environment, '-tmp'
    const realFolder = '-home-user-project-real'
    const ephFolder = `${prefix}-claude-1234--home-user-x-scratchpad-r1`
    mkdirSync(join(root, realFolder), { recursive: true })
    mkdirSync(join(root, ephFolder), { recursive: true })
    mkdirSync(join(root, '-muted-observer'), { recursive: true })
    const idx = claudeSessionIndex(root, join(base, 'cache.json'), ['-muted-observer'], prefix)
    await idx.init()
    closer = startWatcher(root, idx, ['-muted-observer'], prefix)
    await new Promise((r) => setTimeout(r, 300)) // watcher ready

    // control: a session outside tmp and not muted does get indexed
    writeFileSync(join(root, realFolder, 'x.jsonl'), LINE)
    await until(() => idx.getMeta(realFolder, 'x')?.turnCount === 1)

    // the ephemeral and muted ones never show up, no matter how long we wait
    writeFileSync(join(root, ephFolder, 'zzz.jsonl'), LINE)
    writeFileSync(join(root, '-muted-observer', 'yyy.jsonl'), LINE)
    await new Promise((r) => setTimeout(r, 400))
    expect(idx.getMeta(ephFolder, 'zzz')).toBeNull()
    expect(idx.getMeta('-muted-observer', 'yyy')).toBeNull()
    expect(idx.allSessions()).toHaveLength(1) // only x
  })
})
