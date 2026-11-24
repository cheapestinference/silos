// tasks.spec.ts — the Tasks view and a task's page against a REAL server.
// Seeded (helpers seedTasks): two projects' plans with
// subtasks, a live linked conversation, a stalled chain whose first stuck
// task is l8, a cancelled blocker (l4 → l5), an agent's review nobody holds
// (l6) and the owner's tasks, one a gate.
//   switch    the sidebar's «Conversations | Tasks» opens the view; the body
//             becomes the task tree; the choice survives a reload
//   presets   Yours to do · Open · Untouched · Done say the right tasks
//   page      a task's page: its plan, its banner, subtasks, conversations
//   done      Done through the silo's set-field: the task leaves Mine
// Evidence screenshots (desktop light, desktop dark, phone) under
// web/test-results/shots/task-view/ when SILOS_SHOTS=1.
// Serial: the last test changes the server (Done).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { startServer, cleanupTempDirs, openNeedsYou, touchTasksLive, type E2EServer, shotsDir } from './helpers'

const SHOTS = process.env.SILOS_SHOTS ? shotsDir('task-view') : null
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

let srv: E2EServer

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  srv = await startServer({ tasks: true })
})
test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})
test.use({ viewport: { width: 1440, height: 900 } })
test.beforeEach(() => touchTasksLive(srv.root))

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return
  await page.waitForTimeout(250)
  await page.screenshot({ path: join(SHOTS, name), maskColor: '#8f8d86', mask: [page.getByRole('button', { name: 'Settings' }).locator('xpath=..')] })
}
const row = (page: Page, ref: string) => page.locator('main').locator(`[data-task="${ref}"]`)

test('the sidebar switch is the door to Tasks, on Yours; «All tasks» opens Open; the choice is remembered', async ({ page }) => {
  await page.goto(`${srv.url}/?token=${srv.token}`)
  const sw = page.getByTestId('sidebar-list-switch')
  await sw.getByRole('tab', { name: 'Tasks' }).click()
  await expect(page.getByTestId('sidebar-tasks')).toBeVisible()
  // the switch's Tasks opens the page beside it (no rail icon)
  await expect(page).toHaveURL(/\/tasks/)
  await expect(page.getByRole('heading', { name: 'Tasks', level: 1 })).toBeVisible()
  await expect(page.getByTestId('sidebar-tasks').getByText('Write the launch post')).toBeVisible()
  // Yours: exactly the owner's open tasks (an agent's task a
  // conversation of yours touched is not yours)
  await expect(page.getByTestId('preset-mine')).toHaveAttribute('aria-selected', 'true')
  for (const ref of ['public-launch#l3', 'docs-site#d1']) await expect(row(page, ref)).toBeVisible()
  for (const ref of ['public-launch#l1', 'public-launch#l2', 'public-launch#l8']) await expect(row(page, ref)).toHaveCount(0)
  // the live mark and the running-below line live where the agent tasks are
  await page.getByTestId('preset-open').click()
  await expect(row(page, 'public-launch#l1').getByTestId('task-live')).toBeVisible()
  await expect(row(page, 'public-launch#l1')).toContainText('1 running below')
  await expect(page.getByTestId('tasks-without')).toContainText('without a task')
  await shot(page, 'tasks-mine-light.png')
  // «All tasks · N open» opens the set it counts
  await page.getByTestId('sidebar-all-tasks').click()
  await expect(page).toHaveURL(/\/tasks\?view=open$/)
  await expect(page.getByTestId('preset-open')).toHaveAttribute('aria-selected', 'true')
  await page.reload()
  await expect(page.getByTestId('sidebar-tasks')).toBeVisible()
})

