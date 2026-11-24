import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ResolvedProvider } from '../src/providers-store.js'
import {
  PROVIDER_KEY_REF,
  providerInjection,
  sdkAnthropicBaseUrl,
  providerLaunch,
  configContent,
  contextText,
  defaultBriefingDir,
  defaultPluginPath,
  defaultSkillsPath,
  envFor,
  projectInstructions,
  writeContextFile,
} from '../src/harnesses/opencode/launch.js'
import { agentDbPath } from '../src/harnesses/opencode/paths.js'
import { cleanOpencodeEntries } from '../src/harnesses/opencode/launch-entries.js'
import { withHeldSkillsDenied } from '../src/harnesses/opencode/assemble.js'
// the plugin that runs inside every OpenCode process (its shell.env hook)
import { AGENT_SHELL_SILOS_ENV, ENGINE_CREDENTIAL_ENV, silosEnv } from '../../plugin-opencode/silos.ts'

const provider = { 'silos-ci': { npm: '@ai-sdk/anthropic', name: 'CI', options: { baseURL: 'https://x', apiKey: PROVIDER_KEY_REF } } }

describe('configContent', () => {
  it('serialises plugin, instructions, permission, provider and model', () => {
    const s = configContent({
      pluginPath: '/repo/plugin-opencode/silos.ts',
      instructions: ['/s/builder/opencode/context.md', '/s/builder/opencode/append.md'],
      permission: { read: { '/home/u/.ssh/**': 'deny' } },
      provider,
      model: 'silos-ci/claude-sonnet-4-5',
    })
    expect(JSON.parse(s)).toEqual({
      plugin: ['/repo/plugin-opencode/silos.ts'],
      instructions: ['/s/builder/opencode/context.md', '/s/builder/opencode/append.md'],
      permission: { read: { '/home/u/.ssh/**': 'deny' } },
      provider: { 'silos-ci': { npm: '@ai-sdk/anthropic', name: 'CI', options: { baseURL: 'https://x', apiKey: '{env:SILOS_PROVIDER_KEY}' } } },
      model: 'silos-ci/claude-sonnet-4-5',
    })
  })
  // a heartbeat turn has no web fetch, no web
  // search and no subagent (OpenCode's subagent IS the `task` tool) — in the
  // deprecated `tools` and in its successor `permission`, singular (the
  // plural aborts the launch); the fence's own rules are kept beside them
  it('a heartbeat denies webfetch, websearch and task in tools AND permission (singular)', () => {
    const cfg = JSON.parse(
      configContent({ pluginPath: '/p.ts', instructions: [], permission: { read: { '/s/**': 'deny' } }, provider: null, model: null, heartbeat: true }),
    )
    expect(cfg.tools).toEqual({ webfetch: false, websearch: false, task: false })
    expect(cfg.permission).toEqual({ read: { '/s/**': 'deny' }, webfetch: 'deny', websearch: 'deny', task: 'deny' })
    expect('permissions' in cfg).toBe(false)
    expect('plugins' in cfg).toBe(false)
    const plain = JSON.parse(configContent({ pluginPath: '/p.ts', instructions: [], permission: null, provider: null, model: null }))
    expect('tools' in plain).toBe(false)
  })
  it('omits permission, provider and model when null', () => {
    expect(JSON.parse(configContent({ pluginPath: '/p.ts', instructions: ['/c.md'], permission: null, provider: null, model: null }))).toEqual({
      plugin: ['/p.ts'],
      instructions: ['/c.md'],
    })
  })
  it('never carries a literal key: a non-substitution apiKey is refused', () => {
    const key = 'sk-ant-literal-secret'
    expect(() =>
      configContent({ pluginPath: '/p.ts', instructions: [], permission: null, provider: { x: { options: { apiKey: key } } }, model: null }),
    ).toThrow(/apiKey/)
    const s = configContent({ pluginPath: '/p.ts', instructions: [], permission: null, provider, model: 'silos-ci/m' })
    expect(s).not.toContain(key)
    expect(s).toContain('{env:SILOS_PROVIDER_KEY}')
  })
  it('only baseURL may be a plain provider option; every other must be a substitution', () => {
    const mk = (options: Record<string, string>) => () =>
      configContent({ pluginPath: '/p.ts', instructions: [], permission: null, provider: { x: { options } }, model: null })
    expect(mk({ baseURL: 'https://x', apiKey: '{file:/run/key}' })).not.toThrow()
    expect(mk({ headers: 'Bearer abc' })).toThrow(/headers/)
    expect(mk({ baseURL: 'https://x/{env:HOME}' })).toThrow(/"\{"/)
  })
  it('a "{" in an instruction path, plugin path or permission pattern is refused', () => {
    const base = { pluginPath: '/p.ts', instructions: ['/c.md'], permission: null, provider: null, model: null }
    expect(() => configContent({ ...base, instructions: ['/s/{env:X}/c.md'] })).toThrow(/instruction path/)
    expect(() => configContent({ ...base, pluginPath: '/{file:x}' })).toThrow(/plugin path/)
    expect(() => configContent({ ...base, permission: { read: { '/a/{env:X}': 'deny' } } })).toThrow(/permission pattern/)
  })
  it("declares Silos' own skills as a skills path, so an OpenCode agent loads heartbeat/team-plan like a Claude one", () => {
    const cfg = JSON.parse(
      configContent({ pluginPath: '/p.ts', instructions: [], permission: null, provider: null, model: null, skillsPaths: ['/repo/plugin/skills'] }),
    )
    expect(cfg.skills).toEqual({ paths: ['/repo/plugin/skills'] })
    expect(() => configContent({ pluginPath: '/p.ts', instructions: [], permission: null, provider: null, model: null, skillsPaths: ['/{env:X}'] })).toThrow(
      /skills path/,
    )
  })
  it('the default skills path is the repo plugin/skills folder, holding every published Silos skill', () => {
    const dir = defaultSkillsPath()
    expect(dir.endsWith('/plugin/skills')).toBe(true)
    for (const name of ['heartbeat', 'team-plan']) expect(existsSync(join(dir, name, 'SKILL.md'))).toBe(true)
  })
  it('the default plugin path is the repo plugin file', () => {
    expect(defaultPluginPath()).toMatch(/\/plugin-opencode\/silos\.ts$/)
    expect(existsSync(defaultPluginPath())).toBe(true)
  })
})

