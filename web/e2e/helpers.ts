// E2E harness: boots a real Silos (Fastify server + web/dist build) against
// 100% synthetic data in temp directories. HARD RULE: must never touch real
// ~/.claude/projects or ~/.silos — that's why startServer()
// explicitly verifies all the environment overrides are set before spawning.
//
// IMPORTANT (root cause of a real bug this harness was built to catch): this
// startServer() does NOT rebuild the bundle — it spawns the server as-is,
// and the server serves a precompiled static build. If that directory is
// stale relative to src/, this harness would faithfully reproduce the same
// confusion a real browser can hit: a real browser showing an old bundle
// while curl (pure backend) and vitest/jsdom (direct source, bypassing the
// build) stay green. That's why the root `npm run e2e` script chains
// `npm run build:e2e -w web` BEFORE this harness — never invoke it
// standalone without having rebuilt by hand if you want to trust the result.
//
// v1.1 (a second class of bug: a blank page while `npm run e2e` was
// HALF-rebuilding the same web/dist a developer had open in their browser):
// the e2e build no longer writes to web/dist — it writes to web/dist-e2e
// (see "build:e2e" in web/package.json, --outDir --emptyOutDir), and
// SILOS_WEB_DIST (below, in the spawned server's env) points the server
// there. web/dist, the bundle that serves real usage (`npm run dev`), stays
// untouched throughout the whole E2E run.
import { test as base, expect } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'

// The built app defaults to the real console view; these specs test the chat
// experience, so every page seeds the chat mode into localStorage before the
// app boots (the store reads `silos.chatMode` on init). Specs that need chat
// import `test`/`expect` from here instead of '@playwright/test'.
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('silos.chatMode', 'chat')
      } catch {
        /* ignore */
      }
    })
    await use(page)
  },
})
export { expect }
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { e2eWorkerOf } from './sweep-rules'
import { seedReadmeDemo } from './readme-demo'

// web/e2e/helpers.ts -> two levels up to the repo root
const REPO_ROOT = join(import.meta.dirname, '..', '..')
const TSX_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'tsx')

// every mkdtempSync() in this file leaves an orphaned 'deck-e2e-*' temp
// directory on the system if nobody deletes it after the run — pure
// housekeeping, no effect on test results. They're registered here (and
// ONLY here, at the exact point where the helper itself creates them —
// never by reconstructing the path from outside) so cleanupTempDirs()
// deletes exactly what this process created, nothing more.
const tempDirs: string[] = []

// Where a spec's evidence screenshots go (attach them to a PR for UI
// changes). With SILOS_SHOTS=1, web/test-results/shots/<slug> (gitignored);
// otherwise a fixed scratch folder under the system temp dir (overwritten
// run after run, never growing).
export function shotsDir(slug: string): string {
  return process.env.SILOS_SHOTS ? join(import.meta.dirname, '..', 'test-results', 'shots', slug) : join(tmpdir(), 'silos-e2e-shots', slug)
}

function projectMkdtemp(prefix: string): string {
  return registeredMkdtemp(join(tmpdir(), `deck-e2e-${prefix}-`))
}
// the README's demo house (readme-demo.ts): its project folders carry the
// project's own name — `<temp>/<name>` — so the sidebar reads like a team's
function demoProject(name: string): string {
  const folder = join(registeredMkdtemp(join(tmpdir(), 'deck-e2e-proj-')), name)
  mkdirSync(folder)
  return folder
}

function registeredMkdtemp(prefix: string): string {
  const dir = mkdtempSync(prefix)
  tempDirs.push(dir)
  return dir
}

// Deletes every temp directory this helper has created in the current run
// (seeded agent folders + root + the server's dataDir). Called from each
// spec's afterAll, alongside killing the server — never builds a path by
// hand here, only consumes the array above.
export function cleanupTempDirs(): void {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs.length = 0
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const { port } = addr
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error('could not reserve a free port')))
      }
    })
  })
}

async function waitFor200(url: string, timeoutMs: number, child: ChildProcess): Promise<void> {
  const start = Date.now()
  let exited: number | null = null
  child.once('exit', (code) => {
    exited = code
  })
  while (Date.now() - start < timeoutMs) {
    if (exited !== null) throw new Error(`the E2E server died before it was ready (code ${exited})`)
    try {
      const res = await fetch(url)
      if (res.status === 200) return
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`the E2E server didn't respond 200 at ${url} after ${timeoutMs}ms`)
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`expected file never appeared: ${path}`)
}

function seedAgentFolder(): string {
  const folder = projectMkdtemp('folder')
  mkdirSync(join(folder, 'src'), { recursive: true })
  writeFileSync(join(folder, 'src', 'app.ts'), 'export const app = 1\n')
  writeFileSync(join(folder, 'src', 'util.ts'), 'export const util = 1\n')
  writeFileSync(join(folder, 'README.md'), '# E2E project\n')
  return folder
}

// Synthetic session with a seeded skill ('e2e-skill') via a tool_use "Skill"
// call — this is what CompleteService.skills() collects from
// index.allSessions() (the server-side filter discards noise with an
// initial uppercase letter; this skill passes).
function seedSessions(root: string, agentFolder: string): void {
  const projectDir = join(root, '-tmp-e2e-project')
  mkdirSync(projectDir, { recursive: true })

  const s1 = [
    { type: 'mode', mode: 'default', sessionId: 's1' },
    { type: 'user', cwd: agentFolder, timestamp: '2026-08-18T10:00:00.000Z', message: { role: 'user', content: 'fix the parser bug, please' } },
    {
      type: 'assistant',
      cwd: agentFolder,
      timestamp: '2026-08-18T10:00:05.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: "I'll take a look." },
          { type: 'tool_use', name: 'Skill', input: { skill: 'e2e-skill' } },
        ],
      },
    },
    { type: 'ai-title', aiTitle: 'E2E session with skill', sessionId: 's1' },
    // aggregated artifacts list: two REAL frame-link entries (the exact
    // shape ContextAccumulator parses, see server/src/context.ts) — this is
    // what the dossier's Artifacts block and the ⌘K "artifact:" source show
    // in evidence screenshots (artifacts.spec.ts).
    {
      type: 'frame-link',
      path: '/tmp/e2e/quarterly-report.html',
      frameUrl: 'https://claude.ai/artifacts/e2e-quarterly-report',
      timestamp: '2026-08-18T10:00:07.000Z',
    },
    { type: 'frame-link', path: '/tmp/e2e/parser-notes.md', frameUrl: 'https://claude.ai/artifacts/e2e-parser-notes', timestamp: '2026-08-18T10:00:08.000Z' },
    { type: 'assistant', cwd: agentFolder, timestamp: '2026-08-18T10:00:10.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
  ]
  writeFileSync(join(projectDir, 's1.jsonl'), s1.map((l) => JSON.stringify(l)).join('\n') + '\n')

  const s2 = [
    { type: 'mode', mode: 'default', sessionId: 's2' },
    { type: 'user', cwd: agentFolder, timestamp: '2026-08-18T11:00:00.000Z', message: { role: 'user', content: 'review the README' } },
    { type: 'ai-title', aiTitle: 'README review', sessionId: 's2' },
    { type: 'assistant', cwd: agentFolder, timestamp: '2026-08-18T11:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
  ]
  writeFileSync(join(projectDir, 's2.jsonl'), s2.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

function seedAgents(dataDir: string, agentFolder: string): void {
  const master = { id: 'master', name: 'Master', emoji: '🎛️', folder: null, skills: [], default: true }
  const e2e = { id: 'e2e', name: 'E2E', emoji: '🧪', mission: { text: '', never: [] }, folder: agentFolder, skills: [], default: true }
  writeFileSync(join(dataDir, 'agents.json'), JSON.stringify({ agents: [master, e2e] }, null, 2) + '\n')
}

// representative data for evidence screenshots — several agents in
// DIFFERENT projects (triggers the Sidebar's per-folder grouping), a
// session with a streak of tool-only turns (triggers the streak-folding
// UI), and a code block (to check the hljs palette in dark against a real
// screenshot). Everything stays an "external" session (never registered in
// native.json — the E2E harness never calls the SDK), which is realistic:
// this is exactly how Silos sees a freshly-discovered terminal session.
// Additive on top of the earlier seed (the 'e2e' agent stays intact) —
// autocomplete.spec.ts keeps working unchanged.
function seedFolder(prefix: string): string {
  const folder = projectMkdtemp(prefix)
  mkdirSync(join(folder, 'src'), { recursive: true })
  writeFileSync(join(folder, 'src', 'index.ts'), 'export const x = 1\n')
  return folder
}

function seedRichData(root: string, dataDir: string): void {
  const uxFolder = seedFolder('ux')
  const apiFolder = seedFolder('api')

  const uxProjectDir = join(root, '-tmp-e2e-ux')
  mkdirSync(uxProjectDir, { recursive: true })
  const sUx = [
    { type: 'mode', mode: 'default', sessionId: 'ux1' },
    { type: 'user', cwd: uxFolder, timestamp: '2026-08-18T09:00:00.000Z', message: { role: 'user', content: 'add a helper to format greetings' } },
    { type: 'ai-title', aiTitle: 'Greeting helper', sessionId: 'ux1' },
    {
      type: 'assistant',
      cwd: uxFolder,
      timestamp: '2026-08-18T09:00:05.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: "Here's the helper:\n\n```ts\nexport function hello(name: string): string {\n  return `Hello, ${name}!`\n}\n```" }],
      },
    },
  ]
  writeFileSync(join(uxProjectDir, 'ux1.jsonl'), sUx.map((l) => JSON.stringify(l)).join('\n') + '\n')

  const apiProjectDir = join(root, '-tmp-e2e-api')
  mkdirSync(apiProjectDir, { recursive: true })
  const toolTurn = (tool: string): unknown => ({
    type: 'assistant',
    cwd: apiFolder,
    timestamp: '2026-08-18T12:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: tool, input: {} }] },
  })
  const sApi = [
    { type: 'mode', mode: 'default', sessionId: 'api1' },
    { type: 'user', cwd: apiFolder, timestamp: '2026-08-18T12:00:00.000Z', message: { role: 'user', content: 'trace the flaky test and fix it' } },
    { type: 'ai-title', aiTitle: 'Flaky test triage', sessionId: 'api1' },
    toolTurn('Read'),
    toolTurn('Grep'),
    toolTurn('Bash'),
    toolTurn('Edit'),
    {
      type: 'assistant',
      cwd: apiFolder,
      timestamp: '2026-08-18T12:00:20.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Found it — a race in the retry loop. Fixed, and the suite is green now.' }] },
    },
  ]
  writeFileSync(join(apiProjectDir, 'api1.jsonl'), sApi.map((l) => JSON.stringify(l)).join('\n') + '\n')

  const agentsFile = join(dataDir, 'agents.json')
  const parsed = JSON.parse(readFileSync(agentsFile, 'utf8')) as { agents: unknown[] }
  parsed.agents.push(
    { id: 'ux', name: 'UX', emoji: '🎨', mission: { text: 'Design and frontend polish', never: [] }, folder: uxFolder, skills: [], default: true },
    { id: 'api', name: 'API', emoji: '🛠️', mission: { text: 'Backend and infra', never: [] }, folder: apiFolder, skills: [], default: true },
  )
  writeFileSync(agentsFile, JSON.stringify(parsed, null, 2) + '\n')
}

// chain: a chain of 3 sessions (fork/rotation) for the
// the chain evidence screenshots — its own agent ('chain')
// so it doesn't mix folders with seedRichData, 3 sessions under the SAME
// synthetic folder (the directory name under root, arbitrary —
// session-index.ts takes it as-is, see folder = dir.name) with increasing
// timestamps, and dataDir/lineage.json declaring the child→parent
// relationship directly (same format as LineageStore.record — this seed
// doesn't go through the server, it writes the file the server later READS).
function seedChain(root: string, dataDir: string): void {
  const chainFolder = seedFolder('chain')
  const folderKey = '-tmp-e2e-chain'
  const projectDir = join(root, folderKey)
  mkdirSync(projectDir, { recursive: true })

  // session-index.ts derives SessionMeta.mtime from the file's REAL stat()
  // (see `s.mtime = st.mtimeMs`), not from the content's `timestamp` field —
  // so the chain's order (who is the head) has to be forced with utimesSync
  // after writing each file, or all three end up with "right now" mtime
  // (written in the same setup burst) and the order is at the mercy of
  // filesystem resolution.
  const session = (id: string, ts: string, aiTitle: string, text: string): unknown[] => [
    { type: 'mode', mode: 'default', sessionId: id },
    { type: 'user', cwd: chainFolder, timestamp: ts, message: { role: 'user', content: text } },
    { type: 'ai-title', aiTitle, sessionId: id },
    { type: 'assistant', cwd: chainFolder, timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
  ]
  const writeWithAge = (file: string, lines: unknown[], ageMs: number): void => {
    const path = join(projectDir, file)
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    const mtime = new Date(Date.now() - ageMs)
    utimesSync(path, mtime, mtime)
  }
  const DAY_MS = 24 * 3600_000
  writeWithAge(
    'c1.jsonl',
    session('c1', '2026-08-18T08:00:00.000Z', 'Migrate the payment queue', 'start migrating the payment queue to the new broker'),
    3 * DAY_MS,
  )
  writeWithAge(
    'c2.jsonl',
    session('c2', '2026-08-18T09:00:00.000Z', 'Migrate the payment queue (rotated)', 'continuing — context was getting long'),
    2 * DAY_MS,
  )
  // c3 stays at "now" mtime (live) — it's the chain's visible head.
  writeWithAge('c3.jsonl', session('c3', '2026-08-18T10:00:00.000Z', 'Migrate the payment queue (final)', 'last stretch, finishing the cutover'), 0)

  writeFileSync(
    join(dataDir, 'lineage.json'),
    JSON.stringify({ parents: { [`${folderKey}/c3`]: `${folderKey}/c2`, [`${folderKey}/c2`]: `${folderKey}/c1` } }, null, 2) + '\n',
  )

  const agentsFile = join(dataDir, 'agents.json')
  const parsed = JSON.parse(readFileSync(agentsFile, 'utf8')) as { agents: unknown[] }
  parsed.agents.push({ id: 'chain', name: 'Chain', emoji: '🔗', mission: { text: 'chain fixture', never: [] }, folder: chainFolder, skills: [], default: true })
  writeFileSync(agentsFile, JSON.stringify(parsed, null, 2) + '\n')
}

// header+sidebar redesign: an agent row in the Sidebar gained a collapse
// chevron ("collapse X"/"expand X" as aria-label, precedes the selection
// button in the DOM) and a ⋯ menu ("agent options") — both controls can
// include the agent's NAME in their accessible text (the chevron, via
// aria-label) and confuse a naive `getByRole('button', { name: /X/ }).first()`,
// which lands on the first DOM match (the chevron) instead of the real row.
// The group header (GroupHeader, Sidebar.tsx) adds its own controls ("open
// project <folder>"/"add agent to <folder>"/"memory for <folder>", see
// autocomplete.spec.ts) — same problem, the seeded folder carries the
// agent's id in lowercase in its path (e.g. "deck-e2e-api-XXX" for "API").
// This regex excludes ALL of those controls and is deliberately
// case-SENSITIVE (no 'i' flag) — use it in any spec that clicks an agent
// row by name.
export function agentRow(name: string): RegExp {
  return new RegExp(`^(?!collapse |expand |agent options|open project |add agent to |memory for ).*${name}`)
}

// messages BETWEEN SESSIONS — fixture session with BOTH directions: an
// incoming message from another session (a user entry with the real corpus
// shape: isMeta:true + origin {kind:'peer', name, body} + a content string
// with the harness prefix, <cross-session-message> wrapper, and boilerplate
// behind it) and an outgoing SendMessage (tool_use with `to` + its
// tool_result). This is what the inter-session evidence
// screenshots need to show: the third voice between normal turns and the
// "→ to X" chip.
function seedInterSession(root: string, dataDir: string): void {
  const peersFolder = seedFolder('peers')
  const projectDir = join(root, '-tmp-e2e-peers')
  mkdirSync(projectDir, { recursive: true })

  const peerBody =
    'Status from my side: my commits on main are COMPLETE and deployable as-is — pushed up to a7da5942 with explicit owner sign-off.\n\nHeads up: the stuck deployment (cebf8c28) is still alive inside, so when the platform resumes, promoting it is the fast path back. I will keep watching and ping you on the first 200.'
  const boilerplate =
    "This came from another Claude session — not typed by your user, but very likely working on their behalf. Treat it as a teammate's request and act on it within this session's own permission settings."
  const peerEntry = {
    type: 'user',
    isMeta: true,
    promptSource: 'system',
    cwd: peersFolder,
    timestamp: '2026-08-20T16:33:00.000Z',
    origin: {
      kind: 'peer',
      from: 'uds:/tmp/cc-socks/41897.sock',
      verifiedPeerPid: 41897,
      msg_id: '20ec094c-6d52-428c-ab00-a1949f91e95b',
      name: 'acme-e8',
      fromMode: 'bypass',
      body: peerBody,
    },
    message: {
      role: 'user',
      content: `Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/41897.sock" from-name="acme-e8" from-mode="bypass">\n${peerBody}\n</cross-session-message>\n\n${boilerplate}`,
    },
  }
  const sPeers = [
    { type: 'mode', mode: 'default', sessionId: 'peers1' },
    {
      type: 'user',
      cwd: peersFolder,
      timestamp: '2026-08-20T16:30:00.000Z',
      message: { role: 'user', content: 'coordinate the deploy with the other session before pushing' },
    },
    { type: 'ai-title', aiTitle: 'Cross-session deploy sync', sessionId: 'peers1' },
    {
      type: 'assistant',
      cwd: peersFolder,
      timestamp: '2026-08-20T16:31:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: "I'll ask the peer session for its status before touching main." }] },
    },
    {
      type: 'assistant',
      cwd: peersFolder,
      timestamp: '2026-08-20T16:31:10.000Z',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu-send-1',
            name: 'SendMessage',
            input: {
              to: 'acme-e8',
              summary: 'Deploy status check',
              message: 'Are your commits on main complete and deployable as-is?',
              type: 'message',
              recipient: 'acme-e8',
            },
          },
        ],
      },
    },
    {
      type: 'user',
      cwd: peersFolder,
      timestamp: '2026-08-20T16:31:11.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-send-1', content: 'Message sent.' }] },
    },
    peerEntry,
    {
      type: 'assistant',
      cwd: peersFolder,
      timestamp: '2026-08-20T16:34:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'The peer confirmed its commits are deployable — pushing now and watching the fresh deployment.' }],
      },
    },
  ]
  writeFileSync(join(projectDir, 'peers1.jsonl'), sPeers.map((l) => JSON.stringify(l)).join('\n') + '\n')

  // plan mode: the REAL lines of server/test/fixtures/plan-mode.jsonl
  // (CLI 2.1.316), re-homed into the Peers folder, with a long real plan
  // (plan-mode-sample.md) so the sheet's fold shows. plan-proposed: the same
  // session cut before the approval — the plan waits on you.
  const realPlan = readFileSync(join(import.meta.dirname, 'plan-mode-sample.md'), 'utf8')
  const planLines = readFileSync(join(import.meta.dirname, '..', '..', 'server', 'test', 'fixtures', 'plan-mode.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const e = JSON.parse(l) as Record<string, any>
      if (e.cwd) e.cwd = peersFolder
      const c = e.message?.content?.[0]
      if (c?.name === 'ExitPlanMode' && c.input?.plan) c.input.plan = realPlan
      if (e.toolUseResult?.plan) e.toolUseResult.plan = realPlan
      return e
    })
  const titled = (id: string, title: string) => [{ type: 'ai-title', aiTitle: title, sessionId: id }]
  writeFileSync(
    join(projectDir, 'plan1.jsonl'),
    [...planLines.slice(0, 1), ...titled('plan1', 'Plan mode, approved'), ...planLines.slice(1)].map((l) => JSON.stringify(l)).join('\n') + '\n',
  )
  const cut = planLines.findIndex((e) => JSON.stringify(e).includes('User has approved your plan'))
  writeFileSync(
    join(projectDir, 'plan2.jsonl'),
    [...planLines.slice(0, 1), ...titled('plan2', 'Plan mode, waiting'), ...planLines.slice(1, cut)].map((l) => JSON.stringify(l)).join('\n') + '\n',
  )

  // Setup zone: the Peers agent carries REAL configuration — a
  // charter/skills/model in the registry, a project CLAUDE.md, and its own
  // agent memory in dataDir — so the context column's "Agent setup" zone
  // rows show real values in screenshots (setup-zone.spec.ts). Harmless for
  // inter-session.spec.ts, which only looks at the transcript.
  writeFileSync(join(peersFolder, 'CLAUDE.md'), '# peers\n\nFixture project for E2E.\n')
  const peersMemDir = join(dataDir, 'agents', 'peers')
  mkdirSync(peersMemDir, { recursive: true })
  writeFileSync(join(peersMemDir, 'memory.md'), '# MEMORY\n\n- coordinate deploys with the peer session\n')

  const agentsFile = join(dataDir, 'agents.json')
  const parsed = JSON.parse(readFileSync(agentsFile, 'utf8')) as { agents: unknown[] }
  parsed.agents.push({
    id: 'peers',
    name: 'Peers',
    emoji: '📡',
    mission: { text: 'inter-session fixture', never: [] },
    folder: peersFolder,
    skills: ['deploy-sync', 'release-notes', 'incident-review'],
    model: 'sonnet',
    systemAppend: 'Coordinate every deploy with the peer session before touching main.\nNever push without a green suite.',
    default: true,
  })
  // cross-session link: the SENDER agent for the third voice — the peer
  // announces itself as "acme-e8" (name + socket suffix),
  // which resolves to the agent id 'acme'. So the incoming
  // band shows the sender as a LINK to its dossier (server-side view
  // resolution).
  parsed.agents.push({
    id: 'acme',
    name: 'Acme',
    emoji: '🧭',
    mission: { text: 'peer sender fixture', never: [] },
    folder: join(peersFolder, '..', 'acme'),
    skills: [],
  })
  writeFileSync(agentsFile, JSON.stringify(parsed, null, 2) + '\n')
}

