// nav-menu.spec.ts — global navigation menu (Home · Automations · Support…,
// pinned above the sidebar; the Map left it and is a lens on
// Home's date line and ⌘K; the Board retired) + a project's Map. Real smoke test in Chromium over the
// seeded harness (helpers.ts), with evidence screenshots 1440x900 in
// web/test-results/shots/nav-menu/.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { startServer, agentRow, cleanupTempDirs, type E2EServer, shotsDir } from './helpers'

const SHOTS_DIR = shotsDir('nav-menu')
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

test("the pinned global menu lives above the sidebar and navigates; the Map's views are Home's lenses", async ({ page }) => {
  const aside = page.locator('aside')
  // icon-only entries, always visible; Automations has its own entry again
  // — it left the sidebar's tree for one row per agent.
  await expect(aside.getByLabel('Home', { exact: true }).filter({ visible: true })).toBeVisible()
  await expect(aside.getByLabel('Automations', { exact: true })).toBeVisible()
  // the rail diet: Board and Map are
  // not rail doors; their pages stay, opened from Home's date line.
  await expect(aside.getByLabel('Board', { exact: true })).toHaveCount(0)
  await expect(aside.getByLabel('Map', { exact: true })).toHaveCount(0)
  const lenses = page.locator('main').getByTestId('home-lenses')
  // the Board retired into Home: no «board» lens
  await expect(lenses.getByRole('button', { name: 'board', exact: true })).toHaveCount(0)
  await expect(lenses.getByRole('button', { name: 'map', exact: true })).toBeVisible()
  // Uses IS the Map since the Wiring view retired: one word
  for (const gone of ['uses', 'graph', 'wiring']) await expect(lenses.getByRole('button', { name: gone, exact: true })).toHaveCount(0)
  // Settings is NOT in the menu: it stays in its own gear icon at the bottom
  await expect(aside.getByLabel('Settings')).toBeVisible()
  // screenshot (a): the sidebar with the global menu on top
  await page.screenshot({ path: join(SHOTS_DIR, 'sidebar-menu-global.png') })

  // the entry opens /automations, unfiltered, and reads active
  await aside.getByLabel('Automations', { exact: true }).click()
  await expect(page).toHaveURL(/\/automations$/)
  await expect(aside.getByLabel('Automations', { exact: true })).toHaveAttribute('aria-current', 'true')

  // an agent's automations are ONE small ⚡ on the agent's own row —
  // never a row of their own, never the automations or their runs;
  // it says whose it is, and lands on the page narrowed to that agent — the
  // title stays «Automations», the agent is its removable chip.
  const glyph = aside.getByTestId('automations-glyph').first()
  await expect(glyph).toBeVisible()
  await expect(glyph).toHaveAttribute('aria-label', /^.+'s automations: \d+ automations?/)
  await expect(aside.getByTestId('automations-row')).toHaveCount(0)
  await expect(aside.getByTestId('automation-node')).toHaveCount(0)
  await glyph.click()
  await expect(page).toHaveURL(/\/automations\?agent=[^&]+$/)
  await expect(page.locator('main h1')).toHaveText('Automations')
  await expect(page.locator('main').getByRole('button', { name: 'clear Agent filter' })).toBeVisible()
  await page.screenshot({ path: join(SHOTS_DIR, 'sidebar-automations-glyph.png') })

  // the lenses still open their pages: Home's line → the Map (Uses)
  await aside.getByLabel('Home', { exact: true }).filter({ visible: true }).click()
  await expect(page).toHaveURL(new RegExp(`^${srv.url}/(\\?.*)?$`))
  await lenses.getByRole('button', { name: 'map', exact: true }).click()
  await expect(page).toHaveURL(/\/map$/)
  await expect(page.locator('main').getByRole('tab', { name: 'Uses' })).toHaveAttribute('aria-selected', 'true')
  // and ⌘K lists the Map by name — and no Board any more
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Search conversations' })
  await palette.getByRole('textbox', { name: 'search' }).fill('board')
  await expect(palette.getByRole('option', { name: 'Board', exact: true })).toHaveCount(0)
  await palette.getByRole('textbox', { name: 'search' }).fill('map')
  await expect(palette.getByRole('option', { name: 'Map', exact: true })).toBeVisible()
})

test('a project page: the Home scoped to the folder under its Now tab, its Map a tab of its own', async ({ page }) => {
  // the project folder is a random tmpdir — read it from the title of the
  // API agent row (AgentItem title={agent.folder}) and build the deep-link.
  const folder = await page
    .getByRole('button', { name: agentRow('API') })
    .first()
    .getAttribute('title')
  expect(folder).toBeTruthy()
  const enc = encodeURIComponent(folder as string)

  // the project page lands on Now — the Home scoped to the folder: its
  // agent and not the unrelated one; the folder's own tabs above it
  await page.goto(`${srv.url}/project/${enc}?token=${srv.token}`)
  const main = page.locator('main')
  await expect(main.getByRole('navigation', { name: 'Project sections' }).getByRole('button', { name: 'Now', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  )
  await expect(main.getByRole('button', { name: /API/ }).first()).toBeVisible()
  await expect(main.getByRole('button', { name: /^UX/ })).toHaveCount(0)

  // a retired tab name is gone, not aliased: it falls to Home
  await page.goto(`${srv.url}/project/${enc}/board?token=${srv.token}`)
  await expect.poll(() => new URL(page.url()).pathname).toBe('/')

  // the project's Map: Uses, counted for the folder alone
  await page.goto(`${srv.url}/project/${enc}/map?token=${srv.token}`)
  await expect(main.getByRole('tab', { name: 'Uses' })).toHaveAttribute('aria-selected', 'true')
  await expect(main.getByTestId('uses-summary')).toBeVisible()
  await page.screenshot({ path: join(SHOTS_DIR, 'project-map-scoped.png') })
})

test('mobile: the phone lands on Home; the list is one tap away and Home is one tap back', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  // beforeEach loaded '/' at desktop width; reload at phone width = a cold open
  await page.goto(`${srv.url}/?token=${srv.token}`)
  const main = page.locator('main')
  const aside = page.locator('aside')
  await expect(main.getByTestId('pulse')).toBeVisible()
  await expect(aside).toBeHidden()
  // lenses are desk tools: the date line hides them on a phone
  await expect(main.getByTestId('home-lenses')).toBeHidden()
  // Home's ‹ is the list, not "back" (nothing came before Home)
  await main.getByRole('button', { name: 'agents and conversations' }).click()
  await expect(aside.getByLabel('Home', { exact: true }).filter({ visible: true })).toBeVisible()
  await expect(main).toBeHidden()
  // the rail's Home brings the page back, never the bare list
  await aside.getByLabel('Home', { exact: true }).filter({ visible: true }).click()
  await expect(main.getByTestId('pulse')).toBeVisible()
  // opening a page then browser-back to '/' lands on Home again
  await main.getByRole('button', { name: 'agents and conversations' }).click()
  await aside.getByLabel('Automations', { exact: true }).click()
  await expect(page).toHaveURL(/\/automations$/)
  await page.goBack()
  await expect(main.getByTestId('pulse')).toBeVisible()
})

test('mobile: the Map (deep-linked) has a back button to the list (a way back)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  // standalone Map at full screen (mobile hides the sidebar): the back button returns
  await page.goto(`${srv.url}/map?token=${srv.token}`)
  const backMap = page.locator('main').getByLabel('back')
  await expect(backMap).toBeVisible()
  await backMap.click()
  await expect(page.locator('aside').getByLabel('Automations', { exact: true })).toBeVisible()
})