describe('envFor', () => {
  const agentStateEnv = { SILOS_AGENT_ID: 'builder', SILOS_AGENT_STATE: '/d/agent-state/builder', SILOS_AGENT_TOKEN: 'tok' }
  const base = { agentId: 'builder', agentDb: agentDbPath('/d', 'builder'), silosApi: 'http://127.0.0.1:3210', agentStateEnv, configContent: '{"plugin":[]}' }
  it('has exactly the listed keys, OPENCODE_DB under the agent dir', () => {
    const env = envFor(base)
    expect(env).toEqual({
      OPENCODE_DB: '/d/agents/builder/opencode.db',
      OPENCODE_CONFIG_CONTENT: '{"plugin":[]}',
      SILOS_API: 'http://127.0.0.1:3210',
      SILOS_AGENT_ID: 'builder',
      SILOS_AGENT_STATE: '/d/agent-state/builder',
      SILOS_AGENT_TOKEN: 'tok',
    })
  })
  it('adds console key, session id and provider key only when given', () => {
    const env = envFor({ ...base, consoleKey: 'k1', sessionId: 's1', providerKey: 'sk-1' })
    expect(Object.keys(env).sort()).toEqual([
      'OPENCODE_CONFIG_CONTENT',
      'OPENCODE_DB',
      'SILOS_AGENT_ID',
      'SILOS_AGENT_STATE',
      'SILOS_AGENT_TOKEN',
      'SILOS_API',
      'SILOS_CONSOLE_KEY',
      'SILOS_PROVIDER_KEY',
      'SILOS_SESSION_ID',
    ])
    expect(env.SILOS_CONSOLE_KEY).toBe('k1')
    expect(env.SILOS_SESSION_ID).toBe('s1')
    expect(env.SILOS_PROVIDER_KEY).toBe('sk-1')
    expect(envFor({ ...base, providerKey: '' })).not.toHaveProperty('SILOS_PROVIDER_KEY')
  })
  it('refuses an agent-state env that names another agent', () => {
    expect(() => envFor({ ...base, agentId: 'finance' })).toThrow(/builder/)
  })
  it('a fenced agent gets OPENCODE_DISABLE_PROJECT_CONFIG=1; an unfenced one does not', () => {
    expect(envFor({ ...base, fenced: true }).OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1')
    expect(envFor({ ...base, fenced: false })).not.toHaveProperty('OPENCODE_DISABLE_PROJECT_CONFIG')
    expect(envFor(base)).not.toHaveProperty('OPENCODE_DISABLE_PROJECT_CONFIG')
  })
  it('the HTTP server password rides with user silos; none → neither var', () => {
    expect(envFor({ ...base, serverPassword: 'pw' })).toMatchObject({ OPENCODE_SERVER_USERNAME: 'silos', OPENCODE_SERVER_PASSWORD: 'pw' })
    expect(envFor(base)).not.toHaveProperty('OPENCODE_SERVER_PASSWORD')
  })
  it('an agent-env (Vault) name OpenCode or Silos wiring owns is refused, never passed', () => {
    for (const k of ['OPENCODE_CONFIG', 'OPENCODE_PERMISSION', 'OPENCODE_DB', 'SILOS_SESSION_ID', 'SILOS_CONSOLE_KEY', 'SILOS_API']) {
      expect(() => envFor({ ...base, agentStateEnv: { ...base.agentStateEnv, [k]: 'x' } })).toThrow(new RegExp(`${k} is set by Silos`))
    }
  })
  it("SILOS_ASKS_REPLIES only when given (the plugin's Silos-owned reply dir)", () => {
    expect(envFor({ ...base, asksReplies: '/d/asks-replies/builder' }).SILOS_ASKS_REPLIES).toBe('/d/asks-replies/builder')
    expect(envFor(base)).not.toHaveProperty('SILOS_ASKS_REPLIES')
  })
  it('a Vault entry named SILOS_ASKS_REPLIES is refused (it would point the plugin at a dir the agent writes)', () => {
    expect(() => envFor({ ...base, agentStateEnv: { ...base.agentStateEnv, SILOS_ASKS_REPLIES: '/tmp/x' } })).toThrow(/SILOS_ASKS_REPLIES is set by Silos/)
  })
  it('a new console (no sessionId) never carries SILOS_SESSION_ID', () => {
    expect(envFor({ ...base, consoleKey: 'k' })).not.toHaveProperty('SILOS_SESSION_ID')
  })
})

// Security — the rule across both halves: every variable the launcher
// puts in an OpenCode process is either agent-facing (the plugin's
// allowlist), Silos wiring the plugin blanks (any other SILOS_*), a declared
// engine credential the plugin blanks, or OpenCode's own non-secret wiring.
// A new variable in envFor that is none of these fails here until someone
// decides which it is.
describe("envFor × the plugin's shell.env: no credential reaches an agent's shell", () => {
  const OPENCODE_WIRING = new Set(['OPENCODE_DB', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_SERVER_USERNAME'])
  const full = envFor({
    agentId: 'builder',
    agentDb: '/d/agents/builder/opencode.db',
    silosApi: 'http://127.0.0.1:3210',
    configContent: '{}',
    agentStateEnv: { SILOS_AGENT_ID: 'builder', SILOS_AGENT_STATE: '/d/agent-state/builder', SILOS_AGENT_TOKEN: 'agent-bearer', STRIPE_KEY: 'vault-value' },
    consoleKey: 'console-key',
    sessionId: 'ses_1',
    turn: 'turn-1',
    providerKey: 'sk-provider',
    fenced: true,
    serverPassword: 'tui-pw',
    asksReplies: '/d/asks-replies/builder',
  })
  it('every launcher variable is classified', () => {
    for (const k of Object.keys(full)) {
      const known =
        AGENT_SHELL_SILOS_ENV.includes(k) || k.startsWith('SILOS_') || ENGINE_CREDENTIAL_ENV.includes(k) || OPENCODE_WIRING.has(k) || k === 'STRIPE_KEY'
      expect(known, `${k} is not classified for the agent's shell`).toBe(true)
    }
  })
  it('the shell OpenCode builds ({...process env, ...hook output}) holds no provider key, console key or TUI password', () => {
    const shell = { ...full, ...silosEnv(full, 'ses_1') }
    expect(shell.SILOS_PROVIDER_KEY).toBe('')
    expect(shell.OPENCODE_SERVER_PASSWORD).toBe('')
    expect(shell.SILOS_CONSOLE_KEY).toBe('')
    for (const secret of ['sk-provider', 'tui-pw', 'console-key']) expect(Object.values(shell)).not.toContain(secret)
    // what the agent is meant to have: its identity, its bearer, its Vault
    expect(shell).toMatchObject({ SILOS_AGENT_TOKEN: 'agent-bearer', SILOS_API: 'http://127.0.0.1:3210', SILOS_TURN: 'turn-1', STRIPE_KEY: 'vault-value' })
  })
})

describe('context file', () => {
  it('writes <agent-state>/opencode/context.md and nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-ctx-'))
    const p = writeContextFile(dir, 'hello')
    expect(p).toBe(join(dir, 'opencode', 'context.md'))
    expect(readFileSync(p, 'utf8')).toBe('hello')
    expect(readdirSync(dir)).toEqual(['opencode'])
    expect(readdirSync(join(dir, 'opencode'))).toEqual(['context.md'])
    writeContextFile(dir, 'again')
    expect(readFileSync(p, 'utf8')).toBe('again')
    expect(readdirSync(join(dir, 'opencode'))).toEqual(['context.md'])
  })
  it('composes briefing + blank line + roster, as session-start.sh does', () => {
    const briefing = readFileSync(join(defaultBriefingDir(), 'base.md'), 'utf8')
    expect(briefing).toContain('-H "Authorization: Bearer $SILOS_AGENT_TOKEN"')
    const t = contextText(briefing, 'Your fleet (Silos):\n- x')
    expect(t).toBe(`${briefing.replace(/\n+$/, '')}\n\nYour fleet (Silos):\n- x`)
    expect(contextText(briefing + '\n\n', '')).toBe(briefing.replace(/\n+$/, ''))
  })
})