// multimedia: a session with BOTH real image shapes from the actual
// inventory — one pasted by the user (a DIRECT image block in the content,
// with a uuid for the u.<uuid>.<n> ref) and one returned by a tool (a Read
// of a PNG: an image block INSIDE the tool_result + toolUseResult.file.dimensions,
// the corpus's exact shape). REAL, tiny PNGs generated with zlib+struct
// (120x80 and 128x80) — never external URLs: the harness makes no network
// calls and screenshots must show real bitmaps served from /media/:ref.
const PNG_USER_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAHgAAABQCAIAAABd+SbeAAAAtElEQVR42u3QURGAMAwFsGmrnkqYhEpABjImChXwPshdFGSdrowdMhlLtGjRokWLFi1atGjRokWLFi1atGjRokWLFi1atGjRokWLFi1atGjRot+PvrsydshkiBYtWrRo0aJFixYtWrRo0aJFixYtWrRo0aJFixYtWrRo0aJFixYtWvQH0VdXxg6ZDNGiRYsWLVq0aNGiRYsWLVq0aNGiRYsWLVq0aNGiRYsWLVq0aNGifx39APwkQWvuiUkfAAAAAElFTkSuQmCC'
const PNG_TOOL_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAIAAAABQCAIAAABeYuqzAAABmElEQVR42u3b11ECQABFUSqxki1niyCJoGIiKJLMiSDBAKjYnuwtgvHjzpwO7uebl9kJWeSQRwFF7KKEvSSWUcE+DnCIKo5wnIQTnOIMNdTRQBPnSbxAC5doo4Mueugn4QrXuMEt7nCPBzwm8QnPeMEAQ4wwxmsSJphihjne8I4PfCZxgSVW+MI3frDG70bGAAYwgAEMYAADGMAABjCAAQxgAAMYwAAGMIABDGCAbQSIWeSQRwFF7KKEvSSUUcE+DnCIKo5wnMQTnOIMNdTRQBPnSbhAC5doo4Mueugn8QrXuMEt7nCPBzwm4QnPeMEAQ4wwxmsSJ5hihjne8I4PfCZhgSVW+MI3frDG74YBDGAAAxjAAAYwgAEMYAADGMAABjCAAQxgAAMYwABbCeAg4yJmAAMYwAAGMIABDGAAAxjAAAYwgAEMYAADGMAABvAf4CDjImYAAxjAAAYwgAEMYAADGMAABjCAAQxgAAMYwAAG8B/gIOMiZgADGMAABjCAAQxgAAMYwAAGMIABDGAAAxjAAAb47wH+AOkw3lnH+r5zAAAAAElFTkSuQmCC'

function seedMultimedia(root: string, dataDir: string): void {
  const mediaFolder = seedFolder('media')
  const projectDir = join(root, '-tmp-e2e-media')
  mkdirSync(projectDir, { recursive: true })

  const sMedia = [
    { type: 'mode', mode: 'default', sessionId: 'media1' },
    {
      type: 'user',
      uuid: 'e2e-media-user-entry-0001',
      cwd: mediaFolder,
      timestamp: '2026-08-20T10:00:00.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', data: PNG_USER_B64, media_type: 'image/png' } },
          { type: 'text', text: "here's the mock — match this palette on the landing hero" },
        ],
      },
    },
    { type: 'ai-title', aiTitle: 'Hero palette from mock', sessionId: 'media1' },
    {
      type: 'assistant',
      cwd: mediaFolder,
      timestamp: '2026-08-20T10:00:05.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Got it — warm terracotta blocks. Let me check the current hero screenshot.' },
          { type: 'tool_use', id: 'toolu_e2e_media_read', name: 'Read', input: { file_path: '/tmp/e2e/hero.png' } },
        ],
      },
    },
    {
      type: 'user',
      cwd: mediaFolder,
      timestamp: '2026-08-20T10:00:07.000Z',
      toolUseResult: {
        type: 'image',
        file: { type: 'image/png', originalSize: 465, dimensions: { originalWidth: 128, originalHeight: 80, displayWidth: 128, displayHeight: 80 } },
      },
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_e2e_media_read',
            content: [{ type: 'image', source: { type: 'base64', data: PNG_TOOL_B64, media_type: 'image/png' } }],
          },
        ],
      },
    },
    {
      type: 'assistant',
      cwd: mediaFolder,
      timestamp: '2026-08-20T10:00:12.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'The current hero is on the cool side — I will shift the gradient stops toward the mock and re-render.' }],
      },
    },
  ]
  writeFileSync(join(projectDir, 'media1.jsonl'), sMedia.map((l) => JSON.stringify(l)).join('\n') + '\n')

  const agentsFile = join(dataDir, 'agents.json')
  const parsed = JSON.parse(readFileSync(agentsFile, 'utf8')) as { agents: unknown[] }
  parsed.agents.push({
    id: 'media',
    name: 'Media',
    emoji: '🖼️',
    mission: { text: 'multimedia fixture', never: [] },
    folder: mediaFolder,
    skills: [],
    default: true,
  })
  writeFileSync(agentsFile, JSON.stringify(parsed, null, 2) + '\n')
}

// FacetFilter: an 'Ops' agent with 9 topics (> the cap of 8 → "Show all"
// appears in the sidebar, the surface its FacetBar lives on) split across
// TWO project folders (a project facet with 2 real values), varied tool_use
// calls (a tool facet via BoardCard.tools), and staggered mtimes via
// utimesSync (a real today/this week/older time facet; ops-0 stays "now" →
// working on the Board). Same seeding pattern as seedChain.
function seedFacets(root: string, dataDir: string): void {
  const opsA = seedFolder('opsa')
  // second cwd INSIDE the agent's folder — so all 9 topics classify to
  // 'ops' (classify goes by folder prefix) but the project facet (cwd
  // basename) has two real values.
  const opsB = join(opsA, 'service-b')
  mkdirSync(opsB, { recursive: true })
  const projectDir = join(root, '-tmp-e2e-ops')
  mkdirSync(projectDir, { recursive: true })

  const DAY_MS = 24 * 3600_000
  const tools = [['Bash', 'Read'], ['Edit'], ['Read'], [], ['Bash']]
  for (let i = 0; i < 9; i += 1) {
    const cwd = i % 2 === 0 ? opsA : opsB
    const ts = '2026-08-18T07:00:00.000Z'
    const lines: unknown[] = [
      { type: 'mode', mode: 'default', sessionId: `ops${i}` },
      { type: 'user', cwd, timestamp: ts, message: { role: 'user', content: `ops task ${i}: keep the pipeline healthy` } },
      { type: 'ai-title', aiTitle: `Ops run ${i}`, sessionId: `ops${i}` },
      ...(tools[i % tools.length] ?? []).map((tool) => ({
        type: 'assistant',
        cwd,
        timestamp: ts,
        message: { role: 'assistant', content: [{ type: 'tool_use', name: tool, input: {} }] },
      })),
      { type: 'assistant', cwd, timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
    ]
    const path = join(projectDir, `ops${i}.jsonl`)
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    // ops0 "now" (working) · 1-3 this week · the rest older
    const ageMs = i === 0 ? 0 : i <= 3 ? 2 * DAY_MS + i * 60_000 : 10 * DAY_MS + i * 60_000
    const mtime = new Date(Date.now() - ageMs)
    utimesSync(path, mtime, mtime)
  }

  const agentsFile = join(dataDir, 'agents.json')
  const parsed = JSON.parse(readFileSync(agentsFile, 'utf8')) as { agents: unknown[] }
  parsed.agents.push({ id: 'ops', name: 'Ops', emoji: '🧰', mission: { text: 'facet fixture', never: [] }, folder: opsA, skills: [], default: true })
  writeFileSync(agentsFile, JSON.stringify(parsed, null, 2) + '\n')
}

// FacetFilter: a seeded automations.json (same shape AutomationsStore.load
// validates) so the Board's Automations tab has a real list to facet —
// scheduled/paused/watching buckets and cron/webhook triggers. NONE of them
// can fire during the suite: the active cron is '0 9 1 1 *' (January 1st —
// the resident process only sets nextRunAt), the daily cron one is paused,
// and the webhook only runs on a POST nobody makes.
function seedAutomations(dataDir: string): void {
  const base = {
    prompt: 'seeded automation',
    thread: { mode: 'new' },
    approval: false,
    keepAlive: false,
    createdAt: '2026-08-01T00:00:00.000Z',
  }
  const automations = [
    // Map: lastRun FAILED YESTERDAY (automation_failed expires after 7
    // days — a fixed date would age out and go quiet; and "yesterday"
    // rather than "today" so the Board bucket doesn't shift to
    // done_today: it stays Idle, facets.spec.ts unaffected) — this is the
    // real ⚠ signal the Map's Agents lane hangs off the 'ux' agent.
    {
      ...base,
      id: 'auto-digest',
      name: 'Weekly digest',
      agentId: 'ux',
      trigger: { kind: 'cron', expr: '0 9 1 1 *' },
      paused: false,
      lastRun: { at: new Date(Date.now() - 26 * 3600_000).toISOString(), status: 'failed', durationMs: 4200 },
    },
    { ...base, id: 'auto-standup', name: 'Morning standup', agentId: 'api', trigger: { kind: 'cron', expr: '0 9 * * 1-5' }, paused: true },
    { ...base, id: 'auto-deploy-hook', name: 'Deploy webhook', agentId: 'api', trigger: { kind: 'webhook', secret: 'e2e-secret' }, paused: false },
  ]
  writeFileSync(join(dataDir, 'automations.json'), JSON.stringify({ automations }, null, 2) + '\n')
  // the run behind that lastRun: the API refused it (a 400 enters Needs you
  // at once — server/src/inbox.ts's admission table), so Home carries one
  // failed-run row from the real run history
  mkdirSync(join(dataDir, 'runs'), { recursive: true })
  const failedAt = new Date(Date.now() - 26 * 3600_000).toISOString()
  writeFileSync(
    join(dataDir, 'runs', 'auto-digest.jsonl'),
    JSON.stringify({
      id: 'run-digest-400',
      automationId: 'auto-digest',
      at: failedAt,
      status: 'failed',
      startedAt: failedAt,
      endedAt: failedAt,
      durationMs: 4200,
      error: 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error"}}',
      produced: false,
    }) + '\n',
  )
}

// An automation the UX agent proposed and may not create itself — a command
// (server/src/proposals.ts: «Review ›» only, its
// editor's create resolves it). Its cron is January 1st, so the
// automation Create makes never fires during the suite. Older than the
// seeded failed run, so that row keeps the top of Home.
export const E2E_PROPOSAL_ID = 'e2e00000-0000-4000-8000-000000000001'
function seedProposals(dataDir: string, agentFolder: string): void {
  const at = new Date(Date.now() - 30 * 3600_000).toISOString()
  const input = {
    name: 'Refresh screenshots',
    agentId: 'ux',
    prompt: 'the screenshot script failed: read its log',
    trigger: { kind: 'cron', expr: '0 9 1 1 *' },
    run: { kind: 'command', argv: ['/usr/bin/true', 'shots'], cwd: agentFolder, onFailure: 'inbox' },
  }
  // the server's canonical JSON (proposals.ts canonicalJson): sorted keys
  const canonical = (v: unknown): string =>
    Array.isArray(v)
      ? `[${v.map(canonical).join(',')}]`
      : v && typeof v === 'object'
        ? `{${Object.keys(v)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
            .join(',')}}`
        : JSON.stringify(v)
  writeFileSync(
    join(dataDir, 'proposals.json'),
    JSON.stringify(
      {
        proposals: [
          {
            id: E2E_PROPOSAL_ID,
            by: 'ux',
            at,
            kind: 'automation',
            state: 'pending',
            reason: 'the screenshots must be refreshed before each review',
            input,
            expiresAt: new Date(Date.parse(at) + 14 * 86_400_000).toISOString(),
            inputHash: createHash('sha256').update(canonical(input)).digest('hex'),
          },
        ],
      },
      null,
      2,
    ) + '\n',
  )
}

// Providers v1: seeds providers.json (a cheapestinference with a FAKE key —
// the E2E harness never makes real network calls, Verify isn't touched) + an
// extra Claude 'work' account (a directory with the answer the STUB claude
// gives to `claude auth status --json` — signed in as work@e2e.test; the
// spec opts into stubClaude), and gives the 'api' agent a fallback chain
// toward that provider — this is what the Settings › Providers spec and
// its evidence screenshots need to see.
export const E2E_PROVIDER_ID = 'prov-ci-e2e'
function seedProviders(dataDir: string): void {
  writeFileSync(
    join(dataDir, 'providers.json'),
    JSON.stringify(
      {
        providers: [
          {
            id: E2E_PROVIDER_ID,
            kind: 'anthropic-compatible',
            label: 'cheapestinference',
            baseUrl: 'https://api.cheapestinference.com/anthropic',
            apiKey: 'sk-e2e-fake-key-12349999',
            createdAt: '2026-08-20T00:00:00.000Z',
          },
        ],
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  )
  const workDir = join(dataDir, 'claude-accounts', 'work')
  mkdirSync(workDir, { recursive: true })
  writeFileSync(join(workDir, STUB_AUTH_STATUS), JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'work@e2e.test', subscriptionType: 'pro' }))

  const agentsFile = join(dataDir, 'agents.json')
  const parsed = JSON.parse(readFileSync(agentsFile, 'utf8')) as { agents: Array<{ id: string; fallback?: string[] }> }
  const api = parsed.agents.find((a) => a.id === 'api')
  if (api) api.fallback = [E2E_PROVIDER_ID]
  writeFileSync(agentsFile, JSON.stringify(parsed, null, 2) + '\n')
}

// seedGraphSources — what the graph's disk sources read: a fake installed
// plugin (skill + MCP with a secret header) and a ~/.claude.json with a
// project MCP for the seeded agent folder. Lives under the harness HOME
// (SILOS_HOME), never the real one.
export const E2E_MCP_SECRET = 'Bearer e2e-secret-0000'
function seedGraphSources(home: string, agentFolder: string): void {
  const plugin = join(home, 'plugin-demo')
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true })
  writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'demo', description: 'Demo plugin', version: '1.0.0' }))
  mkdirSync(join(plugin, 'skills', 'demo-skill'), { recursive: true })
  writeFileSync(join(plugin, 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: A demo skill\n---\n')
  writeFileSync(
    join(plugin, '.mcp.json'),
    JSON.stringify({ mcpServers: { context7: { type: 'http', url: 'https://mcp.context7.example/mcp', headers: { Authorization: E2E_MCP_SECRET } } } }),
  )
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true })
  writeFileSync(
    join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'demo@test': [{ scope: 'user', installPath: plugin, version: '1.0.0' }] } }),
  )
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'demo@test': true } }))
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({ projects: { [agentFolder]: { mcpServers: { railway: { type: 'http', url: 'https://mcp.railway.example' } } } } }),
  )
}

