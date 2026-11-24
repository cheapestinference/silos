#!/usr/bin/env -S npx tsx
// smoke-silos-places.mts — the ACCEPTANCE smoke: Silos itself, driven end to
// end through its own API, against a REAL Claude Code. Where
// smoke-scopes.mts measures the engine's settings tiers, this one asks
// whether the places Silos draws (machine · project · agent · conversation ·
// the account's heads · all/nothing with Undo) really change what a
// `claude` started in the folder loads — read with «Check now» (`POST
// …/loads/check`: SDK initialize + mcpServerStatus, no prompt, no
// transcript, no tokens). It never starts a chat turn.
//
// TWO PHASES, each on its own ISOLATED server (fresh SILOS_DATA_DIR,
// SILOS_ROOT, TMPDIR and HOME; a free port; the owner identity is the token
// that server writes in its own data dir — never ~/.silos/token):
//
//   A · clean install — the CLEAN bed (below): before each run it is reset
//       to its `.credentials.json` alone (everything else moved into the
//       run's temp dir and never restored — it is the clean machine), and a
//       temp HOME whose `.claude` is a symlink to that WHOLE dir: signed in,
//       nothing else (no settings.json, no plugins, no CLAUDE.md, no
//       ~/.claude.json). Welcome's payload (GET /api/settings, GET
//       /api/starting-set?facts=1), the first agent on a new folder with the
//       Recommended starting set, the second project after a non-default
//       choice (PATCH /api/settings, taken back after), the folder's
//       settings.local.json as designed, GET …/loads, Project › Memory and
//       Skills, a real «Check now».
//   B · the places — the PLACES bed, through a temp HOME whose `.claude` is
//       a symlink to that whole dir (and `.claude.json` → the bed's, which
//       holds no credential), so the machine Silos sees and writes is the
//       bed: its «This machine» writer writes the bed's settings.json. A
//       temp project with a `.mcp.json` server (a tiny stdio MCP that answers
//       initialize), a test plugin installed in the bed with Claude's own
//       `claude plugin install --scope user` (its own MCP server), two agents
//       (Builder, Writer). Each case: switch at a place → «Check now» (as the
//       agent where relevant) → presence in the reading → switch back →
//       restored.
//
// Why HOME and not CLAUDE_CONFIG_DIR: the server scrubs CLAUDE_CONFIG_DIR
// at boot (inherited-env.ts) and resolves the machine's login as
// `<home>/.claude` (config.ts `home`, env.ts: the default provider adds no
// CLAUDE_CONFIG_DIR). A temp HOME pointing at the bed is the one way the
// server's machine is the bed and never ~/.claude.
//
// THE TWO BEDS — Claude config dirs of the smoke's own, each with its OWN
// login (never a shared or linked credential: Claude Code rewrites
// `.credentials.json` by rename on a refresh, so a link becomes a copy that
// shares a refresh token, and the rotation logs one side out — seen 24-11):
//   places: $SILOS_SMOKE_CONFIG_DIR, default ~/.silos-smoke/claude
//   clean:  $SILOS_SMOKE_CLEAN_DIR,  default ~/.silos-smoke/clean
// Each is refused when it is ~/.claude, this shell's CLAUDE_CONFIG_DIR, under
// ~/.silos/claude-accounts/, the other bed (or inside it), or when its
// `.credentials.json` is a link (symbolic, or hard — the same file as the
// other bed's). A bed not signed in stops the run before anything starts
// (exit 3) with its sign-in command:
//   CLAUDE_CONFIG_DIR=<bed> claude auth login
// A credential is never opened, copied or printed (`claude auth status
// --json` → `loggedIn` only).
// WHAT IT WRITES IN THE PLACES BED, all put back: settings.json and
// plugins/{installed_plugins,known_marketplaces}.json snapshotted first and
// restored byte for byte; the test plugin and its marketplace removed with
// Claude's own commands. A journal (<bed>/.silos-places-journal.json) is
// written before the first write, so a killed run is undone by the next
// start. In the clean bed: everything but its credential is moved out at
// each start (it is the clean machine, kept clean). Everything else lives
// in one temp dir, removed at the end — after every process still running
// with a phase's HOME is stopped (reapHome: a `claude` the server started
// can outlive it).
//
// --main-login (or SILOS_SMOKE_MAIN=1) — the places phase ONLY, on this
// machine's own login: the temp HOME's `.claude` is the WHOLE real ~/.claude
// (the credential is the same file, refreshed in place like any session's —
// never copied, never linked alone). On the owner's live setup it never
// installs or removes a plugin or marketplace (the test-plugin cases are
// skipped), writes in ~/.claude/settings.json ONLY
// `deniedMcpServers: [{serverName: "silos-smoke-mcp"}]` through Silos' own
// machine writer — journaled first in ~/.silos-smoke/main-journal.json (a
// hash, never the file's bytes), taken out by the same writer, and the file
// asserted byte-identical after — and runs the connectors head and «Turn
// all off» + Undo at the temp project only. ~/.silos is never touched, and
// the clean install is not run (it needs an empty machine).
//
// Run: npx tsx scripts/smoke-silos-places.mts [A|B] [--main-login]   (default: both)
// Exit 0 = no FAIL · 1 = a FAIL · 2 = the smoke could not set up · 3 = a
// bed is not signed in (nothing ran).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

type Json = Record<string, unknown>
type Verdict = 'PASS' | 'FAIL' | 'SKIPPED' | 'NOTED'
interface Row {
  case: string
  place: string
  expected: string
  observed: string
  verdict: Verdict
}

const REPO = resolve(dirname(new URL(import.meta.url).pathname), '..')
const ENGINE = 'claude-code'
const MKT = 'silos-places-smoke'
const PLUGIN = 'silos-places-demo'
const PLUGIN_ID = `${PLUGIN}@${MKT}`
const PLUGIN_SERVER = `plugin:${PLUGIN}:echo`
/** the project's .mcp.json server — a name that exists in no real setup (--main-login's machine entry names it) */
const MCPJSON = 'silos-smoke-mcp'

