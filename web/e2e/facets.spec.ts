// facets.spec.ts — Automations against a real Silos: one list without
// facets (the Board, the FacetBar's conversation surface,
// retired) — with evidence
// screenshots 1440x900 in web/test-results/shots/facet-filter/. Data:
// seedRichData (API/UX agents with sessions), seedFacets (Ops agent, 9 topics
// across two cwds with tools and staggered mtimes), and seedAutomations
// (scheduled/paused/watching buckets) — all seeded, nothing calls the SDK.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { startServer, cleanupTempDirs, type E2EServer, shotsDir } from './helpers'

const SHOTS_DIR = shotsDir('facet-filter')
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

test.beforeEach(async ({ page }) => {
  await page.goto(`${srv.url}/?token=${srv.token}`)
  await expect(page.getByText('Silos').first()).toBeVisible()
})

test('Automations: one list grouped by agent — no Board lens, no facets', async ({ page }) => {
  // /automations is the page's address (the global menu's Automations entry).
  await page.goto(`${srv.url}/automations?token=${srv.token}`)
  const main = page.locator('main')
  await expect(main.getByTestId('automations-list')).toBeVisible()
  const list = main.getByTestId('automations-list')
  for (const name of ['Weekly digest', 'Morning standup', 'Deploy webhook']) {
    // several agents: a tile each, the automation named in its preview
    await expect(list.locator('[data-testid^="automations-group-"]').filter({ hasText: name })).toHaveCount(1)
  }
  // the seeded failed run leads the page, with its reason (none recorded)
  await expect(main.getByTestId('automations-needs-a-look')).toContainText('Weekly digest')
  await expect(main.getByTestId('automations-needs-a-look')).toContainText('no reason recorded')
  await expect(main.getByLabel('filter by state')).toHaveCount(0)
  await expect(main.getByRole('tab', { name: 'Board' })).toHaveCount(0)
  await page.screenshot({ path: join(SHOTS_DIR, 'automations-one-list.png') })
})
