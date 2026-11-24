// answer-gesture.spec.ts — the PRIMARY gesture of a task's box:
// on a gate of yours, submit (and Enter) IS Answer & done — the text lands on
// the waiting tasks and the gate closes in one gesture; «Add note» is the
// quiet secondary. On a bound agent's task the primary is Send (the note that
// wakes). The generic record page names the task's house instead of being a
// second, mute box. Evidence under web/test-results/shots/answer-gesture/
// when SILOS_SHOTS=1.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { startServer, cleanupTempDirs, PLAN_GATE_TITLE, TASKS_PLAN_SLUG, type E2EServer, shotsDir } from './helpers'

const SHOTS = process.env.SILOS_SHOTS ? shotsDir('answer-gesture') : null
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

let srv: E2EServer

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  srv = await startServer({ taskMode: true, plans: true })
})
test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})
test.use({ viewport: { width: 1440, height: 900 } })

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(SHOTS, name) })
}

let agentFolder = ''
test.beforeAll(async ({ request }) => {
  const agents = (await (await request.get(`${srv.url}/api/agents?token=${srv.token}`)).json()) as
    { agents?: Array<{ id: string; folder: string | null }> } | Array<{ id: string; folder: string | null }>
  const list = Array.isArray(agents) ? agents : (agents.agents ?? [])
  agentFolder = list.find((a) => a.id === 'e2e')!.folder!
})
const taskUrl = (plan: string, id: string): string =>
  `${srv.url}/task/${encodeURIComponent(`folder:${agentFolder}/${plan}`)}/${encodeURIComponent(id)}?token=${srv.token}`

test('on a gate of yours, Enter answers-and-closes: the text lands on the waiting task and the gate goes done', async ({ page }) => {
  await page.goto(taskUrl('ship-public-repo', 't2'))
  await expect(page.getByTestId('task-title')).toHaveText(PLAN_GATE_TITLE)
  const box = page.getByTestId('task-note-box')
  await expect(box).toHaveAttribute('placeholder', /Your answer — it lands on E2E and closes this task/)
  // the answering button is the primary (terracotta) submit; Add note the quiet secondary
  await expect(page.getByTestId('task-answer-done')).toHaveText('Answer & done')
  await expect(page.getByRole('button', { name: 'Add note' })).toBeVisible()
  await shot(page, 'gate-box.png')
  await box.fill('the-org, with the homepage at example.dev')
  await box.press('Enter')
  await expect(page.getByTestId('task-answered-doors')).toContainText('it landed on ship-public-repo#t3 (E2E)')
  await shot(page, 'gate-answered.png')
  // the gesture really closed the gate and the answer really landed on the waiter
  const plan = await (
    await page.request.get(`${srv.url}/api/silos/plans/record?key=${encodeURIComponent(`folder:${agentFolder}/ship-public-repo/tasks/t3`)}&token=${srv.token}`)
  ).text()
  expect(plan).toContain('the-org, with the homepage at example.dev')
})

test("a plain task of yours keeps the quiet Add note as the only button; a bound agent's task sends", async ({ page }) => {
  await page.goto(taskUrl('close-october', 'c3'))
  await expect(page.getByRole('button', { name: 'Add note' })).toBeVisible()
  await expect(page.getByTestId('task-answer-done')).toHaveCount(0)
  await page.goto(`${srv.url}/task/${encodeURIComponent(`folder:${agentFolder}/${TASKS_PLAN_SLUG}`)}/l8?token=${srv.token}`)
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
})

test("the generic record page names the task's house", async ({ page }) => {
  const recordKey = `folder:${agentFolder}/close-october/tasks/c2`
  await page.goto(`${srv.url}/silo/plans/r/${encodeURIComponent(recordKey)}?token=${srv.token}`)
  const door = page.getByTestId('record-house-door')
  await expect(door).toBeVisible()
  await shot(page, 'record-house-door.png')
  await door.click()
  await expect(page.getByTestId('task-title')).toHaveText('Sign the VAT return')
})
