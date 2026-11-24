// silo-install.spec.ts — the install dialog end to end (silo surfaces round
// 2) against a REAL server: seedSilos (invoices + documents active) plus two
// pending submissions (helpers seedSiloSubmissions) — a never-installed
// `helpdesk` (the support manifest under a non-native id) whose producer role is bound to no agent, and a invoices 0.2.0
// update blocked on finance's token. Serial: the decisions change the server.
// Evidence screenshots in web/test-results/shots/silo-ux2/.
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { startServer, cleanupTempDirs, openNeedsYou, type E2EServer, shotsDir } from './helpers'

const SHOTS_DIR = shotsDir('silo-ux2')
mkdirSync(SHOTS_DIR, { recursive: true })

let srv: E2EServer

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  srv = await startServer({ silos: true, siloSubmissions: true })
})

test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})

test.use({ viewport: { width: 1440, height: 900 } })

// The harness still shows two things from the machine it runs on — the
// sidebar footer's signed-in account and Home's account-load line (/proc).
// Neither belongs in the repo: masked in every shot this spec writes.
async function shot(page: Page, name: string, fullPage = false): Promise<void> {
  await page.screenshot({
    path: join(SHOTS_DIR, name),
    fullPage,
    maskColor: '#8f8d86',
    mask: [page.getByRole('button', { name: 'Settings' }).locator('xpath=..'), page.locator('main header button[aria-expanded]')],
  })
}

test('a money column reads as figures — right-aligned (evidence)', async ({ page }) => {
  await page.goto(`${srv.url}/silo/invoices?token=${srv.token}`)
  const main = page.locator('main')
  const th = main.getByRole('columnheader', { name: 'total' })
  await expect(th).toBeVisible()
  await expect(th).toHaveClass(/text-right/)
  await expect(main.getByRole('cell', { name: '€465.51' }).first()).toHaveClass(/text-right/)
  // the update waiting for this silo is said on its own page
  await expect(main.getByTestId('silo-waiting')).toContainText('Version 0.2.0 waits for your approval — it would replace 0.1.0. Submitted by finance.')
  await shot(page, 'list-invoices-money-and-band.png')

  // the record page: the message preview offers Send — no wake checkbox (no
  // message wakes anyone); this seed binds invoices'
  // producer role to nobody, so there is nobody to make a task for (the
  // button with a producer is pinned in silo-record.test.tsx)
  await main.getByText('F2026-0401 · Acme SL').first().click()
  await main.getByRole('button', { name: /Chase payment for F2026-0401/ }).click()
  await expect(main.getByRole('button', { name: 'Send' })).toBeVisible()
  await expect(main.getByRole('button', { name: /Make it a task for/ })).toHaveCount(0)
  await expect(main.getByRole('checkbox', { name: /Wake the producer/ })).toHaveCount(0)
  await shot(page, 'record-make-task.png')
})

test('Needs you → the dialog → bind a producer → Install lands on the active silo', async ({ page }) => {
  await page.goto(`${srv.url}/?token=${srv.token}`)
  const main = page.locator('main')
  const inbox = await openNeedsYou(page)
  // both submissions wait on the owner, in plain words
  await expect(inbox.getByText('0.2.0 waits for your approval to install — submitted by finance')).toBeVisible()
  await expect(inbox.getByText('an update 0.1.0 → 0.2.0 waits for your approval — submitted by finance')).toBeVisible()
  await shot(page, 'home-needs-you-submissions.png')

  await inbox.getByText('0.2.0 waits for your approval to install — submitted by finance').click()
  await expect(page).toHaveURL(/\/silo\/helpdesk\/review$/)
  await expect(main.getByRole('heading', { name: 'Install Helpdesk 0.2.0?' })).toBeVisible()
  // derived: the preview speaks from the manifest's examples — and says so
  await expect(main.getByTestId('silo-review-basis')).toContainText('example')
  await expect(main.getByTestId('silo-review-basis')).toContainText('no records on disk yet')
  await expect(main.getByTestId('silo-review-preview')).toContainText('Needs you')
  // the author's words, quoted apart
  await expect(main.getByRole('heading', { name: 'In finance’s words' })).toBeVisible()
  // the author proposes itself (finance submitted it): Finance is the
  // dialog's default — never an agent read from the role «helpdesk»
  await expect(main.getByRole('checkbox', { name: 'Bind Finance' })).toBeChecked()
  await expect(main.getByTestId('silo-review-blockers')).toHaveCount(0)
  await expect(main.getByRole('button', { name: 'Install Helpdesk' })).toBeEnabled()
  // with nobody bound, Install waits for a binding
  await main.getByText('Finance', { exact: true }).click()
  await expect(main.getByRole('checkbox', { name: 'Bind Finance' })).not.toBeChecked()
  await expect(main.getByTestId('silo-review-blockers')).toHaveText('Not yet: bind the producer role helpdesk to at least one agent')
  await expect(main.getByRole('button', { name: 'Install Helpdesk' })).toBeDisabled()
  await shot(page, 'review-support-unbound.png', true)

  await main.getByText('Finance', { exact: true }).click()
  await expect(main.getByRole('checkbox', { name: 'Bind Finance' })).toBeChecked()
  await expect(main.getByTestId('silo-review-blockers')).toHaveCount(0)
  await expect(main.getByRole('button', { name: 'Install Helpdesk' })).toBeEnabled()
  await shot(page, 'review-support-bound.png', true)

  // dark, same dialog
  await page.evaluate(() => localStorage.setItem('silos-dark', '1'))
  await page.reload()
  await expect(main.getByRole('heading', { name: 'Install Helpdesk 0.2.0?' })).toBeVisible()
  await shot(page, 'review-support-dark.png', true)
  await page.evaluate(() => localStorage.setItem('silos-dark', '0'))
  await page.reload()

  // a fresh dialog proposes the author again
  await expect(main.getByRole('checkbox', { name: 'Bind Finance' })).toBeChecked()
  await main.getByRole('button', { name: 'Install Helpdesk' }).click()
  // the honest state: the silo's page, active, no records pretended
  await expect(page).toHaveURL(/\/silo\/helpdesk$/)
  await expect(main.getByRole('heading', { name: 'Helpdesk' })).toBeVisible()
  await expect(main.getByText('No records yet — they appear here as the producer writes them.')).toBeVisible()
  // the binding the owner chose is who writes it — not the manifest's role
  await expect(main.getByText(/0 records · written by finance/)).toBeVisible()
  await expect(main.getByTestId('silo-waiting')).toHaveCount(0)
  await shot(page, 'support-installed.png')

  // Home: its row is gone; the update's row still waits
  await page.goto(`${srv.url}/?token=${srv.token}`)
  const after = await openNeedsYou(page)
  await expect(after.getByText('an update 0.1.0 → 0.2.0 waits for your approval — submitted by finance')).toBeVisible()
  await expect(after.getByText('0.2.0 waits for your approval to install — submitted by finance')).toHaveCount(0)
})