test('presets: Open, Untouched with its cause and the first untouched task, Done', async ({ page }) => {
  await page.goto(`${srv.url}/tasks?token=${srv.token}`)
  await page.getByTestId('preset-open').click()
  await expect(row(page, 'public-launch#l8')).toBeVisible()
  await expect(row(page, 'public-launch#l10')).toHaveCount(0)
  await page.getByTestId('preset-untouched').click()
  await expect(row(page, 'public-launch#l5')).toContainText('waits on a dropped task: public-launch#l4 Record the demo video')
  await expect(row(page, 'public-launch#l6')).toContainText('in review — nobody is reviewing it')
  // Untouched lists a stall's SEAT only: a task waiting
  // down a chain (l9 → l7 → l8) is its seat's, never a row of its own here
  await expect(row(page, 'public-launch#l9')).toHaveCount(0)
  await shot(page, 'tasks-stalled-light.png')
  await page.getByTestId('preset-done').click()
  await expect(row(page, 'public-launch#l10')).toBeVisible()
  await expect(row(page, 'public-launch#l4')).toBeVisible()
  // the last preset is remembered
  await page.reload()
  await expect(page.getByTestId('preset-done')).toHaveAttribute('aria-selected', 'true')
  await page.getByTestId('preset-open').click()
  await page.getByTestId('layout-board').click()
  await expect(page.getByTestId('board-col-in_progress')).toContainText('Fix the RSS feed')
  await shot(page, 'tasks-board-light.png')
  await page.getByTestId('layout-tree').click()
  await expect(page.getByTestId('tree-plan').filter({ hasText: 'Docs site' })).toBeVisible()
  await expect(page.getByTestId('tree-plan').filter({ hasText: 'Public launch' })).toBeVisible()
  await shot(page, 'tasks-tree-light.png')
  await page.getByTestId('layout-list').click()
})

test('a task blocked by a dropped one: its page says it never resolves and offers both ways out', async ({ page }) => {
  await page.goto(`${srv.url}/tasks?view=untouched&token=${srv.token}`)
  await row(page, 'public-launch#l5').click()
  const banner = page.locator('[data-testid="task-banner"][data-kind="dropped-blocker"]')
  await expect(banner).toContainText('which was dropped — that never resolves')
  await expect(banner.getByTestId('task-remove-dependency')).toBeVisible()
  await expect(banner.getByTestId('task-reopen-dependency')).toContainText('Reopen public-launch#l4')
  await shot(page, 'task-dropped-blocker-light.png')
})

test('dark: the view and a task page', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('silos-dark', '1'))
  await page.goto(`${srv.url}/tasks?token=${srv.token}`)
  await page.getByTestId('preset-open').click()
  await expect(row(page, 'public-launch#l1')).toBeVisible()
  await shot(page, 'tasks-active-dark.png')
  await row(page, 'public-launch#l1').click()
  await expect(page.getByTestId('task-title')).toHaveText('Write the launch post')
  await shot(page, 'task-page-dark.png')
})

