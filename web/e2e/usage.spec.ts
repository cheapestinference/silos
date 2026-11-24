// usage.spec.ts — Usage against a real Silos with a
// seeded week of turns (helpers.ts seedUsage): the page, its views, its
// empty-of-nothing words and its doors. Screenshots only when USAGE_SHOTS
// names a folder (layout is checked by eye, never asserted).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { startServer, cleanupTempDirs, type E2EServer } from './helpers'

const SHOTS = process.env.USAGE_SHOTS
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
// desktop and phone (390 px), light and dark — layout is checked by eye
const shot = async (page: Page, name: string): Promise<void> => {
  if (!SHOTS) return
  const size = page.viewportSize()
  for (const [w, h, tag] of [
    [1440, 900, 'desktop'],
    [390, 844, 'phone'],
  ] as const) {
    await page.setViewportSize({ width: w, height: h })
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => {
        document.documentElement.classList.toggle('dark', t === 'dark')
      }, theme)
      await page.waitForTimeout(80)
      await page.screenshot({ path: join(SHOTS, `${name}--${tag}-${theme}.png`), fullPage: true })
    }
  }
  await page.evaluate(() => {
    document.documentElement.classList.remove('dark')
  })
  if (size) await page.setViewportSize(size)
}

let srv: E2EServer

test.beforeAll(async () => {
  srv = await startServer({ usage: true })
})

test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})

test.use({ viewport: { width: 1440, height: 900 } })

test('Usage: today by agent — the classes of each agent, Unattributed apart, plan without dollars', async ({ page }) => {
  await page.goto(`${srv.url}/usage?token=${srv.token}`)
  const main = page.locator('main')
  await expect(main.getByTestId('usage-summary')).toContainText('tokens today')
  await expect(main.getByTestId('usage-row-agent:ux')).toBeVisible()
  await expect(main.getByTestId('usage-row-agent:ux')).toContainText('Task starts')
  await expect(main.getByTestId('usage-row-agent:ux')).toContainText('on plan')
  await expect(main.getByTestId('usage-row-unattributed')).toContainText('Quick shell question')
  await expect(main.getByTestId('usage-row-agent:e2e')).toContainText('With you')
  // a console is said as one, never as a count of turns
  await expect(main.getByTestId('usage-summary')).toContainText('and a console')
  await expect(main.getByTestId('usage-summary-parts')).toContainText('cache')
  await shot(page, 'usage-today-by-agent')
})

test('Usage: 7 days — one bar a day, by agent in By agent and by class elsewhere, «before» the register, the views', async ({ page }) => {
  await page.goto(`${srv.url}/usage?period=7d&token=${srv.token}`)
  const main = page.locator('main')
  await expect(main.getByTestId('usage-bars')).toBeVisible()
  await expect(main.getByTestId('usage-bars')).toHaveAttribute('data-by', 'agent')
  await expect(main.getByTestId('usage-legend')).toContainText('UX')
  await expect(main.getByTestId('usage-row-before')).toBeVisible()
  await shot(page, 'usage-7d-by-agent')
  await main.getByTestId('usage-view-automation').click()
  await expect(main.getByTestId('usage-row-automation:auto-digest')).toContainText('Weekly digest')
  await expect(page).toHaveURL(/by=automation/)
  await expect(main.getByTestId('usage-bars')).toHaveAttribute('data-by', 'class')
  await shot(page, 'usage-7d-by-automation')
  await main.getByTestId('usage-view-account').click()
  await expect(main.getByTestId('usage-row-account:gateway')).toContainText('$')
  await shot(page, 'usage-7d-by-account')
  await main.getByTestId('usage-view-conversation').click()
  await expect(main.getByTestId('usage-rows')).toContainText('With you')
  await shot(page, 'usage-7d-by-conversation')
})

// narrowed as Tasks narrows — the title stays, the agent is a chip
test("Usage of one agent: its chip's ✕ leads back to the fleet", async ({ page }) => {
  await page.goto(`${srv.url}/usage?agent=api&period=7d&token=${srv.token}`)
  const chip = page.locator('main').getByTestId('usage-agent')
  await expect(chip).toContainText('API')
  await expect(page.locator('main').getByTestId('usage-row-agent:api')).toContainText('1 you started')
  await shot(page, 'usage-agent-api-7d')
  await chip.getByRole('button').click()
  await expect(page).toHaveURL(/\/usage\?period=7d$/)
})

test("doors: Automations' header opens Usage by automation", async ({ page }) => {
  await page.goto(`${srv.url}/automations?token=${srv.token}`)
  await page.getByTestId('automations-usage').click()
  await expect(page).toHaveURL(/\/usage\?by=automation/)
  await expect(page.locator('main').getByTestId('usage-rows')).toBeVisible()
})

test('a failed read replaces the report by the error — never stale rows under it', async ({ page }) => {
  await page.goto(`${srv.url}/usage?period=7d&token=${srv.token}`)
  const main = page.locator('main')
  await expect(main.getByTestId('usage-rows')).toBeVisible()
  await page.route('**/api/usage?*', (r) =>
    r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'the index is not ready' }) }),
  )
  await main.getByTestId('usage-view-task').click()
  await expect(main.getByRole('alert')).toContainText("Usage can't be read")
  await expect(main.getByTestId('usage-rows')).toHaveCount(0)
  await expect(main.getByTestId('usage-summary')).toHaveCount(0)
})
