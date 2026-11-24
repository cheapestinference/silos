// readme-demo.ts — the README's demo house: what a small team's Silos looks
// like on a good morning. Seeded ONLY for readme-shots.spec.ts (startServer
// with `readmeDemo: true` seeds this INSTEAD of the e2e fixtures), so no
// other spec sees any of it. Every record is in the shape the real engine
// and Silos write (transcripts, agents.json, automations + runs, plans, the
// usage ledger, a digest); times are relative to now, so the shots always
// read «minutes ago». Generic names only — no person, no real path.
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface DemoDirs {
  root: string // SILOS_ROOT: the engine's projects/
  dataDir: string // SILOS_DATA_DIR
  home: string // SILOS_HOME (the stub claude's HOME)
  project: (name: string) => string // a temp project folder named `name`
  authStatusFile: string // the file the stub claude answers `auth status` from
}

export const DEMO_CONVERSATION_TITLE = 'Paginate the orders endpoint'
export const DEMO_AGENT_ID = 'ops'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const MODEL = 'claude-opus-5'

const keyOf = (folder: string): string => folder.replace(/[/.]/g, '-')
const jsonl = (rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'

function write(path: string, body: string, mtime?: number): void {
  writeFileSync(path, body)
  if (mtime !== undefined) utimesSync(path, new Date(mtime), new Date(mtime))
}

export function seedReadmeDemo(d: DemoDirs): void {
  const now = Date.now()
  // «today» stays today even on a run just after midnight
  const sinceMidnight = now - new Date(new Date(now).setHours(0, 0, 0, 0)).getTime()
  const today = (ms: number): number => now - Math.min(ms, Math.max(sinceMidnight - MIN, 3 * MIN))

  const storefront = d.project('storefront')
  const backend = d.project('backend')
  const payments = d.project('payments')

  // ── projects: a little real code, a CLAUDE.md, skills Claude Code loads ──
  const files: Array<[string, string, string]> = [
    [storefront, 'CLAUDE.md', '# Storefront\n\nNext.js shop. `npm run dev` on :3000, `npm test` before every push.\n'],
    [storefront, 'src/pages/product.tsx', 'export default function Product() {\n  return null\n}\n'],
    [backend, 'CLAUDE.md', '# Backend\n\nFastify + Postgres. Migrations in `db/migrations`, never edit an applied one.\n'],
    [
      backend,
      'src/routes/orders.ts',
      "import { db } from '../db'\n\nexport async function listOrders(limit = 50, cursor?: string) {\n  return db.order.findMany({ take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), orderBy: { id: 'asc' } })\n}\n",
    ],
    [backend, 'src/db.ts', 'export const db = {} as any\n'],
    [payments, 'CLAUDE.md', '# Payments\n\nCheckout, refunds and payouts. Test mode only outside production.\n'],
    [payments, 'src/refunds.ts', 'export function refund() {}\n'],
  ]
  for (const [dir, rel, body] of files) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  const skill = (dir: string, name: string, description: string): void => {
    mkdirSync(join(dir, '.claude', 'skills', name), { recursive: true })
    writeFileSync(join(dir, '.claude', 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${description}\n`)
  }
  skill(backend, 'deploy', 'Use when shipping the backend: build, migrate, roll out, watch the error rate.')
  skill(backend, 'incident-review', 'Use after an incident: timeline, cause, the fix and what keeps it from coming back.')
  skill(storefront, 'release-notes', 'Use when a release is cut: write the notes from the merged changes.')
  skill(payments, 'refund-policy', 'Use before any refund: the policy, the limits and who signs off.')

  // ── the team ──
  const agents = [
    {
      id: 'web',
      name: 'Web',
      emoji: '🎨',
      mission: { text: 'Builds the storefront and keeps it fast', never: [] },
      folder: storefront,
      skills: [],
      default: true,
    },
    { id: 'qa', name: 'QA', emoji: '🧪', mission: { text: 'Tests every release before it ships', never: [] }, folder: storefront, skills: [] },
    { id: 'api', name: 'API', emoji: '🛠️', mission: { text: 'Backend services and the database', never: [] }, folder: backend, skills: [], default: true },
    {
      id: 'ops',
      name: 'Ops',
      emoji: '🛰️',
      mission: { text: 'Deploys, backups and on-call — production stays up', never: ['deploy without a green suite'] },
      folder: backend,
      skills: [],
      model: 'sonnet',
    },
    {
      id: 'payments',
      name: 'Payments',
      emoji: '💳',
      mission: { text: 'Checkout, refunds and payouts', never: ['move real money without sign-off'] },
      folder: payments,
      skills: [],
      default: true,
    },
  ]
  writeFileSync(join(d.dataDir, 'agents.json'), JSON.stringify({ agents }, null, 2) + '\n')
  const folderOf = new Map(agents.map((a) => [a.id, a.folder]))

  // the machine's Claude account, as the stub claude answers it
  mkdirSync(join(d.home, '.claude'), { recursive: true })
  writeFileSync(
    join(d.home, '.claude', d.authStatusFile),
    JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'team@example.com', subscriptionType: 'max' }),
  )

  // the backend's MCP servers (Claude Code's ~/.claude.json, per project)
  // and the Vault entries Ops reaches — fake values, masked by the server
  writeFileSync(
    join(d.home, '.claude.json'),
    JSON.stringify({
      projects: {
        [backend]: {
          mcpServers: {
            sentry: { type: 'http', url: 'https://mcp.sentry.example/mcp' },
            grafana: { type: 'http', url: 'https://mcp.grafana.example/mcp' },
          },
        },
      },
    }),
  )
  const ago = (days: number): string => new Date(now - days * DAY).toISOString()
  writeFileSync(
    join(d.dataDir, 'vault.json'),
    JSON.stringify(
      {
        entries: [
          { id: 'v-deploy', name: 'DEPLOY_TOKEN', value: 'demo-deploy-0001', scope: { type: 'agents', agentIds: ['ops'] }, createdAt: ago(30) },
          { id: 'v-db', name: 'DATABASE_URL', value: 'postgres://demo:demo@db/app', scope: { type: 'folder', folder: backend }, createdAt: ago(60) },
          { id: 'v-stripe', name: 'STRIPE_TEST_KEY', value: 'demo-stripe-0002', scope: { type: 'agents', agentIds: ['payments'] }, createdAt: ago(45) },
          { id: 'v-sentry', name: 'SENTRY_DSN', value: 'https://demo@sentry.example/1', scope: { type: 'global' }, createdAt: ago(90) },
        ],
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  )

  // Claude Code's auto-memory for the backend: what the agents learned
  const mem = join(d.root, keyOf(backend), 'memory')
  mkdirSync(mem, { recursive: true })
  const note = (name: string, description: string, body: string): void =>
    writeFileSync(join(mem, `${name}.md`), `---\nname: ${name}\ndescription: ${description}\ntype: project\n---\n\n${body}\n`)
  note('deploy-window', 'Production deploys only Tue–Thu before 16:00', 'Deploys happen Tuesday to Thursday, before 16:00, with someone on call.')
  note('backup-restore', 'Restores are tested every Monday on staging', 'The nightly backup is only trusted once a restore of it has run on staging.')
  note('orders-index', 'orders(id) is the pagination key', 'Cursor pagination uses orders.id; created_at has duplicates.')
  writeFileSync(join(mem, 'MEMORY.md'), '- [Deploy window](deploy-window.md)\n- [Backup restores](backup-restore.md)\n- [Orders index](orders-index.md)\n')

  // ── conversations + the usage ledger behind them ──
  const ledger: string[] = []
  // Silos' own launches: native.json names each conversation's agent (two
  // agents share a folder here, so the folder alone can't say whose it is)
  const native: Record<string, { agentId: string; createdAt: string }> = {}
  let n = 0
  const usage = (size: number) => ({
    input_tokens: 30 * size,
    output_tokens: 90 * size,
    cache_read_input_tokens: 2600 * size,
    cache_creation_input_tokens: 240 * size,
  })
  const say = (folder: string, id: string, t: number, text: string, size: number) => ({
    type: 'assistant',
    cwd: folder,
    sessionId: id,
    timestamp: new Date(t).toISOString(),
    message: { id: `msg_${id}_${++n}`, role: 'assistant', model: MODEL, content: [{ type: 'text', text }], usage: usage(size) },
  })
  const record = (o: { id: string; agent: string; start: number; end: number | null; cls: string; automation?: string }): void => {
    const folder = folderOf.get(o.agent)!
    native[`${keyOf(folder)}/${o.id}`] = { agentId: o.agent, createdAt: new Date(o.start).toISOString() }
    ledger.push(
      JSON.stringify({
        ev: 'open',
        id: o.id,
        at: new Date(o.start).toISOString(),
        class: o.cls,
        agentId: o.agent,
        session: { folder: keyOf(folder), id: o.id },
        ...(o.automation ? { automationId: o.automation, runId: `run-${o.id}`, runOf: 'yours' } : {}),
        provider: 'default',
        account: 'default',
        priced: false,
      }),
    )
    if (o.end !== null) ledger.push(JSON.stringify({ ev: 'close', id: o.id, at: new Date(o.end + 5_000).toISOString(), outcome: 'done' }))
  }
  // a plain conversation: the owner's ask, a few replies, the last one a
  // short report — written where the engine writes, its mtime its last line
  const conversation = (o: {
    agent: string
    title: string
    ask: string
    reply: string
    end: number
    replies: number
    size: number
    cls?: string
    automation?: string
  }): string => {
    const folder = folderOf.get(o.agent)!
    const id = `demo-${o.agent}-${++n}`
    const start = o.end - o.replies * 50_000
    const rows: unknown[] = [
      { type: 'user', cwd: folder, sessionId: id, timestamp: new Date(start).toISOString(), message: { role: 'user', content: o.ask } },
      { type: 'ai-title', aiTitle: o.title, sessionId: id },
    ]
    for (let i = 1; i < o.replies; i++) rows.push(say(folder, id, start + i * 50_000, 'Working on it.', o.size))
    rows.push(say(folder, id, o.end, o.reply, o.size))
    const dir = join(d.root, keyOf(folder))
    mkdirSync(dir, { recursive: true })
    write(join(dir, `${id}.jsonl`), jsonl(rows), o.end)
    record({ id, agent: o.agent, start, end: o.end, cls: o.cls ?? 'chat', ...(o.automation ? { automation: o.automation } : {}) })
    return id
  }

  // today
  conversation({
    agent: 'web',
    title: 'Product page image gallery',
    ask: 'The product page gallery jumps when images load — fix the layout shift.',
    reply: 'Reserved the aspect ratio for each image and lazy-loaded the thumbnails. CLS on the product page went from 0.21 to 0.02.',
    end: today(12 * MIN),
    replies: 14,
    size: 22,
  })
  conversation({
    agent: 'web',
    title: 'Cart badge on small screens',
    ask: 'The cart badge overlaps the logo on phones.',
    reply: 'Moved the badge into the icon button and checked it at 360, 390 and 430 px.',
    end: today(2 * HOUR + 10 * MIN),
    replies: 8,
    size: 16,
  })
  conversation({
    agent: 'qa',
    title: 'Regression pass for 2.4',
    ask: 'Run the full regression suite against the 2.4 branch.',
    reply: '412 checks passed, 1 skipped (the gift-card flow is behind a flag). Nothing blocks 2.4.',
    end: today(41 * MIN),
    replies: 10,
    size: 18,
    cls: 'run',
    automation: 'auto-regression',
  })
  conversation({
    agent: 'api',
    title: 'Slow search query',
    ask: 'Search is slow again since Friday — find out why.',
    reply: 'The new filter skipped the trigram index. Rewrote the query; p95 is back to 80 ms.',
    end: today(3 * HOUR + 5 * MIN),
    replies: 12,
    size: 20,
  })
  conversation({
    agent: 'ops',
    title: 'Nightly backup check',
    ask: 'Check last night’s backup and that it restores.',
    reply: 'Backup is 4.2 GB, checksum matches, and a restore on staging finished in 6 minutes.',
    end: today(5 * HOUR),
    replies: 5,
    size: 10,
    cls: 'run',
    automation: 'auto-backups',
  })
  conversation({
    agent: 'ops',
    title: 'Rotate the staging certificates',
    ask: 'The staging certificates expire next week — rotate them.',
    reply: 'Rotated both certificates and reloaded the proxy. They now expire in 90 days.',
    end: today(65 * MIN),
    replies: 7,
    size: 12,
  })
  conversation({
    agent: 'payments',
    title: 'Payout report for November',
    ask: 'Draft the November payout report.',
    reply: 'The report is in reports/payouts-november.md: 38 payouts, none failed.',
    end: today(4 * HOUR),
    replies: 6,
    size: 14,
  })

  // earlier this week
  const earlier: Array<[string, string, number, number]> = [
    ['web', 'Checkout button contrast', 1, 11],
    ['web', 'Lazy-load the reviews', 2, 15],
    ['web', 'Size guide modal', 4, 10],
    ['qa', 'Flaky checkout test', 1, 16],
    ['qa', 'Regression pass for 2.3.2', 3, 9],
    ['api', 'Webhook retries with backoff', 1, 14],
    ['api', 'Index on orders.created_at', 2, 10],
    ['api', 'Rate limits for the public API', 5, 12],
    ['ops', 'Error budget review', 2, 9],
    ['ops', 'Upgrade Postgres to 17', 4, 15],
    ['payments', 'Stripe webhook signatures', 3, 13],
    ['payments', 'Currency rounding in invoices', 6, 10],
  ]
  for (const [agent, title, days, hour] of earlier) {
    const t = new Date(now - days * DAY)
    t.setHours(hour, 20, 0, 0)
    conversation({
      agent,
      title,
      ask: title,
      reply: 'Done — summary in the pull request.',
      end: t.getTime(),
      replies: 8 + (title.length % 9),
      size: 14 + (title.length % 8),
    })
  }

  // the conversation the README opens: real tool calls, a code block
  {
    const folder = backend
    const id = 'demo-api-orders'
    const t0 = today(24 * MIN)
    const at = (s: number): string => new Date(t0 + s * 1000).toISOString()
    const tool = (s: number, tid: string, name: string, input: Record<string, unknown>) => ({
      type: 'assistant',
      cwd: folder,
      sessionId: id,
      timestamp: at(s),
      message: { id: `msg_${tid}`, role: 'assistant', model: MODEL, content: [{ type: 'tool_use', id: tid, name, input }], usage: usage(18) },
    })
    const result = (s: number, tid: string, content: string) => ({
      type: 'user',
      cwd: folder,
      sessionId: id,
      timestamp: at(s),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content }] },
    })
    const routes = join(folder, 'src', 'routes', 'orders.ts')
    const rows: unknown[] = [
      {
        type: 'user',
        cwd: folder,
        sessionId: id,
        timestamp: at(0),
        message: {
          role: 'user',
          content: 'GET /orders returns every order at once and the admin page is crawling. Add cursor pagination — keep the response backwards compatible.',
        },
      },
      { type: 'ai-title', aiTitle: DEMO_CONVERSATION_TITLE, sessionId: id },
      {
        type: 'assistant',
        cwd: folder,
        sessionId: id,
        timestamp: at(4),
        message: {
          id: 'msg_o1',
          role: 'assistant',
          model: MODEL,
          content: [{ type: 'text', text: 'I’ll read how the handler builds its query first.' }],
          usage: usage(18),
        },
      },
      tool(6, 'tu_o1', 'Read', { file_path: routes }),
      result(7, 'tu_o1', 'export async function listOrders() {\n  return db.order.findMany({ orderBy: { createdAt: "desc" } })\n}'),
      tool(10, 'tu_o2', 'Grep', { pattern: 'listOrders', path: join(folder, 'src') }),
      result(11, 'tu_o2', 'src/routes/orders.ts\nsrc/admin/orders-page.ts'),
      tool(20, 'tu_o3', 'Edit', { file_path: routes, old_string: 'findMany({ orderBy', new_string: 'findMany({ take: limit + 1, orderBy' }),
      result(21, 'tu_o3', 'The file has been updated.'),
      tool(30, 'tu_o4', 'Bash', { command: 'npm test -- orders', description: 'Run the orders tests' }),
      result(58, 'tu_o4', ' ✓ test/orders.test.ts (14 tests)\n\n Test Files  1 passed (1)\n      Tests  14 passed (14)'),
      {
        type: 'assistant',
        cwd: folder,
        sessionId: id,
        timestamp: at(64),
        message: {
          id: 'msg_o2',
          role: 'assistant',
          model: MODEL,
          content: [
            {
              type: 'text',
              text: "Done. `/orders` now pages by cursor; callers that send nothing get the first 50, as before:\n\n```ts\n// GET /orders?limit=50&cursor=ord_8f2c\nexport async function listOrders(limit = 50, cursor?: string) {\n  const rows = await db.order.findMany({\n    take: limit + 1,\n    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),\n    orderBy: { id: 'asc' },\n  })\n  const page = rows.slice(0, limit)\n  return { orders: page, nextCursor: rows.length > limit ? page.at(-1)!.id : null }\n}\n```\n\n- The cursor is `orders.id` — `created_at` has duplicates, so it would skip rows.\n- The admin page now loads 50 orders instead of 18,000; first paint went from 4.1 s to 0.3 s.\n- The 14 order tests pass, including two new ones for the last page and an unknown cursor.",
            },
          ],
          usage: usage(26),
        },
      },
    ]
    const dir = join(d.root, keyOf(folder))
    mkdirSync(dir, { recursive: true })
    write(join(dir, `${id}.jsonl`), jsonl(rows), t0 + 64_000)
    record({ id, agent: 'api', start: t0, end: t0 + 64_000, cls: 'chat' })
  }

  // Payments asks a question (an open AskUserQuestion: the turn waits on you)
  {
    const folder = payments
    const id = 'demo-payments-refunds'
    const t0 = today(18 * MIN)
    const rows: unknown[] = [
      {
        type: 'user',
        cwd: folder,
        sessionId: id,
        timestamp: new Date(t0 - 6 * MIN).toISOString(),
        message: { role: 'user', content: 'Add partial refunds for split orders.' },
      },
      { type: 'ai-title', aiTitle: 'Partial refunds for split orders', sessionId: id },
      say(folder, id, t0 - 3 * MIN, 'The refund flow is ready except for one policy call.', 16),
      {
        type: 'assistant',
        cwd: folder,
        sessionId: id,
        timestamp: new Date(t0).toISOString(),
        message: {
          id: 'msg_ask',
          role: 'assistant',
          model: MODEL,
          content: [
            {
              type: 'tool_use',
              id: 'tu_ask',
              name: 'AskUserQuestion',
              input: {
                questions: [
                  {
                    question: 'When part of an order is refunded, should shipping be refunded too?',
                    header: 'Shipping',
                    multiSelect: false,
                    options: [
                      { label: 'Only on a full refund', description: 'Shipping comes back when every item does' },
                      { label: 'Pro rata', description: 'Refund the share of shipping the returned items carried' },
                      { label: 'Never', description: 'Shipping is never refunded' },
                    ],
                  },
                ],
              },
            },
          ],
          usage: usage(16),
        },
      },
    ]
    const dir = join(d.root, keyOf(folder))
    mkdirSync(dir, { recursive: true })
    write(join(dir, `${id}.jsonl`), jsonl(rows), t0)
    record({ id, agent: 'payments', start: t0 - 6 * MIN, end: null, cls: 'console' })
  }

  writeFileSync(join(d.dataDir, 'native.json'), JSON.stringify({ sessions: native }, null, 2) + '\n')
  const month = new Date(now)
  mkdirSync(join(d.dataDir, 'usage'), { recursive: true, mode: 0o700 })
  writeFileSync(join(d.dataDir, 'usage', `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}.jsonl`), ledger.join('\n') + '\n', {
    mode: 0o600,
  })

  // ── automations: three healthy ones, and a deploy that waits for your go ──
  const iso = (t: number): string => new Date(t).toISOString()
  const base = { thread: { mode: 'new' }, keepAlive: false, paused: false, createdAt: iso(now - 40 * DAY) }
  const ok = (t: number, ms: number) => ({ at: iso(t), status: 'ok', durationMs: ms, outcome: 'acted' })
  const automations = [
    {
      ...base,
      id: 'auto-backups',
      name: 'Nightly backup check',
      agentId: 'ops',
      prompt: 'Check last night’s backup and test a restore on staging.',
      trigger: { kind: 'cron', expr: '30 3 * * *' },
      approval: false,
      lastRun: ok(today(5 * HOUR), 312_000),
    },
    {
      ...base,
      id: 'auto-deploy',
      name: 'Deploy to production',
      agentId: 'ops',
      prompt: 'Deploy main to production with the deploy skill, then watch the error rate for 15 minutes.',
      trigger: { kind: 'webhook', secret: 'demo-webhook-secret' },
      approval: true,
      lastRun: ok(now - 2 * DAY, 840_000),
    },
    {
      ...base,
      id: 'auto-regression',
      name: 'Morning regression run',
      agentId: 'qa',
      prompt: 'Run the regression suite against the release branch and report what broke.',
      trigger: { kind: 'cron', expr: '0 7 * * 1-5' },
      approval: false,
      lastRun: ok(today(41 * MIN), 520_000),
    },
    {
      ...base,
      id: 'auto-deps',
      name: 'Weekly dependency audit',
      agentId: 'api',
      prompt: 'Audit the dependencies for advisories and open one pull request with the safe upgrades.',
      trigger: { kind: 'cron', expr: '0 8 * * 1' },
      approval: false,
      lastRun: ok(now - 3 * DAY, 410_000),
    },
  ]
  writeFileSync(join(d.dataDir, 'automations.json'), JSON.stringify({ automations }, null, 2) + '\n')
  mkdirSync(join(d.dataDir, 'runs'), { recursive: true })
  const waitingAt = iso(today(9 * MIN))
  writeFileSync(
    join(d.dataDir, 'runs', 'auto-deploy.jsonl'),
    jsonl([
      {
        id: 'run-deploy-prev',
        automationId: 'auto-deploy',
        at: iso(now - 2 * DAY),
        status: 'ok',
        startedAt: iso(now - 2 * DAY),
        endedAt: iso(now - 2 * DAY + 840_000),
        durationMs: 840_000,
        outcome: 'acted',
        produced: true,
      },
      { id: 'run-deploy-now', automationId: 'auto-deploy', at: waitingAt, status: 'waiting_approval', reason: 'main is green — 2.4 is ready to ship' },
    ]),
  )

  // ── the team's tasks: what is yours, one of them due soon ──
  const day = (offset: number): string => new Date(now + offset * DAY).toISOString().slice(0, 10)
  const plan = (folder: string, title: string, tasks: unknown[]): void => {
    mkdirSync(join(folder, 'plans'), { recursive: true })
    writeFileSync(join(folder, 'plans', 'tasks.plan.json'), JSON.stringify({ title, createdAt: day(-12), updatedAt: day(0), tasks }, null, 2) + '\n')
  }
  plan(storefront, 'Storefront', [
    { id: 't1', title: 'Product page image gallery', owner: 'web', status: 'done', dependsOn: [] },
    { id: 't2', title: 'Pick the launch date for 2.4', owner: 'owner', status: 'pending', dependsOn: [] },
    { id: 't3', title: 'Schedule the 2.4 launch email', owner: 'web', status: 'blocked', dependsOn: ['t2'] },
    { id: 't4', title: 'Sign off the 2.4 release notes', owner: 'owner', status: 'pending', dependsOn: [], due: day(1) },
    { id: 't5', title: 'Regression pass for 2.4', owner: 'qa', status: 'done', dependsOn: [] },
  ])
  plan(payments, 'Payments', [
    { id: 'p1', title: 'Partial refunds for split orders', owner: 'payments', status: 'in_progress', dependsOn: [] },
    { id: 'p2', title: 'Review the new refund policy wording', owner: 'owner', status: 'pending', dependsOn: [] },
  ])

  // ── this morning's digest: what happened overnight, nothing failed ──
  const ymd = (t: number): string => {
    const x = new Date(t)
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
  }
  const at8 = new Date(now)
  at8.setHours(8, 0, 0, 0)
  mkdirSync(join(d.dataDir, 'digests'), { recursive: true })
  writeFileSync(
    join(d.dataDir, 'digests', `${ymd(at8.getTime())}.json`),
    JSON.stringify({
      version: 1,
      date: ymd(at8.getTime()),
      hour: '08:00',
      from: iso(at8.getTime() - DAY),
      to: iso(at8.getTime()),
      waits: { blocking: 0, due: 1, routine: 1, oldest: null },
      happened: {
        conversations: [
          { agentId: 'web', name: 'Web', count: 3 },
          { agentId: 'api', name: 'API', count: 2 },
          { agentId: 'payments', name: 'Payments', count: 1 },
        ],
        runs: [
          { agentId: 'ops', name: 'Ops', runs: 1, acted: 1, noNews: 0, ok: 1, failed: 0, recovered: 0 },
          { agentId: 'qa', name: 'QA', runs: 1, acted: 1, noNews: 0, ok: 1, failed: 0, recovered: 0 },
        ],
        planTasksDone: 2,
        silos: [],
      },
      coming: [],
      planDone: [],
    }),
  )
}
