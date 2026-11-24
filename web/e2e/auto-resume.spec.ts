// auto-resume.spec.ts — evidence screenshots: the session LIMIT banner with
// its reassurance line ("Silos will resume this automatically at <time>"),
// the Cancel button, and the nudge toward cheapestinference; plus the same
// view AFTER pressing Cancel (reassurance gone, nudge still present).
// Data is 100% seeded (helpers seedAutoResume): a session with a synthetic
// limit notice + a real pending-resumes.json — the banner never promises
// something that doesn't exist (proof-of-life principle).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { type Page } from '@playwright/test'
import { test, expect, startServer, agentRow, cleanupTempDirs, type E2EServer, shotsDir } from './helpers'

const SHOTS_DIR = shotsDir('auto-resume')
mkdirSync(SHOTS_DIR, { recursive: true })

let srv: E2EServer

test.beforeAll(async () => {
  srv = await startServer()
})
test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})

async function openLimitedSession(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('silos.chatMode', 'chat')
    } catch {
      /* ignore */
    }
  })
  await page.goto(`${srv.url}/?token=${srv.token}`)
  await expect(page.getByText('Silos').first()).toBeVisible()
  await page
    .getByRole('button', { name: agentRow('Limited') })
    .first()
    .click()
  await page
    .locator('aside')
    .first()
    .getByText(/Quarterly board deck/)
    .first()
    .click()
  // the limit notice in the transcript
  await expect(page.locator('main').getByText(/You've hit your session limit/)).toBeVisible()
}

test('desktop: limit banner with resume reassurance + Cancel + cheapestinference nudge', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await openLimitedSession(page)
  await expect(page.getByText(/Silos will resume this automatically at/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Skip limits with cheapestinference/ })).toBeVisible()
  await page.screenshot({ path: join(SHOTS_DIR, 'limit-banner-scheduled.png') })
  await context.close()
})

test('desktop: after Cancel the reassurance disappears (the nudge remains)', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await openLimitedSession(page)
  await page.getByRole('button', { name: 'Cancel' }).click()
  // the reassurance line goes away (optimistic + WS pending-resume-removed);
  // the notice and the nudge stay — the limit really happened and the nudge
  // doesn't depend on the resume.
  await expect(page.getByText(/Silos will resume this automatically at/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Skip limits with cheapestinference/ })).toBeVisible()
  await page.screenshot({ path: join(SHOTS_DIR, 'limit-banner-cancelled.png') })
  await context.close()
})
