// heartbeat-audit.ts — what an unattended turn did that Silos must know
// about.
//
// Two halves:
//   · a PURE core — auditToolCalls(calls, ctx) over engine-neutral tool calls
//     (contract.ts ToolCallRecord: each engine's adapter says what a call IS —
//     a web tool, an MCP tool, a shell command, the files it writes), plus the
//     verdict helpers (isTainted, heartbeatVerdict, ownerCredentialCut);
//   · a thin LOADER — collectTurnCalls(ref, deps) gathers the calls of a
//     finished run: its session and that session's children (each reader's
//     HarnessReader.toolCalls — Claude subagent transcripts, OpenCode child
//     sessions by parent_id), and every NESTED session a shell call of the
//     turn launched (`claude -p`, `opencode run`), linked by its birth marker
//     (births/<id>.json `parent` = the turn's session) and read with its own
//     engine's reader through the same index.
// No engine is named here (harness-boundary.test.ts): tool names and input
// shapes stay inside each adapter's tool-calls.ts.
//
// What it writes into `audit`:
//   readOutside — each distinct label, in first-seen order:
//     · a web tool: its own name (WebFetch, WebSearch, webfetch, websearch…);
//     · an MCP tool: its name, always as `mcp__…` (an engine whose MCP tools
//       carry no such prefix gets it prepended, so the engine-gap exception can
//       tell them apart on both engines);
//     · `subagent` once, when the turn had child sessions and
//       ctx.markChildSessions is set (an OpenCode heartbeat while its `task`
//       deny is not smoke-verified — G4; the integrator decides the flag);
//     · `transcript unreadable` once, when a session of the turn (its own,
//       a nested one) could not be read — fail closed: an unreadable
//       transcript is indistinguishable from a tampered one;
//     · a shell command that meets NETWORK_RE outside the one exemption:
//       `<tool name>: <first NETWORK_RE match, lower-cased>` — e.g.
//       `Bash: curl`, `bash: python3`, `Bash: https://`, `Bash: /dev/tcp/`.
//   ownerCredential — `<what>: <command, ≤ 300 chars>` per use, where <what>
//     is `x-token header`, `?token= in URL` or `owner token file`.
//   memoryEdited / configEdited — absolute paths (as resolvable: `~`, $HOME
//     and paths relative to ctx.cwd are expanded), written by a file tool
//     OR named in a shell command (best effort, m12).
// Fields other than readOutside are omitted when empty.
//
// Shell commands are judged SEGMENT by segment (split on unquoted ; && || |
// & and newlines, never inside quotes, $( ) or backticks): every segment
// that meets NETWORK_RE needs a recognisable host (m13), and the exemption
// holds for a segment only when ALL its hosts are the Silos server, it
// carries the agent channel and the command uses no owner credential. A
// whole-command reading would let `curl …$SILOS_API… -H "Authorization:
// Bearer $SILOS_AGENT_TOKEN"; python3 exfil.py` pass on the curl's host.

import { posix } from 'node:path'
import type { SessionToolCalls, ToolCallRecord } from './harnesses/contract.js'
import { mungePath } from './agent-registry.js'
import { CLAUDE_ACCOUNTS_DIR, OWN_PLUGIN_DIR } from './territory.js'

/** The declared network heuristic. Never a firewall. */
export const NETWORK_RE =
  /\b(curl|wget|gog|himalaya|mutt|nc|ssh|scp|telnet|rsync|openssl|python3?|node|deno|bun|git|gh|npm|npx|pnpm|yarn|pip3?|pipx|uv|perl|ruby|php|claude|opencode)\b|https?:\/\/|\/dev\/(tcp|udp)\//i

/** `audit` of a finished unattended run. */
export interface RunAudit {
  readOutside: string[]
  memoryEdited?: string[]
  configEdited?: string[]
  ownerCredential?: string[]
}

