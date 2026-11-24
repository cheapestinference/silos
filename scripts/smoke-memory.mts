#!/usr/bin/env -S npx tsx
// smoke-memory.mts — measures, on a REAL `claude`, which instruction files a
// conversation loads and what `claudeMdExcludes` / `autoMemoryEnabled` keep
// out, per file kind and settings tier: the memory-places spec's T1 (§6, its
// facts table §7). A smoke of its own (not a group of smoke-scopes.mts):
// that one runs in a config dir of its own; this one runs on the login you
// use, in place, and writes nothing under it.
//
// THE LOGIN — the default config dir (~/.claude), used IN PLACE: every
// launch runs without CLAUDE_CONFIG_DIR and without the shell's ANTHROPIC_*,
// CLAUDE*, SILOS_* variables; the credential is never opened, copied or
// linked (`claude auth status --json` is asked for `loggedIn` only). Not
// signed in → every case SKIPPED. Nothing is created, edited or deleted
// under ~/.claude or ~/.silos by this script; Claude Code itself writes each
// launch's transcript under ~/.claude/projects/<the temp folder's key>/ —
// that transcript IS the signal (spec §6) — and the script prints those
// folders at the end (they hold only fixture text and the login's own
// personal instructions, and are left for the owner to clear).
// Auto memory is pointed at a temp folder (flag-tier `autoMemoryDirectory`)
// in every launch, so no real auto memory is read or written.
// CASES THAT NEED A PERSONAL (user-level) FILE OR THE USER TIER — a personal
// CLAUDE.md or rule, ~/.claude/settings.json — are SKIPPED here: «measured
// 24-11 by transcript read-back (spec §6)».
//
// WHAT IT WRITES — only in fresh temp folders, removed in `finally`:
//   <root>/CLAUDE.md                     a folder above the project
//   <root>/proj/                         the project (a git repository):
//     CLAUDE.md (imports @./notes.md) · notes.md · .claude/CLAUDE.md ·
//     .claude/rules/always.md · .claude/rules/scoped.md (paths: sub/**) ·
//     CLAUDE.local.md (git-ignored) · AGENTS.md · sub/CLAUDE.md · sub/x.txt ·
//     .claude/settings.json / settings.local.json (the repository and local
//     tiers, rewritten per case) · .claude/worktrees/x (a git worktree)
//   <alone>/AGENTS.md                    no CLAUDE.md in it or above (/tmp)
//   <extra>/CLAUDE.md · x.txt            an additional directory
//   <automem>/MEMORY.md                  the auto memory every launch points at
//
// THE SIGNAL, read two ways per launch (a verdict needs both to agree):
//   (a) the transcript: `attachment` records `instructions` (base; a later
//       start's delta with `changed`, `removed`) and `nested_memory`,
//       replayed; a fresh conversation with no record = nothing loaded;
//   (b) `getContextUsage({detail:'summary'}).memoryFiles` at `system/init`
//       ('full' if the summary is empty) — start files only.
// Each launch is a FRESH conversation (m-resume resumes m-base's), model
// haiku, permissions NEVER bypassed (mode default, Read the only tool, a
// canUseTool that allows it only inside the run's temp folders), hooks off (`disableAllHooks`; the AGENTS.md-alone cases also run
// with hooks on, as the built-in plugin loads it through its hooks). Every
// launch is stopped right after init except the on-demand ones (one short
// turn each: «read <file>, reply ok»).
//
// VERDICTS: PASS = observed as the spec expects; FAIL = it does not; NOTED =
// the spec makes no claim (or says unverified) — the observation is the
// measurement; DISAGREE = the transcript and getContextUsage differ (both
// printed); SKIPPED = not measurable in this run (said why).
// REFUSED = an instruction file sits above the case's temp folder (the case is not launched).
// Exit 0 = no FAIL/DISAGREE/REFUSED; 1 = one; 3 = not signed in.
//
// RUN: npx tsx scripts/smoke-memory.mts [case-prefix...]
import { spawnSync, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { claudeOnPath, withClaudeExecutable } from '../server/src/harnesses/claude-code/binary.js'
import { filesCarry, withFilesCarried } from '../server/src/harnesses/claude-code/local-holds.js'

type Json = Record<string, unknown>
type Source = 'user' | 'project' | 'local'
const ALL: Source[] = ['user', 'project', 'local']
const isMap = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const MARK = 'silos-smoke-memory fixture'

// ── the environment: the default login, nothing inherited that steers it ──
function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (/^(CLAUDE|ANTHROPIC_|SILOS_)/.test(k)) continue
    env[k] = v
  }
  return { ...env, ...extra }
}
function cli(args: string[]): string {
  const r = spawnSync(claudeOnPath() ?? 'claude', args, { env: cleanEnv(), encoding: 'utf8', timeout: 60_000 })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
}
function signedIn(): boolean {
  const out = cli(['auth', 'status', '--json'])
  try {
    const j: unknown = JSON.parse(out.slice(out.indexOf('{')))
    return isMap(j) && j.loggedIn === true
  } catch {
    return false
  }
}

