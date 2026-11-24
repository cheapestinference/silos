// templates.spec.ts — automation templates against a real Silos:
// /automation/new
// shows the templates; picking one turns its sentence into the form; the
// preview is the server's; Create lands on the new automation; «Save as
// template» brings it back as yours. Seeded data only; what is created is
// paused at once. Screenshots only when TEMPLATES_SHOTS_DIR is set.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { startServer, cleanupTempDirs, type E2EServer } from './helpers'

const SHOTS = process.env.TEMPLATES_SHOTS_DIR
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

let srv: E2EServer
test.beforeAll(async () => {
  srv = await startServer()
})
test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})

const pause = (id: string) =>
  fetch(`${srv.url}/api/automations/${id}?token=${srv.token}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paused: true }),
  })

test('a template: the shelf, the sentence as the form, the server preview, Create, then Save as template', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await page.goto(`${srv.url}/automation/new?agent=ux&token=${srv.token}`)
  const main = page.locator('main')
  await expect(main.getByTestId('template-shelf')).toBeVisible()
  await expect(main.getByTestId('template-monthly-close')).toBeVisible()
  await shot(page, 'desktop-shelf')

  await main.getByTestId('template-monthly-close').click()
  await expect(page).toHaveURL(/\/automation\/new\?template=monthly-close&agent=ux$/)
  await expect(main.getByTestId('template-fill')).toBeVisible()
  // the agent the page was opened for fills the first agent blank; the day has its default
  await expect(main.getByTestId('blank-agent')).toHaveValue('ux')
  await expect(main.getByTestId('blank-day')).toHaveValue('5')
  await main.getByTestId('blank-what').fill('reconcile sales with the bank and list unpaid invoices')
  await expect(main.getByTestId('template-preview')).toContainText('Monthly close (day 5)')
  await shot(page, 'desktop-fill')

  // a bad answer: the server's words, the blank marked
  await main.getByTestId('blank-day').fill('31')
  await expect(main.getByTestId('template-problem')).toContainText('a day from 1 to 28')
  await expect(main.getByTestId('blank-day')).toHaveAttribute('aria-invalid', 'true')
  await shot(page, 'desktop-fill-problem')
  await main.getByTestId('blank-day').fill('3')
  await expect(main.getByTestId('template-preview')).toContainText('Monthly close (day 3)')

  await main.getByTestId('template-create').click()
  await expect(page).toHaveURL(/\/automation\/(?!new)[^/?]+$/)
  const id = page.url().split('/').pop()!
  await pause(id)
  const created = (await (await fetch(`${srv.url}/api/automations/${id}?token=${srv.token}`)).json()).automation
  expect(created).toMatchObject({ agentId: 'ux', trigger: { kind: 'cron', expr: '7 6 3 * *' } })
  expect(created.prompt).toContain('reconcile sales with the bank')

  // «Save as template»: back on the fill page, as yours
  await main.getByRole('button', { name: 'More actions' }).click()
  await main.getByRole('menuitem', { name: 'Save as template' }).click()
  await expect(page).toHaveURL(/\/automation\/new\?template=monthly-close-day-3$/)
  await expect(main.getByText('Your template — fill in the blanks')).toBeVisible()
  await shot(page, 'desktop-yours')
  await context.close()
})

test('shots: the fill page on a phone, and dark', async ({ browser }) => {
  const phone = await browser.newContext({ viewport: { width: 400, height: 860 }, isMobile: true, hasTouch: true })
  const p = await phone.newPage()
  await p.goto(`${srv.url}/automation/new?template=site-watch&agent=api&token=${srv.token}`)
  await expect(p.locator('main').getByTestId('template-fill')).toBeVisible()
  await p.locator('main').getByTestId('blank-url').fill('https://status.example.com/health')
  await expect(p.locator('main').getByTestId('template-preview')).toBeVisible()
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  expect(overflow).toBe(false)
  await shot(p, 'phone-fill')
  await phone.close()

  const dark = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const d = await dark.newPage()
  await d.addInitScript(() => window.localStorage.setItem('silos-dark', '1'))
  await d.goto(`${srv.url}/automation/new?template=nightly-script&token=${srv.token}`)
  await expect(d.locator('main').getByTestId('template-fill')).toBeVisible()
  await shot(d, 'desktop-fill-dark')
  await d.goto(`${srv.url}/automation/new?token=${srv.token}`)
  await expect(d.locator('main').getByTestId('template-shelf')).toBeVisible()
  await shot(d, 'desktop-shelf-dark')
  await dark.close()
})