test('a task page: where it came from, its subtasks, its conversations, its notes, its deliverables', async ({ page }) => {
  await page.goto(`${srv.url}/tasks?token=${srv.token}`)
  await page.getByTestId('preset-open').click()
  await row(page, 'public-launch#l1').click()
  await expect(page).toHaveURL(/\/task\//)
  await expect(page.getByTestId('task-title')).toHaveText('Write the launch post')
  // where it lives is the crumb (project › plan); the facts say who wrote it
  await expect(page.getByTestId('task-header').getByRole('navigation', { name: 'Where this lives' })).toContainText('Public launch')
  await expect(page.getByTestId('task-origin')).toContainText('written by E2E')
  await expect(page.getByTestId('task-subtasks')).toContainText('Take the screenshots')
  await expect(page.getByTestId('task-subtasks')).toContainText('Proofread the post')
  await expect(page.getByTestId('task-conversation').first()).toHaveAttribute('data-state', 'working')
  await expect(page.getByTestId('task-activity')).toContainText('Draft is in docs/launch.md')
  await expect(page.getByTestId('task-deliverables')).toContainText('launch.md')
  await shot(page, 'task-page-light.png')
  // a stalled one: the banner names the cause and the first stuck task, a door to it
  await page.goto(`${srv.url}/tasks?token=${srv.token}`)
  await page.getByTestId('preset-open').click()
  await row(page, 'public-launch#l9').click()
  const banner = page.getByTestId('task-banner')
  // l8 is not untouched: its agent opens with you — the banner names the task to start
  await expect(banner).toContainText('The task to start is')
  await shot(page, 'task-page-stalled-light.png')
  await banner.getByRole('button', { name: /Fix the RSS feed/ }).click()
  await expect(page.getByTestId('task-title')).toHaveText('Fix the RSS feed')
})

test("a file is a sheet over the task, Back closes it; the plan crumb is the plan's tasks; Files marks the file", async ({ page }) => {
  await page.goto(`${srv.url}/tasks?token=${srv.token}`)
  await page.getByTestId('preset-open').click()
  await row(page, 'public-launch#l1').click()
  await expect(page.getByTestId('task-title')).toHaveText('Write the launch post')
  const taskUrl = page.url()
  // a deliverable opens OVER the task: same place, ?file= rides along
  await page
    .getByTestId('task-deliverables')
    .getByRole('button', { name: /launch\.md/ })
    .click()
  const sheet = page.getByRole('dialog', { name: /launch\.md/ })
  await expect(sheet).toBeVisible()
  await expect(page).toHaveURL(/\/task\/.*[?&]file=/)
  await expect(page.getByTestId('task-title')).toHaveText('Write the launch post')
  await shot(page, 'file-sheet-over-task.png')
  // Back closes the sheet and you are where you were
  await page.goBack()
  await expect(sheet).toBeHidden()
  expect(page.url()).toBe(taskUrl)
  // ✕ too
  await page
    .getByTestId('task-deliverables')
    .getByRole('button', { name: /launch\.md/ })
    .click()
  await page.getByRole('button', { name: 'Close file viewer' }).click()
  await expect(sheet).toBeHidden()
  await expect(page.getByTestId('task-title')).toHaveText('Write the launch post')
  // the plan's crumb is a place: its tasks, not its JSON
  await page
    .getByTestId('task-header')
    .getByRole('navigation', { name: 'Where this lives' })
    .getByRole('button', { name: /Public launch/ })
    .click()
  await expect(page).toHaveURL(/\/tasks\?.*plan=/)
  await page.goBack()
  // «Open in Files» is the one door into the explorer — and it shows the file
  await page
    .getByTestId('task-deliverables')
    .getByRole('button', { name: /launch\.md/ })
    .click()
  await page.getByTestId('open-in-files').click()
  await expect(page).toHaveURL(/\/files\?path=/)
  // the seeded deliverable lives outside the explorer's tree here: the column says so
  // (the reveal inside the tree is test/file-explorer.test.tsx)
  await expect(page.getByTestId('explorer-outside')).toContainText('launch.md')
  await shot(page, 'files-marks-open-file.png')
})

test("the conversation header names its task; Home's gate row says what it unblocks and opens the task", async ({ page }) => {
  await page.goto(`${srv.url}/agent/e2e/c/${encodeURIComponent('-tmp-e2e-tasks')}/tasks-live-1?token=${srv.token}`)
  await expect(page.getByTestId('conversation-task')).toContainText('Write the launch post')
  await page.goto(`${srv.url}/?token=${srv.token}`)
  const inbox = await openNeedsYou(page)
  const gate = inbox.locator('li', { hasText: 'Choose the docs theme' })
  await expect(gate).toContainText('unblocks 1 task of Web')
  await gate.getByRole('button', { name: 'Open task' }).click()
  await expect(page.getByTestId('task-title')).toHaveText('Choose the docs theme')
})

test('phone: the view and a task page are usable', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  await page.goto(`${srv.url}/tasks?token=${srv.token}`)
  await expect(row(page, 'public-launch#l3')).toBeVisible()
  await shot(page, 'tasks-mine-phone.png')
  await row(page, 'public-launch#l3').click()
  await expect(page.getByTestId('task-title')).toHaveText('Proofread the post')
  await expect(page.getByTestId('task-props').first()).toBeVisible()
  await shot(page, 'task-page-phone.png')
  await ctx.close()
})

