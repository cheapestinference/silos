import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadMuted } from '../src/muted.js'

afterEach(() => vi.restoreAllMocks())

describe('loadMuted', () => {
  it('no file: nothing muted, and none is created', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'deck-'))
    expect(loadMuted(dataDir)).toEqual([])
    expect(existsSync(join(dataDir, 'muted.json'))).toBe(false)
  })

  it('respects an existing file as-is (the owner can add/remove entries)', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'deck-'))
    writeFileSync(join(dataDir, 'muted.json'), JSON.stringify(['-other-folder', '-and-another']))
    expect(loadMuted(dataDir)).toEqual(['-other-folder', '-and-another'])
  })

  it('corrupt file or a bad shape -> nothing muted, warns and does not overwrite it', () => {
    for (const bad of ['{ this is not valid JSON', JSON.stringify({ oops: true })]) {
      const dataDir = mkdtempSync(join(tmpdir(), 'deck-'))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      writeFileSync(join(dataDir, 'muted.json'), bad)
      expect(loadMuted(dataDir)).toEqual([])
      expect(warn).toHaveBeenCalledOnce()
      expect(readFileSync(join(dataDir, 'muted.json'), 'utf8')).toBe(bad)
      warn.mockRestore()
    }
  })
})
