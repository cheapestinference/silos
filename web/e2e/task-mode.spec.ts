// task-mode.spec.ts — Task mode against a REAL seeded server.
// Seeded (helpers seedTasks + seedTaskMode): the opt-in Task mode
// silo installed with ONE agent bound (Web); E2E stays in conversation
// mode. Web's l8 has its conversation and its wakes (a next check that woke
// it, the owner's note still waiting); d2 has no conversation yet.
// A STUB claude sits on PATH (HOME and TMPDIR isolated): the console really
// launches, the stub records its argv and writes the transcript a real one
// would — no real claude, never the SDK (task wakes are off in the harness).
//   binding   the silo page says who is in task mode
//   unbound   an agent in conversation mode: the SAME door, «Wakes when»
//             with a quiet «turn on ›» — no sentence in the way
//   resume    the door on l8 («Open console ›» — Web has a console in the
//             index): --resume its
//             conversation with the briefing,
//             the waiting note folded in, the wake marked delivered
//   new       the door on d2 («Open console ›», no thread yet): a new
//             console born with the briefing, its
//             id written into the task's conversations[] (as a string)
// Evidence screenshots under web/test-results/shots/task-mode/ when SILOS_SHOTS=1.
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { startServer, cleanupTempDirs, TASKS_PLAN_SLUG, TASK_MODE_WEB_SESSION, type E2EServer, shotsDir } from './helpers'

const SHOTS = process.env.SILOS_SHOTS ? shotsDir('task-mode') : null
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