const isMap = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const readOr = (p: string): string | null => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}
const within = (root: string, p: string): boolean => {
  const r = relative(root, p)
  return r !== '' && !r.startsWith('..') && !isAbsolute(r)
}
const real = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// ── the bed ──────────────────────────────────────────────────────────────
function bedRefusal(bed: string, other: string): string | null {
  const home = homedir()
  const accounts = join(home, '.silos', 'claude-accounts')
  if (bed === accounts || within(accounts, bed) || within(real(accounts), real(bed))) return `${bed} is under ${accounts}`
  const forbidden = [join(home, '.claude'), process.env.CLAUDE_CONFIG_DIR].filter((x): x is string => !!x).map((p) => real(resolve(p)))
  if (forbidden.includes(real(bed))) return `${bed} is a login you use (~/.claude or this shell's CLAUDE_CONFIG_DIR)`
  if (within(bed, join(home, '.claude')) || within(real(join(home, '.claude')), real(bed))) return `${bed} overlaps ~/.claude`
  if (real(bed) === real(other) || within(real(other), real(bed)) || within(real(bed), real(other))) return `${bed} overlaps the other bed ${other}`
  const cred = join(bed, '.credentials.json'),
    otherCred = join(other, '.credentials.json')
  try {
    if (lstatSync(cred).isSymbolicLink()) return `${cred} is a link — each bed signs in on its own: CLAUDE_CONFIG_DIR=${bed} claude auth login`
    const a = statSync(cred)
    if (existsSync(otherCred)) {
      const b = statSync(otherCred)
      if (a.ino === b.ino && a.dev === b.dev) return `${cred} is the same file as ${otherCred} — each bed signs in on its own`
    }
  } catch {
    /* no credential: not signed in, said by main */
  }
  return null
}
const PLACES_BED = resolve(process.env.SILOS_SMOKE_CONFIG_DIR ?? join(homedir(), '.silos-smoke', 'claude'))
const CLEAN_BED = resolve(process.env.SILOS_SMOKE_CLEAN_DIR ?? join(homedir(), '.silos-smoke', 'clean'))

/** The clean machine: its credential alone. Everything else is moved into
 *  `into` (the run's temp dir, removed at the end) — never restored. */
function resetClean(bed: string, into: string): string[] {
  const moved: string[] = []
  mkdirSync(into, { recursive: true, mode: 0o700 })
  for (const name of readdirSync(bed)) {
    if (name === '.credentials.json') continue
    renameSync(join(bed, name), join(into, name))
    moved.push(name)
  }
  return moved.sort()
}

/** The environment of an engine process or the server: no inherited engine
 *  variables, no npm run plumbing. */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_') || k.startsWith('ANTHROPIC_') || k.startsWith('npm_') || k === 'INIT_CWD') continue
    env[k] = v
  }
  return env
}
function claudeCli(bed: string, args: string[]): { status: number | null; out: string } {
  const r = spawnSync('claude', args, { env: { ...cleanEnv(), CLAUDE_CONFIG_DIR: bed }, encoding: 'utf8', timeout: 120_000 })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}
function signedIn(bed: string): boolean {
  const r = claudeCli(bed, ['auth', 'status', '--json'])
  try {
    const j: unknown = JSON.parse(r.out.slice(r.out.indexOf('{')))
    return isMap(j) && j.loggedIn === true
  } catch {
    return false
  }
}

// ── the journal (phase B's writes to the bed) ────────────────────────────
interface Journal {
  files: Record<string, string | null>
  plugin: boolean
}
const SNAPSHOT = ['settings.json', join('plugins', 'installed_plugins.json'), join('plugins', 'known_marketplaces.json')]
const journalPath = (bed: string): string => join(bed, '.silos-places-journal.json')
const saveJournal = (bed: string, j: Journal): void => writeFileSync(journalPath(bed), JSON.stringify(j, null, 2), { mode: 0o600 })
function undo(bed: string, j: Journal): void {
  if (j.plugin) {
    claudeCli(bed, ['plugin', 'uninstall', PLUGIN_ID, '--scope', 'user'])
    claudeCli(bed, ['plugin', 'marketplace', 'remove', MKT, '--scope', 'user'])
  }
  for (const [rel, bytes] of Object.entries(j.files)) {
    const p = resolve(bed, rel)
    if (!within(bed, p)) continue
    if (bytes === null) {
      if (existsSync(p)) unlinkSync(p)
    } else writeFileSync(p, bytes)
  }
  if (existsSync(journalPath(bed))) unlinkSync(journalPath(bed))
}

// ── fixtures ─────────────────────────────────────────────────────────────
/** A stdio MCP server that answers initialize and tools/list — newline-delimited JSON-RPC. */
const MCP_ECHO = `import { createInterface } from 'node:readline'
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line) } catch { return }
  if (m.id === undefined) return
  if (m.method === 'initialize') out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'silos-places-echo', version: '0.0.1' } } })
  else if (m.method === 'tools/list') out({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', description: 'Fixture of the Silos places smoke; never call it.', inputSchema: { type: 'object', properties: {} } }] } })
  else out({ jsonrpc: '2.0', id: m.id, result: {} })
})
`
function writeMarketplace(dir: string, echo: string): void {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(dir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify(
      { name: MKT, owner: { name: 'Silos smoke' }, plugins: [{ name: PLUGIN, source: `./${PLUGIN}`, description: 'Fixture of the Silos places smoke.' }] },
      null,
      2,
    ),
  )
  const p = join(dir, PLUGIN)
  mkdirSync(join(p, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(p, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: PLUGIN, version: '0.0.1', description: 'Fixture of the Silos places smoke.' }, null, 2),
  )
  writeFileSync(join(p, '.mcp.json'), JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [echo] } } }, null, 2))
}

