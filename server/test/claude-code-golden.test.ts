// claude-code-golden.test.ts — the characterization net under the Claude adapter
// relocation (plans/claude-adapter-relocation, Task 0): the literal argv, env
// and SDK options Claude Code receives today, frozen from a run. Later move
// tasks edit ONLY the import lines; a failure here means behaviour changed.
// Literals are compared with toEqual AND serialized (key order is part of the
// contract: --settings JSON, env order).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { TerminalService } from '../src/terminal-service.js'
import { defaultConsoleCommand, rotationHookCommand, contextNewsHookCommand } from '../src/harnesses/claude-code/console.js'
import { defaultLoginCommand } from '../src/harnesses/claude-code/login.js'
import { claudeSessionIndex } from '../src/harnesses/claude-code/reader.js'
import { envForProvider, consoleEnvForProvider } from '../src/harnesses/claude-code/env.js'
import type { ResolvedProvider } from '../src/providers-store.js'
import type { FenceOverlay } from '../src/territory.js'
import { AgentRegistry } from '../src/agent-registry.js'
import { NativeStore } from '../src/native-store.js'
import { ChatService } from '../src/chat-service.js'
import { briefingText } from '../src/harnesses/briefing.js'
import type { QueryArgs, SdkQueryHandle } from '../src/harnesses/claude-code/sdk-types.js'

const same = (actual: unknown, expected: unknown): void => {
  expect(actual).toEqual(expected)
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected))
}