let srv: E2EServer & { stubLog?: string }

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  srv = await startServer({ taskMode: true, stubClaude: true })
})
test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})
test.use({ viewport: { width: 1440, height: 900 } })

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(SHOTS, name), maskColor: '#8f8d86', mask: [page.getByRole('button', { name: 'Settings' }).locator('xpath=..')] })
}
const launches = (): Array<{ argv: string[]; cwd: string }> =>
  srv.stubLog && existsSync(srv.stubLog)
    ? readFileSync(srv.stubLog, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []
const taskUrl = (folder: string, plan: string, id: string): string =>
  `${srv.url}/task/${encodeURIComponent(`folder:${folder}/${plan}`)}/${encodeURIComponent(id)}?token=${srv.token}`

let agentFolder = ''
let webFolder = ''
test.beforeAll(async ({ request }) => {
  const agents = (await (await request.get(`${srv.url}/api/agents?token=${srv.token}`)).json()) as
    { agents?: Array<{ id: string; folder: string | null }> } | Array<{ id: string; folder: string | null }>
  const list = Array.isArray(agents) ? agents : (agents.agents ?? [])
  agentFolder = list.find((a) => a.id === 'e2e')!.folder!
  webFolder = list.find((a) => a.id === 'web')!.folder!
})

test('the Task mode silo says who is in task mode', async ({ page, request }) => {
  const st = await (await request.get(`${srv.url}/api/task-mode?token=${srv.token}`)).json()
  expect(st).toEqual({ silo: 'task-mode', installed: true, active: true, bound: ['web'] })
  await page.goto(`${srv.url}/silo/task-mode?token=${srv.token}`)
  await expect(page.getByTestId('silo-binding')).toContainText('Silos wakes Web on their tasks. The rest wait to be spoken to.')
  await expect(page.getByText('public-launch#l8 · a note from the owner').first()).toBeVisible()
  await shot(page, 'silo-task-mode-light.png')
})

test('an agent in conversation mode: the same one door, and «Moves on its own» says it waits for you', async ({ page }) => {
  await page.goto(taskUrl(agentFolder, TASKS_PLAN_SLUG, 'l7'))
  await expect(page.getByTestId('task-title')).toHaveText('Publish on the blog')
  const door = page.locator('[data-testid="task-door"]:visible')
  // no console of E2E in the index: Open goes to chat, and says so
  await expect(door.getByTestId('task-door-primary')).toHaveText('Open chat ›')
  await expect(door.getByTestId('task-door-other')).toHaveCount(0)
  await expect(page.getByText('Nothing wakes E2E')).toHaveCount(0)
  await expect(page.locator('[data-testid="task-moves-control-told"]:visible')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('task-wake-history')).toHaveCount(0)
  await shot(page, 'task-door-unbound-light.png')
})

test("a bound agent's task: how it wakes, its wakes, and the door CONTINUES its conversation with the briefing", async ({ page }) => {
  await page.goto(taskUrl(agentFolder, TASKS_PLAN_SLUG, 'l8'))
  await expect(page.getByTestId('task-title')).toHaveText('Fix the RSS feed')
  await expect(page.locator('[data-testid="task-moves-control-own"]:visible')).toHaveAttribute('aria-checked', 'true')
  const wakes = page.getByTestId('task-wake-history')
  await expect(wakes.getByTestId('task-wake')).toHaveCount(2)
  await expect(wakes.getByTestId('task-wake').first()).toHaveAttribute('data-state', 'queued')
  // the hold is said ONCE at rest: by the live line; its row in Wakes says «Waiting»
  await expect(page.locator('[data-testid="task-live"][data-state="held"]')).toContainText('a console has its conversation open')
  await expect(wakes).not.toContainText('a console has its conversation open')
  await shot(page, 'task-mode-page-light.png')
  await expect(page.locator('[data-testid="task-door"]:visible').getByTestId('task-door-primary')).toHaveText('Open console ›')
  await page.locator('[data-testid="task-door"]:visible').getByTestId('task-door-primary').click()
  // the console opened on the task's own conversation
  await expect(page).toHaveURL(new RegExp(TASK_MODE_WEB_SESSION))
  await expect.poll(() => launches().length).toBe(1)
  const l = launches()[0]!
  const i = l.argv.indexOf('--resume')
  expect(l.argv[i + 1]).toBe(TASK_MODE_WEB_SESSION)
  const prompt = l.argv[l.argv.length - 1]!
  expect(prompt).toContain(`The owner opened this conversation to work ONE task — ${TASKS_PLAN_SLUG}#l8 «Fix the RSS feed»`)
  expect(prompt).toContain('Also keep the old /rss.xml path working')
  expect(prompt).toContain('Acknowledge the latest note first')
  expect(l.cwd).toBe(webFolder)
  // back on the task: the waiting wake reached it through the console
  await page.goto(taskUrl(agentFolder, TASKS_PLAN_SLUG, 'l8'))
  await expect(page.getByTestId('task-wake-history').getByTestId('task-wake').first()).toHaveAttribute('data-state', 'delivered')
  await expect(page.getByTestId('task-wake-history')).toContainText('Reached Web in your console')
})

test('no conversation yet: the door starts a NEW console with the briefing and writes its id into the task', async ({ page }) => {
  await page.goto(taskUrl(webFolder, 'docs-site', 'd2'))
  await expect(page.getByTestId('task-title')).toHaveText('Port the guides')
  await expect(page.getByTestId('task-wake-history')).toContainText('No wake yet — the next comes when its blockers or subtasks finish')
  await expect(page.locator('[data-testid="task-door"]:visible').getByTestId('task-door-primary')).toHaveText('Open console ›')
  await shot(page, 'task-door-start-light.png')
  await page.locator('[data-testid="task-door"]:visible').getByTestId('task-door-primary').click()
  await expect.poll(() => launches().length).toBe(2)
  const l = launches()[1]!
  const id = l.argv[l.argv.indexOf('--session-id') + 1]!
  expect(l.argv).not.toContain('--resume')
  expect(l.argv[l.argv.length - 1]).toContain('docs-site#d2 «Port the guides»')
  // the stub wrote its first line: the conversation opens
  await expect(page).toHaveURL(new RegExp(id), { timeout: 20_000 })
  const plan = JSON.parse(readFileSync(join(webFolder, 'plans', 'docs-site.plan.json'), 'utf8')) as { tasks: Array<{ id: string; conversations?: unknown[] }> }
  expect(plan.tasks.find((t) => t.id === 'd2')!.conversations).toEqual([id])
  await page.goto(taskUrl(webFolder, 'docs-site', 'd2'))
  await expect(page.getByTestId('task-conversation')).toHaveCount(1)
})

test('evidence: the task page dark and on a phone', async ({ page }) => {
  test.skip(!SHOTS, 'screenshots only')
  await page.addInitScript(() => window.localStorage.setItem('silos-dark', '1'))
  await page.goto(taskUrl(agentFolder, TASKS_PLAN_SLUG, 'l8'))
  await expect(page.getByTestId('task-wake-history')).toBeVisible()
  await shot(page, 'task-mode-page-dark.png')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(taskUrl(agentFolder, TASKS_PLAN_SLUG, 'l8'))
  await expect(page.getByTestId('task-title')).toBeVisible()
  await shot(page, 'task-mode-page-mobile-dark.png')
  await page.addInitScript(() => window.localStorage.setItem('silos-dark', '0'))
  await page.goto(taskUrl(agentFolder, TASKS_PLAN_SLUG, 'l8'))
  await page.getByTestId('task-wake-history').scrollIntoViewIfNeeded()
  await shot(page, 'task-mode-page-mobile-light.png')
})
