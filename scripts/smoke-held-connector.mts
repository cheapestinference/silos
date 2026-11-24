#!/usr/bin/env -S npx tsx
// smoke-held-connector.mts — what a folder's .claude/settings.local.json
// switches OFF must not load in an UNATTENDED turn. Those turns launch with
// settingSources ['user','project'] — the local layer, where every switch of
// Tools and Skills lives, is never read — so Silos carries the holds into the
// turn's flag-tier `settings` (harnesses/claude-code/local-holds.ts). This
// smoke proves, on a REAL `claude` (the one on PATH, the engine Silos' chats
// run — sdk.ts), that each key holds from the flag tier as it does from the
// local file: the spec's «not measured» row (tools-origin §11, T12).
//
// WHAT IT PREPARES (a temp folder, removed at the end):
//   .mcp.json             three stdio servers: silos-smoke-held, silos-smoke-denied,
//                         silos-smoke-active (an idle node process each)
//   .claude/settings.json enableAllProjectMcpServers: true (so all three WOULD load)
//   .claude/settings.local.json  rewritten for each case below
//
// WHAT IT RUNS — every launch is stopped right after the SDK's `system/init`
// message (its MCP servers, plugins and skills); hooks off in all of them:
//   B  baseline : user+project, nothing carried — what an unattended turn
//                 loaded before the holds; it also picks the subjects below
//                 from what THIS login really loads
//   per case, with that case's local file:
//   A  attended : user+project+local      → Claude Code reading the file itself
//   C  Silos    : user+project + withFilesCarried(...) in the flag tier → the fix
//
// THE CASES (one key each; a case whose subject this login does not load is
// skipped and said):
//   mcpjson          disabledMcpjsonServers: [silos-smoke-held]
//   denied           deniedMcpServers: [{serverName: silos-smoke-denied}]
//   plugin-server    deniedMcpServers: [{serverName: "plugin:<p>:<s>"}]   (the first plugin server B lists)
//   connector        deniedMcpServers: [{serverName: "claude.ai <Name>"}] (the first connector B lists)
//   connectors-off   disableClaudeAiConnectors: true
//   synced-plugin    enabledPlugins: {"<name>@synced": false}            (the first account plugin B lists)
//   synced-plugins   syncClaudeAiPlugins: false
//   synced-skills    syncClaudeAiSkills: false
//   skill-off        skillOverrides: {<skill>: "off"}  (SMOKE_SKILL=<name>, else a personal skill B lists)
//   personal-md      claudeMdExcludes: ["<config dir>/CLAUDE.md", "<config dir>/rules/**"]
//                    (personal-instructions.ts — Project › Memory's switch).
//                    The init message does not list instruction files, so
//                    this case reads them from the engine's InstructionsLoaded
//                    hook (an SDK callback; memory_type "User") and waits for
//                    the first reply instead of stopping at init — three
//                    launches that each spend one short turn. Its launches
//                    do NOT set disableAllHooks (it could silence the
//                    callback): your own hooks run in them. Skipped when the
//                    login has no personal CLAUDE.md; NOTHING TO SHOW when no
//                    InstructionsLoaded event reached the script at all.
//
// VERDICT per case, on the parts that case touches (servers / plugins /
// skills): PASS when C lists exactly what A lists; FAIL when they differ (the
// diff is printed); NOTHING TO SHOW when A lists what B lists (the key removed
// nothing on this login — the case cannot discriminate). The project cases
// also require silos-smoke-active in A and C (else the launch is broken).
// Exit 0 = no FAIL; 1 = a FAIL; 2 = a launch saw no init within the timeout.
//
// RUN (from the repo, with your normal claude login; each launch is
// interrupted at init, so it spends at most a few tokens; about 19 launches
// plus personal-md's three short turns,
// a few seconds each):
//   npx tsx scripts/smoke-held-connector.mts            every case
//   npx tsx scripts/smoke-held-connector.mts denied skill-off   only those
//   SMOKE_SKILL=<name> npx tsx scripts/smoke-held-connector.mts skill-off
//   npx tsx scripts/smoke-held-connector.mts scopes [case-prefix...]
//     the scopes measurement (smoke-scopes.mts): each key from each settings
//     tier, in a config dir of the smoke's own — read its head first
// It prints the names this login loads (servers, plugins, skills) — the
// output is yours; nothing is written outside the temp folder. The sessions
// are born under the temp folder (a /tmp scratch path Silos keeps out of its
// lists).
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { sdkQueryFn } from '../server/src/harnesses/claude-code/sdk.js'
import { filesCarry, withFilesCarried } from '../server/src/harnesses/claude-code/local-holds.js'
import { personalEntries } from '../server/src/harnesses/claude-code/personal-instructions.js'

