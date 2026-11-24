#!/usr/bin/env -S npx tsx
// smoke-scopes.mts — measures, on a REAL `claude` at a session start, how
// each key of a Silos place reads from each settings tier (user ‹ project ‹
// local ‹ flag): the «unmeasured» and «schema» rows of the scopes spec's
// engine-facts table (scopes §10, task T1). Run through the held-connector
// smoke: `npx tsx scripts/smoke-held-connector.mts scopes [case-prefix...]`
// (or this file directly with the same arguments).
//
// ITS BED — a Claude config dir of the smoke's own:
//   $SILOS_SMOKE_CONFIG_DIR, default ~/.silos-smoke/claude
// It must sit OUTSIDE <dataDir>/claude-accounts/ (nothing follows it, no
// watcher rewrites it mid-case, no Silos conversation runs on it) and must
// not be ~/.claude or the shell's own CLAUDE_CONFIG_DIR — the script refuses
// otherwise. The owner signs in to it once with Claude's own command:
//   CLAUDE_CONFIG_DIR=<bed> claude auth login
// The script asks `claude auth status --json` whether it is signed in (it
// reads only `loggedIn`) and never opens, copies or keeps a credential. Not
// signed in → every case is SKIPPED (each launches a session) and the
// sign-in line is printed. Every launch runs with CLAUDE_CONFIG_DIR=<bed>
// and without the shell's ANTHROPIC_* / CLAUDE_CODE_OAUTH_TOKEN, so the bed's
// login is the one used.
//
// WHAT IT WRITES — only inside the bed and two temp folders, all put back:
//   bed: settings.json (the user tier, rewritten per case and restored after
//        each one in a finally), personal skills it creates under skills/
//        (never over an existing one), CLAUDE.md when the bed has none, and a
//        local test plugin installed with Claude's own `claude plugin
//        marketplace add` / `install --scope user` and removed with its
//        `uninstall` / `marketplace remove` at the end. settings.json and
//        plugins/{installed_plugins,known_marketplaces}.json are snapshotted
//        first and written back byte for byte at the end. A journal
//        (<bed>/.silos-smoke-journal.json) records all of it before each
//        write, so a run killed mid-case is undone by the next run's start.
//   temp project (the sessions' cwd): .mcp.json, .claude/settings.json
//        (the repository tier), .claude/settings.local.json, .claude/skills.
//   temp marketplace: the test plugin's source.
// Never ~/.claude/settings.json, never an account under claude-accounts/.
// The two user-tier sync cases run LAST: they make Claude Code move the
// bed's synced copies to its own trash; it downloads them again at the
// bed's next start once the key is back (this script puts it back).
//
// EACH LAUNCH is stopped right after `system/init` (servers, plugins,
// skills) and the initialize answer (the command rows, to tell two copies
// of a skill apart by their descriptions) — hooks off — except the
// claudeMdExcludes cases, which read the engine's InstructionsLoaded hook and
// so wait for the first reply (one short turn each, five in all).
//
// THE CASES (filter by id prefix: `scopes u-` runs the user-tier ones):
//   u-*  the user tier, per key: enabledPlugins (test plugin; account
//        plugin `<name>@synced`), deniedMcpServers (plugin server,
//        connector), disabledMcpjsonServers, disableClaudeAiConnectors,
//        skillOverrides
//   c-*  controls: the wider «off» alone (local plugin off, skill off in
//        the repository, local and flag tiers)
//   p-*  an «on» over a wider «off»: flag over local and local over user,
//        for enabledPlugins (test plugin and `@synced`) and skillOverrides;
//        the repository's file over the user file for skillOverrides
//   s-*  skillOverrides «off» from the flag tier on a project skill (and
//        the local file's, its control)
//   r-*  reach on a name two skills share, entry at each tier: a personal
//        copy beside the account's copy, and a personal copy beside a
//        project copy
//   l-*  skills the engine locks (author: disable-model-invocation; a
//        plugin's; the reserved name __proto__): an «off» at user, local
//        and flag must change nothing
//   m-*  claudeMdExcludes on the bed's CLAUDE.md, from each tier
//   x-*  the repository's file carried into a launch that skips it
//        (settingSources ['user'] + the file's keys in the flag tier), for an
//        «off» and for an «on» over the user file's «off»
//   t-*  rule 14 through Silos' own carry (local-holds.ts filesCarry): the
//        flag tier a run builds from the files it skips — the local file's
//        «on» over the user file's «off», the repository's «on» in a launch
//        without projectSettings, the local file over the repository's —
//        and a heartbeat's, which takes every «off» and no «on»
//   z-*  the user-tier sync keys (syncClaudeAiSkills / syncClaudeAiPlugins
//        false) — in this bed only
// A case whose subject this login does not load (no account plugin, no
// connector…) is SKIPPED and says why.
//
// VERDICTS: PASS = observed as the spec's table expects; FAIL = it does
// not (the fact is wrong as written); NOTED = the spec makes no claim, the
// observation is the measurement; NOTHING TO SHOW = an «on over off» case
// whose control showed the wider «off» does not hold alone (it cannot
// discriminate); NO INIT = the launch never reached init. The summary is a
// table — case · tier · subject · expected · observed · verdict — under the
// CLI version every line was seen on.
// Exit 0 = no FAIL; 1 = a FAIL; 2 = a launch saw no init; 3 = the bed is
// not signed in (nothing measured).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sdkQueryFn } from '../server/src/harnesses/claude-code/sdk.js'
import { claudeOnPath } from '../server/src/harnesses/claude-code/binary.js'
import { filesCarry, withFilesCarried } from '../server/src/harnesses/claude-code/local-holds.js'