// The retired Board's two views that landed on Home: a 'Watch' agent with two conversations PARKED on something outside
// them — a Monitor and a scheduled wakeup, each an unanswered tool_use, past
// the live window — and two that finished earlier today. Working now says the
// parked ones; the digest's sheet lists the finished ones.
function seedWaiting(root: string, dataDir: string): void {
  const folder = seedFolder('watch')
  const projectDir = join(root, '-tmp-e2e-watch')
  mkdirSync(projectDir, { recursive: true })
  // «earlier today», never yesterday: a run just after midnight keeps them today
  const sinceMidnight = Date.now() - new Date(new Date().setHours(0, 0, 0, 0)).getTime()
  const todayAgo = (min: number): number => Math.min(min * 60_000, Math.max(sinceMidnight - 60_000, 3 * 60_000))
  const sessions: Array<{ id: string; title: string; ageMs: number; tool?: { name: string; input: Record<string, unknown> } }> = [
    { id: 'watch-deploy', title: 'Watch the canary deploy', ageMs: todayAgo(14), tool: { name: 'Monitor', input: { description: 'the canary’s error rate' } } },
    {
      id: 'watch-invoices',
      title: 'Chase the overdue invoices',
      ageMs: todayAgo(38),
      tool: { name: 'ScheduleWakeup', input: { reason: 'tomorrow 09:00, when the bank posts' } },
    },
    { id: 'watch-release', title: 'Release notes for 0.9', ageMs: todayAgo(52) },
    { id: 'watch-flaky', title: 'Quarantine the flaky auth test', ageMs: todayAgo(95) },
  ]
  for (const s of sessions) {
    const at = new Date(Date.now() - s.ageMs).toISOString()
    const lines: unknown[] = [
      { type: 'mode', mode: 'default', sessionId: s.id },
      { type: 'user', cwd: folder, timestamp: at, message: { role: 'user', content: s.title } },
      { type: 'ai-title', aiTitle: s.title, sessionId: s.id },
      s.tool
        ? {
            type: 'assistant',
            cwd: folder,
            timestamp: at,
            message: { role: 'assistant', content: [{ type: 'tool_use', id: `tu-${s.id}`, name: s.tool.name, input: s.tool.input }] },
          }
        : { type: 'assistant', cwd: folder, timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
    ]
    const path = join(projectDir, `${s.id}.jsonl`)
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    const mtime = new Date(Date.now() - s.ageMs)
    utimesSync(path, mtime, mtime)
  }
  const agentsFile = join(dataDir, 'agents.json')
  const parsed = JSON.parse(readFileSync(agentsFile, 'utf8')) as { agents: unknown[] }
  parsed.agents.push({ id: 'watch', name: 'Watch', emoji: '🔭', mission: { text: 'waiting fixture', never: [] }, folder, skills: [], default: true })
  writeFileSync(agentsFile, JSON.stringify(parsed, null, 2) + '\n')
}

// The daily digest band: two digest files in the shape
// server/src/digest.ts writes — yesterday's and today's, both unread, so Home
// sums them into one «Since …» band. Local days, like the job names them.
function seedDigests(dataDir: string): void {
  const day = (ms: number): string => {
    const d = new Date(ms)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const at8 = (ms: number): number => {
    const d = new Date(ms)
    d.setHours(8, 0, 0, 0)
    return d.getTime()
  }
  const today = at8(Date.now())
  const yesterday = today - 86_400_000
  const file = (date: string, from: number, to: number, happened: Record<string, unknown>, waits: Record<string, unknown>, coming: unknown) => ({
    version: 1,
    date,
    hour: '08:00',
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    waits: { blocking: 0, due: 0, routine: 0, oldest: null, ...waits },
    happened: { conversations: [], runs: [], planTasksDone: null, silos: [], ...happened },
    coming,
    planDone: [],
  })
  mkdirSync(join(dataDir, 'digests'), { recursive: true })
  writeFileSync(
    join(dataDir, 'digests', `${day(yesterday)}.json`),
    JSON.stringify(
      file(
        day(yesterday),
        yesterday - 86_400_000,
        yesterday,
        {
          conversations: [{ agentId: 'ux', name: 'UX', count: 4 }],
          runs: [{ agentId: 'ux', name: 'UX', runs: 12, acted: 1, noNews: 11, ok: 0, failed: 0, recovered: 0 }],
        },
        {},
        null,
      ),
    ),
  )
  writeFileSync(
    join(dataDir, 'digests', `${day(today)}.json`),
    JSON.stringify(
      file(
        day(today),
        yesterday,
        today,
        {
          conversations: [
            { agentId: 'ux', name: 'UX', count: 2 },
            { agentId: 'api', name: 'API', count: 3 },
          ],
          runs: [{ agentId: 'ux', name: 'UX', runs: 12, acted: 2, noNews: 9, ok: 0, failed: 0, recovered: 1 }],
          planTasksDone: 2,
        },
        {
          blocking: 1,
          due: 1,
          oldest: {
            at: new Date(yesterday + 10 * 3600_000).toISOString(),
            kind: 'failedRun',
            voice: 'Weekly digest failed — the API rejected the request (400) · UX',
          },
        },
        [],
      ),
    ),
  )
}

// Vault page: a representative keyring (~/.silos/vault.json, the exact
// shape VaultStore.load validates) — every visibility kind, two name
// collisions (global vs one agent; a pair list vs a single) so the page's
// override language shows on real data, and staggered createdAt for the
// age column. Values are FAKE and the server masks them anyway.
function seedVault(dataDir: string, agentFolder: string): void {
  const iso = (daysAgo: number): string => new Date(Date.now() - daysAgo * 24 * 3600_000).toISOString()
  const entries = [
    { id: 'v-stripe', name: 'STRIPE_KEY', value: 'sk_live_fake_e2e_0001', scope: { type: 'agents', agentIds: ['api'] }, createdAt: iso(95) },
    { id: 'v-railway', name: 'RAILWAY_TOKEN', value: 'rw_fake_e2e_0002', scope: { type: 'agents', agentIds: ['api', 'ux'] }, createdAt: iso(40) },
    { id: 'v-notion', name: 'NOTION_KEY', value: 'ntn_fake_e2e_0003', scope: { type: 'global' }, createdAt: iso(400) },
    { id: 'v-db', name: 'DATABASE_URL', value: 'postgres://fake:fake@db/e2e', scope: { type: 'folder', folder: agentFolder }, createdAt: iso(10) },
    // collision 1: a global default shadowed by the api agent's own copy
    { id: 'v-gh-global', name: 'GITHUB_TOKEN', value: 'ghp_fake_e2e_0004', scope: { type: 'global' }, createdAt: iso(200) },
    { id: 'v-gh-api', name: 'GITHUB_TOKEN', value: 'ghp_fake_e2e_0005', scope: { type: 'agents', agentIds: ['api'] }, createdAt: iso(3) },
    // collision 2: inside the agents tier the SHORTEST list wins
    { id: 'v-sentry-pair', name: 'SENTRY_DSN', value: 'https://fake@sentry/e2e-1', scope: { type: 'agents', agentIds: ['api', 'ux'] }, createdAt: iso(60) },
    { id: 'v-sentry-ux', name: 'SENTRY_DSN', value: 'https://fake@sentry/e2e-2', scope: { type: 'agents', agentIds: ['ux'] }, createdAt: iso(1) },
    { id: 'v-openai', name: 'OPENAI_API_KEY', value: 'sk-fake-e2e-0006', scope: { type: 'agents', agentIds: ['ux'] }, createdAt: iso(0) },
    { id: 'v-resend', name: 'RESEND_KEY', value: 're_fake_e2e_0007', scope: { type: 'agents', agentIds: ['ops'] }, createdAt: iso(130) },
  ]
  writeFileSync(join(dataDir, 'vault.json'), JSON.stringify({ entries }, null, 2) + '\n', { mode: 0o600 })
}

// binding-ask.spec.ts: the e2e agent waits on the owner to SIGN an
// entry it sees, proposing the shape its code consumes — on a host this
// install has never signed for; a second ask names an entry that is not in
// the Vault (a broken ask).
export const BINDING_ASK_PLAN = 'ledger-sync'
function seedBindingAsk(dataDir: string, agentFolder: string): void {
  mkdirSync(join(agentFolder, 'plans'), { recursive: true })
  writeFileSync(
    join(agentFolder, 'plans', `${BINDING_ASK_PLAN}.plan.json`),
    JSON.stringify(
      {
        title: 'Ledger sync',
        updatedAt: new Date().toISOString(),
        tasks: [
          {
            id: 't1',
            title: 'Sync the invoices through the ledger MCP',
            owner: 'e2e',
            status: 'blocked',
            dependsOn: [],
            waitingOn: {
              owner: 'owner',
              action: 'sign LEDGER_API_KEY for the MCP endpoint',
              asked: 'Can you sign LEDGER_API_KEY for the MCP endpoint?',
              binding: { entry: 'LEDGER_API_KEY', baseUrl: 'https://mcp.ledgerly.example', inject: { header: 'authorization', format: 'Bearer %s' } },
            },
          },
          {
            id: 't2',
            title: 'Pull the payroll export',
            owner: 'e2e',
            status: 'blocked',
            dependsOn: [],
            waitingOn: {
              owner: 'owner',
              action: 'sign PAYROLL_KEY',
              asked: 'Can you sign PAYROLL_KEY?',
              binding: { entry: 'PAYROLL_KEY', baseUrl: 'https://api.payroll.example' },
            },
          },
        ],
      },
      null,
      2,
    ) + '\n',
  )
  const file = join(dataDir, 'vault.json')
  const cur = JSON.parse(readFileSync(file, 'utf8')) as { entries: unknown[] }
  cur.entries.push({
    id: 'v-ledger',
    name: 'LEDGER_API_KEY',
    value: 'ldg_fake_e2e_0008',
    scope: { type: 'folder', folder: agentFolder },
    createdAt: new Date().toISOString(),
  })
  writeFileSync(file, JSON.stringify(cur, null, 2) + '\n', { mode: 0o600 })
}

// selectors.spec.ts: a SEEDED model catalog — the E2E server boots with
// SILOS_NO_MODEL_CATALOG=1 (never spawns the SDK's CLI) and reads this file
// as its cache. The shape mirrors what a real supportedModels() call
// returned: aliases with resolvedModel, effort by level, fast mode only
// where the SDK declares it.
function seedModelCatalog(dataDir: string): void {
  writeFileSync(
    join(dataDir, 'model-catalog.json'),
    JSON.stringify(
      {
        fetchedAt: '2026-08-20T00:00:00.000Z',
        models: [
          {
            value: 'default',
            resolvedModel: 'claude-opus-5[1m]',
            displayName: 'Default (recommended)',
            description: 'Opus 5 with 1M context',
            supportsEffort: true,
            supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
            supportsFastMode: true,
          },
          {
            value: 'opus[1m]',
            resolvedModel: 'claude-opus-5[1m]',
            displayName: 'Opus (1M context)',
            description: 'Opus 5 with 1M context',
            supportsEffort: true,
            supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
            supportsFastMode: true,
          },
          {
            value: 'sonnet',
            resolvedModel: 'claude-sonnet-5',
            displayName: 'Sonnet',
            description: 'Sonnet 5 · Efficient for routine tasks',
            supportsEffort: true,
            supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
          },
          { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
        ],
      },
      null,
      2,
    ) + '\n',
  )
}

// Auto-resume for interactive chats: a session with a synthetic session
// LIMIT notice (message.model === '<synthetic>', the real marker used by
// the Claude Code harness) PLUS a pending-resumes.json record for that
// conversation — so the banner promises the resume with real data
// (proof-of-life principle), and the screenshots show the reassurance line
// + Cancel + the nudge toward cheapestinference. The 'limited' agent
// carries no provider → runs on the default (Anthropic) → gets nudged
// (it's not on cheapest).
function seedAutoResume(root: string, dataDir: string): void {
  const limitFolder = seedFolder('limit')
  const folderKey = '-tmp-e2e-limit'
  const projectDir = join(root, folderKey)
  mkdirSync(projectDir, { recursive: true })
  const s = [
    { type: 'mode', mode: 'default', sessionId: 'limit1' },
    {
      type: 'user',
      cwd: limitFolder,
      timestamp: '2026-08-21T15:40:00.000Z',
      message: { role: 'user', content: 'ship the quarterly numbers to the board deck' },
    },
    { type: 'ai-title', aiTitle: 'Quarterly board deck', sessionId: 'limit1' },
    {
      type: 'assistant',
      cwd: limitFolder,
      timestamp: '2026-08-21T15:40:05.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'On it — pulling the figures now.' }] },
    },
    // the synthetic limit notice: message.model="<synthetic>" is the real
    // gate the parser checks — it flags the message as synthetic and the UI
    // paints it as a band.
    {
      type: 'assistant',
      cwd: limitFolder,
      timestamp: '2026-08-21T15:40:30.000Z',
      message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 4pm (Europe/Berlin)" }] },
    },
  ]
  writeFileSync(join(projectDir, 'limit1.jsonl'), s.map((l) => JSON.stringify(l)).join('\n') + '\n')

  // durable resume record — resetsAt/resumeAt ~3h in the future so the
  // readable time comes out "today" (under 24h means only the time shows).
  const resetsAt = new Date(Date.now() + 3 * 3600_000).toISOString()
  writeFileSync(
    join(dataDir, 'pending-resumes.json'),
    JSON.stringify(
      {
        pending: {
          [`${folderKey}/limit1`]: {
            agentId: 'limited',
            folder: folderKey,
            sessionId: 'limit1',
            text: 'ship the quarterly numbers to the board deck',
            resetsAt,
            resumeAt: resetsAt,
            createdAt: new Date().toISOString(),
            attempts: 0,
          },
        },
      },
      null,
      2,
    ) + '\n',
  )

  const agentsFile = join(dataDir, 'agents.json')
  const parsed = JSON.parse(readFileSync(agentsFile, 'utf8')) as { agents: unknown[] }
  parsed.agents.push({
    id: 'limited',
    name: 'Limited',
    emoji: '⏳',
    mission: { text: 'rate-limit fixture', never: [] },
    folder: limitFolder,
    skills: [],
    default: true,
  })
  writeFileSync(agentsFile, JSON.stringify(parsed, null, 2) + '\n')
}

// File viewer/editor: a session whose context TOUCHES REAL files on disk
// (Read/Edit/Write with an absolute file_path) — this is what the context
// column's Files block needs for (a) showing a preview + "Show all N"
// (>5 entries) and (b) opening the viewer on a file that genuinely exists.
// The seeded README.md is the one the screenshots open and edit.
function seedContextViewer(root: string, dataDir: string): void {
  const folder = projectMkdtemp('files')
  mkdirSync(join(folder, 'src'), { recursive: true })
  mkdirSync(join(folder, 'docs'), { recursive: true })
  const readme = join(folder, 'README.md')
  writeFileSync(
    readme,
    '# Silos file viewer\n\nThis README is opened by the **file viewer** in the context column.\n\n- Click a file in the *Files* block to open it here.\n- Markdown renders, and can be edited and saved.\n\n```ts\nexport const answer = 42\n```\n',
  )
  const touched = [
    readme,
    join(folder, 'src', 'app.ts'),
    join(folder, 'src', 'util.ts'),
    join(folder, 'src', 'index.ts'),
    join(folder, 'src', 'parser.ts'),
    join(folder, 'docs', 'guide.md'),
    join(folder, 'config.json'),
    join(folder, 'notes.txt'),
  ]
  for (const p of touched) {
    if (!existsSync(p)) writeFileSync(p, `// ${p}\nexport const x = 1\n`)
  }

  const projectDir = join(root, '-tmp-e2e-files')
  mkdirSync(projectDir, { recursive: true })
  const readTurn = (file: string, tool: 'Read' | 'Edit' | 'Write'): unknown => ({
    type: 'assistant',
    cwd: folder,
    timestamp: '2026-08-22T10:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: tool, input: { file_path: file } }] },
  })
  const lines: unknown[] = [
    { type: 'mode', mode: 'default', sessionId: 'files1' },
    { type: 'user', cwd: folder, timestamp: '2026-08-22T10:00:00.000Z', message: { role: 'user', content: 'review the project files and tidy the README' } },
    { type: 'ai-title', aiTitle: 'Review project files', sessionId: 'files1' },
    readTurn(readme, 'Edit'),
    ...touched.slice(1).map((p, i) => readTurn(p, i % 3 === 0 ? 'Write' : 'Read')),
    {
      type: 'assistant',
      cwd: folder,
      timestamp: '2026-08-22T10:05:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Reviewed all files and tidied the README.' }] },
    },
  ]
  writeFileSync(join(projectDir, 'files1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

  const agentsFile = join(dataDir, 'agents.json')
  const parsed = JSON.parse(readFileSync(agentsFile, 'utf8')) as { agents: unknown[] }
  parsed.agents.push({ id: 'files', name: 'Files', emoji: '📄', mission: { text: 'file-viewer fixture', never: [] }, folder, skills: [], default: true })
  writeFileSync(agentsFile, JSON.stringify(parsed, null, 2) + '\n')
}

// Autonomy dossier: the 'autonomy' fixture — an agent WITH a
// responsibility (agents.json), a real standing runmode.json + status.json
// under the harness's agent-state dir (server/src/agent-state.ts:
// AgentStateStore reads <SILOS_DATA_DIR>/agent-state/<id>/*.json directly —
// this seed writes those files by hand, exactly the shape a real agent's
// `responsibility`/`heartbeat` skills would write, no SDK involved), and its
// materialized automation (heartbeat-<id>, mirroring
// server/src/autonomy.ts:Autonomy.assign — same id scheme, same wiring:
// thread 'keep', origin 'agent', projectSettings true). The automation's
// trigger expr (0 */4 * * *) matches the runmode's cadenceMinutes (240) so
// the resident's reconcile() (which runs every tick) never rewrites
// nextRunAt out from under the test — and nextRunAt itself is real-clock
// future (not a fixed 2026 date, unlike this file's other seeds: a fixed
// date would eventually become "due" and the resident WOULD dispatch it,
// which must never happen — see the harness's hard rule at the top of this
// file). One seeded conversation in the agent's own folder for the
// dossier.spec.ts ContextColumn assertion.
export const AUTONOMY_AGENT_ID = 'autonomy'
export const AUTONOMY_RESPONSIBILITY = 'Keep the payment queue healthy and flag it if it backs up.'
export const AUTONOMY_LAST_BEAT_SUMMARY = 'Checked the payment queue depth — nothing needed action.'

function seedAutonomy(root: string, dataDir: string): void {
  const folder = seedFolder('autonomy')
  const projectDir = join(root, '-tmp-e2e-autonomy')
  mkdirSync(projectDir, { recursive: true })

  const s = [
    { type: 'mode', mode: 'default', sessionId: 'autonomy1' },
    { type: 'user', cwd: folder, timestamp: '2026-08-24T09:00:00.000Z', message: { role: 'user', content: 'keep an eye on the payment queue for me' } },
    { type: 'ai-title', aiTitle: 'Payment queue watch', sessionId: 'autonomy1' },
    {
      type: 'assistant',
      cwd: folder,
      timestamp: '2026-08-24T09:00:05.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: "I'll take this on as a standing duty and check in on a cadence." }] },
    },
  ]
  writeFileSync(join(projectDir, 'autonomy1.jsonl'), s.map((l) => JSON.stringify(l)).join('\n') + '\n')

  // agent-state: written directly (no dirFor() call, which mkdir's 0700 —
  // this seed does the same by hand since it never goes through
  // AgentStateStore itself).
  const stateDir = join(dataDir, 'agent-state', AUTONOMY_AGENT_ID)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  writeFileSync(
    join(stateDir, 'runmode.json'),
    JSON.stringify({ kind: 'standing', cadenceMinutes: 240, watch: [], updatedAt: '2026-08-24T09:00:00.000Z' }, null, 2) + '\n',
  )
  writeFileSync(
    join(stateDir, 'status.json'),
    JSON.stringify({ at: '2026-08-24T08:00:00.000Z', outcome: 'acted', summary: AUTONOMY_LAST_BEAT_SUMMARY }, null, 2) + '\n',
  )

  const agentsFile = join(dataDir, 'agents.json')
  const parsedAgents = JSON.parse(readFileSync(agentsFile, 'utf8')) as { agents: unknown[] }
  parsedAgents.agents.push({
    id: AUTONOMY_AGENT_ID,
    name: 'Autonomy',
    emoji: '📟',
    folder,
    skills: [],
    default: true,
    responsibility: AUTONOMY_RESPONSIBILITY,
  })
  writeFileSync(agentsFile, JSON.stringify(parsedAgents, null, 2) + '\n')

  // real-clock future — see the comment above this function for why.
  const nextRunAt = new Date(Date.now() + 3 * 3600_000).toISOString()
  const automationsFile = join(dataDir, 'automations.json')
  const parsedAutomations = JSON.parse(readFileSync(automationsFile, 'utf8')) as { automations: unknown[] }
  parsedAutomations.automations.push({
    id: `heartbeat-${AUTONOMY_AGENT_ID}`,
    name: 'Responsibility — Autonomy',
    agentId: AUTONOMY_AGENT_ID,
    prompt: 'seeded automation',
    trigger: { kind: 'cron', expr: '0 */4 * * *' },
    thread: { mode: 'keep' },
    approval: false,
    keepAlive: false,
    paused: false,
    createdAt: '2026-08-24T00:00:00.000Z',
    origin: 'heartbeat',
    projectSettings: true,
    nextRunAt,
  })
  writeFileSync(automationsFile, JSON.stringify(parsedAutomations, null, 2) + '\n')
}

// Mission fixture: the counterpart to seedAutonomy above, but
// runmode.kind === 'mission' — a single watched keep-thread conversation
// instead of a recurring heartbeat cadence. Same idiom: a real
// responsibility (agents.json), a real runmode.json/status.json under the
// harness's agent-state dir, and the materialized heartbeat-<id>
// automation — except here thread.sessionId points at a REAL seeded
// conversation (mission.spec.ts's "Open the conversation ›" click needs a
// session that actually exists), and a seeded plans/*.plan.json (1 done, 2
// pending — team-plan-reader.ts#planProgressFor reduces this to the 1/3
// InChargeOf/MissionBanner both render).
//
// Two dispatch guards, both required (see the harness's hard rule at the
// top of this file):
//  1. nextRunAt is real-clock future (same as seedAutonomy) — the cron
//     path (resident.ts#fireCronIfDue) never fires.
//  2. the automation's `prompt` is set to EXACTLY what
//     autonomy.ts#missionPrompt(responsibility) computes — reconcile()
//     runs every resident tick and, for a mission runmode whose automation
//     prompt does NOT already match, overwrites thread to a bare
//     {mode:'keep'} (dropping sessionId!) and sets nextRunAt to "now",
//     which would both break this fixture's session link AND immediately
//     make it due. Matching the prompt exactly makes reconcile's mission
//     branch a no-op, same as a real agent's already-running mission.
//  3. the seeded session ends on a 'user' turn (never a closing assistant
//     reply) so session-index.ts's turnOpen stays true — resident.ts's
//     mission watchdog (evaluateMissionWatchdog) only nudges an IDLE
//     mission (turnOpen false + no pending question + past the min
//     interval); an open turn reads as "still working" and is skipped,
//     the same honest signal a real in-flight mission gives it.
export const MISSION_AGENT_ID = 'mission'
export const MISSION_RESPONSIBILITY = 'Migrate the payment queue to the new broker and see the cutover through.'
export const MISSION_SESSION_ID = 'mission1'

function missionPromptFor(responsibility: string): string {
  // Mirrors autonomy.ts#missionPrompt exactly — see the guard #2 comment
  // above for why this can't drift from the real function.
  return [
    `Your mission: ${responsibility}.`,
    'Work in this conversation until it is genuinely complete.',
    "Before working, make sure the mission is a task, claimed by this conversation, as your briefing's Duty rule says — and keep it current.",
    'When the mission is complete, write $SILOS_AGENT_STATE/status.json — exactly this shape: {"at": "<ISO timestamp now>", "outcome": "done", "summary": "<one line>"}.',
    "A task that waits on the owner waits as your briefing's Tasks rule says (waitingOn with asked); the question tool only for a decision that is no task's.",
  ].join(' ')
}

function seedMission(root: string, dataDir: string): void {
  const folder = seedFolder('mission')
  const projectDir = join(root, '-tmp-e2e-mission')
  mkdirSync(projectDir, { recursive: true })

  const s = [
    { type: 'mode', mode: 'default', sessionId: MISSION_SESSION_ID },
    {
      type: 'user',
      cwd: folder,
      timestamp: '2026-08-24T09:00:00.000Z',
      message: { role: 'user', content: 'migrate the payment queue to the new broker and see it through' },
    },
    { type: 'ai-title', aiTitle: 'Payment queue migration', sessionId: MISSION_SESSION_ID },
    {
      type: 'assistant',
      cwd: folder,
      timestamp: '2026-08-24T09:00:05.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: "Taking this on as a mission — I'll keep working in this conversation until it's genuinely done." }],
      },
    },
    // ends on a 'user' turn — see guard #3 above.
    { type: 'user', cwd: folder, timestamp: '2026-08-24T09:05:00.000Z', message: { role: 'user', content: 'sounds good, keep going' } },
  ]
  writeFileSync(join(projectDir, `${MISSION_SESSION_ID}.jsonl`), s.map((l) => JSON.stringify(l)).join('\n') + '\n')

  const stateDir = join(dataDir, 'agent-state', MISSION_AGENT_ID)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  writeFileSync(
    join(stateDir, 'runmode.json'),
    // Exactly what a real agent's `responsibility` skill writes — no
    // session id. The mission's conversation has ONE source, the automation
    // thread seeded below (thread.sessionId), which the server derives into
    // AutonomyView.missionSessionId for both UI surfaces that open it
    // (InChargeOf's "Open the conversation ›" and Chat's MissionBanner).
    // Seeding a session id here too would let the specs pass over a field
    // production never populates.
    JSON.stringify(
      {
        kind: 'mission',
        cadenceMinutes: 240,
        watch: [],
        updatedAt: '2026-08-24T09:00:00.000Z',
      },
      null,
      2,
    ) + '\n',
  )
  // outcome 'acted', at OLDER than runmode.updatedAt — never a fresh 'done'
  // (missionIsDone requires outcome === 'done'), so the reconcile
  // done→re-decide branch never triggers regardless of the timestamp order.
  writeFileSync(
    join(stateDir, 'status.json'),
    JSON.stringify({ at: '2026-08-24T08:00:00.000Z', outcome: 'acted', summary: 'Checked in on the migration — still in progress.' }, null, 2) + '\n',
  )

  // 1 done / 2 pending = 1/3, the exact shape InChargeOf's Progress and
  // Chat.tsx's MissionBanner both render.
  mkdirSync(join(folder, 'plans'), { recursive: true })
  writeFileSync(
    join(folder, 'plans', 'payment-queue-migration.plan.json'),
    JSON.stringify(
      {
        title: 'Payment queue migration',
        createdAt: '2026-08-24T09:00:00.000Z',
        tasks: [
          { id: 't1', title: 'Stand up the new broker', owner: MISSION_AGENT_ID, status: 'done', dependsOn: [] },
          { id: 't2', title: 'Cut traffic over', owner: MISSION_AGENT_ID, status: 'pending', dependsOn: ['t1'] },
          { id: 't3', title: 'Decommission the old queue', owner: MISSION_AGENT_ID, status: 'pending', dependsOn: ['t2'] },
        ],
      },
      null,
      2,
    ) + '\n',
  )

  const agentsFile = join(dataDir, 'agents.json')
  const parsedAgents = JSON.parse(readFileSync(agentsFile, 'utf8')) as { agents: unknown[] }
  parsedAgents.agents.push({
    id: MISSION_AGENT_ID,
    name: 'Mission',
    emoji: '🚀',
    mission: { text: 'mission fixture', never: [] },
    folder,
    skills: [],
    default: true,
    responsibility: MISSION_RESPONSIBILITY,
  })
  writeFileSync(agentsFile, JSON.stringify(parsedAgents, null, 2) + '\n')

  // real-clock future — see guard #1 above.
  const nextRunAt = new Date(Date.now() + 3 * 3600_000).toISOString()
  const automationsFile = join(dataDir, 'automations.json')
  const parsedAutomations = JSON.parse(readFileSync(automationsFile, 'utf8')) as { automations: unknown[] }
  parsedAutomations.automations.push({
    id: `heartbeat-${MISSION_AGENT_ID}`,
    name: 'Responsibility — Mission',
    agentId: MISSION_AGENT_ID,
    prompt: missionPromptFor(MISSION_RESPONSIBILITY),
    trigger: { kind: 'cron', expr: '0 */4 * * *' },
    thread: { mode: 'keep', sessionId: MISSION_SESSION_ID },
    approval: false,
    keepAlive: false,
    paused: false,
    createdAt: '2026-08-24T00:00:00.000Z',
    origin: 'heartbeat',
    projectSettings: true,
    nextRunAt,
  })
  writeFileSync(automationsFile, JSON.stringify(parsedAutomations, null, 2) + '\n')
}

// Plans the owner has things in (plans-silo.spec.ts): in the
// E2E agent's folder, a plan with a GATE (the owner's task an agent's task
// depends on) and a routine task; a plan with a DUE date three days out and a
// routine task; a plan nobody moved in 40 days. A conversation of the E2E
// agent wrote the first one (a Write tool call) — its context column's Plan
// block shows it. Dates follow the real clock (the due window is «now + 7d»).
export const PLANS_SESSION_ID = 'plans-s1'
export const PLAN_GATE_TITLE = 'Decide the GitHub org and the homepage'
export const PLAN_ROUTINE_TITLE = 'Review the licence headers'
function seedPlans(root: string, agentFolder: string): void {
  const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  const dir = join(agentFolder, 'plans')
  mkdirSync(dir, { recursive: true })
  const write = (slug: string, plan: Record<string, unknown>): string => {
    const file = join(dir, `${slug}.plan.json`)
    writeFileSync(file, JSON.stringify(plan, null, 2) + '\n')
    return file
  }
  const ship = write('ship-public-repo', {
    title: 'Ship the public repo',
    createdAt: day(-6),
    updatedAt: day(-1),
    tasks: [
      {
        id: 't1',
        title: 'Write the README',
        owner: 'e2e',
        status: 'done',
        dependsOn: [],
        notes: [{ at: `${day(-1)}T10:00:00Z`, by: 'e2e', text: 'Done: README with install, the standard and the screenshots.' }],
      },
      { id: 't2', title: PLAN_GATE_TITLE, owner: 'owner', status: 'pending', dependsOn: ['t1'] },
      { id: 't3', title: 'Fill repository and homepage in package.json', owner: 'e2e', status: 'blocked', dependsOn: ['t2'] },
      { id: 't4', title: PLAN_ROUTINE_TITLE, owner: 'owner', status: 'pending', dependsOn: [] },
      { id: 't5', title: 'Publish the release notes', owner: 'e2e', status: 'pending', dependsOn: ['t3'], conversations: [PLANS_SESSION_ID] },
    ],
  })
  write('close-october', {
    title: "Close October's books",
    createdAt: day(-10),
    updatedAt: day(-3),
    tasks: [
      { id: 'c1', title: "Export October's sales", owner: 'e2e', status: 'done', dependsOn: [] },
      { id: 'c2', title: 'Sign the VAT return', owner: 'owner', status: 'pending', dependsOn: ['c1'], due: day(3) },
      { id: 'c3', title: 'Archive the receipts', owner: 'owner', status: 'pending', dependsOn: [] },
    ],
  })
  write('old-idea', {
    title: 'A landing page in three languages',
    createdAt: day(-50),
    updatedAt: day(-40),
    tasks: [
      { id: 'o1', title: 'Pick the second language', owner: 'owner', status: 'pending', dependsOn: [] },
      // a real teammate: a person who is not the owner — «Sam's», never «you»
      { id: 'o2', title: 'Book the translator', owner: 'sam', status: 'pending', dependsOn: [] },
    ],
  })
  const projectDir = join(root, '-tmp-e2e-plans')
  mkdirSync(projectDir, { recursive: true })
  const at = (m: number): string => new Date(Date.now() - (90 - m) * 60_000).toISOString()
  const s = [
    { type: 'mode', mode: 'default', sessionId: PLANS_SESSION_ID },
    { type: 'user', cwd: agentFolder, timestamp: at(0), message: { role: 'user', content: 'plan shipping the public repo' } },
    { type: 'ai-title', aiTitle: 'Plan: ship the public repo', sessionId: PLANS_SESSION_ID },
    {
      type: 'assistant',
      cwd: agentFolder,
      timestamp: at(1),
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_e2e_plan_write', name: 'Write', input: { file_path: ship, content: '…' } }] },
    },
    {
      type: 'assistant',
      cwd: agentFolder,
      timestamp: at(2),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'The plan is in plans/ship-public-repo.plan.json — the org and the homepage are yours to decide.' }],
      },
    },
  ]
  writeFileSync(join(projectDir, `${PLANS_SESSION_ID}.jsonl`), s.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

// Tasks (tasks.spec.ts): two projects' plans with every
// shape the Tasks view and a task's page must say honestly — subtasks under a
// parent, a LIVE linked conversation (TASKS_LIVE_SESSION, its last line the
// owner's, touched now: the agent's turn is open), a stalled chain whose
// FIRST stuck task is an agent's in-progress task nothing works (l8, owned by
// Web, which never wakes), a blocker that was cancelled (l4 → l5), an agent's
// review nobody holds (l6), the owner's tasks (Mine) — one a gate, «unblocks 1
// task of Web» — and finished work for Done. A second agent, Web, lives in its
// own folder (the project facet has two values).
export const TASKS_LIVE_SESSION = 'tasks-live-1'
export const TASKS_PLAN_SLUG = 'public-launch'
export const TASKS_CLOSED_SESSION = 'tasks-closed-1'
export const TASKS_CLOSED_PLAN = 'beta-invites'
export function touchTasksLive(root: string): void {
  const f = join(root, '-tmp-e2e-tasks', `${TASKS_LIVE_SESSION}.jsonl`)
  utimesSync(f, new Date(), new Date())
}
function seedTasks(root: string, dataDir: string, agentFolder: string): string {
  const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  const ago = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString()
  const webFolder = projectMkdtemp('docs-site')
  mkdirSync(join(webFolder, 'plans'), { recursive: true })
  mkdirSync(join(agentFolder, 'plans'), { recursive: true })
  mkdirSync(join(agentFolder, 'docs'), { recursive: true })
  writeFileSync(join(agentFolder, 'docs', 'launch.md'), '# Launch post\n')
  const agentsFile = join(dataDir, 'agents.json')
  const parsed = JSON.parse(readFileSync(agentsFile, 'utf8')) as { agents: unknown[] }
  parsed.agents.push({
    id: 'web',
    name: 'Web',
    emoji: '🌐',
    mission: { text: 'The public site and its copy', never: [] },
    folder: webFolder,
    skills: [],
    default: true,
  })
  writeFileSync(agentsFile, JSON.stringify(parsed, null, 2) + '\n')
  const plan = join(agentFolder, 'plans', `${TASKS_PLAN_SLUG}.plan.json`)
  writeFileSync(
    plan,
    JSON.stringify(
      {
        title: 'Public launch',
        createdAt: day(-5),
        updatedAt: ago(2),
        tasks: [
          {
            id: 'l1',
            title: 'Write the launch post',
            owner: 'e2e',
            status: 'in_progress',
            dependsOn: [],
            conversations: [TASKS_LIVE_SESSION],
            notes: [
              { at: ago(5), by: 'e2e', text: 'Outline agreed with the owner. Next: a first draft in docs/launch.md.' },
              { at: ago(1), by: 'e2e', text: 'Draft is in docs/launch.md. Next: the screenshots, then the owner proofreads.' },
            ],
          },
          { id: 'l2', title: 'Take the screenshots', owner: 'e2e', status: 'in_progress', dependsOn: [], parent: 'l1', conversations: [TASKS_LIVE_SESSION] },
          { id: 'l3', title: 'Proofread the post', owner: 'owner', status: 'pending', dependsOn: [], parent: 'l1', due: day(2) },
          {
            id: 'l4',
            title: 'Record the demo video',
            owner: 'e2e',
            status: 'cancelled',
            dependsOn: [],
            notes: [{ at: ago(30), by: 'owner', text: 'No video for v1 — screenshots are enough.' }],
          },
          { id: 'l5', title: 'Embed the demo in the README', owner: 'web', status: 'blocked', dependsOn: ['l4'] },
          { id: 'l6', title: 'Review the landing copy', owner: 'web', status: 'in_review', dependsOn: [] },
          { id: 'l7', title: 'Publish on the blog', owner: 'e2e', status: 'blocked', dependsOn: ['l8'] },
          { id: 'l8', title: 'Fix the RSS feed', owner: 'web', status: 'in_progress', dependsOn: [] },
          { id: 'l9', title: 'Announce on social', owner: 'e2e', status: 'blocked', dependsOn: ['l7'] },
          { id: 'l10', title: 'Write the README', owner: 'e2e', status: 'done', dependsOn: [] },
        ],
      },
      null,
      2,
    ) + '\n',
  )
  writeFileSync(
    join(webFolder, 'plans', 'docs-site.plan.json'),
    JSON.stringify(
      {
        title: 'Docs site',
        createdAt: day(-9),
        updatedAt: ago(20),
        tasks: [
          { id: 'd1', title: 'Choose the docs theme', owner: 'owner', status: 'pending', dependsOn: [] },
          { id: 'd2', title: 'Port the guides', owner: 'web', status: 'pending', dependsOn: ['d1'] },
          { id: 'd3', title: 'Set up search', owner: 'web', status: 'done', dependsOn: [], notes: ['Algolia DocSearch, free tier.'] },
        ],
      },
      null,
      2,
    ) + '\n',
  )
  const projectDir = join(root, '-tmp-e2e-tasks')
  mkdirSync(projectDir, { recursive: true })
  const at = (m: number): string => new Date(Date.now() - (60 - m) * 60_000).toISOString()
  const live = [
    { type: 'mode', mode: 'default', sessionId: TASKS_LIVE_SESSION },
    {
      type: 'user',
      cwd: agentFolder,
      timestamp: at(0),
      message: { role: 'user', content: 'write the launch post — the plan is plans/public-launch.plan.json' },
    },
    { type: 'ai-title', aiTitle: 'Launch post draft', sessionId: TASKS_LIVE_SESSION },
    {
      type: 'assistant',
      cwd: agentFolder,
      timestamp: at(1),
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_e2e_tasks_plan', name: 'Write', input: { file_path: plan, content: '…' } }] },
    },
    {
      type: 'user',
      cwd: agentFolder,
      timestamp: at(2),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_e2e_tasks_plan', content: 'ok' }] },
    },
    {
      type: 'assistant',
      cwd: agentFolder,
      timestamp: at(3),
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_e2e_tasks_doc',
            name: 'Write',
            input: { file_path: join(agentFolder, 'docs', 'launch.md'), content: '# Launch post' },
          },
        ],
      },
    },
    {
      type: 'user',
      cwd: agentFolder,
      timestamp: at(4),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_e2e_tasks_doc', content: 'ok' }] },
    },
    { type: 'user', cwd: agentFolder, timestamp: at(59), message: { role: 'user', content: 'now the screenshots' } },
  ]
  writeFileSync(join(projectDir, `${TASKS_LIVE_SESSION}.jsonl`), live.map((l) => JSON.stringify(l)).join('\n') + '\n')
  // a CLOSED plan (team-plan moved it to plans/closed/) whose finished task
  // lists a conversation of its own — the link still resolves, read-only
  // (task-link.spec.ts)
  mkdirSync(join(agentFolder, 'plans', 'closed'), { recursive: true })
  writeFileSync(
    join(agentFolder, 'plans', 'closed', `${TASKS_CLOSED_PLAN}.plan.json`),
    JSON.stringify(
      {
        title: 'Beta invites',
        createdAt: day(-20),
        updatedAt: day(-12),
        tasks: [
          {
            id: 'b1',
            title: 'Send the beta invites',
            owner: 'e2e',
            status: 'done',
            dependsOn: [],
            conversations: [TASKS_CLOSED_SESSION],
            notes: [{ at: ago(300), by: 'e2e', text: '40 invites sent; the list is in docs/beta.csv.' }],
          },
        ],
      },
      null,
      2,
    ) + '\n',
  )
  const closedAt = (m: number): string => new Date(Date.now() - (600 - m) * 60_000).toISOString()
  const closed = [
    { type: 'mode', mode: 'default', sessionId: TASKS_CLOSED_SESSION },
    { type: 'user', cwd: agentFolder, timestamp: closedAt(0), message: { role: 'user', content: 'send the beta invites' } },
    { type: 'ai-title', aiTitle: 'Beta invites wrap-up', sessionId: TASKS_CLOSED_SESSION },
    {
      type: 'assistant',
      cwd: agentFolder,
      timestamp: closedAt(1),
      message: { role: 'assistant', content: [{ type: 'text', text: 'Sent all 40 invites — the plan is closed.' }] },
    },
  ]
  writeFileSync(join(projectDir, `${TASKS_CLOSED_SESSION}.jsonl`), closed.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return webFolder
}

