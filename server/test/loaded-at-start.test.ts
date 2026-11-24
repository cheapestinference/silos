// loaded-at-start.test.ts — what every session of an agent receives before
// its first message (Knows & can › Loaded at start), read from disk by the
// engine's own reader. Pure parsers first, then the Claude Code reader over a
// fake home (every variant: missing files, disabled plugin, malformed JSON,
// symlink loops, caps, imports), then OpenCode's.
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SUBFOLDER_DEPTH,
  SUBFOLDER_MAX_FILES,
  injectedText,
  matcherWords,
  observedStarts,
  parseImports,
  readClaudeLoadedAtStart,
  resolveImport,
  sessionStartHooks,
} from '../src/harnesses/claude-code/loaded-at-start.js'
import { opencodeMcpNames, readOpencodeLoadedAtStart } from '../src/harnesses/opencode/loaded-at-start.js'
import { opencodeLoadsInventory } from '../src/harnesses/opencode/loads.js'
import { pluginResolver } from '../src/plugin-enablement.js'
import type { Agent } from '../src/types.js'
import type { InstructionRow, InstructionsInput, LoadedAtStartInput } from '../src/harnesses/contract.js'
import { claudeInstructions, launchesReading, readClaudeInstruction } from '../src/harnesses/claude-code/instructions.js'
import { opencodeInstructions, readOpencodeInstruction } from '../src/harnesses/opencode/instructions.js'
import { mungePath } from '../src/agent-registry.js'

const write = (path: string, text: string): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}
const json = (path: string, v: unknown): void => write(path, JSON.stringify(v))

function fixture(): {
  home: string
  folder: string
  silos: string
  input: (over?: Partial<LoadedAtStartInput>) => LoadedAtStartInput
  paths: { managedSettings: string; silosPlugin: string }
} {
  const base = mkdtempSync(join(tmpdir(), 'loaded-'))
  const home = join(base, 'home')
  const folder = join(home, 'work', 'proj')
  const silos = join(base, 'silos', 'plugin')
  mkdirSync(folder, { recursive: true })
  mkdirSync(join(home, '.claude'), { recursive: true })
  return {
    home,
    folder,
    silos,
    input: (over = {}) => ({ agent: { id: 'finance' } as Agent, folder, home, agentStateDir: null, recentTranscripts: [], seenMcpServers: [], ...over }),
    paths: { managedSettings: join(base, 'managed-settings.json'), silosPlugin: silos },
  }
}

function plugin(home: string, key: string, files: { hooks?: unknown; mcp?: unknown; manifest?: unknown }): string {
  const [name, mkt] = key.split('@') as [string, string]
  const dir = join(home, '.claude', 'plugins', 'cache', mkt, name, '1.0.0')
  json(join(dir, '.claude-plugin', 'plugin.json'), files.manifest ?? { name })
  if (files.hooks !== undefined) json(join(dir, 'hooks', 'hooks.json'), { hooks: files.hooks })
  if (files.mcp !== undefined) json(join(dir, '.mcp.json'), { mcpServers: files.mcp })
  return dir
}
function installed(home: string, entries: Record<string, string>): void {
  json(join(home, '.claude', 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: Object.fromEntries(Object.entries(entries).map(([k, dir]) => [k, [{ scope: 'user', installPath: dir }]])),
  })
}
const startHook = (command: string, matcher?: string) => ({ SessionStart: [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command }] }] })
const record = (command: string, stdout: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'attachment',
    timestamp: '2026-10-31T09:51:28.165Z',
    attachment: { type: 'hook_success', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', stdout, exitCode: 0, command, ...extra },
  })
const ctxJson = (text: string): string => JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })

describe('parseImports', () => {
  it('reads @path words: relative, home, absolute, bare', () => {
    expect(parseImports('See @docs/a.md and @~/notes.md\n@/abs/b.md\n@README')).toEqual(['docs/a.md', '~/notes.md', '/abs/b.md', 'README'])
  })
  it('skips fenced blocks, inline code and emails; trims trailing punctuation; no duplicates', () => {
    const text = 'mail me at x@y.com\n```\n@inside/fence.md\n```\nuse `@inline.md` or @real.md, then @real.md.'
    expect(parseImports(text)).toEqual(['real.md'])
  })
  it('a tilde fence counts too', () => {
    expect(parseImports('~~~\n@a.md\n~~~\n@b.md')).toEqual(['b.md'])
  })
  it('resolves against the importing file, ~ against home', () => {
    expect(resolveImport('a.md', '/p/sub/CLAUDE.md', '/h')).toBe('/p/sub/a.md')
    expect(resolveImport('~/x.md', '/p/CLAUDE.md', '/h')).toBe('/h/x.md')
    expect(resolveImport('/abs.md', '/p/CLAUDE.md', '/h')).toBe('/abs.md')
  })
})

describe('matcherWords / sessionStartHooks / injectedText', () => {
  it('a matcher in words; absent, empty or * = every start', () => {
    expect(matcherWords('startup|resume| clear')).toEqual(['startup', 'resume', 'clear'])
    expect(matcherWords(undefined)).toEqual([])
    expect(matcherWords('')).toEqual([])
    expect(matcherWords('*')).toEqual([])
  })
  it('one row per inner hook; args joined as the transcript records them; malformed entries skipped', () => {
    const map = {
      SessionStart: [
        {
          matcher: 'startup',
          hooks: [
            { type: 'command', command: 'node', args: ['x.mjs', 7] },
            { type: 'command', command: 'b.sh' },
          ],
        },
        { hooks: [{ type: 'prompt', prompt: 'hi' }] },
        { hooks: 'nope' },
        null,
        'x',
      ],
      PreToolUse: [{ hooks: [{ type: 'command', command: 'pre.sh' }] }],
    }
    expect(sessionStartHooks(map)).toEqual([
      { on: ['startup'], command: 'node x.mjs' },
      { on: ['startup'], command: 'b.sh' },
      { on: [], command: '(prompt hook)' },
    ])
    expect(sessionStartHooks(null)).toEqual([])
    expect(sessionStartHooks({ SessionStart: {} })).toEqual([])
  })
  it('the context a stdout adds: additionalContext JSON, else the plain text', () => {
    expect(injectedText(ctxJson('hello'))).toBe('hello')
    expect(injectedText('  plain words \n')).toBe('plain words')
    expect(injectedText('{"other":1}')).toBe('')
    expect(injectedText('{not json')).toBe('{not json')
  })
})