type Json = Record<string, unknown>
type Source = 'user' | 'project' | 'local'
interface Snap {
  mcp: string[]
  plugins: string[]
  pluginPaths: Array<{ name: string; path: string }>
  skills: string[]
  commands: Array<{ name: string; description: string }>
  version: string | null
  /** InstructionsLoaded: events seen and the User files loaded (m-* only) */
  instr?: { events: number; user: string[] }
}
interface Check {
  subject: string
  observe: (s: Snap) => string
  /** what the baseline must show, or the subject is not there to measure */
  baseline: string
  /** the spec's claim; null = no claim (NOTED) */
  expected: string | null
  skip?: string
}
interface Case {
  id: string
  tier: string
  user?: Json
  project?: Json
  local?: Json
  flag?: Json
  /** a t- case: the flag tier is Silos' own carry of the files the launch skips, as a run or a heartbeat gets it */
  carry?: 'run' | 'heartbeat'
  sources?: Source[]
  instr?: true
  /** an «on over off» case: the id of the case that shows the wider «off» alone */
  control?: string
  checks: Check[]
}
type Verdict = 'PASS' | 'FAIL' | 'SKIPPED' | 'NOTED' | 'NOTHING TO SHOW' | 'NO INIT'
interface Row {
  id: string
  tier: string
  subject: string
  expected: string
  observed: string
  verdict: Verdict
  note?: string
}

// ── names (all data; __proto__ included) ─────────────────────────────────
const MKT = 'silos-smoke'
const PLUGIN = 'silos-smoke-demo'
const PLUGIN_ID = `${PLUGIN}@${MKT}`
const PLUGIN_SERVER = `plugin:${PLUGIN}:idle`
const PLUGIN_SKILL = 'silos-smoke-plugin-skill'
const MCPJSON = 'silos-smoke-mcp'
const SOLO = 'silos-smoke-solo'
const TWIN = 'silos-smoke-twin'
const PROJ = 'silos-smoke-proj'
const AUTHOR = 'silos-smoke-author'
const RESERVED = '__proto__'
const PERSONAL_MARK = '[silos-smoke personal]'
const PROJECT_MARK = '[silos-smoke project]'
const ALL: Source[] = ['user', 'project', 'local']

const isMap = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const own = (o: Json, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined)
/** An own data property even for `__proto__` (plain assignment would set the prototype). */
const put = (o: Json, k: string, v: unknown): void => {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true })
}
const obj = (...pairs: Array<[string, unknown]>): Json => {
  const o: Json = {}
  for (const [k, v] of pairs) put(o, k, v)
  return o
}
/** base ⊕ add: maps merged per key, lists joined, anything else replaced. */
function merged(base: Json, add: Json): Json {
  const out: Json = {}
  for (const k of Object.keys(base)) put(out, k, base[k])
  for (const k of Object.keys(add)) {
    const a = add[k]
    const b = own(out, k)
    put(out, k, isMap(a) && isMap(b) ? merged(b, a) : Array.isArray(a) && Array.isArray(b) ? [...b, ...a] : a)
  }
  return out
}
const readOr = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
const restoreBytes = (path: string, bytes: string | null): void => {
  if (bytes === null) {
    if (existsSync(path)) unlinkSync(path)
  } else writeFileSync(path, bytes)
}
const within = (root: string, p: string): boolean => {
  const r = relative(root, p)
  return r !== '' && !r.startsWith('..') && !isAbsolute(r)
}

// ── the bed ──────────────────────────────────────────────────────────────
function bedDir(): { bed: string } | { refuse: string } {
  const home = homedir()
  const bed = resolve(process.env.SILOS_SMOKE_CONFIG_DIR ?? join(home, '.silos-smoke', 'claude'))
  const dataDir = resolve(process.env.SILOS_DATA_DIR ?? join(home, '.silos'))
  const accounts = join(dataDir, 'claude-accounts')
  const real = (p: string): string => {
    try {
      return realpathSync(p)
    } catch {
      return p
    }
  }
  if (bed === accounts || within(accounts, bed) || within(real(accounts), real(bed)))
    return { refuse: `${bed} is under ${accounts}: an account Silos runs is never the bed` }
  const forbidden = [join(home, '.claude'), process.env.CLAUDE_CONFIG_DIR].filter((x): x is string => !!x).map((p) => real(resolve(p)))
  if (forbidden.includes(real(bed))) return { refuse: `${bed} is a login you use (~/.claude or this shell's CLAUDE_CONFIG_DIR): the bed is the smoke's own` }
  if (within(bed, join(home, '.claude')) || within(real(join(home, '.claude')), real(bed))) return { refuse: `${bed} overlaps ~/.claude` }
  return { bed }
}

/** The environment of every bed process: the bed's login and nothing else. */
function bedEnv(bed: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (k === 'CLAUDE_CONFIG_DIR' || k.startsWith('ANTHROPIC_') || k === 'CLAUDE_CODE_OAUTH_TOKEN') continue
    env[k] = v
  }
  env.CLAUDE_CONFIG_DIR = bed
  return env
}

function claudeCli(bed: string, args: string[]): { status: number | null; out: string } {
  const bin = claudeOnPath() ?? 'claude'
  const r = spawnSync(bin, args, { env: bedEnv(bed), encoding: 'utf8', timeout: 120_000 })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}

