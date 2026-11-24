// selectors.spec.ts — the composer's chips and Run on (the ONE editor of
// model and account) against a real server with a SEEDED catalog (helpers.ts: seedModelCatalog + SILOS_NO_MODEL_CATALOG=1 —
// the E2E harness never spawns the SDK's CLI). Captures evidence
// screenshots in web/test-results/shots/selectors/.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { type Page } from '@playwright/test'
import { test, expect, startServer, agentRow, cleanupTempDirs, type E2EServer, shotsDir } from './helpers'

const SHOTS_DIR = shotsDir('selectors')
mkdirSync(SHOTS_DIR, { recursive: true })

let srv: E2EServer

test.beforeAll(async () => {
  srv = await startServer()
})

test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})

async function openConversation(page: Page): Promise<void> {
  await page.goto(`${srv.url}/?token=${srv.token}`)
  await expect(page.getByText('Silos').first()).toBeVisible()
  await page
    .getByRole('button', { name: agentRow('API') })
    .first()
    .click()
  await page
    .locator('aside')
    .first()
    .getByText(/Flaky test triage/)
    .first()
    .click()
  await expect(page.getByTestId('chip-model')).toBeVisible()
}

test.use({ viewport: { width: 1440, height: 900 } })

test('chips in default state: catalog model, default effort, calm shield in bypass', async ({ page }) => {
  await openConversation(page)
  // the 'api' agent doesn't pin a model → the effective truth is the default
  // row of the seeded catalog, never a made-up list.
  await expect(page.getByTestId('chip-model')).toContainText('Default (recommended)')
  await expect(page.getByLabel('effort selector')).toContainText('effort · default')
  await expect(page.getByLabel('permission mode selector')).toContainText('bypass')
  await page.screenshot({ path: join(SHOTS_DIR, 'chips-default.png') })
})

test('the model chip opens Run on: agent default first, the SDK catalog, a typed id; fast mode is its own chip', async ({ page }) => {
  await openConversation(page)
  // the default row supports fast mode per the seeded catalog
  await expect(page.getByLabel('fast mode selector')).toBeVisible()
  await page.getByTestId('chip-model').click()
  const panel = page.getByRole('dialog', { name: 'Run on' })
  await expect(panel.getByTestId('run-on-agent-default')).toHaveAttribute('aria-checked', 'true')
  // the machine's account is a real group (logged out in the seed: never opened by itself)
  await expect(panel.getByRole('button', { name: /Claude \(this machine\)/ })).toHaveAttribute('aria-expanded', 'false')
  await panel.getByRole('button', { name: /^cheapestinference — / }).click()
  await expect(panel.getByRole('menuitemradio').nth(1)).toBeVisible()
  await expect(panel.getByRole('checkbox', { name: 'Next message only' })).toBeVisible()
  await page.screenshot({ path: join(SHOTS_DIR, 'menu-model.png') })
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
})

test('per-conversation plan mode: amber shield, persisted on the server', async ({ page }) => {
  await openConversation(page)
  await page.getByLabel('permission mode selector').click()
  await page.getByRole('menuitemradio', { name: /Plan mode/ }).click()
  await expect(page.getByLabel('permission mode selector')).toContainText('plan mode')
  await page.screenshot({ path: join(SHOTS_DIR, 'shield-plan.png') })

  // proof-of-life: the override landed in the server's conversation-prefs.json
  const res = await page.request.get(`${srv.url}/api/sessions/-tmp-e2e-api/api1/prefs`, {
    headers: { 'x-token': srv.token },
  })
  expect((await res.json()).prefs.permissionMode).toBe('plan')

  // cleanup so this doesn't leak into other specs on the same server
  await page.getByLabel('permission mode selector').click()
  await page.getByRole('menuitemradio', { name: /Bypass/ }).click()
  await expect(page.getByLabel('permission mode selector')).toContainText('bypass')
})

test('one-shot: "next turn only" marks the chip amber and persists nothing', async ({ page }) => {
  await openConversation(page)
  await page.getByLabel('effort selector').click()
  await page.getByRole('menuitemcheckbox', { name: /next turn only/ }).click()
  await page.getByRole('menuitemradio', { name: 'max' }).click()
  const chip = page.getByLabel('effort selector')
  await expect(chip).toContainText('effort · max')
  await expect(chip).toContainText('· next turn')
  await page.screenshot({ path: join(SHOTS_DIR, 'one-shot-next-turn.png') })

  // genuinely one-shot: the server has NO persisted effort for this conversation
  const res = await page.request.get(`${srv.url}/api/sessions/-tmp-e2e-api/api1/prefs`, {
    headers: { 'x-token': srv.token },
  })
  expect((await res.json()).prefs.effort).toBeUndefined()
})

// output style: one row in Run on — the engine's styles, a pick pins
// it for this conversation, the runs-on line names it in a word
test('Run on: the output style row pins a style for the conversation', async ({ page }) => {
  await openConversation(page)
  await page.getByRole('button', { name: 'Change what it runs on' }).click()
  const panel = page.getByRole('dialog', { name: 'Run on' })
  const row = panel.getByTestId('output-style-row')
  await expect(row).toContainText('Claude Code’s setting')
  await row.getByRole('button', { name: /Answers in/ }).click()
  await expect(row.getByRole('menuitemradio', { name: /^Learning/ })).toBeVisible()
  await page.screenshot({ path: join(SHOTS_DIR, 'run-on-output-style.png') })
  await row.getByRole('menuitemradio', { name: /^Explanatory/ }).click()
  await expect(panel).toBeHidden()
  await expect(page.getByRole('button', { name: 'Change what it runs on' })).toContainText('Explanatory')
  const res = await page.request.get(`${srv.url}/api/sessions/-tmp-e2e-api/api1/prefs`, { headers: { 'x-token': srv.token } })
  expect((await res.json()).prefs.outputStyle).toBe('Explanatory')
  await page.screenshot({ path: join(SHOTS_DIR, 'runs-on-explanatory.png') })
  // cleanup: back to the agent's own (nothing set)
  const del = await page.request.patch(`${srv.url}/api/sessions/-tmp-e2e-api/api1/prefs`, { headers: { 'x-token': srv.token }, data: { outputStyle: null } })
  expect(del.status()).toBe(200)
})
