// inter-session.spec.ts — messages BETWEEN SESSIONS. Verifies in real
// Chromium, against the seedInterSession fixture session (helpers.ts, real
// corpus shape), both directions: an INCOMING message from another session
// rendered as a third voice ("↦ from <sender>", a band — never an owner
// bubble) and an OUTGOING SendMessage labeled with its destination
// ("→ to X") on the chip. Evidence screenshots in
// web/test-results/shots/inter-session/ (1440x900, same pattern as
// screenshots.spec.ts: the controller reviews them by hand).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { type Page } from '@playwright/test'
import { test, expect, startServer, agentRow, cleanupTempDirs, type E2EServer, shotsDir } from './helpers'

const SHOTS_DIR = shotsDir('inter-session')
mkdirSync(SHOTS_DIR, { recursive: true })
// cross-session link: screenshots specific to the sender-link feature.
const LINK_SHOTS_DIR = shotsDir('inter-session-link')
mkdirSync(LINK_SHOTS_DIR, { recursive: true })

let srv: E2EServer

test.beforeAll(async () => {
  srv = await startServer()
})

test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})

async function openPeersSession(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('silos.chatMode', 'chat')
    } catch {
      /* ignore */
    }
  })
  await page.goto(`${srv.url}/?token=${srv.token}`)
  await expect(page.getByText('Silos').first()).toBeVisible()
  await page
    .getByRole('button', { name: agentRow('Peers') })
    .first()
    .click()
  await page
    .locator('aside')
    .first()
    .getByText(/Cross-session deploy sync/)
    .first()
    .click()
  await expect(page.locator('main').getByText('Cross-session deploy sync')).toBeVisible()
}

test('incoming: the "↦ from <sender>" band appears between normal turns, never as a bubble', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await openPeersSession(page)

  const band = page.locator('[data-inter-session]')
  await expect(band).toBeVisible()
  await expect(band).toContainText('↦ from acme-e8')
  // clean body: no wrapper or harness boilerplate
  await expect(band).toContainText('my commits on main are COMPLETE')
  await expect(page.locator('main')).not.toContainText('cross-session-message')
  await expect(page.locator('main')).not.toContainText('Another Claude session sent a message')
  // never an owner bubble: the band doesn't carry the ml-auto anatomy
  const cls = await band.getAttribute('class')
  expect(cls ?? '').not.toContain('ml-auto')

  await page.screenshot({ path: join(SHOTS_DIR, 'incoming-third-voice.png') })
  await context.close()
})

test('cross-session link: the resolved sender is a link that jumps to its agent dossier', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await openPeersSession(page)

  // the peer "acme-e8" resolves to the agent id 'acme'
  // (server-side view resolution) → the name is a BUTTON with an honest
  // tooltip ("go to …": the sender, not the exact thread).
  const link = page.locator('[data-inter-session]').getByRole('button', { name: 'acme-e8' })
  await expect(link).toBeVisible()
  await expect(link).toHaveAttribute('title', 'go to acme-e8')

  await page.screenshot({ path: join(LINK_SHOTS_DIR, 'sender-clickable.png') })

  // click → navigates to the sender agent's dossier (URL /agent/<id>)
  await link.click()
  await expect(page).toHaveURL(/\/agent\/acme(\/|$)/)

  await context.close()
})

test('outgoing: the SendMessage chip shows the destination "→ to X"', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await openPeersSession(page)

  const chip = page.getByRole('button', { name: '→ to acme-e8' })
  await expect(chip).toBeVisible()

  await page.screenshot({ path: join(SHOTS_DIR, 'outbound-chip.png') })
  await context.close()
})