// ── the fixtures ─────────────────────────────────────────────────────────
interface Bed {
  root: string
  proj: string
  wt: string
  alone: string
  extra: string
  automem: string
  temps: string[]
}
const fx = (name: string): string => `# ${MARK}: ${name}\n\nA fixture of scripts/smoke-memory.mts. Nothing to do here.\n`
function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
const INSTR_NAMES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.claude']
/** the first ancestor of `dir` holding an instruction file the engine walks */
function ancestorHit(dir: string): string | null {
  let d = dirname(dir)
  while (d !== dirname(d)) {
    for (const n of INSTR_NAMES) if (existsSync(join(d, n))) return join(d, n)
    d = dirname(d)
  }
  return null
}
function makeBed(): Bed {
  const mk = (p: string): string => realpathSync(mkdtempSync(join(tmpdir(), p)))
  const root = mk('silos-smoke-memory-')
  const alone = mk('silos-smoke-memory-alone-')
  const extra = mk('silos-smoke-memory-extra-')
  const automem = mk('silos-smoke-memory-automem-')
  const proj = join(root, 'proj')
  put(join(root, 'CLAUDE.md'), fx('parent'))
  put(join(proj, 'CLAUDE.md'), `${fx('project')}\n@./notes.md\n`)
  put(join(proj, 'notes.md'), fx('import'))
  put(join(proj, '.claude', 'CLAUDE.md'), fx('dotclaude'))
  put(join(proj, '.claude', 'rules', 'always.md'), fx('rule'))
  put(join(proj, '.claude', 'rules', 'scoped.md'), `---\npaths:\n  - "sub/**"\n---\n${fx('scoped rule')}`)
  put(join(proj, 'AGENTS.md'), fx('agents beside a CLAUDE.md'))
  put(join(proj, 'sub', 'CLAUDE.md'), fx('subfolder'))
  put(join(proj, 'sub', 'x.txt'), 'x\n')
  put(join(proj, 'wt.txt'), 'w\n')
  put(join(proj, '.gitignore'), 'CLAUDE.local.md\n.claude/settings.local.json\n.claude/worktrees/\n')
  const git = (args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.com', ...args], { cwd: proj, stdio: 'ignore' })
  }
  git(['init', '-q', '-b', 'main'])
  git(['add', '-A'])
  git(['commit', '-qm', 'fixture'])
  const wt = join(proj, '.claude', 'worktrees', 'x')
  git(['worktree', 'add', '-q', wt])
  put(join(proj, 'CLAUDE.local.md'), fx('local'))
  put(join(proj, '.claude', 'settings.json'), '{}')
  put(join(proj, '.claude', 'settings.local.json'), '{}')
  put(join(alone, 'AGENTS.md'), fx('agents alone'))
  put(join(extra, 'CLAUDE.md'), fx('additional directory'))
  put(join(extra, 'x.txt'), 'e\n')
  put(join(automem, 'MEMORY.md'), fx('auto memory index'))
  return { root, proj, wt, alone, extra, automem, temps: [root, alone, extra, automem] }
}

// ── one launch ───────────────────────────────────────────────────────────
interface Loaded {
  type: string
  how: 'start' | 'nested'
  parent?: string
}
interface Obs {
  sid: string | null
  version: string | null
  transcript: string | null
  /** the replay: path → how it is in force */
  files: Map<string, Loaded>
  removed: string[]
  deltas: number
  usage: Map<string, string> | null
  raw: string
  replied: boolean
  error?: string
}
interface Launch {
  cwd: string
  sources?: Source[]
  flag?: Json
  local?: Json
  repo?: Json
  env?: Record<string, string>
  addDirs?: string[]
  hooks?: true
  /** a short turn that reads this file (relative to cwd or absolute) */
  read?: string
  resume?: string
  /** Silos' own carry of the files the launch skips (a run / a heartbeat) */
  carry?: 'run' | 'heartbeat'
}

