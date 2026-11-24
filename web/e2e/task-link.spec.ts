// task-link.spec.ts — the link shows on both sides,
// against a REAL seeded server (helpers seedTasks):
//   header    the conversation says «☑ Working on «title» ›», an open task
//             first; «+N» opens the list of the others
//   sidebar   its row carries the ☑, the task's title in the tooltip
//   closed    a conversation whose task's plan moved to plans/closed/ says
//             «Worked on «title» ✓»; the task's page opens read-only
//   ⌘K link   «Link this conversation to a task…» lists the agent's open
//             tasks; picking one writes conversations[] — the chip says it
//   ⌘K make   «Make this a task» opens New task with the conversation's
//             title and agent; on create the task lists the conversation
// Screenshots (desktop light) when SILOS_T5_SHOTS=<dir>.
// Serial: the ⌘K tests write the plans.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { startServer, cleanupTempDirs, touchTasksLive, TASKS_CLOSED_SESSION, TASKS_LIVE_SESSION, type E2EServer } from './helpers'

const SHOTS = process.env.SILOS_T5_SHOTS || null
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

async function shot(page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }): Promise<void> {
  if (!SHOTS) return
  await page.waitForTimeout(300)
  await page.screenshot({
    path: join(SHOTS, name),
    ...(clip ? { clip } : {}),
    maskColor: '#8f8d86',
    mask: [page.getByRole('button', { name: 'Settings' }).locator('xpath=..')],
  })
}
const conversation = (id: string): string => `${srv.url}/agent/e2e/c/${encodeURIComponent('-tmp-e2e-tasks')}/${id}?token=${srv.token}`

test('the header says the task it works, an open one first; +N opens the others', async ({ page }) => {
  await page.goto(conversation(TASKS_LIVE_SESSION))
  const chip = page.getByTestId('conversation-task')
  await expect(chip).toContainText('Working on')
  await expect(chip).toContainText('Write the launch post')
  await expect(chip).toHaveAttribute('data-working', 'true')
  await shot(page, 'header-working-on.png')
  await page.getByTestId('conversation-task-more').click()
  const list = page.getByTestId('conversation-task-list')
  await expect(list.getByTestId('conversation-task-item')).toHaveCount(2)
  await expect(list).toContainText('Take the screenshots')
  await shot(page, 'header-more-list.png')
  await list.getByTestId('conversation-task-item').filter({ hasText: 'Take the screenshots' }).click()
  await expect(page.getByTestId('task-title')).toHaveText('Take the screenshots')
})

test('the sidebar row carries the ☑ with the task in its tooltip; a finished task leaves none', async ({ page }) => {
  await page.goto(conversation(TASKS_LIVE_SESSION))
  const nav = page.getByRole('navigation').first()
  const liveRow = page.locator('li', { hasText: 'Launch post draft' }).first()
  const mark = liveRow.getByTestId('task-mark')
  await expect(mark).toBeVisible()
  await expect(mark).toHaveAttribute('title', /Working on «Write the launch post» and 1 more/)
  await expect(page.locator('li', { hasText: 'Beta invites wrap-up' }).first().getByTestId('task-mark')).toHaveCount(0)
  const box = await nav.boundingBox()
  await shot(page, 'sidebar-task-mark.png', box ? { x: 0, y: 0, width: Math.min(box.x + box.width, 520), height: 520 } : undefined)
})

test("a closed plan's task still resolves: «Worked on ✓», and its page opens read-only", async ({ page }) => {
  await page.goto(conversation(TASKS_CLOSED_SESSION))
  const chip = page.getByTestId('conversation-task')
  await expect(chip).toContainText('Worked on')
  await expect(chip).toContainText('Send the beta invites')
  await expect(chip).toHaveAttribute('data-working', 'false')
  await shot(page, 'header-worked-on-closed.png')
  await chip.click()
  await expect(page.getByTestId('task-title')).toHaveText('Send the beta invites')
  await expect(page.getByTestId('task-closed').first()).toContainText('read only')
  await expect(page.getByTestId('task-back')).toContainText('Beta invites wrap-up')
  await shot(page, 'task-page-closed-plan.png')
})

test("⌘K links this conversation to one of the agent's open tasks", async ({ page }) => {
  await page.goto(conversation(TASKS_CLOSED_SESSION))
  await expect(page.getByTestId('conversation-task')).toContainText('Worked on')
  await page.keyboard.press('Control+k')
  await page.getByRole('textbox', { name: 'search' }).fill('link')
  await page.getByTestId('palette-link-task').click()
  await expect(page.getByTestId('palette-link-head')).toContainText('Beta invites wrap-up')
  const options = page.getByTestId('palette-link-option')
  await expect(options.first()).toBeVisible()
  // the agent's open tasks only — Web's are not offered, nor the finished ones
  await expect(page.getByTestId('palette-link-option').filter({ hasText: 'Fix the RSS feed' })).toHaveCount(0)
  await expect(page.getByTestId('palette-link-option').filter({ hasText: 'Write the README' })).toHaveCount(0)
  await shot(page, 'palette-link-list.png')
  await page.getByRole('textbox', { name: 'search' }).fill('publish on')
  await expect(options).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: /Link this conversation/ })).toHaveCount(0)
  const chip = page.getByTestId('conversation-task')
  // a blocked task keeps its state when the owner links it: «Linked to»
  await expect(chip).toContainText('Linked to')
  await expect(chip).toContainText('Publish on the blog')
  await expect(page.getByTestId('conversation-task-more').locator('[data-count]')).toHaveAttribute('data-count', '1')
  await shot(page, 'header-after-link.png')
})

test("⌘K «Make this a task»: New task with the conversation's title and agent, linked on create", async ({ page }) => {
  // ONE request: the task is born with the conversation
  // listed — current before any gesture, so Silos never wakes a second one
  const calls: Array<{ path: string; body: Record<string, unknown> }> = []
  page.on('request', (r) => {
    const u = new URL(r.url()).pathname
    if (r.method() === 'POST' && (u === '/api/tasks/new' || u === '/api/tasks/link' || u === '/api/tasks/assign'))
      calls.push({ path: u, body: (r.postDataJSON() ?? {}) as Record<string, unknown> })
  })
  await page.goto(conversation(TASKS_LIVE_SESSION))
  await page.keyboard.press('Control+k')
  await page.getByRole('textbox', { name: 'search' }).fill('make this')
  await shot(page, 'palette-verbs.png')
  await page.getByTestId('palette-make-task').click()
  const dialog = page.getByTestId('new-task-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('textbox', { name: 'What to do' })).toHaveValue('Launch post draft')
  await expect(dialog.locator('#nt-owner')).toHaveValue('e2e')
  await expect(page.getByTestId('new-task-link-note')).toContainText('Launch post draft')
  await shot(page, 'make-this-a-task-dialog.png')
  await dialog.getByTestId('give-later').click()
  await expect(page.getByTestId('task-title')).toHaveText('Launch post draft')
  await expect(page.getByTestId('task-back')).toContainText('Launch post draft')
  await expect(page.getByTestId('task-conversation').first()).toBeVisible()
  expect(calls.map((c) => c.path)).toEqual(['/api/tasks/new'])
  expect(calls[0]!.body).toMatchObject({ title: 'Launch post draft', owner: 'e2e', session: TASKS_LIVE_SESSION })
  await page.getByTestId('task-back').click()
  await expect(page).toHaveURL(/\/c\/-tmp-e2e-tasks\/tasks-live-1/)
  await page.getByTestId('conversation-task-more').click()
  await expect(page.getByTestId('conversation-task-list')).toContainText('Launch post draft')
})
