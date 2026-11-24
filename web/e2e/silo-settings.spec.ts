// silo-settings.spec.ts — the Silos page end to end against a REAL server: seedSilos (invoices active) plus
// seedSiloSettings — documents uninstalled three days ago with its manifest
// kept and its files still there (Home's growth line), helpdesk sitting in the
// registry never approved and with no submission. The walk: the growth line
// is a door → Settings › Silos paints the three groups → Reinstall… lands on
// the dialog → approving brings documents back → «Submit for approval…»
// does the same for helpdesk. Serial: the decisions change the server.
// Evidence screenshots in web/test-results/shots/silo-ux3/.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { startServer, cleanupTempDirs, type E2EServer, shotsDir } from './helpers'

const SHOTS_DIR = shotsDir('silo-ux3')
mkdirSync(SHOTS_DIR, { recursive: true })

let srv: E2EServer

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  srv = await startServer({ silos: true, siloSettings: true })
})

test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})

test.use({ viewport: { width: 1440, height: 900 } })

const shot = (page: Page, name: string, fullPage = false): Promise<Buffer> => page.screenshot({ path: join(SHOTS_DIR, name), fullPage })
const GROWTH = "4 records written to Documents's files since it was uninstalled — no silo shows them"

test("Home's doors to the silos: the growth line and the quiet «silos ›» line land on Settings › Silos; the pulse names open their page", async ({ page }) => {
  await page.goto(`${srv.url}/?token=${srv.token}`)
  const growth = page.getByTestId('silo-growth')
  await expect(growth.getByRole('button', { name: GROWTH })).toBeVisible()
  await shot(page, 'home-growth-line.png')
  // a silo in use says its term in Settings › Silos (reached from the date
  // line's «silos ›» — Home lists no silo tiles), the door to its page
  await page.getByTestId('home-silos-door').click()
  await expect(page.getByTestId('silo-installed-invoices')).toContainText('outstanding')
  await page.getByTestId('silo-installed-invoices').click()
  await expect(page).toHaveURL(/\/silo\/invoices$/)
  await page.goto(`${srv.url}/?token=${srv.token}`)
  await growth.getByRole('button', { name: GROWTH }).click()
  await expect(page).toHaveURL(/\/settings\/silos$/)
  await expect(page.getByRole('heading', { name: 'Silos', exact: true })).toBeVisible()
  // the standing door: the quiet line under the pulse
  await page.goto(`${srv.url}/?token=${srv.token}`)
  await page.getByTestId('home-silos-door').click()
  await expect(page).toHaveURL(/\/settings\/silos$/)
})

test("Settings › Silos is the inventory's one address; the old /silos is gone", async ({ page }) => {
  await page.goto(`${srv.url}/settings/silos?token=${srv.token}`)
  await expect(page).toHaveURL(/\/settings\/silos$/)
  await expect(page.getByRole('heading', { name: 'Silos', exact: true })).toBeVisible()
  await expect(page.getByTestId('silo-door-open')).toBeVisible()
  // no alias: an unknown path falls to Home
  await page.goto(`${srv.url}/silos?token=${srv.token}`)
  await expect(page.getByTestId('pulse')).toBeVisible()
})

