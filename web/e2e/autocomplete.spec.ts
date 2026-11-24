// E2E in a real Chromium: the autocomplete bug — "I see it in Claude Code
// but not here" — didn't reproduce in jsdom (unit tests passed), so only a
// real browser catches it. A single spec, controller ruling: no separate
// E2E suite, the load smoke test folds into beforeAll instead of living in
// its own app.spec.ts.
import { test, expect, startServer, cleanupTempDirs, type E2EServer } from './helpers'

let srv: E2EServer

// v1.1: the group header (Sidebar) became a set of interactive <button>s
// (collapse + move up/down, see GroupHeader) whose accessible name is the
// basename of the seeded folder — "deck-e2e-folder-XXXXX" for this spec's
// 'e2e' agent — which also matches /e2e/i. The header gained more
// controls with the same problem (clickable name "open project X", hover
// "add agent to X", "memory for X" — see GroupHeader in Sidebar.tsx). The
// negative lookahead excludes ALL of those header controls by their
// aria-label prefix, leaving only the agent's own button ("🧪 E2E").
const E2E_AGENT = /^(?!collapse |expand |move |open project |add agent to |memory for ).*e2e/i

test.beforeAll(async ({ browser }) => {
  srv = await startServer()
  // minimal load smoke test (replaces the draft's app.spec.ts): the real
  // app responds and renders the team before the two autocomplete tests
  // assume there's something to click.
  const page = await browser.newPage()
  await page.goto(`${srv.url}/?token=${srv.token}`)
  await expect(page.getByText('Silos').first()).toBeVisible()
  await expect(page.getByRole('button', { name: E2E_AGENT }).first()).toBeVisible()
  await page.close()
})

test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})

test.beforeEach(async ({ page }) => {
  await page.goto(`${srv.url}/?token=${srv.token}`)
  // header+sidebar redesign: clicking the agent row navigates to the AGENT
  // DOSSIER (no composer) — reaching the real composer is an explicit
  // action: "+ New conversation", already visible in the Sidebar (the
  // selected agent expands its topic list there).
  await page.getByRole('button', { name: E2E_AGENT }).first().click()
  // "New conversation" is an INLINE button per agent (aria-label
  // "new conversation with <name>") — not the old ghost row.
  await page.getByLabel('new conversation with E2E').click()
})

test('@ opens the dropdown with real files and Tab inserts the pick', async ({ page }) => {
  const textarea = page.getByRole('textbox', { name: 'message' })
  await textarea.click()
  await textarea.pressSequentially('look at @', { delay: 30 })
  await expect(page.getByRole('listbox')).toBeVisible() // dropdown open with empty q
  await textarea.pressSequentially('ap', { delay: 30 })
  await expect(page.getByRole('option').first()).toContainText('app')
  await page.keyboard.press('Tab')
  await expect(textarea).toHaveValue(/@src\/app\.ts /)
})

test('/ at the start lists skills', async ({ page }) => {
  const textarea = page.getByRole('textbox', { name: 'message' })
  await textarea.click()
  await textarea.pressSequentially('/e2e', { delay: 30 })
  await expect(page.getByRole('option').first()).toContainText('e2e-skill')
})