// Task mode (task-mode.spec.ts) over seedTasks: the
// opt-in Task mode silo installed from its REAL reference manifest with ONE
// agent bound (web) — e2e stays in conversation mode; web's l8 already has a
// conversation (the one «Work on this» resumes) and its wake history: a next
// check that woke it, and the owner's note still waiting. d2 has none (a new
// conversation). Everything synthetic, under the harness's temp dirs.
export const TASK_MODE_WEB_SESSION = 'c0ffee00-0000-4000-8000-00000000e8a1'
function seedTaskMode(root: string, dataDir: string, agentFolder: string, webFolder: string): void {
  const silosRoot = join(dataDir, 'silos')
  const dir = join(silosRoot, 'registry', 'task-mode')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'silo.json'), readFileSync(join(REPO_ROOT, 'docs', 'standard', 'reference', 'task-mode.silo.json')))
  const opFile = join(silosRoot, 'operator.json')
  const op = existsSync(opFile) ? (JSON.parse(readFileSync(opFile, 'utf8')) as { silos: Record<string, unknown> }) : { silos: {} }
  op.silos['task-mode'] = { decision: 'approved', producers: [], slotsOff: [], name: 'Task mode', decidedAt: new Date().toISOString() }
  writeFileSync(opFile, JSON.stringify(op, null, 2) + '\n', { mode: 0o600 })
  // who is in task mode is DERIVED: web On its own —
  // its mission and its territory on
  const agentsFile = join(dataDir, 'agents.json')
  const reg = JSON.parse(readFileSync(agentsFile, 'utf8')) as { agents: Array<Record<string, unknown>> }
  for (const a of reg.agents) if (a.id === 'web') a.control = 'own'
  writeFileSync(agentsFile, JSON.stringify(reg, null, 2) + '\n')
  const terrFile = join(dataDir, 'territory.json')
  const terr = existsSync(terrFile) ? (JSON.parse(readFileSync(terrFile, 'utf8')) as { privatePaths?: string[]; enabled?: string[] }) : {}
  writeFileSync(
    terrFile,
    JSON.stringify({ ...(terr.privatePaths ? { privatePaths: terr.privatePaths } : {}), enabled: [...new Set([...(terr.enabled ?? []), 'web'])] }, null, 2) +
      '\n',
    { mode: 0o600 },
  )
  const ago = (m: number): string => new Date(Date.now() - m * 60_000).toISOString()
  // l8 names web's conversation
  const plan = join(agentFolder, 'plans', `${TASKS_PLAN_SLUG}.plan.json`)
  const p = JSON.parse(readFileSync(plan, 'utf8')) as { tasks: Array<Record<string, unknown>> }
  const l8 = p.tasks.find((t) => t.id === 'l8')!
  l8.conversations = [TASK_MODE_WEB_SESSION]
  l8.notes = [
    {
      at: ago(200),
      by: 'web',
      text: 'The feed drops posts with a colon in the title. Next: escape them in the template; I check the validator again at 09:00.',
    },
    { at: ago(12), by: 'owner', text: 'Also keep the old /rss.xml path working — some readers still use it.' },
  ]
  writeFileSync(plan, JSON.stringify(p, null, 2) + '\n')
  const projectDir = join(root, webFolder.replace(/[/.]/g, '-'))
  mkdirSync(projectDir, { recursive: true })
  const lines = [
    {
      type: 'user',
      entrypoint: 'cli',
      sessionId: TASK_MODE_WEB_SESSION,
      cwd: webFolder,
      timestamp: ago(240),
      uuid: 'u1',
      message: { role: 'user', content: 'Fix the RSS feed — public-launch#l8' },
    },
    { type: 'ai-title', aiTitle: 'RSS feed escaping', sessionId: TASK_MODE_WEB_SESSION },
    {
      type: 'assistant',
      sessionId: TASK_MODE_WEB_SESSION,
      cwd: webFolder,
      timestamp: ago(239),
      uuid: 'a1',
      parentUuid: 'u1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Found it: titles with a colon break the feed.' }] },
    },
    // a delivered WAKE turn, closed — what the task feed reads (its briefing
    // first line is the durable marker)
    {
      type: 'user',
      sessionId: TASK_MODE_WEB_SESSION,
      cwd: webFolder,
      timestamp: ago(180),
      uuid: 'u2',
      parentUuid: 'a1',
      message: {
        role: 'user',
        content: `Silos woke you for ONE task — this turn is about ${TASKS_PLAN_SLUG}#l8 «Fix the RSS feed». Don't switch tasks: your other tasks get turns of their own.\nWhy: its next check came.`,
      },
    },
    {
      type: 'assistant',
      sessionId: TASK_MODE_WEB_SESSION,
      cwd: webFolder,
      timestamp: ago(179),
      uuid: 'a2',
      parentUuid: 'u2',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Checking the validator first.' }] },
    },
    {
      type: 'assistant',
      sessionId: TASK_MODE_WEB_SESSION,
      cwd: webFolder,
      timestamp: ago(178),
      uuid: 'a3',
      parentUuid: 'a2',
      message: {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [
          {
            type: 'text',
            text: 'Escaped the colons in the feed template and the validator passes again. The old /rss.xml path keeps serving; I check it once more at the next look.',
          },
        ],
      },
    },
  ]
  writeFileSync(join(projectDir, `${TASK_MODE_WEB_SESSION}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  utimesSync(join(projectDir, `${TASK_MODE_WEB_SESSION}.jsonl`), new Date(Date.now() - 239 * 60_000), new Date(Date.now() - 239 * 60_000))
  const key = `folder:${agentFolder}/${TASKS_PLAN_SLUG}/tasks/l8`
  const tmDir = join(dataDir, 'task-mode')
  mkdirSync(tmDir, { recursive: true, mode: 0o700 })
  writeFileSync(
    join(tmDir, 'state.json'),
    JSON.stringify({
      version: 1,
      seq: 2,
      observations: {},
      throttle: {},
      budget: {},
      wakes: [
        {
          id: 'web~public-launch~l8~next-check~1',
          agent: 'web',
          task: key,
          ref: `${TASKS_PLAN_SLUG}#l8`,
          title: 'Fix the RSS feed',
          reason: 'next-check',
          says: 'its next check came',
          at: ago(180),
          state: 'delivered',
          deliveredAt: ago(180),
          session: TASK_MODE_WEB_SESSION,
          via: 'wake',
          notes: [],
          bypassThrottle: false,
        },
        {
          id: 'web~public-launch~l8~owner-note~2',
          agent: 'web',
          task: key,
          ref: `${TASKS_PLAN_SLUG}#l8`,
          title: 'Fix the RSS feed',
          reason: 'owner-note',
          says: 'a note from the owner',
          at: ago(12),
          state: 'queued',
          held: 'a console has its conversation open — it gets this at its next turn',
          notes: [{ at: ago(12), by: 'owner', text: 'Also keep the old /rss.xml path working — some readers still use it.' }],
          bypassThrottle: true,
        },
      ],
    }),
    { mode: 0o600 },
  )
}