describe('observedStarts', () => {
  it('the last record of a command wins; failures flagged; junk lines ignored', () => {
    const lines = [
      'not json SessionStart',
      record('a.sh', ctxJson('first')),
      record('a.sh', ctxJson('second, longer')),
      record('b.sh', '', { type: 'hook_error', exitCode: 1 }),
      record('c.sh', 'plain', { exitCode: 2 }),
      JSON.stringify({ type: 'attachment', attachment: { type: 'hook_success', hookEvent: 'PreToolUse', command: 'd.sh', stdout: 'x' } }),
    ]
    const obs = observedStarts(lines)
    expect(obs.get('a.sh')).toMatchObject({ chars: 14, excerpt: 'second, longer' })
    expect(obs.get('a.sh')?.failed).toBeUndefined()
    expect(obs.get('b.sh')).toMatchObject({ chars: 0, failed: true })
    expect(obs.get('c.sh')).toMatchObject({ chars: 5, failed: true })
    expect(obs.has('d.sh')).toBe(false)
    expect(obs.get('a.sh')?.at).toBe(Date.parse('2026-10-31T09:51:28.165Z'))
  })
  it('an excerpt is whitespace-collapsed and capped', () => {
    const long = 'word '.repeat(100)
    const o = observedStarts([record('a.sh', ctxJson(long))]).get('a.sh')!
    expect(o.chars).toBe(long.length)
    expect(o.excerpt.length).toBe(160)
    expect(o.excerpt.endsWith('…')).toBe(true)
  })
})

describe('readClaudeLoadedAtStart — instruction files', () => {
  it('an empty home and folder: nothing listed, nothing thrown', () => {
    const f = fixture()
    const r = readClaudeLoadedAtStart(f.input(), f.paths)
    expect(r).toMatchObject({ engine: 'Claude Code', instructions: [], injections: [], outputStyle: null })
    expect(r.mcp).toEqual([])
  })

  it('local, .claude/CLAUDE.md and parent files at start; the memory layers are not listed again', () => {
    const f = fixture()
    write(join(f.folder, 'CLAUDE.md'), '# project')
    write(join(f.home, '.claude', 'CLAUDE.md'), '# global')
    write(join(f.folder, 'CLAUDE.local.md'), 'mine')
    write(join(f.folder, '.claude', 'CLAUDE.md'), 'dot')
    write(join(f.home, 'work', 'CLAUDE.md'), 'parent')
    write(join(f.home, 'CLAUDE.local.md'), 'home local')
    const r = readClaudeLoadedAtStart(f.input(), f.paths)
    const rows = r.instructions.map((i) => [i.kind, i.when, i.rel, i.bytes])
    expect(rows).toEqual([
      ['local', 'start', 'CLAUDE.local.md', 4],
      ['project', 'start', '.claude/CLAUDE.md', 3],
      ['parent', 'start', '~/work/CLAUDE.md', 6],
      ['parent', 'start', '~/CLAUDE.local.md', 10],
    ])
  })

  it('AGENTS.md is listed in place of CLAUDE.md — only where no CLAUDE.md sits beside it', () => {
    const f = fixture()
    // the folder has AGENTS.md and NO CLAUDE.md: the engine reads it in its
    // place (docs «memory»), so At start names it
    write(join(f.folder, 'AGENTS.md'), '# agents')
    write(join(f.home, 'work', 'AGENTS.md'), 'parent agents')
    const r = readClaudeLoadedAtStart(f.input(), f.paths)
    expect(r.instructions.map((i) => [i.kind, i.rel])).toEqual([
      ['project', 'AGENTS.md'],
      ['parent', '~/work/AGENTS.md'],
    ])
    // with a CLAUDE.md beside it, the substitution never applies (an
    // @AGENTS.md import is the way it gets listed then)
    write(join(f.folder, 'CLAUDE.md'), '# project')
    write(join(f.home, 'work', 'CLAUDE.md'), 'parent')
    const r2 = readClaudeLoadedAtStart(f.input(), f.paths)
    expect(r2.instructions.some((i) => i.rel.endsWith('AGENTS.md'))).toBe(false)
  })

  it('subfolder CLAUDE.md on demand, under its folder; dot-dirs and node_modules skipped; symlink loops never followed', () => {
    const f = fixture()
    write(join(f.folder, 'src', 'CLAUDE.md'), 'src')
    write(join(f.folder, 'src', 'services', 'CLAUDE.md'), 'svc')
    write(join(f.folder, 'node_modules', 'pkg', 'CLAUDE.md'), 'no')
    write(join(f.folder, '.git', 'CLAUDE.md'), 'no')
    symlinkSync(f.folder, join(f.folder, 'src', 'loop'))
    symlinkSync(join(f.folder, 'src'), join(f.folder, 'linked'))
    const r = readClaudeLoadedAtStart(f.input(), f.paths)
    expect(r.instructions.map((i) => [i.kind, i.when, i.rel, i.under])).toEqual([
      ['subfolder', 'on-demand', 'src/CLAUDE.md', 'src/'],
      ['subfolder', 'on-demand', 'src/services/CLAUDE.md', 'src/services/'],
    ])
    expect(r.notes.some((n) => n.startsWith('Subfolders read up to'))).toBe(false)
  })

  it('the walk stops at its depth and file caps, and says so', () => {
    const f = fixture()
    let deep = f.folder
    for (let i = 0; i < SUBFOLDER_DEPTH + 2; i++) {
      deep = join(deep, `d${i}`)
      write(join(deep, 'CLAUDE.md'), 'x')
    }
    const r = readClaudeLoadedAtStart(f.input(), f.paths)
    expect(r.instructions.filter((i) => i.kind === 'subfolder')).toHaveLength(SUBFOLDER_DEPTH)

    const g = fixture()
    for (let i = 0; i < SUBFOLDER_MAX_FILES + 5; i++) write(join(g.folder, `m${String(i).padStart(3, '0')}`, 'CLAUDE.md'), 'x')
    const r2 = readClaudeLoadedAtStart(g.input(), g.paths)
    expect(r2.instructions.filter((i) => i.kind === 'subfolder')).toHaveLength(SUBFOLDER_MAX_FILES)
    expect(r2.notes.some((n) => n.startsWith('Subfolders read up to'))).toBe(true)
  })

  it('@imports: only files that exist, from the memory layers too, transitive, cycle-safe, inheriting on-demand', () => {
    const f = fixture()
    write(join(f.folder, 'CLAUDE.md'), 'Read @docs/a.md and ask @finance about it.')
    write(join(f.folder, 'docs', 'a.md'), 'then @b.md')
    write(join(f.folder, 'docs', 'b.md'), 'back to @a.md and @../CLAUDE.md')
    write(join(f.home, '.claude', 'CLAUDE.md'), '@~/personal.md')
    write(join(f.home, 'personal.md'), 'p')
    write(join(f.folder, 'src', 'CLAUDE.md'), '@local-note.md')
    write(join(f.folder, 'src', 'local-note.md'), 'n')
    const r = readClaudeLoadedAtStart(f.input(), f.paths)
    const imports = r.instructions.filter((i) => i.kind === 'import').map((i) => [i.rel, i.importedBy, i.when, i.under])
    expect(imports).toEqual([
      ['~/personal.md', '~/.claude/CLAUDE.md', 'start', undefined],
      ['docs/a.md', 'CLAUDE.md', 'start', undefined],
      ['src/local-note.md', 'src/CLAUDE.md', 'on-demand', 'src/'],
      ['docs/b.md', 'docs/a.md', 'start', undefined],
    ])
  })

  it('imports stop after five hops', () => {
    const f = fixture()
    write(join(f.folder, 'CLAUDE.md'), '@i1.md')
    for (let i = 1; i <= 7; i++) write(join(f.folder, `i${i}.md`), `@i${i + 1}.md`)
    const r = readClaudeLoadedAtStart(f.input(), f.paths)
    expect(r.instructions.map((i) => i.rel)).toEqual(['i1.md', 'i2.md', 'i3.md', 'i4.md', 'i5.md'])
  })

  it('.claude/rules: unconditional at start, `paths:` frontmatter on demand', () => {
    const f = fixture()
    write(join(f.folder, '.claude', 'rules', 'style.md'), '# always')
    write(join(f.folder, '.claude', 'rules', 'api', 'routes.md'), '---\npaths: "src/routes/**"\n---\n# when touching routes')
    const r = readClaudeLoadedAtStart(f.input(), f.paths)
    expect(r.instructions.map((i) => [i.kind, i.when, i.rel, i.under])).toEqual([
      ['rules', 'on-demand', '.claude/rules/api/routes.md', 'src/routes/**'],
      ['rules', 'start', '.claude/rules/style.md', undefined],
    ])
  })
})