let savedEnv: NodeJS.ProcessEnv
beforeEach(async () => {
  savedEnv = process.env
  process.env = { PATH: '/usr/bin', HOME: '/home/g' }
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-inherited') // pruned or pinned per provider
  vi.stubEnv('CLAUDE_X', '1') // /^CLAUDE/ never reaches a child
})
const dirs: string[] = []
const tempDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
afterEach(async () => {
  vi.unstubAllEnvs()
  process.env = savedEnv
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const FENCE: FenceOverlay = { permissions: { deny: ['Read(//home/u/.silos/*.json)'], additionalDirectories: ['/srv/b'] } } as FenceOverlay
const ROT =
  "node -e \"let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const s=JSON.parse(d).session_id;if(typeof s==='string'&&/^[\\\\w-]+\\$/.test(s))require('fs').writeFileSync(require('path').join(\\\"/d\\\",s+'.json'),JSON.stringify({from:\\\"k\\\"}))}catch{}})\""
const NEWS =
  "node -e \"try{const f=require('fs'),p=require('path');const m=p.join(\\\"/d\\\",\\\"k\\\"+'.ctx');let s=0;try{s=f.statSync(m).mtimeMs}catch{}const o=[];for(const d of ['shared',\\\"writer\\\"]){const r=p.join(\\\"/p\\\",'context',d);let n=[];try{n=f.readdirSync(r)}catch{}for(const x of n){if(x[0]==='.')continue;try{const t=f.statSync(p.join(r,x));if(t.isFile()&&s>0&&t.mtimeMs>s)o.push('- context/'+d+'/'+x)}catch{}}}f.mkdirSync(\\\"/d\\\",{recursive:true});f.writeFileSync(m,'');if(o.length)console.log(\\\"New context files since your last turn — the owner just added them, read them if relevant:\\\"+'\\\\n'+o.join('\\\\n'))}catch{}\""

describe('console argv', () => {
  it('hook commands', async () => {
    expect(rotationHookCommand('/d', 'k')).toBe(ROT)
    expect(contextNewsHookCommand('/d', 'k', '/p', 'writer')).toBe(NEWS)
  })
  it('the console matrix', async () => {
    same(defaultConsoleCommand({ sessionId: 's-1' }), ['claude', '--session-id', 's-1'])
    same(defaultConsoleCommand({ resumeId: 'r-1', theme: 'light' }), ['claude', '--settings', '{"theme":"light"}', '--resume', 'r-1'])
    same(defaultConsoleCommand({ permissionMode: 'bypassPermissions', fence: FENCE }), [
      'claude',
      '--dangerously-skip-permissions',
      '--settings',
      '{"permissions":{"deny":["Read(//home/u/.silos/*.json)"],"additionalDirectories":["/srv/b"]}}',
    ])
    same(
      defaultConsoleCommand({
        permissionMode: 'plan',
        model: 'opus',
        appendFile: '/a/k.md',
        rotationHook: { dir: '/d', key: 'k' },
        contextNews: { dir: '/d', key: 'k', cwd: '/p', agentId: 'writer' },
      }),
      [
        'claude',
        '--append-system-prompt-file',
        '/a/k.md',
        '--permission-mode',
        'plan',
        '--model',
        'opus',
        '--settings',
        '{"hooks":{"SessionStart":[{"matcher":"clear","hooks":[{"type":"command","command":"node -e \\"let d=\'\';process.stdin.on(\'data\',c=>d+=c).on(\'end\',()=>{try{const s=JSON.parse(d).session_id;if(typeof s===\'string\'&&/^[\\\\\\\\w-]+\\\\$/.test(s))require(\'fs\').writeFileSync(require(\'path\').join(\\\\\\"/d\\\\\\",s+\'.json\'),JSON.stringify({from:\\\\\\"k\\\\\\"}))}catch{}})\\""}]}],"UserPromptSubmit":[{"hooks":[{"type":"command","command":"node -e \\"try{const f=require(\'fs\'),p=require(\'path\');const m=p.join(\\\\\\"/d\\\\\\",\\\\\\"k\\\\\\"+\'.ctx\');let s=0;try{s=f.statSync(m).mtimeMs}catch{}const o=[];for(const d of [\'shared\',\\\\\\"writer\\\\\\"]){const r=p.join(\\\\\\"/p\\\\\\",\'context\',d);let n=[];try{n=f.readdirSync(r)}catch{}for(const x of n){if(x[0]===\'.\')continue;try{const t=f.statSync(p.join(r,x));if(t.isFile()&&s>0&&t.mtimeMs>s)o.push(\'- context/\'+d+\'/\'+x)}catch{}}}f.mkdirSync(\\\\\\"/d\\\\\\",{recursive:true});f.writeFileSync(m,\'\');if(o.length)console.log(\\\\\\"New context files since your last turn — the owner just added them, read them if relevant:\\\\\\"+\'\\\\\\\\n\'+o.join(\'\\\\\\\\n\'))}catch{}\\""}]}]}}',
      ],
    )
  })
  // output style (01-11, deliberate addition): the style rides the SAME
  // --settings as theme + fence, after them — outputStyle and the style
  // plugins off. No style = the lines above, byte-identical.
  it('the console matrix with an output style', async () => {
    same(defaultConsoleCommand({ resumeId: 'r-1', theme: 'light', permissionMode: 'bypassPermissions', fence: FENCE, outputStyle: 'Explanatory' }), [
      'claude',
      '--dangerously-skip-permissions',
      '--settings',
      '{"theme":"light","permissions":{"deny":["Read(//home/u/.silos/*.json)"],"additionalDirectories":["/srv/b"]},"outputStyle":"Explanatory","enabledPlugins":{"explanatory-output-style@claude-plugins-official":false,"learning-output-style@claude-plugins-official":false}}',
      '--resume',
      'r-1',
    ])
    same(defaultConsoleCommand({ sessionId: 's-1', outputStyle: 'default' }), [
      'claude',
      '--settings',
      '{"outputStyle":"default","enabledPlugins":{"explanatory-output-style@claude-plugins-official":false,"learning-output-style@claude-plugins-official":false}}',
      '--session-id',
      's-1',
    ])
  })
  it('login command', async () => {
    same(defaultLoginCommand('acc'), { file: 'claude', args: ['auth', 'login', '--claudeai'] })
  })
})

const PROVIDERS: Array<ResolvedProvider | null> = [
  null,
  { id: 'a', kind: 'claude-account', label: 'A', configDir: null },
  { id: 'b', kind: 'claude-account', label: 'B', configDir: '/acc/b' },
  { id: 'g', kind: 'anthropic-compatible', label: 'G', baseUrl: 'https://gw.example', apiKey: 'sk-gw' },
  { id: 'h', kind: 'anthropic-compatible', label: 'H', baseUrl: 'https://gw.example', apiKey: 'sk-gw', models: ['kimi-k3', 'qwen'] },
]

describe('provider env', () => {
  it('envForProvider', async () => {
    same(
      PROVIDERS.map((p) => envForProvider(p)),
      [
        { PATH: '/usr/bin', HOME: '/home/g', ANTHROPIC_API_KEY: 'sk-inherited' },
        { PATH: '/usr/bin', HOME: '/home/g', ANTHROPIC_API_KEY: 'sk-inherited' },
        { PATH: '/usr/bin', HOME: '/home/g', CLAUDE_CONFIG_DIR: '/acc/b' },
        { PATH: '/usr/bin', HOME: '/home/g', ANTHROPIC_BASE_URL: 'https://gw.example', ANTHROPIC_AUTH_TOKEN: 'sk-gw' },
        {
          PATH: '/usr/bin',
          HOME: '/home/g',
          ANTHROPIC_BASE_URL: 'https://gw.example',
          ANTHROPIC_MODEL: 'kimi-k3',
          ANTHROPIC_SMALL_FAST_MODEL: 'kimi-k3',
          ANTHROPIC_AUTH_TOKEN: 'sk-gw',
        },
      ],
    )
  })
  it('consoleEnvForProvider', async () => {
    same(
      PROVIDERS.map((p) => consoleEnvForProvider(p)),
      [
        {},
        {},
        { CLAUDE_CONFIG_DIR: '/acc/b', ANTHROPIC_BASE_URL: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' },
        { ANTHROPIC_BASE_URL: 'https://gw.example', ANTHROPIC_AUTH_TOKEN: 'sk-gw', ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: '', ANTHROPIC_SMALL_FAST_MODEL: '' },
        {
          ANTHROPIC_BASE_URL: 'https://gw.example',
          ANTHROPIC_AUTH_TOKEN: 'sk-gw',
          ANTHROPIC_API_KEY: '',
          ANTHROPIC_MODEL: 'kimi-k3',
          ANTHROPIC_SMALL_FAST_MODEL: 'kimi-k3',
        },
      ],
    )
  })
})

// the automations rule rides the briefing alone (briefing.d/base.md) since
// 26-11 — the append carries the mission and the ask-decisions note
const APPEND =
  'Your mission: charter\n\nWhen you need a decision or missing input from the owner to continue, ask with the AskUserQuestion tool and offer clear options — do not bury the question in prose. Reserve it for real decisions.'
// the console's settings ride an owner-only file named on argv, never the
// JSON itself (D8: /proc/<pid>/cmdline): its bytes pinned here
const PLAIN_SETTINGS =
  '{"hooks":{"SessionStart":[{"matcher":"clear","hooks":[{"type":"command","command":"node -e \\"let d=\'\';process.stdin.on(\'data\',c=>d+=c).on(\'end\',()=>{try{const s=JSON.parse(d).session_id;if(typeof s===\'string\'&&/^[\\\\\\\\w-]+\\\\$/.test(s))require(\'fs\').writeFileSync(require(\'path\').join(\\\\\\"<base>/rot\\\\\\",s+\'.json\'),JSON.stringify({from:\\\\\\"golden-k\\\\\\"}))}catch{}})\\""}]}]}}'
const LAUNCHER_SETTINGS =
  '{"theme":"light","hooks":{"SessionStart":[{"matcher":"clear","hooks":[{"type":"command","command":"node -e \\"let d=\'\';process.stdin.on(\'data\',c=>d+=c).on(\'end\',()=>{try{const s=JSON.parse(d).session_id;if(typeof s===\'string\'&&/^[\\\\\\\\w-]+\\\\$/.test(s))require(\'fs\').writeFileSync(require(\'path\').join(\\\\\\"<base>/rot\\\\\\",s+\'.json\'),JSON.stringify({from:\\\\\\"golden-k\\\\\\"}))}catch{}})\\""}]}],"UserPromptSubmit":[{"hooks":[{"type":"command","command":"node -e \\"try{const f=require(\'fs\'),p=require(\'path\');const m=p.join(\\\\\\"<base>/rot\\\\\\",\\\\\\"golden-k\\\\\\"+\'.ctx\');let s=0;try{s=f.statSync(m).mtimeMs}catch{}const o=[];for(const d of [\'shared\',\\\\\\"writer\\\\\\"]){const r=p.join(\\\\\\"<base>/p\\\\\\",\'context\',d);let n=[];try{n=f.readdirSync(r)}catch{}for(const x of n){if(x[0]===\'.\')continue;try{const t=f.statSync(p.join(r,x));if(t.isFile()&&s>0&&t.mtimeMs>s)o.push(\'- context/\'+d+\'/\'+x)}catch{}}}f.mkdirSync(\\\\\\"<base>/rot\\\\\\",{recursive:true});f.writeFileSync(m,\'\');if(o.length)console.log(\\\\\\"New context files since your last turn — the owner just added them, read them if relevant:\\\\\\"+\'\\\\\\\\n\'+o.join(\'\\\\\\\\n\'))}catch{}\\""}]}]}}'
const PLAIN_ARGV = [
  '-f',
  '<tmpdir>/silos-console-tmux.conf',
  'new-session',
  '-d',
  '-s',
  'silos-golden-k',
  '-c',
  '<base>/p',
  '-x',
  '200',
  '-y',
  '50',
  '-e',
  'SILOS_CONSOLE_THEME=dark',
  'claude',
  '--settings',
  '<base>/append/golden-k.settings.json',
  '--session-id',
  'golden-k',
]
const LAUNCHER_ARGV = [
  '-f',
  '<tmpdir>/silos-console-tmux.conf',
  'new-session',
  '-d',
  '-s',
  'silos-golden-k',
  '-c',
  '<base>/p',
  '-x',
  '200',
  '-y',
  '50',
  '-e',
  'SILOS_CONSOLE_THEME=light',
  'sh',
  '-c',
  '. "$1"; rm -f -- "$1"; shift; exec "$@"',
  'silos-console',
  '<base>/env/golden-k.env',
  'claude',
  '--append-system-prompt-file',
  '<base>/append/golden-k.md',
  '--permission-mode',
  'plan',
  '--model',
  'opus',
  '--settings',
  '<base>/append/golden-k.settings.json',
  '--resume',
  'golden-k',
]
const LAUNCHER_ENV_FILE = "export CLAUDE_CONFIG_DIR='/acc/b'\nexport ANTHROPIC_API_KEY=''\n"
// The binary is never chosen by the engine: the SDK boundary (sdk.ts
// withClaudeExecutable) hands every query the `claude` on PATH — the
// consoles' own — so the engine's options never name one.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('SDK query() options', () => {
  it('a new turn, an append resume, a fenced bypass fork', async () => {
    const base = tempDir('golden-')
    const folder = join(base, 'ci')
    mkdirSync(folder)
    // capability states 01-11: the skills preamble derives from the FOLDER's
    // active skills (<folder>/.claude/skills), not from agents.json — the
    // skill is materialized on disk so the golden prompt stays byte-identical
    mkdirSync(join(folder, '.claude', 'skills', 'finance-skill'), { recursive: true })
    writeFileSync(join(folder, '.claude', 'skills', 'finance-skill', 'SKILL.md'), 'x')
    const registry = new AgentRegistry(join(base, 'agents.json'))
    registry.load()
    registry.create({ id: 'finance', name: 'FINANCE', folder, model: 'claude-sonnet-5', mission: { text: 'charter' } })
    const native = new NativeStore(join(base, 'native.json'))
    const calls: QueryArgs[] = []
    const queryFn = (args: QueryArgs): SdkQueryHandle => {
      calls.push(args)
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'result', subtype: 'success', total_cost_usd: 0 }
        },
        async interrupt() {
          return { status: 'interrupted' }
        },
      } as SdkQueryHandle
    }
    const drain = async (g: AsyncGenerator<unknown>) => {
      for await (const _ of g) void _
    }
    await drain(new ChatService({ registry, native, queryFn }).send({ turnId: 't1', agentId: 'finance', text: 'hi' }))
    await drain(
      new ChatService({ registry, native, queryFn }).send({ turnId: 't2', agentId: 'finance', text: 'more', resume: { sessionId: 'sess-1', mode: 'append' } }),
    )
    await drain(
      new ChatService({ registry, native, queryFn, territory: { fenceFor: () => FENCE } }).send({
        turnId: 't3',
        agentId: 'finance',
        text: 'fork',
        resume: { sessionId: 'sess-ext', mode: 'fork' },
        overrides: { permissionMode: 'bypassPermissions' },
      }),
    )
    // host-dependent values are asserted on their own, then masked: the born
    // id (UUID, equal to SILOS_SESSION_ID); no binary (set at the SDK boundary)
    const norm = (c: QueryArgs) => {
      const o = { ...c.options } as Record<string, any>
      expect('pathToClaudeCodeExecutable' in o).toBe(false)
      // the turn token (live-turns.ts): 128 random bits, masked
      expect(o.env.SILOS_TURN).toMatch(/^[0-9a-f]{32}$/)
      o.env = { ...o.env, SILOS_TURN: '<turn>' }
      if (o.sessionId !== undefined) {
        expect(o.sessionId).toMatch(UUID)
        expect(o.env.SILOS_SESSION_ID).toBe(o.sessionId)
        o.sessionId = '<uuid>'
        o.env = { ...o.env, SILOS_SESSION_ID: '<uuid>' }
      }
      return { prompt: c.prompt, options: o }
    }
    const head = { cwd: folder }
    const common = {
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      settingSources: ['user', 'project', 'local'],
    }
    // the skill line rides the append, never the owner's prompt (07-11)
    // 21-11 (deliberate): a turn with hooks carries the static briefing after
    // its own append (no fragment skill in the folder: every .without) and
    // says so with SILOS_BRIEFING — its SessionStart hook sends only roster
    // and inbox, so the hook stays under Claude Code's 10,000-character cap
    const sys = {
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: `${APPEND}\n\n${briefingText([])}\n\nYour skills for this session include /finance-skill — load them when the task calls for them.`,
      },
    }
    same(calls.map(norm), [
      {
        prompt: 'hi',
        options: {
          ...head,
          ...common,
          ...sys,
          env: {
            PATH: '/usr/bin',
            HOME: '/home/g',
            ANTHROPIC_API_KEY: 'sk-inherited',
            SILOS_API: 'http://127.0.0.1:3210',
            SILOS_SESSION_ID: '<uuid>',
            SILOS_TURN: '<turn>',
            SILOS_BRIEFING: 'system-prompt',
          },
          model: 'claude-sonnet-5',
          sessionId: '<uuid>',
        },
      },
      {
        prompt: 'more',
        options: {
          ...head,
          ...common,
          ...sys,
          env: {
            PATH: '/usr/bin',
            HOME: '/home/g',
            ANTHROPIC_API_KEY: 'sk-inherited',
            SILOS_API: 'http://127.0.0.1:3210',
            SILOS_SESSION_ID: 'sess-1',
            SILOS_TURN: '<turn>',
            SILOS_BRIEFING: 'system-prompt',
          },
          model: 'claude-sonnet-5',
          resume: 'sess-1',
        },
      },
      {
        prompt: 'fork',
        options: {
          ...head,
          ...common,
          settings: { permissions: { deny: ['Read(//home/u/.silos/*.json)'], additionalDirectories: ['/srv/b'] } },
          additionalDirectories: ['/srv/b'],
          ...sys,
          env: {
            PATH: '/usr/bin',
            HOME: '/home/g',
            ANTHROPIC_API_KEY: 'sk-inherited',
            SILOS_API: 'http://127.0.0.1:3210',
            SILOS_SESSION_ID: '<uuid>',
            SILOS_TURN: '<turn>',
            SILOS_BRIEFING: 'system-prompt',
          },
          model: 'claude-sonnet-5',
          resume: 'sess-ext',
          forkSession: true,
          sessionId: '<uuid>',
        },
      },
    ])
  })
})