// ── the isolated server ──────────────────────────────────────────────────
interface Silos {
  url: string
  token: string
  dataDir: string
  root: string
  home: string
  child: ChildProcess
  log: () => string
}
function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      const port = typeof a === 'object' && a ? a.port : 0
      s.close(() => res(port))
    })
  })
}
function tsxBin(): string {
  for (let d = REPO; ; d = dirname(d)) {
    const p = join(d, 'node_modules', '.bin', 'tsx')
    if (existsSync(p)) return p
    if (dirname(d) === d) throw new Error('tsx not found in node_modules')
  }
}
async function startSilos(base: string, label: string, home: string, prepareRoot?: (root: string) => void): Promise<Silos> {
  const dataDir = join(base, `${label}-data`),
    root = join(base, `${label}-root`),
    tmp = join(base, `${label}-tmp`)
  for (const d of [dataDir, root, tmp]) mkdirSync(d, { recursive: true, mode: 0o700 })
  prepareRoot?.(root)
  const port = await freePort()
  if (port === 3210) throw new Error('refusing port 3210')
  const env: Record<string, string> = {
    ...cleanEnv(),
    HOME: home,
    TMPDIR: tmp,
    SILOS_DATA_DIR: dataDir,
    SILOS_ROOT: root,
    SILOS_HOME: home,
    SILOS_PORT: String(port),
    SILOS_OPENCODE_DATA: join(home, '.local', 'share'),
    SILOS_TMUX_SOCKET: `silos-places-${process.pid}-${label}`,
    SILOS_WEB_DIST: join(base, 'no-web'),
    SILOS_NO_EPHEMERAL: '1',
    SILOS_NO_AUTOTITLES: '1',
    SILOS_NO_MODEL_CATALOG: '1',
    SILOS_NO_ACCOUNT_LOAD: '1',
    SILOS_NO_DIGEST: '1',
    SILOS_NO_PROCESS_SCAN: '1',
    SILOS_NO_WORKTREE_SCAN: '1',
    SILOS_NO_TASK_WAKE_DELIVERY: '1',
  }
  // the hard rule, checked right before the spawn
  const realHome = homedir()
  for (const k of ['HOME', 'SILOS_DATA_DIR', 'SILOS_ROOT', 'SILOS_HOME', 'TMPDIR'] as const) {
    const v = env[k]
    if (!v || !within(base, v)) throw new Error(`${k} is not inside the smoke's temp dir: aborting`)
  }
  if (real(env.HOME!) === real(realHome)) throw new Error('HOME is the real home: aborting')
  const child = spawn(tsxBin(), ['server/src/index.ts'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  let out = ''
  const keep = (b: Buffer): void => {
    out = (out + b.toString()).slice(-20_000)
  }
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)
  const url = `http://127.0.0.1:${port}`
  const until = Date.now() + 90_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the ${label} server exited:\n${out}`)
    try {
      if ((await fetch(`${url}/healthz`)).ok && existsSync(join(dataDir, 'token'))) break
    } catch {
      /* not up yet */
    }
    if (Date.now() > until) {
      stopSilos({ url, token: '', dataDir, root, home, child, log: () => out })
      throw new Error(`the ${label} server did not come up:\n${out}`)
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  const token = readFileSync(join(dataDir, 'token'), 'utf8').trim()
  return { url, token, dataDir, root, home, child, log: () => out }
}
function stopSilos(s: Silos): void {
  try {
    if (s.child.pid) process.kill(-s.child.pid, 'SIGTERM')
  } catch {
    /* gone */
  }
}
async function waitExit(s: Silos): Promise<void> {
  const until = Date.now() + 15_000
  while (s.child.exitCode === null && s.child.signalCode === null && Date.now() < until) await new Promise((r) => setTimeout(r, 200))
  if (s.child.exitCode === null && s.child.signalCode === null) {
    try {
      if (s.child.pid) process.kill(-s.child.pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
  spawnSync('tmux', ['-L', `silos-places-${process.pid}-${s.dataDir.endsWith('A-data') ? 'A' : 'B'}`, 'kill-server'], { stdio: 'ignore' })
  await reapHome(s.home)
}

/** Every process still running with this server's temp HOME (a `claude` the
 *  server started can outlive it, and write its HOME after the temp dir is
 *  gone — seen on the first run): stopped, waited for, then killed. */
async function reapHome(home: string): Promise<void> {
  const mark = `HOME=${home}`
  const holders = (): number[] => {
    const out: number[] = []
    let pids: string[] = []
    try {
      pids = readdirSync('/proc').filter((p) => /^\d+$/.test(p))
    } catch {
      return out
    }
    for (const p of pids) {
      try {
        if (readFileSync(`/proc/${p}/environ`, 'latin1').split('\0').includes(mark)) out.push(Number(p))
      } catch {
        /* not ours, or gone */
      }
    }
    return out
  }
  for (const pid of holders()) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* gone */
    }
  }
  const until = Date.now() + 10_000
  while (holders().length > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 250))
  for (const pid of holders()) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
}

interface Answer {
  status: number
  json: Json
}
async function api(s: Silos, method: string, path: string, body?: unknown): Promise<Answer> {
  const r = await fetch(`${s.url}${path}`, {
    method,
    headers: { 'x-token': s.token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await r.text()
  let json: Json = {}
  try {
    const j: unknown = JSON.parse(text)
    json = isMap(j) ? j : { value: j }
  } catch {
    json = { text: text.slice(0, 300) }
  }
  return { status: r.status, json }
}
const F = (folder: string): string => `/api/folders/${encodeURIComponent(folder)}`

// ── readings ─────────────────────────────────────────────────────────────
interface Reading {
  ok: boolean
  error?: string
  login: string | null
  servers: Array<{ name: string; status: string; source?: string }>
  incomplete: boolean
}
/** «Check now», then the reading it kept (the server's own tool-health ledger for the folder). */
async function check(s: Silos, folder: string, as?: string): Promise<Reading> {
  const a = await api(s, 'POST', `${F(folder)}/loads/check`, as !== undefined ? { agent: as } : {})
  if (a.status !== 200)
    return { ok: false, error: `${a.status} ${String(a.json.error ?? JSON.stringify(a.json))}`, login: null, servers: [], incomplete: false }
  const file = join(s.dataDir, 'tool-health', `${createHash('sha256').update(folder).digest('hex').slice(0, 24)}.json`)
  let readings: Json[] = []
  try {
    const j: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (isMap(j) && Array.isArray(j.readings)) readings = j.readings as Json[]
  } catch {
    /* none */
  }
  const mine = readings.filter((r) => r.from === 'check' && (r.agent ?? undefined) === as).sort((x, y) => Number(y.at) - Number(x.at))[0]
  if (!mine) return { ok: false, error: 'the check answered but kept no reading', login: null, servers: [], incomplete: false }
  return {
    ok: true,
    login: typeof a.json.login === 'string' ? a.json.login : null,
    servers: (mine.servers as Array<{ name: string; status: string; source?: string }>) ?? [],
    incomplete: a.json.incomplete === true,
  }
}
const has = (r: Reading, name: string): boolean => r.servers.some((x) => x.name === name)
const connectorsOf = (r: Reading): string[] =>
  r.servers
    .filter((x) => x.source === 'claudeai')
    .map((x) => x.name)
    .sort()
const present = (r: Reading, name: string): string => (!r.ok ? `check failed: ${r.error}` : has(r, name) ? 'present' : 'absent')
const conn = (r: Reading): string => (!r.ok ? `check failed: ${r.error}` : connectorsOf(r).length > 0 ? `present (${connectorsOf(r).length})` : 'absent')
const names = (r: Reading): string[] => r.servers.map((x) => x.name).sort()

// ── the run ──────────────────────────────────────────────────────────────
const rowsA: Row[] = []
const rowsB: Row[] = []
function add(rows: Row[], c: string, place: string, expected: string, observed: string, ok?: boolean): void {
  const verdict: Verdict = ok === undefined ? (observed === expected || observed.startsWith(`${expected} `) ? 'PASS' : 'FAIL') : ok ? 'PASS' : 'FAIL'
  rows.push({ case: c, place, expected, observed, verdict })
}
const skip = (rows: Row[], c: string, place: string, expected: string, why: string): void => {
  rows.push({ case: c, place, expected, observed: why, verdict: 'SKIPPED' })
}
const note = (rows: Row[], c: string, place: string, observed: string): void => {
  rows.push({ case: c, place, expected: '—', observed, verdict: 'NOTED' })
}

function table(title: string, rows: Row[]): void {
  const w = (k: keyof Row, cap: number): number => Math.min(cap, Math.max(k.length, ...rows.map((r) => r[k].length)))
  const cols: Array<[keyof Row, number]> = [
    ['case', w('case', 34)],
    ['place', w('place', 22)],
    ['expected', w('expected', 40)],
    ['observed', w('observed', 70)],
    ['verdict', 7],
  ]
  const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
  console.log(`\n${title}`)
  console.log(cols.map(([k, n]) => cut(k, n)).join(' │ '))
  console.log(cols.map(([, n]) => '─'.repeat(n)).join('─┼─'))
  for (const r of rows) console.log(cols.map(([k, n]) => cut(r[k], n)).join(' │ '))
}

/** The folder's settings.local.json, parsed (null: none or not JSON). */
function localFile(folder: string): Json | null {
  const t = readOr(join(folder, '.claude', 'settings.local.json'))
  if (t === null) return null
  try {
    const j: unknown = JSON.parse(t)
    return isMap(j) ? j : null
  } catch {
    return null
  }
}
const startingKeys = (j: Json | null): string =>
  j === null
    ? 'no file'
    : JSON.stringify(
        Object.fromEntries(
          Object.keys(j)
            .sort()
            .map((k) => [k, j[k]]),
        ),
      )

// ── phase A: a clean install ─────────────────────────────────────────────
async function phaseA(base: string, bed: string): Promise<void> {
  const home = join(base, 'A-home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  // the clean machine: its own login and nothing else — the whole dir linked, never a file
  const moved = resetClean(bed, join(base, 'A-clean-moved'))
  if (moved.length > 0) note(rowsA, 'clean bed reset', 'machine', `moved out: ${moved.join(', ')}`)
  symlinkSync(bed, join(home, '.claude'))
  const s = await startSilos(base, 'A', home)
  try {
    // Welcome's payload
    const settings = await api(s, 'GET', '/api/settings')
    const classes = (isMap(settings.json.startingSet) ? settings.json.startingSet[ENGINE] : undefined) as Array<Json> | undefined
    const rec = Array.isArray(classes) ? Object.fromEntries(classes.map((c) => [String(c.id), c.recommended])) : null
    add(
      rowsA,
      'welcome: GET /api/settings',
      'machine',
      'plugins off · connectors off · skills on, none chosen',
      settings.status !== 200 || !rec
        ? `${settings.status} ${JSON.stringify(settings.json).slice(0, 120)}`
        : `plugins ${rec['account-plugins'] ? 'on' : 'off'} · connectors ${rec['account-connectors'] ? 'on' : 'off'} · skills ${rec['account-skills'] ? 'on' : 'off'}, ${(classes ?? []).some((c) => 'chosen' in c) ? 'some chosen' : 'none chosen'}`,
    )
    const projA = join(base, 'A-projects', 'alpha'),
      projB = join(base, 'A-projects', 'beta')
    mkdirSync(projA, { recursive: true })
    mkdirSync(projB, { recursive: true })
    const ss = await api(s, 'GET', `/api/starting-set?framework=${ENGINE}&facts=1&folder=${encodeURIComponent(projA)}`)
    const facts = isMap(ss.json.facts) ? ss.json.facts : null
    const machine =
      facts && Array.isArray(facts.machine)
        ? (facts.machine as Array<Json>).map((m) => `${String(m.what)} ${String(m.n)}`).join(', ') || 'nothing set up'
        : 'no facts'
    add(
      rowsA,
      'welcome: «At start» facts',
      'new folder',
      'facts read, folder exists, no agent joins',
      ss.status !== 200
        ? `${ss.status} ${JSON.stringify(ss.json).slice(0, 120)}`
        : `${facts ? 'facts read' : 'no facts'}, ${ss.json.exists === true ? 'folder exists' : 'folder missing'}, ${ss.json.joins === null ? 'no agent joins' : 'joins agents'}`,
    )
    note(rowsA, 'welcome: machine counts', 'machine', `${machine}; sends ${JSON.stringify(facts?.sends ?? {})}`)

    // the first agent, Recommended
    const b = await api(s, 'POST', '/api/agents', { name: 'Builder', folder: projA })
    add(
      rowsA,
      'first agent (Recommended)',
      'new folder',
      '201, no startWarn',
      `${b.status}${b.json.startWarn ? ` startWarn: ${String(b.json.startWarn)}` : ', no startWarn'}${b.status !== 201 ? ` ${JSON.stringify(b.json).slice(0, 120)}` : ''}`,
    )
    const la = localFile(projA)
    add(rowsA, 'starting set written (Recommended)', 'project local file', '{"disableClaudeAiConnectors":true,"syncClaudeAiPlugins":false}', startingKeys(la))
    // GET …/loads on an empty machine
    const loads = await api(s, 'GET', `${F(projA)}/loads`)
    const rows = Array.isArray(loads.json.rows) ? (loads.json.rows as Json[]) : null
    const bad = rows
      ? rows.filter((r) => typeof r.key !== 'string' || typeof r.kind !== 'string' || typeof r.name !== 'string' || typeof r.state !== 'string')
      : []
    const dup = rows ? rows.length - new Set(rows.map((r) => r.key)).size : 0
    add(
      rowsA,
      'GET …/loads (empty machine)',
      'project',
      '200, rows well-formed, no error',
      loads.status !== 200 || !rows
        ? `${loads.status} ${JSON.stringify(loads.json).slice(0, 140)}`
        : `200, rows ${bad.length === 0 && dup === 0 ? 'well-formed' : `${bad.length} malformed, ${dup} duplicate keys`}, ${'error' in loads.json ? `error: ${String(loads.json.error)}` : 'no error'}`,
    )
    if (rows)
      note(
        rowsA,
        'GET …/loads rows',
        'project',
        rows.length === 0
          ? '0 rows'
          : rows
              .map((r) => `${String(r.kind)}:${String(r.name)}=${String(r.state)}`)
              .join(', ')
              .slice(0, 300),
      )
    // Project › Memory / Skills
    for (const [label, path] of [
      ['Memory: GET /api/memory', `/api/memory?folder=${encodeURIComponent(projA)}`],
      ['Memory: GET …/context', `${F(projA)}/context`],
      ['Memory: GET …/personal', `${F(projA)}/personal`],
      ['Skills: GET …/skills-catalog', `${F(projA)}/skills-catalog`],
      ['Skills: agent skills-catalog', '/api/agents/builder/skills-catalog'],
    ] as const) {
      const r = await api(s, 'GET', path)
      add(rowsA, label, 'project', '200', r.status === 200 ? '200' : `${r.status} ${JSON.stringify(r.json).slice(0, 140)}`)
    }
    // a real «Check now»
    const c = await check(s, projA)
    add(
      rowsA,
      '«Check now» (clean machine)',
      'project',
      'answers, connectors absent',
      !c.ok
        ? `failed: ${c.error}`
        : `answers${c.incomplete ? ' (incomplete)' : ''}, connectors ${connectorsOf(c).length > 0 ? `present: ${connectorsOf(c).join(', ')}` : 'absent'}`,
    )
    if (c.ok) note(rowsA, '«Check now» reading', 'project', `login ${c.login ? 'known' : 'unknown'}; servers [${names(c).join(', ')}]`)

    // a non-default choice: connectors on, skills off — then the second project
    const choice = { 'account-connectors': true, 'account-skills': false }
    const p = await api(s, 'PATCH', '/api/settings', { startingSet: { [ENGINE]: choice } })
    add(rowsA, 'choose non-default (PATCH)', 'machine', '200', p.status === 200 ? '200' : `${p.status} ${JSON.stringify(p.json).slice(0, 120)}`)
    const w = await api(s, 'POST', '/api/agents', { name: 'Writer', folder: projB })
    add(
      rowsA,
      'agent on a 2nd folder (chosen)',
      'new folder',
      '201, no startWarn',
      `${w.status}${w.json.startWarn ? ` startWarn: ${String(w.json.startWarn)}` : ', no startWarn'}`,
    )
    add(
      rowsA,
      'starting set written (chosen)',
      'project local file',
      '{"syncClaudeAiPlugins":false,"syncClaudeAiSkills":false}',
      startingKeys(localFile(projB)),
    )
    const cb = await check(s, projB)
    if (!cb.ok) add(rowsA, '«Check now» (connectors chosen on)', 'project', 'answers', `failed: ${cb.error}`)
    else if (connectorsOf(cb).length > 0)
      add(rowsA, '«Check now» (connectors chosen on)', 'project', 'connectors present', `connectors present (${connectorsOf(cb).length})`, true)
    else note(rowsA, '«Check now» (connectors chosen on)', 'project', 'answers; no connector in the reading (this login may send none)')
    const back = await api(s, 'PATCH', '/api/settings', { startingSet: { [ENGINE]: { 'account-connectors': null, 'account-skills': null } } })
    const again = await api(s, 'GET', '/api/settings')
    const left =
      isMap(again.json.startingSet) && Array.isArray(again.json.startingSet[ENGINE])
        ? (again.json.startingSet[ENGINE] as Json[]).filter((x) => 'chosen' in x).length
        : -1
    add(
      rowsA,
      'choice taken back (null)',
      'machine',
      'none chosen',
      back.status !== 200 ? `${back.status}` : left === 0 ? 'none chosen' : `${left} still chosen`,
    )
    // the clean HOME: nothing of Silos landed in it but what Claude writes
    note(
      rowsA,
      'clean HOME after the phase',
      'machine',
      `.claude holds [${readdirSync(join(home, '.claude')).sort().join(', ')}]; ~ holds [${readdirSync(home).sort().join(', ')}]`,
    )
  } finally {
    stopSilos(s)
    await waitExit(s)
  }
}

// ── phase B: the places ──────────────────────────────────────────────────
async function phaseB(base: string, bed: string, main: boolean): Promise<void> {
  const home = join(base, 'B-home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  // the WHOLE config dir linked (never its credential alone); ~/.claude.json
  // lives beside it and holds no credential
  symlinkSync(bed, join(home, '.claude'))
  const claudeJson = main ? join(homedir(), '.claude.json') : join(bed, '.claude.json')
  if (existsSync(claudeJson)) symlinkSync(claudeJson, join(home, '.claude.json'))

  // the bed's files are snapshotted and journaled; the owner's live setup
  // (--main-login) gets no journal inside it and no snapshot of its bytes
  const journal: Journal = { files: {}, plugin: false }
  if (!main) {
    for (const rel of SNAPSHOT) journal.files[rel] = readOr(join(bed, rel))
    saveJournal(bed, journal)
  }
  const userFile = join(bed, 'settings.json')
  const hashBefore = main ? hashOf(userFile) : null
  let s: Silos | null = null
  try {
    // fixtures: the echo MCP, the marketplace, the project
    const fx = join(base, 'B-fixtures')
    mkdirSync(fx, { recursive: true })
    const echo = join(fx, 'mcp-echo.mjs')
    writeFileSync(echo, MCP_ECHO)
    const market = join(fx, 'market')
    writeMarketplace(market, echo)
    const project = real(
      (() => {
        const p = join(base, 'B-projects', 'places')
        mkdirSync(p, { recursive: true })
        return p
      })(),
    )
    writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { [MCPJSON]: { command: process.execPath, args: [echo] } } }, null, 2))
    mkdirSync(join(project, '.claude'), { recursive: true })
    writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ enableAllProjectMcpServers: true }, null, 2))
    // the test plugin: in the bed only — never a plugin or marketplace added to or removed from the owner's setup
    let pluginSkip: string | undefined = 'main login: no plugin is installed in the owner’s setup'
    if (!main) {
      journal.plugin = true
      saveJournal(bed, journal)
      const added = claudeCli(bed, ['plugin', 'marketplace', 'add', market, '--scope', 'user'])
      const installed = added.status === 0 ? claudeCli(bed, ['plugin', 'install', PLUGIN_ID, '--scope', 'user']) : added
      pluginSkip = installed.status === 0 ? undefined : `the test plugin did not install: ${installed.out.split('\n').pop() ?? ''}`
    }
    // a conversation of the project, as a transcript the index reads (no turn)
    const sid = randomUUID()
    s = await startSilos(base, 'B', home, (root) => {
      const dir = join(root, project.replace(/[/.]/g, '-'))
      mkdirSync(dir, { recursive: true })
      const t = '2026-11-24T10:00:00.000Z'
      writeFileSync(
        join(dir, `${sid}.jsonl`),
        [
          {
            type: 'user',
            cwd: project,
            sessionId: sid,
            timestamp: t,
            uuid: randomUUID(),
            message: { role: 'user', content: 'fixture of the Silos places smoke' },
          },
          {
            type: 'assistant',
            cwd: project,
            sessionId: sid,
            timestamp: t,
            uuid: randomUUID(),
            message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
          },
        ]
          .map((l) => JSON.stringify(l))
          .join('\n') + '\n',
      )
    })
    const S = s
    // everything the account sends on in new projects here, so its heads have something to take out
    await api(S, 'PATCH', '/api/settings', { startingSet: { [ENGINE]: { 'account-plugins': true, 'account-connectors': true, 'account-skills': true } } })
    for (const name of ['Builder', 'Writer']) {
      const r = await api(S, 'POST', '/api/agents', { name, folder: project })
      if (r.status !== 201) throw new Error(`creating ${name}: ${r.status} ${JSON.stringify(r.json)}`)
    }
    await api(S, 'PATCH', '/api/settings', { startingSet: { [ENGINE]: { 'account-plugins': null, 'account-connectors': null, 'account-skills': null } } })
    const loads = await api(S, 'GET', `${F(project)}/loads`)
    const rows = (Array.isArray(loads.json.rows) ? loads.json.rows : []) as Json[]
    const mcpRow = rows.find((r) => r.kind === 'mcp' && r.name === MCPJSON && r.parent === undefined)
    const pluginRow = rows.find((r) => r.kind === 'plugin' && (r.name === PLUGIN_ID || String(r.name).startsWith(`${PLUGIN}@`)))
    const base0 = await check(S, project)
    console.log(
      `baseline: ${!base0.ok ? `check failed: ${base0.error}` : main ? `${base0.servers.length} servers, ${MCPJSON} ${has(base0, MCPJSON) ? 'present' : 'absent'}, ${connectorsOf(base0).length} connectors` : `servers [${names(base0).join(', ')}]`}`,
    )
    if (!base0.ok) throw new Error(`the baseline check failed: ${base0.error}`)
    const mcpKey = typeof mcpRow?.key === 'string' ? mcpRow.key : null

    // 1 · project off/on, the .mcp.json server
    if (!mcpKey || !has(base0, MCPJSON))
      skip(rowsB, 'project: .mcp.json server', 'project', 'off → absent', mcpKey ? 'not in the baseline reading' : 'no row for it in GET …/loads')
    else {
      const off = await api(S, 'POST', `${F(project)}/loads/switch`, { key: mcpKey, to: 'off' })
      add(
        rowsB,
        'project off: .mcp.json server',
        'project',
        'absent',
        off.status !== 200 ? `switch ${off.status} ${String(off.json.error)}` : present(await check(S, project), MCPJSON),
      )
      const on = await api(S, 'POST', `${F(project)}/loads/switch`, { key: mcpKey, to: 'on' })
      add(
        rowsB,
        'project on: .mcp.json server',
        'project',
        'present',
        on.status !== 200 ? `switch ${on.status} ${String(on.json.error)}` : present(await check(S, project), MCPJSON),
      )
    }

    // 2 · «Only Builder»
    if (!mcpKey) skip(rowsB, '«Only Builder»', 'agent', '—', 'no row')
    else {
      const only = await api(S, 'POST', `${F(project)}/loads/only`, { key: mcpKey, agent: 'builder' })
      if (only.status !== 200) add(rowsB, '«Only Builder»', 'agent', '200', `${only.status} ${String(only.json.error)}`)
      else {
        add(rowsB, '«Only Builder»: check as Writer', 'agent writer', 'absent', present(await check(S, project, 'writer'), MCPJSON))
        add(rowsB, '«Only Builder»: check as Builder', 'agent builder', 'present', present(await check(S, project, 'builder'), MCPJSON))
        const back = await api(S, 'POST', `${F(project)}/loads/switch`, { key: mcpKey, to: 'on', scope: 'agent', agent: 'writer' })
        add(
          rowsB,
          'Writer back on: check as Writer',
          'agent writer',
          'present',
          back.status !== 200 ? `switch ${back.status} ${String(back.json.error)}` : present(await check(S, project, 'writer'), MCPJSON),
        )
      }
    }

    // 3 · this conversation (a transcript the index knows; a check cannot run as a conversation, so its line is read)
    if (!mcpKey) skip(rowsB, 'conversation off', 'conversation', '—', 'no row')
    else {
      const lineOf = async (): Promise<string> => {
        const g = await api(S, 'GET', `${F(project)}/loads?conversation=${sid}`)
        if (g.status !== 200) return `GET ${g.status} ${String(g.json.error)}`
        const row = ((g.json.rows ?? []) as Json[]).find((r) => r.key === mcpKey)
        const line = (row?.at as Json[] | undefined)?.find((l) => l.place === 'conversation')
        return line ? `line ${String(line.result)}${line.entry ? ` (entry ${String(line.entry)})` : ''}` : 'no conversation line'
      }
      const off = await api(S, 'POST', `${F(project)}/loads/switch`, { key: mcpKey, to: 'off', scope: 'conversation', conversation: sid })
      if (off.status === 404)
        skip(rowsB, 'conversation off', 'conversation', 'line off', `the seeded conversation is not one Silos knows (404 ${String(off.json.error)})`)
      else {
        add(
          rowsB,
          'conversation off: its line',
          'conversation',
          'line off',
          off.status !== 200 ? `switch ${off.status} ${String(off.json.error)}` : await lineOf(),
        )
        add(rowsB, 'conversation off: project check', 'project', 'present', present(await check(S, project), MCPJSON))
        const on = await api(S, 'POST', `${F(project)}/loads/switch`, { key: mcpKey, to: 'on', scope: 'conversation', conversation: sid })
        add(rowsB, 'conversation on: its line', 'conversation', 'line on', on.status !== 200 ? `switch ${on.status} ${String(on.json.error)}` : await lineOf())
      }
    }

    // 4 · This machine: the test plugin (the bed's user file, by Silos' machine writer)
    const pluginKey = typeof pluginRow?.key === 'string' ? pluginRow.key : null
    if (main) await machineDenyCase(S, project, mcpKey, userFile)
    else if (pluginSkip || !pluginKey || !has(base0, PLUGIN_SERVER))
      skip(rowsB, 'machine off: plugin', 'machine', 'absent', pluginSkip ?? (pluginKey ? `${PLUGIN_SERVER} not in the baseline reading` : 'no plugin row'))
    else {
      const userPlugin = (): string => {
        try {
          const j: unknown = JSON.parse(readOr(join(bed, 'settings.json')) ?? '{}')
          const ep = isMap(j) && isMap(j.enabledPlugins) ? j.enabledPlugins : {}
          return PLUGIN_ID in ep ? String(ep[PLUGIN_ID]) : 'no entry'
        } catch {
          return 'unreadable'
        }
      }
      const off = await api(S, 'POST', `${F(project)}/loads/switch`, { key: pluginKey, to: 'off', scope: 'machine' })
      add(rowsB, 'machine off: bed settings.json', 'machine', 'false', off.status !== 200 ? `switch ${off.status} ${String(off.json.error)}` : userPlugin())
      add(rowsB, 'machine off: plugin server', 'machine', 'absent', present(await check(S, project), PLUGIN_SERVER))
      const on = await api(S, 'POST', `${F(project)}/loads/switch`, { key: pluginKey, to: 'on', scope: 'machine' })
      add(rowsB, 'machine on: bed settings.json', 'machine', 'true', on.status !== 200 ? `switch ${on.status} ${String(on.json.error)}` : userPlugin())
      add(rowsB, 'machine on: plugin server', 'machine', 'present', present(await check(S, project), PLUGIN_SERVER))
    }

    // 5 · the account's connectors head at the project
    if (connectorsOf(base0).length === 0) skip(rowsB, 'connectors head off', 'project', 'absent', 'no claude.ai connector in the baseline reading')
    else {
      const off = await api(S, 'POST', `${F(project)}/loads/switch`, { origin: 'connectors', to: 'off' })
      add(
        rowsB,
        'connectors head off',
        'project',
        'absent',
        off.status !== 200 ? `switch ${off.status} ${String(off.json.error)}` : conn(await check(S, project)),
      )
      const on = await api(S, 'POST', `${F(project)}/loads/switch`, { origin: 'connectors', to: 'on' })
      add(rowsB, 'connectors head on', 'project', 'present', on.status !== 200 ? `switch ${on.status} ${String(on.json.error)}` : conn(await check(S, project)))
    }

    // 6 · «Turn all off» on the tab's head at the project, then «Undo»
    {
      const before = await check(S, project)
      const keys = rows.map((r) => r.key).filter((k): k is string => typeof k === 'string')
      const off = await api(S, 'POST', `${F(project)}/loads/bulk`, { keys, origins: ['connectors'], to: 'off', group: 'tab' })
      if (off.status !== 200) add(rowsB, '«Turn all off»', 'project', '200', `${off.status} ${String(off.json.error)}`)
      else {
        const r = await check(S, project)
        const left = [MCPJSON, PLUGIN_SERVER].filter((n) => has(r, n))
        add(
          rowsB,
          '«Turn all off»: mcp + plugin + connectors',
          'project',
          'all absent',
          !r.ok
            ? `check failed: ${r.error}`
            : left.length === 0 && connectorsOf(r).length === 0
              ? 'all absent'
              : `still: ${[...left, ...connectorsOf(r)].join(', ')}`,
        )
        note(rowsB, '«Turn all off»: what stays', 'project', main ? `${r.servers.length} servers` : `[${names(r).join(', ')}]`)
        const u = await api(S, 'POST', `${F(project)}/loads/bulk/undo`, { group: 'tab' })
        const ru = await check(S, project)
        const want = names(before),
          got = names(ru)
        const lost = want.filter((n) => !got.includes(n)),
          gained = got.filter((n) => !want.includes(n))
        add(
          rowsB,
          '«Undo»: reading as before',
          'project',
          'same servers',
          u.status !== 200
            ? `undo ${u.status} ${String(u.json.error)}`
            : !ru.ok
              ? `check failed: ${ru.error}`
              : lost.length + gained.length === 0
                ? 'same servers'
                : `missing [${lost.join(', ')}] new [${gained.join(', ')}]`,
        )
      }
    }
  } finally {
    if (s) {
      stopSilos(s)
      await waitExit(s)
    }
    if (main) {
      // the smoke's one entry out again if anything left it, then the owner's file as it was
      const leftover = removeSmokeDeny(userFile)
      const same = hashOf(userFile) === hashBefore
      add(
        rowsB,
        'owner settings.json afterwards',
        'machine',
        'byte-identical',
        same
          ? 'byte-identical'
          : `DIFFERS${leftover ? ' (the smoke’s deny was left and has been removed)' : ' (not rewritten: an edit made during the run, or the writer’s formatting)'}`,
      )
      if (existsSync(MAIN_JOURNAL)) unlinkSync(MAIN_JOURNAL)
    } else {
      undo(bed, journal)
      const after = SNAPSHOT.filter((rel) => readOr(join(bed, rel)) !== journal.files[rel])
      note(rowsB, 'bed restored', 'machine', after.length === 0 ? 'settings.json + plugin files byte-identical' : `DIFFERS: ${after.join(', ')}`)
      if (after.length > 0) rowsB[rowsB.length - 1]!.verdict = 'FAIL'
    }
  }
}

// ── --main-login: the machine case on the owner's live setup ─────────────
// ONE entry, `deniedMcpServers: [{serverName: "silos-smoke-mcp"}]` — a name
// that exists nowhere else — written only by Silos' own machine writer
// (POST …/loads/switch scope 'machine'), journaled first OUTSIDE ~/.claude
// (no copy of the file's bytes, only its hash), and taken out by the same
// writer's «on». If Silos refuses the line (a server of one project has no
// machine line), nothing is written and the case says so.
const SMOKE_DENY = { serverName: MCPJSON }
const MAIN_JOURNAL = join(homedir(), '.silos-smoke', 'main-journal.json')
function hashOf(file: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}
const isSmokeDeny = (e: unknown): boolean => isMap(e) && Object.keys(e).length === 1 && e.serverName === SMOKE_DENY.serverName
function hasSmokeDeny(file: string): boolean {
  try {
    const j: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return isMap(j) && Array.isArray(j.deniedMcpServers) && j.deniedMcpServers.some(isSmokeDeny)
  } catch {
    return false
  }
}
/** Takes exactly the smoke's entry out (a killed run's leftover); true when it was there. */
function removeSmokeDeny(file: string): boolean {
  let j: unknown
  try {
    j = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return false
  }
  if (!isMap(j) || !Array.isArray(j.deniedMcpServers) || !j.deniedMcpServers.some(isSmokeDeny)) return false
  const next = j.deniedMcpServers.filter((e) => !isSmokeDeny(e))
  if (next.length > 0) j.deniedMcpServers = next
  else delete j.deniedMcpServers
  writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`)
  return true
}
async function machineDenyCase(S: Silos, project: string, mcpKey: string | null, userFile: string): Promise<void> {
  if (!mcpKey) {
    skip(rowsB, 'machine off: smoke deny', 'machine', 'entry written', 'no row for the smoke server')
    return
  }
  mkdirSync(dirname(MAIN_JOURNAL), { recursive: true, mode: 0o700 })
  writeFileSync(MAIN_JOURNAL, JSON.stringify({ file: userFile, entry: SMOKE_DENY, before: hashOf(userFile), at: new Date().toISOString() }, null, 2), {
    mode: 0o600,
  })
  const off = await api(S, 'POST', `${F(project)}/loads/switch`, { key: mcpKey, to: 'off', scope: 'machine' })
  if (off.status === 409 && !hasSmokeDeny(userFile)) {
    skip(rowsB, 'machine off: smoke deny', 'machine', 'entry written', `Silos refused the machine line (409: ${String(off.json.error)}) — nothing written`)
    return
  }
  add(
    rowsB,
    'machine off: smoke deny in settings.json',
    'machine',
    'entry written',
    off.status !== 200 ? `switch ${off.status} ${String(off.json.error)}` : hasSmokeDeny(userFile) ? 'entry written' : 'no entry',
  )
  add(rowsB, 'machine off: smoke server', 'machine', 'absent', present(await check(S, project), MCPJSON))
  const on = await api(S, 'POST', `${F(project)}/loads/switch`, { key: mcpKey, to: 'on', scope: 'machine' })
  add(
    rowsB,
    'machine on: smoke deny removed',
    'machine',
    'no entry',
    on.status !== 200 ? `switch ${on.status} ${String(on.json.error)}` : hasSmokeDeny(userFile) ? 'entry still there' : 'no entry',
  )
  add(rowsB, 'machine on: smoke server', 'machine', 'present', present(await check(S, project), MCPJSON))
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const main = args.includes('--main-login') || process.env.SILOS_SMOKE_MAIN === '1'
  const which = (args.find((a) => !a.startsWith('--')) ?? 'AB').toUpperCase()
  if (main) return mainLogin(which)
  const beds = [
    ...(which.includes('A') ? [{ phase: 'A · clean install', bed: CLEAN_BED, other: PLACES_BED }] : []),
    ...(which.includes('B') ? [{ phase: 'B · the places', bed: PLACES_BED, other: CLEAN_BED }] : []),
  ]
  if (beds.length === 0) {
    console.log('Usage: smoke-silos-places.mts [A|B|AB]')
    return 2
  }
  for (const b of beds) {
    const why = bedRefusal(b.bed, b.other)
    if (why) {
      console.log(`REFUSED (${b.phase}): ${why}`)
      return 2
    }
  }
  const stale = which.includes('B') ? readOr(journalPath(PLACES_BED)) : null
  if (stale !== null) {
    console.log('A previous run did not finish: putting the places bed back as its journal says.')
    undo(PLACES_BED, JSON.parse(stale) as Journal)
  }
  // every bed of the run signed in, or nothing runs
  const out = beds.filter((b) => !existsSync(join(b.bed, '.credentials.json')) || !signedIn(b.bed))
  if (out.length > 0) {
    for (const b of out)
      console.log(
        `${b.phase}: the bed ${b.bed} is not signed in. Sign it in once (its own login, never a link):\n  CLAUDE_CONFIG_DIR=${b.bed} claude auth login`,
      )
    return 3
  }
  const version = claudeCli(beds[0]!.bed, ['--version']).out.split('\n')[0] ?? '?'
  const base = mkdtempSync(join(tmpdir(), 'silos-places-'))
  let setup: string | null = null
  try {
    if (which.includes('A')) {
      try {
        await phaseA(base, CLEAN_BED)
      } catch (err) {
        setup = `phase A: ${msg(err)}`
      }
    }
    if (which.includes('B')) {
      try {
        await phaseB(base, PLACES_BED, false)
      } catch (err) {
        setup = `${setup ? `${setup}\n` : ''}phase B: ${msg(err)}`
      }
    }
  } finally {
    // nothing started under a phase's HOME outlives it (a server that failed to start included)
    for (const label of ['A', 'B']) await reapHome(join(base, `${label}-home`))
    rmSync(base, { recursive: true, force: true })
  }
  return report(`Claude Code ${version} · ${beds.map((b) => `${b.phase.split(' ')[0] ?? ''} bed ${b.bed}`).join(' · ')}`, setup)
}

