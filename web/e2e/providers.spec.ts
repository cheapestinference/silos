// providers.spec.ts — Providers v1: Settings › Providers on real Chromium
// against the seeded harness (helpers.ts seedProviders: a cheapestinference
// with a fake key + a Claude 'work' account + a fallback chain on the 'api'
// agent; the stub claude answers `claude auth status`). HARD RULE: zero
// real network and zero SDK — the provider Verify
// button is not touched here (its fetch is covered by server tests with an
// injected fetch).
import { test, expect } from '@playwright/test'
import { startServer, agentRow, cleanupTempDirs, type E2EServer } from './helpers'

let srv: E2EServer

test.beforeAll(async () => {
  srv = await startServer({ stubClaude: true })
})

test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})

test.beforeEach(async ({ page }) => {
  await page.goto(`${srv.url}/?token=${srv.token}`)
  await expect(page.getByText('Silos').first()).toBeVisible()
})

test('Settings › Accounts & providers: Claude accounts + cheapestinference widget with the key masked', async ({ page }) => {
  await page.getByLabel('Settings').click()
  await page.locator('main').getByRole('button', { name: 'Accounts & providers' }).click()

  // accounts: the machine's own + the seeded 'work' one (logged in, fixture email)
  await expect(page.locator('main').getByText('Claude accounts')).toBeVisible()
  await expect(page.locator('main').getByText('This machine', { exact: true })).toBeVisible()
  await expect(page.locator('main').getByText('work@e2e.test', { exact: true })).toBeVisible()

  // cheapestinference widget: connected (the seeded provider) and the key NEVER shown in full
  await expect(page.locator('main').getByText('Inference providers')).toBeVisible()
  // a key is seeded: the link reads "Your keys" (100e1a7); with none it reads "Get your key"
  await expect(page.locator('main').getByRole('link', { name: /Your keys/ })).toBeVisible()
  await expect(page.locator('main').getByText('sk-…9999')).toBeVisible()
  await expect(page.locator('main').getByText('sk-e2e-fake-key-12349999')).toHaveCount(0)

  // "Connect another account" asks for a name; the sign-in is Claude's own (next test)
  await page
    .locator('main')
    .getByRole('button', { name: /Connect another account/ })
    .click()
  await expect(page.locator('main').getByLabel('account name')).toBeVisible()
})

test('agent › Settings › Runs on: Provider selector and seeded fallback chain', async ({ page }) => {
  await page
    .getByRole('button', { name: agentRow('API') })
    .first()
    .click()
  // its Settings tab reads first — the provider selector lives in the Runs on
  // card's editor (SettingsTab fields="runs"), which only mounts once that
  // card's "Edit" is clicked.
  await page
    .locator('main')
    .getByRole('navigation', { name: /sections/ })
    .getByRole('button', { name: /^Profile/ })
    .click()
  await page.locator('main').getByRole('button', { name: 'Edit what it runs on' }).click()

  const selector = page.locator('main').getByLabel('Provider')
  await expect(selector).toBeVisible()
  // Default · 'work' account · cheapestinference
  await expect(selector.getByRole('option', { name: /Default/ })).toHaveCount(1)
  await expect(selector.getByRole('option', { name: 'Claude · work' })).toHaveCount(1)
  await expect(selector.getByRole('option', { name: 'cheapestinference' })).toHaveCount(1)

  // the seeded chain (agents.json fallback: [prov-ci-e2e]) shows up as a chip
  await expect(page.locator('main').getByText('Fallback chain')).toBeVisible()
  await expect(page.locator('main').getByRole('button', { name: 'cheapestinference' })).toBeVisible()
})

// The sign-in block on real Chromium: Claude's process is stubbed at the
// network edge (the login route and its socket) — zero claude, zero network.
test('Connect another account: Claude’s sign-in in two steps — link (open/copy), code typed at Claude’s prompt, Claude’s answer', async ({ page }) => {
  const LINK = 'https://claude.com/cai/oauth/authorize?code=true&client_id=e2e&state=e2e'
  const sent: string[] = []
  await page.route('**/api/accounts/*/login', (route) =>
    route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ terminal: { id: 'e2e-login', agentId: null, cwd: '/x' } }) }),
  )
  await page.routeWebSocket(
    (url) => url.pathname === '/ws/terminal/e2e-login',
    (ws) => {
      ws.send(`Opening browser to sign in…\r\nIf the browser didn't open, visit: \x1b]8;;${LINK}\x07${LINK}\x1b]8;;\x07\r\nPaste code here if prompted > `)
      ws.onMessage((m) => {
        sent.push(String(m))
        if (String(m).includes('\\r')) ws.send('Invalid code. Please make sure the full code was copied.\r\nPaste code here if prompted > ')
      })
    },
  )
  // the socket stub is an init script: it holds for pages loaded after it
  await page.reload()
  await page.getByLabel('Settings').click()
  await page.locator('main').getByRole('button', { name: 'Accounts & providers' }).click()
  await page
    .locator('main')
    .getByRole('button', { name: /Connect another account/ })
    .click()
  await page.locator('main').getByLabel('account name').fill('personal')
  await page.locator('main').getByRole('button', { name: 'Create' }).click()

  const block = page.getByTestId('claude-sign-in')
  await expect(block.getByRole('link', { name: /Open sign-in page/ })).toHaveAttribute('href', LINK)
  await expect(block.getByRole('button', { name: /Copy link/ })).toBeVisible()
  if (process.env.SILOS_SHOTS) await block.screenshot({ path: `${process.env.SILOS_SHOTS}/signin-step1.png` })
  await block.getByLabel('code from Claude').fill('abc#123')
  await block.getByRole('button', { name: 'Sign in' }).click()
  await expect(block.getByRole('alert')).toContainText('Claude says: Invalid code')
  expect(sent).toContain(JSON.stringify({ op: 'write', data: 'abc#123' }))
  if (process.env.SILOS_SHOTS) {
    await block.getByRole('button', { name: /Show Claude’s output/ }).click()
    await page.locator('main').screenshot({ path: `${process.env.SILOS_SHOTS}/signin-rejected.png` })
    await page.emulateMedia({ colorScheme: 'dark' })
    await block.screenshot({ path: `${process.env.SILOS_SHOTS}/signin-dark.png` })
  }
})
