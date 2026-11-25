// territory-smoke-files.mts — the «other projects» half of the fence (R5) on
// the REAL `claude` binary, with no login and no model: a scripted Messages
// API on loopback answers every turn with the next tool call of a fixed
// script, and records the tool_result Claude Code sends back. What is
// checked is the engine's own matching of the rules fenceFor really writes:
//
//   · another project's folder, by its path and through a symlink inside the
//     agent's own folder (Read tool, Bash cat, Write — the latter on disk);
//   · that project's transcripts (`~/.claude/projects/<name>`) and its temp
//     store (`<TMPDIR>/claude-<uid>/<name>/<session>/` — observed layout);
//   · a store whose name extends the agent's own: transcripts and session
//     dirs refused, memory/ open (the `????????-*` session glob);
//   · Silos' credentials, `/proc/*/cmdline`, Bash `tmux` (compound too);
//   · its own folder and its own memory stay open; its own project's skill
//     is read, and refused to Edit, Write and a shell redirect;
//   · what an engine loads from above a project (Harness.loadedFromAbove):
//     the owner's CLAUDE.md above it is read, and refused to Edit, Write and
//     a shell redirect; nothing new is written above it nor in the Projects
//     folder (on disk);
//   · `--settings <file>`: the fence named by path, never on argv;
//   · the temp store layout, read back from disk after the run.
//
// Everything lives under one temp dir: HOME, the data dir, TMPDIR, the
// folders. Nothing reads or writes the operator's ~/.claude; the claude
// process gets a clean env (no CLAUDE_*/SILOS_* — never a nested run of a
// Silos conversation) and a fake API key that only the local stub sees.
//
//   npx tsx scripts/territory-smoke-files.mts
//
// Exit 0 = every probe as expected; 1 = a probe failed; 2 = could not run.
import { createServer } from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

const T = mkdtempSync(join(tmpdir(), 'territory-files-'))
const H = join(T, 'home'),
  D = join(H, '.silos'),
  TMP = join(T, 'tmp')
const W = join(T, 'work'),
  O = join(T, 'other'),
  X = join(T, 'work-x')
for (const d of [H, D, TMP, W, O, X]) mkdirSync(d, { recursive: true })
// the engine's temp store is the claude process's TMPDIR: fenceFor (through
// the harness) and the launch below read the same one
process.env.TMPDIR = TMP

const { FENCE_REFUSAL_RE, fenceFor } = await import('../server/src/territory.js')
const { claudeCode } = await import('../server/src/harnesses/claude-code/index.js')
const { opencode } = await import('../server/src/harnesses/opencode/index.js')
const { mungePath } = await import('../server/src/agent-registry.js')

const CANARY = `FILES-CANARY-${process.pid}-${Date.now()}`
const uid = process.getuid?.() ?? 0
const SID = '0f9c2e1a-1111-2222-3333-444455556666'
const plant = (p: string, text = CANARY): void => {
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, `${text}\n`)
}
plant(join(O, 'secret.txt'))
plant(join(D, 'token'))
plant(join(W, 'own.txt'), 'OWN-FILE')
// its own project's skill: read and used, never written (proposed instead)
const ownSkill = join(W, '.claude', 'skills', 'replies', 'SKILL.md')
plant(ownSkill, 'OWN-SKILL')
// the owner's file in a folder above the project (T): theirs, read, never written
const aboveMd = join(T, 'CLAUDE.md')
plant(aboveMd, 'ABOVE-MD')
const P = join(T, 'Projects')
symlinkSync(O, join(W, 'link'))
const proj = (f: string): string => join(H, '.claude', 'projects', mungePath(f))
plant(join(proj(O), `${SID}.jsonl`))
plant(join(TMP, `claude-${uid}`, mungePath(O), SID, 'scratchpad', 'x.txt'))
plant(join(proj(X), `${SID}.jsonl`))
plant(join(proj(X), SID, 'subagents', 'agent-a.jsonl'))
plant(join(proj(X), 'memory', 'MEMORY.md'), 'X-MEMORY-OPEN')
plant(join(proj(W), 'memory', 'MEMORY.md'), 'OWN-MEMORY')

