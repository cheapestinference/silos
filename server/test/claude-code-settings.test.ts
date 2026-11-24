import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, lstatSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readClaudeSettings, writeCleanupPeriodDays, CLEANUP_DEFAULT_DAYS } from '../src/harnesses/claude-code/settings.js'

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'deck-claude-settings-'))
}

describe('claude-settings (transcript retention)', () => {
  it('with no file -> default 30 and explicit=false', () => {
    const d = dir()
    const v = readClaudeSettings(join(d, 'settings.json'))
    expect(v).toMatchObject({ cleanupPeriodDays: CLEANUP_DEFAULT_DAYS, explicit: false })
  })

  it('reads the key if it exists and preserves the rest of the file on write (prior backup, atomic)', () => {
    const d = dir()
    const p = join(d, 'settings.json')
    writeFileSync(p, JSON.stringify({ model: 'opus', hooks: { Stop: [] }, cleanupPeriodDays: 30 }, null, 2))
    expect(readClaudeSettings(p)).toMatchObject({ cleanupPeriodDays: 30, explicit: true })
    const backups = join(d, 'backups')
    const r = writeCleanupPeriodDays(p, 3650, backups)
    expect(r.view).toMatchObject({ cleanupPeriodDays: 3650, explicit: true })
    expect(r.backup && existsSync(r.backup)).toBe(true)
    const after = JSON.parse(readFileSync(p, 'utf8'))
    expect(after).toEqual({ model: 'opus', hooks: { Stop: [] }, cleanupPeriodDays: 3650 })
    expect(readdirSync(backups)).toHaveLength(1)
    expect(readdirSync(d).some((f) => f.startsWith('settings.json.tmp'))).toBe(false)
  })

  it('creates the file if it does not exist (no backup) and rejects invalid values', () => {
    const d = dir()
    const p = join(d, 'settings.json')
    const r = writeCleanupPeriodDays(p, 3650, join(d, 'b'))
    expect(r.backup).toBeNull()
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ cleanupPeriodDays: 3650 })
    expect(() => writeCleanupPeriodDays(p, 0, join(d, 'b'))).toThrow('invalid cleanupPeriodDays')
    expect(() => writeCleanupPeriodDays(p, 1.5, join(d, 'b'))).toThrow()
    expect(() => writeCleanupPeriodDays(p, 99999, join(d, 'b'))).toThrow()
  })

  it('does not overwrite a corrupt settings.json', () => {
    const d = dir()
    const p = join(d, 'settings.json')
    writeFileSync(p, '{ not json')
    expect(() => writeCleanupPeriodDays(p, 3650, join(d, 'b'))).toThrow()
    expect(readFileSync(p, 'utf8')).toBe('{ not json')
  })
})

