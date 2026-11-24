// system.spec.ts — System › Vitals against a real Silos with the sampler's
// history seeded (helpers.ts seedMachine): the rail's System door lands on
// it, it draws the seeded series (30 days of disk, the memory week with its
// gap, the fleet, runs a day), and its doors work. Screenshots only when
// SYSTEM_SHOTS names a folder (layout is checked by eye, never asserted).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { startServer, cleanupTempDirs, type E2EServer } from './helpers'

const SHOTS = process.env.SYSTEM_SHOTS
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
const shot = async (page: Page, name: string): Promise<void> => {
  if (!SHOTS) return
  const size = page.viewportSize()
  for (const [w, h, tag] of [
    [1440, 1000, 'desktop'],
    [390, 844, 'phone'],
  ] as const) {
    await page.setViewportSize({ width: w, height: h })
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => {
        document.documentElement.classList.toggle('dark', t === 'dark')
      }, theme)
      await page.waitForTimeout(150)
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
  srv = await startServer({ machine: true, silos: true })
})

test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})

test.use({ viewport: { width: 1440, height: 1000 } })

test("the rail's System door lands on Vitals, which draws the seeded series", async ({ page }) => {
  await page.goto(`${srv.url}/?token=${srv.token}`)
  await page.locator('aside').getByLabel('System', { exact: true }).click()
  await expect(page).toHaveURL(/\/system$/)
  const main = page.locator('main')
  // the disk: every seeded day (the boot sample lands on today's)
  await expect(main.getByTestId('system-disk-chart')).toHaveAttribute('data-days', '30')
  await expect(main.getByTestId('system-disk-short')).toHaveCount(0)
  // the memory week: hourly points, the missing hours drawn as one gap
  const mem = main.getByTestId('system-memory-chart')
  await expect(mem).toHaveAttribute('data-gaps', '1')
  expect(Number(await mem.getAttribute('data-points'))).toBeGreaterThan(100)
  // the fleet over 90 days, with the seeded change of control among its events
  const fleet = main.getByTestId('system-fleet-chart')
  await expect(fleet).toHaveAttribute('data-days', '90')
  expect(Number(await fleet.getAttribute('data-events'))).toBeGreaterThan(0)
  // runs and executions: 30 days each, drawn or said
  for (const id of ['system-runs', 'system-executions']) await expect(main.getByTestId(id)).toBeVisible()
  await expect(main.getByTestId('system-trash')).toBeVisible()
  await shot(page, 'system-vitals')
  // the figure at the cursor, one shot per chart (by eye)
  if (SHOTS) {
    for (const id of ['system-disk-chart', 'system-memory-chart', 'system-fleet-chart', 'system-runs-chart']) {
      const box = await main.getByTestId(id).boundingBox()
      if (!box) continue
      await page.mouse.move(box.x + box.width * 0.62, box.y + box.height / 2)
      await page.screenshot({
        path: join(SHOTS, `system-hover-${id}.png`),
        clip: { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 120 },
      })
    }
  }
})

test('doors: the Vitals tab, Worktrees ›, ⌘K «System › Vitals»', async ({ page }) => {
  await page.goto(`${srv.url}/files?token=${srv.token}`)
  await page.getByRole('tab', { name: 'Vitals' }).click()
  await expect(page).toHaveURL(/\/system$/)
  const door = page.locator('main').getByTestId('system-worktrees')
  await door.click()
  await expect(page).toHaveURL(/\/silo\/system\/v\/worktrees$/)
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Search conversations' })
  await palette.getByRole('textbox', { name: 'search' }).fill('vitals')
  await palette.getByRole('option', { name: 'System › Vitals', exact: true }).click()
  await expect(page).toHaveURL(/\/system$/)
})

test('a failed read draws nothing of its own — the doors stay', async ({ page }) => {
  await page.route('**/api/system', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'down' }) }))
  await page.route('**/api/vitals', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'down' }) }))
  await page.goto(`${srv.url}/system?token=${srv.token}`)
  const main = page.locator('main')
  await expect(main.getByTestId('system-worktrees')).toBeVisible()
  await expect(main.getByTestId('system-disk')).toHaveCount(0)
  await expect(main.getByTestId('system-fleet')).toHaveCount(0)
})
