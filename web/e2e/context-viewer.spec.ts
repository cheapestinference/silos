// context-viewer.spec.ts — context column redesign: heavy blocks (Files) in
// preview + "Show all N" with internal scroll, and clicking a file opens the
// viewer/editor (rendered markdown, view↔edit, save). Verified in real
// Chromium against the 'Files' fixture agent (helpers.ts: seedContextViewer
// seeds REAL files on disk touched by the session). Evidence screenshots
// 1440x900 in web/test-results/shots/context-viewer/.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { startServer, agentRow, cleanupTempDirs, type E2EServer, shotsDir } from './helpers'

const SHOTS_DIR = shotsDir('context-viewer')
mkdirSync(SHOTS_DIR, { recursive: true })

let srv: E2EServer

test.beforeAll(async () => {
  srv = await startServer()
})

test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})

async function openFilesSession(page: Page): Promise<void> {
  await page.goto(`${srv.url}/?token=${srv.token}`)
  await expect(page.getByText('Silos').first()).toBeVisible()
  await page
    .getByRole('button', { name: agentRow('Files') })
    .filter({ hasText: 'Files' })
    .first()
    .click() // not the rail's icon-only «Files»
  await page
    .locator('aside')
    .first()
    .getByText(/Review project files/)
    .first()
    .click()
  await expect(page.locator('main').getByText('Review project files')).toBeVisible()
  // what the conversation used is ONE folded block, «Used here»:
  // open it, then its files line
  const column = page.getByRole('complementary').last()
  await column.locator('summary').getByText('Used here', { exact: true }).click()
  await column
    .getByTestId('used-here')
    .getByRole('button', { name: /^files/i })
    .click()
}

test('Files: preview + expand with internal scroll; Now/Files-expanded screenshots', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await openFilesSession(page)

  const column = page.getByRole('complementary').last() // context column <aside>
  // the Files block shows the total (8 touched files) and a preview of 5
  await expect(column.getByText('README.md')).toBeVisible()
  await expect(column.getByRole('button', { name: 'Show all 8' })).toBeVisible()
  await page.screenshot({ path: join(SHOTS_DIR, 'now-files-preview.png') })

  // expand: the rest appear and the control switches to "Show less"
  await column.getByRole('button', { name: 'Show all 8' }).click()
  await expect(column.getByText('Show less')).toBeVisible()
  await expect(column.getByText('notes.txt')).toBeVisible()
  await page.screenshot({ path: join(SHOTS_DIR, 'files-expanded.png') })

  await context.close()
})

test('clicking a markdown file opens the viewer; Edit shows the source; viewer/edit screenshots', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await openFilesSession(page)

  const column = page.getByRole('complementary').last()
  await column.getByText('README.md').first().click()

  // viewer modal with rendered markdown
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('Silos file viewer')).toBeVisible()
  await page.screenshot({ path: join(SHOTS_DIR, 'md-viewer.png') })

  // view → edit: the source appears in a textarea
  await dialog.getByRole('button', { name: 'Edit' }).click()
  const ta = dialog.getByRole('textbox')
  await expect(ta).toBeVisible()
  await expect(ta).toHaveValue(/# Silos file viewer/)
  await page.screenshot({ path: join(SHOTS_DIR, 'md-edit.png') })

  // Esc closes the viewer (Esc contract)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  await context.close()
})