describe('readClaudeLoadedAtStart — start hooks', () => {
  it('user settings, project settings and ENABLED plugins; a disabled one adds nothing; the folder can hold one off', () => {
    const f = fixture()
    json(join(f.home, '.claude', 'settings.json'), {
      hooks: startHook('/u/start.sh', 'startup|clear'),
      enabledPlugins: { 'on@m': true, 'off@m': false, 'held@m': true, 'style-output-style@m': true },
    })
    json(join(f.folder, '.claude', 'settings.json'), { hooks: startHook('proj.sh') })
    json(join(f.folder, '.claude', 'settings.local.json'), { enabledPlugins: { 'held@m': false } })
    installed(f.home, {
      'on@m': plugin(f.home, 'on@m', { hooks: startHook('on.sh') }),
      'off@m': plugin(f.home, 'off@m', { hooks: startHook('off.sh') }),
      'held@m': plugin(f.home, 'held@m', { hooks: startHook('held.sh') }),
      'style-output-style@m': plugin(f.home, 'style-output-style@m', { hooks: startHook('style.sh') }),
      'ghost@m': '/nowhere',
    })
    const r = readClaudeLoadedAtStart(f.input(), f.paths)
    expect(r.injections.map((i) => [i.origin, i.name, i.on, i.command, i.outputStyle ?? null])).toEqual([
      ['user', '~/.claude/settings.json', ['startup', 'clear'], '/u/start.sh', null],
      ['project', '.claude/settings.json', [], 'proj.sh', null],
      ['plugin', 'on', [], 'on.sh', null],
      ['plugin', 'style-output-style', [], 'style.sh', true],
    ])
  })

  it("Silos' own briefing is named as Silos', wherever the repo lives", () => {
    const f = fixture()
    json(join(f.home, '.claude', 'settings.json'), {
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: 'command', command: join(f.silos, 'hooks', 'session-start.sh') },
              { type: 'command', command: '/elsewhere/silos/plugin/hooks/session-start.sh' },
            ],
          },
        ],
      },
    })
    const r = readClaudeLoadedAtStart(f.input(), f.paths)
    expect(r.injections.map((i) => [i.origin, i.name])).toEqual([
      ['silos', 'Silos briefing'],
      ['silos', 'Silos briefing'],
    ])
  })

  it('malformed JSON anywhere reads as nothing, never a throw', () => {
    const f = fixture()
    write(join(f.home, '.claude', 'settings.json'), '{ nope')
    write(join(f.folder, '.claude', 'settings.json'), '[1,2]')
    write(join(f.home, '.claude', 'plugins', 'installed_plugins.json'), 'garbage')
    write(join(f.home, '.claude.json'), '{')
    write(join(f.folder, '.mcp.json'), 'x')
    const r = readClaudeLoadedAtStart(f.input(), f.paths)
    expect(r.injections).toEqual([])
    expect(r.mcp).toEqual([])
  })

  it('a plugin manifest can point its hooks elsewhere or inline them', () => {
    const f = fixture()
    json(join(f.home, '.claude', 'settings.json'), { enabledPlugins: { 'a@m': true, 'b@m': true } })
    const a = plugin(f.home, 'a@m', { manifest: { name: 'a', hooks: './custom/h.json' } })
    json(join(a, 'custom', 'h.json'), { hooks: startHook('a.sh') })
    const b = plugin(f.home, 'b@m', { manifest: { name: 'b', hooks: startHook('b.sh') } })
    installed(f.home, { 'a@m': a, 'b@m': b })
    const r = readClaudeLoadedAtStart(f.input(), f.paths)
    expect(r.injections.map((i) => [i.name, i.command])).toEqual([
      ['a', 'a.sh'],
      ['b', 'b.sh'],
    ])
  })

  it('what each hook added, from the newest transcript that recorded it; a shared command is attributed to neither', () => {
    const f = fixture()
    json(join(f.home, '.claude', 'settings.json'), {
      hooks: startHook('/u/start.sh'),
      enabledPlugins: { 'x-output-style@m': true, 'y-output-style@m': true },
    })
    const same = 'bash "${CLAUDE_PLUGIN_ROOT}/hooks-handlers/session-start.sh"'
    installed(f.home, {
      'x-output-style@m': plugin(f.home, 'x-output-style@m', { hooks: startHook(same) }),
      'y-output-style@m': plugin(f.home, 'y-output-style@m', { hooks: startHook(same) }),
    })
    const newer = join(f.home, 'newer.jsonl')
    const older = join(f.home, 'older.jsonl')
    write(newer, `${record('/u/start.sh', ctxJson('new briefing'))}\n${record(same, ctxJson('style'))}\n`)
    write(older, `${record('/u/start.sh', ctxJson('old'))}\n`)
    const r = readClaudeLoadedAtStart(f.input({ recentTranscripts: [newer, older, join(f.home, 'missing.jsonl')] }), f.paths)
    expect(r.injections[0]!.seen).toMatchObject({ chars: 12, excerpt: 'new briefing' })
    expect(r.injections[1]!.seen).toBeUndefined()
    expect(r.injections[2]!.seen).toBeUndefined()
    expect(r.notes).toContain('Automation runs start without these hooks, unless an automation is set to inherit them.')
  })

  it('a fresh-start hook absent from every start that recorded others prints nothing (unseenIn); a resume-only one or no evidence says nothing', () => {
    const f = fixture()
    json(join(f.home, '.claude', 'settings.json'), {
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: 'command', command: '/u/talks.sh' },
              { type: 'command', command: '/u/async.sh' },
            ],
          },
          { matcher: 'resume', hooks: [{ type: 'command', command: '/u/resume.sh' }] },
        ],
      },
    })
    const a = join(f.home, 'a.jsonl')
    const b = join(f.home, 'b.jsonl')
    const empty = join(f.home, 'empty.jsonl')
    write(a, `${record('/u/talks.sh', ctxJson('hi'))}\n`)
    write(b, `${record('/u/talks.sh', ctxJson('hello'))}\n`)
    write(empty, '{}\n')
    const r = readClaudeLoadedAtStart(f.input({ recentTranscripts: [a, b, empty] }), f.paths)
    const by = (c: string) => r.injections.find((i) => i.command === c)!
    expect(by('/u/talks.sh').unseenIn).toBeUndefined()
    expect(by('/u/async.sh').unseenIn).toBe(2)
    expect(by('/u/resume.sh').unseenIn).toBeUndefined()
    const none = readClaudeLoadedAtStart(f.input({ recentTranscripts: [empty] }), f.paths)
    expect(none.injections.every((i) => i.unseenIn === undefined)).toBe(true)
  })

  it('disableAllHooks: no injection, said', () => {
    const f = fixture()
    json(join(f.home, '.claude', 'settings.json'), { hooks: startHook('a.sh') })
    json(join(f.folder, '.claude', 'settings.local.json'), { disableAllHooks: true })
    const r = readClaudeLoadedAtStart(f.input(), f.paths)
    expect(r.injections).toEqual([])
    expect(r.notes).toContain('disableAllHooks is set — no start hook runs.')
  })
})