test('the three groups, in plain words — each with the gesture it can actually take', async ({ page }) => {
  await page.goto(`${srv.url}/settings/silos?token=${srv.token}`)
  const main = page.locator('main')
  // one gallery: the state is each tile's name line
  await expect(main.getByTestId('silo-installed-invoices')).toBeVisible()
  await expect(main.locator('[data-testid^="silo-waiting-"]').first()).toContainText('Waiting for approval')
  await expect(main.locator('[data-testid^="silo-uninstalled-"]').first()).toContainText('Uninstalled')

  const invoices = main.getByTestId('silo-installed-invoices')
  await expect(invoices).toContainText('Active')
  await expect(invoices).toContainText('written by finance')

  // the recommended silos came installed at boot (Plans among them); the
  // optional ones Silos ships wait on offer (Support among them)
  await expect(main.getByTestId('silo-installed-plans')).toContainText('Active')
  await expect(main.getByTestId('silo-available-support')).toBeVisible()

  const support = main.getByTestId('silo-waiting-helpdesk')
  await expect(support).toContainText('Version 0.2.0 · nothing submitted yet')
  await expect(support.getByRole('button', { name: 'Submit for approval…' })).toBeVisible()

  const docs = main.getByTestId('silo-uninstalled-documents')
  await expect(docs).toContainText('Uninstalled 3d ago')
  await expect(docs).toContainText('4 files stay on disk, with your overlay and the journal')
  await expect(docs).toContainText('finance kept writing: 4 new since')
  await expect(docs.getByRole('button', { name: 'Reinstall 0.1.0…' })).toBeVisible()
  await shot(page, 'settings-silos.png', true)

  // dark, same page
  await page.evaluate(() => localStorage.setItem('silos-dark', '1'))
  await page.reload()
  await expect(main.locator('[data-testid^="silo-uninstalled-"]').first()).toBeVisible()
  await shot(page, 'settings-silos-dark.png', true)
  await page.evaluate(() => localStorage.setItem('silos-dark', '0'))

  // an installed row opens its page
  await page.reload()
  await invoices.click() // the tile is the door
  await expect(page).toHaveURL(/\/silo\/invoices$/)
})

test('Reinstall… lands on the dialog; approving brings documents back and the growth line leaves Home', async ({ page }) => {
  await page.goto(`${srv.url}/settings/silos?token=${srv.token}`)
  const main = page.locator('main')
  await main.getByTestId('silo-uninstalled-documents').getByRole('button', { name: 'Reinstall 0.1.0…' }).click()
  await expect(page).toHaveURL(/\/silo\/documents\/review$/)
  await expect(main.getByRole('heading', { name: 'Reinstall Documents 0.1.0?' })).toBeVisible()
  await shot(page, 'review-documents-reinstall.png', true)

  // the submission waits now: Settings says so and offers the dialog, never a second submission
  await page.goto(`${srv.url}/settings/silos?token=${srv.token}`)
  const docs = main.getByTestId('silo-uninstalled-documents')
  await expect(docs).toContainText('0.1.0 waits for your approval — submitted by you')
  await docs.getByRole('button', { name: 'Review…' }).click()
  await expect(page).toHaveURL(/\/silo\/documents\/review$/)

  await expect(main.getByRole('button', { name: 'Reinstall Documents' })).toBeEnabled()
  await main.getByRole('button', { name: 'Reinstall Documents' }).click()
  await expect(page).toHaveURL(/\/silo\/documents$/)

  await page.goto(`${srv.url}/settings/silos?token=${srv.token}`)
  await expect(main.getByTestId('silo-installed-documents')).toContainText('Active')
  await expect(main.locator('[data-testid^="silo-uninstalled-"]')).toHaveCount(0)

  await page.goto(`${srv.url}/?token=${srv.token}`)
  await expect(page.getByRole('heading', { level: 1 }).or(page.getByTestId('pulse')).first()).toBeVisible()
  await expect(page.getByTestId('silo-growth')).toHaveCount(0)
})

test("«Submit for approval…» puts the registry's manifest through the dialog", async ({ page }) => {
  await page.goto(`${srv.url}/settings/silos?token=${srv.token}`)
  const main = page.locator('main')
  await main.getByTestId('silo-waiting-helpdesk').getByRole('button', { name: 'Submit for approval…' }).click()
  await expect(page).toHaveURL(/\/silo\/helpdesk\/review$/)
  // a manifest that sat pending in the registry is an install, not «an update of itself»
  await expect(main.getByRole('heading', { name: 'Install Helpdesk 0.2.0?' })).toBeVisible()
  await shot(page, 'review-support-submitted.png', true)
})

test('Settings › Silos at phone width (400px)', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 860 } })
  const page = await ctx.newPage()
  await page.goto(`${srv.url}/settings/silos?token=${srv.token}`)
  await expect(page.locator('main').getByTestId('silo-installed-invoices')).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  await shot(page, 'settings-silos-phone.png', true)
  await ctx.close()
})