const PROJECTS = join(homedir(), '.claude', 'projects')
function findTranscript(sid: string): string | null {
  let dirs: string[] = []
  try {
    dirs = readdirSync(PROJECTS)
  } catch {
    return null
  }
  for (const d of dirs) {
    const p = join(PROJECTS, d, `${sid}.jsonl`)
    if (existsSync(p)) return p
  }
  return null
}
function replay(raw: string, since = 0): Pick<Obs, 'files' | 'removed' | 'deltas'> {
  const files = new Map<string, Loaded>()
  const removed: string[] = []
  let deltas = 0
  const lines = raw.split('\n')
  for (let i = since; i < lines.length; i++) {
    let r: unknown
    try {
      r = JSON.parse(lines[i]!)
    } catch {
      continue
    }
    if (!isMap(r) || r.type !== 'attachment' || !isMap(r.attachment)) continue
    const a = r.attachment
    if (a.type === 'instructions') {
      if (a.changed === true) deltas++
      else files.clear()
      for (const f of Array.isArray(a.files) ? a.files : [])
        if (isMap(f) && typeof f.path === 'string') files.set(f.path, { type: String(f.type ?? '?'), how: 'start' })
      for (const p of Array.isArray(a.removed) ? a.removed : []) {
        const path = typeof p === 'string' ? p : isMap(p) && typeof p.path === 'string' ? p.path : null
        if (path) {
          files.delete(path)
          removed.push(path)
        }
      }
    }
    if (a.type === 'nested_memory' && typeof a.path === 'string') {
      const c = isMap(a.content) ? a.content : {}
      files.set(a.path, { type: String(c.type ?? '?'), how: 'nested', ...(typeof c.parent === 'string' ? { parent: c.parent } : {}) })
    }
  }
  return { files, removed, deltas }
}

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
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const DENIED_TOOLS = ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent']
const inside = (root: string, p: string): boolean => p === root || p.startsWith(root + sep)
/** canUseTool: Read of a path inside one of `roots` (links resolved), nothing else. Read is
 *  deliberately NOT in allowedTools — that would auto-allow it and skip this callback. */
function readOnlyIn(roots: string[]) {
  return async (
    tool: string,
    input: Record<string, unknown>,
  ): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }> => {
    const raw = typeof input.file_path === 'string' ? input.file_path : ''
    let real = ''
    try {
      real = raw ? realpathSync(resolve(raw)) : ''
    } catch {
      real = ''
    }
    if (tool === 'Read' && real && roots.some((r) => inside(r, real))) return { behavior: 'allow', updatedInput: input }
    return { behavior: 'deny', message: 'the memory smoke allows only Read inside its temp folders' }
  }
}
/** A case launched in (or adding) a temp folder with an instruction file ABOVE that folder is refused. */
function refusal(bed: Bed, l: Launch): string | null {
  for (const d of [l.cwd, ...(l.addDirs ?? [])]) {
    const top = bed.temps.find((t) => inside(t, d))
    if (!top) return `${d} is not one of the run's temp folders`
    const hit = ancestorHit(top)
    if (hit) return `an instruction file sits above ${top}: ${hit}`
  }
  return null
}
let TURNS = 0
let LAUNCHES = 0

