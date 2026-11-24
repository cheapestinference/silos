// digest.spec.ts — the daily digest band on Home
// against a REAL server: the harness seeds two unread digest files
// (yesterday's and today's — the job itself is off, SILOS_NO_DIGEST); Home
// sums them into ONE band titled by where it starts; Seen posts the newest
// date and the band stays gone after a reload. Settings › Notifications
// shows the doorbell and the digest hour in place of the old checkbox.
// Serial: Seen changes the server. Evidence shots in
// web/test-results/shots/needs-you/ when SILOS_SHOTS=1.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { startServer, cleanupTempDirs, openDigest, type E2EServer, shotsDir } from './helpers'

const SHOTS = process.env.SILOS_SHOTS ? shotsDir('needs-you') : null
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

let srv: E2EServer

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  srv = await startServer({ digests: true })
})
test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return
  await page.screenshot({ path: join(SHOTS, name), maskColor: '#8f8d86', mask: [page.getByRole('button', { name: 'Settings' }).locator('xpath=..')] })
}

test('GET /api/digest sums the two unread digests', async () => {
  const body = (await (await fetch(`${srv.url}/api/digest?token=${srv.token}`)).json()) as {
    hour: string
    band: { dates: string[]; happened: { conversations: Array<{ agentId: string; count: number }>; planTasksDone: number } }
  }
  expect(body.hour).toBe('08:00')
  expect(body.band.dates).toHaveLength(2)
  expect(body.band.happened.conversations).toEqual([
    expect.objectContaining({ agentId: 'ux', count: 6 }),
    expect.objectContaining({ agentId: 'api', count: 3 }),
  ])
  expect(body.band.happened.planTasksDone).toBe(2)
})

test.describe('phone', () => {
  test.use({ viewport: { width: 400, height: 860 } })

  test('the band reads at 400 px, no sideways scroll', async ({ page }) => {
    // measured at rest: the sheet slides in from the right (sheet-in)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto(`${srv.url}/?token=${srv.token}`)
    const band = await openDigest(page)
    await expect(band).toBeVisible()
    const box = await band.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(16)
    expect(box!.x + box!.width).toBeLessThanOrEqual(400 - 16)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(400)
    await shot(page, 'home-digest-band-phone.png')
  })

  test('Settings › Notifications fits too', async ({ page }) => {
    await page.goto(`${srv.url}/settings/notifications?token=${srv.token}`)
    await expect(page.getByLabel('Morning digest')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(400)
    await shot(page, 'settings-notifications-phone.png')
  })
})

test.describe('dark', () => {
  test.use({ viewport: { width: 1180, height: 760 }, colorScheme: 'dark' })

  test('the band in the dark theme', async ({ page }) => {
    await page.goto(`${srv.url}/?token=${srv.token}`)
    await expect(await openDigest(page)).toBeVisible()
    await shot(page, 'home-digest-band-dark.png')
    await page.goto(`${srv.url}/settings/notifications?token=${srv.token}`)
    await expect(page.getByLabel('Morning digest')).toBeVisible()
    await shot(page, 'settings-notifications-dark.png')
  })
})

test.describe('desk', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('Home: one summed band under the pulse — what waited, what happened, what is coming', async ({ page }) => {
    await page.goto(`${srv.url}/?token=${srv.token}`)
    const band = await openDigest(page)
    await expect(band).toBeVisible()
    await expect(band.getByRole('heading')).toHaveText(/^Since \S+ 08:00$/)
    // the band folds 'what waited' and 'what is coming' behind all › (92a097ec)
    await band.getByRole('button', { name: 'all ›' }).click()
    await expect(band).toContainText('At 08:00 two things needed you (1 blocking) — the oldest since')
    await expect(band).toContainText('9 conversations of yours finished')
    await expect(band).toContainText('ran 24 times')
    await expect(band).toContainText('1 failed and recovered on its own')
    await expect(band).toContainText('2 plan tasks done.')
    await expect(band).toContainText('Nothing falls due in the next 7 days.')
    await shot(page, 'home-digest-band.png')
  })

  test('Settings › Notifications: this device with its honest reason, the digest hour, no old checkbox', async ({ page }) => {
    // the headless shell answers «denied» to every notification permission —
    // exactly the case the row must name instead of a dead switch (Turn on /
    // test / revoke run against a fake browser in
    // web/test/notifications-tab.test.tsx; a real push can't run in CI)
    await page.goto(`${srv.url}/settings/notifications?token=${srv.token}`)
    await expect(page.getByText('This device')).toBeVisible()
    await expect(page.getByText(/Notifications are blocked for this site/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Turn on' })).toHaveCount(0)
    await expect(page.getByLabel('Morning digest')).toHaveValue('08:00')
    await expect(page.getByLabel('Browser notifications')).toHaveCount(0)
    await shot(page, 'settings-notifications.png')
  })

  test('Seen: the band leaves and stays gone after a reload', async ({ page }) => {
    await page.goto(`${srv.url}/?token=${srv.token}`)
    const band = await openDigest(page)
    await expect(band).toBeVisible()
    await band.getByRole('button', { name: 'Seen' }).click()
    await expect(band).toHaveCount(0)
    await page.reload()
    await expect(page.locator('main').getByTestId('pulse')).toBeVisible()
    await expect(page.locator('main').getByText('while you were away')).toHaveCount(0)
  })
})
