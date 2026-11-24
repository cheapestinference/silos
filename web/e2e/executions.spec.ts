// executions.spec.ts — the SDD executions hung from their tasks against a REAL server whose built-in Executions silo reads the
// seeded ledgers (helpers seedExecutions, over seedTasks): l1's conversation
// executes the launch post (3 of 7, Task 4 fixing — the conversation edge),
// d3 names docs/plans/search.md (all 5 done — the document edge), and a
// legacy ledger hangs from no task.
//   page     the task page's Execution section, its line, its door
//   tree     the ▸ SDD leaf under its task
//   without  «1 SDD execution without a task», opened
//   column   the conversation's Executing block reads the same record and
//            names its task («for public-launch#l1 ›»)
// Evidence screenshots (desktop light, dark, phone) under
// web/test-results/shots/task-view-phase5/ when SILOS_SHOTS=1.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { startServer, cleanupTempDirs, touchTasksLive, TASKS_PLAN_SLUG, type E2EServer, shotsDir } from './helpers'

const SHOTS = process.env.SILOS_SHOTS ? shotsDir('task-view-phase5') : null
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

let srv: E2EServer
let agentFolder = ''

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  // stubClaude: opening the conversation may open its console — a stub on PATH, HOME and TMPDIR isolated
  srv = await startServer({ tasks: true, executions: true, stubClaude: true })
  const body = (await (await fetch(`${srv.url}/api/agents?token=${srv.token}`)).json()) as
    { agents?: Array<{ id: string; folder: string }> } | Array<{ id: string; folder: string }>
  const list = Array.isArray(body) ? body : (body.agents ?? [])
  agentFolder = list.find((a) => a.id === 'e2e')!.folder
})
test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})
test.use({ viewport: { width: 1440, height: 900 } })
test.beforeEach(() => touchTasksLive(srv.root))

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(SHOTS, name), maskColor: '#8f8d86', mask: [page.getByRole('button', { name: 'Settings' }).locator('xpath=..')] })
}
const taskUrl = (folder: string, plan: string, id: string): string =>
  `${srv.url}/task/${encodeURIComponent(`folder:${folder}/${plan}`)}/${id}?token=${srv.token}`

test("a task's page shows the execution its conversation ran; the row opens that conversation", async ({ page }) => {
  await page.goto(taskUrl(agentFolder, TASKS_PLAN_SLUG, 'l1'))
  const section = page.getByTestId('task-executions')
  await expect(section).toBeVisible()
  const row = section.getByTestId('task-execution')
  await expect(row).toHaveCount(1)
  await expect(row.getByTestId('task-execution-line')).toContainText(/3 of 7 done · .*Step 4.* — round 1/) // fixing or stopped: the seeded conversation goes quiet as the suite runs
  await expect(row.getByTestId('execution-meter')).toBeVisible()
  await shot(page, 'task-page-execution-light.png')
  await row.getByRole('button').click()
  await expect(page).toHaveURL(/tasks-live-1/)
  // the column's Executing block: the same record, and the door back to the task
  const door = page.getByTestId('execution-task-door')
  await expect(door).toContainText(`${TASKS_PLAN_SLUG}#l1`)
  await expect(page.getByTestId('execution-progress')).toContainText('3 of 7 done')
  await shot(page, 'conversation-executing-door-light.png')
  await door.click()
  await expect(page.getByTestId('task-title')).toHaveText('Write the launch post')
})

test('a task with no execution has no section', async ({ page }) => {
  await page.goto(taskUrl(agentFolder, TASKS_PLAN_SLUG, 'l3'))
  await expect(page.getByTestId('task-title')).toBeVisible()
  await expect(page.getByTestId('task-executions')).toHaveCount(0)
})

test('the tree hangs each execution under its task; the one no task holds is counted, never hidden', async ({ page }) => {
  await page.goto(`${srv.url}/tasks?token=${srv.token}`)
  await page.getByTestId('preset-open').click()
  await page.getByTestId('layout-tree').click()
  const leaves = page.getByTestId('tree-execution')
  await expect(leaves.first()).toContainText('3 of 7 done')
  await shot(page, 'tasks-tree-execution-light.png')
  await page.getByTestId('preset-done').click()
  await expect(page.getByTestId('tree-execution').filter({ hasText: 'all 5 done' })).toHaveCount(1)
  const without = page.getByTestId('tasks-executions-without')
  await expect(without).toContainText('1 SDD execution without a task')
  await without.getByRole('button', { name: 'Show them' }).click()
  await expect(page.getByTestId('execution-without')).toContainText('Old theme migration')
  await page.getByTestId('execution-without').scrollIntoViewIfNeeded()
  await shot(page, 'tasks-executions-without-light.png')
  await page.getByTestId('layout-list').click()
})

test('dark: the task page and the tree', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('silos-dark', '1'))
  await page.goto(taskUrl(agentFolder, TASKS_PLAN_SLUG, 'l1'))
  await expect(page.getByTestId('task-executions')).toBeVisible()
  await shot(page, 'task-page-execution-dark.png')
  await page.goto(`${srv.url}/tasks?token=${srv.token}`)
  await page.getByTestId('preset-open').click()
  await page.getByTestId('layout-tree').click()
  await expect(page.getByTestId('tree-execution').first()).toBeVisible()
  await shot(page, 'tasks-tree-execution-dark.png')
  await page.getByTestId('layout-list').click()
})

test('phone: the execution reads under the properties', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(taskUrl(agentFolder, TASKS_PLAN_SLUG, 'l1'))
  await expect(page.getByTestId('task-executions')).toBeVisible()
  await page.getByTestId('task-executions').scrollIntoViewIfNeeded()
  await shot(page, 'task-page-execution-phone.png')
})
