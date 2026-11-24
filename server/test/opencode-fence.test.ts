import { describe, it, expect } from 'vitest'
import { fenceMapping, fenceToPermission, opencodeConfigDenies } from '../src/harnesses/opencode/fence.js'
import { opencode } from '../src/harnesses/opencode/index.js'
import { claudeCode } from '../src/harnesses/claude-code/index.js'
import { authFilePath } from '../src/harnesses/opencode/auth-file.js'
import { fenceFor } from '../src/territory.js'

const fence = (deny: string[]) => ({ permissions: { deny, additionalDirectories: [] } })
const opts = { worktree: '/home/u/proj' }

// OpenCode's evaluation (1.14.22 and 1.19.4), as read from the binary: wildcard `*` → `.*`
// with the `s` flag (crosses `/`), `?` → `.`, and the LAST matching key of
// the tool's object wins (findLast over Object.entries); no match → ask.
function evaluate(rules: Record<string, string> | undefined, path: string): string {
  let out = 'ask'
  for (const [pattern, action] of Object.entries(rules ?? {})) {
    const re = new RegExp(
      '^' +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.') +
        '$',
      's',
    )
    if (re.test(path)) out = action
  }
  return out
}

describe('fenceToPermission', () => {
  it('maps Read/Edit/Bash rules; read and edit twice: worktree-relative (what the tools ask with on 1.19.4) and absolute', () => {
    expect(fenceToPermission(fence(['Read(//home/u/.ssh/**)', 'Edit(//home/u/.silos/agents/**)', 'Bash(cat /home/u/secrets/*)']), opts)).toEqual({
      read: { '../.ssh/**': 'deny', '/home/u/.ssh/**': 'deny' },
      edit: { '../.silos/agents/**': 'deny', '/home/u/.silos/agents/**': 'deny' },
      bash: { 'cat /home/u/secrets/*': 'deny' },
    })
  })
  it('Write folds into edit; a path inside the worktree turns relative without ../', () => {
    expect(fenceToPermission(fence(['Write(//home/u/proj/context/finance/**)']), opts)).toEqual({
      edit: { 'context/finance/**': 'deny', '/home/u/proj/context/finance/**': 'deny' },
    })
  })
  it('strips exactly one leading slash; relative patterns are kept as-is', () => {
    expect(fenceToPermission(fence(['Read(///x)', 'Read(./rel/**)', 'Edit(./rel/**)']), opts)).toEqual({
      read: { '../../../x': 'deny', '//x': 'deny', './rel/**': 'deny' },
      edit: { './rel/**': 'deny' },
    })
  })
  it('Glob/Grep/LS (no path permission in OpenCode), unknown tools and malformed rules are unmapped', () => {
    const r = fenceMapping(
      fence(['WebFetch(domain:x.com)', 'Bash', 'Read(//ok)', 'NotARule(', 'constructor(x)', 'Glob(//c/**)', 'Grep(//d/**)', 'LS(//e)']),
      opts,
    )
    expect(r.permission).toEqual({ read: { '../../../ok': 'deny', '/ok': 'deny' } })
    expect(r.unmapped).toEqual(['WebFetch(domain:x.com)', 'Bash', 'NotARule(', 'constructor(x)', 'Glob(//c/**)', 'Grep(//d/**)', 'LS(//e)'])
  })
  it('a "{" in a pattern is refused (OpenCode would substitute it)', () => {
    expect(() => fenceToPermission(fence(['Read(//home/u/{env:HOME})']), opts)).toThrow(/"\{"/)
    expect(() => fenceToPermission(fence([]), { ...opts, allowPaths: ['/s/{file:x}'] })).toThrow(/"\{"/)
  })
  it('allowPaths come last and win over an existing key for the same pattern', () => {
    const p = fenceToPermission(fence(['Read(//s/me/**)', 'Read(//t/**)']), { ...opts, allowPaths: ['/s/me/'] })
    expect(Object.entries(p.read as object)).toEqual([
      ['../../../t/**', 'deny'],
      ['/t/**', 'deny'],
      ['../../../s/me/**', 'allow'],
      ['/s/me/**', 'allow'],
    ])
  })
  it("real fenceFor + own state dir: the agent still reads and edits its own state, never another agent's", () => {
    const builder = { id: 'builder', folder: '/home/u/ci', skills: [], name: 'Builder', emoji: '', role: '' }
    const finance = { id: 'finance', folder: '/home/u/ci', skills: [], name: 'Finance', emoji: '', role: '' }
    const stateDir = '/home/u/.silos/agent-state/builder'
    const f = fenceFor({
      agent: builder,
      agents: [builder, finance],
      privatePaths: ['~/secrets'],
      home: '/home/u',
      dataDir: '/home/u/.silos',
      agentStateDir: stateDir,
    })!
    expect(f.permissions.deny).toContain('Read(//home/u/.silos/*.json)')
    const r = fenceMapping(f, { worktree: '/home/u/ci', allowPaths: [stateDir] })
    expect(r.unmapped).toEqual([])
    const read = r.permission.read as Record<string, string>,
      edit = r.permission.edit as Record<string, string>
    // the allow keys come after every deny — they win under findLast — and
    // only a deny INSIDE the allowed dir (its own plugin) is set again after them
    expect(Object.entries(read).slice(-2)).toEqual([
      ['../.silos/agent-state/builder/**', 'allow'],
      [`${stateDir}/**`, 'allow'],
    ])
    expect(Object.entries(edit).slice(-4)).toEqual([
      ['../.silos/agent-state/builder/**', 'allow'],
      [`${stateDir}/**`, 'allow'],
      ['../.silos/agent-state/builder/plugin/**', 'deny'],
      [`${stateDir}/plugin/**`, 'deny'],
    ])
    expect(evaluate(edit, `${stateDir}/plugin/skills/x/SKILL.md`)).toBe('deny')
    expect(evaluate(edit, '../.silos/agent-state/builder/plugin/hooks/hooks.json')).toBe('deny')
    expect(evaluate(edit, `${stateDir}/proposed/x/SKILL.md`)).toBe('allow')
    // without the allow, `*.json` crosses `/` and would deny its own state
    const denyOnly = fenceMapping(f, { worktree: '/home/u/ci' }).permission.read as Record<string, string>
    expect(evaluate(denyOnly, '../.silos/agent-state/builder/runmode.json')).toBe('deny')
    for (const own of [`${stateDir}/runmode.json`, `${stateDir}/inbox/m1.json`, `${stateDir}/births/s.json`]) {
      const rel = `../.silos/agent-state/builder/${own.slice(stateDir.length + 1)}`
      expect(evaluate(read, rel)).toBe('allow')
      expect(evaluate(read, own)).toBe('allow')
      expect(evaluate(edit, rel)).toBe('allow')
    }
    // what 1.19.4's read tool asks with: the path relative to the worktree
    expect(evaluate(read, '../.silos/agent-state/finance/runmode.json')).toBe('deny')
    expect(evaluate(read, '../.silos/agents.json')).toBe('deny')
    expect(evaluate(read, '../.silos/ui.json')).toBe('deny')
    expect(evaluate(read, '../secrets/k')).toBe('deny')
    expect(evaluate(read, 'src/app.ts')).toBe('ask')
    // and the absolute form stays denied too
    expect(evaluate(read, '/home/u/.silos/agent-state/finance/runmode.json')).toBe('deny')
    expect(evaluate(edit, '../.silos/agent-state/finance/x.json')).toBe('deny')
    expect(evaluate(read, '/home/u/.silos/agents.json')).toBe('deny')
    expect(evaluate(read, '/home/u/secrets/k')).toBe('deny')
    expect(evaluate(edit, 'context/finance/notes.md')).toBe('deny')
    expect(evaluate(edit, 'context/builder/notes.md')).toBe('ask')
  })

  // OpenCode merges config layers keeping an earlier layer's
  // key position — its own config files are fenced like Claude's settings.
  it("with `home`: OpenCode's config files are denied for edit, after the fence and before the allows", () => {
    const p = fenceToPermission(fence(['Edit(//s/**)']), { ...opts, allowPaths: ['/st/me'], home: '/home/u' })
    const keys = Object.keys(p.edit as object)
    const denies = [
      'opencode.json',
      'opencode.jsonc',
      '.opencode/**',
      '**/opencode.json',
      '**/opencode.jsonc',
      '**/.opencode/**',
      '../.config/opencode/**',
      '/home/u/.config/opencode/**',
    ]
    expect(keys).toEqual(['../../../s/**', '/s/**', ...denies, '../../../st/me/**', '/st/me/**'])
    for (const k of denies) expect((p.edit as Record<string, string>)[k]).toBe('deny')
    expect(opencodeConfigDenies('/home/u/')).toContain('/home/u/.config/opencode/**')
    // without `home`: nothing added (an unfenced launch never calls this anyway)
    expect(Object.keys(fenceToPermission(fence(['Edit(//s/**)']), opts).edit as object)).toEqual(['../../../s/**', '/s/**'])
  })

  it('real fenceFor + home: config files denied wherever they sit, own state still allowed', () => {
    const builder = { id: 'builder', folder: '/home/u/ci', skills: [], name: 'Builder', emoji: '', role: '' }
    const stateDir = '/home/u/.silos/agent-state/builder'
    const f = fenceFor({ agent: builder, agents: [builder], privatePaths: [], home: '/home/u', dataDir: '/home/u/.silos', agentStateDir: stateDir })!
    const r = fenceMapping(f, { worktree: '/home/u/ci', allowPaths: [stateDir], home: '/home/u' })
    const edit = r.permission.edit as Record<string, string>,
      read = r.permission.read as Record<string, string>
    for (const p of [
      'opencode.json',
      'opencode.jsonc',
      'sub/opencode.json',
      '.opencode/opencode.json',
      'a/.opencode/plugin/x.ts',
      '../.config/opencode/opencode.json',
      '../other/opencode.jsonc',
      '../.opencode/opencode.json',
    ]) {
      expect(evaluate(edit, p)).toBe('deny')
    }
    for (const own of ['runmode.json', 'inbox/m1.json', 'births/s.json', 'opencode/context.md']) {
      expect(evaluate(edit, `../.silos/agent-state/builder/${own}`)).toBe('allow')
      expect(evaluate(read, `${stateDir}/${own}`)).toBe('allow')
      expect(evaluate(read, `../.silos/agent-state/builder/${own}`)).toBe('allow')
    }
    expect(evaluate(edit, 'src/app.ts')).toBe('ask')
  })
})