describe('claude-settings — push notifications + Silos hooks', () => {
  it('reads agentPushNotifEnabled (absent → true) and toggles it preserving the rest', async () => {
    const { readClaudeSettings, writeAgentPushNotif } = await import('../src/harnesses/claude-code/settings.js')
    const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'cs-'))
    const path = join(dir, 'settings.json')
    writeFileSync(path, JSON.stringify({ theme: 'dark', agentPushNotifEnabled: true }))
    expect(readClaudeSettings(path).agentPushNotifEnabled).toBe(true)
    expect(readClaudeSettings(join(dir, 'missing.json')).agentPushNotifEnabled).toBe(true) // absent → default on
    const { view } = writeAgentPushNotif(path, false, join(dir, 'bk'))
    expect(view.agentPushNotifEnabled).toBe(false)
    expect(JSON.parse(readFileSync(path, 'utf8')).theme).toBe('dark') // rest untouched
  })

  it('todoTools: reads env.CLAUDE_CODE_ENABLE_TODO_TOOLS; on sets only that key, off removes only it', async () => {
    const { readClaudeSettings, writeTodoTools } = await import('../src/harnesses/claude-code/settings.js')
    const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'cs-'))
    const path = join(dir, 'settings.json')
    writeFileSync(path, JSON.stringify({ theme: 'dark', env: { OTHER: 'x' } }))
    expect(readClaudeSettings(path).todoTools).toBe(false)
    const on = writeTodoTools(path, true, join(dir, 'bk'))
    expect(on.view.todoTools).toBe(true)
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    expect(saved.env).toEqual({ OTHER: 'x', CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' })
    expect(saved.theme).toBe('dark') // rest untouched
    const off = writeTodoTools(path, false, join(dir, 'bk'))
    expect(off.view.todoTools).toBe(false)
    expect(JSON.parse(readFileSync(path, 'utf8')).env).toEqual({ OTHER: 'x' }) // only its key removed
  })

  it('hooks status reads the wiring (a script that exists); install adds ONLY what is missing, additively', async () => {
    const { readClaudeSettings, installSilosHooks } = await import('../src/harnesses/claude-code/settings.js')
    const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { mkdirSync } = await import('node:fs')
    const dir = mkdtempSync(join(tmpdir(), 'cs-'))
    const path = join(dir, 'settings.json')
    const hooksDir = join(dir, 'plugin', 'hooks')
    mkdirSync(hooksDir, { recursive: true })
    for (const s of ['session-start.sh', 'pre-cron.sh']) writeFileSync(join(hooksDir, s), '#!/bin/sh\n')
    writeFileSync(
      path,
      JSON.stringify({
        hooks: { SessionStart: [{ matcher: 'startup|resume|clear', hooks: [{ type: 'command', command: join(hooksDir, 'session-start.sh') }] }] },
      }),
    )
    const v = readClaudeSettings(path)
    expect(v.hooks).toEqual({ briefing: 'installed', cronGate: 'missing' })
    const { view } = installSilosHooks(path, join(dir, 'bk'), hooksDir)
    expect(view.hooks).toEqual({ briefing: 'installed', cronGate: 'installed' })
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    expect(raw.hooks.SessionStart).toHaveLength(1) // the existing entry was not duplicated
    expect(raw.hooks.PreToolUse[0].matcher).toBe('CronCreate')
    // idempotent: a second install writes nothing new
    expect(installSilosHooks(path, join(dir, 'bk'), hooksDir).backup).toBeNull()
  })

  it('install writes each hook as hooks.json declares it: every source, a timeout, the path quoted for the shell', async () => {
    const { installSilosHooks, SILOS_HOOK_ENTRIES } = await import('../src/harnesses/claude-code/settings.js')
    const { mkdtempSync, mkdirSync, cpSync, readFileSync } = await import('node:fs')
    const { execFileSync } = await import('node:child_process')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const dir = mkdtempSync(join(tmpdir(), 'cs-'))
    // a hooks dir whose path has a space and a quote: the command must stay one word
    const hooksDir = join(dir, "it's a plugin", 'hooks')
    mkdirSync(hooksDir, { recursive: true })
    cpSync(fileURLToPath(new URL('../../plugin/hooks/', import.meta.url)), hooksDir, { recursive: true })
    const path = join(dir, 'settings.json')
    installSilosHooks(path, join(dir, 'bk'), hooksDir)
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    const start = raw.hooks.SessionStart[0]
    expect(start.matcher).toBe(SILOS_HOOK_ENTRIES.SessionStart.matcher)
    expect(start.matcher.split('|').sort()).toEqual(['clear', 'compact', 'fork', 'resume', 'startup'])
    expect(start.hooks[0].timeout).toBe(SILOS_HOOK_ENTRIES.SessionStart.timeout)
    expect(raw.hooks.PreToolUse[0].hooks[0].timeout).toBe(SILOS_HOOK_ENTRIES.PreToolUse.timeout)
    // run as Claude Code runs a command hook (sh -c): the quoted path resolves
    const out = execFileSync('sh', ['-c', raw.hooks.PreToolUse[0].hooks[0].command], {
      input: JSON.stringify({ tool_input: { recurring: true } }),
      env: { PATH: process.env.PATH ?? '', SILOS_AGENT_ID: 'writer', SILOS_API: 'http://127.0.0.1:9' },
      encoding: 'utf8',
    })
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('deny')
  })
  it("uninstall removes Silos' two hooks and nothing else; a second uninstall writes nothing", async () => {
    const { installSilosHooks, uninstallSilosHooks } = await import('../src/harnesses/claude-code/settings.js')
    const d = dir()
    const path = join(d, 'settings.json')
    const hooksDir = join(d, 'plugin', 'hooks')
    mkdirSync(hooksDir, { recursive: true })
    for (const s of ['session-start.sh', 'pre-cron.sh']) writeFileSync(join(hooksDir, s), '#!/bin/sh\n')
    const theirs = {
      model: 'opus',
      hooks: {
        SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: '/opt/tools/greet.sh' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/opt/tools/audit.sh' }] }],
        Stop: [{ hooks: [{ type: 'command', command: '/opt/tools/bell.sh' }] }],
      },
    }
    writeFileSync(path, JSON.stringify(theirs))
    installSilosHooks(path, join(d, 'bk'), hooksDir)
    // a Silos command that shares an entry with someone else's: only ours leaves it
    const mixed = JSON.parse(readFileSync(path, 'utf8'))
    mixed.hooks.SessionStart[0].hooks.push({ type: 'command', command: join(hooksDir, 'session-start.sh') })
    writeFileSync(path, JSON.stringify(mixed))
    const r = uninstallSilosHooks(path, join(d, 'bk'))
    expect(r.view.hooks).toEqual({ briefing: 'missing', cronGate: 'missing' })
    expect(r.backup && existsSync(r.backup)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(theirs)
    expect(uninstallSilosHooks(path, join(d, 'bk')).backup).toBeNull()
  })

  it('uninstall of a broken wiring works too, and leaves no empty `hooks` behind', async () => {
    const { uninstallSilosHooks } = await import('../src/harnesses/claude-code/settings.js')
    const d = dir()
    const path = join(d, 'settings.json')
    writeFileSync(
      path,
      JSON.stringify({
        theme: 'dark',
        hooks: {
          SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: join(d, 'gone', 'hooks', 'session-start.sh') }] }],
          PreToolUse: [{ matcher: 'CronCreate', hooks: [{ type: 'command', command: join(d, 'gone', 'hooks', 'pre-cron.sh') }] }],
        },
      }),
    )
    uninstallSilosHooks(path, join(d, 'bk'))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ theme: 'dark' })
  })

  it('a settings.json that is a symlink stays one: every writer goes through to the real file', async () => {
    const { installSilosHooks, uninstallSilosHooks, writeAgentPushNotif } = await import('../src/harnesses/claude-code/settings.js')
    const d = dir()
    const real = join(d, 'dotfiles', 'claude-settings.json')
    mkdirSync(join(d, 'dotfiles'))
    mkdirSync(join(d, 'home'))
    writeFileSync(real, JSON.stringify({ theme: 'dark' }))
    const path = join(d, 'home', 'settings.json')
    symlinkSync(join('..', 'dotfiles', 'claude-settings.json'), path) // relative, as dotfile managers write it
    const hooksDir = join(d, 'plugin', 'hooks')
    mkdirSync(hooksDir, { recursive: true })
    for (const s of ['session-start.sh', 'pre-cron.sh']) writeFileSync(join(hooksDir, s), '#!/bin/sh\n')
    const writers: Array<[() => unknown, (o: Record<string, any>) => void]> = [
      [() => installSilosHooks(path, join(d, 'bk'), hooksDir), (o) => expect(o.hooks.PreToolUse[0].matcher).toBe('CronCreate')],
      [() => uninstallSilosHooks(path, join(d, 'bk')), (o) => expect(o.hooks).toBeUndefined()],
      [() => writeAgentPushNotif(path, false, join(d, 'bk')), (o) => expect(o.agentPushNotifEnabled).toBe(false)],
      [() => writeCleanupPeriodDays(path, 90, join(d, 'bk')), (o) => expect(o.cleanupPeriodDays).toBe(90)],
    ]
    for (const [write, check] of writers) {
      write()
      expect(lstatSync(path).isSymbolicLink()).toBe(true)
      const o = JSON.parse(readFileSync(real, 'utf8'))
      expect(o.theme).toBe('dark')
      check(o)
    }
    // a link whose target does not exist yet: the file is created where it points
    const fresh = join(d, 'home', 'fresh.json')
    symlinkSync(join(d, 'dotfiles', 'fresh.json'), fresh)
    writeCleanupPeriodDays(fresh, 90, join(d, 'bk'))
    expect(lstatSync(fresh).isSymbolicLink()).toBe(true)
    expect(JSON.parse(readFileSync(join(d, 'dotfiles', 'fresh.json'), 'utf8'))).toEqual({ cleanupPeriodDays: 90 })
  })
})