async function launch(bed: Bed, l: Launch): Promise<Obs> {
  const repoFile = join(bed.proj, '.claude', 'settings.json')
  const localFile = join(bed.proj, '.claude', 'settings.local.json')
  writeFileSync(repoFile, JSON.stringify(l.repo ?? {}, null, 2))
  writeFileSync(localFile, JSON.stringify(l.local ?? {}, null, 2))
  const sources = l.sources ?? ALL
  let flag: Json = { autoMemoryDirectory: bed.automem, ...(l.hooks ? {} : { disableAllHooks: true }), ...(l.flag ?? {}) }
  if (l.carry) flag = withFilesCarried(flag, filesCarry(bed.proj, { sources, onlyRemoves: l.carry === 'heartbeat' }), { onlyRemoves: l.carry === 'heartbeat' })
  const prompt = l.read ? `Read the file ${l.read} with the Read tool, then reply with the single word ok.` : 'ok'
  const options: Json = {
    cwd: l.cwd,
    env: cleanEnv(l.env),
    settingSources: sources,
    settings: flag,
    model: 'haiku',
    // never bypass permissions: Read is the only tool, and only inside the run's temp folders
    permissionMode: 'default',
    tools: ['Read'],
    disallowedTools: DENIED_TOOLS,
    canUseTool: readOnlyIn(bed.temps),
    // a read turn: one tool call and the reply; every other launch stops at init
    maxTurns: l.read ? 2 : 1,
    ...(l.addDirs ? { additionalDirectories: l.addDirs } : {}),
    ...(l.resume ? { resume: l.resume } : {}),
  }
  LAUNCHES++
  if (l.read) TURNS++
  const obs: Obs = { sid: null, version: null, transcript: null, files: new Map(), removed: [], deltas: 0, usage: null, raw: '', replied: false }
  const handle = query({ prompt, options: withClaudeExecutable(options) as never })
  const timer = setTimeout(() => {
    obs.error = 'timeout'
    void handle.interrupt().catch(() => {})
  }, 180_000)
  let before = 0
  try {
    for await (const m of handle as unknown as AsyncIterable<Json>) {
      if (m.type === 'system' && m.subtype === 'init') {
        obs.sid = typeof m.session_id === 'string' ? m.session_id : null
        obs.version = typeof m.claude_code_version === 'string' ? m.claude_code_version : null
        if (l.resume && obs.sid) {
          const t = findTranscript(l.resume)
          before = t ? readFileSync(t, 'utf8').split('\n').length - 1 : 0
        }
        const mem = async (detail: 'summary' | 'full'): Promise<Array<{ path: string; type: string }>> => {
          const u = await withTimeout(handle.getContextUsage({ detail }), 30_000)
          return isMap(u) && Array.isArray(u.memoryFiles) ? (u.memoryFiles as Array<{ path: string; type: string }>) : []
        }
        let list = await mem('summary').catch(() => [])
        if (list.length === 0) list = await mem('full').catch(() => [])
        obs.usage = new Map(list.map((f) => [f.path, f.type]))
        if (!l.read) {
          await handle.interrupt().catch(() => {})
          break
        }
      }
      // a resume's synthetic «No response requested.» after the interrupted turn is not a reply
      if (m.type === 'assistant' && !JSON.stringify(m.message ?? '').includes('No response requested.')) obs.replied = true
      if (m.type === 'result') break
    }
  } catch (err) {
    obs.error = err instanceof Error ? err.message : String(err)
  } finally {
    clearTimeout(timer)
    try {
      handle.close()
    } catch {
      /* closed */
    }
  }
  // the transcript: wait for the prompt's own record to land
  const sid = l.resume ?? obs.sid
  for (let i = 0; i < 20 && sid; i++) {
    const t = findTranscript(sid)
    if (t) {
      const raw = readFileSync(t, 'utf8')
      if (
        raw
          .split('\n')
          .slice(before)
          .some((ln) => ln.includes('"type":"user"'))
      ) {
        obs.transcript = t
        obs.raw = raw.split('\n').slice(before).join('\n')
        break
      }
    }
    await pause(500)
  }
  Object.assign(obs, replay(obs.raw))
  if (!obs.replied && obs.raw.split('\n').some((ln) => ln.includes('"type":"assistant"') && !ln.includes('No response requested.'))) obs.replied = true
  return obs
}

// ── cases ────────────────────────────────────────────────────────────────
type Verdict = 'PASS' | 'FAIL' | 'SKIPPED' | 'NOTED' | 'DISAGREE' | 'REFUSED'
interface Row {
  id: string
  kind: string
  tier: string
  expected: string
  observed: string
  verdict: Verdict
}
interface Check {
  kind: string
  path: (b: Bed) => string
  /** 'loaded' / 'absent' / 'nested' / 'removed'; null = no claim (NOTED) */
  expected: string | null
  /** start files are cross-checked with getContextUsage; nested ones by transcript only */
  how?: 'start' | 'nested' | 'any'
}
interface Case {
  id: string
  tier: string
  launch: (b: Bed, ctx: Ctx) => Launch | { skip: string }
  checks: Check[]
}
interface Ctx {
  baseSid: string | null
}

const P =
  (...rel: string[]) =>
  (b: Bed): string =>
    join(b.proj, ...rel)
const KINDS: Record<string, { path: (b: Bed) => string }> = {
  parent: { path: (b) => join(b.root, 'CLAUDE.md') },
  project: { path: P('CLAUDE.md') },
  dotclaude: { path: P('.claude', 'CLAUDE.md') },
  rule: { path: P('.claude', 'rules', 'always.md') },
  local: { path: P('CLAUDE.local.md') },
  import: { path: P('notes.md') },
}
const START_KINDS = Object.keys(KINDS)
const loadedAll = (but: string[] = [], expectOut = 'absent'): Check[] =>
  START_KINDS.map((k) => ({ kind: k, path: KINDS[k]!.path, expected: but.includes(k) ? expectOut : 'loaded', how: 'start' as const }))