// ── the catalog and the door (a repo of silos) ────────

test('the optional silos Silos ships are on offer while held nowhere; Install… lands on the review dialog', async ({ page }) => {
  await page.goto(`${srv.url}/settings/silos?token=${srv.token}`)
  const main = page.locator('main')
  // a recommended silo is installed at boot, never on offer; a silo of the
  // owner's own (invoices, installed) is not Silos' to offer
  await expect(main.getByTestId('silo-available-plans')).toHaveCount(0)
  await expect(main.getByTestId('silo-available-invoices')).toHaveCount(0)
  for (const id of ['support', 'hierarchy', 'executions', 'heather']) await expect(main.getByTestId(`silo-available-${id}`)).toBeVisible()
  await shot(page, 'settings-silos-available.png', true)
  await main.getByTestId('silo-available-hierarchy').getByRole('button', { name: 'Install…' }).click()
  await expect(page).toHaveURL(/\/silo\/hierarchy\/review$/)
  await expect(page.getByRole('button', { name: /Install Hierarchy/ })).toBeVisible()
  await shot(page, 'available-install-review.png', true)
})

test("the «Install a silo…» door: a JSON typo is said in place, the validator's words come back, a valid paste lands on the dialog", async ({ page }) => {
  await page.goto(`${srv.url}/settings/silos?token=${srv.token}`)
  const main = page.locator('main')
  await main.getByTestId('silo-door-open').click()
  const text = main.getByTestId('silo-door-text')
  await text.fill('{nope')
  await main.getByTestId('silo-door-submit').click()
  await expect(main.getByTestId('silo-door-error')).toContainText('That is not JSON yet')
  // valid JSON, invalid manifest: the server's exact words, in place
  await text.fill('{"apiVersion": "silo-standard/v0", "metadata": {"id": "door-e2e"}}')
  await main.getByTestId('silo-door-submit').click()
  await expect(main.getByTestId('silo-door-error')).toBeVisible()
  await shot(page, 'door-validator-words.png')
  // the real plans manifest pasted under the id of a dimension that never
  // becomes a silo (memories — part of the engine; no dimension
  // is native any more) — the server's refusal comes back in place, nothing
  // submitted
  const plans = await (
    await import('node:fs/promises')
  ).readFile(join(import.meta.dirname, '..', '..', 'docs', 'standard', 'reference', 'plans.silo.json'), 'utf8')
  const asNative = JSON.parse(plans) as { metadata: { id: string } }
  asNative.metadata.id = 'memories'
  await text.fill(JSON.stringify(asNative))
  await main.getByTestId('silo-door-submit').click()
  await expect(main.getByTestId('silo-door-error')).toHaveText(
    "Memories is part of the engine — Silos reads it from the engine's own files; it never becomes a silo",
  )
  // the same manifest under a non-native id → the review dialog
  const roadmap = JSON.parse(plans) as { metadata: { id: string; name: string } }
  roadmap.metadata.id = 'roadmap'
  roadmap.metadata.name = 'Roadmap'
  await text.fill(JSON.stringify(roadmap))
  await main.getByTestId('silo-door-submit').click()
  await expect(page).toHaveURL(/\/silo\/roadmap\/review$/)
  await shot(page, 'door-pasted-review.png', true)
})

// a recommended silo the owner removed: where its feature lived, a quiet
// door says so and lands on its installer (last: it changes the server)
test('Plans uninstalled: Tasks shows the quiet door, and it lands on the review dialog', async ({ page }) => {
  const r = await fetch(`${srv.url}/api/silos/plans/uninstall`, {
    method: 'POST',
    headers: { 'x-token': srv.token, 'content-type': 'application/json' },
    body: '{}',
  })
  expect(r.status).toBe(200)
  await page.goto(`${srv.url}/tasks?token=${srv.token}`)
  const door = page.locator('main').getByTestId('silo-door-plans')
  await expect(door).toBeVisible()
  await shot(page, 'tasks-plans-door.png')
  await door.getByRole('button').click()
  await expect(page).toHaveURL(/\/silo\/plans\/review$/)
})