describe('projectInstructions — OpenCode 1.14.22 discovery, for a fenced launch', () => {
  it('the first name found (AGENTS.md › CLAUDE.md › CONTEXT.md) wins, every match from cwd up to the worktree, nearest first', async () => {
    const { mkdtempSync: mk, mkdirSync: md, writeFileSync: wf, realpathSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join: j } = await import('node:path')
    const repo = realpathSync(mk(j(tmpdir(), 'oc-pi-')))
    md(j(repo, 'a', 'b'), { recursive: true })
    expect(projectInstructions(j(repo, 'a', 'b'), repo)).toEqual([])
    wf(j(repo, 'CLAUDE.md'), 'c')
    wf(j(repo, 'a', 'CLAUDE.md'), 'c')
    expect(projectInstructions(j(repo, 'a', 'b'), repo)).toEqual([j(repo, 'a', 'CLAUDE.md'), j(repo, 'CLAUDE.md')])
    wf(j(repo, 'AGENTS.md'), 'a')
    expect(projectInstructions(j(repo, 'a', 'b'), repo)).toEqual([j(repo, 'AGENTS.md')])
    // above the worktree is never looked at
    expect(projectInstructions(j(repo, 'a', 'b'), j(repo, 'a'))).toEqual([j(repo, 'a', 'CLAUDE.md')])
  })
})

