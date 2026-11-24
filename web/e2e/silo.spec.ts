// silo.spec.ts — the Silo Standard's pages against a REAL server (Task 8):
// two active silos seeded from the reference manifests (helpers seedSilos),
// read by the real kernel — reader, overlay reconcile, journal, surfaces.
// Evidence screenshots 1440x900 (and 400px) in web/test-results/shots/silo-ux/.
//
// The invisibility gate (zero active silos → nothing anywhere) is fixed at
// the unit level (command-palette.test.tsx, sidebar rail) and here by
// contrast: every OTHER spec runs the same server WITHOUT seedSilos and
// would fail on any stray silo text in Home/⌘K/rail.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { startServer, cleanupTempDirs, openNeedsYou, type E2EServer, shotsDir } from './helpers'

const SHOTS_DIR = shotsDir('silo-ux')
mkdirSync(SHOTS_DIR, { recursive: true })

let srv: E2EServer

test.beforeAll(async () => {
  srv = await startServer({ silos: true })
})

test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})

test.use({ viewport: { width: 1440, height: 900 } })

test('the list archetype paints the manifest: identity rows, plain-word states, whole-set facets, fold, unreadable', async ({ page }) => {
  await page.goto(`${srv.url}/silo/invoices?token=${srv.token}`)
  const main = page.locator('main')
  await expect(main.getByRole('heading', { name: 'Invoices' })).toBeVisible()
  // the header sentence: real counts + the sync (10 parsed, 2 failed); nobody is
  // bound (a role is never an agent id), said once by the binding line
  await expect(main.getByText(/10 records · synced from Invoicing/)).toBeVisible()
  await expect(main.getByTestId('silo-binding')).toContainText('No producer yet ·')
  await expect(main.getByTestId('silo-binding').getByRole('button', { name: 'Bind ›' })).toBeVisible()
  // identity is the row's phrase; the state cell speaks the label, never the raw value
  await expect(main.getByText('F2026-0401 · Acme SL').first()).toBeVisible()
  // an owner-settable state is a select on the row (phase B): its chosen
  // option speaks the label
  await expect(
    main
      .getByRole('combobox')
      .filter({ has: page.locator('option:checked', { hasText: 'outstanding' }) })
      .first(),
  ).toBeVisible()
  await expect(
    main
      .getByRole('combobox')
      .filter({ has: page.locator('option:checked', { hasText: 'partially paid' }) })
      .first(),
  ).toBeVisible()
  // folded (paid/refunded) records are counted by the server, listed on ask
  // (the exact count is unit-tested; under fullyParallel another test in
  // this worker may already have folded one more by marking it paid)
  const folded = main.getByRole('button', { name: /\d+ .+ · Show/ })
  await expect(folded).toBeVisible()
  // the unreadable files are said, each with its reason
  await main.getByRole('button', { name: /2 records can't be read — show which/ }).click()
  await expect(main.getByTestId('silo-unreadable-reason').first()).toBeVisible()
  await page.screenshot({ path: join(SHOTS_DIR, 'list-invoices-unreadable.png') })
  await main.getByRole('button', { name: /2 records can't be read — hide/ }).click()

  await folded.click()
  await expect(main.getByText('F2026-0396 · Acme SL').first()).toBeVisible()
  // the conflicted row is marked in so many words (it folded with the
  // owner's 'paid' standing)
  await expect(main.getByText('conflict').first()).toBeVisible()
  await page.screenshot({ path: join(SHOTS_DIR, 'list-invoices.png') })

  // dark, same page (the theme is Silos's own localStorage pref, not the
  // media query — set it and reload, then undo)
  await page.evaluate(() => localStorage.setItem('silos-dark', '1'))
  await page.reload()
  await main.getByRole('button', { name: /\d+ .+ · Show/ }).click()
  await expect(main.getByText('conflict').first()).toBeVisible()
  await page.screenshot({ path: join(SHOTS_DIR, 'list-invoices-dark.png') })
  await page.evaluate(() => localStorage.setItem('silos-dark', '0'))
  await page.reload()

  // a facet filters through the server (single value per facet)
  await main.getByLabel('filter by kind').click()
  await main.getByRole('option', { name: /purchase/ }).click()
  await expect(main.getByText('Cloud Provider Inc').first()).toBeVisible()
  await expect(main.getByText('F2026-0401 · Acme SL')).toHaveCount(0)
})

test('the record page: envelope in voice, the story, and set-field over a sync source lands in the overlay', async ({ page }) => {
  await page.goto(`${srv.url}/silo/invoices?token=${srv.token}`)
  const main = page.locator('main')
  await main.getByText('F2026-0401 · Acme SL').first().click()
  await expect(page).toHaveURL(/\/silo\/invoices\/r\//)
  await expect(main.getByRole('heading', { name: 'F2026-0401 · Acme SL' })).toBeVisible()
  // the envelope line: state word + date + the agent anchor
  await expect(main.getByText('with finance')).toBeVisible()
  // the needs-you band (overdue sale) with its clears, and money as money
  await expect(main.getByTestId('silo-needs-you')).toContainText('clears when state in [paid, refunded]')
  await expect(main.getByText('€465.51').first()).toBeVisible()
  // the story: the first observation is a baseline — «arrived», never «became»
  await expect(main.getByText('first seen — arrived outstanding')).toBeVisible()
  // the message template is previewed FILLED before sending
  await main.getByRole('button', { name: /Chase payment for F2026-0401 · Acme SL/ }).click()
  await expect(main.getByTestId('silo-template-preview')).toContainText('(€465.51)')
  await page.screenshot({ path: join(SHOTS_DIR, 'record-invoices.png') })
  await main.getByRole('button', { name: 'Cancel' }).click()

  // set-field (owner): over a sync source it writes the overlay — the page
  // re-reads and the state now says paid with «your edit stands»
  await main.getByLabel('Set state').selectOption('paid')
  await expect(main.getByText('your edit stands').first()).toBeVisible()
  // …and the action is an event in the record's story, in the server's words
  await expect(main.getByText(/set-field state: .* \(held over the sync\)/)).toBeVisible()
})

test('the overlay conflict says both sides and resolves', async ({ page }) => {
  await page.goto(`${srv.url}/silo/invoices?token=${srv.token}`)
  const main = page.locator('main')
  // the conflicted record folded (its merged state is the owner's 'paid')
  await main.getByRole('button', { name: /\d+ .+ · Show/ }).click()
  await main.getByText('F2026-0405 · Acme SL').first().click()
  const band = main.getByTestId('silo-conflict')
  await expect(band).toContainText('you set state to paid')
  await expect(band).toContainText('the source now says partially paid')
  await page.screenshot({ path: join(SHOTS_DIR, 'record-conflict.png') })
  await band.getByRole('button', { name: "Take the source's" }).click()
  await expect(main.getByTestId('silo-conflict')).toHaveCount(0)
})

test('the same archetype, another manifest: documents (different columns, facets, fold)', async ({ page }) => {
  await page.goto(`${srv.url}/silo/documents?token=${srv.token}`)
  const main = page.locator('main')
  await expect(main.getByRole('heading', { name: 'Documents' })).toBeVisible()
  await expect(main.getByText('Tax office request — reply').first()).toBeVisible()
  // this manifest's own state words
  await expect(
    main
      .getByRole('combobox')
      .filter({ has: page.locator('option:checked', { hasText: 'needs a response' }) })
      .first(),
  ).toBeVisible()
  // its own facets (type · issuer · state)
  await expect(main.getByLabel('filter by type')).toBeVisible()
  await expect(main.getByLabel('filter by issuer')).toBeVisible()
  // filed records fold
  await expect(main.getByRole('button', { name: /1 .+ · Show/ })).toBeVisible()
  await page.screenshot({ path: join(SHOTS_DIR, 'list-documents.png') })
})

test("⌘K lists each active silo; Home's silo rows open the record page", async ({ page }) => {
  await page.goto(`${srv.url}/?token=${srv.token}`)
  // a needs-you silo row (the overdue invoice), in the manifest's words —
  // in the Needs you list (Home's one list; its head opens it all)
  const row = (await openNeedsYou(page)).getByText(/F2026-0401 · Acme SL — outstanding · due/).first()
  await expect(row).toBeVisible()
  await page.screenshot({ path: join(SHOTS_DIR, 'home-silo-rows.png') })
  await row.click()
  await expect(page).toHaveURL(/\/silo\/invoices\/r\//)

  // ⌘K: the silo by name
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('textbox', { name: 'search' }).fill('invoices')
  await expect(page.getByRole('option', { name: 'Invoices' })).toBeVisible()
  await page.screenshot({ path: join(SHOTS_DIR, 'cmdk-silo.png') })
  await page.getByRole('option', { name: 'Invoices' }).click()
  await expect(page).toHaveURL(/\/silo\/invoices$/)
})

test('the list and the record at phone width (400px)', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 860 } })
  const page = await ctx.newPage()
  await page.goto(`${srv.url}/silo/invoices?token=${srv.token}`)
  const main = page.locator('main')
  await expect(main.getByRole('heading', { name: 'Invoices' })).toBeVisible()
  // below sm the table yields to the stacked rows — the LAST match is the
  // stacked copy (the table renders first in the DOM, display:none here)
  await expect(main.getByText('F2026-0401 · Acme SL').last()).toBeVisible()
  await page.screenshot({ path: join(SHOTS_DIR, 'list-invoices-mobile.png') })
  await main.getByText('F2026-0401 · Acme SL').last().click()
  await expect(main.getByRole('heading', { name: 'F2026-0401 · Acme SL' })).toBeVisible()
  await page.screenshot({ path: join(SHOTS_DIR, 'record-invoices-mobile.png') })
  await ctx.close()
})
