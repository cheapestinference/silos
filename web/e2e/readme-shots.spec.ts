// readme-shots.spec.ts — the README's screenshots, taken from the seeded demo
// data only (never a real ~/.silos or ~/.claude). Off by default; run with
//   SILOS_README_SHOTS=1 npx playwright test readme-shots   (from web/)
// It writes raw PNGs to web/test-results/readme-shots/; optimise them into
// docs/images/ by hand (they are reviewed before they ship).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { type Page } from '@playwright/test'
import { test, expect, startServer, cleanupTempDirs, type E2EServer } from './helpers'
import { DEMO_AGENT_ID, DEMO_CONVERSATION_TITLE } from './readme-demo'

const OUT = process.env.SILOS_README_SHOTS_DIR ?? join(import.meta.dirname, '..', 'test-results', 'readme-shots')

test.skip(!process.env.SILOS_README_SHOTS, 'README screenshots: set SILOS_README_SHOTS=1')
test.describe.configure({ mode: 'serial' })

let srv: E2EServer

test.beforeAll(async () => {
  mkdirSync(OUT, { recursive: true })
  // the demo house (readme-demo.ts) instead of the e2e fixtures; the stub
  // claude answers who the machine's account is signed in as
  srv = await startServer({ readmeDemo: true, stubClaude: true })
})

test.afterAll(async () => {
  await srv?.stop()
  cleanupTempDirs()
})

async function open(browser: import('@playwright/test').Browser, path: string, dark = false): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light' })
  await context.addInitScript((d) => {
    try {
      localStorage.setItem('silos.chatMode', 'chat')
      if (d) localStorage.setItem('silos-dark', '1')
    } catch {
      /* ignore */
    }
  }, dark)
  const page = await context.newPage()
  const sep = path.includes('?') ? '&' : '?'
  await page.goto(`${srv.url}${path}${sep}token=${srv.token}`)
  return { page, close: () => context.close() }
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(1200)
}

test('home', async ({ browser }) => {
  const { page, close } = await open(browser, '/')
  await expect(page.getByText('Silos').first()).toBeVisible()
  await settle(page)
  await page.screenshot({ path: join(OUT, 'home.png') })
  await close()
})

// the README opens on the conversation in dark; the light one is its
// <picture> fallback for a reader on a light theme
for (const dark of [true, false]) {
  test(`conversation${dark ? '-dark' : ''}`, async ({ browser }) => {
    const { page, close } = await open(browser, '/', dark)
    await expect(page.getByText('Silos').first()).toBeVisible()
    await page.locator('aside').first().getByText(DEMO_CONVERSATION_TITLE).first().click()
    await expect(page.locator('main').getByText(DEMO_CONVERSATION_TITLE)).toBeVisible()
    await settle(page)
    await page.screenshot({ path: join(OUT, `conversation${dark ? '-dark' : ''}.png`) })
    await close()
  })

  test(`agent${dark ? '-dark' : ''}`, async ({ browser }) => {
    const { page, close } = await open(browser, `/agent/${DEMO_AGENT_ID}`, dark)
    await settle(page)
    await page.screenshot({ path: join(OUT, `agent${dark ? '-dark' : ''}.png`) })
    await close()
  })

  test(`silos${dark ? '-dark' : ''}`, async ({ browser }) => {
    const { page, close } = await open(browser, '/settings/silos', dark)
    await settle(page)
    await page.screenshot({ path: join(OUT, `silos${dark ? '-dark' : ''}.png`) })
    await close()
  })
}

test('home-dark', async ({ browser }) => {
  const { page, close } = await open(browser, '/', true)
  await expect(page.getByText('Silos').first()).toBeVisible()
  await settle(page)
  await page.screenshot({ path: join(OUT, 'home-dark.png') })
  await close()
})
