// per-provider env injection matrix (Providers v1) — includes the key
// REGRESSION test: with the default provider, envForProvider() is
// byte-identical to cleanEnv() (the original behavior).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { OWNER_CREDENTIAL_ENV, cleanEnv, scrubOwnerCredentials } from '../src/env.js'
import { cleanPath } from '../src/inherited-env.js'
import { envForProvider, consoleEnvForProvider } from '../src/harnesses/claude-code/env.js'
import type { ResolvedProvider } from '../src/providers-store.js'

const TOUCHED = [
  'CLAUDE_CONFIG_DIR',
  'CLAUDECODE_X',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'SILOS_AGENT_STATE',
  'SILOS_AGENT_TOKEN',
  'SILOS_AGENT_ID',
  'SILOS_CONSOLE_KEY',
  'SILOS_PROVIDER_KEY',
  'SILOS_ASKS_REPLIES',
  'SILOS_TOKEN',
] as const
let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = {}
  for (const k of TOUCHED) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

const DEFAULT: ResolvedProvider = { id: 'default', kind: 'claude-account', label: 'Claude (this machine)', configDir: null }
const ACCOUNT: ResolvedProvider = { id: 'account:alt', kind: 'claude-account', label: 'Claude · alt', configDir: '/tmp/deck-accounts/alt' }
const KEYPROV: ResolvedProvider = {
  id: 'p1',
  kind: 'anthropic-compatible',
  label: 'cheapestinference',
  baseUrl: 'https://api.cheapestinference.com/anthropic',
  apiKey: 'sk-live-abcdef123456',
}

describe('cleanEnv', () => {
  // the server itself can run INSIDE a Silos console (the owner's setup):
  // its process.env then carries the PARENT agent's SILOS_AGENT_STATE. That
  // var is per-agent platform plumbing (chat-service re-injects the right
  // one per turn, last-write-wins) — inheriting it would point a child
  // agent at ANOTHER agent's state dir whenever its own degrades.
  it('drops an inherited SILOS_AGENT_STATE (re-injected per agent, never inherited)', () => {
    process.env.SILOS_AGENT_STATE = '/home/other/.silos/agent-state/parent'
    expect(cleanEnv().SILOS_AGENT_STATE).toBeUndefined()
  })

  // Same plumbing, same rule: a server started inside an agent's console
  // must not hand that agent's bearer (or identity) to master or to an
  // agent the owner has not enabled — both engines build on cleanEnv().
  it('drops an inherited SILOS_AGENT_TOKEN and SILOS_AGENT_ID', () => {
    process.env.SILOS_AGENT_TOKEN = 'parent-bearer'
    process.env.SILOS_AGENT_ID = 'parent'
    const env = cleanEnv()
    expect(env.SILOS_AGENT_TOKEN).toBeUndefined()
    expect(env.SILOS_AGENT_ID).toBeUndefined()
  })

  // OpenCode console plumbing: a server started inside an OpenCode console
  // carries that console's key (the registrar would seal every child as
  // that console's conversation) and its provider key (a secret meant for
  // one process only). Neither is ever inherited.
  it('drops an inherited SILOS_CONSOLE_KEY and SILOS_PROVIDER_KEY', () => {
    process.env.SILOS_CONSOLE_KEY = 'parent-console'
    process.env.SILOS_PROVIDER_KEY = 'sk-parent'
    const env = cleanEnv()
    expect(env.SILOS_CONSOLE_KEY).toBeUndefined()
    expect(env.SILOS_PROVIDER_KEY).toBeUndefined()
  })

  it("drops an inherited SILOS_ASKS_REPLIES (each OpenCode process gets its own agent's)", () => {
    process.env.SILOS_ASKS_REPLIES = '/home/u/.silos/asks-replies/parent'
    expect(cleanEnv().SILOS_ASKS_REPLIES).toBeUndefined()
  })

  // security: the owner's static token (SILOS_TOKEN, how a PaaS deploy
  // fixes it) is read once at boot and is never any child's — a console,
  // chat turn or command run with it holds the key to the whole API
  it("never hands a child the owner's token; the boot scrub takes it out of the env it is given", () => {
    expect(OWNER_CREDENTIAL_ENV).toContain('SILOS_TOKEN')
    process.env.SILOS_TOKEN = 'owner-token'
    expect(cleanEnv().SILOS_TOKEN).toBeUndefined()
    const env: NodeJS.ProcessEnv = { SILOS_TOKEN: 'owner-token', PATH: '/usr/bin' }
    expect(scrubOwnerCredentials(env)).toEqual(['SILOS_TOKEN'])
    expect(env).toEqual({ PATH: '/usr/bin' })
    expect(scrubOwnerCredentials(env)).toEqual([])
  })
})

