// artifacts.spec.ts — aggregated artifacts list: proof-of-life check in a
// real Chromium against the seeded harness (helpers.ts seeds two REAL
// frame-link entries in the E2E agent's s1 session). Covers what jsdom
// can't: the Artifacts block inside the dossier's Sessions facet with data
// coming from the real server (JSONL → ContextAccumulator → GET
// /api/artifacts), and the "artifact:" source in the ⌘K palette. Evidence
// screenshots go to web/test-results/shots/artifacts-list/ (1440x900), same
// criterion as screenshots.spec.ts: no pixel asserts.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { startServer, agentRow, cleanupTempDirs, type E2EServer, shotsDir } from './helpers'

const SHOTS_DIR = shotsDir('artifacts-list')
mkdirSync(SHOTS_DIR, { recursive: true })

let srv: E2EServer

test.beforeAll(async () => {
  srv = await startServer()
})

test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})

test('dossier › Machinery: Artifacts block with the real artifacts from the seeded session', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await page.goto(`${srv.url}/?token=${srv.token}`)
  await expect(page.getByText('Silos').first()).toBeVisible()

  // clicking the E2E agent lands on its page; artifacts are what it
  // produced — Files › Artifacts (each page its own scope)
  await page
    .getByRole('button', { name: agentRow('E2E') })
    .first()
    .click()
  await page
    .locator('main')
    .getByRole('navigation', { name: /sections/ })
    .getByRole('button', { name: /^Files/ })
    .click()
  await page
    .locator('main')
    .getByRole('button', { name: /^Artifacts$/ })
    .click()
  const artifacts = page.locator('main').getByRole('region', { name: 'Artifacts' })
  await expect(artifacts).toBeVisible()
  // most recent first (parser-notes ts 10:00:08 > quarterly-report 10:00:07)
  await expect(artifacts.getByText('parser-notes.md')).toBeVisible()
  await expect(artifacts.getByText('quarterly-report.html')).toBeVisible()
  // the source session as a secondary affordance, and the real URL link.
  await expect(artifacts.getByText('E2E session with skill').first()).toBeVisible()
  await expect(artifacts.getByRole('link').first()).toHaveAttribute('href', /claude\.ai\/artifacts/)

  await page.screenshot({ path: join(SHOTS_DIR, 'dossier-sessions-artifacts.png') })
  await context.close()
})

test('⌘K: artifacts are a searchable source ("artifact: <title>")', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await page.goto(`${srv.url}/?token=${srv.token}`)
  await expect(page.getByText('Silos').first()).toBeVisible()

  await page.keyboard.press('Control+k')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('search').fill('quarterly')
  await expect(dialog.getByText('artifact:')).toBeVisible()
  await expect(dialog.getByText('quarterly-report.html')).toBeVisible()
  // the source session travels as secondary meta on the row.
  await expect(dialog.getByText('# E2E session with skill')).toBeVisible()

  await page.screenshot({ path: join(SHOTS_DIR, 'cmdk-artifact-hit.png') })
  await context.close()
})
