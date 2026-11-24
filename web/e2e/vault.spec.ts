// vault.spec.ts — the Vault page (/vault) against a real server with a
// seeded keyring (helpers.ts seedVault): the rail's key opens it, the
// ledger groups a name collision and says who wins, search narrows it, and Settings
// does not list it. Also the evidence screenshots for the frontend-design pass (light/dark desktop + ~400px).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, startServer, cleanupTempDirs, type E2EServer, shotsDir } from './helpers'

const SHOTS_DIR = shotsDir('vault-ux')
mkdirSync(SHOTS_DIR, { recursive: true })

let srv: E2EServer

test.beforeAll(async () => {
  srv = await startServer()
})

test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})

test('System › Vault opens /vault: pulse line, collision group, override in plain words', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await page.goto(`${srv.url}/?token=${srv.token}`)
  // the rail's one door to the machine, then its Vault tab
  await page.locator('aside').getByLabel('System', { exact: true }).click()
  await page.getByRole('tab', { name: 'Vault' }).click()
  await expect(page).toHaveURL(/\/vault$/)
  // the pulse line is composed of real counts
  await expect(page.getByText('10 secrets — 2 for every agent · 1 for a project · 7 for agents')).toBeVisible()
  // the GITHUB_TOKEN collision: group caption + the shadowed global
  await expect(page.getByText('GITHUB_TOKEN')).toBeVisible()
  await expect(page.getByText('2 entries — the most specific wins').first()).toBeVisible()
  await expect(page.getByText(/except Agent · .*API/)).toBeVisible()
  await page.screenshot({ path: join(SHOTS_DIR, 'vault-desktop-light.png') })

  // a row expands in place — the delete names who loses it
  await page.getByRole('button', { name: /STRIPE_KEY/ }).click()
  await expect(page.getByText('Reaches API.')).toBeVisible()
  await page.getByRole('button', { name: 'delete STRIPE_KEY' }).click()
  await expect(page.getByText('API loses it — sure?')).toBeVisible()
  await page.screenshot({ path: join(SHOTS_DIR, 'vault-row-expanded.png') })

  // search narrows by what the visibility names
  await page.getByLabel('search the vault').fill('sentry')
  await expect(page.getByText('SENTRY_DSN')).toBeVisible()
  await expect(page.getByText('STRIPE_KEY')).toBeHidden()
  await context.close()
})

test('an entry is marked «Not a secret» in place: its value shows in clear, and back', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await page.goto(`${srv.url}/vault?token=${srv.token}`)
  await expect(page.getByText('https://fake@sentry/e2e-2')).toBeHidden()
  await page.getByRole('button', { name: /…2e-2.*UX/ }).click()
  await page.getByRole('radio', { name: 'Not a secret' }).click()
  await expect(page.getByText('https://fake@sentry/e2e-2')).toBeVisible()
  await expect(page.getByText('· not a secret')).toBeVisible()
  await page.screenshot({ path: join(SHOTS_DIR, 'vault-not-a-secret.png') })
  await page.getByRole('radio', { name: 'Secret', exact: true }).click()
  await expect(page.getByText('https://fake@sentry/e2e-2')).toBeHidden()
  await context.close()
})

test('the composer leads with visibility and lands the new row', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await page.goto(`${srv.url}/vault?token=${srv.token}`)
  await page.getByRole('button', { name: /Add a secret/ }).click()
  await page.getByRole('radio', { name: 'One project' }).click()
  await page.getByLabel('new secret project').selectOption({ index: 1 })
  await page.getByLabel('secret name').fill('DEPLOY_KEY')
  await page.getByLabel('secret value').fill('fake-e2e-value')
  await page.screenshot({ path: join(SHOTS_DIR, 'vault-composer.png') })
  await page.getByRole('button', { name: 'Add to vault' }).click()
  await expect(page.getByText('DEPLOY_KEY')).toBeVisible()
  await expect(page.getByText('11 secrets', { exact: false })).toBeVisible()
  await context.close()
})

test('Settings does not list the Vault — it is its own page', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await page.goto(`${srv.url}/settings?token=${srv.token}`)
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Settings sections' }).getByText('Vault')).toHaveCount(0)
  await context.close()
})

test('dark desktop — evidence screenshot', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addInitScript(() => {
    window.localStorage.setItem('silos-dark', '1')
  })
  const page = await context.newPage()
  await page.goto(`${srv.url}/vault?token=${srv.token}`)
  await expect(page.getByText('GITHUB_TOKEN')).toBeVisible()
  await page.getByRole('button', { name: /RAILWAY_TOKEN/ }).click()
  // reach names follow the roster's order (UX before API in the seed)
  await expect(page.getByText('Reaches UX + API.')).toBeVisible()
  await page.screenshot({ path: join(SHOTS_DIR, 'vault-desktop-dark.png') })
  await context.close()
})

test('mobile 400px — the ledger wraps, nothing scrolls sideways', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 400, height: 844 } })
  const page = await context.newPage()
  await page.goto(`${srv.url}/vault?token=${srv.token}`)
  await expect(page.getByText('GITHUB_TOKEN')).toBeVisible()
  // no horizontal overflow on the page body
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  await page.screenshot({ path: join(SHOTS_DIR, 'vault-mobile-light.png') })
  await page.getByRole('button', { name: /STRIPE_KEY/ }).click()
  await expect(page.getByText('Reaches API.')).toBeVisible()
  await page.screenshot({ path: join(SHOTS_DIR, 'vault-mobile-expanded.png') })
  await context.close()
})