/** --main-login (or SILOS_SMOKE_MAIN=1): the places phase ONLY, on the
 *  owner's real login — the temp HOME's `.claude` is the whole real
 *  ~/.claude (the same credential file, refreshed in place like any other
 *  session: no copy, no link of the file). No plugin or marketplace is ever
 *  installed or removed (the cases that need the test plugin are skipped);
 *  the machine case writes only the smoke's own deny (machineDenyCase); the
 *  connectors head and «Turn all off» + Undo run at the temp project only.
 *  Nothing under ~/.silos is read or written. The clean install is not run
 *  here: it needs an empty machine. */
async function mainLogin(which: string): Promise<number> {
  if (which.includes('A')) console.log('--main-login: the clean install (A) is not run on the owner’s setup — it needs an empty machine; the places (B) only.')
  const realDir = join(homedir(), '.claude')
  const status = spawnSync('claude', ['auth', 'status', '--json'], { env: cleanEnv(), encoding: 'utf8', timeout: 120_000 })
  const raw = `${status.stdout ?? ''}`
  let loggedIn = false
  try {
    const j: unknown = JSON.parse(raw.slice(raw.indexOf('{')))
    loggedIn = isMap(j) && j.loggedIn === true
  } catch {
    loggedIn = false
  }
  if (!loggedIn) {
    console.log('B · the places (--main-login): this machine’s own login is not signed in. Sign it in:\n  claude auth login')
    return 3
  }
  if (existsSync(MAIN_JOURNAL)) {
    const left = removeSmokeDeny(join(realDir, 'settings.json'))
    console.log(`A previous --main-login run did not finish: ${left ? 'the smoke’s deny was taken out of ~/.claude/settings.json' : 'nothing of it was left'}.`)
    unlinkSync(MAIN_JOURNAL)
  }
  const version = (spawnSync('claude', ['--version'], { env: cleanEnv(), encoding: 'utf8' }).stdout ?? '').split('\n')[0] ?? '?'
  const base = mkdtempSync(join(tmpdir(), 'silos-places-'))
  let setup: string | null = null
  try {
    try {
      await phaseB(base, realDir, true)
    } catch (err) {
      setup = `phase B: ${msg(err)}`
    }
  } finally {
    await reapHome(join(base, 'B-home'))
    rmSync(base, { recursive: true, force: true })
  }
  return report(`Claude Code ${version} · B on this machine’s own login (~/.claude, --main-login)`, setup)
}

function report(head: string, setup: string | null): number {
  console.log(`\n${head}`)
  if (rowsA.length) table('A · clean install', rowsA)
  if (rowsB.length) table('B · the places', rowsB)
  if (setup) console.log(`\nSETUP FAILED:\n${setup}`)
  const fails = [...rowsA, ...rowsB].filter((r) => r.verdict === 'FAIL').length
  console.log(
    `\n${fails} FAIL · ${[...rowsA, ...rowsB].filter((r) => r.verdict === 'PASS').length} PASS · ${[...rowsA, ...rowsB].filter((r) => r.verdict === 'SKIPPED').length} SKIPPED`,
  )
  return fails > 0 ? 1 : setup ? 2 : 0
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err)
    process.exit(2)
  },
)