if (process.argv[2] === 'scopes') {
  const { runScopes } = await import('./smoke-scopes.mjs')
  process.exit(await runScopes(process.argv.slice(3)))
}

const HELD = 'silos-smoke-held'
const DENIED = 'silos-smoke-denied'
const ACTIVE = 'silos-smoke-active'
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'silos-held-')))
const idle = { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1 << 30)'] }
mkdirSync(join(dir, '.claude'), { recursive: true })
writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { [HELD]: idle, [DENIED]: idle, [ACTIVE]: idle } }, null, 2))
writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ enableAllProjectMcpServers: true }, null, 2))
const localFile = join(dir, '.claude', 'settings.local.json')

type Sources = Array<'user' | 'project' | 'local'>
interface Snap {
  mcp: string[]
  plugins: Array<{ name: string; path: string }>
  skills: string[]
}
type Part = 'mcp' | 'plugins' | 'skills'

async function snapAtInit(label: string, settingSources: Sources, settings: Record<string, unknown>): Promise<Snap | null> {
  const handle = sdkQueryFn({
    prompt: 'Reply with the single word OK.',
    options: { cwd: dir, settingSources, settings, permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, maxTurns: 1 },
  })
  const timer = setTimeout(() => {
    console.log(`  ${label}: TIMEOUT waiting for init`)
    void handle.interrupt()
  }, 120_000)
  try {
    for await (const m of handle as AsyncIterable<Record<string, unknown>>) {
      if (m.type === 'system' && m.subtype === 'init') {
        await handle.interrupt().catch(() => {})
        const servers = (Array.isArray(m.mcp_servers) ? m.mcp_servers : []) as Array<{ name: string }>
        return {
          mcp: servers.map((s) => s.name).sort(),
          plugins: ((Array.isArray(m.plugins) ? m.plugins : []) as Array<{ name: string; path: string }>).map((p) => ({ name: p.name, path: p.path })),
          skills: ((Array.isArray(m.skills) ? m.skills : []) as string[]).slice().sort(),
        }
      }
    }
  } catch (err) {
    console.log(`  ${label}: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearTimeout(timer)
  }
  return null
}

/** The User instruction files a start loads, as the engine's InstructionsLoaded
 *  hook names them — read until the first reply, then the turn is stopped. */
async function personalAtStart(label: string, settingSources: Sources, settings: Record<string, unknown>): Promise<{ events: number; user: string[] } | null> {
  const user = new Set<string>()
  let events = 0
  const handle = sdkQueryFn({
    prompt: 'Reply with the single word OK.',
    options: {
      cwd: dir,
      settingSources,
      settings,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 1,
      hooks: {
        InstructionsLoaded: [
          {
            hooks: [
              async (input: Record<string, unknown>) => {
                events++
                if (input.memory_type === 'User' && typeof input.file_path === 'string') user.add(input.file_path)
                return {}
              },
            ],
          },
        ],
      },
    } as never,
  })
  const timer = setTimeout(() => {
    console.log(`  ${label}: TIMEOUT waiting for a reply`)
    void handle.interrupt()
  }, 120_000)
  try {
    for await (const m of handle as AsyncIterable<Record<string, unknown>>) {
      if (m.type === 'assistant' || m.type === 'result') {
        await handle.interrupt().catch(() => {})
        return { events, user: [...user].sort() }
      }
    }
  } catch (err) {
    console.log(`  ${label}: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearTimeout(timer)
  }
  return null
}

const partOf = (s: Snap, p: Part): string[] => (p === 'plugins' ? s.plugins.map((x) => x.name).sort() : s[p])
const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])
const minus = (a: string[], b: string[]): string[] => a.filter((x) => !b.includes(x))
const isSynced = (p: { path: string }): boolean => p.path.includes(`${sep}plugins${sep}synced${sep}`)