const automem = (expected: string | null): Check => ({ kind: 'automem', path: (b) => join(b.automem, 'MEMORY.md'), expected, how: 'start' })
const excl = (...paths: string[]): Json => ({ claudeMdExcludes: paths })
const SKIP_USER = 'measured 24-11 by transcript read-back (spec §6)'

const CASES: Case[] = [
  {
    id: 'm-base',
    tier: '—',
    launch: (b) => ({ cwd: b.proj }),
    checks: [
      ...loadedAll(),
      automem('loaded'),
      { kind: 'agents-beside', path: P('AGENTS.md'), expected: 'absent', how: 'start' },
      { kind: 'subfolder', path: P('sub', 'CLAUDE.md'), expected: 'absent', how: 'start' },
      { kind: 'scoped-rule', path: P('.claude', 'rules', 'scoped.md'), expected: 'absent', how: 'start' },
    ],
  },
  {
    id: 'm-ondemand',
    tier: '— (turn)',
    launch: (b) => ({ cwd: b.proj, read: 'sub/x.txt' }),
    checks: [
      { kind: 'subfolder', path: P('sub', 'CLAUDE.md'), expected: 'nested', how: 'nested' },
      { kind: 'scoped-rule', path: P('.claude', 'rules', 'scoped.md'), expected: 'nested', how: 'nested' },
    ],
  },
  // every kind kept out at the local file and the flag tier; the import goes with its parent
  ...START_KINDS.flatMap((k): Case[] =>
    (['local', 'flag'] as const).map((tier) => ({
      id: `m-${k}-${tier}`,
      tier,
      launch: (b: Bed): Launch => ({ cwd: b.proj, [tier]: excl(KINDS[k]!.path(b)) }),
      checks: loadedAll(k === 'project' ? ['project', 'import'] : [k]),
    })),
  ),
  { id: 'm-project-repo', tier: 'project', launch: (b) => ({ cwd: b.proj, repo: excl(P('CLAUDE.md')(b)) }), checks: loadedAll(['project', 'import']) },
  { id: 'm-project-user', tier: 'user', launch: () => ({ skip: SKIP_USER }), checks: [{ kind: 'project', path: P('CLAUDE.md'), expected: 'absent' }] },
  {
    id: 'm-personal-*',
    tier: 'user·local·flag',
    launch: () => ({ skip: SKIP_USER }),
    checks: [{ kind: 'personal', path: () => '~/.claude/CLAUDE.md', expected: 'absent' }],
  },
  {
    id: 'm-personal-rule',
    tier: 'local·flag',
    launch: () => ({ skip: SKIP_USER }),
    checks: [{ kind: 'personal-rule', path: () => '~/.claude/rules/*.md', expected: 'absent' }],
  },
  {
    id: 'm-link',
    tier: 'flag',
    launch: () => ({ skip: SKIP_USER }),
    checks: [{ kind: 'personal-link', path: () => '~/.claude/CLAUDE.md', expected: 'absent' }],
  },
  {
    id: 'm-nested',
    tier: 'flag (turn)',
    launch: (b) => ({ cwd: b.proj, read: 'sub/x.txt', flag: excl(P('sub', 'CLAUDE.md')(b), P('.claude', 'rules', 'scoped.md')(b)) }),
    checks: [
      { kind: 'subfolder', path: P('sub', 'CLAUDE.md'), expected: 'absent', how: 'nested' },
      { kind: 'scoped-rule', path: P('.claude', 'rules', 'scoped.md'), expected: 'absent', how: 'nested' },
    ],
  },
  {
    id: 'm-join',
    tier: 'local+flag',
    launch: (b) => ({ cwd: b.proj, local: excl(P('CLAUDE.md')(b)), flag: excl(P('.claude', 'CLAUDE.md')(b)) }),
    checks: loadedAll(['project', 'import', 'dotclaude']),
  },
  { id: 'm-glob', tier: 'flag', launch: (b) => ({ cwd: b.proj, flag: excl('**/rules/**') }), checks: loadedAll(['rule']) },
  {
    id: 'm-not',
    tier: 'flag',
    launch: (b) => ({ cwd: b.proj, flag: excl('**/CLAUDE.md', `!${P('CLAUDE.md')(b)}`) }),
    checks: START_KINDS.map((k) => ({ kind: k, path: KINDS[k]!.path, expected: null, how: 'start' as const })),
  },
  // AGENTS.md alone: hooks off, hooks on (the built-in plugin), and kept out
  {
    id: 'm-agents-alone',
    tier: '— hooks off',
    launch: (b) => ({ cwd: b.alone }),
    checks: [{ kind: 'agents-alone', path: (b) => join(b.alone, 'AGENTS.md'), expected: null, how: 'any' }],
  },
  {
    id: 'm-agents-alone-hooks',
    tier: '— hooks on',
    launch: (b) => ({ cwd: b.alone, hooks: true }),
    checks: [{ kind: 'agents-alone', path: (b) => join(b.alone, 'AGENTS.md'), expected: null, how: 'any' }],
  },
  {
    id: 'm-agents-alone-x',
    tier: 'flag, hooks on',
    launch: (b) => ({ cwd: b.alone, hooks: true, flag: excl(join(b.alone, 'AGENTS.md')) }),
    checks: [{ kind: 'agents-alone', path: (b) => join(b.alone, 'AGENTS.md'), expected: null, how: 'any' }],
  },
  // worktrees under <folder>/.claude/worktrees/x
  {
    id: 'm-worktree',
    tier: '— (started in it)',
    launch: (b) => ({ cwd: b.wt }),
    checks: [
      { kind: 'wt-project', path: (b) => join(b.wt, 'CLAUDE.md'), expected: 'loaded', how: 'start' },
      { kind: 'wt-dotclaude', path: (b) => join(b.wt, '.claude', 'CLAUDE.md'), expected: 'loaded', how: 'start' },
      { kind: 'main-local', path: P('CLAUDE.local.md'), expected: 'loaded', how: 'start' },
      { kind: 'main-project', path: P('CLAUDE.md'), expected: null, how: 'start' },
    ],
  },
  {
    id: 'm-worktree-x',
    tier: 'flag (started in it)',
    launch: (b) => ({ cwd: b.wt, flag: excl(`${b.proj}/.claude/worktrees/*/CLAUDE.md`) }),
    checks: [
      { kind: 'wt-project', path: (b) => join(b.wt, 'CLAUDE.md'), expected: 'absent', how: 'start' },
      { kind: 'wt-dotclaude', path: (b) => join(b.wt, '.claude', 'CLAUDE.md'), expected: 'loaded', how: 'start' },
    ],
  },
  {
    id: 'm-worktree-read',
    tier: 'flag (turn, from main)',
    launch: (b) => ({ cwd: b.proj, read: '.claude/worktrees/x/wt.txt', flag: excl(`${b.proj}/.claude/worktrees/*/CLAUDE.md`) }),
    checks: [{ kind: 'wt-project', path: (b) => join(b.wt, 'CLAUDE.md'), expected: 'absent', how: 'nested' }],
  },
  // an additional directory
  {
    id: 'm-adddir',
    tier: '—',
    launch: (b) => ({ cwd: b.proj, addDirs: [b.extra] }),
    checks: [{ kind: 'adddir', path: (b) => join(b.extra, 'CLAUDE.md'), expected: 'absent', how: 'start' }],
  },
  {
    id: 'm-adddir-env',
    tier: 'env var',
    launch: (b) => ({ cwd: b.proj, addDirs: [b.extra], env: { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' } }),
    checks: [{ kind: 'adddir', path: (b) => join(b.extra, 'CLAUDE.md'), expected: 'loaded', how: 'start' }],
  },
  {
    id: 'm-adddir-read',
    tier: '— (turn)',
    launch: (b) => ({ cwd: b.proj, addDirs: [b.extra], read: join(b.extra, 'x.txt') }),
    checks: [{ kind: 'adddir', path: (b) => join(b.extra, 'CLAUDE.md'), expected: 'absent', how: 'any' }],
  },
  // which sources load which types (§2 «Which start reads what»)
  {
    id: 'g-user-project',
    tier: "sources ['user','project']",
    launch: (b) => ({ cwd: b.proj, sources: ['user', 'project'] }),
    checks: [...loadedAll(['local']), automem('loaded')],
  },
  { id: 'g-user', tier: "sources ['user']", launch: (b) => ({ cwd: b.proj, sources: ['user'] }), checks: [...loadedAll(START_KINDS), automem('loaded')] },
  // autoMemoryEnabled per tier
  { id: 'a-user', tier: 'user', launch: () => ({ skip: SKIP_USER }), checks: [automem('absent')] },
  { id: 'a-local', tier: 'local', launch: (b) => ({ cwd: b.proj, local: { autoMemoryEnabled: false } }), checks: [automem('absent')] },
  { id: 'a-project', tier: 'project', launch: (b) => ({ cwd: b.proj, repo: { autoMemoryEnabled: false } }), checks: [automem(null)] },
  { id: 'a-flag', tier: 'flag', launch: (b) => ({ cwd: b.proj, flag: { autoMemoryEnabled: false } }), checks: [automem('absent')] },
  {
    id: 'a-flag-over-local',
    tier: 'flag true · local false',
    launch: (b) => ({ cwd: b.proj, local: { autoMemoryEnabled: false }, flag: { autoMemoryEnabled: true } }),
    checks: [automem('loaded')],
  },
  // Silos' own carry (local-holds.ts filesCarry) into a launch that skips the local file
  {
    id: 't-automem-raw',
    tier: "local false · ['user','project']",
    launch: (b) => ({ cwd: b.proj, sources: ['user', 'project'], local: { autoMemoryEnabled: false } }),
    checks: [automem('loaded')],
  },
  {
    id: 't-automem-carry',
    tier: "local false · ['user','project'] + filesCarry",
    launch: (b) => ({ cwd: b.proj, sources: ['user', 'project'], local: { autoMemoryEnabled: false }, carry: 'run' }),
    checks: [automem('loaded')],
  },
  {
    id: 't-automem-user',
    tier: "local false · ['user'] + filesCarry",
    launch: (b) => ({ cwd: b.proj, sources: ['user'], local: { autoMemoryEnabled: false }, carry: 'run' }),
    checks: [automem('loaded')],
  },
  {
    id: 't-automem-heartbeat',
    tier: 'local false · heartbeat carry',
    launch: (b) => ({ cwd: b.proj, sources: ['user', 'project'], local: { autoMemoryEnabled: false }, carry: 'heartbeat' }),
    checks: [automem('loaded')],
  },
  { id: 't-automem-on', tier: 'local true over user false', launch: () => ({ skip: SKIP_USER }), checks: [automem('loaded')] },
  {
    id: 't-excludes-carry',
    tier: "local · ['user','project'] + filesCarry",
    launch: (b) => ({ cwd: b.proj, sources: ['user', 'project'], local: excl(P('CLAUDE.md')(b)), carry: 'run' }),
    checks: loadedAll(['project', 'import', 'local']),
  },
  // a later start of m-base's conversation with a file kept out
  {
    id: 'm-resume',
    tier: 'flag (resume)',
    launch: (b, ctx) => (ctx.baseSid ? { cwd: b.proj, resume: ctx.baseSid, flag: excl(P('CLAUDE.local.md')(b)) } : { skip: 'm-base left no conversation' }),
    checks: [{ kind: 'local', path: P('CLAUDE.local.md'), expected: 'removed', how: 'start' }],
  },
]

// ── judging ──────────────────────────────────────────────────────────────
function judge(c: Case, ck: Check, b: Bed, o: Obs): Row {
  const path = ck.path(b)
  const f = o.files.get(path)
  let tState: string
  if (ck.expected === 'removed')
    tState = o.removed.includes(path) ? 'removed' : f ? `still loaded (${o.deltas} delta)` : `absent, not in removed (${o.deltas} delta)`
  else if (ck.how === 'nested') tState = f && f.how === 'nested' ? 'nested' : f ? `at start (${f.type})` : 'absent'
  else tState = f ? (ck.how === 'any' ? `${f.how} (${f.type})` : f.how === 'start' ? 'loaded' : 'nested') : 'absent'
  if (!f && ck.how === 'any' && o.raw.includes(`${MARK}: ${path === join(b.alone, 'AGENTS.md') ? 'agents alone' : 'additional directory'}`))
    tState = 'text in transcript, no record'
  const type = f ? ` · ${f.type}${f.parent ? ` ← ${f.parent.split(sep).slice(-1)[0]}` : ''}` : ''
  let observed = `${tState}${tState === 'loaded' ? type : ''}`
  let disagree = false
  if (o.usage && ck.how === 'start' && ck.expected !== 'removed') {
    const u = o.usage.has(path)
    const t = tState === 'loaded'
    if (u !== t) {
      disagree = true
      observed += ` | usage: ${u ? `listed (${o.usage.get(path)})` : 'not listed'}`
    }
  }
  if (o.error) observed += ` [${o.error}]`
  const base = tState.split(' ')[0]!
  const verdict: Verdict = disagree ? 'DISAGREE' : ck.expected === null ? 'NOTED' : base === ck.expected ? 'PASS' : 'FAIL'
  return { id: c.id, kind: ck.kind, tier: c.tier, expected: ck.expected ?? '(no claim)', observed, verdict }
}

function table(rows: Row[]): string {
  const head: Row = { id: 'case', kind: 'kind', tier: 'tier', expected: 'expected', observed: 'observed', verdict: 'verdict' as Verdict }
  const all = [head, ...rows]
  const w = (k: keyof Row): number => Math.max(...all.map((r) => String(r[k]).length))
  const line = (r: Row): string => (['id', 'kind', 'tier', 'expected', 'observed', 'verdict'] as const).map((k) => String(r[k]).padEnd(w(k))).join(' · ')
  return all.map(line).join('\n')
}

export async function runMemory(argv: string[]): Promise<number> {
  const picked = (id: string): boolean => argv.length === 0 || argv.some((p) => id.startsWith(p))
  const version = cli(['--version']).split('\n')[0] ?? '?'
  console.log(`claude: ${version} · login: the default config dir, in place`)
  if (!signedIn()) {
    console.log('SKIPPED — the default login is not signed in; nothing measured')
    return 3
  }
  const bed = makeBed()
  const rows: Row[] = []
  const versions = new Set<string>()
  const transcriptDirs = new Set<string>()
  const ctx: Ctx = { baseSid: null }
  try {
    console.log(`bed: ${bed.root} (+ ${bed.alone}, ${bed.extra}, ${bed.automem})`)
    for (const c of CASES) {
      if (!picked(c.id) && !(c.id === 'm-base' && argv.some((p) => 'm-resume'.startsWith(p)))) continue
      const l = c.launch(bed, ctx)
      if ('skip' in l) {
        for (const ck of c.checks)
          rows.push({ id: c.id, kind: ck.kind, tier: c.tier, expected: ck.expected ?? '(no claim)', observed: '—', verdict: 'SKIPPED' })
        console.log(`  ${c.id}: SKIPPED — ${l.skip}`)
        continue
      }
      const refused = refusal(bed, l)
      if (refused) {
        for (const ck of c.checks)
          rows.push({ id: c.id, kind: ck.kind, tier: c.tier, expected: ck.expected ?? '(no claim)', observed: '—', verdict: 'REFUSED' })
        console.log(`  ${c.id}: REFUSED — ${refused}`)
        continue
      }
      const o = await launch(bed, l)
      if (o.version) versions.add(o.version)
      if (o.transcript) transcriptDirs.add(dirname(o.transcript))
      if (c.id === 'm-base') ctx.baseSid = o.sid
      const seen = [...o.files.entries()].map(
        ([p, f]) =>
          `${p.replace(bed.root, '<root>').replace(bed.alone, '<alone>').replace(bed.extra, '<extra>').replace(bed.automem, '<automem>').replace(homedir(), '~')} ${f.type}${f.how === 'nested' ? ' (nested)' : ''}`,
      )
      console.log(
        `  ${c.id}: ${o.transcript ? 'transcript' : 'NO transcript'} · ${o.files.size} in force · usage ${o.usage ? o.usage.size : 'n/a'} · replied ${o.replied}${o.removed.length ? ` · removed ${o.removed.length}` : ''}\n      ${seen.join('\n      ')}`,
      )
      for (const ck of c.checks) rows.push(judge(c, ck, bed, o))
    }
  } finally {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', bed.wt], { cwd: bed.proj, stdio: 'ignore' })
    } catch {
      /* removed with the folder */
    }
    for (const t of bed.temps) rmSync(t, { recursive: true, force: true })
  }
  const shown = rows.map((r) => ({ ...r, observed: r.observed }))
  console.log(`\nCLI ${[...versions].join(', ') || version} · ${LAUNCHES} launches · ${TURNS} short turns (the rest stopped at init)\n`)
  console.log(table(shown))
  console.log("\nTranscripts Claude Code wrote (fixture text + the login's own personal instructions), left in place:")
  for (const d of transcriptDirs) console.log(`  ${d}`)
  const bad = rows.some((r) => r.verdict === 'FAIL' || r.verdict === 'DISAGREE' || r.verdict === 'REFUSED')
  console.log(`\nRESULT: ${bad ? 'FAIL/DISAGREE present' : 'no FAIL'}`)
  return bad ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runMemory(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err)
      process.exit(2)
    },
  )
}