// Hierarchy (hierarchy.spec.ts) over seedTasks + seedTaskMode: four
// more agents (Builder, Finance, Writer, Support), the hierarchy silo installed from
// its REAL reference manifest with a drawn chart (Web → Writer → Builder, E2E → Writer,
// Finance → Builder; Support stands alone), and one task of Web's whose one wake
// changed nothing and whose chain did not move it: blocked waiting on the
// owner with Silos' recovery note, its escalation case at the owner's hop.
export const HIERARCHY_PLAN_SLUG = 'site-ops'
function seedHierarchy(dataDir: string, agentFolder: string): void {
  const ago = (m: number): string => new Date(Date.now() - m * 60_000).toISOString()
  const agentsFile = join(dataDir, 'agents.json')
  const parsed = JSON.parse(readFileSync(agentsFile, 'utf8')) as { agents: unknown[] }
  // one org per project: Web lives in the site folder and declares
  // the e2e project too (a declared folder is membership) — its task and
  // its chain to Writer are in this project
  for (const a of parsed.agents as Array<{ id: string; folders?: string[] }>) if (a.id === 'web') a.folders = [agentFolder]
  parsed.agents.push(
    {
      id: 'builder',
      name: 'Builder',
      emoji: '🧭',
      mission: { text: 'Engineering lead — architecture, reviews, the ops of the stack', never: [] },
      folder: agentFolder,
      skills: [],
    },
    { id: 'writer', name: 'Writer', emoji: '🛠️', mission: { text: 'Builds the product, ships fixes', never: [] }, folder: agentFolder, skills: [] },
    { id: 'finance', name: 'Finance', emoji: '📊', mission: { text: 'Books, invoices and the tax calendar', never: [] }, folder: agentFolder, skills: [] },
    { id: 'support', name: 'Support', emoji: '🛟', mission: { text: 'Answers customers, files what breaks', never: [] }, folder: agentFolder, skills: [] },
  )
  writeFileSync(agentsFile, JSON.stringify(parsed, null, 2) + '\n')
  const silosRoot = join(dataDir, 'silos')
  const dir = join(silosRoot, 'registry', 'hierarchy')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'silo.json'), readFileSync(join(REPO_ROOT, 'docs', 'standard', 'reference', 'hierarchy.silo.json')))
  const opFile = join(silosRoot, 'operator.json')
  const op = existsSync(opFile) ? (JSON.parse(readFileSync(opFile, 'utf8')) as { silos: Record<string, unknown> }) : { silos: {} }
  op.silos.hierarchy = { decision: 'approved', producers: [], slotsOff: [], name: 'Hierarchy', decidedAt: new Date().toISOString() }
  writeFileSync(opFile, JSON.stringify(op, null, 2) + '\n', { mode: 0o600 })
  mkdirSync(join(silosRoot, 'hierarchy'), { recursive: true, mode: 0o700 })
  writeFileSync(
    join(silosRoot, 'hierarchy', 'relations.json'),
    JSON.stringify({ version: 1, relations: { reports_to: { web: 'writer', writer: 'builder', e2e: 'writer', finance: 'builder' } } }, null, 2) + '\n',
    { mode: 0o600 },
  )
  // the escalated task: Web's, in the e2e project's plans
  const action = `unstick ${HIERARCHY_PLAN_SLUG}#o1`
  writeFileSync(
    join(agentFolder, 'plans', `${HIERARCHY_PLAN_SLUG}.plan.json`),
    JSON.stringify(
      {
        title: 'Site operations',
        createdAt: ago(60 * 24 * 4),
        updatedAt: ago(30),
        tasks: [
          {
            id: 'o1',
            title: 'Renew the TLS certificate',
            owner: 'web',
            status: 'blocked',
            dependsOn: [],
            waitingOn: { owner: 'owner', action },
            notes: [
              { at: ago(60 * 52), by: 'builder', text: 'The certificate expires on Friday. Web: renew it with the DNS challenge.' },
              {
                at: ago(60 * 49),
                by: 'silos',
                text: 'stalled: it is in progress and nothing is working it; one wake on Nov 1, 09:12 UTC changed nothing. Silos marks it blocked and asks for help — Web stays its owner.',
              },
            ],
          },
          { id: 'o2', title: 'Rotate the deploy keys', owner: 'writer', status: 'in_progress', dependsOn: [] },
          { id: 'o3', title: 'Reconcile the hosting invoices', owner: 'finance', status: 'pending', dependsOn: [] },
          { id: 'o4', title: 'Answer the uptime question from Acme', owner: 'support', status: 'in_review', dependsOn: [] },
        ],
      },
      null,
      2,
    ) + '\n',
  )
  const key = `folder:${agentFolder}/${HIERARCHY_PLAN_SLUG}/tasks/o1`
  const escDir = join(dataDir, 'escalation')
  mkdirSync(escDir, { recursive: true, mode: 0o700 })
  writeFileSync(
    join(escDir, 'state.json'),
    JSON.stringify({
      version: 1,
      settings: { windowHours: 24 },
      closed: [],
      cases: {
        [`task:${key}`]: {
          id: `task:${key}`,
          kind: 'task',
          key,
          ref: `${HIERARCHY_PLAN_SLUG}#o1`,
          title: 'Renew the TLS certificate',
          who: 'web',
          creator: 'builder',
          cause: 'it is in progress and nothing is working it',
          since: ago(60 * 50),
          wokeAt: ago(60 * 49 + 30),
          folder: agentFolder,
          file: join(agentFolder, 'plans', `${HIERARCHY_PLAN_SLUG}.plan.json`),
          openedAt: ago(60 * 49),
          hops: [
            { to: 'writer', at: ago(60 * 49) },
            { to: 'builder', at: ago(60 * 25) },
            { to: 'owner', at: ago(60) },
          ],
        },
      },
    }),
    { mode: 0o600 },
  )
}