// the ONE writer of the user's settings file (spec scopes §8): the five
// older writers and the «This machine» line go through it
describe("editUserSettings — the user file's one writer", () => {
  it('keeps every other key and entry; a no-op writes nothing', async () => {
    const { editUserSettings } = await import('../src/harnesses/claude-code/settings.js')
    const d = dir()
    const path = join(d, 'settings.json')
    const hooks = { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: '/x/session-start.sh' }] }] }
    writeFileSync(path, JSON.stringify({ hooks, model: 'opus', enabledPlugins: { a: true } }))
    editUserSettings(path, (o) => {
      ;(o.enabledPlugins as Record<string, boolean>).b = false
      return true
    })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ hooks, model: 'opus', enabledPlugins: { a: true, b: false } })
    const before = readFileSync(path, 'utf8')
    expect(editUserSettings(path, () => false)).toEqual({ changed: false, backup: null })
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it("refuses a file that isn't JSON, isn't an object or can't be read — untouched, the file named", async () => {
    const { editUserSettings, UserSettingsError } = await import('../src/harnesses/claude-code/settings.js')
    const d = dir()
    const path = join(d, 'settings.json')
    for (const bad of ['{ nope', '"a string"', '[]', 'null']) {
      writeFileSync(path, bad)
      let err: unknown = null
      try {
        editUserSettings(path, (o) => {
          o.x = 1
          return true
        })
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(UserSettingsError)
      expect((err as Error).message).toContain(path)
      expect(readFileSync(path, 'utf8')).toBe(bad)
    }
    // a directory where the file should be: can't be read
    const asDir = join(d, 'dir-settings.json')
    mkdirSync(asDir)
    expect(() =>
      editUserSettings(asDir, (o) => {
        o.x = 1
        return true
      }),
    ).toThrow(UserSettingsError)
    // absent: created
    const fresh = join(d, 'nested', 'settings.json')
    editUserSettings(fresh, (o) => {
      o.x = 1
      return true
    })
    expect(JSON.parse(readFileSync(fresh, 'utf8'))).toEqual({ x: 1 })
  })

  it("re-applies the change when the file moved before the rename — the other writer's key survives", async () => {
    const { editUserSettings } = await import('../src/harnesses/claude-code/settings.js')
    const d = dir()
    const path = join(d, 'settings.json')
    writeFileSync(path, JSON.stringify({ model: 'opus' }))
    let raced = false
    editUserSettings(
      path,
      (o) => {
        o.enabledPlugins = { a: false }
        return true
      },
      {
        beforeRename: () => {
          if (!raced) {
            raced = true
            writeFileSync(path, JSON.stringify({ model: 'opus', theme: 'light' }))
          }
        },
      },
    )
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ model: 'opus', theme: 'light', enabledPlugins: { a: false } })
    // no temp file left beside it
    expect(readdirSync(d).filter((f) => f.includes('.tmp-'))).toEqual([])
  })
})