describe('SDK query() options with an output style (01-11, deliberate addition)', () => {
  it('the agent default rides settings after the fence; a conversation pin overrides it', async () => {
    const base = tempDir('golden-style-')
    const folder = join(base, 'ci')
    mkdirSync(folder)
    const registry = new AgentRegistry(join(base, 'agents.json'))
    registry.load()
    registry.create({ id: 'finance', name: 'FINANCE', folder, outputStyle: 'Explanatory' })
    const native = new NativeStore(join(base, 'native.json'))
    const calls: QueryArgs[] = []
    const queryFn = (args: QueryArgs): SdkQueryHandle => {
      calls.push(args)
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'result', subtype: 'success', total_cost_usd: 0 }
        },
        async interrupt() {
          return { status: 'interrupted' }
        },
      } as SdkQueryHandle
    }
    const drain = async (g: AsyncGenerator<unknown>) => {
      for await (const _ of g) void _
    }
    const convPrefs = { get: (_f: string, id: string) => (id === 'pinned' ? { outputStyle: 'default' } : null) } as never
    await drain(new ChatService({ registry, native, queryFn, territory: { fenceFor: () => FENCE } }).send({ turnId: 't1', agentId: 'finance', text: 'hi' }))
    await drain(
      new ChatService({ registry, native, queryFn, convPrefs }).send({
        turnId: 't2',
        agentId: 'finance',
        text: 'more',
        resume: { sessionId: 'pinned', mode: 'append' },
      }),
    )
    const off = { 'explanatory-output-style@claude-plugins-official': false, 'learning-output-style@claude-plugins-official': false }
    same(
      calls.map((c) => (c.options as Record<string, unknown>).settings),
      [
        { permissions: { deny: ['Read(//home/u/.silos/*.json)'], additionalDirectories: ['/srv/b'] }, outputStyle: 'Explanatory', enabledPlugins: off },
        { outputStyle: 'default', enabledPlugins: off },
      ],
    )
  })
})