/** `claude auth status --json` → loggedIn only; the rest of the answer is not kept. */
function signedIn(bed: string): boolean {
  const r = claudeCli(bed, ['auth', 'status', '--json'])
  try {
    const j: unknown = JSON.parse(r.out.slice(r.out.indexOf('{')))
    return isMap(j) && j.loggedIn === true
  } catch {
    return false
  }
}

// ── the journal: everything written to the bed, recorded before the write ─
interface Journal {
  files: Record<string, string | null>
  created: string[]
  plugin: boolean
}
const SNAPSHOT = ['settings.json', join('plugins', 'installed_plugins.json'), join('plugins', 'known_marketplaces.json')]

function journalPath(bed: string): string {
  return join(bed, '.silos-smoke-journal.json')
}
function saveJournal(bed: string, j: Journal): void {
  writeFileSync(journalPath(bed), JSON.stringify(j, null, 2), { mode: 0o600 })
}

/** Put the bed back as the journal says: the test plugin out, the files the
 *  smoke created removed, the snapshotted files restored byte for byte. */
function undo(bed: string, j: Journal): void {
  if (j.plugin) {
    claudeCli(bed, ['plugin', 'uninstall', PLUGIN_ID, '--scope', 'user'])
    claudeCli(bed, ['plugin', 'marketplace', 'remove', MKT, '--scope', 'user'])
  }
  for (const rel of j.created) {
    const p = resolve(bed, rel)
    if (within(bed, p)) rmSync(p, { recursive: true, force: true })
  }
  for (const [rel, bytes] of Object.entries(j.files)) {
    const p = resolve(bed, rel)
    if (within(bed, p)) restoreBytes(p, bytes)
  }
  if (existsSync(journalPath(bed))) unlinkSync(journalPath(bed))
}

// ── one launch ───────────────────────────────────────────────────────────
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let t: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      p,
      new Promise<null>((r) => {
        t = setTimeout(() => r(null), ms)
      }),
    ])
  } finally {
    clearTimeout(t)
  }
}