/** Globs (absolute; `*` within a segment, `**` across) the audit watches. */
export interface AuditPaths {
  /** Project memory: the engine's per-folder auto memory dirs. CLAUDE.md
   *  and AGENTS.md count by file name anywhere, with no glob. */
  memory: string[]
  /** Engine conduct files: agent plugins, configFiles, settings*. */
  conduct: string[]
}

export interface AuditContext {
  /** The turn's folder: what relative paths resolve against. */
  cwd: string
  home: string
  /** The Silos server: its port (127.0.0.1:<port>, localhost:<port>) and
   *  its API URL as handed to agents (SILOS_API), when it differs. */
  silos: { port: number; api?: string }
  paths: AuditPaths
  /** The owner credential on disk as an absolute path (<dataDir>/token);
   *  `~/.silos/token`, `$HOME/.silos/token` and `$SILOS_DATA_DIR/token` are
   *  always recognised. */
  ownerTokenPaths?: string[]
  /** Child sessions of the turn (TurnCalls.children). */
  children?: readonly string[]
  /** A child session reads outside (`subagent`): set for an OpenCode
   *  heartbeat while the `task` deny is not smoke-verified. */
  markChildSessions?: boolean
  /** Sessions of the turn whose calls could not be read (TurnCalls.unread):
   *  any ⇒ `transcript unreadable` (fail closed). */
  unread?: readonly string[]
}

/** The readOutside label of a turn whose transcript could not be read. */
export const TRANSCRIPT_UNREADABLE = 'transcript unreadable'

// ── paths ───────────────────────────────────────────────────────────────

const strip = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p)

/** The memory and conduct globs for a turn.
 *  `folders`: the folders whose conduct files count (the turn's folder and
 *  its agent's territories); `engineConfigFiles`: every registered engine's
 *  Harness.configFiles for a folder (territory.ts builds the same union). */
export function auditPaths(o: { folders: readonly string[]; home: string; dataDir: string; engineConfigFiles: (folder: string) => string[] }): AuditPaths {
  const home = strip(o.home)
  const data = strip(o.dataDir)
  // the engine's home layer and every extra account (a whole config dir each)
  const configDirs = [`${home}/.claude`, `${data}/${CLAUDE_ACCOUNTS_DIR}/*`]
  const conduct = [`${data}/agent-state/*/${OWN_PLUGIN_DIR}/**`]
  for (const d of configDirs) {
    conduct.push(`${d}/settings*.json`)
    for (const sub of ['commands', 'agents', 'plugins', 'output-styles']) conduct.push(`${d}/${sub}/**`)
  }
  for (const raw of o.folders) {
    const f = strip(raw)
    conduct.push(`${f}/.claude/settings*.json`)
    for (const p of o.engineConfigFiles(f)) if (p.startsWith('/')) conduct.push(strip(p))
  }
  const memory = configDirs.map((d) => `${d}/projects/*/memory/**`)
  return { memory: [...new Set(memory)], conduct: [...new Set(conduct)] }
}

const globCache = new Map<string, RegExp>()
function globRe(glob: string): RegExp {
  let re = globCache.get(glob)
  if (re) return re
  let body = ''
  let tail = ''
  let g = glob
  // `dir/**` also names the dir itself (`rm -rf dir`)
  if (g.endsWith('/**')) {
    g = g.slice(0, -3)
    tail = '(?:/.*)?'
  }
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!
    if (c === '*' && g[i + 1] === '*') {
      body += '.*'
      i++
    } else if (c === '*') body += '[^/]*'
    else if (c === '?') body += '[^/]'
    else body += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  re = new RegExp(`^${body}${tail}$`)
  globCache.set(glob, re)
  return re
}

function expand(p: string, ctx: Pick<AuditContext, 'cwd' | 'home'>): string {
  let s = p
  if (s === '~' || s.startsWith('~/')) s = strip(ctx.home) + s.slice(1)
  s = s.replace(/^\$\{HOME\}|^\$HOME\b/, strip(ctx.home))
  return posix.resolve(ctx.cwd, s)
}