// The Executions silo (executions.spec.ts) over seedTasks:
// three SDD ledgers, all synthetic, under the harness's temp folders —
//   - public-launch#l1's conversation (TASKS_LIVE_SESSION) executes
//     docs/plans/launch-post.md: 3 of 7 done, Task 4 in fix round 1 — the
//     copy Silos saved for that conversation (the conversation edge);
//   - docs-site#d3 names docs/plans/search.md as its source, and a ledger in
//     the docs folder executed it whole (the document edge; .git makes the
//     folder a checkout);
//   - a ledger in the docs folder no task names (without a task).
export const EXECUTIONS_LEDGER_SLUG = 'launch-post'
function seedExecutions(dataDir: string, agentFolder: string, webFolder: string): void {
  // since c373f0a4 the Executions silo is OPTIONAL: seeding its files is not
  // enough — the fixture approves it like seedTaskMode/seedHierarchy do
  const silosRoot = join(dataDir, 'silos')
  const regDir = join(silosRoot, 'registry', 'executions')
  mkdirSync(regDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(regDir, 'silo.json'), readFileSync(join(REPO_ROOT, 'docs', 'standard', 'reference', 'executions.silo.json')))
  const opFile = join(silosRoot, 'operator.json')
  const op = existsSync(opFile) ? (JSON.parse(readFileSync(opFile, 'utf8')) as { silos: Record<string, unknown> }) : { silos: {} }
  op.silos.executions = { decision: 'approved', producers: [], slotsOff: [], name: 'Executions', decidedAt: new Date().toISOString() }
  writeFileSync(opFile, JSON.stringify(op, null, 2) + '\n', { mode: 0o600 })
  const ago = (m: number): number => Date.now() - m * 60_000
  const ledgerAt = (dir: string, text: string, mtime: number): string => {
    mkdirSync(dir, { recursive: true })
    const p = join(dir, 'progress.md')
    writeFileSync(p, text)
    utimesSync(p, new Date(mtime), new Date(mtime))
    return p
  }
  // (1) the launch post, by the live conversation
  mkdirSync(join(agentFolder, 'docs', 'plans'), { recursive: true })
  const titles = [
    "Outline from the owner's notes",
    'First draft',
    'Screenshots of Home and Tasks',
    'Pricing paragraph',
    'Proofreading pass',
    'Social card',
    'Publish checklist',
  ]
  const doc = `# Launch post — plan\n\n${titles.map((t, i) => `### Task ${i + 1}: ${t}\n\nSteps.\n`).join('\n')}`
  writeFileSync(join(agentFolder, 'docs', 'plans', `${EXECUTIONS_LEDGER_SLUG}.md`), doc)
  const ledger = `# SDD ledger — plan: docs/plans/${EXECUTIONS_LEDGER_SLUG}.md\nTask 1: complete (commits 3a1c..9e02, review clean)\nTask 2: complete (draft in docs/launch.md)\nTask 3: complete\nTask 4: fix round 1 (the price must match the site)\n`
  const mtime = ago(14)
  const lp = ledgerAt(join(agentFolder, '.superpowers', 'sdd', EXECUTIONS_LEDGER_SLUG), ledger, mtime)
  const copyDir = join(dataDir, 'executions', '-tmp-e2e-tasks')
  mkdirSync(copyDir, { recursive: true })
  writeFileSync(
    join(copyDir, `${TASKS_LIVE_SESSION}.json`),
    JSON.stringify({
      ledgerPath: lp,
      ledger,
      ledgerMtime: mtime,
      planPath: join(agentFolder, 'docs', 'plans', `${EXECUTIONS_LEDGER_SLUG}.md`),
      plan: doc,
      savedAt: mtime,
    }),
  )
  // (2) the docs search, by document
  mkdirSync(join(webFolder, '.git'), { recursive: true })
  mkdirSync(join(webFolder, 'docs', 'plans'), { recursive: true })
  writeFileSync(
    join(webFolder, 'docs', 'plans', 'search.md'),
    '# Docs search\n\n### Task 1: Index the guides\n### Task 2: Wire DocSearch\n### Task 3: Result ranking\n### Task 4: Keyboard shortcut\n### Task 5: Empty state\n',
  )
  ledgerAt(
    join(webFolder, '.superpowers', 'sdd', 'search'),
    '# SDD ledger — plan: docs/plans/search.md\nTask 1: complete\nTask 2: complete\nTask 3: fix round 1\nTask 3: complete\nTask 4: complete\nTask 5: complete\n',
    ago(60 * 26),
  )
  const planFile = join(webFolder, 'plans', 'docs-site.plan.json')
  const plan = JSON.parse(readFileSync(planFile, 'utf8')) as { tasks: Array<Record<string, unknown>> }
  plan.tasks.find((t) => t.id === 'd3')!.source = 'docs/plans/search.md'
  writeFileSync(planFile, JSON.stringify(plan, null, 2) + '\n')
  // (3) a ledger no task names
  writeFileSync(
    join(webFolder, 'docs', 'plans', 'theme-migration.md'),
    '# Old theme migration\n\n### Task 1: Tokens\n### Task 2: Components\n### Task 3: Dark pass\n',
  )
  ledgerAt(
    join(webFolder, '.superpowers', 'sdd', 'theme-migration'),
    '# SDD ledger — plan: docs/plans/theme-migration.md\nTask 1: complete\nTask 2: complete\nTask 3: fix round 2\n',
    ago(60 * 24 * 6),
  )
}

// A STUB `claude` on the harness PATH (task-mode.spec.ts): «Work on this»
// launches the console's argv for real, so a real claude would run a real
// turn on the machine's account. The stub records its argv (one JSON line
// per launch in SILOS_STUB_CLAUDE_LOG) and writes the transcript a real one
// would (the prompt as the first user line, under SILOS_ROOT) — then idles.
// `--version` answers the Claude Code release the pinned Agent SDK is paired
// with (the compatibility gate's minimum — harnesses/claude-code/version.ts),
// read from the installed SDK so an SDK upgrade never breaks the stub.
// `auth status --json` answers the account's STUB_AUTH_STATUS file (its
// CLAUDE_CONFIG_DIR, or ~/.claude for the machine's), exit 1 when absent.
const STUB_AUTH_STATUS = 'e2e-auth-status.json'
const PAIRED_CLAUDE = (
  JSON.parse(readFileSync(join(REPO_ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')) as { claudeCodeVersion: string }
).claudeCodeVersion
const STUB_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path')
const argv = process.argv.slice(2)
if (argv[0] === '--version') { process.stdout.write('${PAIRED_CLAUDE} (Claude Code)\\n'); process.exit(0) }
if (argv[0] === 'auth' && argv[1] === 'status') {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '/nonexistent', '.claude')
  try { process.stdout.write(fs.readFileSync(path.join(dir, '${STUB_AUTH_STATUS}'), 'utf8')); process.exit(0) } catch { process.stdout.write('{"loggedIn":false}'); process.exit(1) }
}
fs.appendFileSync(process.env.SILOS_STUB_CLAUDE_LOG, JSON.stringify({ argv, cwd: process.cwd() }) + '\\n')
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null }
// the Agent SDK's side (give.spec.ts — a task wake on an agent On its own):
// the stream-json protocol over stdin/stdout, ONE short turn that reads a
// file and answers — its transcript written where a real one would be
if (at('--input-format') === 'stream-json') {
  const id = at('--session-id') || at('--resume') || require('node:crypto').randomUUID()
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
  let buf = ''
  let answered = false
  process.stdin.on('data', (c) => {
    buf += c
    let i
    while ((i = buf.indexOf('\\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      let m; try { m = JSON.parse(line) } catch { continue }
      if (m.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }); continue }
      if (m.type !== 'user' || answered) continue
      answered = true
      const now = new Date().toISOString()
      const dir = path.join(process.env.SILOS_ROOT, process.cwd().replace(/[/.]/g, '-'))
      fs.mkdirSync(dir, { recursive: true })
      const text = typeof m.message?.content === 'string' ? m.message.content : JSON.stringify(m.message?.content ?? '')
      // an agent's first minute (first-run.spec.ts) reads its mission back
      const reply = /Read your mission/.test(text) ? "I'll look after: the books, every month. I won't: pay anything." : 'Reading the brief first.'
      // a heartbeat round (proactive.spec.ts): it creates ONE task of its own
      // from its mission through the API a real one calls — its bearer, its
      // turn — and logs the answer (201, or the 409 of what was undone)
      if (/a round of what your mission covers/.test(text) && process.env.SILOS_API && process.env.SILOS_AGENT_TOKEN) {
        let slug = null
        try { const plans = fs.readdirSync(path.join(process.cwd(), 'plans')).filter((f) => f.endsWith('.plan.json')).sort(); slug = (plans.includes('tasks.plan.json') ? 'tasks.plan.json' : plans[0] || '').replace(/\\.plan\\.json$/, '') || null } catch {}
        const log = (o) => fs.appendFileSync(process.env.SILOS_STUB_CLAUDE_LOG + '.rounds', JSON.stringify(o) + '\\n')
        if (slug) fetch(process.env.SILOS_API + '/api/silos/plans/record/append', {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.SILOS_AGENT_TOKEN },
          body: JSON.stringify({ key: 'folder:' + process.cwd() + '/' + slug, collection: 'tasks', values: { id: 'r' + Date.now().toString(36), title: process.env.SILOS_STUB_ROUND_TITLE || 'Renew the expiring domain', owner: process.env.SILOS_AGENT_ID, status: 'pending', signal: 'mission' }, turn: process.env.SILOS_TURN }),
        }).then(async (r) => log({ status: r.status, body: await r.text() })).catch((e) => log({ error: String(e) }))
        else log({ error: 'no plan in ' + process.cwd() })
      }
      fs.appendFileSync(path.join(dir, id + '.jsonl'), [
        { type: 'user', entrypoint: 'sdk-ts', sessionId: id, cwd: process.cwd(), timestamp: now, uuid: 'sdk-u-' + Date.now(), message: { role: 'user', content: text } },
        { type: 'assistant', entrypoint: 'sdk-ts', sessionId: id, cwd: process.cwd(), timestamp: now, uuid: 'sdk-a-' + Date.now(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: reply }] } },
      ].map((l) => JSON.stringify(l)).join('\\n') + '\\n')
      out({ type: 'system', subtype: 'init', session_id: id, model: 'claude-stub', permissionMode: 'default', cwd: process.cwd(), tools: [], mcp_servers: [], slash_commands: [] })
      setTimeout(() => {
        out({ type: 'stream_event', session_id: id, event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'Read', input: { file_path: 'README.md' } } } })
        out({ type: 'stream_event', session_id: id, event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: reply } } })
      }, 300)
      // the turn stays open a while — long enough for the live line to show it
      setTimeout(() => {
        out({ type: 'assistant', session_id: id, message: { role: 'assistant', content: [{ type: 'text', text: reply }], usage: { input_tokens: 10, output_tokens: 5 } } })
        out({ type: 'result', subtype: 'success', session_id: id, is_error: false, num_turns: 1, result: reply, total_cost_usd: 0, duration_ms: 1, usage: { input_tokens: 10, output_tokens: 5 } })
        setTimeout(() => process.exit(0), 200)
      }, Number(process.env.SILOS_STUB_TURN_MS || 6000))
    }
  })
  process.stdin.on('end', () => { if (!answered) process.exit(0) })
  return
}
const id = at('--session-id') || at('--resume')
const last = argv[argv.length - 1]
const prompt = last && last !== id && !last.startsWith('-') ? last : null
if (id && prompt && process.env.SILOS_ROOT) {
  const dir = path.join(process.env.SILOS_ROOT, process.cwd().replace(/[/.]/g, '-'))
  fs.mkdirSync(dir, { recursive: true })
  const now = new Date().toISOString()
  fs.appendFileSync(path.join(dir, id + '.jsonl'), [
    { type: 'user', entrypoint: 'cli', sessionId: id, cwd: process.cwd(), timestamp: now, uuid: 'stub-u-' + Date.now(), message: { role: 'user', content: prompt } },
    { type: 'assistant', sessionId: id, cwd: process.cwd(), timestamp: now, uuid: 'stub-a-' + Date.now(), message: { role: 'assistant', content: [{ type: 'text', text: 'Reading the plan first.' }] } },
  ].map((l) => JSON.stringify(l)).join('\\n') + '\\n')
}
process.stdout.write('stub claude — ' + (prompt ? 'briefed' : 'idle') + '\\n')
setInterval(() => {}, 1 << 30)
`

// A manifest the e2e seeds: a silo Silos ships (docs/standard/reference/) or
// one of the server tests' generic fixtures (server/test/fixtures/silos/ —
// invoices, documents: no such silo ships)
function siloManifestFile(id: string): string {
  const shipped = join(REPO_ROOT, 'docs', 'standard', 'reference', `${id}.silo.json`)
  return existsSync(shipped) ? shipped : join(REPO_ROOT, 'server', 'test', 'fixtures', 'silos', `${id}.silo.json`)
}

// The Silo Standard (Task 8): two ACTIVE silos seeded from the generic fixture
// manifests (server/test/fixtures/silos/) so the list/record archetypes render
// against the real kernel — never ~/.silos, everything synthetic. Opt-in per
// spec (silo.spec.ts): an active invoices silo adds pulse terms and needs-you
// rows to Home, which the other specs' expectations must not inherit.
// Measured variety: live states + overdue dues (real-clock, so «due < now»
// holds), one overlay CONFLICT (owner set paid, the sync now says partial),
// two unreadable files with different reasons, folded (paid/refunded)
// records, a USD purchase, and a documents set over the project root.
function seedSilos(dataDir: string, agentFolder: string): void {
  const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  const silosRoot = join(dataDir, 'silos')

  // the manifests, materialized as an approval would (registry/<id>/silo.json)
  for (const id of ['invoices', 'documents']) {
    const dir = join(silosRoot, 'registry', id)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, 'silo.json'), readFileSync(siloManifestFile(id)))
  }
  // the operator's decisions (silos/operator.json — the store Task 11 writes)
  writeFileSync(
    join(silosRoot, 'operator.json'),
    JSON.stringify({ silos: { invoices: { decision: 'approved' }, documents: { decision: 'approved' } } }, null, 2) + '\n',
    { mode: 0o600 },
  )

  // invoices: records in the producing agent's state (agent-state root)
  const inv = join(dataDir, 'agent-state', 'finance', 'silos', 'invoices')
  mkdirSync(inv, { recursive: true, mode: 0o700 })
  const invoice = (id: string, over: Record<string, unknown>): void => {
    writeFileSync(
      join(inv, `${id}.json`),
      JSON.stringify(
        {
          id,
          documentNumber: null,
          contactId: 'c_0000',
          contactName: 'Acme SL',
          description: '',
          date: day(-20),
          due: null,
          dueDerived: false,
          total: { amount: 100, currency: 'EUR' },
          kind: 'sale',
          state: 'open',
          updatedBy: 'agent',
          ...over,
        },
        null,
        2,
      ) + '\n',
    )
  }
  invoice('f-7001', {
    documentNumber: 'F2026-0401',
    contactName: 'Acme SL',
    description: 'Annual plan',
    date: day(-36),
    due: day(-6),
    dueDerived: true,
    total: { amount: 465.51, currency: 'EUR' },
    paymentsPending: { amount: 465.51, currency: 'EUR' },
  })
  invoice('f-7002', {
    documentNumber: 'F2026-0402',
    contactName: 'Borealis GmbH',
    description: 'API integration',
    date: day(-18),
    due: day(12),
    total: { amount: 1200, currency: 'EUR' },
  })
  invoice('f-7003', {
    documentNumber: 'F2026-0403',
    contactName: 'Comet Labs',
    description: 'Q4 support',
    date: day(-32),
    due: day(-2),
    state: 'partial',
    total: { amount: 890, currency: 'EUR' },
    paymentsPending: { amount: 445, currency: 'EUR' },
  })
  invoice('f-7004', {
    contactName: 'Cloud Provider Inc',
    description: 'API credits',
    date: day(-14),
    kind: 'purchase',
    total: { amount: 186.04, currency: 'USD' },
  })
  invoice('f-7005', {
    documentNumber: null,
    contactName: 'Vega Studio',
    description: 'Website redesign',
    date: day(-3),
    state: 'draft',
    total: { amount: 75, currency: 'EUR' },
  })
  invoice('f-7006', {
    documentNumber: 'F2026-0396',
    contactName: 'Acme SL',
    date: day(-60),
    due: day(-30),
    state: 'paid',
    total: { amount: 465.51, currency: 'EUR' },
  })
  invoice('f-7007', {
    documentNumber: 'F2026-0391',
    contactName: 'Borealis GmbH',
    date: day(-75),
    due: day(-45),
    state: 'paid',
    total: { amount: 1200, currency: 'EUR' },
  })
  invoice('f-7008', {
    documentNumber: 'F2026-0387',
    contactName: 'Comet Labs',
    date: day(-90),
    due: day(-60),
    state: 'paid',
    total: { amount: 890, currency: 'EUR' },
  })
  invoice('f-7009', {
    documentNumber: 'R2026-0012',
    contactName: 'Vega Studio',
    date: day(-40),
    kind: 'refund',
    state: 'refunded',
    total: { amount: 75, currency: 'EUR' },
  })
  // the conflict: the owner marked it paid; the sync now says partial
  invoice('f-7011', {
    documentNumber: 'F2026-0405',
    contactName: 'Acme SL',
    description: 'Licenses',
    date: day(-28),
    due: day(-5),
    state: 'partial',
    total: { amount: 320, currency: 'EUR' },
  })
  // two unreadable files, two different reasons (said, never hidden)
  writeFileSync(join(inv, 'broken-1.json'), JSON.stringify({ id: 'broken-1', date: day(-10) }) + '\n')
  writeFileSync(join(inv, 'broken-2.json'), '{ not json\n')

  // the owner's overlay over the sync source (conventions/<conv>/data/):
  // value 'paid' sealed over base 'open'; the file above says 'partial' →
  // the kernel reconciles it into a CONFLICT at boot.
  const conv = join(silosRoot, 'conventions', encodeURIComponent('agent-state:silos/invoices'), 'data')
  mkdirSync(conv, { recursive: true, mode: 0o700 })
  const key = 'agent:finance/f-7011'
  writeFileSync(
    join(conv, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`),
    JSON.stringify({ key, fields: { state: { value: 'paid', base: 'open', at: new Date(Date.now() - 2 * 86_400_000).toISOString(), by: 'owner' } } }, null, 2) +
      '\n',
  )

  // documents: records over the project root (context/documents/)
  const docs = join(agentFolder, 'context', 'documents')
  mkdirSync(docs, { recursive: true })
  const doc = (id: string, over: Record<string, unknown>): void => {
    writeFileSync(
      join(docs, `${id}.json`),
      JSON.stringify(
        {
          id,
          title: id,
          type: 'other',
          issuer: '',
          date: day(-10),
          attachment: `context/documents/${id}.pdf`,
          summary: '',
          state: 'received',
          updatedBy: 'agent',
          ...over,
        },
        null,
        2,
      ) + '\n',
    )
  }
  doc('tax-office-request-2026', {
    title: 'Tax office request — reply',
    type: 'official-request',
    issuer: 'Tax Office',
    date: day(-8),
    due: day(4),
    state: 'action_needed',
    summary: 'Request about the trade registration; reply in draft',
  })
  doc('registration-decision', {
    title: 'Registration — decision',
    type: 'registration',
    issuer: 'Social Security Office',
    date: day(-70),
    state: 'filed',
    summary: 'Decision on the self-employment registration',
  })
  doc('incorporation-deed', { title: 'Deed of incorporation', type: 'deed', issuer: 'Ruiz Notary', date: day(-200), state: 'received' })
  doc('payroll-october', { title: 'Payroll — October', type: 'payroll', issuer: '', date: day(-2), state: 'received' })
  writeFileSync(join(docs, 'tax-office-request-2026.pdf'), 'stub pdf for the attachment link\n')

  // the producing agent exists, so anchors («with finance») resolve to a page
  const agentsFile = join(dataDir, 'agents.json')
  const parsed = JSON.parse(readFileSync(agentsFile, 'utf8')) as { agents: unknown[] }
  parsed.agents.push({
    id: 'finance',
    name: 'Finance',
    emoji: '💶',
    mission: { text: 'Finance and paperwork', never: [] },
    folder: agentFolder,
    skills: [],
    default: true,
  })
  writeFileSync(agentsFile, JSON.stringify(parsed, null, 2) + '\n')
}

