// Paths with spaces, and paths that point nowhere. The class: a
// path Silos derives from its own location, and a path it writes into a
// shell string for someone else to run.
//   - derived: `new URL(import.meta.url).pathname` percent-encodes a space
//     and, in a module moved one folder down, names the wrong level (the
//     hook route pointed at <repo>/server/plugin/hooks) — repo-paths.ts is
//     the one source, and no server/src file may use `.pathname` on its URL
//   - written: one shell word whatever the path holds (shell-quote.ts)
//   - read back: «installed» means the hook command points at a script
//     that exists (settings.ts HookWiring), never just «names the script»
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLUGIN_DIR, PLUGIN_HOOKS_DIR, REPO_ROOT } from '../src/repo-paths.js'
import { shellQuote, shellWords } from '../src/shell-quote.js'
import { hookCommand, hookScriptPath, installSilosHooks, readClaudeSettings } from '../src/harnesses/claude-code/settings.js'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) out.push(...tsFiles(p))
    else if (n.endsWith('.ts')) out.push(p)
  }
  return out
}

describe("repo-paths — one source for where the checkout's files are", () => {
  it('points at the real plugin: both hook scripts exist', () => {
    expect(existsSync(join(REPO_ROOT, 'package.json'))).toBe(true)
    expect(existsSync(join(PLUGIN_DIR, '.claude-plugin', 'plugin.json'))).toBe(true)
    for (const s of ['session-start.sh', 'pre-cron.sh']) expect(existsSync(join(PLUGIN_HOOKS_DIR, s)), s).toBe(true)
  })

  it('no server/src file takes .pathname of its own module URL', () => {
    const offenders = tsFiles(SRC).filter((f) => /import\.meta\.url\)?\s*\)?\.pathname/.test(readFileSync(f, 'utf8')))
    expect(offenders.map((f) => f.slice(SRC.length))).toEqual([])
  })
})

describe('shellQuote / shellWords', () => {
  const values = ['/plain/path.sh', '/My Repo/plugin/hooks/session-start.sh', "/it's/here.sh", '/a"b/$HOME/`x`/c.sh', '/tab\there', '']
  it('a quoted value is one shell word whatever it holds — the shell agrees', () => {
    for (const v of values) {
      const out = execFileSync('/bin/sh', ['-c', `printf '%s' ${shellQuote(v)}`], { encoding: 'utf8' })
      expect(out, v).toBe(v)
      expect(shellWords(`${shellQuote(v)} --flag`), v).toEqual([v, '--flag'])
    }
  })
  it('a plain path is written as is (existing settings stay byte-identical)', () => {
    expect(shellQuote('/home/u/silos/plugin/hooks/pre-cron.sh')).toBe('/home/u/silos/plugin/hooks/pre-cron.sh')
  })
  it('reads double quotes and backslashes the way sh does', () => {
    expect(shellWords('bash "/a b/c.sh" x\\ y')).toEqual(['bash', '/a b/c.sh', 'x y'])
  })
})

