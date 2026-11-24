// claude-project-key.test.ts — the per-project entry of ~/.claude.json is
// keyed by the folder's CANONICAL GIT ROOT (Claude Code 2.1.316): the repo's
// top level for a subfolder, the MAIN checkout for a linked worktree, the
// folder itself outside a repo (third review round, defect 2). Every reader
// (the Claude inventory and loaded-at-start picture, the switches, loads/switch.ts) looks it up that way.
// Real temp git repos; the real ~/.claude.json is never read.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalGitRoot, claudeJsonProjectKeys, claudeJsonProjectOf } from '../src/claude-project-key.js'
import { claudeLoadsSwitch } from '../src/harnesses/claude-code/loads/switch.js'
import { mcpRowsOf, type McpRow } from './helpers/mcp-rows.js'
import { readClaudeLoadedAtStart } from '../src/harnesses/claude-code/loaded-at-start.js'
import type { Agent } from '../src/types.js'

let base: string, repo: string, web: string, wt: string, plain: string, claudeJsonPath: string
const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'deck-cpk-')))
  repo = join(base, 'repo')
  web = join(repo, 'web')
  wt = join(base, 'repo-wt')
  plain = join(base, 'plain')
  mkdirSync(web, { recursive: true })
  mkdirSync(plain, { recursive: true })
  git(repo, 'init', '-q')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  git(repo, 'worktree', 'add', '-q', wt)
  mkdirSync(join(wt, 'web'), { recursive: true })
  claudeJsonPath = join(base, '.claude.json') // `base` is the home the inventory reads
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('canonicalGitRoot — the key Claude Code computes', () => {
  it('a subfolder keys at the repo root; a worktree (and its subfolder) at the MAIN checkout; outside a repo, none', () => {
    expect(canonicalGitRoot(web)).toBe(repo)
    expect(canonicalGitRoot(repo)).toBe(repo)
    expect(canonicalGitRoot(wt)).toBe(repo)
    expect(canonicalGitRoot(join(wt, 'web'))).toBe(repo)
    expect(canonicalGitRoot(plain)).toBeNull()
  })

  it('a folder that does not exist answers null, never a throw; the keys fall back to the folder', () => {
    const gone = join(base, 'gone')
    expect(canonicalGitRoot(gone)).toBeNull()
    expect(claudeJsonProjectKeys(gone)).toEqual([gone])
    expect(claudeJsonProjectKeys(plain)).toEqual([plain])
    // inside a repo, only the git root — Claude Code reads nothing else there
    expect(claudeJsonProjectKeys(web)).toEqual([repo])
    expect(claudeJsonProjectKeys(join(wt, 'web'))).toEqual([repo])
  })

  it("the git root entry answers; inside a repo an entry under the subfolder's own path never does (Claude Code ignores it); outside, the folder's", () => {
    expect(claudeJsonProjectOf({ projects: { [repo]: { a: 1 }, [web]: { b: 2 } } }, web)).toEqual({ a: 1 })
    expect(claudeJsonProjectOf({ projects: { [web]: { b: 2 } } }, web)).toBeNull()
    expect(claudeJsonProjectOf({ projects: { [plain]: { c: 3 } } }, plain)).toEqual({ c: 3 })
    // keys are data: an inherited name never answers
    expect(claudeJsonProjectOf({ projects: {} }, 'constructor')).toBeNull()
  })
})

describe("the rows (the inventory) — the operator's per-project entry by git root", () => {
  const row = (rows: McpRow[], name: string, scope: string) => rows.find((r) => r.kind === 'mcp' && r.name === name && r.scope === scope)
  const operator = () =>
    writeFileSync(claudeJsonPath, JSON.stringify({ projects: { [repo]: { disabledMcpServers: ['db'], mcpServers: { op: { command: 'op-mcp' } } } } }))

  it("a subfolder of the repo: the operator's disable list holds its server and the operator's server is listed", () => {
    writeFileSync(join(web, '.mcp.json'), JSON.stringify({ mcpServers: { db: { command: 'db-mcp' } } }))
    operator()
    const rows = mcpRowsOf(web, base)
    expect(row(rows, 'db', 'project')).toMatchObject({ state: 'held', heldBy: 'user' })
    expect(row(rows, 'op', 'user')).toMatchObject({ state: 'active', detail: 'op-mcp' })
  })

  it("a linked worktree reads the MAIN checkout's entry", () => {
    writeFileSync(join(wt, 'web', '.mcp.json'), JSON.stringify({ mcpServers: { db: { command: 'db-mcp' } } }))
    operator()
    const rows = mcpRowsOf(join(wt, 'web'), base)
    expect(row(rows, 'db', 'project')).toMatchObject({ state: 'held', heldBy: 'user' })
    expect(row(rows, 'op', 'user')).toBeDefined()
    // turning it on is refused naming the operator's file — read-only
    expect(() =>
      claudeLoadsSwitch(
        { folder: join(wt, 'web'), home: base, managedDir: join(base, 'no-managed'), recentTranscripts: [], seenToolIds: [], readings: [] },
        'mcp:project:db',
        'on',
      ),
    ).toThrow(/~\/\.claude\.json/)
  })

  it('outside a repo the folder keys itself', () => {
    writeFileSync(join(plain, '.mcp.json'), JSON.stringify({ mcpServers: { db: { command: 'db-mcp' } } }))
    writeFileSync(claudeJsonPath, JSON.stringify({ projects: { [plain]: { disabledMcpServers: ['db'] } } }))
    expect(row(mcpRowsOf(plain, base), 'db', 'project')).toMatchObject({ state: 'held', heldBy: 'user' })
  })
})

describe("loaded-at-start — the operator's per-project servers by git root", () => {
  it("a conversation started in a repo subfolder lists the root entry's servers minus its disable list", () => {
    const home = join(base, 'home')
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [repo]: { mcpServers: { op: {}, gone: {} }, disabledMcpServers: ['gone'] } } }))
    const agent = { id: 'a', name: 'A', emoji: '', role: '', folder: web, skills: [] } as Agent
    const r = readClaudeLoadedAtStart(
      { agent, folder: web, home, agentStateDir: null, recentTranscripts: [], seenMcpServers: [] },
      { managedSettings: join(base, 'managed.json'), silosPlugin: join(base, 'silos-plugin') },
    )
    // the operator's own entry for the folder: your machine's (the inventory's origin)
    expect(r.mcp).toContainEqual({ name: 'op', source: 'user', from: '~/.claude.json · this folder' })
    expect(r.mcp.some((m) => m.name === 'gone')).toBe(false)
  })
})