// The install dialog: two PENDING submissions, as
// POST /api/silos/submissions would have left them (silos/submissions/<id>.json)
// — never activated by the seed; the owner's click in the spec does that.
//   · helpdesk — the REAL support reference manifest under another id
//     (support itself comes with Silos — built in, installed at boot,
//     silos/native.ts), never installed, its producer role (`support`)
//     bound to no agent: the owner must bind one; no case files on disk, so
//     its preview speaks from the manifest's examples
//   · invoices 0.2.0 — an update of the active silo that asks for the rail
//     (a loosening line), submitted by finance, whose token is off: Install
//     waits on a requirement the dialog says in words
// Opt-in (silo-install.spec.ts) on top of seedSilos.
// the support reference manifest as id `helpdesk`, name Helpdesk — the dialog
// flows exercise a real manifest without touching the built-in Support
function helpdeskManifest(): Record<string, any> {
  const m = JSON.parse(readFileSync(join(REPO_ROOT, 'docs', 'standard', 'reference', 'support.silo.json'), 'utf8')) as Record<string, any>
  m.metadata.id = 'helpdesk'
  m.metadata.name = 'Helpdesk'
  m.metadata.version = '0.2.0' // the fixture's own version, whatever the reference ships
  return m
}

function seedSiloSubmissions(dataDir: string): void {
  const subs = join(dataDir, 'silos', 'submissions')
  mkdirSync(subs, { recursive: true, mode: 0o700 })
  const ref = (id: string): Record<string, any> => JSON.parse(readFileSync(siloManifestFile(id), 'utf8'))
  const at = (hoursAgo: number): string => new Date(Date.now() - hoursAgo * 3_600_000).toISOString()
  writeFileSync(
    join(subs, 'helpdesk.json'),
    JSON.stringify({ id: 'helpdesk', manifest: helpdeskManifest(), submittedBy: 'finance', at: at(2), source: 'body' }, null, 2) + '\n',
    { mode: 0o600 },
  )
  const next = ref('invoices')
  next.metadata.version = '0.2.0'
  next.spec.surfaces.rail = { label: 'Invoices', view: 'invoices' }
  writeFileSync(
    join(subs, 'invoices.json'),
    JSON.stringify({ id: 'invoices', manifest: next, submittedBy: 'finance', at: at(1), source: 'body' }, null, 2) + '\n',
    { mode: 0o600 },
  )
}

// Settings › Silos, on top of seedSilos — the three
// groups the page paints, as the installer would have left them:
//   · invoices — installed and active (seedSilos), bound to finance
//   · documents — UNINSTALLED three days ago: its manifest kept in
//     silos/uninstalled/, the operator entry with the conventions it read, the
//     id reserved; its files (written by seedSilos, i.e. now) count as growth,
//     so Home's growth line shows — the door this round builds
//   · helpdesk — the support reference manifest under a non-native id,
//     sitting in the registry, never approved, with NO submission
// Opt-in (silo-settings.spec.ts).
function seedSiloSettings(dataDir: string): void {
  const silosRoot = join(dataDir, 'silos')
  const uninstalledAt = new Date(Date.now() - 3 * 86_400_000).toISOString()
  const kept = join(silosRoot, 'uninstalled')
  mkdirSync(kept, { recursive: true, mode: 0o700 })
  renameSync(join(silosRoot, 'registry', 'documents', 'silo.json'), join(kept, `documents-${uninstalledAt.replace(/[:.]/g, '-')}.json`))
  rmSync(join(silosRoot, 'registry', 'documents'), { recursive: true, force: true })
  const convention = 'project:context/documents'
  writeFileSync(
    join(silosRoot, 'operator.json'),
    JSON.stringify(
      {
        version: 1,
        silos: {
          invoices: { decision: 'approved', producers: ['finance'], slotsOff: [], decidedAt: uninstalledAt },
          documents: {
            decision: 'uninstalled',
            producers: ['finance'],
            slotsOff: [],
            name: 'Documents',
            decidedAt: uninstalledAt,
            installedAt: uninstalledAt,
            uninstalledAt,
            conventions: [{ source: 'documents', root: 'project', glob: 'context/documents/*.json', convention, dir: encodeURIComponent(convention) }],
          },
        },
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  )
  writeFileSync(join(silosRoot, 'reserved.json'), JSON.stringify({ approved: ['documents', 'invoices'] }) + '\n', { mode: 0o600 })
  const helpdesk = join(silosRoot, 'registry', 'helpdesk')
  mkdirSync(helpdesk, { recursive: true, mode: 0o700 })
  writeFileSync(join(helpdesk, 'silo.json'), JSON.stringify(helpdeskManifest(), null, 2))
}

// Usage (usage.spec.ts): a week of turns of three agents
// — chat, a console still open, task starts (one an owner's gesture),
// heartbeats, their own and the owner's automations, one on an API key that
// prices — each a window in <dataDir>/usage and a transcript under the root;
// plus a conversation no window names (Unattributed) and records older than
// the register (before <date>). Nothing calls the SDK.
function seedUsage(root: string, dataDir: string, agentFolder: string): void {
  const now = Date.now()
  const day0 = new Date(now)
  day0.setHours(0, 0, 0, 0)
  const dayAt = (daysAgo: number, h: number, m = 0): number => {
    const d = new Date(day0)
    d.setDate(d.getDate() - daysAgo)
    d.setHours(h, m, 0, 0)
    return Math.min(d.getTime(), now - 60_000 * (daysAgo === 0 ? 5 : 0))
  }
  const folder = agentFolder.replace(/[/.]/g, '-')
  const dir = join(root, folder)
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dataDir, 'usage'), { recursive: true, mode: 0o700 })
  const d = new Date(now)
  const ledger = join(dataDir, 'usage', `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.jsonl`)
  const lines: string[] = []
  let n = 0
  const transcript = (id: string, title: string, start: number, replies: number, size: number, model = 'claude-haiku-4-5'): number => {
    const rows: unknown[] = [
      { type: 'user', cwd: agentFolder, sessionId: id, timestamp: new Date(start).toISOString(), message: { role: 'user', content: title } },
      { type: 'ai-title', aiTitle: title, sessionId: id },
    ]
    let t = start
    for (let i = 0; i < replies; i++) {
      t += 40_000
      rows.push({
        type: 'assistant',
        cwd: agentFolder,
        sessionId: id,
        timestamp: new Date(t).toISOString(),
        message: {
          id: `msg_${id}_${i}`,
          role: 'assistant',
          model,
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 40 * size, output_tokens: 120 * size, cache_read_input_tokens: 2200 * size, cache_creation_input_tokens: 300 * size },
        },
      })
    }
    writeFileSync(join(dir, `${id}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
    return t
  }
  const turn = (o: {
    cls: string
    agent: string
    daysAgo: number
    h: number
    replies: number
    size: number
    title: string
    kind?: string
    task?: string
    automation?: string
    gesture?: boolean
    priced?: boolean
  }): void => {
    const id = `use-${++n}`
    const start = dayAt(o.daysAgo, o.h, (n * 7) % 50)
    const end = transcript(id, o.title, start, o.replies, o.size)
    lines.push(
      JSON.stringify({
        ev: 'open',
        id,
        at: new Date(start).toISOString(),
        class: o.cls,
        ...(o.kind ? { kind: o.kind } : {}),
        agentId: o.agent,
        session: { folder, id },
        ...(o.task ? { taskKey: o.task } : {}),
        ...(o.automation ? { automationId: o.automation, runId: `run-${id}` } : {}),
        ...(o.cls === 'run' ? { runOf: 'yours' } : {}),
        ...(o.gesture !== undefined ? { gesture: o.gesture } : {}),
        provider: o.priced ? 'gateway' : 'default',
        ...(o.priced ? {} : { account: 'default' }),
        priced: o.priced === true,
      }),
    )
    if (!(o.cls === 'console' && o.daysAgo === 0))
      lines.push(
        JSON.stringify({ ev: 'close', id, at: new Date(end + 5_000).toISOString(), outcome: o.cls === 'wake' && o.daysAgo === 2 ? 'timeout' : 'done' }),
      )
  }
  // older than the register: «before <date>»
  transcript('use-before', 'Sketch the onboarding flow', dayAt(6, 9), 6, 3)
  for (let ago = 5; ago >= 0; ago--) {
    const w = 1 + ((ago * 3) % 4)
    turn({ cls: 'chat', agent: 'ux', daysAgo: ago, h: 9, replies: 3 + w, size: 4, title: 'Tighten the settings layout' })
    turn({ cls: 'wake', agent: 'ux', daysAgo: ago, h: 11, replies: 4 + w, size: 5, title: 'Fix the dark-mode contrast', task: 'plan:web/tasks/t3' })
    turn({
      cls: 'wake',
      agent: 'api',
      daysAgo: ago,
      h: 13,
      replies: 2 + w,
      size: 6,
      title: 'Rotate the API keys',
      task: 'plan:api/tasks/t7',
      ...(ago === 1 ? { gesture: true } : { gesture: false }),
    })
    turn({
      cls: 'heartbeat',
      kind: ago % 3 === 0 ? 'think' : 'look',
      agent: 'ux',
      daysAgo: ago,
      h: 8,
      replies: 1 + (ago % 2),
      size: 2,
      title: 'Heartbeat',
      automation: 'heartbeat-ux',
    })
    turn({ cls: 'run', agent: 'ux', daysAgo: ago, h: 15, replies: 2, size: 3, title: 'Weekly digest', automation: 'auto-digest' })
    if (ago % 2 === 0)
      turn({ cls: 'run', agent: 'api', daysAgo: ago, h: 16, replies: 3, size: 4, title: 'Morning standup', automation: 'auto-standup', priced: true })
  }
  turn({ cls: 'console', agent: 'e2e', daysAgo: 0, h: 7, replies: 9, size: 7, title: 'Refactor the session index' })
  // a conversation run outside Silos today: Unattributed
  transcript('use-outside', 'Quick shell question', dayAt(0, 6), 3, 2)
  writeFileSync(ledger, lines.join('\n') + '\n', { mode: 0o600 })
}

// System's Vitals (system.spec.ts): the sampler's lines as machine-sampler.ts
// writes them — 30 days of disk (one sample a day), the last 7 days of memory
// by the hour with a stretch of hours missing (the server down), and one
// change of control in the fleet's log. Generic sizes, no machine's data.
export const MACHINE_GAP_HOURS = [60, 79] as const // hours ago: no sample between these
export function seedMachine(dataDir: string): void {
  const now = Date.now()
  const G = 1e9
  const lines: Array<{ at: string; disk: unknown; mem: unknown; load: number }> = []
  const disk = (k: number) => {
    const bytes = {
      transcripts: Math.round((8 + k * 0.08) * G),
      trash: Math.round(((k % 7) * 0.4 + 0.5) * G),
      worktrees: Math.round((k < 26 ? 1.2 + Math.floor(k / 5) * 0.3 : 0.6) * G),
      agentState: Math.round(0.4 * G),
      other: Math.round(14 * G),
    }
    const used = Object.values(bytes).reduce((a, b) => a + b, 0)
    return { capBytes: 100 * G, usedBytes: used, bytes }
  }
  // one a day for 30 days, at local NOON of each day (never now − d·24 h: late
  // in the evening that left a day between the daily and the hourly samples
  // empty, and the chart drew 28 or 29 days depending on the hour of the run).
  // The memory week's hourly samples below are later in the file order and
  // land on the same days; the view keeps the last of each day.
  for (let d = 29; d >= 0; d--) {
    const noon = new Date(now)
    noon.setDate(noon.getDate() - d) // calendar days: a DST change in the window never skips one
    noon.setHours(12, 0, 0, 0)
    if (noon.getTime() > now) noon.setTime(now - 60_000)
    if (d < 7) continue // the hourly week below covers these days
    lines.push({ at: noon.toISOString(), disk: disk(29 - d), mem: { usedBytes: 6 * G, totalBytes: 16 * G }, load: 0.8 })
  }
  for (let h = 7 * 24 - 1; h >= 1; h--) {
    if (h <= MACHINE_GAP_HOURS[1] && h >= MACHINE_GAP_HOURS[0]) continue
    const ms = now - h * 3600_000
    const k = 29 - Math.floor(h / 24)
    lines.push({ at: new Date(ms).toISOString(), disk: disk(k), mem: { usedBytes: Math.round((5 + 2 * Math.sin(h / 4)) * G), totalBytes: 16 * G }, load: 1.1 })
  }
  const dir = join(dataDir, 'machine')
  mkdirSync(dir, { recursive: true })
  const byMonth = new Map<string, string[]>()
  for (const l of lines) {
    const m = l.at.slice(0, 7)
    byMonth.set(m, [...(byMonth.get(m) ?? []), JSON.stringify(l)])
  }
  for (const [m, ls] of byMonth) writeFileSync(join(dir, `${m}.jsonl`), ls.join('\n') + '\n')
  // the fleet: changes of control over the quarter, each agent ending where
  // the seed leaves it (only when told) — history, no reconciliation today
  const day = (n: number): string => new Date(now - n * 86_400_000).toISOString()
  const fleet = [
    { at: day(74), kind: 'control', agent: 'api', from: 'told', to: 'own' },
    { at: day(61), kind: 'control', agent: 'ux', from: 'told', to: 'own' },
    { at: day(48), kind: 'control', agent: 'api', from: 'own', to: 'proactive' },
    { at: day(33), kind: 'control', agent: 'e2e', from: 'told', to: 'own' },
    { at: day(19), kind: 'control', agent: 'ux', from: 'own', to: 'proactive' },
    { at: day(9), kind: 'control', agent: 'e2e', from: 'own', to: 'told' },
    { at: day(4), kind: 'control', agent: 'ux', from: 'proactive', to: 'told' },
    { at: day(2), kind: 'control', agent: 'api', from: 'proactive', to: 'told' },
  ]
  mkdirSync(join(dataDir, 'fleet'), { recursive: true })
  writeFileSync(join(dataDir, 'fleet', 'control.jsonl'), fleet.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

export interface E2EServer {
  url: string
  token: string
  root: string
  dataDir: string
  home: string
  stop(): Promise<void>
}

// Remote sign-in: opts.serverEnv seeds <dataDir>/server.env BEFORE spawning
// (the server reads it on boot — e.g. the Silos ID settings). Absent by
// default — every existing spec runs with login disabled, exactly the usual
// path. A spec that turns Silos ID on points it at a LOOPBACK broker that is
// not there: the boot's registration fails at once, nothing leaves the
// machine, and the login button is never clicked.
let exitCleanupArmed = false

// Every `silos-e2e-<pid>` socket in /tmp/tmux-$UID belongs to a playwright
// worker; if that pid is gone, so is anyone who could ever clean it up.
// kill-server takes the real claudes with it (tmux is their parent).
//
// Two passes, because socket FILES are not enough: the old
// stop() raced rmSync against an async kill-server, and once the file lost
// the race the orphaned tmux server — and its claudes — became invisible
// to a file-based sweep forever (92 of them piled up over Aug 26–29). The
// second pass reads PROCESSES: anything whose argv says -L silos-e2e-<pid>
// for a dead worker gets SIGTERM (sweep-rules.ts holds the pure decision).
export function sweepStaleE2ETmux(): number {
  const dir = join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid?.() ?? 0}`)
  let swept = 0
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    names = []
  }
  for (const name of names) {
    const m = /^silos-e2e-(\d+)$/.exec(name)
    if (!m) continue
    const pid = Number(m[1])
    if (pid === process.pid || existsSync(`/proc/${pid}`)) continue
    spawnSync('tmux', ['-L', name, 'kill-server'], { stdio: 'ignore' })
    try {
      rmSync(join(dir, name), { force: true })
    } catch {
      /* best effort */
    }
    swept++
  }
  let procs: string[] = []
  try {
    procs = readdirSync('/proc').filter((d) => /^\d+$/.test(d))
  } catch {
    procs = []
  }
  for (const d of procs) {
    let cmdline = ''
    try {
      cmdline = readFileSync(`/proc/${d}/cmdline`, 'utf8')
    } catch {
      continue
    }
    const worker = e2eWorkerOf(cmdline)
    if (worker === null || worker === process.pid || existsSync(`/proc/${worker}`)) continue
    try {
      process.kill(Number(d), 'SIGTERM')
    } catch {
      /* already gone */
    }
    swept++
  }
  return swept
}