interface Case {
  id: string
  local: Record<string, unknown>
  parts: Part[]
  control?: true
}

let code = 0
try {
  console.log(`folder: ${dir}`)
  writeFileSync(localFile, '{}')
  const base = await snapAtInit('B baseline', ['user', 'project'], { disableAllHooks: true })
  if (base === null) {
    console.log('RESULT: no init seen — inconclusive')
    throw new Error('no baseline')
  }
  console.log(
    `B baseline — servers ${JSON.stringify(base.mcp)}\n  plugins ${JSON.stringify(base.plugins.map((p) => p.name))}\n  skills ${JSON.stringify(base.skills)}`,
  )

  const pluginServer = base.mcp.find((n) => n.startsWith('plugin:'))
  const connector = base.mcp.find((n) => n.startsWith('claude.ai '))
  const synced = base.plugins.find(isSynced)
  const personal = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'skills')
  const skill = process.env.SMOKE_SKILL ?? base.skills.find((n) => !n.includes(':') && existsSync(join(personal, n)))

  const all: Array<Case | { id: string; skip: string }> = [
    { id: 'mcpjson', local: { disabledMcpjsonServers: [HELD] }, parts: ['mcp'], control: true },
    { id: 'denied', local: { deniedMcpServers: [{ serverName: DENIED }] }, parts: ['mcp'], control: true },
    pluginServer
      ? { id: 'plugin-server', local: { deniedMcpServers: [{ serverName: pluginServer }] }, parts: ['mcp'] }
      : { id: 'plugin-server', skip: 'no plugin server loads on this login' },
    connector
      ? { id: 'connector', local: { deniedMcpServers: [{ serverName: connector }] }, parts: ['mcp'] }
      : { id: 'connector', skip: 'no claude.ai connector in the baseline' },
    { id: 'connectors-off', local: { disableClaudeAiConnectors: true }, parts: ['mcp'] },
    synced
      ? { id: 'synced-plugin', local: { enabledPlugins: { [`${synced.name}@synced`]: false } }, parts: ['plugins', 'mcp', 'skills'] }
      : { id: 'synced-plugin', skip: 'no plugin from the Claude account loads on this login' },
    { id: 'synced-plugins', local: { syncClaudeAiPlugins: false }, parts: ['plugins', 'mcp', 'skills'] },
    { id: 'synced-skills', local: { syncClaudeAiSkills: false }, parts: ['skills'] },
    skill
      ? { id: 'skill-off', local: { skillOverrides: { [skill]: 'off' } }, parts: ['skills'] }
      : { id: 'skill-off', skip: 'no personal skill in the baseline — set SMOKE_SKILL=<name>' },
  ]
  const only = process.argv.slice(2)
  const verdicts: string[] = []
  for (const c of all) {
    if (only.length > 0 && !only.includes(c.id)) continue
    if ('skip' in c) {
      verdicts.push(`${c.id}: SKIPPED — ${c.skip}`)
      continue
    }
    console.log(`\n${c.id} — settings.local.json ${JSON.stringify(c.local)}`)
    writeFileSync(localFile, JSON.stringify(c.local, null, 2))
    const carried = withFilesCarried({ disableAllHooks: true }, filesCarry(dir, { sources: ['user', 'project'] }))
    console.log(`  carried in the flag tier: ${JSON.stringify(carried)}`)
    const a = await snapAtInit('A attended', ['user', 'project', 'local'], { disableAllHooks: true })
    const s = await snapAtInit('C Silos', ['user', 'project'], carried)
    if (a === null || s === null) {
      verdicts.push(`${c.id}: NO INIT`)
      if (code === 0) code = 2
      continue
    }
    if (c.control && (!a.mcp.includes(ACTIVE) || !s.mcp.includes(ACTIVE))) {
      verdicts.push(`${c.id}: FAIL — ${ACTIVE} did not load, the launch is broken`)
      code = 1
      continue
    }
    const diffs = c.parts.filter((p) => !same(partOf(a, p), partOf(s, p)))
    const removed = c.parts.flatMap((p) => minus(partOf(base, p), partOf(a, p)).map((x) => `${p}:${x}`))
    if (diffs.length > 0) {
      code = 1
      verdicts.push(`${c.id}: FAIL — the flag tier does not hold like the local file`)
      for (const p of diffs)
        console.log(`  ${p}: only in A ${JSON.stringify(minus(partOf(a, p), partOf(s, p)))} · only in C ${JSON.stringify(minus(partOf(s, p), partOf(a, p)))}`)
    } else if (removed.length === 0) {
      verdicts.push(`${c.id}: NOTHING TO SHOW — the key removed nothing on this login (A lists what B lists)`)
    } else {
      verdicts.push(`${c.id}: PASS — removed ${JSON.stringify(removed)} in both`)
    }
  }
  // personal-md: the User files a start loads, with the exclusions in the
  // local file (A) and carried in the flag tier (C), against none (B)
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  if (only.length === 0 || only.includes('personal-md')) {
    if (!existsSync(join(configDir, 'CLAUDE.md'))) verdicts.push(`personal-md: SKIPPED — no ${join(configDir, 'CLAUDE.md')} on this login`)
    else {
      const local = { claudeMdExcludes: personalEntries([configDir]) }
      console.log(`\npersonal-md — settings.local.json ${JSON.stringify(local)}`)
      writeFileSync(localFile, '{}')
      const b = await personalAtStart('B baseline', ['user', 'project'], {})
      writeFileSync(localFile, JSON.stringify(local, null, 2))
      const carried = withFilesCarried({}, filesCarry(dir, { sources: ['user', 'project'] }))
      console.log(`  carried in the flag tier: ${JSON.stringify(carried)}`)
      const a = await personalAtStart('A attended', ['user', 'project', 'local'], {})
      const c = await personalAtStart('C Silos', ['user', 'project'], carried)
      if (b === null || a === null || c === null) {
        verdicts.push('personal-md: NO REPLY')
        if (code === 0) code = 2
      } else {
        console.log(`  User files — B ${JSON.stringify(b.user)} · A ${JSON.stringify(a.user)} · C ${JSON.stringify(c.user)}`)
        if (b.events === 0) verdicts.push('personal-md: NOTHING TO SHOW — no InstructionsLoaded event reached the script')
        else if (b.user.length === 0) verdicts.push('personal-md: NOTHING TO SHOW — the baseline loaded no User file')
        else if (a.user.length > 0 || c.user.length > 0) {
          code = 1
          verdicts.push(`personal-md: FAIL — still loaded: A ${JSON.stringify(a.user)} · C ${JSON.stringify(c.user)}`)
        } else verdicts.push(`personal-md: PASS — ${JSON.stringify(b.user)} kept out in both`)
      }
    }
  }
  console.log(`\n${verdicts.join('\n')}`)
  console.log(
    code === 0
      ? 'RESULT: PASS — no key the local file switches off loaded in an unattended turn'
      : code === 1
        ? 'RESULT: FAIL'
        : 'RESULT: inconclusive — a launch saw no init',
  )
} catch (err) {
  if (!(err instanceof Error && err.message === 'no baseline')) throw err
  code = 2
} finally {
  rmSync(dir, { recursive: true, force: true })
}
process.exit(code)
