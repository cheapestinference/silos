// screenshots.spec.ts — evidence screenshots for the frontend-design pass in
// real Chromium, with representative seeded data (helpers.ts: several
// agents in different projects, a session with a streak of tool-only turns,
// freshly-discovered "external" sessions — see the seedRichData comment in
// helpers.ts). No pixel asserts: the controller reviews the screenshots by
// hand before approving the task. A single shared server (beforeAll) — each
// test opens its own browser context with the viewport and theme it needs,
// so they don't step on each other.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { type Page } from '@playwright/test'
import { test, expect, startServer, agentRow, cleanupTempDirs, type E2EServer, shotsDir } from './helpers'

const SHOTS_DIR = shotsDir('2026-08-18-f4-consolidated')
mkdirSync(SHOTS_DIR, { recursive: true })

let srv: E2EServer

test.beforeAll(async () => {
  srv = await startServer()
})

test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})

// header+sidebar redesign: clicking the agent navigates to the AGENT
// DOSSIER (Sessions tab, landing) — the topic opens from there, no need to
// go through the Sidebar. `main` scopes the click: the Sidebar still has
// the same topic in its own expanded list (visible on desktop, unlike
// mobile), and without scoping, `.first()` could land on either one.
async function openAgentAndSession(page: Page, agentName: string, session: RegExp, phone = false): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('silos.chatMode', 'chat')
    } catch {
      /* ignore */
    }
  })
  await page.goto(`${srv.url}/?token=${srv.token}`)
  // a phone lands on Home: the list is one tap away
  if (phone) await page.getByRole('button', { name: 'agents and conversations' }).click()
  await expect(page.getByText('Silos').first()).toBeVisible()
  // the session row sits under its (expanded) agent in the unified sidebar
  // — one gesture, on every viewport (on a phone, opening the agent first
  // would cover the list with the agent page).
  await expect(page.getByRole('button', { name: agentRow(agentName) }).first()).toBeVisible()
  await page.locator('aside').first().getByText(session).first().click()
}

test('desktop-light: team grouped by folder + session with a streak of tool-only turns', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  // API has the "Flaky test triage" session: 4 consecutive tool-only turns
  // → folded streak indicator — this is what compact tool runs and sidebar
  // row density (several folders → group headers) need to show in a real
  // screenshot.
  await openAgentAndSession(page, 'API', /Flaky test triage/)
  // with the unified sidebar, the open session's title appears TWICE (the
  // sidebar row stays expanded + the chat header) — scope to <main> (the
  // chat column) to avoid colliding with the sidebar's in strict mode.
  await expect(page.locator('main').getByText('Flaky test triage')).toBeVisible()
  await page.screenshot({ path: join(SHOTS_DIR, 'desktop-light.png') })
  await context.close()
})

test('desktop-dark: same layout in dark, session with a code block (hljs)', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addInitScript(() => {
    window.localStorage.setItem('silos-dark', '1')
  })
  const page = await context.newPage()
  // UX has the "Greeting helper" session: a ```ts``` block in the response
  // → check the hljs palette (and --ink-2/--line) in dark against a real
  // screenshot, not in the abstract.
  await openAgentAndSession(page, 'UX', /Greeting helper/)
  await expect(page.locator('main').getByText('Greeting helper')).toBeVisible()
  await expect(page.locator('code.hljs').first()).toBeVisible()
  await page.screenshot({ path: join(SHOTS_DIR, 'desktop-dark.png') })
  await context.close()
})

test('mobile-home: a phone lands on Home at 390x844, lenses hidden, the list one tap away', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  await page.goto(`${srv.url}/?token=${srv.token}`)
  await expect(page.locator('main').getByTestId('pulse')).toBeVisible()
  await expect(page.locator('aside').first()).toBeHidden()
  // lenses are desk tools: hidden on a phone
  await expect(page.getByTestId('home-lenses')).toBeHidden()
  await page.screenshot({ path: join(SHOTS_DIR, 'mobile-home.png') })
  await context.close()
})

test('mobile-team: team at full screen at 390x844', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  await page.goto(`${srv.url}/?token=${srv.token}`)
  await page.getByRole('button', { name: 'agents and conversations' }).click()
  await expect(page.getByText('Silos').first()).toBeVisible()
  await expect(page.getByRole('button', { name: /API/ }).first()).toBeVisible()
  await page.screenshot({ path: join(SHOTS_DIR, 'mobile-team.png') })
  await context.close()
})

test('mobile-chat: chat open at 390x844 (list→chat, unified sidebar)', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  await openAgentAndSession(page, 'API', /Flaky test triage/, true)
  await expect(page.locator('main').getByText('Flaky test triage')).toBeVisible()
  // back button visible in both mobile columns — in 'chat' exactly one
  // must remain visible (the one in the session header).
  await expect(page.getByRole('button', { name: 'back', exact: true })).toBeVisible()
  await page.screenshot({ path: join(SHOTS_DIR, 'mobile-chat.png') })
  await context.close()
})