const ag = (id: string, folder: string) => ({ id, name: id, emoji: '', role: '', skills: [], folder })
const builder = ag('builder', W)
const fence = fenceFor({
  agent: builder,
  agents: [builder, ag('maker', O), ag('twin', X)],
  privatePaths: [],
  home: H,
  dataDir: D,
  agentStateDir: join(D, 'agent-state', 'builder'),
  projectStores: (folder, own) => [claudeCode, opencode].flatMap((h) => h.projectStores?.(folder, { home: H, dataDir: D, own }) ?? []),
  loadedFromAbove: (dir) => [claudeCode, opencode].flatMap((h) => h.loadedFromAbove?.(dir, H) ?? []),
  projectsFolder: P,
})
if (!fence) {
  console.log('fenceFor gave no fence')
  process.exit(2)
}
const settingsFile = join(D, 'console-append', 'smoke.settings.json')
plant(settingsFile, JSON.stringify({ permissions: fence.permissions }))

type Step = { name: string; input: Record<string, unknown>; expect: 'refused' | RegExp; disk?: { path: string; exists: boolean } }
const bash = (command: string) => ({ command, description: 'probe' })
const steps: Step[] = [
  { name: 'Read', input: { file_path: join(O, 'secret.txt') }, expect: 'refused' },
  { name: 'Read', input: { file_path: join(W, 'link', 'secret.txt') }, expect: 'refused' },
  { name: 'Bash', input: bash(`cat ${join(W, 'link', 'secret.txt')}`), expect: 'refused' },
  { name: 'Write', input: { file_path: join(O, 'planted.txt'), content: 'x' }, expect: 'refused', disk: { path: join(O, 'planted.txt'), exists: false } },
  {
    name: 'Write',
    input: { file_path: join(W, 'link', 'planted2.txt'), content: 'x' },
    expect: 'refused',
    disk: { path: join(O, 'planted2.txt'), exists: false },
  },
  { name: 'Read', input: { file_path: join(proj(O), `${SID}.jsonl`) }, expect: 'refused' },
  { name: 'Read', input: { file_path: join(TMP, `claude-${uid}`, mungePath(O), SID, 'scratchpad', 'x.txt') }, expect: 'refused' },
  { name: 'Read', input: { file_path: join(proj(X), `${SID}.jsonl`) }, expect: 'refused' },
  { name: 'Read', input: { file_path: join(proj(X), SID, 'subagents', 'agent-a.jsonl') }, expect: 'refused' },
  { name: 'Read', input: { file_path: join(proj(X), 'memory', 'MEMORY.md') }, expect: /X-MEMORY-OPEN/ },
  { name: 'Read', input: { file_path: join(D, 'token') }, expect: 'refused' },
  { name: 'Read', input: { file_path: ownSkill }, expect: /OWN-SKILL/ },
  { name: 'Edit', input: { file_path: ownSkill, old_string: 'OWN-SKILL', new_string: 'x' }, expect: 'refused' },
  { name: 'Write', input: { file_path: ownSkill, content: 'x' }, expect: 'refused' },
  { name: 'Bash', input: bash(`echo x >> ${ownSkill}`), expect: 'refused' },
  { name: 'Read', input: { file_path: aboveMd }, expect: /ABOVE-MD/ },
  { name: 'Edit', input: { file_path: aboveMd, old_string: 'ABOVE-MD', new_string: 'x' }, expect: 'refused' },
  { name: 'Bash', input: bash(`echo x >> ${aboveMd}`), expect: 'refused' },
  { name: 'Write', input: { file_path: join(T, 'AGENTS.md'), content: 'x' }, expect: 'refused', disk: { path: join(T, 'AGENTS.md'), exists: false } },
  {
    name: 'Write',
    input: { file_path: join(T, '.claude', 'rules', 'r.md'), content: 'x' },
    expect: 'refused',
    disk: { path: join(T, '.claude', 'rules', 'r.md'), exists: false },
  },
  { name: 'Bash', input: bash(`mkdir -p ${P} && echo x > ${join(P, 'CLAUDE.md')}`), expect: 'refused', disk: { path: join(P, 'CLAUDE.md'), exists: false } },
  { name: 'Bash', input: bash('tmux -V'), expect: 'refused' },
  { name: 'Bash', input: bash('true && tmux -V'), expect: 'refused' },
  { name: 'Bash', input: bash('cat /proc/self/cmdline'), expect: 'refused' },
  // a command that runs: the engine then opens its temp store for the session
  { name: 'Bash', input: bash('echo probe-ran'), expect: /probe-ran/ },
  { name: 'Read', input: { file_path: join(W, 'own.txt') }, expect: /OWN-FILE/ },
  { name: 'Read', input: { file_path: join(proj(W), 'memory', 'MEMORY.md') }, expect: /OWN-MEMORY/ },
]

