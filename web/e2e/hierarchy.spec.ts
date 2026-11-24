// hierarchy.spec.ts — the hierarchy against a REAL seeded server (helpers
// seedTasks + seedTaskMode + seedHierarchy): the hierarchy silo installed
// from its reference manifest with a drawn chart, and one task of Web's that
// escalated to the owner. HOME and TMPDIR isolated (stubClaude), task wakes
// off — no turn ever runs.
//   map org     Map gains its fourth toggle «Org» and draws the chart, read-only
//   silo page   the tree is the editor: «Reports to · Change» moves an agent
//   lens        Tasks opens grouped by team, the floor above, off in one click
//   needs you   the escalated task is one blocking row with the door to it
// Evidence screenshots under context/silos/phase4-shots/ when SILOS_SHOTS=1.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { startServer, cleanupTempDirs, openNeedsYou, type E2EServer } from './helpers'

const SHOTS = process.env.SILOS_SHOTS ? join(import.meta.dirname, '..', '..', 'context', 'silos', 'phase4-shots') : null
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

let srv: E2EServer

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  srv = await startServer({ taskMode: true, executions: true, hierarchy: true, stubClaude: true })
})
test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})
test.use({ viewport: { width: 1440, height: 900 } })

async function shot(page: Page, name: string, fullPage = false): Promise<void> {
  if (!SHOTS) return
  await page.waitForTimeout(400)
  if (fullPage) {
    // the view scrolls inside its own pane: let it grow so the whole page is drawn
    await page.setViewportSize({ width: 1440, height: 2200 })
    await page.waitForTimeout(300)
  }
  await page.screenshot({ path: join(SHOTS, name) })
  if (fullPage) await page.setViewportSize({ width: 1440, height: 900 })
}
const go = (page: Page, path: string): Promise<unknown> => page.goto(`${srv.url}${path}${path.includes('?') ? '&' : '?'}token=${srv.token}`)

test('Map › Org: its toggle draws the chart, read-only', async ({ page }) => {
  await go(page, '/map')
  await expect(page.getByRole('tab', { name: 'Org' })).toBeVisible()
  await page.getByRole('tab', { name: 'Org' }).click()
  await expect(page).toHaveURL(/\/map\/org/)
  const tree = page.getByTestId('org-tree')
  await expect(tree.locator('[data-agent="writer"]')).toBeVisible()
  await expect(tree.getByRole('button', { name: 'Change', exact: true })).toHaveCount(0)
  await expect(tree.getByText('change who reports to whom')).toBeVisible()
  await shot(page, 'map-org.png')
})

test('the silo page: the tree is the editor, and a loop is refused in words', async ({ page }) => {
  await go(page, '/silo/hierarchy')
  const tree = page.getByTestId('org-tree')
  await expect(tree.locator('[data-agent="web"]')).toContainText('Reports to Writer')
  await expect(page.getByTestId('escalation-panel')).toContainText('site-ops#o1')
  await shot(page, 'silo-tree.png')
  // Support joins Builder's team
  // Support stands on its own: a chip in the cluster; it joins Builder's team
  await tree.getByTestId('org-loners').locator('[data-agent="support"] button[aria-pressed]').click()
  await tree.getByLabel('Reports to').selectOption('builder')
  await tree.getByRole('button', { name: 'Save' }).click()
  await expect(tree.locator('li[data-agent="support"]')).toContainText('Reports to Builder')
  await shot(page, 'silo-tree-changed.png')
  // the picker never offers what would close a loop
  const builder = tree.locator('[data-agent="builder"]')
  await builder.getByRole('button', { name: 'Change', exact: true }).click()
  await expect(builder.getByLabel('Reports to').locator('option[value="writer"]')).toHaveCount(0)
})

test('Tasks: the lens groups by team, the floor stays above, off in one click', async ({ page }) => {
  await go(page, '/tasks')
  await page.getByTestId('preset-open').click()
  await expect(page.getByTestId('lens-chip')).toContainText('Lens: by team')
  const floor = page.getByTestId('lens-floor')
  await expect(floor.locator('[data-task="site-ops#o1"]')).toBeVisible()
  await expect(page.locator('[data-testid="lens-group"][data-group="builder"]')).toBeVisible()
  await shot(page, 'tasks-lens-list.png')
  await page.locator('[data-testid="lens-group"][data-group="builder"] > button').click()
  await shot(page, 'tasks-lens-list-open.png', true)
  await page.getByTestId('layout-board').click()
  await shot(page, 'tasks-lens-board.png', true)
  await page.getByTestId('layout-tree').click()
  await shot(page, 'tasks-lens-tree.png', true)
  await page.getByTestId('layout-list').click()
  await page.getByRole('button', { name: 'Turn the lens off' }).click()
  await expect(page.getByTestId('lens-body')).toHaveCount(0)
  await expect(page.getByTestId('lens-chip')).toContainText('Group by team')
  await page.getByTestId('lens-chip').click()
  await expect(page.getByTestId('lens-body')).toBeVisible()
})

test('Needs you: the escalated task, blocking, with the door to it', async ({ page }) => {
  await go(page, '/')
  const region = await openNeedsYou(page)
  const row = region.getByText('site-ops#o1 stalled since')
  await expect(row).toBeVisible()
  await expect(region.getByText(/asked Writer, then Builder; nobody moved it/)).toBeVisible()
  await shot(page, 'needs-you-escalated.png')
})

test.describe('installing it from the catalog', () => {
  let fresh: E2EServer
  test.beforeAll(async () => {
    fresh = await startServer({ tasks: true, stubClaude: true })
  })
  test.afterAll(async () => {
    await fresh.stop()
  })
  test('Available → the review dialog says nobody writes it → installed with no edges, every agent on its own', async ({ page }) => {
    await page.goto(`${fresh.url}/settings/silos?token=${fresh.token}`)
    const main = page.locator('main')
    await main.getByTestId('silo-available-hierarchy').getByRole('button', { name: 'Install…' }).click()
    await expect(page).toHaveURL(/\/silo\/hierarchy\/review$/)
    await expect(main.getByText(/Nobody writes it but you/)).toBeVisible()
    await shot(page, 'install-review.png')
    await page.getByRole('button', { name: /Install Hierarchy/ }).click()
    await page.goto(`${fresh.url}/silo/hierarchy?token=${fresh.token}`)
    // one org per project: here every agent is alone in its project,
    // so there is no org to draw — said once, and each one named quietly
    await expect(page.getByTestId('org-by-project')).toContainText('No project has two agents yet')
    await expect(page.getByTestId('org-solo')).toContainText('Web in')
    await shot(page, 'installed-empty.png')
  })
})
