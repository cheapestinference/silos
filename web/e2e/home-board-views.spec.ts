// home-board-views.spec.ts — the retired Board's two views that only it
// showed, on Home now, against a REAL server:
// conversations parked on a Monitor / a wakeup ride the Working now sheet
// the pulse opens, each saying what it waits on; the conversations that
// finished today are the list inside the digest's sheet, opened from the
// «finished today» door under the pulse. Evidence shots in
// web/test-results/shots/home-board/ when SILOS_SHOTS=1.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { startServer, cleanupTempDirs, type E2EServer, shotsDir } from './helpers'

const SHOTS = process.env.SILOS_SHOTS ? shotsDir('home-board') : null
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

let srv: E2EServer

test.beforeAll(async () => {
  srv = await startServer({ waiting: true, digests: true })
})
test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})
test.use({ viewport: { width: 1440, height: 900 } })

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.screenshot({ path: join(SHOTS, name) })
}

test('the pulse opens the Working now sheet, which says on what each parked conversation waits', async ({ page }) => {
  await page.goto(`${srv.url}/?token=${srv.token}`)
  // Right now left Home: the sheet's door is the pulse — its
  // «X is working on…» sentence, or the quiet line under it while the pulse
  // speaks of something else
  const main = page.locator('main')
  const door = main.getByTestId('pulse-working').or(main.getByTestId('working-now-door'))
  await expect(door).toBeVisible()
  await shot(page, 'home-working-now-waiting.png')
  await door.click()
  const sheet = page.getByTestId('sheet-working')
  const waiting = sheet.getByTestId('working-waiting')
  await expect(waiting).toContainText('waiting on a monitor — the canary’s error rate')
  await expect(waiting).toContainText('waiting for a wakeup — tomorrow 09:00, when the bank posts')
  await shot(page, 'home-working-sheet.png')
  // a parked row reopens its conversation
  await waiting.getByText('Watch the canary deploy').click()
  await expect(page).toHaveURL(/\/agent\/watch\/c\//)
})

test("the digest's sheet lists what finished today, each one a door to it", async ({ page }) => {
  await page.goto(`${srv.url}/?token=${srv.token}`)
  const done = page.locator('main').getByTestId('today-done')
  await expect(done).toContainText(/\d+ conversations? finished today/)
  await done.click()
  const sheet = page.getByTestId('sheet-digest')
  await expect(sheet.getByRole('region', { name: 'Daily digest' })).toBeVisible()
  const finished = sheet.getByTestId('digest-finished')
  await expect(finished).toContainText('Release notes for 0.9')
  await expect(finished).toContainText('Quarantine the flaky auth test')
  // the parked ones are not «finished»
  await expect(finished).not.toContainText('Watch the canary deploy')
  await shot(page, 'home-digest-sheet.png')
  await finished.getByText('Release notes for 0.9').click()
  await expect(page).toHaveURL(/\/agent\/watch\/c\//)
})