describe('readClaudeLoadedAtStart — output style and MCP', () => {
  it("the agent's cockpit style outranks the files and switches the official style plugins off — said, never shown as active", () => {
    const f = fixture()
    json(join(f.home, '.claude', 'settings.json'), {
      outputStyle: 'Learning',
      enabledPlugins: { 'explanatory-output-style@claude-plugins-official': true, 'my-output-style@m': true },
    })
    installed(f.home, {
      'explanatory-output-style@claude-plugins-official': plugin(f.home, 'explanatory-output-style@claude-plugins-official', { hooks: startHook('exp.sh') }),
      'my-output-style@m': plugin(f.home, 'my-output-style@m', { hooks: startHook('mine.sh') }),
    })
    const plain = readClaudeLoadedAtStart(f.input(), f.paths)
    expect(plain.outputStyle).toEqual({ name: 'Learning', from: '~/.claude/settings.json' })
    expect(plain.injections.some((i) => i.offBySilos)).toBe(false)
    const base = f.input()
    const styled = readClaudeLoadedAtStart({ ...base, agent: { ...base.agent, outputStyle: 'default' } }, f.paths)
    expect(styled.outputStyle).toEqual({ name: 'default', from: "Silos — the agent's default", silos: true })
    // only the plugins Silos really turns off (output-styles.ts OUTPUT_STYLE_PLUGINS)
    expect(styled.injections.map((i) => [i.name, i.offBySilos ?? null])).toEqual([
      ['explanatory-output-style', true],
      ['my-output-style', null],
    ])
  })

  it('the output style of the highest layer that sets one', () => {
    const f = fixture()
    json(join(f.home, '.claude', 'settings.json'), { outputStyle: 'Explanatory' })
    expect(readClaudeLoadedAtStart(f.input(), f.paths).outputStyle).toEqual({ name: 'Explanatory', from: '~/.claude/settings.json' })
    json(join(f.folder, '.claude', 'settings.local.json'), { outputStyle: 'Learning' })
    expect(readClaudeLoadedAtStart(f.input(), f.paths).outputStyle).toEqual({ name: 'Learning', from: '.claude/settings.local.json' })
    json(join(f.folder, '.claude', 'settings.local.json'), { outputStyle: null })
    expect(readClaudeLoadedAtStart(f.input(), f.paths).outputStyle?.name).toBe('Explanatory')
  })

  it("the operator's servers, the folder's minus its disable lists, enabled plugins', and account connectors only as seen", () => {
    const f = fixture()
    json(join(f.home, '.claude.json'), {
      mcpServers: { everywhere: { command: 'x' } },
      projects: {
        [f.folder]: { mcpServers: { railway: { type: 'http' }, notion: {}, gone: {} }, disabledMcpServers: ['gone'] },
        '/other': { mcpServers: { nope: {} } },
      },
    })
    json(join(f.folder, '.mcp.json'), { mcpServers: { repo: {}, heldrepo: {} } })
    json(join(f.folder, '.claude', 'settings.local.json'), { disabledMcpjsonServers: ['heldrepo'] })
    json(join(f.home, '.claude', 'settings.json'), { enabledPlugins: { 'p@m': true, 'q@m': false } })
    installed(f.home, { 'p@m': plugin(f.home, 'p@m', { mcp: { search: {} } }), 'q@m': plugin(f.home, 'q@m', { mcp: { hidden: {} } }) })
    const r = readClaudeLoadedAtStart(f.input({ seenMcpServers: ['claude_ai_Google_Calendar', 'claude_ai_ledgerly', 'railway', 'plugin_p_search'] }), f.paths)
    expect(r.mcp).toEqual([
      { name: 'everywhere', source: 'user', from: '~/.claude.json' },
      // the operator's own entry for this folder: your machine's, as the inventory places it
      { name: 'notion', source: 'user', from: '~/.claude.json · this folder' },
      { name: 'railway', source: 'user', from: '~/.claude.json · this folder' },
      { name: 'repo', source: 'project', from: '.mcp.json' },
      // an entry with no address is a placeholder (by structure)
      { name: 'search', source: 'plugin', from: 'p', engineName: 'plugin:p:search', placeholder: true },
      // a connector known only by its tool-name id keeps that id: never turned back
      { name: 'claude_ai_Google_Calendar', source: 'account', from: 'claude.ai' },
      { name: 'claude_ai_ledgerly', source: 'account', from: 'claude.ai' },
    ])
  })
})