describe('envForProvider', () => {
  it('default -> byte-identical to cleanEnv() (regression: nothing added, nothing missing)', () => {
    process.env.CLAUDECODE_X = 'inherited' // must fall through on both
    expect(envForProvider(DEFAULT)).toEqual(cleanEnv())
    expect(envForProvider(null)).toEqual(cleanEnv())
    expect(envForProvider(undefined)).toEqual(cleanEnv())
    expect(envForProvider(DEFAULT).CLAUDE_CONFIG_DIR).toBeUndefined()
  })

  it('a claude account -> cleanEnv() + CLAUDE_CONFIG_DIR injected AFTER the cleanup', () => {
    // the bug this covers: cleanEnv strips /^CLAUDE/ — a CLAUDE_CONFIG_DIR
    // inherited from the parent dies, but the one injected by the provider survives.
    process.env.CLAUDE_CONFIG_DIR = '/inherited/from/parent'
    const env = envForProvider(ACCOUNT)
    expect(env.CLAUDE_CONFIG_DIR).toBe('/tmp/deck-accounts/alt')
    // and the rest is exactly cleanEnv()
    const { CLAUDE_CONFIG_DIR: _injected, ...rest } = env
    expect(rest).toEqual(cleanEnv())
  })

  // an ANTHROPIC_API_KEY from the shell would compete with the chosen
  // account's OAuth login — the account would get silently ignored.
  it('a claude account -> strips inherited ANTHROPIC_* credentials; default KEEPS them (parity)', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-from-shell'
    process.env.ANTHROPIC_AUTH_TOKEN = 'tok-from-shell'
    process.env.ANTHROPIC_BASE_URL = 'https://proxy-from-shell'
    const env = envForProvider(ACCOUNT)
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env.CLAUDE_CONFIG_DIR).toBe('/tmp/deck-accounts/alt')
    // default stays byte-identical to cleanEnv(), inherited credentials
    // INCLUDED — the original behavior doesn't change by a single byte.
    const byDefault = envForProvider(DEFAULT)
    expect(byDefault).toEqual(cleanEnv())
    expect(byDefault.ANTHROPIC_API_KEY).toBe('sk-from-shell')
  })

  it("anthropic-compatible -> the provider's BASE_URL + AUTH_TOKEN, inherited credentials stripped", () => {
    process.env.ANTHROPIC_API_KEY = 'sk-from-owner-shell'
    process.env.ANTHROPIC_AUTH_TOKEN = 'tok-old'
    process.env.ANTHROPIC_BASE_URL = 'https://other.proxy'
    const env = envForProvider(KEYPROV)
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.cheapestinference.com/anthropic')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-live-abcdef123456')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined() // the shell's does not compete
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined() // same config dir as always: transcripts stay intact
  })

  it('a gateway with known models makes its FIRST model the default (ANTHROPIC_MODEL + SMALL_FAST) — a pin still wins via --model; no list → nothing set', () => {
    const gw = {
      id: 'ci',
      kind: 'anthropic-compatible' as const,
      label: 'ci',
      baseUrl: 'https://api.ci.test/anthropic',
      apiKey: 'sk-x',
      models: ['mimo-v2.6-flash', 'deepseek-v4.1-flash'],
    }
    const env = envForProvider(gw)
    expect(env.ANTHROPIC_MODEL).toBe('mimo-v2.6-flash')
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('mimo-v2.6-flash')
    const bare = envForProvider({ ...gw, models: undefined })
    expect(bare.ANTHROPIC_MODEL).toBeUndefined()
    const console = consoleEnvForProvider(gw)
    expect(console.ANTHROPIC_MODEL).toBe('mimo-v2.6-flash')
    expect(consoleEnvForProvider({ ...gw, models: [] }).ANTHROPIC_MODEL).toBe('') // cleared, never inherited
  })

  it('cleanEnv keeps stripping every /^CLAUDE/ and preserving the rest', () => {
    process.env.CLAUDECODE_X = 'x'
    const env = cleanEnv()
    expect(env.CLAUDECODE_X).toBeUndefined()
    // the PATH is the user's own: npm's node_modules/.bin never reach a child
    expect(env.PATH).toBe(cleanPath(process.env.PATH ?? ''))
  })
})

// consoleEnvForProvider: the console's tmux-session delta (ensureConsole
// extraEnv) — same semantics as envForProvider, without shipping the whole
// process env through `tmux -e`.
describe('consoleEnvForProvider', () => {
  it('default provider (null / configDir null) is an EMPTY delta — the console stays as it always was', () => {
    expect(consoleEnvForProvider(null)).toEqual({})
    expect(consoleEnvForProvider({ id: 'default', kind: 'claude-account', label: 'x', configDir: null })).toEqual({})
  })
  it('a Claude account pins CLAUDE_CONFIG_DIR and neutralizes inherited ANTHROPIC_* credentials', () => {
    expect(consoleEnvForProvider({ id: 'account:kai', kind: 'claude-account', label: 'kai', configDir: '/x/kai' })).toEqual({
      CLAUDE_CONFIG_DIR: '/x/kai',
      ANTHROPIC_BASE_URL: '',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
    })
  })
  it('a key-based provider rides as BASE_URL + AUTH_TOKEN (Bearer), with API_KEY neutralized', () => {
    expect(consoleEnvForProvider(KEYPROV)).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.cheapestinference.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'sk-live-abcdef123456',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_MODEL: '',
      ANTHROPIC_SMALL_FAST_MODEL: '',
    })
  })
})

// OpenCode kinds never reach a Claude process: they touch no ANTHROPIC_* var
// (the OpenCode engine injects them its own way — harnesses/opencode/launch).
describe('OpenCode provider kinds in the Claude env builders', () => {
  const HP: ResolvedProvider = {
    id: 'h1',
    kind: 'harness-provider',
    label: 'MiniMax',
    harness: 'opencode',
    providerId: 'minimax-coding-plan',
    apiKey: 'mm-secret-key-123456',
  }
  const HN: ResolvedProvider = { id: 'h2', kind: 'harness-native', label: 'Z.ai', harness: 'opencode', providerId: 'zai' }
  it('envForProvider adds nothing to cleanEnv() and never carries the key', () => {
    process.env.ANTHROPIC_API_KEY = 'inherited'
    for (const p of [HP, HN]) {
      expect(envForProvider(p)).toEqual(cleanEnv())
      expect(JSON.stringify(envForProvider(p))).not.toContain('mm-secret')
    }
  })
  it('consoleEnvForProvider is an empty delta', () => {
    expect(consoleEnvForProvider(HP)).toEqual({})
    expect(consoleEnvForProvider(HN)).toEqual({})
  })
})
