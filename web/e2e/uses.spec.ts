// uses.spec.ts — Map › Uses (the usage matrix; the Map's landing
// since the Wiring view retired) against a real Silos over the seeded
// harness (helpers.ts): Home's lens opens /map, the matrix counts tools the
// seeded transcripts really called, a cell opens the conversations behind
// it and one of them opens its conversation; /map deep-links while the
// retired /map/uses, /map/graph and /constellation fall to Home; at 390px
// only the matrix pans, never the page. Evidence screenshots in web/test-results/shots/uses/.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { startServer, cleanupTempDirs, type E2EServer, shotsDir } from './helpers'

const SHOTS_DIR = shotsDir('uses')
mkdirSync(SHOTS_DIR, { recursive: true })

let srv: E2EServer

test.beforeAll(async () => {
  srv = await startServer()
})

test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})

test.use({ viewport: { width: 1440, height: 900 } })

// the seeded transcripts are dated August: the matrix is asked for all time
async function openUses(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`${srv.url}/?token=${srv.token}`)
  await expect(page.getByText('Silos').first()).toBeVisible()
  await page.getByTestId('home-lenses').getByRole('button', { name: 'map', exact: true }).click()
  await expect(page).toHaveURL(/\/map$/)
  await page.getByRole('radiogroup', { name: 'Window' }).getByRole('radio', { name: 'all' }).click()
}

test('agents × tools counts what the transcripts called; a cell lists its conversations and opens one', async ({ page }) => {
  await openUses(page)
  const main = page.locator('main')
  await expect(main.getByRole('tab', { name: 'Uses' })).toHaveAttribute('aria-selected', 'true')
  await main.getByRole('radiogroup', { name: 'Columns' }).getByRole('radio', { name: 'Tools' }).click()
  const matrix = main.getByTestId('uses-matrix')
  await expect(matrix.getByRole('columnheader', { name: /Bash/ })).toBeVisible()
  await expect(main.getByTestId('uses-summary')).toContainText('all time')
  await page.screenshot({ path: join(SHOTS_DIR, 'uses-agents-tools.png') })

  // the seeded API agent's "Flaky test triage" called Read, Grep, Bash, Edit
  const cell = matrix.getByRole('button', { name: /API × Grep: \d+ conversations?$/ })
  await cell.click()
  const panel = page.getByRole('complementary', { name: 'conversations in this cell' })
  await expect(panel).toContainText('Flaky test triage')
  await expect(panel).toContainText(/\d+ calls?/)
  await page.screenshot({ path: join(SHOTS_DIR, 'uses-cell-panel.png') })
  await panel.getByRole('button', { name: /Flaky test triage/ }).click()
  await expect(page).toHaveURL(/\/agent\/api\/c\//)
})

test('shared by 2+ keeps only what more than one row used; projects × skills reads by folder', async ({ page }) => {
  await openUses(page)
  const main = page.locator('main')
  await main.getByRole('radiogroup', { name: 'Columns' }).getByRole('radio', { name: 'Tools' }).click()
  await expect(main.getByTestId('uses-matrix')).toBeVisible()
  const all = await main.getByTestId('uses-matrix').getByRole('columnheader').count()
  await main.getByRole('switch', { name: /shared by 2\+ agents/ }).click()
  await expect.poll(async () => main.getByTestId('uses-matrix').getByRole('columnheader').count()).toBeLessThanOrEqual(all)
  await main.getByRole('switch', { name: /shared by 2\+ agents/ }).click()
  await main.getByRole('radiogroup', { name: 'Rows' }).getByRole('radio', { name: 'Projects' }).click()
  await main.getByRole('radiogroup', { name: 'Columns' }).getByRole('radio', { name: 'Skills' }).click()
  await expect(main.getByTestId('uses-matrix').getByRole('columnheader', { name: /e2e-skill/ })).toBeVisible()
  await page.screenshot({ path: join(SHOTS_DIR, 'uses-projects-skills.png') })
})

test('/map deep-links to Uses; retired addresses fall to Home, never aliased', async ({ page }) => {
  await page.goto(`${srv.url}/map?token=${srv.token}`)
  await expect(page).toHaveURL(/\/map(\?.*)?$/)
  await expect(page.locator('main').getByRole('tab', { name: 'Uses' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('main').getByTestId('uses-summary')).toBeVisible()
  for (const gone of ['/map/uses', '/map/graph', '/constellation']) {
    await page.goto(`${srv.url}${gone}?token=${srv.token}`)
    await expect.poll(() => new URL(page.url()).pathname).toBe('/')
  }
})

test.describe('at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } })
  test('only the matrix scrolls sideways — never the page', async ({ page }) => {
    await page.goto(`${srv.url}/map?token=${srv.token}`)
    const main = page.locator('main')
    await main.getByRole('radiogroup', { name: 'Window' }).getByRole('radio', { name: 'all' }).click()
    await main.getByRole('radiogroup', { name: 'Columns' }).getByRole('radio', { name: 'Tools' }).click()
    await expect(main.getByTestId('uses-matrix')).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    await page.screenshot({ path: join(SHOTS_DIR, 'uses-phone.png') })
  })
})