describe('Silos hooks in settings.json — installed means the script runs', () => {
  function setup(dirName = 'my repo') {
    const root = mkdtempSync(join(tmpdir(), 'deck-hooks-'))
    const hooksDir = join(root, dirName, 'plugin', 'hooks')
    mkdirSync(hooksDir, { recursive: true })
    for (const s of ['session-start.sh', 'pre-cron.sh']) {
      writeFileSync(join(hooksDir, s), `#!/bin/sh\necho ran-${s}\n`)
      chmodSync(join(hooksDir, s), 0o755)
    }
    const path = join(root, 'settings.json')
    return { root, hooksDir, path, backups: join(root, 'bk') }
  }
  const entries = (start: string, cron: string) => ({
    hooks: {
      SessionStart: [{ matcher: 'startup|resume|clear', hooks: [{ type: 'command', command: start }] }],
      PreToolUse: [{ matcher: 'CronCreate', hooks: [{ type: 'command', command: cron }] }],
    },
  })

  it('a fresh install under a path with a space writes quoted commands that really run', () => {
    const { hooksDir, path, backups } = setup()
    const { view } = installSilosHooks(path, backups, hooksDir)
    expect(view.hooks).toEqual({ briefing: 'installed', cronGate: 'installed' })
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    const cmd = raw.hooks.SessionStart[0].hooks[0].command as string
    expect(cmd).toBe(hookCommand(hooksDir, 'session-start.sh'))
    expect(execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' })).toBe('ran-session-start.sh\n')
    expect(execFileSync('/bin/sh', ['-c', raw.hooks.PreToolUse[0].hooks[0].command], { encoding: 'utf8' })).toBe('ran-pre-cron.sh\n')
    expect(installSilosHooks(path, backups, hooksDir).backup).toBeNull() // idempotent
  })

  it('every way a command can point nowhere reads broken, never installed', () => {
    const { hooksDir, path } = setup()
    const variants = {
      'moved repo': ['/gone/plugin/hooks/session-start.sh', '/gone/plugin/hooks/pre-cron.sh'],
      'space unquoted': [join(hooksDir, 'session-start.sh'), join(hooksDir, 'pre-cron.sh')],
      'percent-encoded': [join(hooksDir, 'session-start.sh').replace(/ /g, '%20'), join(hooksDir, 'pre-cron.sh').replace(/ /g, '%20')],
      'an unknown variable': ['${SOMEWHERE}/hooks/session-start.sh', '$X/pre-cron.sh'],
      'a stale npx cache': [
        '/home/u/.npm/_npx/0123abcd/node_modules/silosplatform/plugin/hooks/session-start.sh',
        '/home/u/.npm/_npx/0123abcd/node_modules/silosplatform/plugin/hooks/pre-cron.sh',
      ],
    }
    for (const [name, [start, cron]] of Object.entries(variants)) {
      writeFileSync(path, JSON.stringify(entries(start!, cron!)))
      expect(readClaudeSettings(path).hooks, name).toEqual({ briefing: 'broken', cronGate: 'broken' })
    }
    writeFileSync(path, JSON.stringify({}))
    expect(readClaudeSettings(path).hooks).toEqual({ briefing: 'missing', cronGate: 'missing' })
  })

  it('a command that reaches the script — quoted, through bash, or from ~ — reads installed', () => {
    const { root, hooksDir, path } = setup('repo')
    const home = root
    writeFileSync(path, JSON.stringify(entries(`bash ${shellQuote(join(hooksDir, 'session-start.sh'))}`, '~/repo/plugin/hooks/pre-cron.sh')))
    expect(readClaudeSettings(path, home).hooks).toEqual({ briefing: 'installed', cronGate: 'installed' })
    expect(hookScriptPath('$HOME/repo/plugin/hooks/pre-cron.sh', 'pre-cron.sh', home)).toBe(join(hooksDir, 'pre-cron.sh'))
  })

  it('install repairs a broken entry in place — its matcher and neighbours stay, nothing is duplicated', () => {
    const { hooksDir, path, backups } = setup()
    const mine = { type: 'command', command: '/usr/local/bin/my-own-hook' }
    writeFileSync(
      path,
      JSON.stringify({
        model: 'opus',
        hooks: {
          SessionStart: [{ matcher: 'startup|resume|clear', hooks: [mine, { type: 'command', command: '/gone/plugin/hooks/session-start.sh' }] }],
        },
      }),
    )
    const r = installSilosHooks(path, backups, hooksDir)
    expect(r.backup).not.toBeNull()
    expect(r.view.hooks).toEqual({ briefing: 'installed', cronGate: 'installed' })
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    expect(raw.model).toBe('opus')
    expect(raw.hooks.SessionStart).toHaveLength(1)
    expect(raw.hooks.SessionStart[0].hooks).toEqual([mine, { type: 'command', command: hookCommand(hooksDir, 'session-start.sh'), timeout: 15 }])
    expect(raw.hooks.PreToolUse).toEqual([{ matcher: 'CronCreate', hooks: [{ type: 'command', command: hookCommand(hooksDir, 'pre-cron.sh'), timeout: 10 }] }])
  })
})