// the scripted Messages API: the n-th tool_result in the conversation gets
// step n+1; requests without tools (titles, side calls) get a plain «ok»
const results: { content: string; isError: boolean }[] = []
const textOf = (c: unknown): string => (typeof c === 'string' ? c : JSON.stringify(c))
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (d: Buffer) => {
    body += d
  })
  req.on('end', () => {
    let j: { messages?: { role: string; content: unknown }[]; tools?: unknown[]; stream?: boolean; model?: string } = {}
    try {
      j = JSON.parse(body)
    } catch {
      /* not JSON */
    }
    if (!req.url?.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ input_tokens: 1 }))
      return
    }
    const seen: { content: unknown; is_error?: boolean }[] = []
    for (const m of j.messages ?? [])
      if (m.role === 'user' && Array.isArray(m.content)) for (const c of m.content as { type: string }[]) if (c.type === 'tool_result') seen.push(c as never)
    const main = Array.isArray(j.tools) && j.tools.length > 0
    if (main && seen.length > results.length)
      for (const r of seen.slice(results.length)) results.push({ content: textOf(r.content), isError: r.is_error === true })
    const next = main ? steps[seen.length] : undefined
    const block = next ? { type: 'tool_use', id: `toolu_${seen.length}`, name: next.name, input: next.input } : { type: 'text', text: 'done' }
    const stop = next ? 'tool_use' : 'end_turn'
    const message = {
      id: `msg_${seen.length}`,
      type: 'message',
      role: 'assistant',
      model: j.model ?? 'claude',
      content: [] as unknown[],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }
    if (!j.stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ...message, content: [block], stop_reason: stop }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const ev = (type: string, data: object): void => {
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    }
    ev('message_start', { message })
    if (next) {
      ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: (block as { id: string }).id, name: next.name, input: {} } })
      ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(next.input) } })
    } else {
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'done' } })
    }
    ev('content_block_stop', { index: 0 })
    ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } })
    ev('message_stop', {})
    res.end()
  })
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
const port = (server.address() as AddressInfo).port

let version = 'unknown'
try {
  version = execFileSync('claude', ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: H } }).trim()
} catch {
  console.log('no `claude` on PATH')
  process.exit(2)
}
console.log(`claude version: ${version}`)
console.log(`deny rules: ${fence.permissions.deny.length}`)

const argv = ['-p', '--dangerously-skip-permissions', '--settings', settingsFile, '--output-format', 'json', 'run the probes']
const env = {
  PATH: process.env.PATH ?? '',
  HOME: H,
  TMPDIR: TMP,
  ANTHROPIC_API_KEY: 'sk-smoke-local',
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
}
const exit = await new Promise<number | null>((resolve) => {
  const child = spawn('claude', argv, { cwd: W, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const timer = setTimeout(() => child.kill('SIGKILL'), 180_000)
  child.on('exit', (code) => {
    clearTimeout(timer)
    resolve(code)
  })
})
server.close()
console.log(`== exit code: ${exit}`)

let fail = 0
steps.forEach((s, i) => {
  const r = results[i]
  const what = `${s.name} ${JSON.stringify(s.input.file_path ?? s.input.command)}`
  if (!r) {
    console.log(`FAIL no result   ${what}`)
    fail = 1
    return
  }
  const ok = s.expect === 'refused' ? FENCE_REFUSAL_RE.test(r.content) && !r.content.includes(CANARY) : s.expect.test(r.content)
  const disk = s.disk ? existsSync(s.disk.path) === s.disk.exists : true
  console.log(`${ok && disk ? 'ok  ' : 'FAIL'} ${s.expect === 'refused' ? 'refused' : 'open   '} ${what} — ${r.content.slice(0, 110).replace(/\n/g, ' ')}`)
  if (!ok || !disk) fail = 1
})
if (results.some((r) => r.content.includes(CANARY))) {
  console.log('FAIL a canary reached a tool result')
  fail = 1
}
// the temp store's layout, from disk: <TMPDIR>/claude-<uid>/<munged cwd>/<session>/
const base = join(TMP, `claude-${uid}`)
const names = existsSync(base) ? readdirSync(base) : []
const own = join(base, mungePath(W))
const sessions = existsSync(own) ? readdirSync(own) : []
console.log(
  `${names.includes(mungePath(W)) ? 'ok  ' : 'warn'} temp store observed: <TMPDIR>/claude-${uid}/ holds ${JSON.stringify(names.filter((n) => n !== mungePath(O)))}; its own store holds ${JSON.stringify(sessions)}`,
)
rmSync(T, { recursive: true, force: true })
process.exit(fail)
