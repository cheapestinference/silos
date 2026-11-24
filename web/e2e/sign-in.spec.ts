// Remote sign-in (Silos ID, opt-in) — e2e with no broker and no Google:
// hard rule, there is never any network beyond the machine here. Nobody is the owner by default:
// the app opens for the owner's credential only, local or
// remote; "remote" is simulated with cloudflared's extraHTTPHeaders
// (CF-Connecting-IP), exactly what the real tunnel adds and the client
// cannot strip.
// Two servers:
//   1. The usual one (no Silos ID): no login screen — a local visit
//      with no token is paired once («Pair this browser»: paste the token,
//      or the printed ?token= link).
//   2. One given Silos ID through <dataDir>/server.env (a loopback broker
//      that is not there — nobody clicks the button): a visit with no token
//      sees the login screen; "remote" with ?token= (the escape hatch) gets
//      in. It also proves server.env is read at boot.
// Screenshots 1440x900 → web/test-results/shots/sign-in/.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { startServer, cleanupTempDirs, type E2EServer, shotsDir } from './helpers'

const SHOTS_DIR = shotsDir('sign-in')
mkdirSync(SHOTS_DIR, { recursive: true })

// loopback on both ends: normalizeOrigin accepts plain http only there, and
// the boot's registration hits a closed port instead of the network
const SILOS_ID_ENV = [
  '# Silos ID for this e2e instance',
  'SILOS_ID_URL=http://127.0.0.1:9',
  'SILOS_PUBLIC_URL="http://127.0.0.1:3210"',
  'SILOS_OWNER_EMAIL=owner@example.com',
  '',
].join('\n')

// what cloudflared adds to EVERY forwarded request — the "remote" stand-in
const TUNNEL_HEADERS = { 'CF-Connecting-IP': '203.0.113.9', 'CF-Ray': 'e2e-test' }

let normal: E2EServer // no Silos ID — the usual product
let withLogin: E2EServer // Silos ID from server.env — login active

test.beforeAll(async () => {
  normal = await startServer()
  withLogin = await startServer({ serverEnv: SILOS_ID_ENV })
})

test.afterAll(async () => {
  await normal.stop()
  await withLogin.stop()
  cleanupTempDirs()
})

// nobody is the owner by default — a local browser
// with no credential is paired once (the printed ?token= link, or a pasted token)
test('no Silos ID: a local visit with NO token sees «Pair this browser»; a pasted token pairs it, ?token= too', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await page.goto(`${normal.url}/`)
  await expect(page.getByRole('heading', { name: 'Pair this browser' })).toBeVisible()
  await expect(page.getByText('Open the link the server prints at start, or paste the token from')).toBeVisible()
  await expect(page.getByText('Continue with Google')).toHaveCount(0)
  await expect(page.locator('aside').getByLabel('Automations', { exact: true })).toHaveCount(0)
  await page.screenshot({ path: join(SHOTS_DIR, 'c-pair-this-browser.png') })
  // a wrong token is said, not swallowed
  await page.getByLabel('Token from ~/.silos/token').fill('not-the-token')
  await page.getByRole('button', { name: 'Pair this browser' }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  // the right one opens the app — and the browser stays paired
  await page.getByLabel('Token from ~/.silos/token').fill(normal.token)
  await page.getByRole('button', { name: 'Pair this browser' }).click()
  await expect(page.locator('aside').getByLabel('Automations', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.locator('aside').getByLabel('Automations', { exact: true })).toBeVisible()
  await context.close()
  // the printed link pairs a fresh browser in one click
  const fresh = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const p2 = await fresh.newPage()
  await p2.goto(`${normal.url}/?token=${normal.token}`)
  await expect(p2.locator('aside').getByLabel('Automations', { exact: true })).toBeVisible()
  await fresh.close()
})

test('no Silos ID: a local write with no identity is a 401 that teaches the way', async ({ request }) => {
  const r = await request.patch(`${normal.url}/api/prefs`, { data: { contextOpen: true } })
  expect(r.status()).toBe(401)
  expect((await r.json()).error).toMatch(/^writes need an identity/)
})

test('no Silos ID: a "remote" request (tunnel headers) DOES require a token', async ({ request }) => {
  const without = await request.get(`${normal.url}/api/overview`, { headers: TUNNEL_HEADERS })
  expect(without.status()).toBe(401)
  const withToken = await request.get(`${normal.url}/api/overview?token=${normal.token}`, { headers: TUNNEL_HEADERS })
  expect(withToken.status()).toBe(200)
})

test('Silos ID from server.env: the public config says so; a LOCAL visit with no token: the door (login, with the printed-link hatch); ?token= gets in', async ({
  browser,
}) => {
  const cfg = await (await fetch(`${withLogin.url}/api/auth/config`)).json()
  expect(cfg).toEqual({ enabled: true, mode: 'silos-id' })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await page.goto(`${withLogin.url}/`)
  await expect(page.getByRole('button', { name: /Continue with Google/ })).toBeVisible()
  await expect(page.locator('aside').getByLabel('Automations', { exact: true })).toHaveCount(0)
  await page.goto(`${withLogin.url}/?token=${withLogin.token}`)
  await expect(page.locator('aside').getByLabel('Automations', { exact: true })).toBeVisible()
  await context.close()
})

test('Silos ID on, "remote" visit without a token: login screen (screenshot) — and no network beyond the machine', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: TUNNEL_HEADERS })
  const page = await context.newPage()
  // sentinel: if anything tried to reach beyond this server, the test blows up
  const leaks: string[] = []
  page.on('request', (req) => {
    const u = req.url()
    if (!u.startsWith(withLogin.url) && !u.startsWith('data:')) leaks.push(u)
  })
  await page.goto(`${withLogin.url}/`)
  await expect(page.getByRole('button', { name: /Continue with Google/ })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Silos' })).toBeVisible()
  await expect(page.getByText('?token=')).toBeVisible() // the escape hatch, documented on the door
  // the app is NOT mounted behind it
  await expect(page.locator('aside').getByLabel('Automations', { exact: true })).toHaveCount(0)
  expect(leaks).toEqual([])
  await page.screenshot({ path: join(SHOTS_DIR, 'a-login-screen.png') })
  await context.close()
})

test('Silos ID on, "remote" with ?token= (manual escape hatch): gets in without going through Google', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: TUNNEL_HEADERS })
  const page = await context.newPage()
  await page.goto(`${withLogin.url}/?token=${withLogin.token}`)
  await expect(page.locator('aside').getByLabel('Automations', { exact: true })).toBeVisible()
  await expect(page.getByText('Continue with Google')).toHaveCount(0)
  await context.close()
})

test('Google identity in the sidebar footer (screenshot)', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  // identity as left by the Silos ID landing after a verified login — no remote
  // photo on purpose (zero network): initial-letter avatar
  await page.addInitScript(() => {
    localStorage.setItem('silos-google-identity', JSON.stringify({ email: 'owner@example.com', name: 'Owner', photo: null }))
  })
  await page.goto(`${withLogin.url}/?token=${withLogin.token}`)
  await expect(page.locator('aside').getByLabel('Automations', { exact: true })).toBeVisible()
  await expect(page.getByText('owner@example.com')).toBeVisible() // sidebar footer
  await page.screenshot({ path: join(SHOTS_DIR, 'b-sidebar-google-identity.png') })
  await context.close()
})
