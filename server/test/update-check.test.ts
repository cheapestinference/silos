// update-check.ts — the rules that break invisibly: the version compare
// (a wrong one nags forever or never), the disabled switch (an install that
// said no must never touch the network), the cached checker's honesty
// (latest stays null until the registry answered), and the inbox row
// (absent unless strictly newer).
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { UpdateCheck, detectInstallKind, howToUpdate, isNewer } from '../src/update-check.js'
import { silosUpdateRow } from '../src/inbox.js'

describe('isNewer — strictly newer MAJOR.MINOR.PATCH', () => {
  it('compares numerically, never as text', () => {
    expect(isNewer('0.3.0', '0.3.1')).toBe(true)
    expect(isNewer('0.3.1', '0.3.0')).toBe(false)
    expect(isNewer('0.3.0', '0.3.0')).toBe(false)
    expect(isNewer('0.9.0', '0.10.0')).toBe(true) // 10 > 9, not '1' < '9'
    expect(isNewer('0.3.9', '1.0.0')).toBe(true)
    expect(isNewer('1.0.0', '0.9.9')).toBe(false)
  })
  it('an unreadable version is never newer', () => {
    expect(isNewer('0.3.0', 'latest')).toBe(false)
    expect(isNewer('garbage', '0.3.1')).toBe(false)
    expect(isNewer('0.3.0', '')).toBe(false)
  })
})

describe('detectInstallKind — only what the environment honestly says', () => {
  it('Railway by its own vars, a git checkout by the repo, npm otherwise', () => {
    expect(detectInstallKind({ env: { RAILWAY_ENVIRONMENT: 'production' }, rootDir: '/nonexistent' })).toBe('railway')
    const checkout = mkdtempSync(join(tmpdir(), 'upd-'))
    mkdirSync(join(checkout, '.git'))
    expect(detectInstallKind({ env: {}, rootDir: checkout })).toBe('git')
    expect(detectInstallKind({ env: {}, rootDir: '/nonexistent' })).toBe(existsSync('/.dockerenv') ? 'docker' : 'npm')
  })
  it('every kind has its one update line', () => {
    for (const kind of ['npm', 'docker', 'railway', 'git'] as const) expect(howToUpdate(kind)).not.toBe('')
  })
})

describe('UpdateCheck — the cached checker', () => {
  it('answers installed at once and latest only after the registry answered', async () => {
    let calls = 0
    const check = new UpdateCheck({
      installed: '0.3.0',
      kind: 'npm',
      env: {},
      fetchLatest: async () => {
        calls++
        return '0.4.0'
      },
    })
    const first = check.status()
    expect(first).toMatchObject({ installed: '0.3.0', latest: null, newer: false })
    await new Promise((r) => setTimeout(r, 0))
    expect(check.status()).toMatchObject({ latest: '0.4.0', newer: true })
    expect(calls).toBe(1) // within the TTL nothing refetches
  })
  it('SILOS_NO_UPDATE_CHECK never fetches and never claims a version', async () => {
    let calls = 0
    const check = new UpdateCheck({
      installed: '0.3.0',
      kind: 'npm',
      env: { SILOS_NO_UPDATE_CHECK: '1' },
      fetchLatest: async () => {
        calls++
        return '9.9.9'
      },
    })
    expect(check.status()).toMatchObject({ latest: null, newer: false })
    await new Promise((r) => setTimeout(r, 0))
    expect(check.status().newer).toBe(false)
    expect(calls).toBe(0)
  })
  it('a failed fetch stays silent and keeps the last good answer', async () => {
    let fail = false
    const check = new UpdateCheck({ installed: '0.3.0', kind: 'npm', env: {}, ttlMs: 0, fetchLatest: async () => (fail ? null : '0.3.1') })
    check.status()
    await new Promise((r) => setTimeout(r, 0))
    expect(check.status().latest).toBe('0.3.1')
    fail = true
    check.status()
    await new Promise((r) => setTimeout(r, 0))
    expect(check.status().latest).toBe('0.3.1')
  })
})

describe('silosUpdateRow — one routine row, only when strictly newer', () => {
  const base = { installed: '0.3.0', kind: 'npm', how: 'npm install -g silosplatform@latest' }
  it('absent without a checker, an answer, or a newer version', () => {
    expect(silosUpdateRow(null, 1)).toBeNull()
    expect(silosUpdateRow({ ...base, latest: null, newer: false }, 1)).toBeNull()
    expect(silosUpdateRow({ ...base, latest: '0.3.0', newer: false }, 1)).toBeNull()
  })
  it('present and routine when newer, keyed by the version so a new release is a new row', () => {
    const row = silosUpdateRow({ ...base, latest: '0.4.0', newer: true }, 7)
    expect(row).toMatchObject({ kind: 'silosUpdate', key: 'silos-update:0.4.0', urgency: 'routine', installed: '0.3.0', latest: '0.4.0' })
  })
})
