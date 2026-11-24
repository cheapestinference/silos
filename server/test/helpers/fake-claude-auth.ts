// A stand-in for `claude auth status --json` (auth-status.ts): tests NEVER
// run the real claude. The account's answer is a file inside its config dir
// (the machine's account: the defaultConfigDir handed here) — present = what
// Claude would print, absent = signed out (exit 1).
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ClaudeIdentityReader, type AuthStatusRunner } from '../../src/harnesses/claude-code/auth-status.js'

export const FAKE_AUTH_FILE = 'fake-auth-status.json'

export function fakeAuthRunner(defaultConfigDir: string): AuthStatusRunner {
  return async (call) => {
    const dir = call.env.CLAUDE_CONFIG_DIR ?? defaultConfigDir
    try {
      return { code: 0, stdout: readFileSync(join(dir, FAKE_AUTH_FILE), 'utf8') }
    } catch {
      return { code: 1, stdout: JSON.stringify({ loggedIn: false }) }
    }
  }
}

/** A reader that asks the fake, never cached (each read sees the file now). */
export function fakeIdentity(defaultConfigDir: string): ClaudeIdentityReader {
  return new ClaudeIdentityReader({ home: '/nonexistent-home', runner: fakeAuthRunner(defaultConfigDir), bin: () => '/fake/claude', ttlMs: 0 })
}

/** Claude now says this account is signed in (as `status`'s fields). */
export function fakeSignIn(configDir: string, status: Record<string, unknown> = {}): void {
  writeFileSync(join(configDir, FAKE_AUTH_FILE), JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', ...status }))
}