// What each Silos provider kind injects into an OpenCode process.
describe('providerLaunch (provider kinds → OpenCode config + env)', () => {
  const AC: ResolvedProvider = {
    id: 'ci',
    kind: 'anthropic-compatible',
    label: 'cheapestinference',
    baseUrl: 'https://api.ci.test/anthropic',
    apiKey: 'sk-ci-secret-123456',
  }
  const HP: ResolvedProvider = { id: 'h1', kind: 'harness-provider', label: 'MiniMax', harness: 'opencode', providerId: 'minimax-coding-plan', apiKey: 'k' }
  const HN: ResolvedProvider = { id: 'h2', kind: 'harness-native', label: 'Z.ai', harness: 'opencode', providerId: 'zai' }
  const DEF: ResolvedProvider = { id: 'default', kind: 'claude-account', label: 'Claude (this machine)', configDir: null }

  it("a gateway's learned models are DECLARED on its OpenCode provider entry — the TUI lists a custom provider's models only from config", () => {
    const withModels: ResolvedProvider = { ...AC, models: ['mimo-v2.6-flash', 'deepseek-v4.1-flash'] }
    expect(providerInjection(withModels)).toEqual({
      'silos-ci': {
        npm: '@ai-sdk/anthropic',
        name: 'cheapestinference',
        options: { baseURL: 'https://api.ci.test/anthropic/v1', apiKey: PROVIDER_KEY_REF },
        models: { 'mimo-v2.6-flash': { name: 'mimo-v2.6-flash' }, 'deepseek-v4.1-flash': { name: 'deepseek-v4.1-flash' } },
      },
    })
    expect(providerInjection(AC)).not.toHaveProperty(['silos-ci', 'models']) // no list known: nothing invented
  })

  it("a limit is declared only when the gateway published BOTH numbers — OpenCode's schema rejects a context-only limit (ConfigInvalidError, the TUI exits)", () => {
    const withLimits: ResolvedProvider = {
      ...AC,
      models: ['mimo-v2.6-flash', 'kimi-k3', 'bare'],
      modelLimits: { 'mimo-v2.6-flash': { context: 1048576 }, 'kimi-k3': { context: 262144, output: 32000 } },
    }
    const entry = providerInjection(withLimits)!['silos-ci']!
    expect(entry.models).toEqual({
      'mimo-v2.6-flash': { name: 'mimo-v2.6-flash' },
      'kimi-k3': { name: 'kimi-k3', limit: { context: 262144, output: 32000 } },
      bare: { name: 'bare' },
    })
  })

  it("a pin to a model the pool dropped runs the key's first model instead of failing every run", () => {
    const withModels: ResolvedProvider = { ...AC, models: ['mimo-v2.6-flash', 'deepseek-v4.1-flash'] }
    expect(providerLaunch(withModels, 'kimi-k3').model).toBe('silos-ci/mimo-v2.6-flash')
    expect(providerLaunch(withModels, 'silos-ci/kimi-k3').model).toBe('silos-ci/mimo-v2.6-flash')
    expect(providerLaunch(withModels, 'silos-ci/deepseek-v4.1-flash').model).toBe('silos-ci/deepseek-v4.1-flash')
  })

  it('a gateway pinned with NO model runs its first known model — never no model (OpenCode would fall to its own default provider)', () => {
    const withModels: ResolvedProvider = { ...AC, models: ['mimo-v2.6-flash', 'deepseek-v4.1-flash'] }
    expect(providerLaunch(withModels, null).model).toBe('silos-ci/mimo-v2.6-flash')
    expect(providerLaunch(withModels, 'deepseek-v4.1-flash').model).toBe('silos-ci/deepseek-v4.1-flash')
    expect(providerLaunch(AC, null).model).toBeNull() // no list known: the operator's default stands, as before
  })

  it('harness-provider: the catalogue id gets the key by substitution, the key rides the env', () => {
    expect(providerInjection(HP)).toEqual({ 'minimax-coding-plan': { options: { apiKey: '{env:SILOS_PROVIDER_KEY}' } } })
    const l = providerLaunch(HP, null)
    expect(l).toEqual({ provider: { 'minimax-coding-plan': { options: { apiKey: '{env:SILOS_PROVIDER_KEY}' } } }, model: null, providerKey: 'k' })
    const env = envFor({
      agentId: 'a',
      agentDb: '/db',
      silosApi: 'http://x',
      agentStateEnv: {},
      configContent: '{}',
      ...(l.providerKey ? { providerKey: l.providerKey } : {}),
    })
    expect(env.SILOS_PROVIDER_KEY).toBe('k')
    expect(providerLaunch(HP, 'MiniMax-M2').model).toBe('minimax-coding-plan/MiniMax-M2')
    expect(providerLaunch(HP, 'minimax-coding-plan/MiniMax-M2').model).toBe('minimax-coding-plan/MiniMax-M2')
  })

  it('anthropic-compatible: a silos-<id> provider on @ai-sdk/anthropic, model under it', () => {
    expect(providerInjection(AC)).toEqual({
      'silos-ci': {
        npm: '@ai-sdk/anthropic',
        name: 'cheapestinference',
        options: { baseURL: 'https://api.ci.test/anthropic/v1', apiKey: '{env:SILOS_PROVIDER_KEY}' },
      },
    })
    const l = providerLaunch(AC, 'claude-sonnet-4-5')
    expect(l.model).toBe('silos-ci/claude-sonnet-4-5')
    expect(l.providerKey).toBe('sk-ci-secret-123456')
    expect(providerLaunch(AC, null).model).toBeNull()
    // the config string names the key, never holds it
    const cfg = configContent({ pluginPath: '/p.ts', instructions: [], permission: null, provider: l.provider, model: l.model })
    expect(cfg).not.toContain('sk-ci-secret')
    expect(JSON.parse(cfg).model).toBe('silos-ci/claude-sonnet-4-5')
  })

  it('harness-native: nothing injected, no key env', () => {
    expect(providerInjection(HN)).toBeNull()
    expect(providerLaunch(HN, null)).toEqual({ provider: null, model: null })
    expect(providerLaunch(HN, 'glm-4.6').model).toBe('zai/glm-4.6')
    const env = envFor({ agentId: 'a', agentDb: '/db', silosApi: 'http://x', agentStateEnv: {}, configContent: '{}' })
    expect(env.SILOS_PROVIDER_KEY).toBeUndefined()
  })

  it("no Silos provider (default / none): the operator's OpenCode defaults; only a provider/model id passes", () => {
    for (const p of [DEF, null]) {
      expect(providerLaunch(p, 'opus')).toEqual({ provider: null, model: null })
      expect(providerLaunch(p, 'zai/glm-4.6')).toEqual({ provider: null, model: 'zai/glm-4.6' })
    }
  })

  it("an invalidated key ('') fails the launch CLOSED — never an empty key OpenCode might fill from its own login", () => {
    expect(() => providerLaunch({ ...HP, apiKey: '' } as ResolvedProvider, null)).toThrow(/MiniMax has no key — paste it again/)
    expect(() => providerLaunch({ ...AC, apiKey: '' } as ResolvedProvider, null)).toThrow(/cheapestinference has no key — paste it again/)
  })
})