async function launch(label: string, cwd: string, bed: string, sources: Source[], flag: Json, instr: boolean): Promise<Snap | null> {
  const user = new Set<string>()
  let events = 0
  const options: Json = {
    cwd,
    env: bedEnv(bed),
    settingSources: sources,
    settings: instr ? flag : merged({ disableAllHooks: true }, flag),
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    maxTurns: 1,
  }
  if (instr) {
    options.hooks = {
      InstructionsLoaded: [
        {
          hooks: [
            async (input: Json) => {
              events++
              if (input.memory_type === 'User' && typeof input.file_path === 'string') user.add(input.file_path)
              return {}
            },
          ],
        },
      ],
    }
  }
  const handle = sdkQueryFn({ prompt: 'Reply with the single word OK.', options: options as never })
  const timer = setTimeout(() => {
    console.log(`  ${label}: TIMEOUT`)
    void handle.interrupt()
  }, 120_000)
  let snap: Snap | null = null
  try {
    for await (const m of handle as unknown as AsyncIterable<Json>) {
      if (m.type === 'system' && m.subtype === 'init') {
        const init = handle.initializationResult ? await withTimeout(handle.initializationResult(), 15_000) : null
        const rows = isMap(init) && Array.isArray(init.commands) ? (init.commands as Array<Json>) : []
        const plugins = (Array.isArray(m.plugins) ? m.plugins : []) as Array<{ name: string; path: string }>
        snap = {
          mcp: ((Array.isArray(m.mcp_servers) ? m.mcp_servers : []) as Array<{ name: string }>).map((s) => s.name).sort(),
          plugins: plugins.map((p) => p.name).sort(),
          pluginPaths: plugins.map((p) => ({ name: p.name, path: p.path })),
          skills: ((Array.isArray(m.skills) ? m.skills : []) as string[]).slice().sort(),
          commands: rows.filter((r) => r.builtin !== true).map((r) => ({ name: String(r.name), description: String(r.description ?? '') })),
          version: typeof m.claude_code_version === 'string' ? m.claude_code_version : null,
        }
        if (!instr) {
          await handle.interrupt().catch(() => {})
          break
        }
      }
      if (instr && snap && (m.type === 'assistant' || m.type === 'result')) {
        await handle.interrupt().catch(() => {})
        snap.instr = { events, user: [...user].sort() }
        break
      }
    }
  } catch (err) {
    console.log(`  ${label}: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearTimeout(timer)
    try {
      handle.close?.()
    } catch {
      /* already closed */
    }
  }
  if (instr && snap && !snap.instr) return null
  return snap
}

// ── observations ─────────────────────────────────────────────────────────
const onOff = (b: boolean): string => (b ? 'on' : 'off')
const pluginOn =
  (name: string) =>
  (s: Snap): string =>
    onOff(s.plugins.includes(name))
const serverOn =
  (name: string) =>
  (s: Snap): string =>
    onOff(s.mcp.includes(name))
const skillOn =
  (name: string) =>
  (s: Snap): string =>
    onOff(s.skills.includes(name))
/** a skill the model never sees (disable-model-invocation): its command row */
const commandOn =
  (name: string) =>
  (s: Snap): string =>
    onOff(s.commands.some((c) => c.name === name))
const pluginSkillOn = (s: Snap): string => onOff(s.skills.some((n) => n === PLUGIN_SKILL || n.endsWith(`:${PLUGIN_SKILL}`)))
/** Which copies of a shared name the session lists, told apart by description. */
const copies =
  (name: string, other: string) =>
  (s: Snap): string => {
    const labels = new Set(
      s.commands
        .filter((c) => c.name === name)
        .map((c) => (c.description.includes(PERSONAL_MARK) ? 'personal' : c.description.includes(PROJECT_MARK) ? 'project' : other)),
    )
    return labels.size === 0 ? 'none' : [...labels].sort().join('+')
  }
const instrState =
  (md: string) =>
  (s: Snap): string =>
    s.instr && s.instr.user.includes(md) ? 'loaded' : 'excluded'

// ── fixtures ─────────────────────────────────────────────────────────────
const skillMd = (name: string, mark: string, extra = ''): string =>
  `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(`${mark} fixture of the Silos scopes smoke; never invoke it.`)}\n${extra}---\nFixture of scripts/smoke-scopes.mts. Do nothing.\n`

function writeMarketplace(dir: string): void {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(dir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify(
      {
        name: MKT,
        owner: { name: 'Silos smoke' },
        plugins: [{ name: PLUGIN, source: `./${PLUGIN}`, description: 'Fixture of the Silos scopes smoke.' }],
      },
      null,
      2,
    ),
  )
  const p = join(dir, PLUGIN)
  mkdirSync(join(p, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(p, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: PLUGIN, version: '0.0.1', description: 'Fixture of the Silos scopes smoke.' }, null, 2),
  )
  writeFileSync(
    join(p, '.mcp.json'),
    JSON.stringify({ mcpServers: { idle: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1 << 30)'] } } }, null, 2),
  )
  mkdirSync(join(p, 'skills', PLUGIN_SKILL), { recursive: true })
  writeFileSync(join(p, 'skills', PLUGIN_SKILL, 'SKILL.md'), skillMd(PLUGIN_SKILL, '[silos-smoke plugin]'))
}

// ── the run ──────────────────────────────────────────────────────────────
const GROUPS = 'u- c- p- s- r- l- m- x- t- z-'

export async function runScopes(argv: string[]): Promise<number> {
  const only = argv
  const picked = (id: string): boolean => only.length === 0 || only.some((p) => id.startsWith(p))
  const where = bedDir()
  if ('refuse' in where) {
    console.log(`REFUSED: ${where.refuse}. Set SILOS_SMOKE_CONFIG_DIR to a folder of the smoke's own.`)
    return 3
  }
  const bed = where.bed
  const signIn = `! CLAUDE_CONFIG_DIR=${bed} claude auth login`
  const runLine = `npx tsx scripts/smoke-held-connector.mts scopes${only.length ? ` ${only.join(' ')}` : ''}`
  const cliVersion = claudeCli(bed, ['--version']).out.split('\n')[0] ?? '?'
  console.log(`bed: ${bed}\nclaude: ${cliVersion}`)
  mkdirSync(bed, { recursive: true, mode: 0o700 })
  if (!signedIn(bed)) {
    console.log(`\nSKIPPED — every case (${GROUPS}) starts a session and needs the bed's own login; the bed is not signed in.`)
    console.log(
      `Sign in once (Claude's own command; the smoke never reads the credential):\n  ${signIn}\n(drop the leading «!» in a plain shell), then run:\n  ${runLine}`,
    )
    console.log('RESULT: SKIPPED — nothing measured')
    return 3
  }

  const stale = readOr(journalPath(bed))
  if (stale !== null) {
    console.log('A previous run did not finish: putting the bed back as its journal says.')
    try {
      undo(bed, JSON.parse(stale) as Journal)
    } catch (err) {
      console.log(`  could not undo it (${err instanceof Error ? err.message : String(err)}) — fix ${journalPath(bed)} by hand`)
      return 2
    }
  }

  const journal: Journal = { files: {}, created: [], plugin: false }
  for (const rel of SNAPSHOT) journal.files[rel] = readOr(join(bed, rel))
  saveJournal(bed, journal)
  const userFile = join(bed, 'settings.json')
  const userJson = (bytes: string | null): Json | null => {
    if (bytes === null) return {}
    try {
      const j: unknown = JSON.parse(bytes)
      return isMap(j) ? j : null
    } catch {
      return null
    }
  }
  if (userJson(journal.files['settings.json'] ?? null) === null) {
    console.log(`REFUSED: ${userFile} does not parse — the smoke will not rewrite it`)
    undo(bed, journal)
    return 2
  }

  const project = realpathSync(mkdtempSync(join(tmpdir(), 'silos-scopes-')))
  const market = realpathSync(mkdtempSync(join(tmpdir(), 'silos-scopes-mkt-')))
  const projectFile = join(project, '.claude', 'settings.json')
  const localFile = join(project, '.claude', 'settings.local.json')
  const projectBase: Json = { enableAllProjectMcpServers: true }
  const rows: Row[] = []
  let code = 0
  try {
    console.log(`project: ${project}`)
    // the project: an .mcp.json server, its approval, project skills
    mkdirSync(join(project, '.claude', 'skills'), { recursive: true })
    writeFileSync(
      join(project, '.mcp.json'),
      JSON.stringify({ mcpServers: { [MCPJSON]: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1 << 30)'] } } }, null, 2),
    )
    writeFileSync(projectFile, JSON.stringify(projectBase, null, 2))
    writeFileSync(localFile, '{}')
    for (const [name, mark] of [
      [PROJ, PROJECT_MARK],
      [TWIN, PROJECT_MARK],
    ] as const) {
      mkdirSync(join(project, '.claude', 'skills', name), { recursive: true })
      writeFileSync(join(project, '.claude', 'skills', name, 'SKILL.md'), skillMd(name, mark))
    }

    // the bed: personal skills and CLAUDE.md, never over what is there
    const fixtureSkill = (name: string, extra = ''): boolean => {
      const d = join(bed, 'skills', name)
      if (existsSync(d)) {
        console.log(`  ${d} exists — the smoke does not touch it; its cases are skipped`)
        return false
      }
      journal.created.push(join('skills', name))
      saveJournal(bed, journal)
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'SKILL.md'), skillMd(name, PERSONAL_MARK, extra))
      return true
    }
    const have = {
      solo: fixtureSkill(SOLO),
      twin: fixtureSkill(TWIN),
      author: fixtureSkill(AUTHOR, 'disable-model-invocation: true\n'),
      reserved: fixtureSkill(RESERVED),
    }
    const md = join(bed, 'CLAUDE.md')
    if (!existsSync(md)) {
      journal.created.push('CLAUDE.md')
      saveJournal(bed, journal)
      writeFileSync(md, '# Silos scopes smoke\n\nA fixture of the smoke. Nothing to do here.\n')
    }

    // the test plugin, with Claude's own commands (user scope = the bed)
    writeMarketplace(market)
    journal.plugin = true
    saveJournal(bed, journal)
    const added = claudeCli(bed, ['plugin', 'marketplace', 'add', market, '--scope', 'user', '--json'])
    const installed = added.status === 0 ? claudeCli(bed, ['plugin', 'install', PLUGIN_ID, '--scope', 'user', '--json']) : added
    const pluginSkip = installed.status === 0 ? undefined : `the test plugin did not install: ${installed.out.split('\n').pop() ?? ''}`
    if (pluginSkip) console.log(`  ${pluginSkip}`)

    const S0 = readOr(userFile)
    const s0 = userJson(S0) ?? {}
    const writeTiers = (c: Case): void => {
      if (c.user) writeFileSync(userFile, JSON.stringify(merged(s0, c.user), null, 2))
      if (c.project) writeFileSync(projectFile, JSON.stringify(merged(projectBase, c.project), null, 2))
      if (c.local) writeFileSync(localFile, JSON.stringify(c.local, null, 2))
    }
    const restoreTiers = (): void => {
      restoreBytes(userFile, S0)
      writeFileSync(projectFile, JSON.stringify(projectBase, null, 2))
      writeFileSync(localFile, '{}')
    }

    // baselines: B0 → which skills the account sends (D: the flag's
    // syncClaudeAiSkills false, measured 23-11) → a personal copy of one →
    // B, the baseline every case compares with
    const b0 = await launch('B0 baseline', project, bed, ALL, {}, false)
    if (b0 === null) {
      console.log('RESULT: inconclusive — the baseline saw no init')
      return 2
    }
    const d = await launch('D account skills off', project, bed, ALL, { syncClaudeAiSkills: false }, false)
    const ours = (n: string): boolean => n.startsWith('silos-smoke') || n === RESERVED || n.endsWith(`:${PLUGIN_SKILL}`)
    const accountSkill = d ? b0.skills.filter((n) => !d.skills.includes(n) && !ours(n) && /^[A-Za-z0-9._-]+$/.test(n))[0] : undefined
    const shared = accountSkill !== undefined && fixtureSkill(accountSkill) ? accountSkill : undefined
    const base = await launch('B baseline', project, bed, ALL, {}, false)
    if (base === null) {
      console.log('RESULT: inconclusive — the baseline saw no init')
      return 2
    }
    console.log(`B — servers ${JSON.stringify(base.mcp)}\n  plugins ${JSON.stringify(base.plugins)}\n  skills ${JSON.stringify(base.skills)}`)
    const version = base.version ?? cliVersion

    const synced = base.pluginPaths.find((p) => p.path.includes(`${sep}plugins${sep}synced${sep}`))?.name
    const syncedKey = synced ? `${synced}@synced` : ''
    const connector = base.mcp.find((n) => n.startsWith('claude.ai '))
    const noSynced = synced ? undefined : 'no plugin from the Claude account loads in the bed'
    const noConnector = connector ? undefined : "no claude.ai connector in the bed's baseline"
    const noAccountSkill = shared
      ? undefined
      : accountSkill
        ? `${accountSkill} already exists in the bed's skills`
        : 'no skill from the Claude account loads in the bed'
    const skipIf = (...why: Array<string | false | undefined>): string | undefined => why.find((w): w is string => typeof w === 'string')

    const ep = (k: string, v: boolean): Json => ({ enabledPlugins: obj([k, v]) })
    const so = (...pairs: Array<[string, string]>): Json => ({ skillOverrides: obj(...pairs) })
    const plugin = (expected: string, skip?: string): Check => ({
      subject: PLUGIN_ID,
      observe: pluginOn(PLUGIN),
      baseline: 'on',
      expected,
      skip: skipIf(pluginSkip, skip),
    })
    const syncedC = (expected: string): Check => ({
      subject: syncedKey || '<name>@synced',
      observe: pluginOn(synced ?? ''),
      baseline: 'on',
      expected,
      skip: noSynced,
    })
    const solo = (expected: string): Check => ({
      subject: SOLO,
      observe: skillOn(SOLO),
      baseline: 'on',
      expected,
      skip: skipIf(!have.solo && 'its fixture exists already'),
    })
    const lockOff: Json = so([AUTHOR, 'off'], [`${PLUGIN}:${PLUGIN_SKILL}`, 'off'], [PLUGIN_SKILL, 'off'], [RESERVED, 'off'])
    const locks = (): Check[] => [
      { subject: `${AUTHOR} (author)`, observe: commandOn(AUTHOR), baseline: 'on', expected: 'on', skip: skipIf(!have.author && 'its fixture exists already') },
      { subject: `${PLUGIN}:${PLUGIN_SKILL} (plugin)`, observe: pluginSkillOn, baseline: 'on', expected: 'on', skip: pluginSkip },
      {
        subject: `${RESERVED} (reserved)`,
        observe: skillOn(RESERVED),
        baseline: 'on',
        expected: 'on',
        skip: skipIf(!have.reserved && 'its fixture exists already'),
      },
    ]
    const reach =
      (localExp: string | null, flagExp: string | null, userExp: string | null, projExp: string | null) =>
      (tier: Source | 'flag'): Check[] => {
        const exp = { local: localExp, flag: flagExp, user: userExp, project: projExp }[tier]
        return [
          {
            subject: `${shared ?? '<account skill>'} (personal + account)`,
            observe: copies(shared ?? '', 'account'),
            baseline: 'account+personal',
            expected: exp,
            skip: noAccountSkill,
          },
          {
            subject: `${TWIN} (personal + project)`,
            observe: copies(TWIN, 'other'),
            baseline: 'personal+project',
            expected: null,
            skip: skipIf(!have.twin && 'its fixture exists already'),
          },
        ]
      }
    // measured 23-11: the local file hides only the personal copy, a launch entry both
    const reachChecks = reach('account', 'none', null, null)
    const sharedOff = (): Json => so(...[[TWIN, 'off'] as [string, string]].concat(shared ? [[shared, 'off']] : []))

    const cases: Case[] = [
      // the user tier, per key
      { id: 'u-plugin', tier: 'user', user: ep(PLUGIN_ID, false), checks: [plugin('off')] },
      { id: 'u-synced', tier: 'user', user: ep(syncedKey, false), checks: [syncedC('off')] },
      {
        id: 'u-deny-plugin-server',
        tier: 'user',
        user: { deniedMcpServers: [{ serverName: PLUGIN_SERVER }] },
        checks: [{ subject: PLUGIN_SERVER, observe: serverOn(PLUGIN_SERVER), baseline: 'on', expected: 'off', skip: pluginSkip }],
      },
      {
        id: 'u-deny-connector',
        tier: 'user',
        user: { deniedMcpServers: [{ serverName: connector ?? '' }] },
        checks: [{ subject: connector ?? 'claude.ai <Name>', observe: serverOn(connector ?? ''), baseline: 'on', expected: 'off', skip: noConnector }],
      },
      {
        id: 'u-mcpjson',
        tier: 'user',
        user: { disabledMcpjsonServers: [MCPJSON] },
        checks: [{ subject: MCPJSON, observe: serverOn(MCPJSON), baseline: 'on', expected: 'off' }],
      },
      {
        id: 'u-connectors-off',
        tier: 'user',
        user: { disableClaudeAiConnectors: true },
        checks: [{ subject: connector ?? 'claude.ai <Name>', observe: serverOn(connector ?? ''), baseline: 'on', expected: 'off', skip: noConnector }],
      },
      { id: 'u-skill', tier: 'user', user: so([SOLO, 'off']), checks: [solo('off')] },
      // controls: the wider «off» alone
      { id: 'c-plugin-local', tier: 'local', local: ep(PLUGIN_ID, false), checks: [plugin('off')] },
      { id: 'c-skill-project', tier: 'project', project: so([SOLO, 'off']), checks: [solo('off')] },
      { id: 'c-skill-local', tier: 'local', local: so([SOLO, 'off']), checks: [solo('off')] },
      { id: 'c-skill-flag', tier: 'flag', flag: so([SOLO, 'off']), checks: [solo('off')] },
      // «on» over a wider «off»
      {
        id: 'p-plugin-flag-on',
        tier: 'flag › local',
        local: ep(PLUGIN_ID, false),
        flag: ep(PLUGIN_ID, true),
        control: 'c-plugin-local',
        checks: [plugin('on')],
      },
      { id: 'p-plugin-local-on', tier: 'local › user', user: ep(PLUGIN_ID, false), local: ep(PLUGIN_ID, true), control: 'u-plugin', checks: [plugin('on')] },
      { id: 'p-synced-local-on', tier: 'local › user', user: ep(syncedKey, false), local: ep(syncedKey, true), control: 'u-synced', checks: [syncedC('on')] },
      { id: 'p-synced-flag-on', tier: 'flag › user', user: ep(syncedKey, false), flag: ep(syncedKey, true), control: 'u-synced', checks: [syncedC('on')] },
      { id: 'p-skill-flag-on', tier: 'flag › local', local: so([SOLO, 'off']), flag: so([SOLO, 'on']), control: 'c-skill-local', checks: [solo('on')] },
      { id: 'p-skill-local-on', tier: 'local › user', user: so([SOLO, 'off']), local: so([SOLO, 'on']), control: 'u-skill', checks: [solo('on')] },
      { id: 'p-skill-project-on', tier: 'project › user', user: so([SOLO, 'off']), project: so([SOLO, 'on']), control: 'u-skill', checks: [solo('on')] },
      // a project skill, off from the flag tier (the local file's: its control)
      {
        id: 's-projskill-local',
        tier: 'local',
        local: so([PROJ, 'off']),
        checks: [{ subject: PROJ, observe: skillOn(PROJ), baseline: 'on', expected: 'off' }],
      },
      { id: 's-projskill-flag', tier: 'flag', flag: so([PROJ, 'off']), checks: [{ subject: PROJ, observe: skillOn(PROJ), baseline: 'on', expected: 'off' }] },
      // reach on a name two skills share
      { id: 'r-shared-user', tier: 'user', user: sharedOff(), checks: reachChecks('user') },
      { id: 'r-shared-project', tier: 'project', project: sharedOff(), checks: reachChecks('project') },
      { id: 'r-shared-local', tier: 'local', local: sharedOff(), checks: reachChecks('local') },
      { id: 'r-shared-flag', tier: 'flag', flag: sharedOff(), checks: reachChecks('flag') },
      // skills the engine locks: an «off» changes nothing
      { id: 'l-locks-user', tier: 'user', user: lockOff, control: 'u-skill', checks: locks() },
      { id: 'l-locks-local', tier: 'local', local: lockOff, control: 'c-skill-local', checks: locks() },
      { id: 'l-locks-flag', tier: 'flag', flag: lockOff, control: 'c-skill-flag', checks: locks() },
      // claudeMdExcludes on the bed's CLAUDE.md (m-base: the file loads at all)
      ...(['base', 'user', 'project', 'local', 'flag'] as const).map((t): Case => {
        const ex: Json = { claudeMdExcludes: [md] }
        return {
          id: `m-${t}`,
          tier: t === 'base' ? '—' : t,
          instr: true,
          ...(t === 'user' ? { user: ex } : t === 'project' ? { project: ex } : t === 'local' ? { local: ex } : t === 'flag' ? { flag: ex } : {}),
          ...(t === 'base' ? {} : { control: 'm-base' }),
          checks: [{ subject: md, observe: instrState(md), baseline: 'loaded', expected: t === 'base' ? 'loaded' : 'excluded' }],
        }
      }),
      // the repository's file carried into a launch that skips it
      {
        id: 'x-off-read',
        tier: 'project',
        project: { ...ep(PLUGIN_ID, false), ...so([SOLO, 'off']) },
        sources: ['user', 'project'],
        checks: [plugin('off'), solo('off')],
      },
      {
        id: 'x-off-skipped',
        tier: '— (user only)',
        project: { ...ep(PLUGIN_ID, false), ...so([SOLO, 'off']) },
        sources: ['user'],
        checks: [plugin('on'), solo('on')],
      },
      {
        id: 'x-off-carried',
        tier: 'flag (carried)',
        project: { ...ep(PLUGIN_ID, false), ...so([SOLO, 'off']) },
        flag: { ...ep(PLUGIN_ID, false), ...so([SOLO, 'off']) },
        sources: ['user'],
        checks: [plugin('off'), solo('off')],
      },
      {
        id: 'x-on-read',
        tier: 'project › user',
        user: ep(PLUGIN_ID, false),
        project: ep(PLUGIN_ID, true),
        sources: ['user', 'project'],
        checks: [plugin('on')],
      },
      { id: 'x-on-skipped', tier: '— (user only)', user: ep(PLUGIN_ID, false), project: ep(PLUGIN_ID, true), sources: ['user'], checks: [plugin('off')] },
      {
        id: 'x-on-carried',
        tier: 'flag (carried) › user',
        user: ep(PLUGIN_ID, false),
        project: ep(PLUGIN_ID, true),
        flag: ep(PLUGIN_ID, true),
        sources: ['user'],
        control: 'x-on-skipped',
        checks: [plugin('on')],
      },
      // rule 14: Silos' own carry of the files a run skips (both ways), and a heartbeat's (only «off»)
      {
        id: 't-run-local-on',
        tier: 'flag (run carry) › user',
        user: { ...ep(PLUGIN_ID, false), ...so([SOLO, 'off']) },
        local: { ...ep(PLUGIN_ID, true), ...so([SOLO, 'on']) },
        sources: ['user', 'project'],
        carry: 'run',
        control: 'u-plugin',
        checks: [plugin('on'), solo('on')],
      },
      {
        id: 't-run-repo-on',
        tier: 'flag (run carry) › user',
        user: { ...ep(PLUGIN_ID, false), ...so([SOLO, 'off']) },
        project: { ...ep(PLUGIN_ID, true), ...so([SOLO, 'on']) },
        sources: ['user'],
        carry: 'run',
        control: 'x-on-skipped',
        checks: [plugin('on'), solo('on')],
      },
      {
        id: 't-run-local-over-repo',
        tier: 'flag (run carry)',
        project: { ...ep(PLUGIN_ID, true), ...so([SOLO, 'on']) },
        local: { ...ep(PLUGIN_ID, false), ...so([SOLO, 'off']) },
        sources: ['user'],
        carry: 'run',
        checks: [plugin('off'), solo('off')],
      },
      {
        id: 't-beat-no-on',
        tier: 'flag (heartbeat carry) › user',
        user: { ...ep(PLUGIN_ID, false), ...so([SOLO, 'off']) },
        local: { ...ep(PLUGIN_ID, true), ...so([SOLO, 'on']) },
        project: { ...ep(PLUGIN_ID, true), ...so([SOLO, 'on']) },
        sources: ['user'],
        carry: 'heartbeat',
        control: 'u-plugin',
        checks: [plugin('off'), solo('off')],
      },
      {
        id: 't-beat-off',
        tier: 'flag (heartbeat carry)',
        local: { ...ep(PLUGIN_ID, false), ...so([SOLO, 'off']) },
        sources: ['user', 'project'],
        carry: 'heartbeat',
        checks: [plugin('off'), solo('off')],
      },
      // LAST: the user-tier sync keys — in this bed only
      {
        id: 'z-sync-skills',
        tier: 'user',
        user: { syncClaudeAiSkills: false },
        checks: [
          {
            subject: accountSkill ?? '<account skill>',
            observe: skillOn(accountSkill ?? ''),
            baseline: 'on',
            expected: 'off',
            skip: accountSkill ? undefined : 'no skill from the Claude account loads in the bed',
          },
        ],
      },
      { id: 'z-sync-plugins', tier: 'user', user: { syncClaudeAiPlugins: false }, checks: [syncedC('off')] },
    ]

    const show = (e: string | null): string => e ?? '— (no claim)'
    for (const c of cases) {
      if (!picked(c.id)) continue
      const live = c.checks.filter((k) => !k.skip && (c.instr ? true : k.observe(base) === k.baseline))
      for (const k of c.checks) {
        if (k.skip) rows.push({ id: c.id, tier: c.tier, subject: k.subject, expected: show(k.expected), observed: '—', verdict: 'SKIPPED', note: k.skip })
        else if (!c.instr && k.observe(base) !== k.baseline)
          rows.push({
            id: c.id,
            tier: c.tier,
            subject: k.subject,
            expected: show(k.expected),
            observed: '—',
            verdict: 'SKIPPED',
            note: `the baseline shows ${k.observe(base)}, not ${k.baseline}`,
          })
      }
      if (live.length === 0) continue
      console.log(
        `\n${c.id} — user ${JSON.stringify(c.user ?? {})} · project ${JSON.stringify(c.project ?? {})} · local ${JSON.stringify(c.local ?? {})} · flag ${JSON.stringify(c.flag ?? {})} · sources ${JSON.stringify(c.sources ?? ALL)}`,
      )
      let snap: Snap | null
      try {
        writeTiers(c)
        // a t- case: the flag tier is what Silos' own carry builds from the
        // files just written (local-holds.ts), as an unattended turn gets it
        const onlyRemoves = c.carry === 'heartbeat'
        const flag = c.carry
          ? withFilesCarried(c.flag ?? {}, filesCarry(project, { sources: c.sources ?? ALL, configDir: bed, onlyRemoves }), { onlyRemoves })
          : (c.flag ?? {})
        if (c.carry) console.log(`  carried (${c.carry}): ${JSON.stringify(flag)}`)
        snap = await launch(c.id, project, bed, c.sources ?? ALL, flag, c.instr === true)
      } finally {
        restoreTiers()
      }
      for (const k of live) {
        if (snap === null) {
          rows.push({ id: c.id, tier: c.tier, subject: k.subject, expected: show(k.expected), observed: '—', verdict: 'NO INIT' })
          if (code === 0) code = 2
          continue
        }
        if (c.instr && snap.instr && snap.instr.events === 0) {
          rows.push({
            id: c.id,
            tier: c.tier,
            subject: k.subject,
            expected: show(k.expected),
            observed: '—',
            verdict: 'NOTHING TO SHOW',
            note: 'no InstructionsLoaded event reached the script',
          })
          continue
        }
        const observed = k.observe(snap)
        if (k.subject.includes('+')) console.log(`  ${k.subject}: rows ${JSON.stringify(snap.commands.filter((r) => k.subject.startsWith(`${r.name} `)))}`)
        const verdict: Verdict = k.expected === null ? 'NOTED' : observed === k.expected ? 'PASS' : 'FAIL'
        rows.push({ id: c.id, tier: c.tier, subject: k.subject, expected: show(k.expected), observed, verdict })
      }
    }
    // an «on over off» case whose wider «off» does not hold alone cannot discriminate
    for (const r of rows) {
      const c = cases.find((x) => x.id === r.id)
      if (!c?.control || r.verdict === 'SKIPPED' || r.verdict === 'NO INIT') continue
      const ctl = rows.filter((x) => x.id === c.control)
      if (ctl.length === 0) {
        r.note = `control ${c.control} not run`
        continue
      }
      if (!ctl.some((x) => x.verdict === 'PASS')) {
        r.verdict = 'NOTHING TO SHOW'
        r.note = `its control ${c.control} did not show the wider state`
      }
    }
    if (rows.some((r) => r.verdict === 'FAIL')) code = 1

    // the summary
    const head: Row = { id: 'case', tier: 'tier', subject: 'subject', expected: 'expected', observed: 'observed', verdict: 'PASS' }
    const cols: Array<keyof Omit<Row, 'verdict' | 'note'>> = ['id', 'tier', 'subject', 'expected', 'observed']
    const width = Object.fromEntries(cols.map((k) => [k, Math.max(...[head, ...rows].map((r) => r[k].length))])) as Record<string, number>
    const line = (r: Row, v: string): string => `${cols.map((k) => r[k].padEnd(width[k] ?? 0)).join(' · ')} · ${v}${r.note ? ` — ${r.note}` : ''}`
    console.log(`\nClaude Code ${version} (bed ${bed})`)
    console.log(line(head, 'verdict'))
    for (const r of rows) console.log(line(r, r.verdict))
    if (picked('z-'))
      console.log(
        "\nThe z- cases made Claude Code move the bed's synced copies to its trash; the key is back, and it downloads them again at the bed's next start.",
      )
    console.log(
      code === 0
        ? "RESULT: PASS — no line contradicts the spec's table"
        : code === 1
          ? "RESULT: FAIL — a line contradicts the spec's table"
          : 'RESULT: inconclusive — a launch saw no init',
    )
    return code
  } finally {
    undo(bed, journal)
    rmSync(project, { recursive: true, force: true })
    rmSync(market, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exit(await runScopes(process.argv.slice(2)))
}
