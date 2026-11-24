// automation-editor.spec.ts — the automation editor against a real Silos:
// Edit is a mode of /automation/:id, Save goes through the
// server's real validation, /automation/new creates and lands on the new
// page. Seeded data only (helpers.ts seedAutomations); nothing fires — the
// edited automations are paused or moved to January 1st, the created one
// is paused at once.
// Screenshots only when EDITOR_SHOTS_DIR is set (design review, not CI).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { startServer, cleanupTempDirs, type E2EServer } from './helpers'

const SHOTS = process.env.EDITOR_SHOTS_DIR
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

let srv: E2EServer

const LONG_PROMPT = `Read the merged pull requests of the last 24 hours in this repository and write a short digest for the team.

For each one: what changed in one sentence, what could break, and who should look at it. Group them by area (server, web, plugin). Skip dependency bumps unless they are major versions.

If nothing was merged, say so in one line and stop — do not invent work.

End with OUTCOME: acted if you wrote a digest, OUTCOME: nothing otherwise.`

test.beforeAll(async () => {
  srv = await startServer()
  // a realistic automation to edit: a long prompt, an every-2-hours window
  const res = await fetch(`${srv.url}/api/automations/auto-digest?token=${srv.token}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Merged PR digest',
      prompt: LONG_PROMPT,
      paused: true,
      trigger: { kind: 'cron', expr: '58 0-22/2 * * *', tz: 'Europe/Madrid' },
    }),
  })
  expect(res.ok).toBe(true)
  // what the digest spent this month: the server's per-run
  // figures (server/src/vitals.ts, <dataDir>/vitals/run-usage.json — what it
  // keeps once it has read a finished run's conversation), seeded before
  // anything asked for them; nothing but GET /api/automations reads it
  const day = 24 * 3600_000
  const runs = Object.fromEntries(
    [1, 3, 9].map((ago, i) => [
      `e2e-usage-${i}`,
      { automation: 'auto-digest', at: Date.now() - ago * day, tokens: 1_200_000, cost: 0.2, unpricedTokens: 0, plan: false, measured: true },
    ]),
  )
  mkdirSync(join(srv.dataDir, 'vitals'), { recursive: true })
  writeFileSync(join(srv.dataDir, 'vitals', 'run-usage.json'), JSON.stringify({ runs }) + '\n')
})

test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})

async function automation(id: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${srv.url}/api/automations/${id}?token=${srv.token}`)
  return ((await res.json()) as { automation: Record<string, unknown> }).automation
}

test('Edit is a mode of the page: the editor replaces the runs, Save goes through the server and returns', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await page.goto(`${srv.url}/automation/auto-standup?token=${srv.token}`)
  const main = page.locator('main')
  await main.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(main.getByTestId('automation-editor')).toBeVisible()
  await expect(main.getByText('Editing')).toBeVisible()
  await expect(main.getByRole('button', { name: 'Run now' })).toHaveCount(0)
  // no notify toggles (retired)
  await expect(main.getByText(/Notify/)).toHaveCount(0)
  await expect(main.getByRole('checkbox')).toHaveCount(0)
  const notifyBefore = (await automation('auto-standup')).notify
  // "0 9 * * 1-5" opens as "Weekdays at 09:00"
  await expect(main.getByTestId('schedule-weekdays').getByRole('radio')).toBeChecked()

  // an invalid zone: said under the schedule, Save stays off
  await main.getByLabel('Time zone').fill('Mars/Olympus')
  await expect(main.getByTestId('schedule-problem')).toContainText('isn’t a time zone')
  await expect(main.getByRole('button', { name: 'Save' })).toBeDisabled()
  await main.getByLabel('Time zone').fill('UTC')

  await main.getByTestId('schedule-custom').click()
  await main.getByLabel('cron expression', { exact: true }).fill('0 9 1 1 *')
  await main.getByRole('switch', { name: 'Ask me before each run' }).click()
  await main.getByRole('button', { name: 'Save' }).click()
  await expect(main.getByTestId('automation-editor')).toHaveCount(0)
  await expect(main.getByRole('button', { name: 'Run now' })).toBeVisible()
  const saved = await automation('auto-standup')
  expect(saved.trigger).toEqual({ kind: 'cron', expr: '0 9 1 1 *', tz: 'UTC' })
  expect(saved.approval).toBe(true)
  // the stored notify rides along untouched — an edit never sends it
  expect(saved.notify).toEqual(notifyBefore)
  await context.close()
})