describe('readClaudeLoadedAtStart — every plugin that loads, under its real owner', () => {
  const ORG = '00000000-0000-4000-8000-00000000000a'
  const ACC = '00000000-0000-4000-8000-00000000000b'
  const OTHER = '00000000-0000-4000-8000-00000000000c'
  const synced = (home: string, account: string, folder: string, manifest: Record<string, unknown>, files: { hooks?: unknown; mcp?: unknown } = {}): string => {
    const dir = join(home, '.claude', 'plugins', 'synced', `${ORG}_${account}`, folder)
    json(join(dir, '.claude-plugin', 'plugin.json'), manifest)
    if (files.hooks !== undefined) json(join(dir, 'hooks', 'hooks.json'), { hooks: files.hooks })
    if (files.mcp !== undefined) json(join(dir, '.mcp.json'), { mcpServers: files.mcp })
    return dir
  }
  // a start that recorded its login: the session-owner record and the email
  const started = (home: string, account: string, email = 'sam@example.com'): string => {
    const path = join(home, 'transcripts', `${account}.jsonl`)
    write(
      path,
      [
        JSON.stringify({
          type: 'attachment',
          attachment: { type: 'session_context', context: { userEmail: `The user's email address is ${email}. Use it only to identify the user.` } },
        }),
        JSON.stringify({ type: 'session-owner', accountUuid: account, organizationUuid: ORG, sessionId: 's1' }),
      ].join('\n') + '\n',
    )
    return path
  }

  it('a plugin no settings file mentions loads — its hooks and its servers', () => {
    const f = fixture()
    installed(f.home, { 'quiet@m': plugin(f.home, 'quiet@m', { hooks: startHook('quiet.sh'), mcp: { tracker: { command: 'node' } } }) })
    const r = readClaudeLoadedAtStart(f.input(), f.paths)
    expect(r.injections.map((i) => [i.origin, i.name, i.command])).toEqual([['plugin', 'quiet', 'quiet.sh']])
    expect(r.mcp).toEqual([{ name: 'tracker', source: 'plugin', from: 'quiet', engineName: 'plugin:quiet:tracker' }])
  })

  it("an account plugin is the account's: its login, its hooks, its servers (placeholders and one address said)", () => {
    const f = fixture()
    synced(
      f.home,
      ACC,
      '00000000-0000-4000-8000-0000000000f1~g2',
      { name: 'design' },
      {
        hooks: startHook('design.sh'),
        mcp: { slack: { type: 'http', url: 'https://mcp.example.com/slack' }, gmail: { type: 'http', url: '' } },
      },
    )
    synced(f.home, ACC, '00000000-0000-4000-8000-0000000000f1', { name: 'design' }, { hooks: startHook('stale.sh') })
    synced(f.home, ACC, 'engineering~g2', { name: 'engineering' }, { mcp: { slack: { type: 'http', url: 'https://mcp.example.com/slack' } } })
    // another login's batch: not this agent's
    synced(f.home, OTHER, 'finance~g1', { name: 'finance' }, { hooks: startHook('finance.sh') })
    const r = readClaudeLoadedAtStart(f.input({ recentTranscripts: [started(f.home, ACC)] }), f.paths)
    expect(r.injections.map((i) => [i.origin, i.name, i.command, i.account])).toEqual([['plugin', 'design', 'design.sh', { login: 'sam@example.com' }]])
    expect(r.mcp).toEqual([
      { name: 'gmail', source: 'plugin', from: 'design', engineName: 'plugin:design:gmail', account: { login: 'sam@example.com' }, placeholder: true },
      { name: 'slack', source: 'plugin', from: 'design', engineName: 'plugin:design:slack', account: { login: 'sam@example.com' } },
      {
        name: 'slack',
        source: 'plugin',
        from: 'engineering',
        engineName: 'plugin:engineering:slack',
        account: { login: 'sam@example.com' },
        sameAs: 'plugin:design:slack',
      },
    ])
  })

  it('a batch no start matched: by elimination when it is the only one, else not listed and said', () => {
    const f = fixture()
    synced(f.home, ACC, 'design~g1', { name: 'design' }, { mcp: { slack: { url: 'https://mcp.example.com/slack' } } })
    let r = readClaudeLoadedAtStart(f.input(), f.paths)
    expect(r.mcp.map((m) => [m.engineName, m.account])).toEqual([['plugin:design:slack', { login: null }]])
    synced(f.home, OTHER, 'finance~g1', { name: 'finance' }, { mcp: { books: { url: 'https://mcp.example.com/books' } } })
    r = readClaudeLoadedAtStart(f.input(), f.paths)
    expect(r.mcp).toEqual([])
    expect(r.notes.some((n) => n.includes("2 Claude logins Silos can't match yet"))).toBe(true)
  })

  it('which copy loads: an installed copy that is on takes the name; installed and off, the account copy loads', () => {
    const f = fixture()
    installed(f.home, { 'design@m': plugin(f.home, 'design@m', { mcp: { mine: { command: 'x' } } }) })
    synced(f.home, ACC, 'design~g1', { name: 'design' }, { mcp: { theirs: { url: 'https://mcp.example.com/a' } } })
    const t = started(f.home, ACC)
    expect(readClaudeLoadedAtStart(f.input({ recentTranscripts: [t] }), f.paths).mcp.map((m) => [m.engineName, m.account ?? null])).toEqual([
      ['plugin:design:mine', null],
    ])
    json(join(f.folder, '.claude', 'settings.local.json'), { enabledPlugins: { 'design@m': false } })
    expect(readClaudeLoadedAtStart(f.input({ recentTranscripts: [t] }), f.paths).mcp.map((m) => [m.engineName, m.account ?? null])).toEqual([
      ['plugin:design:theirs', { login: 'sam@example.com' }],
    ])
  })

  it('agrees with pluginResolver on every fixture', () => {
    type Layer = Record<string, unknown>
    const fixtures: { user?: Layer; project?: Layer; local?: Layer; managed?: Layer; quietDefault?: boolean }[] = [
      {},
      { user: { enabledPlugins: { 'a@m': false } } },
      { user: { enabledPlugins: { 'a@m': false } }, local: { enabledPlugins: { 'a@m': true, 'design@synced': false } } },
      { project: { enabledPlugins: { 'b@m': false } }, managed: { enabledPlugins: { 'b@m': true } } },
      { quietDefault: true },
      { quietDefault: true, user: { enabledPlugins: { 'quiet@synced': true } } },
      { local: { syncClaudeAiPlugins: false } },
      { project: { syncClaudeAiPlugins: false } },
      { managed: { syncClaudeAiPlugins: false, enabledPlugins: { 'a@m': false } } },
      { user: { enabledPlugins: JSON.parse('{"__proto__": false, "constructor": false}') } },
    ]
    for (const fx of fixtures) {
      const f = fixture()
      installed(f.home, {
        'a@m': plugin(f.home, 'a@m', { mcp: { sa: { command: 'a' } } }),
        'b@m': plugin(f.home, 'b@m', { mcp: { sb: { command: 'b' } } }),
      })
      synced(f.home, ACC, 'design~g1', { name: 'design' }, { mcp: { sd: { command: 'd' } } })
      synced(f.home, ACC, 'quiet~g1', { name: 'quiet', ...(fx.quietDefault ? { defaultEnabled: false } : {}) }, { mcp: { sq: { command: 'q' } } })
      if (fx.user) json(join(f.home, '.claude', 'settings.json'), fx.user)
      if (fx.project) json(join(f.folder, '.claude', 'settings.json'), fx.project)
      if (fx.local) json(join(f.folder, '.claude', 'settings.local.json'), fx.local)
      if (fx.managed) json(f.paths.managedSettings, fx.managed)
      const r = readClaudeLoadedAtStart(f.input({ recentTranscripts: [started(f.home, ACC)] }), f.paths)
      const listed = new Set(r.mcp.map((m) => m.from))
      const resolver = pluginResolver(
        f.folder,
        {
          userSettingsPath: join(f.home, '.claude', 'settings.json'),
          installedPluginsPath: join(f.home, '.claude', 'plugins', 'installed_plugins.json'),
          managedDir: join(f.paths.managedSettings, '..'),
        },
        new Map([
          ['design@synced', join(f.home, '.claude', 'plugins', 'synced', `${ORG}_${ACC}`, 'design~g1')],
          ['quiet@synced', join(f.home, '.claude', 'plugins', 'synced', `${ORG}_${ACC}`, 'quiet~g1')],
        ]),
      )
      for (const key of ['a@m', 'b@m', 'design@synced', 'quiet@synced']) {
        expect([JSON.stringify(fx), key, listed.has(key.split('@')[0]!)]).toEqual([JSON.stringify(fx), key, resolver.resolve(key).enabled])
      }
    }
  })
})

