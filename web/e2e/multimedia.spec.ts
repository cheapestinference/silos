// multimedia.spec.ts — real evidence (Chromium, 1440x900): an image pasted
// by the user in its bubble, the tool_result thumbnail in the chip detail,
// and the lightbox with its Esc contract. The bitmaps are real PNGs seeded
// into the JSONL (see seedMultimedia in helpers.ts) and served via
// /api/sessions/.../media/:ref — the naturalWidth assertion checks that the
// browser actually DECODED the image (proof-of-life principle: no broken
// <img> that "passes" just because the element exists).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { type Page, type Locator } from '@playwright/test'
import { test, expect, startServer, agentRow, cleanupTempDirs, type E2EServer, shotsDir } from './helpers'

const SHOTS_DIR = shotsDir('multimedia')
mkdirSync(SHOTS_DIR, { recursive: true })

let srv: E2EServer

test.beforeAll(async () => {
  srv = await startServer()
})

test.afterAll(async () => {
  await srv.stop()
  cleanupTempDirs()
})

async function openMediaSession(page: Page): Promise<void> {
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
    .getByRole('button', { name: agentRow('Media') })
    .first()
    .click()
  await page
    .locator('aside')
    .first()
    .getByText(/Hero palette from mock/)
    .first()
    .click()
}

// the <img> exists AND its bitmap was ACTUALLY decoded — decode() rejects
// with EncodingError if the bytes are corrupt (naturalWidth alone isn't
// proof: Chromium reads it from the IHDR header even if IDAT fails to
// decode, so a broken PNG would still paint an empty box with naturalWidth > 0).
async function waitForBitmap(img: Locator): Promise<void> {
  await expect(img).toBeVisible()
  await expect
    .poll(() =>
      img.evaluate((el) =>
        (el as HTMLImageElement)
          .decode()
          .then(() => (el as HTMLImageElement).naturalWidth)
          .catch(() => -1),
      ),
    )
    .toBeGreaterThan(0)
}

test('image pasted by the user in its bubble', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await openMediaSession(page)
  await waitForBitmap(page.getByAltText('pasted image'))
  await page.screenshot({ path: join(SHOTS_DIR, 'user-image-bubble.png') })
  await context.close()
})

test('tool_result thumbnail inside the chip detail', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await openMediaSession(page)
  // the chip flags it with its glyph; expanding it shows the lazy thumbnail
  await page.locator('main').getByRole('button', { name: /Read/ }).first().click()
  await waitForBitmap(page.getByAltText('tool result image'))
  await page.screenshot({ path: join(SHOTS_DIR, 'tool-thumbnail.png') })
  await context.close()
})

test('lightbox: click opens full size, Esc closes', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await openMediaSession(page)
  await waitForBitmap(page.getByAltText('pasted image'))
  await page.getByAltText('pasted image').click()
  const dialog = page.getByRole('dialog', { name: 'Image viewer' })
  await expect(dialog).toBeVisible()
  await waitForBitmap(page.getByAltText('full size image'))
  // honest caption: real media type + dims + weight from the JSONL
  await expect(dialog.getByText(/image\/png · 120×80/)).toBeVisible()
  await page.screenshot({ path: join(SHOTS_DIR, 'lightbox.png') })
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await context.close()
})