test('unsaved changes: browser back asks inline first, and Discard lets it through', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await page.goto(`${srv.url}/automations?token=${srv.token}`)
  const main = page.locator('main')
  // several agents: a tile each — the tile opens its agent's list
  await main.getByText('Merged PR digest').first().click()
  await main.getByTestId('automation-row-auto-digest').click()
  await expect(page).toHaveURL(/\/automation\/auto-digest$/)
  await main.getByRole('button', { name: 'Edit', exact: true }).click()
  await main.getByLabel('What the agent should do').fill('Something else entirely.')
  await page.goBack()
  await expect(main.getByText('Discard changes?')).toBeVisible()
  await expect(page).toHaveURL(/\/automation\/auto-digest$/)
  await main.getByRole('button', { name: 'Keep editing' }).click()
  await expect(main.getByLabel('What the agent should do')).toHaveValue('Something else entirely.')
  await page.goBack()
  await main.getByRole('button', { name: 'Discard' }).click()
  await expect(page).toHaveURL(/\/automations\?agent=[^&]+$/) // back lands on the agent's list it came from
  await context.close()
})

// The month's spend, said where the automation lives: the list
// row carries its month, the page its 30 days with a figure per day, and a
// write (a pause) keeps the figure the list read.
test("the month's spend: the list row carries it, the page draws its days, a pause keeps it", async ({ browser }) => {
  const res = await fetch(`${srv.url}/api/automations?token=${srv.token}`)
  const body = (await res.json()) as {
    automations: Array<{ id: string; usage30d?: { tokens: number; runsCounted: number; days: unknown[] } | null }>
    usageTotals30d: { tokens: number }
  }
  expect(body.automations.find((a) => a.id === 'auto-digest')?.usage30d).toMatchObject({ tokens: 3_600_000, runsCounted: 3 })
  expect(body.usageTotals30d.tokens).toBeGreaterThanOrEqual(3_600_000)
  for (const dark of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    if (dark) await page.addInitScript(() => window.localStorage.setItem('silos-dark', '1'))
    await page.goto(`${srv.url}/automations?agent=ux&token=${srv.token}`)
    const main = page.locator('main')
    await expect(main.getByTestId('automation-row-auto-digest').getByTestId('automation-row-spark')).toBeVisible()
    await expect(page.getByTestId('automations-month')).toBeVisible()
    await shot(page, dark ? 'usage-list-dark' : 'usage-list')
    await main.getByTestId('automation-row-auto-digest').click()
    await expect(page).toHaveURL(/\/automation\/auto-digest$/)
    await expect(main.getByTestId('automation-usage-day')).toHaveCount(30)
    await main.getByTestId('automation-usage-day').nth(28).hover()
    await expect(main.getByTestId('automation-usage-tip')).toBeVisible()
    await shot(page, dark ? 'usage-page-dark' : 'usage-page')
    await context.close()
  }
  // an automation with no runs this month: words, no bars — and a pause
  // (a write whose answer carries no spend) keeps what the list read
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await page.goto(`${srv.url}/automation/auto-deploy-hook?token=${srv.token}`)
  const main = page.locator('main')
  await expect(main.getByTestId('automation-usage-empty')).toBeVisible()
  await expect(main.getByTestId('automation-usage-bars')).toHaveCount(0)
  await main.getByTestId('automation-pause').click()
  await expect(main.getByTestId('automation-pause')).toHaveAccessibleName('Resume')
  await expect(main.getByTestId('automation-usage')).toBeVisible()
  await main.getByTestId('automation-pause').click()
  await expect(main.getByTestId('automation-pause')).toHaveAccessibleName('Pause')
  await context.close()
})

test('shots: the editor on a long prompt, desktop and phone', async ({ browser }) => {
  for (const dark of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    if (dark) await page.addInitScript(() => window.localStorage.setItem('silos-dark', '1'))
    await page.goto(`${srv.url}/automation/auto-digest?token=${srv.token}`)
    await page.locator('main').getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(page.locator('main').getByTestId('automation-editor')).toBeVisible()
    await shot(page, dark ? 'desktop-edit-dark' : 'desktop-edit')
    if (!dark) {
      await page.locator('main').getByLabel('What the agent should do').fill(`${LONG_PROMPT}\n\nAlso: mention flaky tests.`)
      await page.locator('main').getByRole('button', { name: 'Cancel' }).click()
      await shot(page, 'desktop-edit-discard')
    }
    await context.close()
  }
  const phone = await browser.newContext({ viewport: { width: 400, height: 860 }, isMobile: true, hasTouch: true })
  const page = await phone.newPage()
  await page.goto(`${srv.url}/automation/auto-digest?token=${srv.token}`)
  // a phone's band keeps Run now and the ⋯ — Edit (and Pause) live in it
  await page.locator('main').getByRole('button', { name: 'More actions' }).click()
  await page.locator('main').getByRole('menuitem', { name: 'Edit' }).click()
  await expect(page.locator('main').getByTestId('automation-editor')).toBeVisible()
  await shot(page, 'phone-edit')
  await page
    .locator('main')
    .getByTestId('automation-editor')
    .locator('.overflow-y-auto')
    .first()
    .evaluate((el) => el.scrollTo(0, el.scrollHeight))
  await shot(page, 'phone-edit-bottom')
  await phone.close()
})