describe('OpenCode — what it loads instead', () => {
  it('mcp names from opencode.json(c), comments allowed, disabled ones left out, junk = none', () => {
    expect(opencodeMcpNames('{ // c\n "mcp": { "b": {}, "a": { "enabled": false }, "c": {"enabled": true} } }')).toEqual(['b', 'c'])
    expect(opencodeMcpNames('nope')).toEqual([])
    expect(opencodeMcpNames('{"mcp": []}')).toEqual([])
  })

  it("Silos' instruction files, the project's AGENTS.md by OpenCode's rule, the global AGENTS.md, and its MCP — never Claude's hooks", () => {
    const f = fixture()
    const state = join(f.home, 'state')
    write(join(state, 'opencode', 'context.md'), 'briefing')
    write(join(f.folder, 'AGENTS.md'), 'agents')
    write(join(f.folder, 'CLAUDE.md'), 'claude — skipped: AGENTS.md was found first')
    write(join(f.home, '.config', 'opencode', 'AGENTS.md'), 'global')
    write(join(f.home, '.config', 'opencode', 'opencode.jsonc'), '{"mcp":{"op":{}}}')
    write(join(f.folder, 'opencode.json'), '{"mcp":{"proj":{}}}')
    json(join(f.home, '.claude', 'settings.json'), { hooks: startHook('claude-only.sh') })
    const r = readOpencodeLoadedAtStart(f.input({ agentStateDir: state }))
    expect(r.engine).toBe('OpenCode')
    expect(r.injections).toEqual([])
    expect(r.instructions.map((i) => [i.kind, i.rel])).toEqual([
      ['silos', '~/state/opencode/context.md'],
      ['project', 'AGENTS.md'],
      ['global', '~/.config/opencode/AGENTS.md'],
    ])
    expect(r.mcp).toEqual([
      { name: 'op', source: 'user', from: '~/.config/opencode/opencode.jsonc' },
      { name: 'proj', source: 'project', from: 'opencode.json' },
    ])
  })

  // Harness.loads (loads.ts): the inventory alone — every row's origin and
  // the file that decides it; `enabled` is the merged one (the project's
  // config over yours); no switch, no health, no account, no notes
  it("the inventory: your machine's and the project's servers, each naming its file; enabled:false merged across layers", () => {
    const f = fixture()
    write(
      join(f.home, '.config', 'opencode', 'opencode.json'),
      JSON.stringify({
        mcp: {
          docs: { type: 'remote', url: 'https://docs.example.com/mcp?token=s3cret' },
          shared: { type: 'local', command: ['npx', 'shared-mcp'], enabled: false },
        },
      }),
    )
    write(
      join(f.folder, 'opencode.jsonc'),
      '{ // project\n "mcp": { "shared": { "type": "local", "command": ["x"] }, "db": { "type": "local", "command": ["db-mcp"], "enabled": false } } }',
    )
    // OpenCode's own managed dir, empty here (never the machine's /etc/opencode)
    const env = { OPENCODE_TEST_MANAGED_CONFIG_DIR: join(f.home, 'managed') }
    const inv = opencodeLoadsInventory(
      {
        folder: f.folder,
        home: f.home,
        recentTranscripts: [],
        seenToolIds: ['db'],
        readings: [],
        agentServers: [{ agent: 'builder', servers: ['builder_own'] }],
      },
      env,
    )
    expect(inv).toMatchObject({ engine: 'OpenCode', folder: f.folder, logins: [] })
    expect(inv.rows.map((r) => [r.key, r.origin.owner, r.origin.carrier, r.state, r.detail ?? null])).toEqual([
      ['mcp:user:docs', 'you', '~/.config/opencode/opencode.json', 'active', 'https://docs.example.com/mcp'],
      ['mcp:user:shared', 'you', '~/.config/opencode/opencode.json', 'held', 'npx shared-mcp'],
      ['mcp:project:db', 'project', 'opencode.jsonc', 'held', 'db-mcp'],
      ['mcp:project:shared', 'project', 'opencode.jsonc', 'held', 'x'],
    ])
    // every row: its project's own switch (spec scopes §9), no health
    for (const r of inv.rows) {
      expect(r.switch).toEqual({ names: [r.name] })
      expect(r.decidedBy).toBeUndefined()
      expect(r.health).toBeUndefined()
      expect(r.engine).toBe('OpenCode')
    }
    // the project's file turning yours back on wins
    write(join(f.folder, 'opencode.jsonc'), '{"mcp":{"shared":{"enabled":true}}}')
    const again = opencodeLoadsInventory({ folder: f.folder, home: f.home, recentTranscripts: [], seenToolIds: [], readings: [] }, env)
    expect(again.rows.filter((r) => r.name === 'shared').map((r) => r.state)).toEqual(['active', 'active'])
    // no config anywhere: no rows, no throw
    expect(
      opencodeLoadsInventory({ folder: join(f.home, 'none'), home: join(f.home, 'none'), recentTranscripts: [], seenToolIds: [], readings: [] }).rows,
    ).toEqual([])
  })

  it('Harness.instructions: what its launch passes, every row read-only, no place to create', async () => {
    const f = fixture()
    write(join(f.folder, 'AGENTS.md'), 'agents')
    write(join(f.home, '.config', 'opencode', 'AGENTS.md'), 'global')
    const list = await opencodeInstructions({ folder: f.folder, home: f.home, loginDirs: [], projectsRoot: join(f.home, 'p'), transcripts: [] })
    expect(list.rows.map((r) => [r.rel, r.origin, r.editable])).toEqual([
      ['AGENTS.md', 'project', false],
      ['~/.config/opencode/AGENTS.md', 'machine', false],
    ])
    expect(list.places).toEqual([])
    await expect(
      readOpencodeInstruction({ folder: f.folder, home: f.home, loginDirs: [], projectsRoot: '', transcripts: [] }, join(f.folder, 'CLAUDE.md')),
    ).rejects.toThrow('not listed')
  })
})

