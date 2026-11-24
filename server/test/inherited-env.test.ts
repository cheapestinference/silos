// inherited-env.test.ts — the shell that starts Silos never chooses the
// account its engines run on (a server once restarted from inside a
// Claude session ran every default-account turn on another subscription).
import { describe, expect, it } from 'vitest'
import { cleanPath, devRunVars, isInheritedEngineVar, scrubDevRunEnv, scrubInheritedEngineEnv } from '../src/inherited-env.js'
import { cleanEnv } from '../src/env.js'

describe('scrubInheritedEngineEnv', () => {
  it('drops the account, the credentials and the parent session; keeps everything else', () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDE_CONFIG_DIR: '/home/u/.silos/claude-accounts/kai',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: 'x',
      ANTHROPIC_BASE_URL: '',
      CLAUDE_CODE_SESSION_ID: 's',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDECODE: '1',
      CLAUDE_PID: '9',
      CLAUDE_EFFORT: 'high',
      PATH: '/usr/bin',
      HOME: '/home/u',
      SILOS_PORT: '3210',
      TMUX: '/tmp/x',
      OPENCODE_DB: '/x',
    }
    expect(scrubInheritedEngineEnv(env)).toEqual([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'CLAUDECODE',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_EFFORT',
      'CLAUDE_PID',
    ])
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/u', SILOS_PORT: '3210', TMUX: '/tmp/x', OPENCODE_DB: '/x' })
  })
  it('a clean environment is left alone', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    expect(scrubInheritedEngineEnv(env)).toEqual([])
    expect(isInheritedEngineVar('SILOS_TOKEN')).toBe(false)
  })
})

// `npm run dev` once handed every agent process npm's run
// variables and Silos' node_modules/.bin first on PATH (stacked again on each
// restart from a console) — `tsc`/`vitest` in an agent's project ran Silos'.
describe('scrubDevRunEnv — the dev run never reaches an agent', () => {
  const npmPath = [
    '/home/u/silos/server/node_modules/.bin',
    '/home/u/silos/node_modules/.bin',
    '/home/u/node_modules/.bin',
    '/home/node_modules/.bin',
    '/node_modules/.bin',
    '/opt/node/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin',
  ]
  it("drops npm's run variables and every node_modules/.bin; the user's PATH stays, each entry once, in order", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: [...npmPath, '/opt/node/bin', ...npmPath, '/home/u/.local/bin', '/usr/bin', '/home/u/.local/bin', '/usr/bin/'].join(':'),
      npm_config_local_prefix: '/home/u/silos',
      npm_package_name: '@silos/server',
      npm_lifecycle_event: 'dev',
      INIT_CWD: '/home/u/silos',
      NODE: '/opt/node/bin/node',
      COLOR: '1',
      HOME: '/home/u',
      SILOS_PORT: '3210',
      NPM_CONFIG_REGISTRY: 'https://r.example',
    }
    expect(scrubDevRunEnv(env)).toEqual(['COLOR', 'INIT_CWD', 'NODE', 'npm_config_local_prefix', 'npm_lifecycle_event', 'npm_package_name', 'PATH'])
    expect(env).toEqual({ PATH: '/opt/node/bin:/home/u/.local/bin:/usr/bin', HOME: '/home/u', SILOS_PORT: '3210', NPM_CONFIG_REGISTRY: 'https://r.example' })
  })
  it("NODE and COLOR are only npm's when npm ran: a user's own are kept", () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', NODE: '/x/node', COLOR: '0' }
    expect(scrubDevRunEnv(env)).toEqual([])
    expect(env).toEqual({ PATH: '/usr/bin', NODE: '/x/node', COLOR: '0' })
  })
  it('cleanPath drops empty entries and is idempotent', () => {
    const once = cleanPath(':/usr/bin::/home/u/p/node_modules/.bin:/bin:/usr/bin')
    expect(once).toBe('/usr/bin:/bin')
    expect(cleanPath(once)).toBe(once)
    expect(cleanPath('/')).toBe('/')
  })
  it('devRunVars reads an environment it does not own (tmux global env)', () => {
    expect(devRunVars({ npm_x: '1', INIT_CWD: '/a', NODE: '/n', PATH: '/usr/bin' })).toEqual(['INIT_CWD', 'NODE', 'npm_x'])
  })
  it('cleanEnv (every child) applies it too', () => {
    const saved = { ...process.env }
    try {
      process.env.npm_package_name = '@silos/server'
      process.env.INIT_CWD = '/home/u/silos'
      process.env.PATH = `/home/u/silos/node_modules/.bin:${saved.PATH ?? '/usr/bin'}`
      // a server started from a briefed console: the flag is that launch's, never a child's
      process.env.SILOS_BRIEFING = 'system-prompt'
      const env = cleanEnv()
      expect(env.SILOS_BRIEFING).toBeUndefined()
      expect(env.npm_package_name).toBeUndefined()
      expect(env.INIT_CWD).toBeUndefined()
      expect(env.PATH!.split(':').some((p) => p.endsWith('node_modules/.bin'))).toBe(false)
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
      Object.assign(process.env, saved)
    }
  })
})