test('/automation/new creates: from the Automations page, with the agent picked, landing on its page', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await page.goto(`${srv.url}/automations?token=${srv.token}`)
  const main = page.locator('main')
  await main.getByRole('button', { name: 'New automation', exact: true }).click()
  await expect(page).toHaveURL(/\/automation\/new$/)
  await expect(main.getByText('New', { exact: true })).toBeVisible()
  await shot(page, 'desktop-create-empty')
  await main.getByRole('radio', { name: /UX/ }).click()
  await main
    .getByLabel('What the agent should do')
    .fill(
      'Every Monday, look through last week’s UI screenshots in .superpowers and list the three rough edges most worth fixing, with a one-line why for each.',
    )
  // the period first: every 1 week, on Monday, at 08:30
  await main.getByTestId('schedule-period-unit-weeks').click()
  await main.getByTestId('schedule-period-day-1').click()
  await main.getByTestId('schedule-period-at').fill('08:30')
  await expect(main.getByTestId('schedule-period-consequence')).toHaveText(/one run a week/i)
  await shot(page, 'desktop-create')
  await main.getByRole('button', { name: 'Create automation' }).click()
  await expect(page).toHaveURL(/\/automation\/(?!new)[^/?]+$/)
  await expect(main.getByRole('heading', { name: /Every Monday, look through last/ })).toBeVisible()
  const id = page.url().split('/').pop()!
  const created = await automation(id)
  expect(created.agentId).toBe('ux')
  expect(created.trigger).toMatchObject({ kind: 'period', period: { every: 1, unit: 'weeks', day: 1, at: '08:30' } })
  expect(created.maxRunsPerDay).toBe(24)
  // never let it fire during the suite
  await fetch(`${srv.url}/api/automations/${id}?token=${srv.token}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paused: true }),
  })
  await context.close()
})

// A command automation: made
// in the editor, run for real by the resident (an exec, never the SDK), its
// run read as «exit 0 · … · <last line>» with the log opened in place.
test('a command automation: created in the editor, Run now execs it, the run row opens its log', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await page.goto(`${srv.url}/automation/new?agent=ux&token=${srv.token}`)
  const main = page.locator('main')
  await main.getByRole('radio', { name: 'A command' }).click()
  await expect(main.getByTestId('automation-runs-on')).toHaveCount(0)
  await main.getByLabel('The command').fill('/bin/echo "synced 3 invoices"')
  await main.getByLabel('Automation name').fill('Echo sync')
  await shot(page, 'desktop-create-command')
  await main.getByRole('button', { name: 'Create automation' }).click()
  await expect(page).toHaveURL(/\/automation\/(?!new)[^/?]+$/)
  const id = page.url().split('/').pop()!
  // never let it fire on its schedule during the suite
  await fetch(`${srv.url}/api/automations/${id}?token=${srv.token}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paused: true }),
  })
  const created = await automation(id)
  expect(created.run).toEqual({ kind: 'command', argv: ['/bin/echo', 'synced 3 invoices'], onFailure: 'inbox' })
  await expect(main.getByTestId('automation-belongs-command')).toHaveText("echo 'synced 3 invoices'")
  await expect(main.getByTestId('automation-argv')).toHaveText("/bin/echo 'synced 3 invoices'")
  await expect(main.getByTestId('automation-on-failure')).toHaveText('If it fails: tells you')
  await main.getByRole('button', { name: 'Run now' }).click()
  const line = main.getByTestId('command-run-line').first()
  await expect(line).toHaveText(/^exit 0 · (<1|\d+) s · synced 3 invoices$/, { timeout: 15_000 })
  await main.getByTestId('command-run-log-toggle').first().click()
  await expect(main.getByTestId('command-run-log')).toHaveText('synced 3 invoices')
  await shot(page, 'desktop-command-run')
  // a command runs no Claude: its row says so where the month would stand
  await page.goto(`${srv.url}/automations?agent=ux&token=${srv.token}`)
  await expect(main.getByTestId(`automation-row-${id}`).getByTestId('automation-row-no-tokens')).toBeVisible()
  await context.close()
})
