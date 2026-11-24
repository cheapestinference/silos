// layout.spec.ts — layout plan closeout: three minimal smoke tests in real
// Chromium over the seeded harness (helpers.ts), covering what the jsdom
// suite (vitest, web/test/*) can't really catch: real navigation + global
// ⌘K + tab switching within a page. Follows the same pattern as
// autocomplete.spec.ts/screenshots.spec.ts — a single shared server
// (beforeAll), cheap specs, no pixel asserts.
// No rail: the navigation rail (Rail.tsx) was removed. The Board retired;
// its address is gone, so it is
// an unknown path — Home.
import { test, expect } from '@playwright/test'
import { startServer, agentRow, cleanupTempDirs, type E2EServer } from './helpers'

let srv: E2EServer

test.beforeAll(async () => {
  srv = await startServer()
})

test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})

test.beforeEach(async ({ page }) => {
  await page.goto(`${srv.url}/?token=${srv.token}`)
  await expect(page.getByText('Silos').first()).toBeVisible()
})

test('agent page: header, tabs of what is its own, its Profile tab (last, by name) is one flat page', async ({ page }) => {
  await page
    .getByRole('button', { name: agentRow('API') })
    .first()
    .click()
  // header: agent name as heading (h1), role visible on the mono line.
  await expect(page.locator('main').getByRole('heading', { name: 'API' })).toBeVisible()
  await expect(page.locator('main').getByText('Backend and infra').first()).toBeVisible()
  // the sectioned page: an index of the questions — never a
  // Conversations tab (the sidebar holds them) nor one tab per capability
  const index = page.locator('main').getByRole('navigation', { name: /sections/ })
  await expect(index.getByRole('button')).toHaveCount(10)
  for (const label of ['Conversations', 'Agent']) {
    await expect(page.locator('main').getByRole('button', { name: label, exact: true })).toHaveCount(0)
  }
  // no gear on the name (the gear is the platform's Settings)
  await expect(page.locator('main').getByRole('button', { name: "API's settings" })).toHaveCount(0)
  // its Profile tab, and the URL says so: ONE flat page — Mission, Who, then
  // Runs on — each card read first, its editor swapping in on its own "Edit"
  await index.getByRole('button', { name: /^Profile/ }).click()
  await expect(page).toHaveURL(/\/agent\/api\/settings$/)
  await expect(page.locator('main').getByRole('heading', { name: 'Who' })).toBeVisible()
  await expect(page.locator('main').getByRole('heading', { name: 'Runs on' })).toBeVisible()
  await page.locator('main #who').getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.locator('main').getByLabel('Name', { exact: true })).toHaveValue('API')
  await expect(page.locator('main').getByText('api', { exact: true })).toBeVisible()
  // what it runs on is edited in its own card, on the same page
  await page.locator('main').getByRole('button', { name: 'Edit what it runs on' }).click()
  await expect(page.locator('main').getByLabel('Folder', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/\/agent\/api\/settings$/)
  // its secrets are a tab of their own
  await index.getByRole('button', { name: /^Secrets/ }).click()
  await expect(page).toHaveURL(/\/agent\/api\/secrets$/)
  // what it produced lives in Files › Artifacts
  await index.getByRole('button', { name: /^Files/ }).click()
  await page
    .locator('main')
    .getByRole('button', { name: /^Artifacts$/ })
    .click()
  await expect(page.locator('main').getByRole('region', { name: 'Artifacts' })).toBeVisible()
})

// no aliases — a retired agent-settings address is an unknown path
test('agent settings: a retired address lands on Home and REPLACES itself', async ({ page }) => {
  const before = await page.evaluate(() => history.length)
  await page.goto(`${srv.url}/agent/api/settings/runs-on?token=${srv.token}`)
  await expect(page).toHaveURL(/^https?:\/\/[^/]+\/(\?.*)?$/)
  await expect(page.locator('main').getByRole('heading', { name: 'Runs on' })).toHaveCount(0)
  const after = await page.evaluate(() => history.length)
  // the goto itself is one entry; the canonical rewrite adds none
  expect(after).toBe(before + 1)
  await page.goBack()
  await expect(page).not.toHaveURL(/\/agent\/api\/settings\/runs-on/)
})

test('the Board retired: /board is an unknown path — it lands on Home and REPLACES itself', async ({ page }) => {
  // no aliases: an unknown path lands on Home; the rewrite adds no
  // history entry
  const before = await page.evaluate(() => history.length)
  await page.goto(`${srv.url}/board/conversations?view=waiting&token=${srv.token}`)
  await expect(page.locator('main').getByTestId('pulse')).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`^${srv.url}/(\\?.*)?$`))
  expect(await page.evaluate(() => history.length)).toBe(before + 1)
  await expect(page.locator('main').getByTestId('home-lenses').getByRole('button', { name: 'board', exact: true })).toHaveCount(0)
})

test('⌘K: opens, filters, and Enter navigates to the conversation', async ({ page }) => {
  await page.keyboard.press('Control+k')
  const dialog = page.getByRole('dialog', { name: 'Search conversations' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('textbox', { name: 'search', exact: true }).fill('Greeting helper')
  await expect(dialog.getByRole('option').first()).toContainText('Greeting helper')
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  await expect(page.locator('main').getByText('Greeting helper')).toBeVisible()
})

// no rail: ⌘K as universal navigator — "Skills" goes straight to the new
// Settings tab (previously only reachable from the removed rail).
test('⌘K: the "Skills" entry navigates to Settings with that tab active', async ({ page }) => {
  await page.keyboard.press('Control+k')
  const dialog = page.getByRole('dialog', { name: 'Search conversations' })
  await dialog.getByRole('option', { name: 'Settings › Skills' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.locator('main').getByRole('heading', { name: 'Settings' })).toBeVisible()
  await expect(page.locator('main').getByRole('button', { name: 'Skills', exact: true })).toHaveAttribute('aria-current', 'true')
})
