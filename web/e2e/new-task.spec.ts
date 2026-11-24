// new-task.spec.ts — «a task never needs a plan»
// against a REAL server seeded with two projects (helpers seedTasks): E2E's
// folder holds «Public launch», Web's holds «Docs site».
//   where     the dialog asks what and who; where it lands is one folded
//             line — the owner's busiest open plan IN ITS project, never
//             another project's (Web never gets «Public launch»)
//   standing  «No plan» lands the task in the project's standing list: the
//             kernel makes plans/tasks.plan.json, and the task's page
//             crumb is just the project
// Screenshots of the dialog when T3_SHOTS names a folder.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { startServer, cleanupTempDirs, type E2EServer } from './helpers'

const SHOTS = process.env.T3_SHOTS ?? null
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

let srv: E2EServer
let e2eFolder = ''

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  srv = await startServer({ tasks: true })
  const r = await fetch(`${srv.url}/api/agents?token=${srv.token}`)
  const body = (await r.json()) as { agents: Array<{ id: string; folder: string | null }> } | Array<{ id: string; folder: string | null }>
  const list = Array.isArray(body) ? body : body.agents
  e2eFolder = list.find((a) => a.id === 'e2e')!.folder!
})
test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})
test.use({ viewport: { width: 1280, height: 860 } })

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return
  await page.waitForTimeout(200)
  await page.screenshot({ path: join(SHOTS, name) })
}

async function openDialog(page: Page): Promise<void> {
  await page.goto(`${srv.url}/tasks?token=${srv.token}`)
  await page.getByTestId('new-task').click()
  await expect(page.getByTestId('new-task-dialog')).toBeVisible()
}

test("it asks what and who; the plan is folded — the project's standing list by default — and stays in the owner's project", async ({ page }) => {
  await openDialog(page)
  const dialog = page.getByTestId('new-task-dialog')
  await dialog.getByLabel('What to do').fill('Write the changelog')
  await dialog.locator('#nt-owner').selectOption('e2e')
  // never a guessed named plan: the standing list, which has no name
  await expect(page.getByTestId('new-task-where')).toHaveText(`in ${basename(e2eFolder)}`)
  await shot(page, 'new-task-folded.png')
  // Web lives in its own folder: never E2E's «Public launch»
  await dialog.locator('#nt-owner').selectOption('web')
  await expect(page.getByTestId('new-task-where')).not.toContainText('Public launch')
  // the footer that sent you to an agent is gone
  await expect(dialog).not.toContainText('ask it')
})

test("«No plan» lands it in the project's standing list — made by the kernel, the crumb just the project", async ({ page }) => {
  expect(existsSync(join(e2eFolder, 'plans', 'tasks.plan.json'))).toBe(false)
  await openDialog(page)
  const dialog = page.getByTestId('new-task-dialog')
  await dialog.getByLabel('What to do').fill('Renew the domain')
  await dialog.getByTestId('give-details').click()
  await dialog.getByLabel('Details').fill('It expires at the end of the month.')
  await dialog.locator('#nt-owner').selectOption('e2e')
  await page.getByTestId('new-task-change').click()
  const plan = dialog.locator('#nt-plan')
  await expect(plan.locator('option')).toHaveText(['No plan', 'Public launch'])
  await plan.selectOption({ label: 'No plan' })
  await expect(page.getByTestId('new-task-where')).toHaveText(`in ${basename(e2eFolder)}`)
  await shot(page, 'new-task-change-open.png')
  // the task alone, no gesture: its page opens
  await dialog.getByTestId('give-later').click()
  await expect(page).toHaveURL(/\/task\//)
  const header = page.getByTestId('task-header')
  await expect(header).toContainText('Renew the domain')
  await expect(header).toContainText(basename(e2eFolder))
  await expect(header).not.toContainText('Public launch')
  await shot(page, 'new-task-created-page.png')
  const file = JSON.parse(readFileSync(join(e2eFolder, 'plans', 'tasks.plan.json'), 'utf8')) as {
    tasks: Array<{ id: string; title: string; owner: string; status: string; notes?: Array<{ text: string }> }>
  }
  expect(file.tasks).toHaveLength(1)
  expect(file.tasks[0]).toMatchObject({ id: 't1', title: 'Renew the domain', owner: 'e2e', status: 'pending' })
  expect(file.tasks[0]!.notes?.[0]?.text).toBe('It expires at the end of the month.')
})

test('yours: the project is yours to pick', async ({ page }) => {
  await openDialog(page)
  const dialog = page.getByTestId('new-task-dialog')
  await dialog.getByLabel('What to do').fill('Sign the contract')
  await dialog.locator('#nt-owner').selectOption('owner')
  await expect(dialog.getByTestId('give-primary')).toHaveText('Add to my list')
  await page.getByTestId('new-task-change').click()
  await expect(dialog.locator('#nt-project')).toBeVisible()
  expect(await dialog.locator('#nt-project option').count()).toBeGreaterThan(1)
  await shot(page, 'new-task-yours-project.png')
})
