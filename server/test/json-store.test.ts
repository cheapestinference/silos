import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteJson, backupCorruptJson } from '../src/json-store.js'

afterEach(() => vi.restoreAllMocks())

describe('atomicWriteJson', () => {
  it('writes pretty JSON + trailing newline and leaves no .tmp behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'js-'))
    const file = join(dir, 'x.json')
    atomicWriteJson(file, { a: 1 })
    expect(readFileSync(file, 'utf8')).toBe('{\n  "a": 1\n}\n')
    expect(existsSync(file + '.tmp')).toBe(false)
  })

  it('applies the mode on creation (0600 for secret files)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'js-'))
    const file = join(dir, 'secret.json')
    atomicWriteJson(file, { token: 't' }, { mode: 0o600 })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})

describe('backupCorruptJson', () => {
  it('saves the raw text to a collision-proof .corrupt- sidecar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'js-'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const file = join(dir, 'store.json')
    backupCorruptJson(file, 'not json', 'my-store')
    backupCorruptJson(file, 'still not json', 'my-store') // same second → must not overwrite
    const backups = readdirSync(dir).filter((n) => n.startsWith('store.json.corrupt-'))
    expect(backups.length).toBe(2) // both preserved, distinct names
    expect(warn).toHaveBeenCalled()
  })

  it('protects a secret backup with 0600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'js-'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const file = join(dir, 's.json')
    backupCorruptJson(file, 'oauth-token-here', 's', { mode: 0o600 })
    const backup = readdirSync(dir).find((n) => n.startsWith('s.json.corrupt-'))!
    expect(statSync(join(dir, backup)).mode & 0o777).toBe(0o600)
  })
})
