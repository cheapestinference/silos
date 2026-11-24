// dossier.spec.ts — the agent dossier's Identity facet against seeded
// autonomy state (helpers.ts: seedAutonomy — a real responsibility in
// agents.json, a real standing runmode.json + status.json under the
// harness's agent-state dir, and the materialized auto-resp-<id>
// automation). Everything the page shows traces to those files — the
// harness makes no real SDK calls (autonomy-view.ts just reads them back).
// The page's head is the MISSION: the seeded duty is
// never shown (neither on the page nor in the conversation's column) and the
// owner writes a mission in place.
import { test, expect } from '@playwright/test'
import { startServer, agentRow, cleanupTempDirs, type E2EServer, AUTONOMY_RESPONSIBILITY } from './helpers'

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

test('Profile: the mission heads the page — the old duty is never shown; the owner writes one in place', async ({ page }) => {
  await page
    .getByRole('button', { name: agentRow('Autonomy') })
    .first()
    .click()
  const main = page.locator('main')
  await main
    .getByRole('navigation', { name: /sections/ })
    .getByRole('button', { name: /^Profile/ })
    .click()

  // the head of Profile is the mission; the seeded
  // responsibility (the old duty) is never shown
  await expect(main.getByTestId('mission-empty')).toBeVisible()
  await expect(main.getByText(AUTONOMY_RESPONSIBILITY)).toHaveCount(0)
  await main.getByRole('button', { name: 'Write what Autonomy takes care of ›' }).click()
  await expect(main.getByText('New conversations will use it.')).toBeVisible()
  await main.getByLabel('What Autonomy takes care of').fill('Keep the payment queue healthy.\nNever: refund anyone')
  await main.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(main.getByTestId('mission-read')).toContainText('Keep the payment queue healthy.')
  await expect(main.getByTestId('mission-never')).toContainText('Never: refund anyone')

  // the sectioned page: an index in the read-first order —
  // Now · Messages · Automations · Files · Memory · Skills · Tools · Secrets · At start · Profile, and
  // At start is what its conversations really started with, measured
  const index = main.getByRole('navigation', { name: /sections/ })
  const labels = (await index.getByRole('button').allTextContents()).map((t) => t.replace(/[\d≈.k·\s]+$/, '').trim())
  expect(labels).toEqual(['Now', 'Messages', 'Automations', 'Files', 'Memory', 'Skills', 'Tools', 'Secrets', 'At start', 'Profile'])
  await expect(index.getByRole('button', { name: /^Profile/ })).toHaveAttribute('aria-current', 'page')
  await index.getByRole('button', { name: /^At start/ }).click()
  await expect(main.getByText(/Nothing measured for/)).toBeVisible() // the seed has no measured start: one sentence, never an estimate
  await index.getByRole('button', { name: /^Memory/ }).click()
  await expect(main.getByTestId('knows-library')).toBeVisible()
})

test('ContextColumn: a conversation of that agent names its mission, never the old duty', async ({ page }) => {
  await page.request.patch(`${srv.url}/api/agents/autonomy?token=${srv.token}`, {
    data: { mission: { text: 'Keep the payment queue healthy. Weekly.', never: [] } },
  })
  await page.reload()
  await page
    .getByRole('button', { name: agentRow('Autonomy') })
    .first()
    .click()
  await page
    .locator('aside')
    .first()
    .getByText(/Payment queue watch/)
    .first()
    .click()

  const column = page.getByRole('complementary').last() // context column <aside>
  await expect(column.getByRole('button', { name: 'Open mission' })).toContainText('Keep the payment queue healthy.')
  await expect(column.getByText(/Check-in/)).toHaveCount(0)
  await expect(column.getByText(AUTONOMY_RESPONSIBILITY)).toHaveCount(0)
})