test("the sidebar folds every plan to one line under a short «Now»; a click unfolds it (remembered); the open task's plan unfolds itself", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('silos.sidebar.list', 'tasks'))
  await page.goto(`${srv.url}/tasks?token=${srv.token}`)
  const side = page.getByTestId('sidebar-tasks')
  // Now: what a conversation works, then what is on the owner and ready
  const nowGroup = side.getByTestId('sidebar-tasks-now')
  for (const title of ['Write the launch post', 'Take the screenshots', 'Proofread the post', 'Choose the docs theme'])
    await expect(nowGroup.getByText(title)).toBeVisible()
  await expect(nowGroup.getByTestId('sidebar-task')).toHaveCount(4)
  // each plan one folded line with its counts; its tasks hidden
  const launch = side.locator('[data-testid="sidebar-plan"][data-plan="public-launch"]')
  await expect(launch).toHaveAttribute('data-open', 'false')
  await expect(launch.getByTestId('sidebar-plan-counts')).toHaveText('8 open · 1 yours to do')
  await expect(side.locator('[data-plan="docs-site"]').getByTestId('sidebar-plan-counts')).toHaveText('2 open · 1 yours to do')
  await expect(side.getByText('Fix the RSS feed')).toHaveCount(0)
  await shot(page, 'sidebar-folded-light.png')
  // a click unfolds it, and the viewer's choice survives a reload
  await launch.getByTestId('sidebar-plan-fold').click()
  await expect(launch).toHaveAttribute('data-open', 'true')
  await expect(launch.getByText('Fix the RSS feed')).toBeVisible()
  await shot(page, 'sidebar-folded-open-light.png')
  await page.reload()
  await expect(launch).toHaveAttribute('data-open', 'true')
  await launch.getByTestId('sidebar-plan-fold').click()
  await expect(launch).toHaveAttribute('data-open', 'false')
  // the plan of the task open in the main pane unfolds on its own
  await side.locator('[data-plan="docs-site"]').getByTestId('sidebar-plan-fold').click()
  await side.locator('[data-plan="docs-site"]').getByText('Port the guides').click()
  await expect(page.getByTestId('task-title')).toHaveText('Port the guides')
  await side.locator('[data-plan="docs-site"]').getByTestId('sidebar-plan-fold').click()
  await page.goto(`${srv.url}/tasks?token=${srv.token}`)
  await page.getByTestId('preset-open').click()
  await row(page, 'public-launch#l8').click()
  await expect(page.getByTestId('task-title')).toHaveText('Fix the RSS feed')
  await expect(launch).toHaveAttribute('data-open', 'true')
  await expect(launch.locator('[aria-current="page"]')).toHaveText(/Fix the RSS feed/)
})

test('the folded sidebar, dark and on a phone', async ({ browser }) => {
  const dark = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const p1 = await dark.newPage()
  await p1.addInitScript(() => {
    window.localStorage.setItem('silos-dark', '1')
    window.localStorage.setItem('silos.sidebar.list', 'tasks')
    window.localStorage.setItem('silos.sidebar.tasks.expanded', '[]')
  })
  await p1.goto(`${srv.url}/tasks?token=${srv.token}`)
  await expect(p1.getByTestId('sidebar-tasks-now')).toBeVisible()
  await shot(p1, 'sidebar-folded-dark.png')
  await dark.close()
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const p2 = await phone.newPage()
  await p2.addInitScript(() => {
    window.localStorage.setItem('silos.sidebar.list', 'tasks')
    window.localStorage.setItem('silos.sidebar.tasks.expanded', '[]')
  })
  await p2.goto(`${srv.url}/?token=${srv.token}`)
  await p2.getByRole('button', { name: 'agents and conversations' }).click()
  await expect(p2.getByTestId('sidebar-tasks-now')).toBeVisible()
  await shot(p2, 'sidebar-folded-phone.png')
  await phone.close()
})

test('Done: the owner marks a task done through the silo — it leaves Mine and reads done', async ({ page }) => {
  await page.goto(`${srv.url}/tasks?token=${srv.token}`)
  await page.getByTestId('preset-mine').click()
  await row(page, 'docs-site#d1').click()
  await expect(page.getByTestId('task-title')).toHaveText('Choose the docs theme')
  await page.locator('main aside').getByTestId('task-actions').getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.locator('main aside').getByTestId('task-actions').getByRole('button', { name: 'Reopen' })).toBeVisible()
  await expect(page.locator('main aside').getByTestId('task-props')).toContainText('done')
  await page.getByTestId('task-back').click()
  await page.getByTestId('preset-mine').click()
  await expect(row(page, 'docs-site#d1')).toHaveCount(0)
  await page.getByTestId('preset-done').click()
  await expect(row(page, 'docs-site#d1')).toBeVisible()
})

// idle and start are addresses, not tabs — each narrows Open, so Open
// stays lit and the narrowing is a chip whose ✕ returns to the whole tab
test('an address-only view (idle) keeps Open lit and says its narrowing as a removable chip', async ({ page }) => {
  await page.goto(`${srv.url}/tasks?view=idle&token=${srv.token}`)
  await expect(page.getByTestId('preset-open')).toHaveAttribute('aria-selected', 'true')
  const chip = page.getByTestId('tasks-narrow')
  await expect(chip).toBeVisible()
  await chip.getByRole('button').click()
  await expect(page).toHaveURL(/\/tasks\?view=open$/)
  await expect(chip).toHaveCount(0)
})
