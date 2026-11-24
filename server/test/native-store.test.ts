import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { NativeStore } from '../src/native-store.js'

let store: NativeStore
let file: string
beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), 'deck-')), 'native.json')
  store = new NativeStore(file)
})

describe('NativeStore', () => {
  it('registers, reads and persists', () => {
    expect(store.get('-tmp-p', 'abc')).toBeNull()
    expect(store.isNative('-tmp-p', 'abc')).toBe(false)
    store.register('-tmp-p', 'abc', { agentId: 'finance', createdAt: '2026-08-17T20:00:00Z' })
    expect(store.get('-tmp-p', 'abc')?.agentId).toBe('finance')
    expect(new NativeStore(file).isNative('-tmp-p', 'abc')).toBe(true) // persisted
  })
  it('corrupt file -> starts fresh without crashing', () => {
    writeFileSync(file, '{rot')
    expect(new NativeStore(file).get('-tmp-p', 'x')).toBeNull()
  })
  it('caches in memory: get() does not re-read the file after register()', () => {
    store.register('-tmp-p', 'abc', { agentId: 'finance', createdAt: '2026-08-17T20:00:00Z' })
    writeFileSync(file, '{corrupted by hand outside the process') // simulates external write/corruption
    expect(store.get('-tmp-p', 'abc')?.agentId).toBe('finance') // still served from cache
  })
})

// Session ownership must never be silently lost: a corrupt native.json is
// backed up before the store starts fresh (the next write replaces the file).
describe('corrupt native.json', () => {
  it('backs up to .corrupt-* before starting fresh', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(file, '{this is not json')
    expect(store.isNative('-tmp-p', 'abc')).toBe(false)
    const dir = dirname(file)
    const backups = readdirSync(dir).filter((f) => f.startsWith('native.json.corrupt-'))
    expect(backups.length).toBe(1)
    expect(readFileSync(join(dir, backups[0]!), 'utf8')).toBe('{this is not json')
  })
})
