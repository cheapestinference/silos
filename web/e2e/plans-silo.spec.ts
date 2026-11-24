// plans-silo.spec.ts — the owner's plans on every surface that shows them,
// against a REAL server (the native plan code became the
// built-in Plans silo; nothing the owner had may be lost). Seeded (helpers
// seedPlans): a plan with a gate and a routine task, one with a due date, one
// idle 40 days, and a conversation that wrote the first plan.
//   Home     the gate waits in Needs you with Done / Drop; the routine tasks
//            are «Yours to do», one line per plan
//   column   the conversation's Plan block draws the plan it wrote
//   viewer   the plan file opens as the plan, not as JSON
//   /silo    the Plans silo's own page
// Evidence screenshots in web/test-results/shots/plans-silo/ when
// SILOS_SHOTS=1 (SILOS_SHOTS_TAG prefixes them: before / after the flip).
// Serial: the last test changes the server (Done).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { startServer, cleanupTempDirs, openNeedsYou, PLANS_SESSION_ID, PLAN_GATE_TITLE, PLAN_ROUTINE_TITLE, type E2EServer, shotsDir } from './helpers'

const SHOTS = process.env.SILOS_SHOTS ? shotsDir('plans-silo') : null
const TAG = process.env.SILOS_SHOTS_TAG ? `${process.env.SILOS_SHOTS_TAG}-` : ''
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

let srv: E2EServer

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  srv = await startServer({ plans: true })
})
test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})
test.use({ viewport: { width: 1440, height: 900 } })

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return
  await page.screenshot({
    path: join(SHOTS, `${TAG}${name}`),
    maskColor: '#8f8d86',
    mask: [page.getByRole('button', { name: 'Settings' }).locator('xpath=..')],
  })
}

test('Home: the gate and the near due wait in Needs you with Done / Drop; the routine tasks are yours to do, a line per plan', async ({ page }) => {
  await page.goto(`${srv.url}/?token=${srv.token}`)
  // the routine tasks of yours follow what holds someone up, in the one list
  await expect(page.getByTestId('yours-all')).toBeVisible()
  await shot(page, 'home.png')
  const inbox = await openNeedsYou(page)
  const gate = inbox.locator('li', { hasText: PLAN_GATE_TITLE })
  await expect(gate).toBeVisible()
  await expect(gate.getByTestId('task-row-facts')).toHaveAttribute('title', 'Ship the public repo')
  await expect(gate.getByRole('button', { name: 'Done' })).toBeVisible()
  await expect(gate.getByRole('button', { name: 'Drop…' })).toBeVisible()
  // Drop… is a small confirm (why, and what it leaves hanging), never one click
  await gate.getByRole('button', { name: 'Drop…' }).click()
  await expect(inbox.getByTestId('home-drop-confirm')).toBeVisible()
  await inbox.getByTestId('home-drop-confirm').getByRole('button', { name: 'Cancel' }).click()
  await expect(inbox.getByTestId('home-drop-confirm')).toHaveCount(0)
  await expect(inbox.locator('li', { hasText: 'Sign the VAT return' })).toBeVisible()
  await expect(inbox.getByText(PLAN_ROUTINE_TITLE)).toHaveCount(0)
  await shot(page, 'needs-you.png')
  await page.keyboard.press('Escape')
  await page.getByTestId('yours-all').click()
  const yours = page.getByTestId('sheet-yours')
  await expect(yours.getByTestId('plan-group')).toHaveCount(3)
  await yours.getByTestId('plan-group').filter({ hasText: 'Ship the public repo' }).getByRole('button', { expanded: false }).click()
  await expect(yours.getByText(PLAN_ROUTINE_TITLE)).toBeVisible()
  await shot(page, 'yours-to-do.png')
})

test("«Open plan ›» lands in the plan's house (Tasks narrowed to it); its file opens as the plan (FileViewer) from there", async ({ page }) => {
  await page.goto(`${srv.url}/?token=${srv.token}`)
  await page.getByTestId('yours-all').click()
  const yours = page.getByTestId('sheet-yours')
  await yours.getByTestId('plan-group').filter({ hasText: 'Ship the public repo' }).getByRole('button', { name: 'Open plan ›' }).click()
  // one door per thing: the plan's house, the same address the sidebar and the crumb open
  await expect(page).toHaveURL(/\/tasks\?view=open&plan=/)
  await page.getByTestId('tasks-open-file').click()
  await expect(page.getByRole('heading', { name: 'Ship the public repo' })).toBeVisible()
  await expect(page.getByText('Fill repository and homepage in package.json').first()).toBeVisible()
  await shot(page, 'file-viewer.png')
})

test('the conversation that wrote the plan draws it in its column', async ({ page }) => {
  await page.goto(`${srv.url}/agent/e2e/c/${encodeURIComponent('-tmp-e2e-plans')}/${PLANS_SESSION_ID}?token=${srv.token}`)
  const card = page.getByTestId('team-plan-ship-public-repo.plan.json')
  await expect(card).toBeVisible()
  await expect(card.getByTestId('team-plan-title')).toHaveText('Ship the public repo')
  await shot(page, 'column-planview.png')
})

test("the Plans silo's page", async ({ page }) => {
  await page.goto(`${srv.url}/silo/plans?token=${srv.token}`)
  await page.waitForLoadState('networkidle')
  await shot(page, 'silo-plans.png')
})

test('Done on the gate: the row leaves and the line under Needs you says who moves', async ({ page }) => {
  await page.goto(`${srv.url}/?token=${srv.token}`)
  const inbox = await openNeedsYou(page)
  const gate = inbox.locator('li', { hasText: PLAN_GATE_TITLE })
  await gate.getByRole('button', { name: 'Done' }).click()
  await expect(inbox.locator('li', { hasText: PLAN_GATE_TITLE })).toHaveCount(0)
  await expect(page.getByTestId('plan-handoff')).toContainText('Unblocked for E2E: “Fill repository and homepage in package.json”.')
  await shot(page, 'done-handoff.png')
})