test("an update from the silo's own page: the loosening said, the producer's token met, Reject is said in place", async ({ page }) => {
  await page.goto(`${srv.url}/silo/invoices?token=${srv.token}`)
  const main = page.locator('main')
  await main.getByRole('button', { name: 'Review the update ›' }).click()
  await expect(page).toHaveURL(/\/silo\/invoices\/review$/)
  await expect(main.getByRole('heading', { name: 'Update Invoices 0.1.0 → 0.2.0?' })).toBeVisible()
  await expect(main.getByTestId('silo-review-loosening').first()).toContainText('asks for a new slot: rail')
  // the preview speaks from the records on disk (the active silo's files)
  await expect(main.getByTestId('silo-review-basis')).toContainText('records on disk')
  // never bound (a role is never an agent id): the update's author, finance,
  // is the one proposed; with nobody bound the owner still has to bind here
  await expect(main.getByRole('checkbox', { name: 'Bind Finance' })).toBeChecked()
  await main.getByText('Finance', { exact: true }).click()
  await expect(main.getByRole('checkbox', { name: 'Bind Finance' })).not.toBeChecked()
  await expect(main.getByTestId('silo-review-requirements')).toContainText('no agent bound yet')
  await main.getByText('Finance', { exact: true }).click()
  await expect(main.getByRole('checkbox', { name: 'Bind Finance' })).toBeChecked()
  // every agent in play holds its token, fenced or not
  await expect(main.getByTestId('silo-review-requirements')).toContainText("requires finance's token")
  await expect(main.getByTestId('silo-review-requirements')).not.toContainText('archived')
  await expect(main.getByRole('button', { name: 'Update Invoices' })).toBeEnabled()
  // the automation card: opt-in, off
  await expect(main.getByTestId('silo-review-automation').getByRole('checkbox')).not.toBeChecked()
  await shot(page, 'review-invoices-update.png', true)

  await main.getByRole('button', { name: 'Reject…' }).click()
  await main.getByLabel(/Why not\?/).fill('not before the November close')
  await main.getByRole('button', { name: 'Reject Invoices' }).click()
  await expect(main.getByTestId('silo-review-rejected')).toContainText(
    'You rejected Invoices 0.2.0. Nothing of it was installed; finance was told — «not before the November close».',
  )
  await shot(page, 'review-invoices-rejected.png')

  await page.goto(`${srv.url}/silo/invoices?token=${srv.token}`)
  await expect(main.getByRole('heading', { name: 'Invoices' })).toBeVisible()
  await expect(main.getByTestId('silo-waiting')).toHaveCount(0)
})

test('the dialog at phone width (400px)', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 860 } })
  const page = await ctx.newPage()
  // the earlier tests decided both seeded submissions: submit one more by the real route
  // (plans itself is served natively — silos/native.ts — so the same manifest under another id)
  const ref = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'standard', 'reference', 'plans.silo.json'), 'utf8'))
  ref.metadata.id = 'roadmap'
  const sub = await page.request.post(`${srv.url}/api/silos/submissions?token=${srv.token}`, { data: { manifest: ref } })
  expect(sub.status()).toBe(201)
  await page.goto(`${srv.url}/silo/roadmap/review?token=${srv.token}`)
  const main = page.locator('main')
  await expect(main.getByRole('heading', { name: /^Install Plans \d+\.\d+\.\d+\?$/ })).toBeVisible()
  await shot(page, 'review-plans-mobile.png', true)
  await ctx.close()
})
