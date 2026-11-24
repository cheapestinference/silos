// plan-mode.spec.ts — a plan-mode plan (ExitPlanMode, real CLI 2.1.316
// lines from server/test/fixtures/plan-mode.jsonl) is a sheet in the
// transcript with its verdict, and the column carries one row that jumps to
// it. Screenshots in web/test-results/shots/plan-mode/ for review by eye.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { type Page } from '@playwright/test'
import { test, expect, startServer, agentRow, cleanupTempDirs, type E2EServer, shotsDir } from './helpers'

const SHOTS = shotsDir('plan-mode')
mkdirSync(SHOTS, { recursive: true })

let srv: E2EServer
test.beforeAll(async () => {
  srv = await startServer()
})
test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})

async function open(page: Page, title: string): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('silos.chatMode', 'chat')
    } catch {
      /* ignore */
    }
  })
  await page.goto(`${srv.url}/?token=${srv.token}`)
  await page
    .getByRole('button', { name: agentRow('Peers') })
    .first()
    .click()
  await page.locator('aside').first().getByText(title).first().click()
  await expect(page.locator('main').getByText(title).first()).toBeVisible()
}

test('an approved plan: a sheet with its verdict, folded; the column row jumps to it', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await open(page, 'Plan mode, approved')
  const sheet = page.locator('[data-plan-block]')
  await expect(sheet).toHaveCount(1)
  await expect(sheet.getByText('Approved by you')).toBeVisible()
  await expect(sheet.getByRole('heading', { name: /Plan mode, visible in the conversation/ })).toBeVisible()
  await expect(sheet.getByRole('button', { name: 'Show the whole plan' })).toBeVisible()
  await page.screenshot({ path: join(SHOTS, 'approved-folded.png') })
  await sheet.getByRole('button', { name: 'Show the whole plan' }).click()
  await expect(sheet.getByText('Verification')).toBeVisible()
  await expect(page.getByRole('button', { name: /Plan mode, visible in the conversation.*Approved/ })).toBeVisible()
  await page.screenshot({ path: join(SHOTS, 'approved-open.png'), fullPage: false })
  await page.close()
})

test('a proposed plan waits on you — in the sheet and in the column', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await open(page, 'Plan mode, waiting')
  const sheet = page.locator('[data-plan-block]')
  await expect(sheet.getByText(/Waiting for your approval/)).toBeVisible()
  await expect(page.getByRole('button', { name: /Plan mode, visible in the conversation.*Waiting for you/ })).toBeVisible()
  await page.screenshot({ path: join(SHOTS, 'proposed.png') })
  await page.close()
})