describe('providerLaunch model ids', () => {
  it('a catalogue model id that holds a slash still goes under the provider id', () => {
    const OR: ResolvedProvider = { id: 'h3', kind: 'harness-provider', label: 'OpenRouter', harness: 'opencode', providerId: 'openrouter', apiKey: 'k' }
    expect(providerLaunch(OR, 'anthropic/claude-sonnet-4.5').model).toBe('openrouter/anthropic/claude-sonnet-4.5')
  })
})

describe('sdkAnthropicBaseUrl — the AI SDK appends only /messages', () => {
  it('adds /v1 to a Claude-style root and keeps a root that already ends in /v1', () => {
    expect(sdkAnthropicBaseUrl('https://api.cheapestinference.com/anthropic')).toBe('https://api.cheapestinference.com/anthropic/v1')
    expect(sdkAnthropicBaseUrl('https://api.cheapestinference.com/anthropic/')).toBe('https://api.cheapestinference.com/anthropic/v1')
    expect(sdkAnthropicBaseUrl('https://proxy.test/v1')).toBe('https://proxy.test/v1')
  })
})

// the plugin is type-checked against the plugin API of the engine minimum
// Silos enforces (version.ts): the two move together, or the types describe
// a release Silos refuses to run
describe('plugin-opencode types = the OpenCode minimum', () => {
  it('@opencode-ai/plugin is pinned at OPENCODE_MINIMUM', async () => {
    const { OPENCODE_MINIMUM } = await import('../src/harnesses/opencode/version.js')
    const pkg = JSON.parse(readFileSync(new URL('../../plugin-opencode/package.json', import.meta.url), 'utf8')) as { devDependencies: Record<string, string> }
    expect(pkg.devDependencies['@opencode-ai/plugin']).toBe(OPENCODE_MINIMUM)
  })
})