describe('secretFiles', () => {
  it("declares the operator's auth.json (the login keys file every fence must deny)", () => {
    expect(opencode.secretFiles?.('/home/u')).toEqual([authFilePath('/home/u')])
  })
})

// What an engine loads, in OpenCode's dialect — the same
// rules territory.test.ts checks in Claude's, read through OpenCode's
// evaluation (worktree-relative and absolute asks alike).
describe("configFiles and the own plugin, in OpenCode's dialect", () => {
  it('each engine declares the files it loads behaviour from', () => {
    expect(claudeCode.configFiles?.('/home/u/proj/', '/home/u')).toEqual(['/home/u/proj/.mcp.json'])
    expect(opencode.configFiles?.('/home/u/proj', '/home/u/')).toEqual([
      '/home/u/proj/opencode.json',
      '/home/u/proj/opencode.jsonc',
      '/home/u/proj/.opencode/**',
      '/home/u/.config/opencode/**',
    ])
  })
  const builder = { id: 'builder', folder: '/home/u/proj', skills: [], name: 'Builder', emoji: '', role: '' }
  const stateDir = '/home/u/.silos/agent-state/builder'
  const f = fenceFor({
    agent: builder,
    agents: [builder],
    privatePaths: [],
    home: '/home/u',
    dataDir: '/home/u/.silos',
    agentStateDir: stateDir,
    engineConfigFiles: (folder) => [...(claudeCode.configFiles?.(folder, '/home/u') ?? []), ...(opencode.configFiles?.(folder, '/home/u') ?? [])],
  })!
  // as the launch builds it (assemble.ts): the own state dir allowed, home given
  const edit = fenceToPermission(f, { worktree: '/home/u/proj', allowPaths: [stateDir], home: '/home/u' }).edit as Record<string, string>
  it.each(['skills/x/SKILL.md', 'commands/c.md', 'agents/a.md', 'hooks/hooks.json', '.mcp.json', '.claude-plugin/plugin.json'])(
    'its own plugin: %s denied, absolute and relative, despite the state-dir allow',
    (sub) => {
      expect(evaluate(edit, `${stateDir}/plugin/${sub}`)).toBe('deny')
      expect(evaluate(edit, `../.silos/agent-state/builder/plugin/${sub}`)).toBe('deny')
    },
  )
  it.each(['.mcp.json', 'opencode.json', 'opencode.jsonc', '.opencode/agent/a.md'])('%s in its folder: denied', (file) => {
    expect(evaluate(edit, file)).toBe('deny')
    expect(evaluate(edit, `/home/u/proj/${file}`)).toBe('deny')
  })
  it("the global config, the folder's Claude settings and skills: denied", () => {
    for (const p of ['/home/u/.config/opencode/opencode.json', '.claude/settings.local.json', '.claude/skills/x/SKILL.md', '../.claude/skills/y/SKILL.md'])
      expect(evaluate(edit, p)).toBe('deny')
  })
  it("its folder's own work and its proposed/ stay writable", () => {
    expect(evaluate(edit, 'src/index.ts')).toBe('ask')
    expect(evaluate(edit, `${stateDir}/proposed/x/SKILL.md`)).toBe('allow')
  })
  it('no process environment is readable', () => {
    const read = fenceToPermission(f, { worktree: '/home/u/proj', allowPaths: [stateDir] }).read as Record<string, string>
    for (const p of ['/proc/123/environ', '/proc/self/task/9/environ']) expect(evaluate(read, p)).toBe('deny')
  })
  it("another project's folder: closed whole, its work too — with its engine stores and the tmux server; a nested agent's folder: conduct files held, work untouched", () => {
    const other = { id: 'silos', folder: '/home/u/silos', skills: [], name: 'Silos', emoji: '', role: '' }
    const nested = { id: 'docs', folder: '/home/u/proj/docs', skills: [], name: 'Docs', emoji: '', role: '' }
    const g = fenceFor({
      agent: builder,
      agents: [builder, other, nested],
      privatePaths: [],
      home: '/home/u',
      dataDir: '/home/u/.silos',
      agentStateDir: stateDir,
      engineConfigFiles: (folder) => [...(claudeCode.configFiles?.(folder, '/home/u') ?? []), ...(opencode.configFiles?.(folder, '/home/u') ?? [])],
      projectStores: (folder, own) =>
        [claudeCode, opencode].flatMap((h) => h.projectStores?.(folder, { home: '/home/u', dataDir: '/home/u/.silos', own }) ?? []),
    })!
    const p = fenceToPermission(g, { worktree: '/home/u/proj', allowPaths: [stateDir], home: '/home/u' })
    const read = p.read as Record<string, string>,
      ed = p.edit as Record<string, string>
    for (const at of ['/home/u/silos', '../silos']) {
      for (const f of ['.claude/settings.local.json', 'src/app.ts', 'plans/x.plan.json']) {
        expect([at, f, evaluate(read, `${at}/${f}`), evaluate(ed, `${at}/${f}`)]).toEqual([at, f, 'deny', 'deny'])
      }
    }
    // its engine stores: the transcripts in the Claude config dir, the machine's OpenCode database
    for (const s of [
      '/home/u/.claude/projects/-home-u-silos/abc.jsonl',
      '/home/u/.claude/projects/-home-u-silos/memory/MEMORY.md',
      '/home/u/.local/share/opencode/opencode.db',
    ]) {
      expect([s, evaluate(read, s)]).toEqual([s, 'deny'])
    }
    // the same project (nested): its conduct files held like one's own, its work open
    for (const at of ['/home/u/proj/docs', 'docs']) {
      expect(evaluate(read, `${at}/.claude/settings.local.json`)).toBe('deny')
      for (const f of ['.claude/settings.json', '.claude/skills/x/SKILL.md', '.mcp.json', 'opencode.json', '.opencode/plugin/x.js'])
        expect([at, f, evaluate(ed, `${at}/${f}`)]).toEqual([at, f, 'deny'])
      expect(evaluate(ed, `${at}/src/app.ts`)).not.toBe('deny')
      expect(evaluate(read, `${at}/src/app.ts`)).not.toBe('deny')
    }
    // Silos' tmux server: the same patterns in OpenCode's bash dialect
    expect(p.bash).toEqual({ tmux: 'deny', 'tmux *': 'deny' })
  })
  it("the user memory, in ~/.claude and through every account's link to it: neither read nor edited", () => {
    const read = fenceToPermission(f, { worktree: '/home/u/proj', allowPaths: [stateDir] }).read as Record<string, string>
    for (const p of ['/home/u/.claude/CLAUDE.md', '/home/u/.silos/claude-accounts/kai/CLAUDE.md']) {
      expect(evaluate(read, p)).toBe('deny')
      expect(evaluate(edit, p)).toBe('deny')
    }
  })
})