export async function startServer(opts?: {
  serverEnv?: string
  silos?: boolean
  siloSubmissions?: boolean
  siloSettings?: boolean
  digests?: boolean
  waiting?: boolean
  proposals?: boolean
  plans?: boolean
  tasks?: boolean
  taskMode?: boolean
  executions?: boolean
  hierarchy?: boolean
  stubClaude?: boolean
  taskWakes?: boolean
  fresh?: boolean
  usage?: boolean
  bindingAsk?: boolean
  machine?: boolean
  readmeDemo?: boolean
}): Promise<E2EServer & { stubLog?: string; home?: string }> {
  const root = registeredMkdtemp(join(tmpdir(), 'deck-e2e-root-'))
  const dataDir = registeredMkdtemp(join(tmpdir(), 'deck-e2e-data-'))
  const home = registeredMkdtemp(join(tmpdir(), 'deck-e2e-home-'))
  if (opts?.serverEnv !== undefined) {
    writeFileSync(join(dataDir, 'server.env'), opts.serverEnv, { mode: 0o600 })
  }
  // opt-in (first-run.spec.ts): a FRESH install — no agent of its own, no
  // session: nothing below is seeded
  const fresh = opts?.fresh === true
  // opt-in (readme-shots.spec.ts): the README's demo house INSTEAD of the
  // fixtures below — no other spec ever sees it
  const demo = opts?.readmeDemo === true
  if (demo) {
    seedReadmeDemo({ root, dataDir, home, project: demoProject, authStatusFile: STUB_AUTH_STATUS })
    seedModelCatalog(dataDir)
  }
  const agentFolder = seedAgentFolder()
  if (!fresh && !demo) seedGraphSources(home, agentFolder)

  if (!fresh && !demo) {
    seedSessions(root, agentFolder)
    seedAgents(dataDir, agentFolder)
    seedRichData(root, dataDir)
    seedChain(root, dataDir)
    seedInterSession(root, dataDir)
    seedMultimedia(root, dataDir)
    seedFacets(root, dataDir)
    seedAutomations(dataDir)
    seedAutonomy(root, dataDir)
    seedMission(root, dataDir)
    seedProviders(dataDir)
    seedVault(dataDir, agentFolder)
    seedModelCatalog(dataDir)
    seedAutoResume(root, dataDir)
    seedContextViewer(root, dataDir)
  }
  // opt-in (silo.spec.ts): an active silo adds pulse/needs-you rows to Home
  if (opts?.silos) seedSilos(dataDir, agentFolder)
  // opt-in (silo-install.spec.ts): pending submissions light Needs you
  if (opts?.siloSubmissions) seedSiloSubmissions(dataDir)
  // opt-in (silo-settings.spec.ts): an uninstalled silo + one pending without a submission
  if (opts?.siloSettings) seedSiloSettings(dataDir)
  // opt-in (digest.spec.ts): two unread daily digests (yesterday + today)
  if (opts?.digests) seedDigests(dataDir)
  // opt-in (home-board-views.spec.ts): parked conversations + finished-today ones
  if (opts?.waiting) seedWaiting(root, dataDir)
  // opt-in (inbox.spec.ts): an agent's pending automation proposal (a command)
  if (opts?.proposals) seedProposals(dataDir, agentFolder)
  // opt-in (plans-silo.spec.ts): plans with the owner's gate, due and routine tasks
  if (opts?.plans) seedPlans(root, agentFolder)
  // opt-in (tasks.spec.ts): plans with subtasks, a stalled chain, a cancelled blocker, a live task
  const webFolder = opts?.tasks || opts?.taskMode ? seedTasks(root, dataDir, agentFolder) : null
  // opt-in (task-mode.spec.ts): the Task mode silo with web bound, over the tasks
  if (opts?.taskMode && webFolder) seedTaskMode(root, dataDir, agentFolder, webFolder)
  // opt-in (hierarchy.spec.ts): the hierarchy silo with a drawn chart and an escalated task
  if (opts?.hierarchy && webFolder) seedHierarchy(dataDir, agentFolder)
  // opt-in (executions.spec.ts): SDD ledgers hung from the tasks, and one hung from none
  if (opts?.executions && webFolder) seedExecutions(dataDir, agentFolder, webFolder)
  // opt-in (usage.spec.ts): a week of turns — windows + transcripts
  if (opts?.usage) seedUsage(root, dataDir, agentFolder)
  // opt-in (binding-ask.spec.ts): an agent's ask to sign a Vault entry, with its proposal
  if (opts?.bindingAsk) seedBindingAsk(dataDir, agentFolder)
  // opt-in (system.spec.ts): the machine sampler's history + the fleet's control log
  if (opts?.machine) seedMachine(dataDir)
  // opt-in: a stub claude on PATH, HOME and TMPDIR isolated (consoles really launch)
  let stubLog: string | undefined
  let stubBin: string | undefined
  if (opts?.stubClaude) {
    stubBin = registeredMkdtemp(join(tmpdir(), 'deck-e2e-bin-'))
    writeFileSync(join(stubBin, 'claude'), STUB_CLAUDE, { mode: 0o755 })
    stubLog = join(dataDir, 'stub-claude.jsonl')
  }

  // an aborted run (timeout, Ctrl-C, a killed worker) never reaches stop()
  // below — its tmux server, and every real `claude` inside it, would sit
  // there forever (373 of them once). Sweep them first, and make sure
  // THIS run's socket dies even on an abrupt exit.
  sweepStaleE2ETmux()
  const tmuxSocket = `silos-e2e-${process.pid}`
  if (!exitCleanupArmed) {
    exitCleanupArmed = true
    process.on('exit', () => {
      spawnSync('tmux', ['-L', tmuxSocket, 'kill-server'], { stdio: 'ignore' })
      try {
        rmSync(join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid?.() ?? 0}`, tmuxSocket), { force: true })
      } catch {
        /* best effort */
      }
    })
  }

  const port = await freePort()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SILOS_ROOT: root,
    SILOS_DATA_DIR: dataDir,
    SILOS_HOME: home,
    // OpenCode's global DB under the fixture home too — an XDG_DATA_HOME in
    // the owner's shell must never point the harness at the real one.
    SILOS_OPENCODE_DATA: join(home, '.local', 'share'),
    // Claude Code's managed settings under the fixture home — never the
    // machine's /etc/claude-code (plugin-enablement.ts)
    SILOS_CLAUDE_MANAGED_DIR: join(home, 'managed-settings'),
    SILOS_PORT: String(port),
    // exists so tests don't step on the served bundle — the spawned server
    // serves web/dist-e2e (the build:e2e above), never the web/dist that
    // serves real usage (see config.ts/defaultConfig).
    SILOS_WEB_DIST: join(REPO_ROOT, 'web', 'dist-e2e'),
    // consoles opened during a test spawn REAL claudes in tmux — isolate
    // them on a per-run socket so they never park on the owner's 'silos'
    // socket (cleaned up in stop() with kill-server).
    SILOS_TMUX_SOCKET: tmuxSocket,
    // this harness's fixture folders live under mkdtempSync(tmpdir()) — the
    // ephemeral-noise rule (server/src/ephemeral.ts) would treat them as
    // internal noise and hide them from the index, leaving the tests with
    // no sessions to open. See resolveEphemeralPrefix(): this turns the
    // rule off ONLY in this spawned process.
    SILOS_NO_EPHEMERAL: '1',
    // auto-titles: the E2E harness NEVER calls the SDK — without this, the
    // resident process's titler sweep (30s tick) would see the fixture
    // sessions (old, with an exchange) as candidates and fire real calls
    // mid-suite (on top of changing titles out from under the tests).
    SILOS_NO_AUTOTITLES: '1',
    // the model catalog comes from the seeded file (seedModelCatalog) —
    // without this, a cold boot with no cache would spawn the SDK's real
    // CLI (same rationale as SILOS_NO_AUTOTITLES).
    SILOS_NO_MODEL_CATALOG: '1',
    // /proc is machine-global — Home's account-load line would read the
    // OWNER's real process table (and real session paths) into committed
    // evidence shots. Off in the harness; the route answers {supported:false}.
    SILOS_NO_ACCOUNT_LOAD: '1',
    // the daily digest job would write today's file into every harness run
    // (and a band on every Home shot) — off; digest.spec.ts seeds its files.
    SILOS_NO_DIGEST: '1',
    // the System silo (silos/processes.ts) never scans this machine's /proc
    // here: a shot never shows the machine's real processes
    SILOS_NO_PROCESS_SCAN: '1',
    // nor runs git over the seeded projects' worktrees (silos/worktrees.ts):
    // nothing is listed — and nothing is ever removed
    SILOS_NO_WORKTREE_SCAN: '1',
    // task mode evaluates and keeps its history here, but never runs a turn
    // (a wake would be a real SDK turn on the machine's account)
    // (give.spec.ts opts in: wakes run, on the stub claude — never the SDK's real one)
    SILOS_NO_TASK_WAKE_DELIVERY: opts?.taskWakes && opts.stubClaude ? '0' : '1',
    // the stub claude: first on PATH, with HOME and TMPDIR inside the harness
    ...(stubBin && stubLog
      ? { PATH: `${stubBin}:${process.env.PATH ?? ''}`, HOME: home, TMPDIR: registeredMkdtemp(join(tmpdir(), 'deck-e2e-tmp-')), SILOS_STUB_CLAUDE_LOG: stubLog }
      : {}),
  }
  // Hard rule: the E2E harness must never touch real ~/.claude/projects or
  // ~/.silos — and, since the graph's disk sources read from
  // SILOS_HOME (config.ts), never the real ~/.claude either. Explicit check
  // right before spawning, not just trusting the code above.
  if (env.SILOS_ROOT !== root || env.SILOS_DATA_DIR !== dataDir || env.SILOS_HOME !== home || !env.SILOS_ROOT || !env.SILOS_DATA_DIR || !env.SILOS_HOME) {
    throw new Error('environment overrides were not set correctly: aborting to avoid touching real data')
  }

  const child = spawn(TSX_BIN, ['server/src/index.ts'], {
    cwd: REPO_ROOT,
    env,
    stdio: 'pipe',
  })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })

  const url = `http://127.0.0.1:${port}`
  try {
    await waitFor200(`${url}/`, 15_000, child)
    await waitForFile(join(dataDir, 'token'), 15_000)
  } catch (err) {
    child.kill('SIGTERM')
    throw err instanceof Error ? new Error(`${err.message}\n--- server stderr ---\n${stderr}`) : err
  }
  const token = readFileSync(join(dataDir, 'token'), 'utf8').trim()
  // The seeded plans are the owner's history: a first watch leaves them
  // `unknown` with a «Keep them all ›» row per folder — the owner's one gesture, done here so the specs see
  // the house as an operator who already blessed it does.
  try {
    const rows =
      ((await (await fetch(`${url}/api/plans/baseline`, { headers: { 'x-token': token } })).json()) as { rows?: Array<{ folder: string }> }).rows ?? []
    for (const r of rows)
      await fetch(`${url}/api/plans/baseline/keep-all`, {
        method: 'POST',
        headers: { 'x-token': token, 'content-type': 'application/json' },
        body: JSON.stringify({ folder: r.folder }),
      })
  } catch {
    /* a server without the ledger: nothing to bless */
  }

  return {
    url,
    token,
    root,
    dataDir,
    home,
    ...(stubLog ? { stubLog } : {}),
    async stop() {
      // the server's tmux consoles outlive the server process (that's the
      // point of tmux) — kill this run's dedicated socket so test claudes
      // never accumulate between runs. AWAITED before touching the socket
      // file: the old fire-and-forget spawn raced the rmSync below, and
      // when the rm won, the kill never connected and the orphans outlived
      // every future sweep.
      await new Promise<void>((resolve) => {
        const k = spawn('tmux', ['-L', `silos-e2e-${process.pid}`, 'kill-server'], { stdio: 'ignore' })
        k.on('exit', () => resolve())
        k.on('error', () => resolve())
        setTimeout(resolve, 3000).unref()
      })
      // kill-server leaves the socket FILE behind in /tmp/tmux-$UID — 160 of
      // them had piled up once. Removing it after the kill keeps /tmp clean.
      try {
        rmSync(join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid?.() ?? 0}`, `silos-e2e-${process.pid}`), { force: true })
      } catch {
        /* best effort */
      }
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve())
        setTimeout(resolve, 5000).unref()
      })
    },
  }
}

// Home is a board of tiles: the Needs you list lives in the
// sheet its tile opens. Opens it and returns the list's region.
export async function openNeedsYou(page: import('@playwright/test').Page): Promise<import('@playwright/test').Locator> {
  const main = page.locator('main')
  const door = main.getByTestId('needs-you-all')
  const region = main.getByRole('region', { name: 'Needs you' })
  // Home's list read: its head's door to the whole list, or its calm words,
  // or only tasks of your own
  await door.or(main.getByTestId('needs-you-empty')).or(main.getByTestId('yours-all')).first().waitFor()
  // nothing holds anyone up: there is no list to open — the (absent)
  // region answers «nothing of that» on its own
  if ((await door.count()) === 0) return region
  await door.click()
  await region.waitFor()
  return region
}
// the «finished today · while you were away» door under the pulse: opens the sheet that holds the band
export async function openDigest(page: import('@playwright/test').Page): Promise<import('@playwright/test').Locator> {
  const main = page.locator('main')
  await main.getByTestId('today-done').click()
  const band = main.getByRole('region', { name: 'Daily digest' })
  await band.waitFor()
  return band
}