// ---- the places Silos keeps, carried in the launch (spec scopes §6, §9) ----

describe("configContent — what Silos keeps for this launch's places", () => {
  const base = { pluginPath: '/p.ts', instructions: [] as string[], provider: null, model: null }
  const fence = {
    read: { '/home/user/.ssh/**': 'deny' as const, '.ssh/**': 'deny' as const },
    edit: { 'opencode.json': 'deny' as const, '/home/user/.config/opencode/**': 'deny' as const },
    bash: { 'rm -rf *': 'deny' as const },
  }
  const cfgOf = (carried: unknown[], extra: Partial<Parameters<typeof configContent>[0]> = {}): Record<string, unknown> =>
    JSON.parse(configContent({ ...base, permission: fence, ...extra, carried })) as Record<string, unknown>

  it("mcp.<name>.enabled: the folder's entries, then the agent's, then the thread's over them", () => {
    const folder = { mcp: { docs: { enabled: false }, search: { enabled: false }, db: { enabled: false } } }
    const agent = { mcp: { docs: { enabled: true }, search: { enabled: true } } }
    const thread = { mcp: { search: { enabled: false } } }
    expect(cfgOf([folder, agent, thread]).mcp).toEqual({ docs: { enabled: true }, search: { enabled: false }, db: { enabled: false } })
    // the agent's own server keeps its definition: only `enabled` is the payload's
    const own = { builder_books: { type: 'local' as const, command: ['books-mcp'], enabled: true as const } }
    expect(cfgOf([{ mcp: { builder_books: { enabled: false } } }], { mcp: own }).mcp).toEqual({
      builder_books: { type: 'local', command: ['books-mcp'], enabled: false },
    })
  })

  it("a skill's deny is merged into the fence's permission: every fence key kept, in order; a held skill stays denied", () => {
    const held = withHeldSkillsDenied(fence, ['drafts'])
    const cfg = cfgOf([{ permission: { skill: { notes: 'deny' } } }, { permission: { skill: { drafts: 'allow', notes: 'deny' } } }], { permission: held })
    const permission = cfg.permission as Record<string, unknown>
    expect(Object.keys(permission)).toEqual(['read', 'edit', 'bash', 'skill'])
    expect({ read: permission.read, edit: permission.edit, bash: permission.bash }).toEqual(fence)
    // an «allow» is not a shape the allowlist knows: the held name stays denied
    expect(permission.skill).toEqual({ drafts: 'deny', notes: 'deny' })
    // with no fence at all, the deny is the whole permission
    expect(cfgOf([{ permission: { skill: { notes: 'deny' } } }], { permission: null }).permission).toEqual({ skill: { notes: 'deny' } })
  })

  it('a payload carrying any other key or shape is dropped: the config is what it was', () => {
    const plain = configContent({ ...base, permission: fence })
    const evil = {
      permission: { bash: { '*': 'allow' }, read: { '/home/user/.ssh/**': 'allow' }, edit: 'allow', skill: { x: 'allow' } },
      mcp: { evil: { type: 'local', command: ['curl', 'example.com'], enabled: true }, half: { enabled: 'yes' }, '{env:HOME}': { enabled: false } },
      plugin: ['/tmp/evil.ts'],
      instructions: ['/tmp/evil.md'],
      provider: { x: { options: { apiKey: 'sk' } } },
      model: 'x/y',
      env: { A: '1' },
      hooks: {},
    }
    expect(configContent({ ...base, permission: fence, carried: [evil, null, 'text', [1], { mcp: [] }] })).toBe(plain)
    expect(cleanOpencodeEntries(evil)).toBeNull()
  })

  it('names are data: `__proto__` and `constructor` are entries like any other', () => {
    const p = JSON.parse('{"mcp":{"__proto__":{"enabled":false},"constructor":{"enabled":false}}}') as unknown
    const cfg = cfgOf([p])
    expect(Object.keys(cfg.mcp as object).sort()).toEqual(['__proto__', 'constructor'])
    expect(({} as Record<string, unknown>).enabled).toBeUndefined()
  })

  it('a heartbeat, with or without its tools, takes only what removes: no «enabled: true»', () => {
    const carried = [{ mcp: { docs: { enabled: true }, search: { enabled: false } }, permission: { skill: { notes: 'deny' } } }]
    for (const heartbeat of [true, 'tools'] as const) {
      const cfg = cfgOf(carried, { heartbeat })
      expect(cfg.mcp).toEqual({ search: { enabled: false } })
      expect((cfg.permission as Record<string, unknown>).skill).toEqual({ notes: 'deny' })
    }
  })

  it('no payload: byte-identical', () => {
    expect(configContent({ ...base, permission: fence, carried: [] })).toBe(configContent({ ...base, permission: fence }))
  })
})