const MEMORY_NAMES = new Set(['CLAUDE.md', 'AGENTS.md'])
const isMemory = (abs: string, paths: AuditPaths): boolean => MEMORY_NAMES.has(posix.basename(abs)) || paths.memory.some((g) => globRe(g).test(abs))
const isConduct = (abs: string, paths: AuditPaths): boolean => paths.conduct.some((g) => globRe(g).test(abs))

/** The paths a shell command WRITES (best effort, declared):
 *  redirection targets (`>`, `>>`, `&>`), `tee`'s files, the destination of
 *  `cp`/`mv`/`install`/`ln`/`rsync`, `sed -i`'s files and `dd of=`. A read
 *  (`cat`, `grep`, `head`…) writes nothing: it never counts as an edit. */
export function shellWriteTargets(command: string): string[] {
  const out: string[] = []
  const clean = (w: string): string => w.replace(/^['"]+|['"]+$/g, '').replace(/\$\{HOME\}/g, '$HOME')
  for (const seg of shellSegments(command)) {
    const t = seg.text
    for (const m of t.matchAll(/(?:^|[^<0-9>&])(?:\d|&)?>>?\|?\s*(['"]?)([^\s'";|&<>]+)\1/g)) {
      const w = clean(m[2]!)
      if (!/^&\d$/.test(w) && w !== '/dev/null') out.push(w)
    }
    const ws = t
      .split(/\s+/)
      .map(clean)
      .filter((w) => w !== '')
    const verb = posix.basename(ws[0] ?? '')
    const operands = ws.slice(1).filter((w) => !w.startsWith('-') && !/[<>]/.test(w))
    if (verb === 'tee') out.push(...operands)
    else if (['cp', 'mv', 'install', 'ln', 'rsync'].includes(verb) && operands.length >= 2) out.push(operands[operands.length - 1]!)
    else if (verb === 'sed' && ws.some((w) => /^-i/.test(w) || w === '--in-place')) out.push(...operands.slice(1))
    else if (verb === 'dd') for (const w of ws) if (w.startsWith('of=')) out.push(w.slice(3))
  }
  return out
}

/** Path-like words of a command (best effort: quotes, redirections and
 *  separators split; `$HOME`/`${HOME}` expanded by expand()). */
function pathWords(command: string): string[] {
  return command
    .replace(/\$\{HOME\}/g, '$HOME')
    .split(/[\s'"`;|&<>(){},=]+/)
    .map((w) => w.replace(/[:,.]+$/, ''))
    .filter((w) => w !== '' && !w.startsWith('-') && /[./]/.test(w))
}

// ── shell ───────────────────────────────────────────────────────────────

interface Segment {
  text: string
  pipesInto: boolean
}

/** A command split on unquoted ; && || | & and newlines (never inside
 *  quotes, `$( )` or backticks). `pipesInto`: its output feeds the next. */
export function shellSegments(command: string): Segment[] {
  const out: Segment[] = []
  let cur = ''
  let single = false,
    double = false,
    tick = false,
    depth = 0
  const push = (pipesInto: boolean): void => {
    if (cur.trim() !== '') out.push({ text: cur.trim(), pipesInto })
    else if (out.length > 0 && pipesInto) out[out.length - 1]!.pipesInto = true
    cur = ''
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (c === '\\' && !single) {
      cur += c + (command[i + 1] ?? '')
      i++
      continue
    }
    if (single) {
      if (c === "'") single = false
      cur += c
      continue
    }
    if (c === "'" && !double) {
      single = true
      cur += c
      continue
    }
    if (c === '"') {
      double = !double
      cur += c
      continue
    }
    if (c === '`') {
      tick = !tick
      cur += c
      continue
    }
    if (c === '$' && command[i + 1] === '(') {
      depth++
      cur += '$('
      i++
      continue
    }
    if (c === '(' && depth > 0) {
      depth++
      cur += c
      continue
    }
    if (c === ')' && depth > 0) {
      depth--
      cur += c
      continue
    }
    if (double || tick || depth > 0) {
      cur += c
      continue
    }
    if (c === '\n' || c === ';') {
      push(false)
      continue
    }
    if (c === '&' && command[i + 1] === '&') {
      push(false)
      i++
      continue
    }
    if (c === '|' && command[i + 1] === '|') {
      push(false)
      i++
      continue
    }
    if (c === '|') {
      push(true)
      continue
    }
    if (c === '&' && command[i - 1] !== '>' && command[i + 1] !== '>') {
      push(false)
      continue
    }
    cur += c
  }
  push(false)
  return out
}

const SILOS_VAR_RE = /\$\{SILOS_API(?:[:\-=?+][^}]*)?\}|\$SILOS_API\b/g
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/([^/\s'"?#\\`)]*)/gi
const HOSTPORT_RE = /(?<![\w./@-])((?:localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\]|[a-z0-9-]+(?:\.[a-z0-9-]+)+):\d{1,5})(?![\w.])/gi
const DEVNET_RE = /\/dev\/(?:tcp|udp)\/([^/\s'"]+)\/(\d+)/gi
const SCP_LIKE_RE = /(?<![\w.-])[\w.-]+@([\w.-]+):/g
const REMOTE_WORDS = new Set(['ssh', 'scp', 'sftp', 'rsync', 'nc', 'telnet'])

function words(text: string): string[] {
  return text
    .split(/\s+/)
    .map((w) => w.replace(/^['"]+|['"]+$/g, ''))
    .filter((w) => w !== '')
}

/** The hosts a segment names: 'silos' for $SILOS_API, else `host[:port]` lower-cased. */
export function segmentHosts(text: string): string[] {
  const hosts: string[] = []
  let rest = text.replace(SILOS_VAR_RE, () => {
    hosts.push('silos')
    return ' '
  })
  rest = rest.replace(URL_RE, (_m, auth: string) => {
    const h = auth.slice(auth.lastIndexOf('@') + 1)
    if (h !== '') hosts.push(h.toLowerCase())
    return ' '
  })
  rest = rest.replace(DEVNET_RE, (_m, h: string, port: string) => {
    hosts.push(`${h.toLowerCase()}:${port}`)
    return ' '
  })
  rest = rest.replace(SCP_LIKE_RE, (_m, h: string) => {
    hosts.push(h.toLowerCase())
    return ' '
  })
  for (const m of rest.matchAll(HOSTPORT_RE)) hosts.push(m[1]!.toLowerCase())
  // the remote shells' target: the first operand after the word
  const ws = words(rest)
  for (let i = 0; i < ws.length; i++) {
    if (!REMOTE_WORDS.has(posix.basename(ws[i]!))) continue
    for (let j = i + 1; j < ws.length; j++) {
      const w = ws[j]!
      if (w.startsWith('-') || /^\d+$/.test(w)) continue
      const h = w.slice(w.lastIndexOf('@') + 1).split(':')[0]!
      if (h !== '' && !h.includes('/')) hosts.push(h.toLowerCase())
      break
    }
  }
  return hosts
}

function silosHosts(ctx: AuditContext): Set<string> {
  const s = new Set([`127.0.0.1:${ctx.silos.port}`, `localhost:${ctx.silos.port}`])
  if (ctx.silos.api) {
    try {
      const u = new URL(ctx.silos.api)
      s.add(u.port ? `${u.hostname}:${u.port}`.toLowerCase() : u.hostname.toLowerCase())
    } catch {
      /* not a URL: only the loopback forms */
    }
  }
  return s
}

const AGENT_CHANNEL_RE = /authorization\s*:\s*bearer\b|\$\{?SILOS_AGENT_TOKEN\b/i
const X_TOKEN_HEADER_RE = /(?:^|\s)(?:-H|--header)(?:\s+|=)?\s*['"]?\s*x-token\s*:|['"]x-token['"]\s*[:,]/i
const URL_TOKEN_RE = /(?:[a-z][a-z0-9+.-]*:\/\/|\$\{?SILOS_API\b|(?:localhost|\d{1,3}(?:\.\d{1,3}){3}):\d+)[^\s'"]*[?&]token=/i

function tokenFileRe(ctx: AuditContext): RegExp {
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const alts = [
    String.raw`(?:~|\$HOME|\$\{HOME\})/\.silos/token`,
    String.raw`\$\{?SILOS_DATA_DIR\}?/token`,
    `${esc(strip(ctx.home))}/\\.silos/token`,
    ...(ctx.ownerTokenPaths ?? []).map(esc),
  ]
  return new RegExp(`(?:${alts.join('|')})(?![\\w.-])`)
}

interface ShellFinding {
  label: string | null
  owner: string[]
}

// The engines' own names (`claude`, `opencode`) are also files and folders
// every project holds (CLAUDE.md, .claude/, opencode.json): they count as a
// network command only in COMMAND position — a segment's start (after env
// assignments and wrappers, optionally through a path), or right after `$(`
// or a backtick — the way the owner's credential counts only in credential
// position. `cat CLAUDE.md` is a read; `claude -p "…"` is a nested session.
// (the engines' CLI words as NETWORK_RE spells them — a regex, like it)
const ENGINE_WORD_RE = /^(?:claude|opencode)$/i
const COMMAND_POSITION_RE = /(?:^|\$\(|`)\s*(?:[A-Za-z_]\w*=\S*\s+)*(?:(?:sudo|exec|env|nohup|command|time|timeout\s+\S+)\s+)*(?:[^\s'"`$()]*\/)?$/
export function networkHit(text: string): RegExpExecArray | null {
  const re = new RegExp(NETWORK_RE.source, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const w = (m[1] ?? '').toLowerCase()
    if (ENGINE_WORD_RE.test(w) && !COMMAND_POSITION_RE.test(text.slice(0, m.index))) continue
    return m
  }
  return null
}

/** One shell command: its readOutside label (null = none) and owner-credential uses. */
export function auditShell(tool: string, command: string, ctx: AuditContext): ShellFinding {
  const segs = shellSegments(command)
  const silos = silosHosts(ctx)
  const tokenFile = tokenFileRe(ctx)
  // variables assigned from a read of the owner's token file
  const tainted = new Set<string>()
  for (const s of segs) {
    const m = /^(?:export\s+)?([A-Za-z_]\w*)=/.exec(s.text)
    if (m && tokenFile.test(s.text)) tainted.add(m[1]!)
  }
  const usesVar = (text: string): boolean => [...tainted].some((v) => new RegExp(`\\$\\{?${v}\\b`).test(text))
  let label: string | null = null
  const owner: string[] = []
  const short = command.length > 300 ? `${command.slice(0, 299)}…` : command
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!
    const hit = networkHit(s.text)
    if (!hit) continue
    const hosts = segmentHosts(s.text)
    // owner credential: only in credential POSITION inside a network command with a host
    const uses: string[] = []
    if (hosts.length > 0) {
      if (X_TOKEN_HEADER_RE.test(s.text)) uses.push('x-token header')
      if (URL_TOKEN_RE.test(s.text)) uses.push('?token= in URL')
      const fed = i > 0 && segs[i - 1]!.pipesInto && tokenFile.test(segs[i - 1]!.text)
      if (tokenFile.test(s.text) || fed || usesVar(s.text)) uses.push('owner token file')
    }
    for (const u of uses) owner.push(`${u}: ${short}`)
    const exempt = hosts.length > 0 && hosts.every((h) => h === 'silos' || silos.has(h)) && AGENT_CHANNEL_RE.test(s.text) && uses.length === 0
    if (!exempt && label === null) label = `${tool}: ${hit[0].toLowerCase()}`
  }
  // a credential used anywhere taints the command's exemption as a whole
  if (owner.length > 0 && label === null) {
    const hit = networkHit(command)
    label = `${tool}: ${(hit?.[0] ?? 'network').toLowerCase()}`
  }
  return { label, owner }
}

// ── the audit ──────────────────────────────────────────────────────────

/** The `audit` of a turn's tool calls (pure). */
export function auditToolCalls(calls: readonly ToolCallRecord[], ctx: AuditContext): RunAudit {
  const readOutside = new Set<string>()
  const memory = new Set<string>()
  const config = new Set<string>()
  const owner = new Set<string>()
  const touch = (raw: string): void => {
    const abs = expand(raw, ctx)
    if (isMemory(abs, ctx.paths)) memory.add(abs)
    if (isConduct(abs, ctx.paths)) config.add(abs)
  }
  for (const c of calls) {
    if (c.outside === 'web') readOutside.add(c.name)
    else if (c.outside === 'mcp') readOutside.add(c.name.startsWith('mcp__') ? c.name : `mcp__${c.name}`)
    for (const w of c.writes ?? []) touch(w)
    if (typeof c.command === 'string' && c.command !== '') {
      const f = auditShell(c.name, c.command, ctx)
      if (f.label) readOutside.add(f.label)
      for (const o of f.owner) owner.add(o)
      // memory: only what the command WRITES (a read is no edit); engine
      // conduct files: any mention (best effort)
      for (const w of shellWriteTargets(c.command)) {
        const abs = expand(w, ctx)
        if (isMemory(abs, ctx.paths)) memory.add(abs)
      }
      for (const w of pathWords(c.command)) {
        const abs = expand(w, ctx)
        if (isConduct(abs, ctx.paths)) config.add(abs)
      }
    }
  }
  // a child session with no tool call still is one
  if (ctx.markChildSessions && (ctx.children?.length ?? 0) > 0) readOutside.add('subagent')
  // what could not be read cannot be cleared (fail closed)
  if ((ctx.unread?.length ?? 0) > 0) readOutside.add(TRANSCRIPT_UNREADABLE)
  const audit: RunAudit = { readOutside: [...readOutside] }
  if (memory.size > 0) audit.memoryEdited = [...memory]
  if (config.size > 0) audit.configEdited = [...config]
  if (owner.size > 0) audit.ownerCredential = [...owner]
  return audit
}

// ── verdicts ─────────────────────────────────────────────

/** A heartbeat run is tainted when it read outside (a verdict, not a
 *  field). The caller says it is a heartbeat run; any other run's
 *  readOutside is provenance only. */
export function isTainted(audit: RunAudit | null | undefined): boolean {
  return (audit?.readOutside.length ?? 0) > 0
}

/** What the run's engine could not prevent in a heartbeat: its
 *  MCP tools and/or its child sessions (`task` deny not yet
 *  smoke-verified). Engine facts: the integrator supplies them. */
export interface EngineGaps {
  mcp: boolean
  childSessions: boolean
}

/** The verdict for a HEARTBEAT run: tainted ⇒ undo its creations and dismiss its
 *  proposals; cut only when it created or proposed something — and never
 *  when every readOutside entry is an engine gap (MCP tools / `subagent`). */
export function heartbeatVerdict(
  audit: RunAudit | null | undefined,
  o: { createdOrProposed: boolean; gaps: EngineGaps },
): { tainted: boolean; undo: boolean; cut: boolean; why: string | null } {
  const tainted = isTainted(audit)
  if (!tainted) return { tainted, undo: false, cut: false, why: null }
  const gap = (e: string): boolean => (o.gaps.mcp && e.startsWith('mcp__')) || (o.gaps.childSessions && e === 'subagent')
  const onlyGaps = audit!.readOutside.every(gap)
  const cut = o.createdOrProposed && !onlyGaps
  return { tainted, undo: true, cut, why: cut ? `created work after reading outside (${audit!.readOutside.join(', ')})` : null }
}

/** An owner-credential use in ANY unattended turn cuts — the `why`, or null. */
export function ownerCredentialCut(audit: RunAudit | null | undefined): string | null {
  const first = audit?.ownerCredential?.[0]
  if (!first) return null
  return `used the owner's credential in an unattended turn (${first.slice(0, first.indexOf(':'))})`
}

// ── the loader ─────────────────────────────────────────────────────────

/** What the loader reads through (SessionIndex fits: auditSessionsOf). */
export interface AuditSessions {
  toolCalls(folder: string, id: string): Promise<SessionToolCalls | null>
  /** The folder a session is indexed under, or null. */
  folderOf(id: string): string | null
}

/** A birth marker as births-store.ts reads it (the fields used here). */
export interface AuditBirth {
  sessionId: string
  agentId: string
  parent: string | null
  cwd: string | null
  ctimeMs: number
}

export interface TurnRef {
  /** The session's folder as its reader keys it (SessionMeta.folder). */
  folder: string
  sessionId: string
  /** Only nested sessions born under this agent count (its own births dir). */
  agentId?: string
  /** Ignore calls (and nested births) before this instant (ms) — for a run
   *  that resumed an older conversation. Absent = the whole session. */
  since?: number
}

export interface TurnCalls {
  calls: ToolCallRecord[]
  /** Child sessions (subagents) of the turn's session and of its nested ones. */
  children: string[]
  /** Nested sessions found by birth marker, read or not. */
  nested: string[]
  /** Sessions whose calls could not be read (no reader answer). */
  unread: string[]
}

const NESTED_MAX = 64

/** Gather a finished run's tool calls: session, children, nested sessions. */
export async function collectTurnCalls(ref: TurnRef, deps: { sessions: AuditSessions; births: { all(): AuditBirth[] } }): Promise<TurnCalls> {
  const out: TurnCalls = { calls: [], children: [], nested: [], unread: [] }
  const keep = (c: ToolCallRecord): boolean => ref.since === undefined || c.at === undefined || c.at >= ref.since
  const read = async (folder: string, id: string): Promise<void> => {
    const r = await deps.sessions.toolCalls(folder, id).catch(() => null)
    if (!r) {
      out.unread.push(id)
      return
    }
    out.calls.push(...r.calls.filter(keep))
    out.children.push(...r.children)
  }
  await read(ref.folder, ref.sessionId)
  const births = deps.births.all()
  const seen = new Set<string>([ref.sessionId])
  const parents = [ref.sessionId]
  while (parents.length > 0 && out.nested.length < NESTED_MAX) {
    const p = parents.shift()!
    for (const b of births) {
      if (b.parent !== p || seen.has(b.sessionId)) continue
      if (ref.agentId !== undefined && b.agentId !== ref.agentId) continue
      if (ref.since !== undefined && b.ctimeMs < ref.since) continue
      seen.add(b.sessionId)
      out.nested.push(b.sessionId)
      parents.push(b.sessionId)
      const folder = deps.sessions.folderOf(b.sessionId) ?? (b.cwd ? mungePath(b.cwd) : ref.folder)
      await read(folder, b.sessionId)
      if (out.nested.length >= NESTED_MAX) break
    }
  }
  return out
}

/** The loader's view of the one SessionIndex. */
export function auditSessionsOf(index: {
  toolCalls(folder: string, id: string): Promise<SessionToolCalls | null>
  allSessions(): { id: string; folder: string }[]
}): AuditSessions {
  return {
    toolCalls: (folder, id) => index.toolCalls(folder, id),
    folderOf: (id) => index.allSessions().find((s) => s.id === id)?.folder ?? null,
  }
}
