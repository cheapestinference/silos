// auth-status.ts — an account's login is Claude's answer to `claude auth
// status --json`. Never the real claude here: a fake runner, or (for the
// timeout and the exit code) a stand-in script run by the real runner.
import { describe, it, expect } from 'vitest'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ClaudeIdentityReader,
  authStatusEnv,
  parseAuthStatus,
  SIGNED_OUT,
  type AuthStatusCall,
  type AuthStatusRunner,
} from '../src/harnesses/claude-code/auth-status.js'

const STATUS = {
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'a@test.dev',
  orgName: 'Acme',
  subscriptionType: 'max',
  planTier: 'max_20x',
}

function reader(runner: AuthStatusRunner, extra: Partial<ConstructorParameters<typeof ClaudeIdentityReader>[0]> = {}): ClaudeIdentityReader {
  return new ClaudeIdentityReader({ home: '/home/someone', bin: () => '/opt/bin/claude', runner, ...extra })
}
const answering =
  (code: number | null, stdout: string): AuthStatusRunner =>
  async () => ({ code, stdout })

function script(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'silos-authstatus-'))
  const p = join(dir, 'claude')
  writeFileSync(p, `#!/bin/sh\n${body}\n`)
  chmodSync(p, 0o755)
  return p
}

describe('ClaudeIdentityReader', () => {
  it('signed in: email, plan (the subscription, as said on screen) and organization', async () => {
    expect(await reader(answering(0, JSON.stringify(STATUS))).read(null)).toEqual({
      loggedIn: true,
      email: 'a@test.dev',
      plan: 'Max',
      organizationName: 'Acme',
    })
  })

  it('signed out: loggedIn false, nothing else', async () => {
    expect(await reader(answering(0, JSON.stringify({ loggedIn: false }))).read(null)).toEqual(SIGNED_OUT)
    expect(await reader(answering(1, JSON.stringify({ loggedIn: false }))).read(null)).toEqual(SIGNED_OUT)
  })

  it('a non-zero exit is signed out even if the output says otherwise', async () => {
    expect(await reader(answering(2, JSON.stringify(STATUS))).read(null)).toEqual(SIGNED_OUT)
  })

  it('no claude on PATH: signed out, and nothing is spawned', async () => {
    let calls = 0
    const r = reader(
      async () => {
        calls++
        return { code: 0, stdout: JSON.stringify(STATUS) }
      },
      { bin: () => null },
    )
    expect(await r.read(null)).toEqual(SIGNED_OUT)
    expect(calls).toBe(0)
  })

  it('broken JSON, a non-object or a throwing runner: signed out', async () => {
    expect(await reader(answering(0, '{ nope')).read(null)).toEqual(SIGNED_OUT)
    expect(await reader(answering(0, '[true]')).read(null)).toEqual(SIGNED_OUT)
    expect(await reader(answering(0, '')).read(null)).toEqual(SIGNED_OUT)
    expect(
      await reader(async () => {
        throw new Error('spawn EACCES')
      }).read(null),
    ).toEqual(SIGNED_OUT)
  })

  // the answer is the proof: left to finish, this claude exits 0 with a
  // signed-in status; only a cut at the timeout reads signed out
  it('a claude that hangs is cut at the timeout: signed out', async () => {
    const bin = script(`echo '${JSON.stringify(STATUS)}'; sleep 10`)
    expect(await new ClaudeIdentityReader({ home: '/tmp', bin: () => bin, timeoutMs: 200 }).read(null)).toEqual(SIGNED_OUT)
  })

  it('the real runner reads the answer and the exit code of the process', async () => {
    const ok = script(`echo '${JSON.stringify(STATUS)}'`)
    expect(await new ClaudeIdentityReader({ home: '/tmp', bin: () => ok }).read(null)).toMatchObject({ loggedIn: true, email: 'a@test.dev' })
    const out = script(`echo '${JSON.stringify(STATUS)}'; exit 1`)
    expect(await new ClaudeIdentityReader({ home: '/tmp', bin: () => out }).read(null)).toEqual(SIGNED_OUT)
  })

  it("an extra account is asked under its CLAUDE_CONFIG_DIR; the machine's with none", async () => {
    const calls: AuthStatusCall[] = []
    const r = reader(async (c) => {
      calls.push(c)
      return { code: 0, stdout: JSON.stringify(STATUS) }
    })
    await r.read('/data/claude-accounts/work')
    await r.read(null)
    expect(calls[0]).toMatchObject({ file: '/opt/bin/claude', args: ['auth', 'status', '--json'] })
    expect(calls[0]!.env.CLAUDE_CONFIG_DIR).toBe('/data/claude-accounts/work')
    expect(calls[0]!.env.HOME).toBe('/home/someone')
    expect('CLAUDE_CONFIG_DIR' in calls[1]!.env).toBe(false)
    expect(calls[0]!.timeoutMs).toBeLessThanOrEqual(3000)
  })

  it("keeps each account's answer for the TTL; fresh asks again", async () => {
    let now = 1_000
    let calls = 0
    const r = reader(
      async () => {
        calls++
        return { code: 0, stdout: JSON.stringify(STATUS) }
      },
      { ttlMs: 30_000, now: () => now },
    )
    await r.read(null)
    await r.read(null)
    await r.read('/x')
    expect(calls).toBe(2) // one per account
    now += 29_000
    await r.read(null)
    expect(calls).toBe(2)
    now += 2_000
    await r.read(null)
    expect(calls).toBe(3)
    await r.read(null, { fresh: true })
    expect(calls).toBe(4)
  })

  it('concurrent reads of one account share one ask', async () => {
    let calls = 0
    const r = reader(async () => {
      calls++
      await new Promise((res) => setTimeout(res, 20))
      return { code: 0, stdout: JSON.stringify(STATUS) }
    })
    await Promise.all([r.read(null), r.read(null), r.read(null)])
    expect(calls).toBe(1)
  })
})

describe('authStatusEnv', () => {
  it("is built, never inherited: no CLAUDE_*/ANTHROPIC_*/CLAUDECODE nor anything else of Silos' process", () => {
    const from = {
      PATH: '/usr/bin',
      HOME: '/real/home',
      USER: 'u',
      LANG: 'C.UTF-8',
      CLAUDE_CONFIG_DIR: '/other/account',
      CLAUDECODE: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 't',
      ANTHROPIC_API_KEY: 'k',
      ANTHROPIC_BASE_URL: 'https://gw',
      SILOS_DATA_DIR: '/d',
      npm_config_prefix: '/n',
      SECRET: 's',
    }
    expect(authStatusEnv('/fixture/home', null, from)).toEqual({ PATH: '/usr/bin', HOME: '/fixture/home', USER: 'u', LANG: 'C.UTF-8' })
    expect(authStatusEnv('/fixture/home', '/acc/work', from)).toEqual({
      PATH: '/usr/bin',
      HOME: '/fixture/home',
      USER: 'u',
      LANG: 'C.UTF-8',
      CLAUDE_CONFIG_DIR: '/acc/work',
    })
  })
})

describe('parseAuthStatus', () => {
  it('no subscription (an API key) → plan null; blank strings are null', () => {
    expect(parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: 'api_key', email: ' ' }))).toEqual({
      loggedIn: true,
      email: null,
      plan: null,
      organizationName: null,
    })
  })
  it('loggedIn must be literally true', () => {
    expect(parseAuthStatus(JSON.stringify({ loggedIn: 'yes', email: 'a@b.c' }))).toEqual(SIGNED_OUT)
  })
})
