// first-run.spec.ts — a new agent without decisions, end to end:
// a FRESH install (no agent of its own, no
// session) on a stub claude with HOME and TMPDIR isolated — no real claude,
// no real account. In fewer than three screens: Welcome asks who you want
// working for you (a name, what it takes care of, where its files are —
// derived), «Create» lands on the agent's page where it reads its mission
// (one attended chat turn on the stub) and its answer comes back as a card;
// then «What should Ana do first?» and «Give to Ana».
// Evidence screenshots under web/test-results/shots/first-run/ when SILOS_SHOTS=1.
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { startServer, cleanupTempDirs, type E2EServer, shotsDir } from './helpers'

const SHOTS = process.env.SILOS_SHOTS ? shotsDir('first-run') : null
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

let srv: E2EServer & { home?: string }

test.beforeAll(async () => {
  srv = await startServer({ fresh: true, stubClaude: true, taskMode: false })
})
test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})
test.use({ viewport: { width: 1280, height: 860 } })

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return
  await page.waitForTimeout(250)
  await page.screenshot({ path: join(SHOTS, name) })
}

test('name + mission + Give in fewer than three screens — no commands, no decisions', async ({ page }) => {
  // screen 1: Welcome
  await page.goto(`${srv.url}/?token=${srv.token}`)
  const welcome = page.getByTestId('welcome')
  await expect(welcome).toBeVisible()
  await expect(welcome.getByRole('heading')).toHaveText('Who do you want working for you?')
  await expect(welcome).not.toContainText(/cp -r|claude plugin install|npm /)
  // the machine never signed in to Claude (an isolated HOME): the first step
  // asks nothing of it; «Runs on» offers Claude's own sign-in — without
  // holding Welcome
  await expect(welcome.getByRole('button', { name: 'Sign in to Claude ›' })).toHaveCount(0)
  const rail = welcome.getByRole('list', { name: 'Setup' })
  await rail.getByRole('button', { name: /Runs on/ }).click()
  await expect(welcome.getByRole('button', { name: 'Sign in to Claude ›' })).toBeVisible()
  await rail.getByRole('button', { name: /Who/ }).click()
  await welcome.getByLabel('Name').fill('Ana')
  await expect(welcome.getByTestId('welcome-folder')).toHaveText('~/Silos/ana · change')
  // how it works is asked: on its own, it reads its mission now
  await welcome.getByRole('radio', { name: /Also on its own/ }).check()
  await welcome.getByLabel('What will Ana take care of?').fill('Keep the books tidy, every month.\nNever: pay anything')
  await shot(page, 'welcome.png')
  await welcome.getByRole('button', { name: 'Create' }).click()

  // screen 2: its page — the proof of life, then the card as it answered
  const meeting = page.getByTestId('first-meeting')
  await expect(meeting).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('first-reading')).toHaveText('Ana is reading its mission…')
  await shot(page, 'reading.png')
  const card = page.getByTestId('first-card')
  await expect(card).toContainText("I'll look after: the books, every month.", { timeout: 30_000 })
  await expect(page.getByTestId('first-control')).toHaveText(/^Every Monday at 09:\d\d ›$/)
  await expect(page.getByTestId('first-instead')).toHaveText('Make it a task instead')
  await shot(page, 'card.png')
  // its folder was derived and made under the (isolated) home
  expect(srv.home && existsSync(join(srv.home, 'Silos', 'ana'))).toBe(true)

  // still screen 2: what first — Give, On its own
  await page.getByTestId('first-right').click()
  const give = meeting.getByTestId('new-task-dialog')
  await expect(give.getByLabel('What to do')).toHaveAttribute('placeholder', 'What should Ana do first?')
  await give.getByLabel('What to do').fill('Reconcile October')
  await expect(give.getByTestId('give-primary')).toHaveText('Give to Ana')
  await shot(page, 'give.png')
  await give.getByTestId('give-primary').click()
  await expect(meeting.getByTestId('give-given')).toContainText('Given to Ana: Reconcile October', { timeout: 15_000 })
  await shot(page, 'given.png')
})