describe('ensureConsole default Claude launch', () => {
  // tmux is stubbed (nothing spawns): the WHOLE new-session argv and its env
  // are pinned, with the host-dependent parts (the temp base, the tmpdir'd
  // tmux.conf) replaced by placeholders.
  const socket = `silos-golden-${process.pid}`
  const launch = async (input: Record<string, unknown>) => {
    const base = tempDir('golden-console-')
    const cwd = join(base, 'p')
    mkdirSync(cwd)
    mkdirSync(join(base, 'projects'))
    const registry = new AgentRegistry(join(base, 'agents.json'))
    registry.load()
    registry.create({ id: 'writer', name: 'Writer', folder: cwd })
    const index = claudeSessionIndex(join(base, 'projects'), join(base, 'cache.json'))
    await index.init()
    const svc = new TerminalService(registry, index, 30 * 60_000, 60_000, {
      tmuxSocket: socket,
      envDir: join(base, 'env'),
      appendDir: join(base, 'append'),
      rotationsDir: join(base, 'rot'),
    })
    const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = []
    ;(svc as unknown as { tmux: (args: string[], env?: NodeJS.ProcessEnv) => void }).tmux = (args, env) => {
      calls.push({ args, env })
    }
    try {
      await svc.ensureConsole({ cwd, key: 'golden-k', ...input })
      const { args, env } = calls.find((c) => c.args.includes('new-session'))!
      const mask = (a: string) => a.split(base).join('<base>').split(tmpdir()).join('<tmpdir>')
      const envFile = join(base, 'env', 'golden-k.env')
      const settingsFile = join(base, 'append', 'golden-k.settings.json')
      return {
        args: args.map(mask),
        env,
        envFile: existsSync(envFile) ? readFileSync(envFile, 'utf8') : null,
        settings: existsSync(settingsFile) ? mask(readFileSync(settingsFile, 'utf8')) : null,
        settingsMode: existsSync(settingsFile) ? statSync(settingsFile).mode & 0o777 : null,
      }
    } finally {
      svc.killAll()
      svc.stopReaper()
      try {
        execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' })
      } catch {
        /* no server */
      }
      try {
        rmSync(join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid?.() ?? 0}`, socket), { force: true })
      } catch {
        /* best effort */
      }
    }
  }
  // HOME is overwritten in place by homedir() (key position kept from cleanEnv)
  const ENV = () => ({
    PATH: '/usr/bin',
    HOME: homedir(),
    ANTHROPIC_API_KEY: 'sk-inherited',
    TERM: 'xterm-256color',
    CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
  })

  it('a new console: env key order cleanEnv(), TERM, HOME, CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN; the whole argv', async () => {
    const r = await launch({ sessionId: 'golden-k' })
    same(r.env, ENV())
    same(r.args, PLAIN_ARGV)
    expect(r.envFile).toBeNull()
    expect(r.settings).toBe(PLAIN_SETTINGS)
    expect(r.settingsMode).toBe(0o600)
  })

  it('a resumed console with append, agent, theme, mode, model and a provider delta: the env-file launcher before claude', async () => {
    const r = await launch({
      resumeId: 'golden-k',
      append: 'charter',
      agentId: 'writer',
      theme: 'light',
      permissionMode: 'plan',
      model: 'opus',
      extraEnv: { CLAUDE_CONFIG_DIR: '/acc/b', ANTHROPIC_API_KEY: '' },
    })
    same(r.env, ENV())
    same(r.args, LAUNCHER_ARGV)
    expect(r.envFile).toBe(LAUNCHER_ENV_FILE)
    expect(r.settings).toBe(LAUNCHER_SETTINGS)
    expect(r.settingsMode).toBe(0o600)
  })
})
