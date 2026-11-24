// routing.spec.ts — URL routing: "every state navigable in the URL,
// deep-linkable / refresh-restorable / back-forward". Real smoke test in
// Chromium over the seeded harness: a deep link to an agent's URL loads
// THAT agent (without going through the home page or clicks), and the
// browser's back button returns to the previous agent. Covers what the
// jsdom suite (web/test/router.test.ts) can't: the real bundle boot + the
// browser's history.
import { test, expect } from '@playwright/test'
import { startServer, agentRow, cleanupTempDirs, type E2EServer } from './helpers'

let srv: E2EServer

test.beforeAll(async () => {
  srv = await startServer()
})

test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})

test('deep-link to /agent/<id> loads that agent; back/forward navigate', async ({ page }) => {
  // direct deep-link (refresh-restorable): the server serves index.html on
  // the deep route and the client-side router restores the 'api' agent's
  // dossier after loading the overview. getToken() consumes ?token=
  // while preserving the pathname (see api.ts), so the route survives.
  await page.goto(`${srv.url}/agent/api?token=${srv.token}`)
  await expect(page.locator('main').getByText('Backend and infra').first()).toBeVisible()
  await expect(page).toHaveURL(/\/agent\/api$/)

  // navigating to another agent via the UI updates the URL (goes through the
  // store's actions — the sync layer reflects it for free).
  await page
    .getByRole('button', { name: agentRow('UX') })
    .first()
    .click()
  await expect(page.locator('main').getByText('Design and frontend polish').first()).toBeVisible()
  await expect(page).toHaveURL(/\/agent\/ux$/)

  // back → returns to the 'api' agent (pushState from an agent switch).
  await page.goBack()
  await expect(page).toHaveURL(/\/agent\/api$/)
  await expect(page.locator('main').getByText('Backend and infra').first()).toBeVisible()

  // forward → back to 'ux'.
  await page.goForward()
  await expect(page).toHaveURL(/\/agent\/ux$/)
  await expect(page.locator('main').getByText('Design and frontend polish').first()).toBeVisible()
})

// opening a conversation and then "New conversation" is a compound gesture
// (several store set() calls). It must push exactly ONE history entry: Back
// has to return to the conversation, not to an intermediate dossier nobody
// visited. This is the gap a double pushState let through in an earlier round.
test('opening a conversation then New conversation: Back returns to the conversation', async ({ page }) => {
  await page.goto(`${srv.url}/agent/api?token=${srv.token}`)
  // open the "Flaky test triage" session from the dossier
  await page.locator('aside').first().getByText('Flaky test triage').first().click()
  await expect(page).toHaveURL(/\/agent\/api\/c\/.+\/api1$/)

  // "+ New conversation" — INLINE button on the agent row: aria-label
  // "new conversation with <name>". Compound gesture.
  await page.getByRole('button', { name: 'new conversation with API' }).click()
  await expect(page).toHaveURL(/\/agent\/api\/new$/)

  // Back → the previous conversation, not the bare /agent/api dossier
  await page.goBack()
  await expect(page).toHaveURL(/\/agent\/api\/c\/.+\/api1$/)
  await expect(page.locator('main').getByText('Flaky test triage')).toBeVisible()
})

// two DELIBERATE, separate gestures — open an agent [gesture 1] and THEN
// click one of its sessions [gesture 2] — must leave TWO history entries,
// so Back returns to the agent's dossier (doesn't skip to home). An earlier
// history-collapsing heuristic ate this stop in the product's most common
// flow; this test guards against that bug's return.
test('two separate gestures (open agent, then a session): Back returns to the agent dossier', async ({ page }) => {
  // gesture 1: open the agent (direct deep-link to the dossier)
  await page.goto(`${srv.url}/agent/api?token=${srv.token}`)
  await expect(page.locator('main').getByText('Backend and infra').first()).toBeVisible()
  await expect(page).toHaveURL(/\/agent\/api$/)

  // gesture 2: click a session in the dossier
  await page.locator('aside').first().getByText('Flaky test triage').first().click()
  await expect(page).toHaveURL(/\/agent\/api\/c\/.+\/api1$/)

  // Back → the agent dossier, NOT home
  await page.goBack()
  await expect(page).toHaveURL(/\/agent\/api$/)
  await expect(page.locator('main').getByText('Backend and infra').first()).toBeVisible()
})
