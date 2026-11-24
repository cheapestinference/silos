import { describe, it, expect } from 'vitest'
import { mkdtempSync, statSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, ensureData } from '../src/config.js'

describe('defaultConfig', () => {
  it('respects SILOS_ROOT and SILOS_DATA_DIR from the environment', () => {
    process.env.SILOS_ROOT = '/tmp/other-root'
    process.env.SILOS_DATA_DIR = '/tmp/other-data'
    try {
      const cfg = defaultConfig()
      expect(cfg.root).toBe('/tmp/other-root')
      expect(cfg.dataDir).toBe('/tmp/other-data')
    } finally {
      delete process.env.SILOS_ROOT
      delete process.env.SILOS_DATA_DIR
    }
  })

  it('with no overrides, dataDir falls back to the ~/.silos default', () => {
    expect(defaultConfig().dataDir.endsWith(join('.silos'))).toBe(true)
  })

  it('respects SILOS_PORT from the environment (the E2E harness uses it to avoid clashing with a dev server on 3210)', () => {
    process.env.SILOS_PORT = '4321'
    try {
      expect(defaultConfig().port).toBe(4321)
    } finally {
      delete process.env.SILOS_PORT
    }
  })

  // The E2E harness must serve a directory DIFFERENT from the one real
  // usage serves — SILOS_WEB_DIST is the override that allows that, same
  // pattern as SILOS_ROOT/SILOS_DATA_DIR above.
  it('respects SILOS_WEB_DIST from the environment (the E2E harness uses it to avoid clobbering the real web/dist)', () => {
    process.env.SILOS_WEB_DIST = '/tmp/other-dist-e2e'
    try {
      expect(defaultConfig().webDist).toBe('/tmp/other-dist-e2e')
    } finally {
      delete process.env.SILOS_WEB_DIST
    }
  })

  it('with no SILOS_WEB_DIST, webDist falls back to the default web/dist relative to the server', () => {
    delete process.env.SILOS_WEB_DIST
    expect(defaultConfig().webDist.endsWith(join('web', 'dist'))).toBe(true)
  })
})

describe('ensureData', () => {
  it('creates the structure and a stable 0600 token', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'deck-'))
    const cfg = { ...defaultConfig(), dataDir }
    const { token } = ensureData(cfg)
    expect(token).toMatch(/^[0-9a-f]{32}$/)
    for (const d of ['cache', 'trash']) expect(statSync(join(dataDir, d)).isDirectory()).toBe(true)
    expect(statSync(join(dataDir, 'token')).mode & 0o777).toBe(0o600)
    expect(ensureData(cfg).token).toBe(token)
    expect(readFileSync(join(dataDir, 'token'), 'utf8').trim()).toBe(token)
  })

  it('dataDir/cache/trash end up at 0700 (transcripts with secrets end up in trash)', () => {
    // dataDir itself (not just its subdirs) must be created by ensureData,
    // not pre-exist, to check the mode we apply ourselves.
    const base = mkdtempSync(join(tmpdir(), 'deck-'))
    const dataDir = join(base, 'fresh-data')
    const cfg = { ...defaultConfig(), dataDir }
    ensureData(cfg)
    for (const d of [dataDir, join(dataDir, 'cache'), join(dataDir, 'trash')]) {
      expect(statSync(d).mode & 0o777).toBe(0o700)
    }
  })
})

// PaaS/container deploys (Railway, Docker): bind and port come from the
// environment. The default stays loopback (invariant 1).
describe('defaultConfig — host and port for containers', () => {
  it('host defaults to 127.0.0.1 (loopback) with no override', () => {
    expect(defaultConfig().host).toBe('127.0.0.1')
  })

  it('SILOS_HOST overrides the bind address (0.0.0.0 inside a container)', () => {
    process.env.SILOS_HOST = '0.0.0.0'
    try {
      expect(defaultConfig().host).toBe('0.0.0.0')
    } finally {
      delete process.env.SILOS_HOST
    }
  })

  it('falls back to the PaaS-injected PORT if there is no SILOS_PORT', () => {
    process.env.PORT = '8080'
    try {
      expect(defaultConfig().port).toBe(8080)
    } finally {
      delete process.env.PORT
    }
  })

  it('SILOS_PORT wins over PORT', () => {
    process.env.PORT = '8080'
    process.env.SILOS_PORT = '3210'
    try {
      expect(defaultConfig().port).toBe(3210)
    } finally {
      delete process.env.PORT
      delete process.env.SILOS_PORT
    }
  })
})

// Silos Graph delivery 3: the disk sources (claude-plugins.ts, claude-mcp.ts)
// and the watchers in index.ts must read from cfg.home, never os.homedir()
// directly — SILOS_HOME is what lets the E2E harness (and tests) point
// them at a fake home instead of the real ~/.claude.
describe('defaultConfig — home', () => {
  it('home: SILOS_HOME wins, else os.homedir()', () => {
    process.env.SILOS_HOME = '/tmp/fake-home'
    try {
      expect(defaultConfig().home).toBe('/tmp/fake-home')
    } finally {
      delete process.env.SILOS_HOME
    }
    expect(defaultConfig().home).toBe(homedir())
  })
})

describe('ensureData — SILOS_TOKEN', () => {
  it('SILOS_TOKEN fixes the access token by env and persists it to the token file', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'silos-token-'))
    process.env.SILOS_TOKEN = '  abc123secret  '
    try {
      const { token } = ensureData({ ...defaultConfig(), dataDir })
      expect(token).toBe('abc123secret')
      expect(readFileSync(join(dataDir, 'token'), 'utf8').trim()).toBe('abc123secret')
    } finally {
      delete process.env.SILOS_TOKEN
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('SILOS_TOKEN replaces a previously generated token file (rotation by env)', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'silos-token-'))
    try {
      const first = ensureData({ ...defaultConfig(), dataDir }).token
      process.env.SILOS_TOKEN = 'new'
      expect(ensureData({ ...defaultConfig(), dataDir }).token).toBe('new')
      expect(first).not.toBe('new')
    } finally {
      delete process.env.SILOS_TOKEN
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('an empty SILOS_TOKEN is ignored (a random token is generated as always)', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'silos-token-'))
    process.env.SILOS_TOKEN = '   '
    try {
      expect(ensureData({ ...defaultConfig(), dataDir }).token).toMatch(/^[0-9a-f]{32}$/)
    } finally {
      delete process.env.SILOS_TOKEN
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('closes a data directory that was already there and open to others', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'deck-'))
    chmodSync(dataDir, 0o775)
    ensureData({ ...defaultConfig(), dataDir })
    expect(statSync(dataDir).mode & 0o777).toBe(0o700)
  })
})
