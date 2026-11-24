// give.spec.ts — Rule 1 end to end
// against a REAL seeded server with task wakes ON (SILOS_NO_TASK_WAKE_
// DELIVERY=0) and a STUB claude on PATH that speaks the Agent SDK's
// stream-json for one short turn (it reads a file, answers, ends) — HOME and
// TMPDIR isolated: no real claude, no real account.
//   own    «Give to Web»: the task is born, assigned, and the dialog stays as
//          its row — «Starting Web…» (never «on it» at the click) → «Web is
//          on it · Read …» with Stop → the line leaves when the turn ends
//   told   «Give and open chat ›» (E2E has no console in the index): the
//          task is born and its chat opens on it — nothing starts on its own
// Evidence screenshots under web/test-results/shots/give/ when SILOS_SHOTS=1.
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { startServer, cleanupTempDirs, type E2EServer, shotsDir } from './helpers'

const SHOTS = process.env.SILOS_SHOTS ? shotsDir('give') : null
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

let srv: E2EServer & { stubLog?: string }

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  srv = await startServer({ taskMode: true, stubClaude: true, taskWakes: true })
})
test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})
test.use({ viewport: { width: 1280, height: 860 } })

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return
  await page.waitForTimeout(200)
  await page.screenshot({ path: join(SHOTS, name) })
}
const sdkTurns = (): number =>
  srv.stubLog && existsSync(srv.stubLog)
    ? readFileSync(srv.stubLog, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { argv: string[] })
        .filter((l) => l.argv.includes('stream-json')).length
    : 0

async function openGive(page: Page, owner: string, title: string): Promise<void> {
  await page.goto(`${srv.url}/tasks?token=${srv.token}`)
  await page.getByTestId('new-task').click()
  const dialog = page.getByTestId('new-task-dialog')
  await expect(dialog).toBeVisible()
  await dialog.locator('#nt-owner').selectOption(owner)
  await dialog.getByLabel('What to do').fill(title)
}

test('On its own: «Give to Web» — Starting → on it with Stop → the line leaves when its turn ends', async ({ page }) => {
  await openGive(page, 'web', 'Draft the release notes')
  const dialog = page.getByTestId('new-task-dialog')
  await expect(dialog.getByTestId('give-primary')).toHaveText('Give to Web')
  await expect(dialog.getByTestId('give-line')).toHaveText('Starts now, on its own')
  await expect(dialog.getByTestId('give-later')).toHaveText('Save for later')
  await shot(page, 'give-own.png')
  const before = sdkTurns()
  await dialog.getByTestId('give-primary').click()
  const given = page.getByTestId('give-given')
  await expect(given).toContainText('Given to Web: Draft the release notes')
  const live = page.getByTestId('give-live')
  // proof of life: it says something at once, and never «on it» before output
  await expect(live).toHaveText(
    /^(Starting Web…|Web is running \d things? already — it starts when one ends|The fleet is running \d things? — Web starts when one ends|Web is on it · Read · \d+s ago\s*Stop)/,
  )
  await shot(page, 'give-starting.png')
  // the stub's first output reaches the line through the WS stream
  await expect(live).toContainText('Web is on it · Read', { timeout: 30_000 })
  await expect(page.getByTestId('give-live-stop')).toBeVisible()
  await shot(page, 'give-on-it.png')
  expect(sdkTurns()).toBeGreaterThan(before)
  // its turn ends: nothing is on its way any more — the line leaves
  await expect(live).toHaveCount(0, { timeout: 30_000 })
  // the task is the plan's, its conversation linked by the wake
  await page.getByTestId('give-given-open').click()
  await expect(page.getByTestId('task-title')).toHaveText('Draft the release notes')
  await expect(page.getByTestId('task-conversation')).toHaveCount(1, { timeout: 15_000 })
})

test('Only when told: «Give and open chat ›» — no console of E2E in the index, so chat; nothing starts on its own', async ({ page }) => {
  await openGive(page, 'e2e', 'Check the invoices')
  const dialog = page.getByTestId('new-task-dialog')
  await expect(dialog.getByTestId('give-primary')).toHaveText('Give and open chat ›')
  await expect(dialog.getByTestId('give-line')).toHaveText('Opens with you — nothing starts without you')
  await shot(page, 'give-told.png')
  await dialog.getByTestId('give-primary').click()
  // its chat opens on the task (the briefed chat turn on the stub)
  await expect(page).toHaveURL(/\/c\//, { timeout: 30_000 })
})