// Harness.instructions for Claude Code (instructions.ts, spec memory-places
// T2): every instruction file a conversation in a folder loads, one row each
// — its origin, engine type, reach by launch kind, when, weight, and whether
// Silos may write it — from a fixture tree with two logins
describe('Claude Code — Harness.instructions', () => {
  function tree() {
    const base = mkdtempSync(join(tmpdir(), 'instr-'))
    const home = join(base, 'home')
    const login = join(home, '.claude')
    const extra = join(base, 'accounts', 'sam')
    const folder = join(home, 'work', 'proj')
    const managed = join(base, 'managed')
    mkdirSync(folder, { recursive: true })
    mkdirSync(extra, { recursive: true })
    const input = (over: Partial<InstructionsInput> = {}): InstructionsInput => ({
      folder,
      home,
      loginDirs: [login, extra],
      projectsRoot: join(login, 'projects'),
      managedDir: managed,
      transcripts: [],
      ...over,
    })
    return { base, home, login, extra, folder, managed, input }
  }
  const byRel = (rows: InstructionRow[]) => new Map(rows.map((r) => [r.rel, r]))

  it("each kind from the tree: origin, engine type, when, editable — in the engine's load order", async () => {
    const t = tree()
    write(join(t.managed, 'CLAUDE.md'), 'org')
    write(join(t.login, 'CLAUDE.md'), 'mine')
    write(join(t.login, 'rules', 'style.md'), 'always')
    write(join(t.home, 'work', 'CLAUDE.md'), 'above')
    write(join(t.folder, 'CLAUDE.md'), 'Read @AGENTS.md and @docs/notes.md')
    write(join(t.folder, 'AGENTS.md'), 'agents')
    write(join(t.folder, 'docs', 'notes.md'), 'notes')
    write(join(t.folder, '.claude', 'CLAUDE.md'), 'dot')
    write(join(t.folder, '.claude', 'rules', 'api.md'), '---\npaths: "src/**"\n---\nroutes')
    write(join(t.folder, 'CLAUDE.local.md'), 'private')
    write(join(t.folder, 'web', 'CLAUDE.md'), 'web')
    write(join(t.folder, 'web', '.claude', 'rules', 'ui.md'), 'ui')
    write(join(t.login, 'projects', mungePath(t.folder), 'memory', 'MEMORY.md'), '- [a](a.md)')
    write(join(t.login, 'projects', mungePath(t.folder), 'memory', 'a.md'), 'note')
    const list = await claudeInstructions(t.input())
    const rows = list.rows.map((r) => [r.kind, r.origin, r.engineType, r.when.at, r.editable])
    expect(list.rows.map((r) => r.rel)).toEqual([
      t.managed + '/CLAUDE.md',
      '~/.claude/CLAUDE.md',
      '~/.claude/rules/style.md',
      '~/work/CLAUDE.md',
      'CLAUDE.md',
      '.claude/CLAUDE.md',
      '.claude/rules/api.md',
      'CLAUDE.local.md',
      'web/CLAUDE.md',
      'web/.claude/rules/ui.md',
      'AGENTS.md',
      'docs/notes.md',
      `~/.claude/projects/${mungePath(t.folder)}/memory/MEMORY.md`,
      `~/.claude/projects/${mungePath(t.folder)}/memory/a.md`,
    ])
    expect(rows).toEqual([
      ['managed', 'organization', 'Managed', 'start', false],
      ['personal', 'machine', 'User', 'start', true],
      ['personal-rule', 'machine', 'User', 'start', true],
      ['above', 'above', 'Project', 'start', false],
      ['project', 'project', 'Project', 'start', true],
      ['project', 'project', 'Project', 'start', true],
      ['project-rule', 'project', 'Project', 'on-demand', true],
      ['private', 'private', 'Local', 'start', true],
      ['subfolder', 'project', 'Project', 'on-demand', true],
      ['subfolder', 'project', 'Project', 'on-demand', true],
      ['agents', 'project', 'Project', 'start', true],
      ['import', 'project', 'Project', 'start', false],
      ['auto-index', 'auto', 'AutoMem', 'start', true],
      ['auto-note', 'auto', null, 'on-demand', true],
    ])
    const m = byRel(list.rows)
    expect(m.get('AGENTS.md')).toMatchObject({ through: 'import', importedBy: 'CLAUDE.md' })
    expect(m.get('.claude/rules/api.md')!.reach.paths).toBe('src/**')
    expect(m.get('web/CLAUDE.md')!.when.under).toBe('web/')
    expect(m.get('~/work/CLAUDE.md')!.reach).toMatchObject({ scope: 'under', under: join(t.home, 'work') })
    // the machine's files need the owner's confirm; nothing else does
    expect(list.rows.filter((r) => r.confirm).map((r) => r.rel)).toEqual(['~/.claude/CLAUDE.md', '~/.claude/rules/style.md'])
    expect(m.get(`~/.claude/projects/${mungePath(t.folder)}/memory/a.md`)!.inIndex).toBe(true)
  })

  it('reach by sources: a private file reaches the conversations you open, not wakes or isolated runs; a personal one every start', async () => {
    const t = tree()
    write(join(t.login, 'CLAUDE.md'), 'mine')
    write(join(t.folder, 'CLAUDE.md'), 'p')
    write(join(t.folder, 'CLAUDE.local.md'), 'l')
    const m = byRel((await claudeInstructions(t.input())).rows)
    expect(m.get('CLAUDE.local.md')!.reach.launches).toEqual(['console', 'chat', 'run-inherits'])
    expect(m.get('CLAUDE.md')!.reach).toEqual({ scope: 'project', launches: ['console', 'chat', 'wake', 'run', 'run-inherits'] })
    expect(m.get('~/.claude/CLAUDE.md')!.reach.launches).toEqual(['console', 'chat', 'wake', 'run', 'run-inherits', 'run-no-folder'])
    expect(launchesReading('Managed')).toHaveLength(6)
  })

  it('a login that keeps its own rules is named on the machine rule; its own rule is a row of its own', async () => {
    const t = tree()
    write(join(t.login, 'rules', 'style.md'), 'machine')
    write(join(t.extra, 'rules', 'mine.md'), 'own')
    const m = byRel((await claudeInstructions(t.input())).rows)
    expect(m.get('~/.claude/rules/style.md')!.reach.notOn).toEqual([t.extra])
    expect(m.get(join(t.extra, 'rules', 'mine.md'))!.reach.notOn).toEqual([t.login])
    // a login that follows (its rules a link to the machine's) loads it: not named
    const u = tree()
    write(join(u.login, 'rules', 'style.md'), 'machine')
    symlinkSync(join(u.login, 'rules'), join(u.extra, 'rules'))
    expect(byRel((await claudeInstructions(u.input())).rows).get('~/.claude/rules/style.md')!.reach.notOn).toBeUndefined()
  })

  it('bounds: never .git, node_modules, a dot folder, a link, or a login dir — and a home folder keeps only its CLAUDE.md', async () => {
    const t = tree()
    write(join(t.folder, '.git', 'CLAUDE.md'), 'no')
    write(join(t.folder, 'node_modules', 'pkg', 'CLAUDE.md'), 'no')
    write(join(t.folder, '.cache', 'CLAUDE.md'), 'no')
    write(join(t.base, 'outside', 'CLAUDE.md'), 'no')
    symlinkSync(join(t.base, 'outside'), join(t.folder, 'linked'))
    write(join(t.folder, 'src', 'CLAUDE.md'), 'yes')
    const rels = (await claudeInstructions(t.input())).rows.map((r) => r.rel)
    expect(rels).toEqual(['src/CLAUDE.md'])

    // the home folder: its .claude is the login's
    write(join(t.home, 'CLAUDE.md'), 'home top')
    write(join(t.home, 'CLAUDE.local.md'), 'home local')
    write(join(t.login, 'CLAUDE.md'), 'mine')
    const home = await claudeInstructions(t.input({ folder: t.home }))
    expect(home.homeFolder).toBe(true)
    const hm = byRel(home.rows)
    expect(hm.get('CLAUDE.md')!.editable).toBe(true)
    expect(hm.get('CLAUDE.local.md')).toMatchObject({ editable: false })
    expect(hm.get('CLAUDE.local.md')!.readOnly).toMatch(/config folder/)
    expect(hm.get('.claude/CLAUDE.md')).toMatchObject({ kind: 'personal', editable: true, confirm: true })
    expect(home.places.filter((p) => p.origin !== 'machine' && p.origin !== 'auto').map((p) => p.path)).toEqual([join(t.home, 'CLAUDE.md')])
  })

  it('a file linked out of its folder is listed read-only; a moved auto memory is read-only, naming the file that moved it', async () => {
    const t = tree()
    write(join(t.base, 'elsewhere.md'), 'x')
    symlinkSync(join(t.base, 'elsewhere.md'), join(t.folder, 'CLAUDE.md'))
    write(join(t.base, 'notes', 'MEMORY.md'), 'moved index')
    json(join(t.folder, '.claude', 'settings.local.json'), { autoMemoryDirectory: join(t.base, 'notes') })
    const list = await claudeInstructions(t.input())
    const m = byRel(list.rows)
    expect(m.get('CLAUDE.md')).toMatchObject({ editable: false, real: join(t.base, 'elsewhere.md') })
    expect(m.get(join(t.base, 'notes', 'MEMORY.md'))).toMatchObject({
      kind: 'auto-index',
      editable: false,
      movedBy: join(t.folder, '.claude', 'settings.local.json'),
    })
    // no place for a new note: the default dir is not where it loads
    expect(list.places.some((p) => p.origin === 'auto')).toBe(false)
  })

  it('the ignore line is offered only where <folder>/.git is a directory', async () => {
    const t = tree()
    const local = async () => (await claudeInstructions(t.input())).places.find((p) => p.kind === 'private')!
    expect(await local()).toMatchObject({ ignoreElsewhere: true })
    expect((await local()).ignoreLine).toBeUndefined()
    writeFileSync(join(t.folder, '.git'), 'gitdir: /elsewhere/.git/worktrees/x')
    expect((await local()).ignoreLine).toBeUndefined()
    rmSync(join(t.folder, '.git'))
    mkdirSync(join(t.folder, '.git'))
    expect((await local()).ignoreLine).toEqual({ file: join(t.folder, '.git', 'info', 'exclude'), line: 'CLAUDE.local.md' })
  })

  it("weight as loaded from the newest record, by real path — one file under two logins' paths; else on disk; a record names what the scan missed", async () => {
    const t = tree()
    write(join(t.login, 'CLAUDE.md'), 'x'.repeat(40))
    symlinkSync(join(t.login, 'CLAUDE.md'), join(t.extra, 'CLAUDE.md'))
    write(join(t.folder, 'CLAUDE.md'), 'y'.repeat(8))
    let deep = t.folder
    for (let i = 0; i < 8; i++) deep = join(deep, `d${i}`)
    write(join(deep, 'CLAUDE.md'), 'deep')
    const transcript = join(t.base, 't.jsonl')
    writeFileSync(
      transcript,
      [
        JSON.stringify({
          type: 'attachment',
          timestamp: '2026-11-20T10:00:00.000Z',
          attachment: { type: 'instructions', files: [{ path: join(t.extra, 'CLAUDE.md'), type: 'User', content: 'x'.repeat(20) }] },
        }),
        JSON.stringify({
          type: 'attachment',
          timestamp: '2026-11-20T10:05:00.000Z',
          attachment: { type: 'nested_memory', path: join(deep, 'CLAUDE.md'), content: { type: 'Project', content: 'deep' } },
        }),
      ].join('\n') + '\n',
    )
    const list = await claudeInstructions(t.input({ transcripts: [transcript] }))
    const m = byRel(list.rows)
    expect(m.get('~/.claude/CLAUDE.md')!.weight).toEqual({ chars: 20, tokens: 5, as: 'loaded', at: '2026-11-20T10:00:00.000Z' })
    expect(m.get('CLAUDE.md')!.weight).toEqual({ chars: 8, tokens: 2, as: 'disk' })
    const d = list.rows.find((r) => r.real === join(deep, 'CLAUDE.md'))!
    expect(d).toMatchObject({ kind: 'subfolder', fromRecord: true, editable: true, when: { at: 'on-demand', under: 'd0/d1/d2/d3/d4/d5/d6/d7/' } })
    // the read of a listed file; anything else is not listed
    expect((await readClaudeInstruction(t.input(), join(t.folder, 'CLAUDE.md'))).content).toBe('y'.repeat(8))
    await expect(readClaudeInstruction(t.input(), join(t.folder, 'nope', 'CLAUDE.md'))).rejects.toThrow('not listed')
  })
})
